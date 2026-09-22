const CONFIG = window.PROXP_CONFIG || {};
const API_URL = String(CONFIG.API_URL || "https://pronotexp-api.onrender.com").replace(/\/$/, "");

const state = {
  session: null,
  data: null,
  currentPage: "home",
  qrData: null,
  installPrompt: null,
  loading: false,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const pages = {
  home: ["Tableau de bord", "Accueil"],
  timetable: ["Organisation", "Emploi du temps"],
  grades: ["Évaluations", "Notes"],
  homework: ["Travail", "Devoirs"],
  attendance: ["Vie scolaire", "Vie scolaire"],
  news: ["Communication", "Actualités"],
  menus: ["Services", "Cantine"],
  settings: ["Compte local", "Paramètres"],
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;","\"":"&quot;"}[c]));
}

function formatDate(value, options = {}) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return new Intl.DateTimeFormat("fr-FR", { dateStyle: options.dateStyle || "medium", timeStyle: options.timeStyle, ...options }).format(d);
}

function formatTime(value) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" }).format(d);
}

function toast(message, isError = false) {
  const el = $("#toast");
  el.textContent = message;
  el.className = `toast show${isError ? " error" : ""}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 3200);
}

function setAuthStatus(message, error = false) {
  const el = $("#auth-status");
  el.textContent = message;
  el.className = `status${error ? " error" : ""}`;
}

const dbPromise = new Promise((resolve, reject) => {
  const request = indexedDB.open("proxp", 1);
  request.onupgradeneeded = () => request.result.createObjectStore("secrets");
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

async function setStoredSession(session) {
  const db = await dbPromise;
  await new Promise((resolve, reject) => {
    const tx = db.transaction("secrets", "readwrite");
    tx.objectStore("secrets").put(session, "pronote-session");
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function getStoredSession() {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const tx = db.transaction("secrets", "readonly");
    const request = tx.objectStore("secrets").get("pronote-session");
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function clearStoredSession() {
  const db = await dbPromise;
  await new Promise((resolve, reject) => {
    const tx = db.transaction("secrets", "readwrite");
    tx.objectStore("secrets").delete("pronote-session");
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function api(path, options = {}) {
  const response = await fetch(`${API_URL}${path}`, {
    method: options.method || "POST",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  let body = null;
  try { body = await response.json(); } catch (_) {}
  if (!response.ok) throw new Error(body?.detail || `Erreur API (${response.status})`);
  return body;
}

function switchAuthTab(name) {
  $$(".auth-tab").forEach(button => button.classList.toggle("active", button.dataset.authTab === name));
  $$(".auth-panel").forEach(panel => panel.classList.toggle("hidden", panel.dataset.authPanel !== name));
}

function decodeQrFile(file) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error("Aucun fichier sélectionné."));
    const reader = new FileReader();
    reader.onload = () => {
      const image = new Image();
      image.onload = () => {
        const canvas = document.createElement("canvas");
        const scale = Math.min(1, 1800 / Math.max(image.width, image.height));
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const context = canvas.getContext("2d", { willReadFrequently: true });
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
        if (typeof jsQR !== "function") return reject(new Error("Le décodeur QR n'est pas disponible."));
        const result = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: "attemptBoth" });
        if (!result) return reject(new Error("Aucun QR Code lisible n'a été trouvé."));
        try { resolve(JSON.parse(result.data)); } catch (_) { reject(new Error("Le QR Code ne contient pas un objet PRONOTE valide.")); }
      };
      image.onerror = () => reject(new Error("Impossible de lire l'image du QR Code."));
      image.src = reader.result;
    };
    reader.onerror = () => reject(new Error("Impossible de lire le fichier."));
    reader.readAsDataURL(file);
  });
}

async function connectWith(payload, endpoint) {
  if (state.loading) return;
  state.loading = true;
  setAuthStatus("Connexion à PRONOTE en cours…");
  try {
    const response = await api(endpoint, { body: payload });
    if (!response.auth_session?.token) throw new Error("PRONOTE n'a pas fourni de session réutilisable.");
    state.session = response.auth_session;
    state.data = response;
    await setStoredSession(state.session);
    showApp();
    toast("Connexion réussie");
    await refreshData();
  } catch (error) {
    setAuthStatus(error.message, true);
  } finally {
    state.loading = false;
  }
}

async function qrConnect() {
  const pin = $("#qr-pin").value.trim();
  if (!state.qrData) return setAuthStatus("Sélectionnez votre QR Code PRONOTE.", true);
  if (!/^\d{4}$/.test(pin)) return setAuthStatus("Le code PIN doit contenir exactement 4 chiffres.", true);
  await connectWith({ qr_data: state.qrData, pin }, "/v1/auth/qr-and-export");
}

async function tokenConnect() {
  const url = $("#token-url").value.trim(), username = $("#token-user").value.trim(), token = $("#token-value").value.trim();
  if (!url || !username || !token) return setAuthStatus("Remplissez l'URL, l'identifiant et le jeton.", true);
  await connectWith({ url, username, token }, "/v1/auth/token");
}

async function credentialConnect() {
  const url = $("#cred-url").value.trim(), username = $("#cred-user").value.trim(), password = $("#cred-pass").value, ent_name = $("#cred-ent").value || null;
  if (!url || !username || !password) return setAuthStatus("Remplissez tous les champs d'identifiants.", true);
  await connectWith({ url, username, password, ent_name }, "/v1/auth/credentials");
}

function showLogin() {
  $("#login-screen").classList.remove("hidden");
  $("#app-shell").classList.add("hidden");
}

function showApp() {
  $("#login-screen").classList.add("hidden");
  $("#app-shell").classList.remove("hidden");
  render();
}

async function refreshData() {
  if (!state.session) return;
  state.loading = true;
  $("#refresh-button").classList.add("spinning");
  try {
    state.data = await api("/v1/data", { body: { session: state.session } });
    render();
    toast("Données actualisées");
  } catch (error) {
    if (error.message.toLowerCase().includes("session") || error.message.includes("401")) {
      await clearStoredSession();
      state.session = null;
      showLogin();
    }
    toast(error.message, true);
  } finally {
    state.loading = false;
    $("#refresh-button").classList.remove("spinning");
  }
}

function changePage(page) {
  if (!pages[page]) page = "home";
  state.currentPage = page;
  $$(".nav-item").forEach(item => item.classList.toggle("active", item.dataset.page === page));
  $$(".page").forEach(section => section.classList.toggle("active", section.id === `page-${page}`));
  $("#page-kicker").textContent = pages[page][0];
  $("#page-title").textContent = pages[page][1];
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function normalizePeriods() { return Array.isArray(state.data?.periods) ? state.data.periods : []; }
function timetable() { return Array.isArray(state.data?.timetable) ? [...state.data.timetable].sort((a,b)=>new Date(a.start)-new Date(b.start)) : []; }
function homework() { return Array.isArray(state.data?.homework) ? [...state.data.homework].sort((a,b)=>new Date(a.date)-new Date(b.date)) : []; }
function news() { return Array.isArray(state.data?.news) ? [...state.data.news].sort((a,b)=>new Date(b.creation_date)-new Date(a.creation_date)) : []; }
function menus() { return Array.isArray(state.data?.menus) ? [...state.data.menus].sort((a,b)=>new Date(a.date)-new Date(b.date)) : []; }
function absences() { return Array.isArray(state.data?.absences) ? state.data.absences : []; }
function delays() { return Array.isArray(state.data?.delays) ? state.data.delays : []; }

function gradeCount() { return normalizePeriods().reduce((sum,p)=>sum + (Array.isArray(p.grades) ? p.grades.length : 0), 0); }
function homeworkPending() { return homework().filter(item => !item.done).length; }

function card(title, value, subtitle, extra = "") {
  return `<article class="metric-card glass-soft"><p>${escapeHtml(title)}</p><strong>${escapeHtml(value)}</strong><span>${escapeHtml(subtitle)}</span>${extra}</article>`;
}

function renderHome() {
  const profile = state.data?.user_info || {};
  const upcoming = timetable().filter(item => new Date(item.start) >= new Date()).slice(0, 5);
  const pending = homework().filter(item => !item.done).slice(0, 5);
  $("#page-home").innerHTML = `
    <section class="hero-grid">
      <div class="hero-card glass-card">
        <p class="eyebrow">Aujourd'hui</p>
        <h2>${escapeHtml(profile.name || "Bienvenue sur ProXP")}</h2>
        <p>${escapeHtml(profile.class_name || "Votre espace PRONOTE")}${profile.establishment ? ` · ${escapeHtml(profile.establishment)}` : ""}</p>
        <div class="hero-actions"><button class="secondary-button" data-go="timetable">Voir l'emploi du temps</button><button class="secondary-button" data-go="grades">Ouvrir mes notes</button></div>
      </div>
      <div class="identity-card glass-soft"><span class="identity-orb">${escapeHtml((profile.name || "P").trim().charAt(0).toUpperCase())}</span><div><span class="muted">Compte PRONOTE</span><strong>${escapeHtml(state.session?.username || "Compte")}</strong><small>Session enregistrée localement</small></div></div>
    </section>
    <section class="metrics-grid">${card("Notes", String(gradeCount()), "évaluations chargées")}${card("Devoirs", String(homeworkPending()), "à faire")}${card("Absences", String(absences().length), "enregistrées")}${card("Retards", String(delays().length), "enregistrés")}</section>
    <section class="section-grid">
      <article class="panel glass-card"><div class="panel-heading"><div><span class="eyebrow">Organisation</span><h3>Prochains cours</h3></div><button class="link-button" data-go="timetable">Tout voir</button></div>${upcoming.length ? upcoming.map(lessonCard).join("") : emptyState("Aucun cours à venir dans les données reçues.")}</article>
      <article class="panel glass-card"><div class="panel-heading"><div><span class="eyebrow">Travail</span><h3>Devoirs à venir</h3></div><button class="link-button" data-go="homework">Tout voir</button></div>${pending.length ? pending.map(homeworkCard).join("") : emptyState("Aucun devoir à faire.")}</article>
    </section>`;
}

function lessonCard(item) {
  return `<div class="list-row"><div class="time-pill">${formatTime(item.start)}</div><div class="list-main"><strong>${escapeHtml(item.subject || "Cours")}</strong><span>${escapeHtml(item.teacher || "Professeur non précisé")}${item.classroom ? ` · ${escapeHtml(item.classroom)}` : ""}</span></div><span class="row-date">${formatDate(item.start, { dateStyle: "medium" })}</span></div>`;
}

function homeworkCard(item) {
  return `<div class="list-row"><div class="status-dot ${item.done ? "done" : ""}"></div><div class="list-main"><strong>${escapeHtml(item.subject || "Devoir")}</strong><span>${escapeHtml(item.description || "Sans description")}</span></div><span class="row-date">${formatDate(item.date, { dateStyle: "medium" })}</span></div>`;
}

function emptyState(message) { return `<div class="empty-state"><div class="empty-icon">—</div><p>${escapeHtml(message)}</p></div>`; }

function renderTimetable() {
  const items = timetable();
  $("#page-timetable").innerHTML = `<section class="panel glass-card"><div class="panel-heading"><div><span class="eyebrow">Cours</span><h2>Emploi du temps</h2></div><span class="panel-count">${items.length} cours</span></div>${items.length ? `<div class="table-list">${items.slice(0,80).map(lessonCard).join("")}</div>` : emptyState("Aucun cours disponible.")}</section>`;
}

function renderGrades() {
  const periods = normalizePeriods();
  $("#page-grades").innerHTML = `<section class="panel glass-card"><div class="panel-heading"><div><span class="eyebrow">Évaluations</span><h2>Notes et moyennes</h2></div></div>${periods.length ? periods.map(period => `<article class="period-block"><div class="period-head"><div><strong>${escapeHtml(period.name || "Période")}</strong><span>${formatDate(period.start)} → ${formatDate(period.end)}</span></div><b>${escapeHtml(period.overall_average ?? "—")}</b></div><div class="grades-grid">${(period.grades || []).map(g => `<div class="grade-card"><div><strong>${escapeHtml(g.subject || "Matière")}</strong><small>${formatDate(g.date, {dateStyle:"medium"})}</small></div><b>${escapeHtml(g.grade ?? "—")}<small>/ ${escapeHtml(g.out_of ?? "—")}</small></b></div>`).join("") || emptyState("Aucune note dans cette période.")}</div></article>`).join("") : emptyState("Aucune période disponible.")}</section>`;
}

function renderHomework() {
  const items = homework();
  $("#page-homework").innerHTML = `<section class="panel glass-card"><div class="panel-heading"><div><span class="eyebrow">Travail</span><h2>Devoirs</h2></div><span class="panel-count">${homeworkPending()} à faire</span></div>${items.length ? `<div class="table-list">${items.map(homeworkCard).join("")}</div>` : emptyState("Aucun devoir disponible.")}</section>`;
}

function renderAttendance() {
  const a = absences(), d = delays();
  $("#page-attendance").innerHTML = `<div class="metrics-grid">${card("Absences", String(a.length), "enregistrées")}${card("Retards", String(d.length), "enregistrés")}</div><section class="section-grid"><article class="panel glass-card"><div class="panel-heading"><div><span class="eyebrow">Absences</span><h2>Absences</h2></div></div>${a.length ? a.map(x=>`<div class="list-row"><div class="time-pill">${escapeHtml(x.hours ?? "—")} h</div><div class="list-main"><strong>${formatDate(x.from)}</strong><span>${escapeHtml(x.reasons || "Motif non précisé")}</span></div><span class="badge ${x.justified ? "ok" : "warn"}">${x.justified ? "Justifiée" : "À justifier"}</span></div>`).join("") : emptyState("Aucune absence.")}</article><article class="panel glass-card"><div class="panel-heading"><div><span class="eyebrow">Retards</span><h2>Retards</h2></div></div>${d.length ? d.map(x=>`<div class="list-row"><div class="time-pill">${escapeHtml(x.minutes ?? "—")} min</div><div class="list-main"><strong>${formatDate(x.date)}</strong><span>${escapeHtml(x.justification || x.reasons || "Aucun motif")}</span></div></div>`).join("") : emptyState("Aucun retard.")}</article></section>`;
}

function renderNews() {
  const items = news();
  $("#page-news").innerHTML = `<section class="panel glass-card"><div class="panel-heading"><div><span class="eyebrow">Communication</span><h2>Actualités</h2></div></div>${items.length ? items.map(item=>`<article class="news-card glass-soft"><div class="news-head"><div><strong>${escapeHtml(item.title || "Information")}</strong><span>${escapeHtml(item.author || "Établissement")}</span></div><time>${formatDate(item.creation_date)}</time></div><p>${escapeHtml(item.content || "Aucun contenu.")}</p></article>`).join("") : emptyState("Aucune actualité.")}</section>`;
}

function renderMenus() {
  const items = menus();
  $("#page-menus").innerHTML = `<section class="panel glass-card"><div class="panel-heading"><div><span class="eyebrow">Services</span><h2>Cantine</h2></div></div>${items.length ? `<div class="menu-grid">${items.map(item=>`<article class="menu-card glass-soft"><time>${formatDate(item.date, { dateStyle:"full" })}</time><h3>${escapeHtml(item.name || "Menu")}</h3><ul>${[...(item.first_meal||[]), ...(item.main_meal||[]), ...(item.side_meal||[]), ...(item.cheese||[]), ...(item.dessert||[])].map(food=>`<li>${escapeHtml(food)}</li>`).join("") || "<li>Menu non détaillé</li>"}</ul></article>`).join("")}</div>` : emptyState("Aucun menu disponible.")}</section>`;
}

function renderSettings() {
  $("#page-settings").innerHTML = `<section class="section-grid"><article class="panel glass-card"><div class="panel-heading"><div><span class="eyebrow">Session</span><h2>Connexion locale</h2></div></div><div class="setting-row"><div><strong>Identifiant</strong><span>${escapeHtml(state.session?.username || "—")}</span></div></div><div class="setting-row"><div><strong>URL PRONOTE</strong><span>${escapeHtml(state.session?.url || "—")}</span></div></div><div class="setting-row"><div><strong>Token</strong><span>Stocké dans IndexedDB sur cet appareil.</span></div></div><button id="settings-logout" class="danger-button" type="button">Supprimer la session et se déconnecter</button></article><article class="panel glass-card"><div class="panel-heading"><div><span class="eyebrow">Application</span><h2>ProXP</h2></div></div><div class="setting-row"><div><strong>Version API</strong><span>v1</span></div></div><div class="setting-row"><div><strong>PWA</strong><span>Manifest + service worker</span></div></div><p class="muted block">ProXP est un frontend statique. Toute la communication avec PRONOTE passe par PronoteXP-api.</p></article></section>`;
  $("#settings-logout").onclick = logout;
}

function render() {
  renderHome(); renderTimetable(); renderGrades(); renderHomework(); renderAttendance(); renderNews(); renderMenus(); renderSettings(); changePage(state.currentPage);
  $$("[data-go]").forEach(btn => btn.addEventListener("click", () => changePage(btn.dataset.go)));
}

async function logout() {
  await clearStoredSession(); state.session = null; state.data = null; state.qrData = null; showLogin(); toast("Session supprimée");
}

function wire() {
  $$(".auth-tab").forEach(btn => btn.addEventListener("click", () => switchAuthTab(btn.dataset.authTab)));
  $("#qr-file-button").onclick = () => $("#qr-file").click();
  $("#qr-file").onchange = async e => {
    try { state.qrData = await decodeQrFile(e.target.files[0]); $("#qr-file-name").textContent = "QR Code détecté. Entrez votre PIN."; toast("QR Code PRONOTE détecté"); }
    catch (error) { state.qrData = null; $("#qr-file-name").textContent = error.message; toast(error.message, true); }
  };
  $("#qr-connect").onclick = qrConnect; $("#token-connect").onclick = tokenConnect; $("#cred-connect").onclick = credentialConnect;
  $("#refresh-button").onclick = refreshData; $("#logout-button").onclick = logout;
  $$(".nav-item").forEach(btn => btn.onclick = () => changePage(btn.dataset.page));

  window.addEventListener("beforeinstallprompt", event => { event.preventDefault(); state.installPrompt = event; $("#install-button").classList.remove("hidden"); });
  $("#install-button").onclick = async () => { if (!state.installPrompt) return; await state.installPrompt.prompt(); state.installPrompt = null; $("#install-button").classList.add("hidden"); };
}

async function boot() {
  wire();
  try {
    state.session = await getStoredSession();
  } catch (error) {
    toast("Le stockage local n'est pas disponible.", true);
  }
  if (state.session) { showApp(); await refreshData(); } else showLogin();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}

document.addEventListener("DOMContentLoaded", boot);
