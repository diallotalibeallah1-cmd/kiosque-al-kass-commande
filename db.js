// db.js
// Base de données simple basée sur un fichier JSON (data/db.json).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, 'data', 'db.json');

function ensureDb() {
  if (!fs.existsSync(path.dirname(DB_PATH))) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  }
  if (!fs.existsSync(DB_PATH)) {
    const initial = { users: [], reports: [], goals: [] };
    fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2));
  }
}

function readDb() {
  ensureDb();
  const raw = fs.readFileSync(DB_PATH, 'utf-8');
  const data = JSON.parse(raw);
  if (!data.goals) data.goals = [];
  if (!data.history) data.history = [];
  return data;
}

function writeDb(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function newId() {
  return crypto.randomUUID();
}

// ---------- Utilisateurs ----------

function findUserByEmail(email) {
  const db = readDb();
  return db.users.find((u) => u.email.toLowerCase() === email.toLowerCase());
}

function findUserById(userId) {
  const db = readDb();
  return db.users.find((u) => u.id === userId);
}

function createUser({ email, passwordHash }) {
  const db = readDb();
  const user = {
    id: newId(),
    email,
    passwordHash,
    createdAt: new Date().toISOString(),
    resetToken: null,
    resetTokenExpiry: null,
    lastReminderSentDate: null,
  };
  db.users.push(user);
  writeDb(db);
  return user;
}

function updateUserPassword(userId, passwordHash) {
  const db = readDb();
  const user = db.users.find((u) => u.id === userId);
  if (!user) return null;
  user.passwordHash = passwordHash;
  writeDb(db);
  return user;
}

function setResetToken(userId, token, expiry) {
  const db = readDb();
  const user = db.users.find((u) => u.id === userId);
  if (!user) return null;
  user.resetToken = token;
  user.resetTokenExpiry = expiry;
  writeDb(db);
  return user;
}

function findUserByResetToken(token) {
  const db = readDb();
  return db.users.find((u) => u.resetToken === token);
}

function clearResetToken(userId) {
  const db = readDb();
  const user = db.users.find((u) => u.id === userId);
  if (!user) return null;
  user.resetToken = null;
  user.resetTokenExpiry = null;
  writeDb(db);
  return user;
}

function setLastReminderSentDate(userId, dateStr) {
  const db = readDb();
  const user = db.users.find((u) => u.id === userId);
  if (!user) return null;
  user.lastReminderSentDate = dateStr;
  writeDb(db);
  return user;
}

function getAllUsers() {
  const db = readDb();
  return db.users;
}

// ---------- Comptes rendus / rapports ----------

function getReportsByUser(userId) {
  const db = readDb();
  return db.reports
    .filter((r) => r.userId === userId)
    .sort((a, b) => new Date(b.date) - new Date(a.date) || b.createdAt.localeCompare(a.createdAt));
}

function addReport(userId, { date, vendu, depenses, reinvestis, note }) {
  const db = readDb();
  const report = {
    id: newId(),
    userId,
    date,
    vendu: Number(vendu) || 0,
    depenses: Number(depenses) || 0,
    reinvestis: Number(reinvestis) || 0,
    note: (note || '').trim(),
    createdAt: new Date().toISOString(),
  };
  db.reports.push(report);
  writeDb(db);
  return report;
}

function deleteReport(userId, reportId) {
  const db = readDb();
  const before = db.reports.length;
  db.reports = db.reports.filter((r) => !(r.id === reportId && r.userId === userId));
  writeDb(db);
  return db.reports.length < before;
}

// ---------- Objectifs ----------

function getGoal(userId) {
  const db = readDb();
  return db.goals.find((g) => g.userId === userId) || null;
}

function setGoal(userId, { period, amount }) {
  const db = readDb();
  let goal = db.goals.find((g) => g.userId === userId);
  if (!goal) {
    goal = { userId, period, amount: Number(amount) || 0, setAt: new Date().toISOString() };
    db.goals.push(goal);
  } else {
    goal.period = period;
    goal.amount = Number(amount) || 0;
    goal.setAt = new Date().toISOString();
  }
  writeDb(db);
  return goal;
}

// ---------- Historique (audit log) ----------

function addHistory(userId, action, detail) {
  const db = readDb();
  db.history.push({
    id: newId(),
    userId,
    action,
    detail: detail || '',
    date: new Date().toISOString(),
  });
  // On garde seulement les 300 dernières entrées par utilisateur pour ne pas grossir sans fin.
  const mine = db.history.filter((h) => h.userId === userId);
  if (mine.length > 300) {
    const idsToKeep = new Set(mine.slice(mine.length - 300).map((h) => h.id));
    db.history = db.history.filter((h) => h.userId !== userId || idsToKeep.has(h.id));
  }
  writeDb(db);
}

function getHistory(userId) {
  const db = readDb();
  return db.history
    .filter((h) => h.userId === userId)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 100);
}

module.exports = {
  findUserByEmail,
  findUserById,
  createUser,
  updateUserPassword,
  setResetToken,
  findUserByResetToken,
  clearResetToken,
  setLastReminderSentDate,
  getAllUsers,
  getReportsByUser,
  addReport,
  deleteReport,
  getGoal,
  setGoal,
  addHistory,
  getHistory,
};
