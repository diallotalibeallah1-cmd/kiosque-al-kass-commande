// ---- Aides ----
function formatFCFA(n) {
  return Number(n || 0).toLocaleString('fr-FR') + ' FCFA';
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || 'Une erreur est survenue.');
  }
  return data;
}

// ---- Bascule connexion / inscription / mot de passe oublié ----
const loginForm = document.getElementById('loginForm');
const registerForm = document.getElementById('registerForm');
const forgotForm = document.getElementById('forgotForm');
const authSubtitle = document.getElementById('authSubtitle');

function showAuthForm(form) {
  [loginForm, registerForm, forgotForm].forEach((f) => f.classList.add('hidden'));
  form.classList.remove('hidden');
}

document.getElementById('showRegister').addEventListener('click', (e) => {
  e.preventDefault();
  showAuthForm(registerForm);
  authSubtitle.textContent = 'Créer un compte';
});

document.getElementById('showLogin').addEventListener('click', (e) => {
  e.preventDefault();
  showAuthForm(loginForm);
  authSubtitle.textContent = 'Connexion utilisateur';
});

document.getElementById('showForgot').addEventListener('click', (e) => {
  e.preventDefault();
  showAuthForm(forgotForm);
  authSubtitle.textContent = 'Mot de passe oublié';
});

document.getElementById('showLoginFromForgot').addEventListener('click', (e) => {
  e.preventDefault();
  showAuthForm(loginForm);
  authSubtitle.textContent = 'Connexion utilisateur';
});

// ---- Connexion ----
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('loginError');
  errorEl.classList.add('hidden');

  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPass').value;

  try {
    const user = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    enterApp(user);
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  }
});

// ---- Inscription ----
registerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('registerError');
  errorEl.classList.add('hidden');

  const email = document.getElementById('registerEmail').value.trim();
  const password = document.getElementById('registerPass').value;

  try {
    const user = await api('/api/register', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    enterApp(user);
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  }
});

// ---- Mot de passe oublié ----
forgotForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('forgotError');
  const successEl = document.getElementById('forgotSuccess');
  errorEl.classList.add('hidden');
  successEl.classList.add('hidden');

  const email = document.getElementById('forgotEmail').value.trim();
  try {
    const res = await api('/api/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
    successEl.textContent = res.message;
    successEl.classList.remove('hidden');
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  }
});

// ---- Déconnexion ----
document.getElementById('logoutBtn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  document.getElementById('app').classList.add('hidden');
  document.getElementById('authScreen').classList.remove('hidden');
  loginForm.reset();
  registerForm.reset();
});

async function enterApp(user) {
  document.getElementById('authScreen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  document.getElementById('userPill').textContent = user.email;
  document.getElementById('accountEmail').textContent = user.email;

  showLoader();
  try {
    await Promise.all([renderDashboard(), loadAnalytics('day'), loadGoal()]);
  } finally {
    hideLoader();
  }
}

async function loadHistory() {
  const tbody = document.getElementById('historyTableBody');
  tbody.innerHTML = '<tr class="empty-row"><td colspan="3">Chargement…</td></tr>';
  const history = await api('/api/history');

  if (history.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="3">Aucune action enregistrée pour l\'instant.</td></tr>';
    return;
  }

  tbody.innerHTML = '';
  history.forEach((h) => {
    const tr = document.createElement('tr');
    const dateStr = new Date(h.date).toLocaleString('fr-FR');
    tr.innerHTML = `<td>${dateStr}</td><td>${h.action}</td><td>${h.detail}</td>`;
    tbody.appendChild(tr);
  });
}

// ---- Navigation entre sections ----
document.querySelectorAll('.sidebar nav a').forEach((link) => {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    document.querySelectorAll('.sidebar nav a').forEach((a) => a.classList.remove('active'));
    link.classList.add('active');
    const section = link.dataset.section;
    document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
    document.getElementById('view-' + section).classList.remove('hidden');
    if (section === 'historique') loadHistory();
    closeMobileMenu();
  });
});

// ---- Menu mobile (hamburger) ----
const sidebar = document.getElementById('sidebar');
const mobileOverlay = document.getElementById('mobileOverlay');
const burgerBtn = document.getElementById('burgerBtn');

function openMobileMenu() {
  sidebar.classList.add('open');
  mobileOverlay.classList.add('show');
}
function closeMobileMenu() {
  sidebar.classList.remove('open');
  mobileOverlay.classList.remove('show');
}
burgerBtn.addEventListener('click', () => {
  if (sidebar.classList.contains('open')) closeMobileMenu();
  else openMobileMenu();
});
mobileOverlay.addEventListener('click', closeMobileMenu);

// ---- Spinner global ----
const globalLoader = document.getElementById('globalLoader');
function showLoader() { globalLoader.classList.remove('hidden'); }
function hideLoader() { globalLoader.classList.add('hidden'); }

// ---- Formulaire de compte rendu ----
document.getElementById('reportForm').addEventListener('submit', async (e) => {
  e.preventDefault();

  const date = document.getElementById('repDate').value;
  const vendu = Number(document.getElementById('repVendu').value) || 0;
  const depenses = Number(document.getElementById('repDepenses').value) || 0;
  const reinvestis = Number(document.getElementById('repReinvestis').value) || 0;
  const note = document.getElementById('repNote').value.trim();

  if (!date) {
    alert('Merci de choisir une date.');
    return;
  }

  try {
    await api('/api/reports', {
      method: 'POST',
      body: JSON.stringify({ date, vendu, depenses, reinvestis, note }),
    });
    e.target.reset();
    renderDashboard();
    loadAnalytics(currentPeriod);
    loadGoal();
  } catch (err) {
    alert(err.message);
  }
});

async function deleteReport(id) {
  if (!confirm('Supprimer ce compte rendu ?')) return;
  try {
    await api('/api/reports/' + id, { method: 'DELETE' });
    renderDashboard();
    loadAnalytics(currentPeriod);
    loadGoal();
  } catch (err) {
    alert(err.message);
  }
}

// ---- Affichage du tableau de bord ----
async function renderDashboard() {
  const [dashboard, reports] = await Promise.all([
    api('/api/dashboard'),
    api('/api/reports'),
  ]);

  document.getElementById('kpiVendu').textContent = formatFCFA(dashboard.totalVendu);
  document.getElementById('kpiVenduSmall').textContent = dashboard.count
    ? dashboard.count + ' compte(s) rendu(s) enregistré(s)'
    : 'Aucune vente enregistrée';
  document.getElementById('kpiDepenses').textContent = formatFCFA(dashboard.totalDepenses);
  document.getElementById('kpiReinvestis').textContent = formatFCFA(dashboard.totalReinvestis);
  document.getElementById('kpiBenefice').textContent = formatFCFA(dashboard.benefice);

  const tbody = document.getElementById('reportsTableBody');
  tbody.innerHTML = '';

  if (reports.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="4">Aucun compte rendu pour l\'instant. Ajoute-en un ci-dessous.</td></tr>';
    return;
  }

  reports.forEach((r) => {
    const tr = document.createElement('tr');
    const dateStr = new Date(r.date).toLocaleDateString('fr-FR');
    const label = r.note ? r.note : 'Compte rendu';
    const montant = r.vendu - r.depenses - r.reinvestis;
    tr.innerHTML = `<td>${dateStr}</td><td>${label}</td><td>${formatFCFA(montant)}</td>`;
    const deleteTd = document.createElement('td');
    deleteTd.className = 'delete-cell';
    const btn = document.createElement('button');
    btn.textContent = '✕';
    btn.title = 'Supprimer';
    btn.addEventListener('click', () => deleteReport(r.id));
    deleteTd.appendChild(btn);
    tr.appendChild(deleteTd);
    tbody.appendChild(tr);
  });
}

// ---- Analyse / graphiques ----
let currentPeriod = 'day';
let chartInstance = null;

document.querySelectorAll('.period-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.period-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentPeriod = btn.dataset.period;
    loadAnalytics(currentPeriod);
  });
});

async function loadAnalytics(period) {
  const data = await api('/api/analytics?period=' + period);

  const bestBox = document.getElementById('bestDayBox');
  const worstBox = document.getElementById('worstDayBox');

  if (data.bestDay) {
    const d = new Date(data.bestDay.date).toLocaleDateString('fr-FR');
    bestBox.innerHTML = `<strong>${formatFCFA(data.bestDay.benefice)}</strong>Le ${d}, avec ${formatFCFA(data.bestDay.vendu)} de ventes.`;
  } else {
    bestBox.textContent = 'Pas encore de données';
  }

  if (data.worstDay) {
    const d = new Date(data.worstDay.date).toLocaleDateString('fr-FR');
    worstBox.innerHTML = `<strong>${formatFCFA(data.worstDay.benefice)}</strong>Le ${d}, avec ${formatFCFA(data.worstDay.vendu)} de ventes.`;
  } else {
    worstBox.textContent = 'Pas encore de données';
  }

  const labels = data.series.map((s) => s.key);
  const venduData = data.series.map((s) => s.vendu);
  const beneficeData = data.series.map((s) => s.benefice);

  const ctx = document.getElementById('analyticsChart').getContext('2d');
  if (chartInstance) chartInstance.destroy();
  chartInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Vendu', data: venduData, backgroundColor: '#d8a200' },
        { label: 'Bénéfice', data: beneficeData, backgroundColor: '#7a4a1d' },
      ],
    },
    options: {
      responsive: true,
      plugins: { legend: { position: 'bottom' } },
      scales: { y: { beginAtZero: true } },
    },
  });
}

// ---- Objectifs ----
async function loadGoal() {
  const data = await api('/api/goals');
  const box = document.getElementById('goalDisplay');

  if (!data.goal) {
    box.innerHTML = '<p class="hint">Tu n\'as pas encore fixé d\'objectif.</p>';
    return;
  }

  const periodLabel = data.goal.period === 'weekly' ? 'cette semaine' : 'ce mois';
  box.innerHTML = `
    <p>Objectif ${periodLabel} : <strong>${formatFCFA(data.goal.amount)}</strong> de bénéfice net</p>
    <div class="goal-bar-track"><div class="goal-bar-fill" style="width:${data.progress}%"></div></div>
    <p class="hint">${formatFCFA(data.current)} atteints (${data.progress}%)</p>
  `;
}

document.getElementById('goalForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const period = document.getElementById('goalPeriod').value;
  const amount = Number(document.getElementById('goalAmount').value) || 0;
  try {
    await api('/api/goals', {
      method: 'POST',
      body: JSON.stringify({ period, amount }),
    });
    e.target.reset();
    loadGoal();
  } catch (err) {
    alert(err.message);
  }
});

// ---- Compte : changer le mot de passe ----
document.getElementById('changePasswordForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('changePasswordError');
  const successEl = document.getElementById('changePasswordSuccess');
  errorEl.classList.add('hidden');
  successEl.classList.add('hidden');

  const currentPassword = document.getElementById('currentPassword').value;
  const newPassword = document.getElementById('newPassword').value;

  try {
    await api('/api/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    successEl.textContent = 'Mot de passe mis à jour !';
    successEl.classList.remove('hidden');
    e.target.reset();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  }
});

// ---- Reprise de session si déjà connecté ----
(async function init() {
  try {
    const user = await api('/api/me');
    enterApp(user);
  } catch (err) {
    // Pas connecté : on reste sur l'écran de connexion.
  }
})();
