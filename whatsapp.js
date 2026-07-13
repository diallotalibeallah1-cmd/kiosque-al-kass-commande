const axios = require("axios");

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_ID = process.env.WHATSAPP_PHONE_ID;
const API_VERSION = "v20.0";

async function envoyerMessage(destinataire, texte) {
    try {
        await axios.post(
            `https://graph.facebook.com/${API_VERSION}/${PHONE_ID}/messages`,
            {
                messaging_product: "whatsapp",
                to: destinataire,
                type: "text",
                text: { body: texte }
            },
            {
                headers: {
                    Authorization: `Bearer ${WHATSAPP_TOKEN}`,
                    "Content-Type": "application/json"
                }
            }
        );
    } catch (err) {
        console.error("Erreur envoi WhatsApp :", err.response?.data || err.message);
    }
}

module.exports = { envoyerMessage };
