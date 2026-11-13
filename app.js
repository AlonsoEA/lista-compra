import * as store from './store.js';

/* =========================================================
   Lista de la compra compartida
   - Lista: lo que hace falta, lo apunta cualquiera de los que comparten la lista.
   - Se puede estar en varias listas (casa, amigos…) y cambiar de una a otra.
   - Compra: se elige el súper, se van metiendo productos con su precio y la app suma.
   - Calendario: los días de compra y el ticket de cada una.
   ========================================================= */

const DEFAULT_STORES = ['Carrefour', 'Lidl', 'Cash', 'Día', 'Mercadona'];
const STORE_COLORS = { carrefour: '#1d5fd1', lidl: '#e0a800', cash: '#f97316', dia: '#e11d2e', mercadona: '#16a34a' };
const PALETTE = ['#8b5cf6', '#0ea5e9', '#ec4899', '#14b8a6', '#a16207', '#64748b'];
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const norm = (s) => String(s || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const bare = ({ id, ...rest }) => rest;

/* ---------------- Estado ---------------- */

let home = null;      // datos del hogar
let items = [];       // la lista
let trips = [];       // compras (en curso y terminadas)
let tab = 'list';
let sub = null;       // { ticket: id } cuando se está viendo un ticket
let calMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let welcome = { mode: null, busy: false, error: '' };
let index = null;     // precios y nombres conocidos, calculado a partir de las compras

/* ---------------- Números y fechas ---------------- */

const money = (n) => (Math.round((n || 0) * 100) / 100).toFixed(2).replace('.', ',') + ' €';
const parseNum = (s) => { const n = parseFloat(String(s ?? '').replace(',', '.').replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? n : null; };
const fmtNum = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000).replace('.', ','));
const fmtPrice = (n) => (n ? n.toFixed(2).replace('.', ',') : '');
const lineTotal = (l) => Math.round((l.price || 0) * (l.qty || 1) * 100) / 100;
const tripTotal = (t) => Math.round((t.lines || []).reduce((s, l) => s + lineTotal(l), 0) * 100) / 100;

const pad = (n) => String(n).padStart(2, '0');
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dateOf = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const todayKey = () => keyOf(new Date());

function longDate(k) {
  const d = dateOf(k);
  const year = d.getFullYear() !== new Date().getFullYear() ? ` de ${d.getFullYear()}` : '';
  return `${cap(DAYS[d.getDay()])}, ${d.getDate()} de ${MONTHS[d.getMonth()]}${year}`;
}
function relDay(ts) {
  const k = keyOf(new Date(ts));
  const diff = Math.round((dateOf(todayKey()) - dateOf(k)) / 86400000);
  if (diff <= 0) return 'hoy';
  if (diff === 1) return 'ayer';
  if (diff < 7) return `hace ${diff} días`;
  const d = dateOf(k);
  return `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`;
}
const timeOf = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

/* ---------------- Consultas ---------------- */

function storeColor(name) {
  const n = norm(name);
  if (STORE_COLORS[n]) return STORE_COLORS[n];
  let h = 0;
  for (const c of n) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
const dot = (name) => `<i class="dot" style="background:${storeColor(name)}"></i>`;

const myTrip = () => trips.find((t) => !t.finishedAt && t.uid === store.myUid()) || null;
const tripById = (id) => trips.find((t) => t.id === id);
const itemById = (id) => items.find((i) => i.id === id);
const finishedTrips = () => trips.filter((t) => t.finishedAt);
const inCart = (item) => !!item.cart && trips.some((t) => t.id === item.cart && !t.finishedAt);
const pendingItems = () => items.filter((i) => !inCart(i)).sort((a, b) => (a.at || 0) - (b.at || 0));
const stores = () => (home && Array.isArray(home.stores) && home.stores.length ? home.stores : DEFAULT_STORES);

// Índice de productos ya comprados: último precio (en general y por súper) y cuántas veces.
function getIndex() {
  if (index) return index;
  index = {};
  const sorted = [...trips].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  for (const t of sorted) {
    for (const l of t.lines || []) {
      const k = norm(l.name);
      if (!k) continue;
      const e = index[k] || (index[k] = { name: l.name, count: 0, last: null, byStore: {} });
      e.name = l.name;
      e.count++;
      if (l.price > 0) {
        e.last = { price: l.price, store: t.store, date: t.date };
        e.byStore[norm(t.store)] = e.last;
      }
    }
  }
  return index;
}
function lastPrice(name, storeName) {
  const e = getIndex()[norm(name)];
  if (!e || !e.last) return null;
  const same = e.byStore[norm(storeName)];
  return same ? { ...same, same: true } : { ...e.last, same: false };
}
function suggestions(text, limit = 6) {
  const q = norm(text);
  if (!q) return [];
  const taken = new Set(pendingItems().map((i) => norm(i.name)));
  return Object.entries(getIndex())
    .filter(([k]) => k.includes(q) && k !== q && !taken.has(k))
    .sort((a, b) => (a[0].startsWith(q) ? 0 : 1) - (b[0].startsWith(q) ? 0 : 1) || b[1].count - a[1].count)
    .slice(0, limit)
    .map(([, e]) => e.name);
}

/* ---------------- Interfaz común ---------------- */

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}

function openSheet(html, focusSel) {
  $('#sheet-body').innerHTML = html;
  $('#sheet').hidden = false;
  if (focusSel) { const el = $('#sheet-body ' + focusSel); if (el) { el.focus(); if (el.select) el.select(); } }
}
function closeSheet() {
  $('#sheet').hidden = true;
  $('#sheet-body').innerHTML = '';
}
function confirmSheet({ title, text, label, act, danger, attrs = '' }) {
  openSheet(`
    <h2>${esc(title)}</h2>
    ${text ? `<p class="muted">${esc(text)}</p>` : ''}
    <button class="btn ${danger ? 'danger' : ''}" data-act="${act}" ${attrs}>${esc(label)}</button>
    <button class="btn secondary" data-act="close-sheet">Cancelar</button>`);
}

const qtyField = (value) => `
  <label class="field"><span>Cantidad</span>
    <div class="stepper">
      <button type="button" data-act="step" data-d="-1" aria-label="Menos">−</button>
      <input name="qty" inputmode="decimal" autocomplete="off" value="${esc(fmtNum(value || 1))}">
      <button type="button" data-act="step" data-d="1" aria-label="Más">+</button>
    </div>
  </label>`;
const priceField = (value, hint) => `
  <label class="field"><span>Precio por unidad (€)</span>
    <input name="price" class="input big" inputmode="decimal" autocomplete="off" placeholder="0,00" value="${esc(fmtPrice(value))}">
    <small class="muted" id="price-hint">${esc(hint || '')}</small>
  </label>`;

function priceHint(name, storeName) {
  const p = lastPrice(name, storeName);
  if (!p) return '';
  return p.same ? `La última vez aquí: ${money(p.price)}` : `La última vez en ${p.store}: ${money(p.price)}`;
}

/* ---------------- Pantallas ---------------- */

function mount(screen, html) {
  const view = $('#view');
  const changed = view.dataset.screen !== screen;
  view.dataset.screen = screen;
  if (html !== null) view.innerHTML = html;
  if (changed) window.scrollTo(0, 0);
  return changed;
}

/* Pantalla siempre encendida mientras se está en la pestaña Compra con una compra en marcha.
   El sistema suelta el bloqueo al salir de la app, así que se vuelve a pedir al regresar. */
let wakeLock = null;
let wakeBusy = false;
async function syncWakeLock() {
  if (!('wakeLock' in navigator) || wakeBusy) return;
  const want = !!store.session() && !!home && tab === 'shop' && !!myTrip() && document.visibilityState === 'visible';
  if (want === !!wakeLock) return;
  wakeBusy = true;
  try {
    if (want) {
      const lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; });
      wakeLock = lock;
    } else {
      const lock = wakeLock;
      wakeLock = null;
      await lock.release();
    }
    wakeBusy = false;
    syncWakeLock(); // por si la situación cambió mientras se esperaba
  } catch (e) {
    wakeBusy = false; // sin permiso o batería baja: la app sigue funcionando igual
  }
}
document.addEventListener('visibilitychange', syncWakeLock);

function render() {
  syncWakeLock();
  const s = store.session();
  const tabbar = $('#tabbar');
  const totalbar = $('#totalbar');
  if (!s) { tabbar.hidden = true; totalbar.hidden = true; renderWelcome(); return; }
  if (!home) { tabbar.hidden = true; totalbar.hidden = true; mount('loading', `<p class="center muted loading">Cargando la lista…</p>${store.lists().length > 1 ? '<p class="center"><button class="link" data-act="lists">Cambiar de lista</button></p>' : ''}`); return; }

  tabbar.hidden = false;
  tabbar.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  const n = pendingItems().length;
  tabbar.querySelector('[data-tab="list"]').dataset.badge = n || '';

  const trip = myTrip();
  const showTotal = tab === 'shop' && !!trip;
  totalbar.hidden = !showTotal;
  document.body.classList.toggle('with-total', showTotal);
  if (showTotal) {
    const count = trip.lines.length;
    totalbar.innerHTML = `
      <div><small>${count} ${count === 1 ? 'producto' : 'productos'}</small><b>${money(tripTotal(trip))}</b></div>
      <button class="btn" data-act="finish-ask">Terminar compra</button>`;
  }

  if (tab === 'list') renderList();
  else if (tab === 'shop') (trip ? renderShopping(trip) : renderStart());
  else if (tab === 'calendar') (sub && sub.ticket && tripById(sub.ticket) ? renderTicket(tripById(sub.ticket)) : renderCalendar());
  else renderSettings();
}

/* ----- Bienvenida ----- */

function connectError(e) {
  return e.code === 'no-code' ? 'Ese código no existe. Revísalo y vuelve a probar.'
    : e.code === 'auth/operation-not-allowed' || e.code === 'auth/admin-restricted-operation' ? 'Falta activar el acceso anónimo en Firebase.'
    : e.code === 'permission-denied' ? 'Firebase ha rechazado la operación. Revisa las reglas de Firestore.'
    : 'No se ha podido conectar. Comprueba tu conexión a internet.';
}

// Entra en la lista actual (al crearla, al unirse o al cambiar de una a otra).
function enterCurrent() {
  home = null; items = []; trips = []; index = null; sub = null; tab = 'list';
  if (store.session()) startListening();
  render();
  window.scrollTo(0, 0);
}

function renderWelcome() {
  const prev = $('#welcome-form');
  const val = (n) => (prev && prev.elements[n] ? prev.elements[n].value : '');
  const name = prev ? val('name') : store.userName();
  const m = welcome.mode;
  const dis = welcome.busy ? 'disabled' : '';
  mount('welcome', `
    <div class="welcome">
      <img src="icons/icon-192.png" alt="" class="logo">
      <h1>Lista de la compra</h1>
      <p class="muted">Listas compartidas: cada uno apunta lo que hace falta desde su móvil.</p>
      <form id="welcome-form" data-form="welcome" autocomplete="off">
        <label class="field"><span>Tu nombre</span>
          <input name="name" class="input" maxlength="20" placeholder="Por ejemplo, Mamá" value="${esc(name)}">
        </label>
        ${!m ? `
          <button type="button" class="btn" data-act="welcome-mode" data-mode="create">Crear una lista nueva</button>
          <button type="button" class="btn secondary" data-act="welcome-mode" data-mode="join">Unirme a una lista con un código</button>` : ''}
        ${m === 'create' ? `
          <label class="field"><span>Nombre de la lista</span>
            <input name="list" class="input" maxlength="24" placeholder="Por ejemplo, Casa" value="${esc(val('list'))}">
          </label>
          <button class="btn" ${dis}>Crear la lista</button>` : ''}
        ${m === 'join' ? `
          <label class="field"><span>Código de la lista</span>
            <input name="code" class="input code-input" maxlength="8" autocapitalize="characters" autocorrect="off" spellcheck="false" placeholder="ABC123" value="${esc(val('code'))}">
          </label>
          <button class="btn" ${dis}>Unirme a la lista</button>` : ''}
        ${m ? `<button type="button" class="btn ghost" data-act="welcome-mode" data-mode="" ${dis}>‹ Atrás</button>` : ''}
        ${welcome.busy ? '<p class="center muted">Conectando…</p>' : ''}
        ${welcome.error ? `<p class="error">${esc(welcome.error)}</p>` : ''}
      </form>
    </div>`);
}

async function submitWelcome(form) {
  if (welcome.busy || !welcome.mode) return;
  const fail = (msg) => { welcome.error = msg; render(); };
  const name = form.elements.name.value.trim();
  if (!name) return fail('Escribe tu nombre.');
  const mode = welcome.mode;
  const listName = mode === 'create' ? cap(form.elements.list.value.trim()) : '';
  const code = mode === 'join' ? store.cleanCode(form.elements.code.value) : '';
  if (mode === 'create' && !listName) return fail('Escribe un nombre para la lista.');
  if (mode === 'join' && code.length < 6) return fail('Escribe el código de 6 letras y números.');
  welcome = { mode, busy: true, error: '' };
  render();
  try {
    if (mode === 'join') await store.joinHousehold(code, name);
    else await store.createHousehold(name, listName, DEFAULT_STORES);
    welcome = { mode: null, busy: false, error: '' };
    enterCurrent();
  } catch (e) {
    console.error(e);
    welcome = { mode, busy: false, error: connectError(e) };
    render();
  }
}

/* ----- Varias listas ----- */

function openListsSheet() {
  const cur = store.session() ? store.session().hid : null;
  openSheet(`
    <h2>Mis listas</h2>
    <div class="rows">${store.lists().map((l) => `
      <button class="row" data-act="switch-list" data-id="${esc(l.hid)}">
        <span class="circle ${l.hid === cur ? 'on' : ''}">${l.hid === cur ? '✓' : ''}</span>
        <span class="grow"><b>${esc(l.name || 'Lista')}</b>${l.hid === cur ? '<small class="muted">La que estás viendo</small>' : ''}</span>
      </button>`).join('')}</div>
    <button class="btn secondary" data-act="new-list-ask">+ Crear otra lista</button>
    <button class="btn secondary" data-act="join-list-ask">Unirme a otra lista con un código</button>`);
}

// Crea o se une a otra lista desde una ventana, mostrando el error en la propia ventana si falla.
async function connectFromSheet(form, fn) {
  const btn = form.querySelector('.btn');
  const err = form.querySelector('.error');
  if (btn.disabled) return;
  btn.disabled = true;
  err.hidden = true;
  try {
    await fn();
    closeSheet();
    enterCurrent();
  } catch (e) {
    console.error(e);
    err.textContent = e.message && !e.code ? e.message : connectError(e);
    err.hidden = false;
    btn.disabled = false;
  }
}

/* ----- Lista ----- */

function renderList() {
  // La barra para añadir se monta una sola vez para no perder el teclado al actualizarse la lista.
  if ($('#view').dataset.screen !== 'list' || !$('#list-body')) {
    mount('list', `
      <div class="header">
        <div class="eyebrow">Lista de la compra</div>
        <button class="switcher" data-act="lists" aria-label="Cambiar de lista"><h1 id="list-name"></h1><span class="chev-down">▾</span></button>
        <div class="muted small" id="list-people"></div>
      </div>
      <form class="addbar" data-form="add-item" autocomplete="off">
        <input name="name" id="add-name" class="input" maxlength="60" placeholder="Añadir producto…" enterkeyhint="done">
        <button class="btn add" aria-label="Añadir">+</button>
      </form>
      <div class="chips" id="add-suggest"></div>
      <div id="list-body"></div>`);
  }
  $('#list-name').textContent = home.name || 'Lista';
  const people = Object.keys(home.members || {}).length;
  $('#list-people').textContent = people === 1 ? 'De momento solo estás tú' : `${people} personas`;

  const others = trips.filter((t) => !t.finishedAt && t.uid !== store.myUid());
  const mine = myTrip();
  const pending = pendingItems();
  const carted = items.filter(inCart);
  let html = '';
  for (const t of others) html += `<div class="banner">${dot(t.store)}<span><b>${esc(t.by || 'Alguien')}</b> está comprando en ${esc(t.store)}</span></div>`;
  if (mine) html += `<button class="banner link-banner" data-tab="shop">${dot(mine.store)}<span>Tienes una compra en marcha en <b>${esc(mine.store)}</b></span><span class="chev">›</span></button>`;

  if (!pending.length && !carted.length) {
    html += `<div class="empty"><div class="big">🧺</div><p>No hay nada apuntado.</p><p class="muted small">Escribe arriba lo que haga falta y lo verá toda la familia.</p></div>`;
  }
  if (pending.length) {
    html += `<div class="rows">` + pending.map((i) => `
      <button class="row" data-act="edit-item" data-id="${esc(i.id)}">
        <span class="circle"></span>
        <span class="grow"><b>${esc(i.name)}</b><small class="muted">${esc(i.by || '')}${i.by ? ' · ' : ''}${relDay(i.at)}</small></span>
        ${i.qty && i.qty !== 1 ? `<span class="qty">×${esc(fmtNum(i.qty))}</span>` : ''}
      </button>`).join('') + `</div>`;
  }
  if (carted.length) {
    html += `<h2 class="sub">Ya en el carro</h2><div class="rows done">` + carted.map((i) => `
      <div class="row"><span class="circle on">✓</span><span class="grow"><b>${esc(i.name)}</b></span></div>`).join('') + `</div>`;
  }
  $('#list-body').innerHTML = html;
  renderSuggest();
}

function renderSuggest() {
  const input = $('#add-name');
  const box = $('#add-suggest');
  if (!input || !box) return;
  box.innerHTML = suggestions(input.value).map((n) => `<button type="button" class="chip small" data-act="add-suggested" data-name="${esc(n)}">+ ${esc(n)}</button>`).join('');
}

function addItem(rawName, qty = 1) {
  const name = cap(String(rawName || '').trim().replace(/\s+/g, ' '));
  if (!name) return false;
  if (pendingItems().some((i) => norm(i.name) === norm(name))) { toast(`${name} ya está en la lista`); return false; }
  const s = store.session();
  store.commit([{ put: ['items', store.newId(), { name, qty, by: s.name, at: Date.now(), cart: null }] }]);
  return true;
}

function openItemSheet(id) {
  const i = itemById(id);
  if (!i) return;
  openSheet(`
    <form data-form="item-edit" autocomplete="off">
      <input type="hidden" name="id" value="${esc(i.id)}">
      <h2>Editar producto</h2>
      <label class="field"><span>Nombre</span><input name="name" class="input" maxlength="60" value="${esc(i.name)}" required></label>
      ${qtyField(i.qty)}
      <button class="btn">Guardar</button>
      <button type="button" class="btn danger" data-act="del-item" data-id="${esc(i.id)}">Quitar de la lista</button>
    </form>`);
}

/* ----- Compra: elegir súper ----- */

function renderStart() {
  const n = pendingItems().length;
  mount('start', `
    <div class="header">
      <div class="eyebrow">${n ? `${n} ${n === 1 ? 'producto' : 'productos'} en la lista` : 'La lista está vacía'}</div>
      <h1>¿Dónde vas a comprar?</h1>
    </div>
    <div class="store-grid">
      ${stores().map((s) => `<button class="store" data-act="start-trip" data-store="${esc(s)}">${dot(s)}<b>${esc(s)}</b></button>`).join('')}
      <button class="store other" data-act="other-store"><b>Otro sitio…</b></button>
    </div>
    <p class="muted small center">Al empezar podrás ir metiendo productos con su precio y la app irá sumando.</p>`);
}

function startTrip(storeName) {
  if (myTrip()) return;
  const s = store.session();
  const now = Date.now();
  store.commit([{ put: ['trips', store.newId(), { store: storeName, date: todayKey(), startedAt: now, finishedAt: null, uid: store.myUid(), by: s.name, lines: [], total: 0 }] }]);
  window.scrollTo(0, 0);
}

/* ----- Compra en marcha ----- */

function renderShopping(trip) {
  const pending = pendingItems();
  const lines = trip.lines || [];
  mount('shopping', `
    <div class="header">
      <div class="header-row">
        <div class="eyebrow">Comprando en</div>
        <button class="link danger-link" data-act="cancel-ask">Cancelar</button>
      </div>
      <h1>${dot(trip.store)} ${esc(trip.store)}</h1>
      <div class="muted small">${esc(longDate(trip.date))}</div>
    </div>

    <h2 class="sub">De la lista${pending.length ? ` (${pending.length})` : ''}</h2>
    ${pending.length ? `<div class="rows">` + pending.map((i) => `
      <button class="row" data-act="to-cart" data-id="${esc(i.id)}">
        <span class="circle"></span>
        <span class="grow"><b>${esc(i.name)}</b>${priceHint(i.name, trip.store) ? `<small class="muted">${esc(priceHint(i.name, trip.store))}</small>` : ''}</span>
        ${i.qty && i.qty !== 1 ? `<span class="qty">×${esc(fmtNum(i.qty))}</span>` : ''}
      </button>`).join('') + `</div>` : `<p class="muted small">${items.length ? 'Ya está todo en el carro.' : 'No hay nada apuntado en la lista.'}</p>`}

    <button class="btn ghost" data-act="add-line" data-trip="${esc(trip.id)}">+ Otro producto que no está en la lista</button>

    <h2 class="sub">En el carro${lines.length ? ` (${lines.length})` : ''}</h2>
    ${lines.length ? linesHtml(trip) : '<p class="muted small">Toca un producto de la lista para meterlo en el carro con su precio.</p>'}`);
}

function linesHtml(trip) {
  return `<div class="rows">` + [...trip.lines].reverse().map((l) => `
    <button class="row" data-act="edit-line" data-trip="${esc(trip.id)}" data-id="${esc(l.id)}">
      <span class="circle on">✓</span>
      <span class="grow"><b>${esc(l.name)}</b><small class="muted">${l.price ? `${esc(fmtNum(l.qty))} × ${money(l.price)}` : 'Sin precio'}</small></span>
      <span class="amount">${money(lineTotal(l))}</span>
    </button>`).join('') + `</div>`;
}

function openToCart(itemId) {
  const trip = myTrip();
  const i = itemById(itemId);
  if (!trip || !i) return;
  const p = lastPrice(i.name, trip.store);
  openSheet(`
    <form data-form="to-cart" autocomplete="off">
      <input type="hidden" name="id" value="${esc(i.id)}">
      <h2>${esc(i.name)}</h2>
      ${priceField(p && p.same ? p.price : 0, priceHint(i.name, trip.store))}
      ${qtyField(i.qty)}
      <button class="btn">Al carro</button>
    </form>`, '[name=price]');
}

function openAddLine(tripId) {
  const trip = tripById(tripId);
  if (!trip) return;
  openSheet(`
    <form data-form="line-add" autocomplete="off">
      <input type="hidden" name="trip" value="${esc(trip.id)}">
      <h2>Añadir producto</h2>
      <label class="field"><span>Nombre</span><input name="name" class="input" maxlength="60" data-store="${esc(trip.store)}" required></label>
      <div class="chips" id="line-suggest"></div>
      ${priceField(0, '')}
      ${qtyField(1)}
      <button class="btn">${trip.finishedAt ? 'Añadir al ticket' : 'Al carro'}</button>
    </form>`, '[name=name]');
}

function openEditLine(tripId, lineId) {
  const trip = tripById(tripId);
  const l = trip && trip.lines.find((x) => x.id === lineId);
  if (!l) return;
  openSheet(`
    <form data-form="line-edit" autocomplete="off">
      <input type="hidden" name="trip" value="${esc(trip.id)}">
      <input type="hidden" name="id" value="${esc(l.id)}">
      <h2>Editar producto</h2>
      <label class="field"><span>Nombre</span><input name="name" class="input" maxlength="60" value="${esc(l.name)}" required></label>
      ${priceField(l.price, '')}
      ${qtyField(l.qty)}
      <button class="btn">Guardar</button>
      <button type="button" class="btn danger" data-act="del-line" data-trip="${esc(trip.id)}" data-id="${esc(l.id)}">${trip.finishedAt ? 'Quitar del ticket' : 'Quitar del carro'}</button>
    </form>`);
}

function readLineForm(form) {
  const price = parseNum(form.elements.price.value) || 0;
  let qty = parseNum(form.elements.qty.value);
  if (!qty || qty <= 0) qty = 1;
  return { price: Math.round(price * 100) / 100, qty };
}

function saveTrip(trip, lines, extraOps = []) {
  const next = { ...bare(trip), lines };
  next.total = tripTotal(next);
  store.commit([{ put: ['trips', trip.id, next] }, ...extraOps]);
}

function finishTrip() {
  const trip = myTrip();
  if (!trip) return;
  const next = { ...bare(trip), finishedAt: Date.now() };
  next.total = tripTotal(next);
  const ops = [{ put: ['trips', trip.id, next] }];
  for (const i of items) if (i.cart === trip.id) ops.push({ del: ['items', i.id] });
  store.commit(ops);
  closeSheet();
  tab = 'calendar';
  sub = { ticket: trip.id };
  calMonth = new Date(dateOf(trip.date).getFullYear(), dateOf(trip.date).getMonth(), 1);
  toast('Compra guardada');
  render();
  window.scrollTo(0, 0);
}

function cancelTrip() {
  const trip = myTrip();
  if (!trip) return;
  const ops = [{ del: ['trips', trip.id] }];
  for (const i of items) if (i.cart === trip.id) ops.push({ put: ['items', i.id, { ...bare(i), cart: null }] });
  store.commit(ops);
  closeSheet();
  toast('Compra cancelada');
}

/* ----- Calendario ----- */

function renderCalendar() {
  const y = calMonth.getFullYear();
  const m = calMonth.getMonth();
  const done = finishedTrips();
  const byDay = {};
  for (const t of done) (byDay[t.date] || (byDay[t.date] = [])).push(t);
  const prefix = `${y}-${pad(m + 1)}-`;
  const monthTrips = done.filter((t) => t.date.startsWith(prefix)).sort((a, b) => b.startedAt - a.startedAt);
  const spent = monthTrips.reduce((s, t) => s + (t.total || 0), 0);

  const offset = (new Date(y, m, 1).getDay() + 6) % 7; // semana empezando en lunes
  const daysIn = new Date(y, m + 1, 0).getDate();
  let cells = '';
  for (let i = 0; i < offset; i++) cells += '<span></span>';
  for (let d = 1; d <= daysIn; d++) {
    const k = `${prefix}${pad(d)}`;
    const ts = byDay[k];
    const cls = `day${ts ? ' has' : ''}${k === todayKey() ? ' today' : ''}`;
    cells += ts
      ? `<button class="${cls}" data-act="open-day" data-k="${k}">${d}<span class="dots">${ts.slice(0, 3).map((t) => dot(t.store)).join('')}</span></button>`
      : `<span class="${cls}">${d}</span>`;
  }

  mount('calendar', `
    <div class="header"><h1>Calendario</h1></div>
    <div class="cal-nav">
      <button class="icon-btn" data-act="cal-prev" aria-label="Mes anterior">‹</button>
      <b>${cap(MONTHS[m])} ${y}</b>
      <button class="icon-btn" data-act="cal-next" aria-label="Mes siguiente">›</button>
    </div>
    <div class="cal-head"><span>L</span><span>M</span><span>X</span><span>J</span><span>V</span><span>S</span><span>D</span></div>
    <div class="cal-grid">${cells}</div>

    <div class="summary">
      <div><small class="muted">Gastado en ${MONTHS[m]}</small><b>${money(spent)}</b></div>
      <div><small class="muted">Compras</small><b>${monthTrips.length}</b></div>
    </div>

    ${monthTrips.length ? `<div class="rows">` + monthTrips.map(tripRow).join('') + `</div>`
      : '<p class="muted small center">Este mes no hay compras guardadas.</p>'}`);
}

const tripRow = (t) => `
  <button class="row" data-act="open-ticket" data-id="${esc(t.id)}">
    ${dot(t.store)}
    <span class="grow"><b>${esc(t.store)}</b><small class="muted">${esc(longDate(t.date))} · ${t.lines.length} ${t.lines.length === 1 ? 'producto' : 'productos'}</small></span>
    <span class="amount">${money(t.total)}</span>
  </button>`;

function openDay(k) {
  const ts = finishedTrips().filter((t) => t.date === k).sort((a, b) => a.startedAt - b.startedAt);
  if (ts.length === 1) { sub = { ticket: ts[0].id }; render(); window.scrollTo(0, 0); return; }
  openSheet(`<h2>${esc(longDate(k))}</h2><div class="rows">${ts.map(tripRow).join('')}</div>`);
}

/* ----- Ticket ----- */

function renderTicket(t) {
  mount('ticket', `
    <button class="back" data-act="back-cal">‹ Calendario</button>
    <div class="ticket">
      <div class="t-store">${esc(t.store)}</div>
      <div class="t-date">${esc(longDate(t.date))} · ${timeOf(t.finishedAt)}</div>
      ${t.by ? `<div class="t-date">Compra de ${esc(t.by)}</div>` : ''}
      <div class="t-sep"></div>
      ${t.lines.length ? t.lines.map((l) => `
        <button class="t-line" data-act="edit-line" data-trip="${esc(t.id)}" data-id="${esc(l.id)}">
          <span class="grow">${esc(l.name)}<small>${esc(fmtNum(l.qty))} × ${l.price ? money(l.price) : 'sin precio'}</small></span>
          <span>${money(lineTotal(l))}</span>
        </button>`).join('') : '<p class="center">Sin productos</p>'}
      <div class="t-sep"></div>
      <div class="t-total"><span>TOTAL</span><span>${money(t.total)}</span></div>
      <div class="t-count">${t.lines.length} ${t.lines.length === 1 ? 'producto' : 'productos'} · ${esc(fmtNum(t.lines.reduce((s, l) => s + (l.qty || 1), 0)))} unidades</div>
    </div>
    <p class="muted small center">Toca un producto para corregir su precio o su cantidad.</p>
    <button class="btn secondary" data-act="add-line" data-trip="${esc(t.id)}">+ Añadir producto al ticket</button>
    <button class="btn danger" data-act="del-ticket-ask" data-id="${esc(t.id)}">Borrar este ticket</button>`);
}

/* ----- Ajustes ----- */

function renderSettings() {
  const s = store.session();
  const members = Object.entries(home.members || {});
  mount('settings', `
    <div class="header"><h1>Ajustes</h1></div>

    ${store.cloudEnabled ? '' : '<div class="banner warn"><span><b>Modo local.</b> Falta configurar Firebase: de momento la lista solo se guarda en este dispositivo y no se comparte.</span></div>'}

    <h2 class="sub">Lista actual</h2>
    <div class="rows">
      <button class="row" data-act="lists">
        <span class="grow"><b>${esc(home.name || 'Lista')}</b><small class="muted">Toca para cambiar de lista, crear otra o unirte a otra</small></span>
        <span class="chev">›</span>
      </button>
    </div>
    <button class="btn secondary" data-act="rename-list-ask">Cambiar el nombre de la lista</button>

    <h2 class="sub">Código de esta lista</h2>
    <div class="card center">
      <div class="code">${esc(home.code || '')}</div>
      <p class="muted small">Quien quiera unirse a esta lista escribe este código en la app. Compártelo solo con quien quieras que entre.</p>
      <button class="btn" data-act="share-code">Compartir código</button>
    </div>

    <h2 class="sub">En esta lista</h2>
    <div class="chips">${members.map(([id, n]) => `<span class="chip small static${id === store.myUid() ? ' on' : ''}">${esc(n)}${id === store.myUid() ? ' (tú)' : ''}</span>`).join('')}</div>
    <button class="btn secondary" data-act="rename-ask">Cambiar mi nombre (${esc(s.name)})</button>

    <h2 class="sub">Supermercados</h2>
    <div class="rows">
      ${stores().map((n, i) => `<div class="row">${dot(n)}<span class="grow"><b>${esc(n)}</b></span><button class="icon-btn" data-act="del-store" data-i="${i}" aria-label="Quitar ${esc(n)}">✕</button></div>`).join('')}
    </div>
    <button class="btn ghost" data-act="add-store-ask">+ Añadir supermercado</button>

    <h2 class="sub">Más</h2>
    <button class="btn secondary" data-act="change-code-ask">Cambiar el código</button>
    <button class="btn danger" data-act="leave-ask">Salir de esta lista</button>
    <p class="muted small center">Para instalarla en el iPhone: abre esta página en Safari, toca Compartir y «Añadir a pantalla de inicio».</p>`);
}

async function shareCode() {
  const text = `Únete a la lista de la compra «${home.name}».\nCódigo: ${home.code}\n${location.origin}${location.pathname}`;
  try {
    if (navigator.share) { await navigator.share({ text }); return; }
    await navigator.clipboard.writeText(text);
    toast('Código copiado');
  } catch (e) {
    if (e && e.name !== 'AbortError') toast(`Código: ${home.code}`);
  }
}

/* ---------------- Eventos ---------------- */

document.addEventListener('click', (e) => {
  const tabBtn = e.target.closest('[data-tab]');
  if (tabBtn) {
    if (tab === tabBtn.dataset.tab && tab === 'calendar') sub = null;
    tab = tabBtn.dataset.tab;
    render();
    return;
  }
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const d = el.dataset;
  switch (d.act) {
    case 'close-sheet': closeSheet(); break;

    /* Bienvenida y varias listas */
    case 'welcome-mode': {
      welcome = { mode: d.mode || null, busy: false, error: '' };
      render();
      const form = $('#welcome-form');
      const next = !form.elements.name.value.trim() ? form.elements.name : (form.elements.list || form.elements.code);
      if (next && welcome.mode) next.focus();
      break;
    }
    case 'lists': openListsSheet(); break;
    case 'switch-list':
      closeSheet();
      if (!store.session() || d.id !== store.session().hid) { store.switchTo(d.id); enterCurrent(); }
      break;
    case 'new-list-ask':
      openSheet(`
        <form data-form="new-list" autocomplete="off">
          <h2>Crear otra lista</h2>
          <label class="field"><span>Nombre de la lista</span><input name="name" class="input" maxlength="24" placeholder="Por ejemplo, Amigos" required></label>
          <p class="error" hidden></p>
          <button class="btn">Crear la lista</button>
        </form>`, '[name=name]');
      break;
    case 'join-list-ask':
      openSheet(`
        <form data-form="join-list" autocomplete="off">
          <h2>Unirme a otra lista</h2>
          <label class="field"><span>Código de la lista</span><input name="code" class="input code-input" maxlength="8" autocapitalize="characters" autocorrect="off" spellcheck="false" placeholder="ABC123" required></label>
          <p class="error" hidden></p>
          <button class="btn">Unirme a la lista</button>
        </form>`, '[name=code]');
      break;
    case 'rename-list-ask':
      openSheet(`
        <form data-form="rename-list" autocomplete="off">
          <h2>Nombre de la lista</h2>
          <label class="field"><span>Lo verán todos los que están en ella</span><input name="name" class="input" maxlength="24" value="${esc(home.name || '')}" required></label>
          <button class="btn">Guardar</button>
        </form>`, '[name=name]');
      break;

    case 'step': {
      const input = el.closest('.stepper').querySelector('input');
      const v = Math.max(1, Math.round(((parseNum(input.value) || 1) + Number(d.d)) * 1000) / 1000);
      input.value = fmtNum(v);
      break;
    }

    /* Lista */
    case 'add-suggested':
      if (addItem(d.name)) { const i = $('#add-name'); if (i) { i.value = ''; i.focus(); } renderSuggest(); }
      break;
    case 'edit-item': openItemSheet(d.id); break;
    case 'del-item': store.commit([{ del: ['items', d.id] }]); closeSheet(); break;

    /* Compra */
    case 'start-trip': startTrip(d.store); break;
    case 'other-store':
      openSheet(`
        <form data-form="store-add" data-start="1" autocomplete="off">
          <h2>¿Dónde vas a comprar?</h2>
          <label class="field"><span>Nombre del sitio</span><input name="name" class="input" maxlength="30" required></label>
          <button class="btn">Empezar compra</button>
        </form>`, '[name=name]');
      break;
    case 'to-cart': openToCart(d.id); break;
    case 'add-line': openAddLine(d.trip); break;
    case 'edit-line': openEditLine(d.trip, d.id); break;
    case 'pick-suggested': {
      const form = el.closest('form');
      form.elements.name.value = d.name;
      fillPriceFor(form);
      $('#line-suggest').innerHTML = '';
      form.elements.price.focus();
      break;
    }
    case 'del-line': {
      const trip = tripById(d.trip);
      const l = trip && trip.lines.find((x) => x.id === d.id);
      if (!l) break;
      const ops = [];
      const item = !trip.finishedAt && l.itemId ? itemById(l.itemId) : null;
      if (item) ops.push({ put: ['items', item.id, { ...bare(item), cart: null }] });
      saveTrip(trip, trip.lines.filter((x) => x.id !== d.id), ops);
      closeSheet();
      break;
    }
    case 'finish-ask': {
      const trip = myTrip();
      if (!trip) break;
      if (!trip.lines.length) { toast('El carro está vacío'); break; }
      const left = pendingItems().length;
      confirmSheet({
        title: `Total: ${money(tripTotal(trip))}`,
        text: `${trip.lines.length} ${trip.lines.length === 1 ? 'producto' : 'productos'} en ${trip.store}.` + (left ? ` Quedan ${left} en la lista para la próxima compra.` : ''),
        label: 'Terminar y guardar el ticket', act: 'finish',
      });
      break;
    }
    case 'finish': finishTrip(); break;
    case 'cancel-ask':
      confirmSheet({ title: '¿Cancelar esta compra?', text: 'No se guardará ningún ticket y los productos del carro volverán a la lista.', label: 'Cancelar la compra', act: 'cancel-trip', danger: true });
      break;
    case 'cancel-trip': cancelTrip(); break;

    /* Calendario y tickets */
    case 'cal-prev': calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() - 1, 1); render(); break;
    case 'cal-next': calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 1); render(); break;
    case 'open-day': openDay(d.k); break;
    case 'open-ticket': closeSheet(); sub = { ticket: d.id }; render(); window.scrollTo(0, 0); break;
    case 'back-cal': sub = null; render(); break;
    case 'del-ticket-ask':
      confirmSheet({ title: '¿Borrar este ticket?', text: 'Se borrará para todos los de la lista y no se puede recuperar.', label: 'Borrar ticket', act: 'del-ticket', danger: true, attrs: `data-id="${esc(d.id)}"` });
      break;
    case 'del-ticket': store.commit([{ del: ['trips', d.id] }]); sub = null; closeSheet(); toast('Ticket borrado'); render(); break;

    /* Ajustes */
    case 'share-code': shareCode(); break;
    case 'rename-ask':
      openSheet(`
        <form data-form="rename" autocomplete="off">
          <h2>Tu nombre</h2>
          <label class="field"><span>Así te verán los demás</span><input name="name" class="input" maxlength="20" value="${esc(store.session().name)}" required></label>
          <button class="btn">Guardar</button>
        </form>`, '[name=name]');
      break;
    case 'add-store-ask':
      openSheet(`
        <form data-form="store-add" autocomplete="off">
          <h2>Añadir supermercado</h2>
          <label class="field"><span>Nombre</span><input name="name" class="input" maxlength="30" required></label>
          <button class="btn">Añadir</button>
        </form>`, '[name=name]');
      break;
    case 'del-store': {
      const list = stores().filter((_, i) => i !== Number(d.i));
      if (!list.length) { toast('Tiene que quedar al menos uno'); break; }
      store.patchHome({ stores: list });
      break;
    }
    case 'change-code-ask':
      confirmSheet({ title: '¿Cambiar el código?', text: 'El código actual dejará de servir para unirse. Los que ya están en la lista siguen dentro.', label: 'Cambiar el código', act: 'change-code' });
      break;
    case 'change-code':
      closeSheet();
      store.changeCode(home.code).then(() => toast('Código cambiado')).catch(() => toast('No se ha podido cambiar. Comprueba la conexión.'));
      break;
    case 'leave-ask':
      confirmSheet({ title: '¿Salir de esta lista?', text: `Dejarás de ver «${home.name}» en este móvil. Podrás volver a entrar con el código.`, label: 'Salir', act: 'leave', danger: true });
      break;
    case 'leave':
      closeSheet();
      store.leaveHousehold().then(() => { toast('Has salido de la lista'); enterCurrent(); });
      break;
  }
});

function fillPriceFor(form) {
  const nameEl = form.elements.name;
  const p = lastPrice(nameEl.value, nameEl.dataset.store);
  const hint = form.querySelector('#price-hint');
  if (hint) hint.textContent = priceHint(nameEl.value, nameEl.dataset.store);
  if (p && p.same && !form.elements.price.value) form.elements.price.value = fmtPrice(p.price);
}

document.addEventListener('input', (e) => {
  if (e.target.id === 'add-name') renderSuggest();
  const form = e.target.closest('form[data-form="line-add"]');
  if (form && e.target.name === 'name') {
    $('#line-suggest').innerHTML = suggestions(e.target.value, 4)
      .map((n) => `<button type="button" class="chip small" data-act="pick-suggested" data-name="${esc(n)}">${esc(n)}</button>`).join('');
    const hint = form.querySelector('#price-hint');
    if (hint) hint.textContent = priceHint(e.target.value, e.target.dataset.store);
  }
});

document.addEventListener('submit', (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  const f = form.elements;
  switch (form.dataset.form) {
    case 'welcome': submitWelcome(form); break;

    case 'new-list': {
      const listName = cap(f.name.value.trim());
      if (listName) connectFromSheet(form, () => store.createHousehold(store.userName(), listName, DEFAULT_STORES));
      break;
    }
    case 'join-list': {
      const code = store.cleanCode(f.code.value);
      connectFromSheet(form, async () => {
        if (code.length < 6) throw new Error('Escribe el código de 6 letras y números.');
        await store.joinHousehold(code, store.userName());
      });
      break;
    }
    case 'rename-list': {
      const listName = cap(f.name.value.trim());
      if (listName) store.patchHome({ name: listName });
      closeSheet();
      break;
    }

    case 'add-item':
      if (addItem(f.name.value)) { f.name.value = ''; renderSuggest(); }
      f.name.focus();
      break;

    case 'item-edit': {
      const i = itemById(f.id.value);
      const name = cap(f.name.value.trim());
      if (i && name) {
        let qty = parseNum(f.qty.value);
        if (!qty || qty <= 0) qty = 1;
        store.commit([{ put: ['items', i.id, { ...bare(i), name, qty }] }]);
      }
      closeSheet();
      break;
    }

    case 'to-cart': {
      const trip = myTrip();
      const i = itemById(f.id.value);
      if (trip && i) {
        const line = { id: store.newId(), name: i.name, itemId: i.id, ...readLineForm(form) };
        saveTrip(trip, [...trip.lines, line], [{ put: ['items', i.id, { ...bare(i), cart: trip.id }] }]);
      }
      closeSheet();
      break;
    }

    case 'line-add': {
      const trip = tripById(f.trip.value);
      const name = cap(f.name.value.trim());
      if (trip && name) {
        const line = { id: store.newId(), name, ...readLineForm(form) };
        const ops = [];
        // Si estaba apuntado en la lista, se marca como cogido.
        const item = !trip.finishedAt ? pendingItems().find((i) => norm(i.name) === norm(name)) : null;
        if (item) { line.itemId = item.id; ops.push({ put: ['items', item.id, { ...bare(item), cart: trip.id }] }); }
        saveTrip(trip, [...trip.lines, line], ops);
      }
      closeSheet();
      break;
    }

    case 'line-edit': {
      const trip = tripById(f.trip.value);
      const name = cap(f.name.value.trim());
      if (trip && name) saveTrip(trip, trip.lines.map((l) => (l.id === f.id.value ? { ...l, name, ...readLineForm(form) } : l)));
      closeSheet();
      break;
    }

    case 'store-add': {
      const name = cap(f.name.value.trim());
      if (name) {
        if (!stores().some((s) => norm(s) === norm(name))) store.patchHome({ stores: [...stores(), name] });
        if (form.dataset.start) startTrip(name);
      }
      closeSheet();
      break;
    }

    case 'rename': {
      const name = f.name.value.trim();
      if (name) store.rename(name);
      closeSheet();
      render();
      break;
    }
  }
});

/* ---------------- Arranque ---------------- */

function startListening() {
  store.listen({
    onHome: (h) => { home = h; store.noteListName(h.name); render(); },
    onItems: (list) => { items = list; if (home) render(); },
    onTrips: (list) => { trips = list; index = null; if (home) render(); },
    onGone: () => {
      // El hogar ya no existe o este móvil ya no pertenece a él.
      store.forget();
      if (store.session()) { toast('Ya no formas parte de esa lista'); enterCurrent(); return; }
      home = null; items = []; trips = []; index = null;
      welcome = { mode: null, busy: false, error: 'Ya no formas parte de esa lista. Vuelve a entrar con el código.' };
      render();
    },
  });
}

async function boot() {
  try { await store.init(); }
  catch (e) { console.error(e); }
  if (store.session()) startListening();
  render();
}

boot();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
