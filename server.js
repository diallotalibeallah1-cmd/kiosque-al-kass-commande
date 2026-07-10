require("dotenv").config();
const express = require("express");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const { envoyerMessage } = require("./whatsapp");

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static("public"));

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log("Kiosque Al Kass lancé sur le port " + PORT);
});
