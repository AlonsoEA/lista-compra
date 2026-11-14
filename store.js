// Cuenta del usuario y datos compartidos de cada lista (Firebase: correo y contraseña + Firestore).
// Un mismo usuario puede estar en varias listas (casa, amigos…); cada una es un «household».
// Estructura en Firestore:
//   users/{uid}                    -> { name, lists: { hid: nombreDeLaLista } }   (las listas de cada cuenta)
//   codes/{CODIGO}                 -> { hid }                       (para unirse con el código)
//   households/{hid}               -> { name, code, members: { uid: nombre }, stores, createdAt }
//   households/{hid}/items/{id}    -> { name, qty, by, at, cart }   (la lista)
//   households/{hid}/trips/{id}    -> { store, date, startedAt, finishedAt, uid, by, lines, total }
//
// Si FIREBASE_CONFIG es null, la app funciona en modo local (solo este dispositivo, para pruebas).

import { FIREBASE_CONFIG } from './firebase-config.js';

export const cloudEnabled = !!(FIREBASE_CONFIG && FIREBASE_CONFIG.apiKey);

const SESSION_KEY = 'compra.session'; // { uid, synced, name, current, lists: [{ hid, name }] }
const LOCAL_KEY = 'compra.local';
const LOCAL_AUTH_KEY = 'compra.localAuth';
const LOCAL_PROFILES_KEY = 'compra.localProfiles';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O ni 1/I para no confundirse

let fb, auth, db;
let uid = null;
let me = null; // { uid, email, anonymous }
let unsubs = [];
let handlers = null;

export const myUid = () => uid;
export const user = () => me;
export const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
export const cleanCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function randomCode() {
  const a = new Uint32Array(6);
  crypto.getRandomValues(a);
  return [...a].map((n) => CODE_CHARS[n % CODE_CHARS.length]).join('');
}
const readJson = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; } };
const fail = (code) => Object.assign(new Error(code), { code });

/* ---------- Listas guardadas en este dispositivo (copia de las de la cuenta) ---------- */

const emptySession = () => ({ uid: null, synced: false, name: '', current: null, lists: [] });

function loadSession() {
  let s = readJson(SESSION_KEY, null);
  if (!s) return emptySession();
  // Formato de la primera versión, cuando solo podía haber una lista.
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

function addList(hid, listName) {
  const s = loadSession();
  if (!s.lists.some((l) => l.hid === hid)) s.lists.push({ hid, name: listName });
  s.current = hid;
  saveSession(s);
  writeProfile({ lists: { [hid]: listName } });
}
function dropList(hid) {
  const s = loadSession();
  s.lists = s.lists.filter((l) => l.hid !== hid);
  if (s.current === hid) s.current = s.lists.length ? s.lists[0].hid : null;
  saveSession(s);
  removeProfileList(hid);
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
  if (l && listName && l.name !== listName) {
    l.name = listName;
    saveSession(s);
    writeProfile({ lists: { [l.hid]: listName } });
  }
}

/* ---------- Perfil de la cuenta (nombre y listas), guardado en la nube ---------- */

async function readProfile() {
  if (!cloudEnabled) return readJson(LOCAL_PROFILES_KEY, {})[uid] || null;
  const snap = await fb.getDoc(fb.doc(db, 'users', uid));
  return snap.exists() ? snap.data() : null;
}
function writeProfile(patch) {
  if (!uid) return;
  if (!cloudEnabled) {
    const all = readJson(LOCAL_PROFILES_KEY, {});
    const p = all[uid] || { name: '', lists: {} };
    all[uid] = { ...p, ...patch, lists: { ...p.lists, ...(patch.lists || {}) } };
    localStorage.setItem(LOCAL_PROFILES_KEY, JSON.stringify(all));
    return;
  }
  fb.setDoc(fb.doc(db, 'users', uid), patch, { merge: true }).catch((e) => console.error('perfil', e));
}
function removeProfileList(hid) {
  if (!uid) return;
  if (!cloudEnabled) {
    const all = readJson(LOCAL_PROFILES_KEY, {});
    if (all[uid] && all[uid].lists) { delete all[uid].lists[hid]; localStorage.setItem(LOCAL_PROFILES_KEY, JSON.stringify(all)); }
    return;
  }
  fb.updateDoc(fb.doc(db, 'users', uid), { [`lists.${hid}`]: fb.deleteField() }).catch((e) => console.error('perfil', e));
}

// Trae de la cuenta el nombre y las listas. Devuelve true si ha cambiado la lista que se estaba viendo.
// Si este dispositivo tenía listas de antes de existir las cuentas, se añaden a la cuenta.
export async function loadProfile() {
  let s = loadSession();
  if (s.uid && s.uid !== uid) s = emptySession(); // datos de otra cuenta
  const before = s.current;
  let p;
  try { p = await readProfile(); } catch (e) { console.error('perfil', e); return false; } // sin conexión
  const remote = (p && p.lists) || {};
  const extra = s.synced ? [] : s.lists.filter((l) => !(l.hid in remote));
  const name = (p && p.name) || s.name || '';
  if (!p || extra.length || (p.name || '') !== name) {
    writeProfile({ name, lists: Object.fromEntries(extra.map((l) => [l.hid, l.name || ''])) });
  }
  const merged = { ...remote };
  extra.forEach((l) => { merged[l.hid] = l.name || ''; });
  s.uid = uid;
  s.synced = true;
  s.name = name;
  s.lists = Object.entries(merged).map(([hid, listName]) => ({ hid, name: listName }));
  if (!s.lists.some((l) => l.hid === s.current)) s.current = s.lists.length ? s.lists[0].hid : null;
  saveSession(s);
  return s.current !== before;
}

/* ---------- Arranque y cuenta ---------- */

function setUser(u) {
  me = u ? { uid: u.uid, email: u.email || '', anonymous: !!u.isAnonymous } : null;
  uid = u ? u.uid : null;
}

export async function init() {
  if (!cloudEnabled) {
    const a = readJson(LOCAL_AUTH_KEY, { accounts: {}, current: null });
    const acc = a.current && a.accounts[a.current];
    setUser(acc ? { uid: acc.uid, email: a.current } : null);
    return;
  }
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
  // Espera a saber si ya había una sesión iniciada en este dispositivo.
  const u = await new Promise((resolve) => {
    const off = fb.onAuthStateChanged(auth, (x) => { off(); resolve(x); });
  });
  setUser(u);
}

export async function signUp(name, email, pw) {
  let s = loadSession();
  if (!cloudEnabled) {
    const a = readJson(LOCAL_AUTH_KEY, { accounts: {}, current: null });
    if (a.accounts[email]) throw fail('auth/email-already-in-use');
    a.accounts[email] = { pw, uid: newId() };
    a.current = email;
    localStorage.setItem(LOCAL_AUTH_KEY, JSON.stringify(a));
    setUser({ uid: a.accounts[email].uid, email });
    s = emptySession();
  } else if (auth.currentUser && auth.currentUser.isAnonymous) {
    // Este dispositivo se usaba sin cuenta: la cuenta nueva conserva sus listas.
    let cred;
    try {
      cred = await fb.linkWithCredential(auth.currentUser, fb.EmailAuthProvider.credential(email, pw));
    } catch (e) {
      const keep = ['auth/email-already-in-use', 'auth/credential-already-in-use', 'auth/invalid-email', 'auth/weak-password', 'auth/network-request-failed', 'auth/too-many-requests'];
      if (keep.includes(e.code)) throw e;
      // El acceso sin cuenta ya no está permitido: se crea una cuenta nueva desde cero.
      console.error(e);
      await fb.signOut(auth).catch(() => {});
      cred = await fb.createUserWithEmailAndPassword(auth, email, pw);
      s = emptySession();
    }
    setUser(cred.user);
    me.email = email;
    me.anonymous = false;
  } else {
    const cred = await fb.createUserWithEmailAndPassword(auth, email, pw);
    setUser(cred.user);
    s = emptySession();
  }
  const oldName = s.name;
  s.uid = uid;
  s.name = name;
  saveSession(s);
  writeProfile({ name });
  await loadProfile();
  if (oldName && oldName !== name) rename(name);
}

export async function signIn(email, pw) {
  if (!cloudEnabled) {
    const a = readJson(LOCAL_AUTH_KEY, { accounts: {}, current: null });
    const acc = a.accounts[email];
    if (!acc || acc.pw !== pw) throw fail('auth/invalid-credential');
    a.current = email;
    localStorage.setItem(LOCAL_AUTH_KEY, JSON.stringify(a));
    setUser({ uid: acc.uid, email });
    saveSession({ ...emptySession(), uid });
    await loadProfile();
    return;
  }
  // Si este dispositivo se usaba sin cuenta, se apuntan los códigos de sus listas
  // para volver a entrar en ellas con la cuenta.
  const old = [];
  if (auth.currentUser && auth.currentUser.isAnonymous) {
    for (const l of loadSession().lists) {
      try { old.push((await fb.getDoc(fb.doc(db, 'households', l.hid))).data().code); } catch { /* sin acceso */ }
    }
  }
  const cred = await fb.signInWithEmailAndPassword(auth, email, pw);
  setUser(cred.user);
  saveSession({ ...emptySession(), uid });
  await loadProfile();
  for (const code of old) {
    try { await joinHousehold(code, userName() || email.split('@')[0]); } catch (e) { console.error(e); }
  }
}

export const resetPassword = (email) => (cloudEnabled ? fb.sendPasswordResetEmail(auth, email) : Promise.resolve());

export async function signOut() {
  stop();
  if (cloudEnabled) await fb.signOut(auth);
  else {
    const a = readJson(LOCAL_AUTH_KEY, { accounts: {}, current: null });
    a.current = null;
    localStorage.setItem(LOCAL_AUTH_KEY, JSON.stringify(a));
  }
  localStorage.removeItem(SESSION_KEY);
  setUser(null);
}

// Mensaje en español para un error de inicio de sesión ('in') o de registro ('up').
export function authErrorText(e, mode = 'in') {
  const code = (e && e.code) || '';
  if (mode === 'in') {
    if (code === 'auth/user-not-found') return 'Este correo no está registrado. Pulsa «Crear cuenta» para registrarte.';
    if (code === 'auth/wrong-password') return 'La contraseña no es correcta.';
    if (code === 'auth/invalid-credential' || code === 'auth/invalid-login-credentials') {
      return 'Correo o contraseña incorrectos. Si aún no tienes cuenta, pulsa «Crear cuenta».';
    }
  }
  const map = {
    'auth/invalid-email': 'El correo electrónico no es válido.',
    'auth/missing-password': 'Escribe tu contraseña.',
    'auth/weak-password': 'La contraseña debe tener al menos 6 caracteres.',
    'auth/email-already-in-use': 'Este correo ya tiene una cuenta. Vuelve atrás e inicia sesión.',
    'auth/credential-already-in-use': 'Este correo ya tiene una cuenta. Vuelve atrás e inicia sesión.',
    'auth/too-many-requests': 'Demasiados intentos. Espera un poco y vuelve a probar.',
    'auth/network-request-failed': 'Sin conexión. Inténtalo cuando tengas internet.',
    'auth/user-not-found': 'Este correo no está registrado.',
    'auth/operation-not-allowed': 'Falta activar el acceso con correo y contraseña en Firebase.',
  };
  return map[code] || 'No se ha podido completar. Comprueba tu conexión y vuelve a probar.';
}

/* ---------- Modo local ---------- */

function localAll() {
  const d = readJson(LOCAL_KEY, null);
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
  const home = { name: listName, code: randomCode(), members: { [uid]: name }, stores, createdAt: Date.now() };
  if (!cloudEnabled) {
    const hid = newId();
    const all = localAll();
    all[hid] = { home, items: {}, trips: {} };
    localStorage.setItem(LOCAL_KEY, JSON.stringify(all));
    addList(hid, listName);
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
  addList(ref.id, listName);
}

// Lanza un error con code 'no-code' si el código no existe.
export async function joinHousehold(code, name) {
  code = cleanCode(code);
  if (!cloudEnabled) {
    const all = localAll();
    const found = Object.entries(all).find(([, d]) => d.home.code === code);
    if (!found) throw fail('no-code');
    found[1].home.members[uid] = name;
    localStorage.setItem(LOCAL_KEY, JSON.stringify(all));
    addList(found[0], found[1].home.name);
    return;
  }
  const snap = await fb.getDocFromServer(fb.doc(db, 'codes', code));
  if (!snap.exists()) throw fail('no-code');
  const hid = snap.data().hid;
  const ref = fb.doc(db, 'households', hid);
  await fb.updateDoc(ref, { [`members.${uid}`]: name });
  let listName = '';
  try { listName = (await fb.getDoc(ref)).data().name || ''; } catch { /* llegará al escuchar */ }
  addList(hid, listName);
}

export async function leaveHousehold() {
  const s = session();
  stop();
  if (s && cloudEnabled) {
    try { await fb.updateDoc(fb.doc(db, 'households', s.hid), { [`members.${uid}`]: fb.deleteField() }); }
    catch (e) { console.error(e); }
  } else if (s) {
    const all = localAll();
    if (all[s.hid]) { delete all[s.hid].home.members[uid]; localStorage.setItem(LOCAL_KEY, JSON.stringify(all)); }
  }
  if (s) dropList(s.hid);
}

export function forget() { const s = session(); stop(); if (s) dropList(s.hid); }

// Cambia el nombre del usuario en su cuenta y en todas sus listas.
export function rename(name) {
  const s = loadSession();
  s.name = name;
  saveSession(s);
  writeProfile({ name });
  if (!cloudEnabled) {
    const all = localAll();
    for (const l of s.lists) if (all[l.hid]) all[l.hid].home.members[uid] = name;
    localStorage.setItem(LOCAL_KEY, JSON.stringify(all));
    localEmit();
    return;
  }
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
  const onError = (e) => {
    console.error('sync', e);
    if (e.code === 'permission-denied') h.onGone();
  };
  unsubs.push(fb.onSnapshot(base, (snap) => {
    if (!snap.exists()) { if (!snap.metadata.fromCache) h.onGone(); return; }
    const home = snap.data();
    if (!home.members || !(uid in home.members)) { h.onGone(); return; }
    h.onHome(home);
  }, onError));
  const list = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  unsubs.push(fb.onSnapshot(fb.collection(base, 'items'), (snap) => h.onItems(list(snap)), onError));
  unsubs.push(fb.onSnapshot(fb.collection(base, 'trips'), (snap) => h.onTrips(list(snap)), onError));
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

// Cambia campos de la lista. Las claves pueden ser rutas con punto ('members.uid').
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
