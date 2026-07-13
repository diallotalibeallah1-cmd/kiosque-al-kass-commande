require("dotenv").config();
const path = require("path");
const express = require("express");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const ExcelJS = require("exceljs");
const PDFDocument = require("pdfkit");
const db = require("./db");
const mail = require("./mail");
const { envoyerMessage } = require("./whatsapp");

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static("public"));
app.use("/comptes", express.static("comptes"));
app.get("/comptes", (req, res) => res.redirect("/comptes/"));

// Session pour l'espace "Comptes" (ancien dashboard, auth email/mot de passe)
app.use(
    session({
        secret: process.env.SESSION_SECRET || "change-moi-avant-la-mise-en-ligne-alkass",
        resave: false,
        saveUninitialized: false,
        cookie: {
            httpOnly: true,
            maxAge: 1000 * 60 * 60 * 24 * 7, // 7 jours
        },
    })
);

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 8,
    message: { error: "Trop de tentatives. Réessaie dans quelques minutes." },
    standardHeaders: true,
    legacyHeaders: false,
});

function requireAuthComptes(req, res, next) {
    if (!req.session.userId) {
        return res.status(401).json({ error: "Non connecté." });
    }
    next();
}

function getBaseUrl(req) {
    return process.env.APP_URL || `${req.protocol}://${req.get("host")}`;
}

const NUMERO_PROPRIETAIRE = process.env.NUMERO_PROPRIETAIRE;
const NUMEROS_ENTREPRISE = (process.env.NUMEROS_ENTREPRISE || "")
    .split(",").map(n => n.trim()).filter(Boolean);

// --- Stockage en mémoire (⚠️ se réinitialise si le serveur redémarre) ---
let commandes = [];
let codesOTP = {};        // { telephone: { code, expire } }
let sessionsEntreprise = {}; // { token: { telephone, expire } }
let sessionsClient = {};     // { token: { telephone, expire } }

// ============ HORAIRES ============

function statutKiosque(date = new Date()) {
    const m = date.getUTCHours() * 60 + date.getUTCMinutes();
    const matinDebut = 7 * 60 + 30, matinFin = 11 * 60 + 30;
    const soirDebut = 20 * 60, soirFinNuit = 24 * 60 + 30;

    if (m >= matinDebut && m < matinFin) return { ouvert: true, creneau: "matin" };
    if (m >= soirDebut && m < soirFinNuit) return { ouvert: true, creneau: "soir" };
    if (m < 30) return { ouvert: true, creneau: "soir" };
    return { ouvert: false, creneau: null };
}

function numeroDeSemaine(date) {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const jour = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - jour);
    const debutAnnee = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return d.getUTCFullYear() + "-S" + Math.ceil((((d - debutAnnee) / 86400000) + 1) / 7);
}

// ============ AUTHENTIFICATION ENTREPRISE ============

function genererCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}
function genererToken() {
    return crypto.randomBytes(24).toString("hex");
}

async function envoyerCode(telephone) {
    const code = genererCode();
    codesOTP[telephone] = { code, expire: Date.now() + 5 * 60 * 1000 };
    await envoyerMessage(telephone, `🔐 Code de connexion Kiosque Al Kass : ${code}\n\nValable 5 minutes.`);
}

function authEntreprise(req, res, next) {
    const token = req.cookies.session_entreprise;
    const session = token && sessionsEntreprise[token];
    if (!session || session.expire < Date.now()) {
        return res.status(401).json({ erreur: "Non authentifié." });
    }
    req.telephoneEntreprise = session.telephone;
    next();
}

function authClient(req, res, next) {
    const token = req.cookies.session_client;
    const session = token && sessionsClient[token];
    if (!session || session.expire < Date.now()) {
        return res.status(401).json({ erreur: "Non authentifié." });
    }
    req.telephoneClient = session.telephone;
    next();
}

// --- Connexion entreprise (numéros whitelistés uniquement) ---

app.post("/entreprise/connexion", async (req, res) => {
    const { telephone } = req.body;
    if (!telephone || !NUMEROS_ENTREPRISE.includes(telephone)) {
        return res.status(403).json({ erreur: "Ce numéro n'est pas autorisé." });
    }
    await envoyerCode(telephone);
    res.json({ succes: true });
});

app.post("/entreprise/verifier", (req, res) => {
    const { telephone, code } = req.body;
    const entree = codesOTP[telephone];
    if (!entree || entree.expire < Date.now() || entree.code !== code) {
        return res.status(401).json({ erreur: "Code invalide ou expiré." });
    }
    delete codesOTP[telephone];
    const token = genererToken();
    sessionsEntreprise[token] = { telephone, expire: Date.now() + 12 * 60 * 60 * 1000 };
    res.cookie("session_entreprise", token, { httpOnly: true, maxAge: 12 * 60 * 60 * 1000, sameSite: "lax" });
    res.json({ succes: true });
});

app.post("/entreprise/deconnexion", (req, res) => {
    const token = req.cookies.session_entreprise;
    if (token) delete sessionsEntreprise[token];
    res.clearCookie("session_entreprise");
    res.json({ succes: true });
});

app.get("/api/entreprise/moi", authEntreprise, (req, res) => {
    res.json({ telephone: req.telephoneEntreprise });
});

// --- Connexion client (n'importe quel numéro, vérifié par WhatsApp) ---

app.post("/client/connexion", async (req, res) => {
    const { telephone } = req.body;
    if (!telephone) return res.status(400).json({ erreur: "Numéro requis." });
    await envoyerCode(telephone);
    res.json({ succes: true });
});

app.post("/client/verifier", (req, res) => {
    const { telephone, code } = req.body;
    const entree = codesOTP[telephone];
    if (!entree || entree.expire < Date.now() || entree.code !== code) {
        return res.status(401).json({ erreur: "Code invalide ou expiré." });
    }
    delete codesOTP[telephone];
    const token = genererToken();
    sessionsClient[token] = { telephone, expire: Date.now() + 30 * 24 * 60 * 60 * 1000 }; // 30 jours
    res.cookie("session_client", token, { httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000, sameSite: "lax" });
    res.json({ succes: true });
});

app.post("/client/deconnexion", (req, res) => {
    const token = req.cookies.session_client;
    if (token) delete sessionsClient[token];
    res.clearCookie("session_client");
    res.json({ succes: true });
});

app.get("/api/client/moi", authClient, (req, res) => {
    res.json({ telephone: req.telephoneClient });
});

// ============ FILE D'ATTENTE ============

const TEMPS_PREPARATION_MIN = 10;

function commandesEnPreparation() {
    const maintenant = Date.now();
    return commandes.filter(c => {
        const finEstimee = new Date(c.date).getTime() + TEMPS_PREPARATION_MIN * 60000;
        return finEstimee > maintenant;
    }).length;
}

// ============ COMMANDES ============

app.get("/", (req, res) => {
    res.sendFile(__dirname + "/public/index.html");
});

app.get("/api/file-attente", (req, res) => {
    const enAttente = commandesEnPreparation();
    res.json({ enAttente, tempsEstime: (enAttente + 1) * TEMPS_PREPARATION_MIN });
});

app.post("/commander", async (req, res) => {

    const { nom, telephone, items, total } = req.body;

    if (!nom || !telephone || !items || items.length === 0) {
        return res.status(400).json({ erreur: "Informations manquantes." });
    }

    const statut = statutKiosque();
    const aSpaghetti = items.some(i => i.produit === "Spaghetti");

    if (!statut.ouvert) {
        return res.status(400).json({ erreur: "Le kiosque est actuellement fermé." });
    }
    if (aSpaghetti && statut.creneau !== "soir") {
        return res.status(400).json({ erreur: "Le spaghetti n'est disponible que le soir (20h00 à 00h30)." });
    }

    const enAttente = commandesEnPreparation();
    const positionFile = enAttente + 1;
    const tempsAttente = positionFile * TEMPS_PREPARATION_MIN;

    const commande = {
        id: Date.now().toString(),
        nom, telephone, items, total,
        date: new Date().toISOString(),
        semaine: numeroDeSemaine(new Date())
    };

    commandes.push(commande);

    const detail = items.map(i =>
        `- ${i.quantite}x ${i.produit} (${i.prix} F)${i.oeuf ? " + œuf " + i.oeuf : ""}`
    ).join("\n");

    const message = `🆕 Nouvelle commande Kiosque Al Kass !

👤 ${nom}
📞 ${telephone}

${detail}

💰 Total : ${total} FCFA
📋 File d'attente : ${enAttente} commande(s) avant celle-ci`;

    if (NUMERO_PROPRIETAIRE) {
        await envoyerMessage(NUMERO_PROPRIETAIRE, message);
    }

    const messageClient = `✅ Commande reçue chez Kiosque Al Kass !

${detail}

💰 Total : ${total} FCFA
⏱️ Temps d'attente estimé : ${tempsAttente} minutes${enAttente > 0 ? ` (${enAttente} commande(s) avant la vôtre)` : ""}

Merci ${nom}, à très vite ! 🍝`;

    await envoyerMessage(telephone, messageClient);

    res.json({ succes: true, tempsAttente, positionFile, commandesAvant: enAttente });

});

// ============ CLASSEMENT ============

function masquerNom(nom) {
    if (!nom) return "Client";
    const parties = nom.trim().split(/\s+/);
    const prenom = parties[0];
    if (parties.length > 1) {
        return prenom + " " + parties[1][0].toUpperCase() + ".";
    }
    return prenom;
}

function calculerClassement() {
    const semaineActuelle = numeroDeSemaine(new Date());
    const commandesSemaine = commandes.filter(c => c.semaine === semaineActuelle);

    const parClient = {};

    commandesSemaine.forEach(c => {
        if (!parClient[c.telephone]) {
            parClient[c.telephone] = { nom: c.nom, telephone: c.telephone, spaghettis: 0, totalDepense: 0 };
        }
        const spaghettisCommande = c.items
            .filter(i => i.produit === "Spaghetti")
            .reduce((s, i) => s + i.quantite, 0);
        parClient[c.telephone].spaghettis += spaghettisCommande;
        parClient[c.telephone].totalDepense += c.total;
        if (c.nom) parClient[c.telephone].nom = c.nom;
    });

    const classement = Object.values(parClient).sort((a, b) => {
        if (b.spaghettis !== a.spaghettis) return b.spaghettis - a.spaghettis;
        return b.totalDepense - a.totalDepense;
    });

    return { semaine: semaineActuelle, classement };
}

// Public : identité masquée
app.get("/api/classement", (req, res) => {
    const data = calculerClassement();
    const masque = data.classement.map(c => ({
        nom: masquerNom(c.nom),
        spaghettis: c.spaghettis,
        totalDepense: c.totalDepense
    }));
    res.json({ semaine: data.semaine, classement: masque });
});

// Entreprise uniquement : identité complète
app.get("/api/classement/complet", authEntreprise, (req, res) => {
    res.json(calculerClassement());
});

// ============ PROFIL CLIENT ============

app.get("/api/mon-profil", authClient, (req, res) => {
    const telephone = req.telephoneClient;

    const mesCommandes = commandes
        .filter(c => c.telephone === telephone)
        .sort((a, b) => new Date(b.date) - new Date(a.date));

    const data = calculerClassement();
    const index = data.classement.findIndex(c => c.telephone === telephone);
    const monClassement = index >= 0 ? { position: index + 1, ...data.classement[index] } : null;

    res.json({
        commandes: mesCommandes,
        classementSemaine: monClassement,
        semaine: data.semaine
    });
});

// ============ REVENU (entreprise uniquement) ============

app.get("/api/revenu", authEntreprise, (req, res) => {
    const maintenant = new Date();
    const debutJour = new Date(Date.UTC(maintenant.getUTCFullYear(), maintenant.getUTCMonth(), maintenant.getUTCDate()));
    const semaineActuelle = numeroDeSemaine(maintenant);
    const debutMois = new Date(Date.UTC(maintenant.getUTCFullYear(), maintenant.getUTCMonth(), 1));

    let jour = 0, semaine = 0, mois = 0, total = 0;

    commandes.forEach(c => {
        const d = new Date(c.date);
        total += c.total;
        if (d >= debutMois) mois += c.total;
        if (c.semaine === semaineActuelle) semaine += c.total;
        if (d >= debutJour) jour += c.total;
    });

    res.json({ jour, semaine, mois, total, nombreCommandes: commandes.length });
});

// ============ ESPACE COMPTES (ancien dashboard de gestion) ============

app.post("/api/register", authLimiter, async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) {
        return res.status(400).json({ error: "Email et mot de passe requis." });
    }
    if (password.length < 6) {
        return res.status(400).json({ error: "Le mot de passe doit contenir au moins 6 caractères." });
    }
    if (db.findUserByEmail(email)) {
        return res.status(409).json({ error: "Un compte existe déjà avec cet email." });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = db.createUser({ email, passwordHash });
    db.addHistory(user.id, "Compte créé", email);
    req.session.userId = user.id;
    req.session.email = user.email;
    res.json({ id: user.id, email: user.email });
});

app.post("/api/login", authLimiter, async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) {
        return res.status(400).json({ error: "Email et mot de passe requis." });
    }

    const user = db.findUserByEmail(email);
    if (!user) {
        return res.status(401).json({ error: "Email ou mot de passe incorrect." });
    }

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
        return res.status(401).json({ error: "Email ou mot de passe incorrect." });
    }

    req.session.userId = user.id;
    req.session.email = user.email;
    res.json({ id: user.id, email: user.email });
});

app.post("/api/logout", (req, res) => {
    req.session.destroy(() => {
        res.json({ ok: true });
    });
});

app.get("/api/me", (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: "Non connecté." });
    }
    res.json({ id: req.session.userId, email: req.session.email });
});

app.post("/api/forgot-password", authLimiter, async (req, res) => {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: "Email requis." });

    const user = db.findUserByEmail(email);
    if (user) {
        const token = crypto.randomBytes(32).toString("hex");
        const expiry = Date.now() + 1000 * 60 * 60;
        db.setResetToken(user.id, token, expiry);
        const resetUrl = `${getBaseUrl(req)}/comptes/reset.html?token=${token}`;
        await mail.sendResetPasswordEmail(user.email, resetUrl);
    }
    res.json({ ok: true, message: "Si un compte existe avec cet email, un lien a été envoyé." });
});

app.post("/api/reset-password", async (req, res) => {
    const { token, newPassword } = req.body || {};
    if (!token || !newPassword) {
        return res.status(400).json({ error: "Lien invalide." });
    }
    if (newPassword.length < 6) {
        return res.status(400).json({ error: "Le mot de passe doit contenir au moins 6 caractères." });
    }

    const user = db.findUserByResetToken(token);
    if (!user || !user.resetTokenExpiry || Date.now() > user.resetTokenExpiry) {
        return res.status(400).json({ error: "Ce lien a expiré ou est invalide. Refais une demande." });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    db.updateUserPassword(user.id, passwordHash);
    db.clearResetToken(user.id);
    db.addHistory(user.id, "Mot de passe réinitialisé", "Via lien email");
    res.json({ ok: true });
});

app.post("/api/change-password", requireAuthComptes, async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
        return res.status(400).json({ error: "Mot de passe actuel et nouveau requis." });
    }
    if (newPassword.length < 6) {
        return res.status(400).json({ error: "Le nouveau mot de passe doit contenir au moins 6 caractères." });
    }

    const user = db.findUserById(req.session.userId);
    const ok = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!ok) {
        return res.status(401).json({ error: "Mot de passe actuel incorrect." });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    db.updateUserPassword(user.id, passwordHash);
    db.addHistory(user.id, "Mot de passe changé", "Depuis la page Compte");
    res.json({ ok: true });
});

app.get("/api/reports", requireAuthComptes, (req, res) => {
    res.json(db.getReportsByUser(req.session.userId));
});

app.post("/api/reports", requireAuthComptes, (req, res) => {
    const { date, vendu, depenses, reinvestis, note } = req.body || {};
    if (!date) {
        return res.status(400).json({ error: "La date est requise." });
    }
    const report = db.addReport(req.session.userId, { date, vendu, depenses, reinvestis, note });
    db.addHistory(req.session.userId, "Compte rendu ajouté", `${date} — Vendu: ${vendu} FCFA`);
    res.json(report);
});

app.delete("/api/reports/:id", requireAuthComptes, (req, res) => {
    const ok = db.deleteReport(req.session.userId, req.params.id);
    if (!ok) return res.status(404).json({ error: "Compte rendu introuvable." });
    db.addHistory(req.session.userId, "Compte rendu supprimé", req.params.id);
    res.json({ ok: true });
});

app.get("/api/history", requireAuthComptes, (req, res) => {
    res.json(db.getHistory(req.session.userId));
});

app.get("/api/dashboard", requireAuthComptes, (req, res) => {
    const reports = db.getReportsByUser(req.session.userId);
    const totalVendu = reports.reduce((sum, r) => sum + r.vendu, 0);
    const totalDepenses = reports.reduce((sum, r) => sum + r.depenses, 0);
    const totalReinvestis = reports.reduce((sum, r) => sum + r.reinvestis, 0);
    const benefice = totalVendu - totalDepenses - totalReinvestis;
    res.json({ totalVendu, totalDepenses, totalReinvestis, benefice, count: reports.length });
});

function startOfWeek(d) {
    const date = new Date(d);
    const day = date.getDay();
    const diff = date.getDate() - day + (day === 0 ? -6 : 1);
    return new Date(date.setDate(diff));
}

function groupReports(reports, period) {
    const groups = {};
    reports.forEach((r) => {
        const d = new Date(r.date);
        let key;
        if (period === "day") {
            key = r.date;
        } else if (period === "week") {
            const monday = startOfWeek(d);
            key = monday.toISOString().slice(0, 10);
        } else {
            key = r.date.slice(0, 7);
        }
        if (!groups[key]) groups[key] = { key, vendu: 0, depenses: 0, reinvestis: 0, benefice: 0, count: 0 };
        groups[key].vendu += r.vendu;
        groups[key].depenses += r.depenses;
        groups[key].reinvestis += r.reinvestis;
        groups[key].benefice += r.vendu - r.depenses - r.reinvestis;
        groups[key].count += 1;
    });
    return Object.values(groups).sort((a, b) => a.key.localeCompare(b.key));
}

app.get("/api/analytics", requireAuthComptes, (req, res) => {
    const period = ["day", "week", "month"].includes(req.query.period) ? req.query.period : "day";
    const reports = db.getReportsByUser(req.session.userId);
    const series = groupReports(reports, period).slice(-12);

    let bestDay = null;
    let worstDay = null;
    reports.forEach((r) => {
        const benefice = r.vendu - r.depenses - r.reinvestis;
        if (!bestDay || benefice > bestDay.benefice) bestDay = { date: r.date, benefice, vendu: r.vendu };
        if (!worstDay || benefice < worstDay.benefice) worstDay = { date: r.date, benefice, vendu: r.vendu };
    });

    res.json({ period, series, bestDay, worstDay });
});

app.get("/api/goals", requireAuthComptes, (req, res) => {
    const goal = db.getGoal(req.session.userId);
    if (!goal) return res.json({ goal: null, progress: 0, current: 0 });

    const reports = db.getReportsByUser(req.session.userId);
    const now = new Date();
    let since;
    if (goal.period === "weekly") {
        since = startOfWeek(now);
    } else {
        since = new Date(now.getFullYear(), now.getMonth(), 1);
    }
    const current = reports
        .filter((r) => new Date(r.date) >= since)
        .reduce((sum, r) => sum + (r.vendu - r.depenses - r.reinvestis), 0);

    const progress = goal.amount > 0 ? Math.min(100, Math.round((current / goal.amount) * 100)) : 0;
    res.json({ goal, current, progress });
});

app.post("/api/goals", requireAuthComptes, (req, res) => {
    const { period, amount } = req.body || {};
    if (!["weekly", "monthly"].includes(period) || !amount) {
        return res.status(400).json({ error: "Période (weekly/monthly) et montant requis." });
    }
    const goal = db.setGoal(req.session.userId, { period, amount });
    db.addHistory(req.session.userId, "Objectif fixé", `${period} — ${amount} FCFA`);
    res.json(goal);
});

app.get("/api/export/excel", requireAuthComptes, async (req, res) => {
    const reports = db.getReportsByUser(req.session.userId).slice().reverse();

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Comptes rendus");
    sheet.columns = [
        { header: "Date", key: "date", width: 14 },
        { header: "Vendu (FCFA)", key: "vendu", width: 16 },
        { header: "Dépenses (FCFA)", key: "depenses", width: 16 },
        { header: "Réinvestis (FCFA)", key: "reinvestis", width: 18 },
        { header: "Bénéfice (FCFA)", key: "benefice", width: 16 },
        { header: "Note", key: "note", width: 40 },
    ];
    sheet.getRow(1).font = { bold: true };

    reports.forEach((r) => {
        sheet.addRow({
            date: r.date,
            vendu: r.vendu,
            depenses: r.depenses,
            reinvestis: r.reinvestis,
            benefice: r.vendu - r.depenses - r.reinvestis,
            note: r.note,
        });
    });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="kiosque-alkass-rapports.xlsx"');
    await workbook.xlsx.write(res);
    res.end();
});

app.get("/api/export/pdf", requireAuthComptes, (req, res) => {
    const reports = db.getReportsByUser(req.session.userId).slice().reverse();
    const totalVendu = reports.reduce((sum, r) => sum + r.vendu, 0);
    const totalDepenses = reports.reduce((sum, r) => sum + r.depenses, 0);
    const totalReinvestis = reports.reduce((sum, r) => sum + r.reinvestis, 0);
    const benefice = totalVendu - totalDepenses - totalReinvestis;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="kiosque-alkass-rapport.pdf"');

    const doc = new PDFDocument({ margin: 40 });
    doc.pipe(res);

    doc.fontSize(20).text("Kiosque Alkass — Rapport", { align: "center" });
    doc.moveDown();
    doc.fontSize(10).fillColor("#666").text(`Généré le ${new Date().toLocaleDateString("fr-FR")}`, { align: "center" });
    doc.moveDown(2);

    doc.fillColor("#000").fontSize(13).text("Résumé global");
    doc.fontSize(11);
    doc.text(`Total vendu : ${totalVendu.toLocaleString("fr-FR")} FCFA`);
    doc.text(`Total dépenses : ${totalDepenses.toLocaleString("fr-FR")} FCFA`);
    doc.text(`Total réinvestis : ${totalReinvestis.toLocaleString("fr-FR")} FCFA`);
    doc.text(`Bénéfice net : ${benefice.toLocaleString("fr-FR")} FCFA`);
    doc.moveDown(2);

    doc.fontSize(13).text("Détail des comptes rendus");
    doc.moveDown(0.5);
    doc.fontSize(9);

    reports.forEach((r) => {
        const m = r.vendu - r.depenses - r.reinvestis;
        doc.text(
            `${r.date}  —  Vendu: ${r.vendu.toLocaleString("fr-FR")} FCFA  |  Dépenses: ${r.depenses.toLocaleString("fr-FR")}  |  Réinvestis: ${r.reinvestis.toLocaleString("fr-FR")}  |  Net: ${m.toLocaleString("fr-FR")} FCFA${r.note ? "  —  " + r.note : ""}`
        );
    });

    doc.end();
});

app.post("/api/cron/send-reminders", async (req, res) => {
    const secret = req.headers["x-cron-secret"];
    if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
        return res.status(401).json({ error: "Non autorisé." });
    }

    const today = new Date().toISOString().slice(0, 10);
    const users = db.getAllUsers();
    let sentCount = 0;

    for (const user of users) {
        if (user.lastReminderSentDate === today) continue;
        const reports = db.getReportsByUser(user.id);
        const hasReportToday = reports.some((r) => r.date === today);
        if (!hasReportToday) {
            const sent = await mail.sendReminderEmail(user.email);
            if (sent) {
                db.setLastReminderSentDate(user.id, today);
                sentCount += 1;
            }
        }
    }

    res.json({ ok: true, sentCount });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log("Kiosque Al Kass lancé sur le port " + PORT);
});
