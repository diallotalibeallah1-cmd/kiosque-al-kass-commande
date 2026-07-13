// mail.js
// Envoi d'emails via un compte Gmail, en utilisant un "mot de passe d'application".
// Nécessite deux variables d'environnement : GMAIL_USER et GMAIL_APP_PASSWORD.

const nodemailer = require('nodemailer');

function getTransporter() {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    return null;
  }
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });
}

async function sendMail({ to, subject, html }) {
  const transporter = getTransporter();
  if (!transporter) {
    console.warn('Email non envoyé : GMAIL_USER / GMAIL_APP_PASSWORD non configurés.');
    return false;
  }
  try {
    await transporter.sendMail({
      from: `"Kiosque Alkass" <${process.env.GMAIL_USER}>`,
      to,
      subject,
      html,
    });
    return true;
  } catch (err) {
    console.error('Erreur envoi email:', err.message);
    return false;
  }
}

function sendResetPasswordEmail(to, resetUrl) {
  return sendMail({
    to,
    subject: 'Réinitialise ton mot de passe — Kiosque Alkass',
    html: `
      <p>Bonjour,</p>
      <p>Tu as demandé à réinitialiser ton mot de passe sur Kiosque Alkass.</p>
      <p><a href="${resetUrl}">Clique ici pour choisir un nouveau mot de passe</a></p>
      <p>Ce lien expire dans 1 heure. Si tu n'es pas à l'origine de cette demande, ignore cet email.</p>
    `,
  });
}

function sendReminderEmail(to) {
  return sendMail({
    to,
    subject: "N'oublie pas ton compte rendu du jour — Kiosque Alkass",
    html: `
      <p>Bonjour,</p>
      <p>Tu n'as pas encore enregistré de compte rendu aujourd'hui sur Kiosque Alkass.</p>
      <p>Prends 2 minutes pour noter tes ventes du jour et garder ton suivi à jour !</p>
    `,
  });
}

module.exports = { sendMail, sendResetPasswordEmail, sendReminderEmail };
