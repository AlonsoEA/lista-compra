// Datos compartidos de cada lista (Firebase: acceso anónimo + Firestore).
// Un mismo dispositivo puede estar en varias listas (casa, amigos…); cada una es un «household».
// Estructura en Firestore:
//   codes/{CODIGO}                 -> { hid }                       (para unirse con el código)
//   households/{hid}               -> { name, code, members: { uid: nombre }, stores, createdAt }
//   households/{hid}/items/{id}    -> { name, qty, by, at, cart }   (la lista)
//   households/{hid}/trips/{id}    -> { store, date, startedAt, finishedAt, uid, by, lines, total }
//
// Si FIREBASE_CONFIG es null, la app funciona en modo local (solo este dispositivo, sin compartir).

import { FIREBASE_CONFIG } from './firebase-config.js';

export const cloudEnabled = !!(FIREBASE_CONFIG && FIREBASE_CONFIG.apiKey);

const SESSION_KEY = 'compra.session'; // { name, current, lists: [{ hid, name }] }
const LOCAL_KEY = 'compra.local';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O ni 1/I para no confundirse

let fb, auth, db;
let uid = 'local';
let unsubs = [];
let handlers = null;

export const myUid = () => uid;
export const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
export const cleanCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function randomCode() {
  const a = new Uint32Array(6);
  crypto.getRandomValues(a);
  return [...a].map((n) => CODE_CHARS[n % CODE_CHARS.length]).join('');
}

/* ---------- Listas guardadas en este dispositivo ---------- */

function loadSession() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { /* vacío */ }
  if (!s) return { name: '', current: null, lists: [] };
  // Formato anterior, cuando solo podía haber una lista.
  if (s.hid && !s.lists) s = { name: s.name || '', current: s.hid, lists: [{ hid: s.hid, name: 'Casa' }] };
  s.lists = Array.isArray(s.lists) ? s.lists : [];
  if (!s.lists.some((l) => l.hid === s.current)) s.current = s.lists.length ? s.lists[0].hid : null;
  return s;
}
function saveSession(s) { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); }

// La lista que se está viendo: { hid, name (el del usuario) }, o null si no hay ninguna.
export function session() {
  const s = loadSession();
  return s.current ? { hid: s.current, name: s.name } : null;
}
export const userName = () => loadSession().name;
export const lists = () => loadSession().lists;

function addList(hid, listName, name) {
  const s = loadSession();
  s.name = name;
  if (!s.lists.some((l) => l.hid === hid)) s.lists.push({ hid, name: listName });
  s.current = hid;
  saveSession(s);
}
function dropList(hid) {
  const s = loadSession();
  s.lists = s.lists.filter((l) => l.hid !== hid);
  if (s.current === hid) s.current = s.lists.length ? s.lists[0].hid : null;
  saveSession(s);
}
export function switchTo(hid) {
  stop();
  const s = loadSession();
  if (s.lists.some((l) => l.hid === hid)) { s.current = hid; saveSession(s); }
}
// Guarda el nombre de la lista actual para poder mostrarlo en «Mis listas».
export function noteListName(listName) {
  const s = loadSession();
  const l = s.lists.find((x) => x.hid === s.current);
  if (l && listName && l.name !== listName) { l.name = listName; saveSession(s); }
}

/* ---------- Arranque ---------- */

export async function init() {
  if (!cloudEnabled) return uid;
  fb = await import('./vendor/firebase.js');
  const app = fb.initializeApp(FIREBASE_CONFIG);
  auth = fb.getAuth(app);
  try { await fb.setPersistence(auth, fb.indexedDBLocalPersistence); }
  catch { await fb.setPersistence(auth, fb.browserLocalPersistence).catch(() => {}); }
  try {
    db = fb.initializeFirestore(app, { localCache: fb.persistentLocalCache({ tabManager: fb.persistentMultipleTabManager() }) });
  } catch {
    db = fb.initializeFirestore(app, {});
  }
  // Espera a saber si este dispositivo ya tenía identidad guardada.
  const user = await new Promise((resolve) => {
    const off = fb.onAuthStateChanged(auth, (u) => { off(); resolve(u); });
  });
  if (user) uid = user.uid;
  return uid;
}

// Da una identidad anónima a este dispositivo (hace falta conexión la primera vez).
async function ensureUser() {
  if (!cloudEnabled) return;
  if (auth.currentUser) { uid = auth.currentUser.uid; return; }
  const cred = await fb.signInAnonymously(auth);
  uid = cred.user.uid;
}

/* ---------- Modo local ---------- */

function localAll() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem(LOCAL_KEY)); } catch { /* vacío */ }
  if (!d) return {};
  return d.home ? { local: d } : d; // formato anterior: una sola lista
}
function localLoad() {
  const s = session();
  return s ? localAll()[s.hid] || null : null;
}
function localSave(d) {
  const all = localAll();
  all[session().hid] = d;
  localStorage.setItem(LOCAL_KEY, JSON.stringify(all));
}
function localEmit() {
  const d = localLoad();
  if (!handlers) return;
  if (!d) { handlers.onGone(); return; }
  handlers.onHome(d.home);
  handlers.onItems(Object.entries(d.items).map(([id, v]) => ({ id, ...v })));
  handlers.onTrips(Object.entries(d.trips).map(([id, v]) => ({ id, ...v })));
}

/* ---------- Crear / unirse / salir ---------- */

export async function createHousehold(name, listName, stores) {
  await ensureUser();
  const home = { name: listName, code: randomCode(), members: { [uid]: name }, stores, createdAt: Date.now() };
  if (!cloudEnabled) {
    const hid = newId();
    const all = localAll();
    all[hid] = { home, items: {}, trips: {} };
    localStorage.setItem(LOCAL_KEY, JSON.stringify(all));
    addList(hid, listName, name);
    return;
  }
  const ref = fb.doc(fb.collection(db, 'households'));
  for (let i = 0; ; i++) {
    try {
      const batch = fb.writeBatch(db);
      batch.set(ref, home);
      batch.set(fb.doc(db, 'codes', home.code), { hid: ref.id });
      await batch.commit();
      break;
    } catch (e) {
      // Si el código ya existía (rarísimo), se prueba con otro.
      if (i >= 3 || e.code !== 'permission-denied') throw e;
      home.code = randomCode();
    }
  }
  addList(ref.id, listName, name);
}

// Lanza un error con code 'no-code' si el código no existe.
export async function joinHousehold(code, name) {
  code = cleanCode(code);
  if (!cloudEnabled) {
    const found = Object.entries(localAll()).find(([, d]) => d.home.code === code);
    if (!found) throw Object.assign(new Error('no-code'), { code: 'no-code' });
    addList(found[0], found[1].home.name, name);
    return;
  }
  await ensureUser();
  const snap = await fb.getDocFromServer(fb.doc(db, 'codes', code));
  if (!snap.exists()) throw Object.assign(new Error('no-code'), { code: 'no-code' });
  const hid = snap.data().hid;
  const ref = fb.doc(db, 'households', hid);
  await fb.updateDoc(ref, { [`members.${uid}`]: name });
  let listName = '';
  try { listName = (await fb.getDoc(ref)).data().name || ''; } catch { /* llegará al escuchar */ }
  addList(hid, listName, name);
}

export async function leaveHousehold() {
  const s = session();
  stop();
  if (cloudEnabled && s) {
    try { await fb.updateDoc(fb.doc(db, 'households', s.hid), { [`members.${uid}`]: fb.deleteField() }); }
    catch (e) { console.error(e); }
  }
  if (s) dropList(s.hid);
}

export function forget() { const s = session(); stop(); if (s) dropList(s.hid); }

// Cambia el nombre del usuario en todas sus listas.
export function rename(name) {
  const s = loadSession();
  s.name = name;
  saveSession(s);
  if (!cloudEnabled) { patchHome({ [`members.${uid}`]: name }); return; }
  for (const l of s.lists) {
    fb.updateDoc(fb.doc(db, 'households', l.hid), { [`members.${uid}`]: name }).catch((e) => console.error('sync', e));
  }
}

// Cambia el código de invitación: el antiguo deja de servir.
export async function changeCode(oldCode) {
  const s = session();
  if (!cloudEnabled) {
    const d = localLoad();
    d.home.code = randomCode();
    localSave(d); localEmit();
    return;
  }
  for (let i = 0; ; i++) {
    const code = randomCode();
    try {
      const batch = fb.writeBatch(db);
      batch.delete(fb.doc(db, 'codes', oldCode));
      batch.set(fb.doc(db, 'codes', code), { hid: s.hid });
      batch.update(fb.doc(db, 'households', s.hid), { code });
      await batch.commit();
      return;
    } catch (e) {
      if (i >= 3 || e.code !== 'permission-denied') throw e;
    }
  }
}

/* ---------- Escuchar cambios ---------- */

// h = { onHome(home), onItems(lista), onTrips(lista), onGone() }
export function listen(h) {
  stop();
  handlers = h;
  const s = session();
  if (!s) return;
  if (!cloudEnabled) { localEmit(); return; }
  const base = fb.doc(db, 'households', s.hid);
  const fail = (e) => {
    console.error('sync', e);
    if (e.code === 'permission-denied') h.onGone();
  };
  unsubs.push(fb.onSnapshot(base, (snap) => {
    if (!snap.exists()) { if (!snap.metadata.fromCache) h.onGone(); return; }
    const home = snap.data();
    if (!home.members || !(uid in home.members)) { h.onGone(); return; }
    h.onHome(home);
  }, fail));
  const list = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  unsubs.push(fb.onSnapshot(fb.collection(base, 'items'), (snap) => h.onItems(list(snap)), fail));
  unsubs.push(fb.onSnapshot(fb.collection(base, 'trips'), (snap) => h.onTrips(list(snap)), fail));
}

export function stop() {
  unsubs.forEach((u) => u());
  unsubs = [];
  handlers = null;
}

/* ---------- Escribir ---------- */

// ops: [{ put: ['items'|'trips', id, datos] } | { del: ['items'|'trips', id] }]
// No se espera a la respuesta del servidor: sin conexión los cambios quedan en cola y se suben solos.
export function commit(ops) {
  const s = session();
  if (!s || !ops.length) return;
  if (!cloudEnabled) {
    const d = localLoad();
    for (const op of ops) {
      if (op.put) d[op.put[0]][op.put[1]] = op.put[2];
      else delete d[op.del[0]][op.del[1]];
    }
    localSave(d); localEmit();
    return;
  }
  const base = fb.doc(db, 'households', s.hid);
  const batch = fb.writeBatch(db);
  for (const op of ops) {
    if (op.put) batch.set(fb.doc(base, op.put[0], op.put[1]), op.put[2]);
    else batch.delete(fb.doc(base, op.del[0], op.del[1]));
  }
  batch.commit().catch((e) => console.error('sync', e));
}

// Cambia campos del hogar. Las claves pueden ser rutas con punto ('members.uid').
export function patchHome(patch) {
  const s = session();
  if (!s) return;
  if (!cloudEnabled) {
    const d = localLoad();
    for (const [k, v] of Object.entries(patch)) {
      const path = k.split('.');
      let o = d.home;
      while (path.length > 1) o = o[path.shift()];
      o[path[0]] = v;
    }
    localSave(d); localEmit();
    return;
  }
  fb.updateDoc(fb.doc(db, 'households', s.hid), patch).catch((e) => console.error('sync', e));
}
