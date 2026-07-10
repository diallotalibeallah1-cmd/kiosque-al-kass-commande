require("dotenv").config();
const express = require("express");
const { envoyerMessage } = require("./whatsapp");

const app = express();
app.use(express.json());
app.use(express.static("public"));

const NUMERO_PROPRIETAIRE = process.env.NUMERO_PROPRIETAIRE;

// --- Stockage en mémoire (⚠️ se réinitialise si le serveur redémarre) ---
let commandes = [];

// --- Règles d'horaires (heure d'Abidjan = UTC+0) ---
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

app.get("/", (req, res) => {
    res.sendFile(__dirname + "/public/index.html");
});

app.post("/commander", async (req, res) => {

    const { nom, telephone, items, total } = req.body;

    if (!nom || !telephone || !items || items.length === 0) {
        return res.status(400).json({ erreur: "Informations manquantes." });
    }

    const statut = statutKiosque();

    // Validation serveur des règles horaires (ne jamais faire confiance au client)
    const aSpaghetti = items.some(i => i.produit === "Spaghetti");
    const aLait = items.some(i => i.produit === "Lait");

    if (!statut.ouvert) {
        return res.status(400).json({ erreur: "Le kiosque est actuellement fermé." });
    }
    if (aSpaghetti && statut.creneau !== "soir") {
        return res.status(400).json({ erreur: "Le spaghetti n'est disponible que le soir (20h00 à 00h30)." });
    }

    const commande = {
        id: Date.now().toString(),
        nom, telephone, items, total,
        date: new Date().toISOString(),
        semaine: numeroDeSemaine(new Date())
    };

    commandes.push(commande);

    // Notification WhatsApp au propriétaire
    const detail = items.map(i =>
        `- ${i.quantite}x ${i.produit} (${i.prix} F)${i.oeuf ? " + œuf " + i.oeuf : ""}`
    ).join("\n");

    const message = `🆕 Nouvelle commande Kiosque Al Kass !

👤 ${nom}
📞 ${telephone}

${detail}

💰 Total : ${total} FCFA`;

    if (NUMERO_PROPRIETAIRE) {
        await envoyerMessage(NUMERO_PROPRIETAIRE, message);
    }

    res.json({ succes: true });

});

app.get("/api/classement", (req, res) => {

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
        if (c.nom) parClient[c.telephone].nom = c.nom; // garde le nom le plus récent
    });

    const classement = Object.values(parClient).sort((a, b) => {
        if (b.spaghettis !== a.spaghettis) return b.spaghettis - a.spaghettis;
        return b.totalDepense - a.totalDepense; // départage par le total dépensé
    });

    res.json({ semaine: semaineActuelle, classement });

});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log("Kiosque Al Kass - commande en ligne lancé sur le port " + PORT);
});
