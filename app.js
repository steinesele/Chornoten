"use strict";
// Chornoten – entschlüsselt die Notenseiten lokal im Browser.
const $ = s => document.querySelector(s);
const LS_KEY = "chornoten-key", LS_POS = "chornoten-pos", LS_PREF = "chornoten-pref";
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} }
};
const b64 = { enc: u8 => btoa(String.fromCharCode(...u8)), dec: s => Uint8Array.from(atob(s), c => c.charCodeAt(0)) };

let meta = null, key = null, catalog = null;

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

async function loadMeta() {
  const r = await fetch("data/meta.json", { cache: "no-store" });
  if (!r.ok) throw new Error("meta");
  return r.json();
}
const dataUrl = name => `data/${name}?v=${meta.v}`;

async function deriveKey(pw) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt: b64.dec(meta.salt), iterations: meta.iter, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, true, ["decrypt"]);
}
async function decrypt(buf) {
  const u = new Uint8Array(buf);
  return crypto.subtle.decrypt({ name: "AES-GCM", iv: u.slice(0, 12) }, key, u.slice(12));
}
async function fetchDecrypt(name) {
  const r = await fetch(dataUrl(name));
  if (!r.ok) throw new Error("Datei fehlt: " + name);
  return decrypt(await r.arrayBuffer());
}
async function openCatalog() {
  catalog = JSON.parse(new TextDecoder().decode(await fetchDecrypt("katalog.bin")));
}

// ---------- Anmeldung ----------
async function boot() {
  try { meta = await loadMeta(); }
  catch { showScreen("login"); $("#loginMsg").textContent = "Keine Verbindung – bitte einmal mit Internet öffnen."; return; }
  const saved = store.get(LS_KEY);
  if (saved && saved.salt === meta.salt) {
    try {
      key = await crypto.subtle.importKey("raw", b64.dec(saved.k), "AES-GCM", true, ["decrypt"]);
      await openCatalog(); return showList();
    } catch { store.del(LS_KEY); key = null; }
  }
  showScreen("login"); $("#pw").focus();
}

$("#loginForm").addEventListener("submit", async e => {
  e.preventDefault();
  const btn = $("#loginBtn"), msg = $("#loginMsg");
  if (!meta) { try { meta = await loadMeta(); } catch { msg.textContent = "Keine Verbindung."; return; } }
  btn.disabled = true; btn.textContent = "Prüfe …"; msg.textContent = "";
  try {
    key = await deriveKey($("#pw").value);
    await openCatalog();
    if ($("#remember").checked) {
      const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key));
      store.set(LS_KEY, { salt: meta.salt, k: b64.enc(raw) });
    }
    $("#pw").value = "";
    showList();
  } catch {
    key = null; msg.textContent = "Passwort falsch.";
  } finally { btn.disabled = false; btn.textContent = "Öffnen"; }
});

$("#logoutBtn").addEventListener("click", () => {
  store.del(LS_KEY); key = null; catalog = null; showScreen("login");
});

function showScreen(id) {
  for (const s of document.querySelectorAll(".screen")) s.hidden = s.id !== id;
}

// ---------- Liste ----------
function showList() {
  showScreen("list");
  $("#listTitle").textContent = catalog.title || "Noten";
  const ol = $("#songs"); ol.innerHTML = "";
  catalog.songs.forEach((s, i) => {
    const li = document.createElement("li"), b = document.createElement("button");
    b.innerHTML = `<span><b></b><small></small></span><span class="cnt">${s.pages.length} S.</span>`;
    b.querySelector("b").textContent = s.title;
    b.querySelector("small").textContent = s.info;
    b.addEventListener("click", () => openSong(i));
    li.append(b); ol.append(li);
  });
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = navigator.standalone || matchMedia("(display-mode: standalone)").matches;
  $("#installHint").hidden = !(ios && !standalone);
  syncOffline();
}

// Alle verschlüsselten Seiten in den Offline-Speicher legen
let syncing = false;
async function syncOffline() {
  const el = $("#offlineStatus");
  if (!("caches" in window)) { el.textContent = "Offline-Speicher wird von diesem Browser nicht unterstützt."; return; }
  if (syncing) return; syncing = true;
  try {
    const cache = await caches.open("chornoten-data");
    const want = new Set(meta.files.map(f => new URL(`${f}?v=${meta.v}`, location.href).href));
    for (const req of await cache.keys()) {
      if (!req.url.endsWith("meta.json") && !want.has(req.url)) await cache.delete(req);
    }
    let done = 0;
    for (const url of want) {
      if (!(await cache.match(url))) {
        el.textContent = `Lade Noten für offline … ${Math.round(done / want.size * 100)} %`;
        const r = await fetch(url, { cache: "no-store" });
        if (!r.ok) throw new Error();
        await cache.put(url, r);
      }
      done++;
    }
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    el.innerHTML = `<span class="ok">✓</span> Alle Noten sind offline verfügbar.`;
  } catch {
    el.textContent = navigator.onLine ? "Offline-Speicher unvollständig – wird beim nächsten Öffnen ergänzt."
                                      : "Offline – zeige gespeicherte Noten.";
  } finally { syncing = false; }
}

// ---------- Notenansicht ----------
const pagesEl = $("#pages"), viewer = $("#viewer"), vbar = $("#vbar");
let song = null, songIdx = -1, cur = 0, urls = [], wakeLock = null, hideTimer = null;
const pref = Object.assign({ fitw: false, night: false }, store.get(LS_PREF) || {});

function applyPref() {
  viewer.classList.toggle("fitw", pref.fitw);
  viewer.classList.toggle("night", pref.night);
  $("#fitBtn").textContent = pref.fitw ? "Ganz" : "Breite";
  store.set(LS_PREF, pref);
}

async function openSong(i) {
  songIdx = i; song = catalog.songs[i];
  const pos = store.get(LS_POS) || {};
  cur = Math.min(pos[i] || 0, song.pages.length - 1);
  $("#vTitle").textContent = song.title;
  pagesEl.innerHTML = "";
  urls = song.pages.map(() => null);
  song.pages.forEach(() => {
    const d = document.createElement("div"); d.className = "page";
    d.innerHTML = `<span class="wait">Lade …</span>`; pagesEl.append(d);
  });
  applyPref(); showScreen("viewer"); updatePage();
  requestAnimationFrame(() => goTo(cur, false));
  showUI(); requestWake();
  // aktuelle Seite zuerst, dann der Rest
  const order = [cur, ...song.pages.map((_, k) => k).filter(k => k !== cur)];
  const mine = song;
  for (const k of order) {
    if (song !== mine) return;
    try {
      const blob = new Blob([await fetchDecrypt(song.pages[k])], { type: "image/jpeg" });
      if (song !== mine) return;
      urls[k] = URL.createObjectURL(blob);
      const img = new Image(); img.src = urls[k]; img.alt = `${song.title} – Seite ${k + 1}`; img.draggable = false;
      pagesEl.children[k].replaceChildren(img);
    } catch {
      pagesEl.children[k].innerHTML = `<span class="wait">Seite nicht verfügbar (offline noch nicht geladen)</span>`;
    }
  }
}
function closeSong() {
  urls.forEach(u => u && URL.revokeObjectURL(u)); urls = []; song = null;
  pagesEl.innerHTML = ""; releaseWake(); showScreen("list");
}
function goTo(i, smooth = true) {
  if (!song) return;
  cur = Math.max(0, Math.min(song.pages.length - 1, i));
  pagesEl.scrollTo({ left: cur * pagesEl.clientWidth, behavior: smooth ? "smooth" : "auto" });
  const p = pagesEl.children[cur]; if (p) p.scrollTop = 0;
  updatePage();
}
function updatePage() {
  $("#vPage").textContent = `Seite ${cur + 1} / ${song.pages.length}`;
  const pos = store.get(LS_POS) || {}; pos[songIdx] = cur; store.set(LS_POS, pos);
}
let scrollT;
pagesEl.addEventListener("scroll", () => {
  clearTimeout(scrollT);
  scrollT = setTimeout(() => {
    const i = Math.round(pagesEl.scrollLeft / pagesEl.clientWidth);
    if (i !== cur) { cur = i; updatePage(); }
  }, 80);
}, { passive: true });
addEventListener("resize", () => { if (song) goTo(cur, false); });

// Tippen: links = zurück, rechts = weiter, Mitte = Leiste ein/aus
pagesEl.addEventListener("click", e => {
  const x = e.clientX / innerWidth;
  if (x < 0.25) goTo(cur - 1); else if (x > 0.75) goTo(cur + 1); else toggleUI();
});
$("#prevBtn").addEventListener("click", () => goTo(cur - 1));
$("#nextBtn").addEventListener("click", () => goTo(cur + 1));
$("#backBtn").addEventListener("click", closeSong);
$("#fitBtn").addEventListener("click", () => { pref.fitw = !pref.fitw; applyPref(); goTo(cur, false); showUI(); });
$("#nightBtn").addEventListener("click", () => { pref.night = !pref.night; applyPref(); showUI(); });

// Tastatur & Bluetooth-Blätterpedale
addEventListener("keydown", e => {
  if (viewer.hidden) return;
  if (["ArrowRight", "PageDown", " ", "ArrowDown"].includes(e.key) && !(pref.fitw && e.key === "ArrowDown")) { e.preventDefault(); goTo(cur + 1); }
  else if (["ArrowLeft", "PageUp", "ArrowUp"].includes(e.key) && !(pref.fitw && e.key === "ArrowUp")) { e.preventDefault(); goTo(cur - 1); }
  else if (e.key === "Escape") closeSong();
});

function showUI() {
  vbar.classList.remove("hide"); viewer.classList.add("show-ui");
  clearTimeout(hideTimer); hideTimer = setTimeout(hideUI, 3500);
}
function hideUI() { vbar.classList.add("hide"); viewer.classList.remove("show-ui"); }
function toggleUI() { vbar.classList.contains("hide") ? showUI() : hideUI(); }

// Bildschirm beim Lesen nicht abschalten
async function requestWake() {
  try { if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen"); } catch {}
}
function releaseWake() { try { wakeLock && wakeLock.release(); } catch {} wakeLock = null; }
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && song) requestWake();
});
addEventListener("online", () => { if (catalog && !$("#list").hidden) syncOffline(); });

boot();
