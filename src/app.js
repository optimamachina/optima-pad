'use strict';
// Optima Pad renderer. One window shows one note: a main column plus free-floating text boxes.

// ---------- constants ----------

const THEMES = [
  { id: 'paper', name: 'Paper', font: 'literata', swatch: ['#f6f0e2', '#b5683c'] },
  { id: 'terminal', name: 'Terminal', font: 'jetbrains', swatch: ['#0c120e', '#7fe0a0'] },
  { id: 'light', name: 'Light', font: 'inter', swatch: ['#fcfcfb', '#3a6fd8'] },
  { id: 'dark', name: 'Dark', font: 'inter', swatch: ['#1b1b1e', '#8ab4f8'] },
  { id: 'sage', name: 'Sage', font: 'atkinson', swatch: ['#eff3ec', '#2f7a6e'] },
  { id: 'midnight', name: 'Midnight', font: 'lexend', swatch: ['#151925', '#f2c46d'] },
];
const FONTS = [
  { id: 'literata', name: 'Literata', stack: "'Literata', Georgia, serif", scale: 1 },
  { id: 'garamond', name: 'EB Garamond', stack: "'EB Garamond', Georgia, serif", scale: 1.13 },
  { id: 'inter', name: 'Inter', stack: "'Inter', system-ui, sans-serif", scale: 0.96 },
  { id: 'lexend', name: 'Lexend', stack: "'Lexend', system-ui, sans-serif", scale: 0.94 },
  { id: 'atkinson', name: 'Atkinson Hyperlegible', stack: "'Atkinson Hyperlegible', system-ui, sans-serif", scale: 1 },
  { id: 'jetbrains', name: 'JetBrains Mono', stack: "'JetBrains Mono', Consolas, monospace", scale: 0.9 },
];
// Sizes and colours are stored as placeholder <font> attributes; styles.css paints them per theme.
const SIZES = ['opsz-1', 'opsz-2', 'opsz-3']; // regular, medium, big
const COLORS = ['#010100', '#010101', '#010102', '#010103', '#010104']; // theme text, then 4 accents
const BOXES = ['', 'bx1', 'bx2', 'bx3', 'bx4'];
const INDENTS = ['in1', 'in2', 'in3', 'in4', 'in5', 'in6'];
const CLIP_MARK = '<!--optima-pad-->';

// ---------- elements & state ----------

const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const board = $('board'), column = $('column'), scroller = $('scroller');
const ctx = $('ctx'), panel = $('panel'), veil = $('veil'), toastEl = $('toast');

const native = window.api || devApi();
const st = { ready: false, locked: false, hasPath: false, settings: { theme: 'paper', fonts: {}, size: 18, bgOn: false, bgVersion: 0 } };
const wall = { version: 0, url: null };
let zoom = 1;
let dirty = false, saveTimer = null, saving = null;
let savedRange = null;   // selection to restore after a pop-over closes
let emptyStyle = null;   // remembers Ctrl+1 / Ctrl+2 cycling inside an empty paragraph
let ctxPoint = null;     // where a right-click on empty space happened (paste makes a box there)
let dragInside = false;
let commandDepth = 0;    // >0 while we run execCommand ourselves (its input events are ours)
let paletteCache = null; // rgb() -> colour placeholder, for the current theme

document.execCommand('defaultParagraphSeparator', false, 'p');
document.execCommand('styleWithCSS', false, false);

// ---------- helpers ----------

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const isBlank = (ed) => !ed.textContent.trim() && !ed.querySelector('img, hr');
const editors = () => [column, ...board.querySelectorAll('.note .ed')];
const activeEditor = () => {
  const a = document.activeElement;
  return a && a.classList && a.classList.contains('ed') ? a : null;
};
const editorOf = (node) => {
  const el = node && (node.nodeType === 1 ? node : node.parentElement);
  return el ? el.closest('.ed') : null;
};

function exec(command, value) {
  commandDepth++;
  try { return document.execCommand(command, false, value); } finally { commandDepth--; }
}

function blockOf(node, ed) {
  if (node === ed) return null;
  while (node && node.parentNode !== ed) node = node.parentNode;
  return node && node.nodeType === 1 ? node : null;
}

function blocksInRange(range, ed) {
  const blocks = [...ed.children].filter((c) => range.intersectsNode(c));
  // A selection that ends at the very start of a paragraph doesn't really include it.
  if (blocks.length > 1) {
    const last = blocks[blocks.length - 1];
    const r = document.createRange();
    r.setStart(last, 0);
    r.setEnd(range.endContainer, range.endOffset);
    if (!r.toString() && !r.cloneContents().querySelector('img')) blocks.pop();
  }
  return blocks;
}

function textOffset(block, container, offset) {
  const r = document.createRange();
  r.selectNodeContents(block);
  r.setEnd(container, offset);
  return r.toString().length;
}

function placeCaret(block, offset) {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let node, left = offset, target = null;
  while ((node = walker.nextNode())) {
    if (left <= node.length) { target = [node, left]; break; }
    left -= node.length;
  }
  const r = document.createRange();
  if (target) r.setStart(target[0], target[1]); else { r.selectNodeContents(block); r.collapse(false); }
  r.collapse(true);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

// Caret as plain numbers, so it survives the DOM being rebuilt.
function getCaret() {
  const sel = getSelection();
  if (!sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  const ed = editorOf(r.startContainer);
  if (!ed) return null;
  const block = blockOf(r.startContainer, ed);
  if (!block) return { ed: editors().indexOf(ed), block: 0, offset: 0 };
  return { ed: editors().indexOf(ed), block: [...ed.children].indexOf(block), offset: textOffset(block, r.startContainer, r.startOffset) };
}

function setCaret(c) {
  if (!c) return;
  const ed = editors()[c.ed];
  if (!ed) return;
  ed.focus({ preventScroll: true });
  const block = ed.children[Math.min(c.block, ed.children.length - 1)];
  if (block) placeCaret(block, c.offset);
}

function firstTextIn(range, ed) {
  const walker = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (!node.textContent.trim() || !range.intersectsNode(node)) continue;
    if (node === range.startContainer && range.startOffset >= node.length) continue;
    return node;
  }
  return range.startContainer;
}

function attrAbove(node, ed, selector, attr) {
  const el = node.nodeType === 1 ? node : node.parentElement;
  const hit = el && el.closest(selector);
  return hit && ed.contains(hit) ? hit.getAttribute(attr).toLowerCase() : null;
}

function focusEnd(ed) {
  ed.focus();
  const r = document.createRange();
  r.selectNodeContents(ed.lastElementChild || ed);
  r.collapse(false);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

function rememberSelection() {
  const sel = getSelection();
  savedRange = sel.rangeCount && editorOf(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
}

function restoreSelection() {
  if (!savedRange) return;
  const ed = editorOf(savedRange.startContainer);
  if (ed && ed.isConnected) {
    ed.focus({ preventScroll: true });
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(savedRange);
  }
  savedRange = null;
}

function toast(msg, ms = 1600) {
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => toastEl.classList.add('hidden'), ms);
}

// ---------- images: blob: URLs while open (light undo history), data: URLs on disk ----------

const blobToData = new Map();
const dataToBlob = new Map();

function liveUrl(dataUrl) {
  if (dataToBlob.has(dataUrl)) return dataToBlob.get(dataUrl);
  const [head, b64] = dataUrl.split(',');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: head.slice(5).split(';')[0] }));
  blobToData.set(url, dataUrl);
  dataToBlob.set(dataUrl, url);
  return url;
}

function registerBlob(blob, dataUrl) {
  const url = URL.createObjectURL(blob);
  blobToData.set(url, dataUrl);
  dataToBlob.set(dataUrl, url);
  return url;
}

// ---------- sanitising (load, save and internal copy/paste) ----------

const ALLOWED = { P: [], DIV: [], HR: [], BR: [], B: [], STRONG: [], I: [], EM: [], U: [], S: [], STRIKE: [], A: ['href'], IMG: ['src', 'width'], FONT: ['face', 'color'] };
const DROP = new Set(['SCRIPT', 'STYLE', 'TITLE', 'META', 'LINK', 'HEAD', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE', 'SVG', 'NOSCRIPT', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'CANVAS', 'VIDEO', 'AUDIO']);
const VALID = {
  href: (v) => /^(https?:|mailto:)/i.test(v),
  src: (v) => /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(v) || blobToData.has(v),
  face: (v) => SIZES.includes(v),
  width: (v) => /^\d{1,4}$/.test(v),
  color: (v) => COLORS.includes(v.toLowerCase()),
};

function cleanTree(parent) {
  for (const node of [...parent.childNodes]) {
    if (node.nodeType === 8) { node.remove(); continue; }
    if (node.nodeType !== 1) continue;
    const tag = node.nodeName.toUpperCase();
    if (DROP.has(tag)) { node.remove(); continue; }
    cleanTree(node);
    const allowed = ALLOWED[tag];
    if (!allowed) { node.replaceWith(...node.childNodes); continue; }
    const keep = tag === 'P' || tag === 'DIV'
      ? [...node.classList].filter((c) => BOXES.includes(c) && c || INDENTS.includes(c) || c === 'bl') : [];
    for (const a of [...node.attributes]) {
      if (!(allowed.includes(a.name) && VALID[a.name](a.value))) node.removeAttribute(a.name);
    }
    if (keep.length) node.className = keep.join(' ');
    if (tag === 'FONT' && node.hasAttribute('color')) node.setAttribute('color', node.getAttribute('color').toLowerCase());
    if ((tag === 'FONT' || tag === 'A') && !node.attributes.length) node.replaceWith(...node.childNodes);
    else if (tag === 'IMG' && !node.hasAttribute('src')) node.remove();
  }
}

// mode 'live': images become blob: URLs (for the editor); 'store': images become data: URLs (for disk/clipboard)
function sanitize(html, mode) {
  const tpl = document.createElement('template'); // inert: nothing loads or runs
  tpl.innerHTML = html;
  cleanTree(tpl.content);
  for (const img of tpl.content.querySelectorAll('img')) {
    const src = img.getAttribute('src');
    if (mode === 'live' && src.startsWith('data:')) img.setAttribute('src', liveUrl(src));
    if (mode === 'store' && src.startsWith('blob:')) img.setAttribute('src', blobToData.get(src));
  }
  return tpl.innerHTML;
}

// Chrome "helpfully" freezes computed styles into style="" when it merges or pastes paragraphs.
// Turn sizes/colours back into theme-aware placeholders and drop the rest.
function palette() {
  if (paletteCache) return paletteCache;
  const probe = document.createElement('font');
  column.append(probe);
  paletteCache = {};
  for (const c of COLORS) {
    probe.setAttribute('color', c);
    paletteCache[getComputedStyle(probe).color] = c;
  }
  probe.remove();
  return paletteCache;
}

function normalize(ed) {
  const styled = ed.querySelectorAll('[style]');
  if (styled.length) {
    const base = parseFloat(getComputedStyle(ed).fontSize);
    for (const el of styled) {
      const px = parseFloat(el.style.fontSize);
      const k = px ? px / base : 1;
      const face = k > 1.5 ? 'opsz-3' : k > 1.12 ? 'opsz-2' : null;
      const color = el.style.color ? palette()[el.style.color] : null;
      el.removeAttribute('style');
      if (!face && (!color || color === COLORS[0])) continue;
      const wrap = document.createElement('font');
      if (face) wrap.setAttribute('face', face);
      if (color && color !== COLORS[0]) wrap.setAttribute('color', color);
      wrap.append(...el.childNodes);
      el.append(wrap);
    }
  }
  for (const span of ed.querySelectorAll('span')) span.replaceWith(...span.childNodes);
  // Every line of text lives in a paragraph, so boxes and sizes have something to hold on to.
  let loose = null;
  for (const n of [...ed.childNodes]) {
    const isBlock = n.nodeType === 1 && /^(P|DIV|HR)$/.test(n.nodeName);
    if (isBlock || (n.nodeType === 3 && !n.textContent.length)) { loose = null; continue; }
    if (n.nodeType !== 1 && n.nodeType !== 3) continue;
    if (!loose) { loose = document.createElement('p'); n.before(loose); }
    loose.append(n);
  }
  if (!ed.firstElementChild) ed.innerHTML = '<p><br></p>';
  if (ed.lastElementChild.nodeName === 'HR') ed.lastElementChild.after(Object.assign(document.createElement('p'), { innerHTML: '<br>' }));
}

const needsNormalize = (ed) => !!ed.querySelector('[style], span') || (ed.lastElementChild && ed.lastElementChild.nodeName === 'HR') ||
  [...ed.childNodes].some((n) => (n.nodeType === 3 && n.textContent.length) || (n.nodeType === 1 && !/^(P|DIV|HR)$/.test(n.nodeName)));

function normalizeKeepingCaret(ed) {
  if (!needsNormalize(ed) && ed.firstElementChild) return;
  const c = getCaret();
  normalize(ed);
  if (c && editors()[c.ed] === ed) setCaret(c);
}

function linkify(ed) {
  const walker = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT);
  const hits = [];
  let node;
  while ((node = walker.nextNode())) {
    if (node.parentElement.closest('a')) continue;
    if (/https?:\/\//i.test(node.textContent)) hits.push(node);
  }
  for (const text of hits) {
    const frag = document.createDocumentFragment();
    let last = 0;
    const s = text.textContent;
    for (const m of s.matchAll(URL_RE)) {
      frag.append(s.slice(last, m.index));
      const a = document.createElement('a');
      a.href = m[0];
      a.textContent = m[0];
      frag.append(a);
      last = m.index + m[0].length;
    }
    frag.append(s.slice(last));
    text.replaceWith(frag);
  }
}
const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/gi;

// ---------- undo history (our own, so the clean-ups above never confuse it) ----------

const history = { stack: [], index: -1, lastKind: null, lastTime: 0 };
let rebuilding = false; // true while undo/load swap every box out (their focusout must not tidy anything)

function clearNotes() {
  rebuilding = true;
  try { board.querySelectorAll('.note').forEach((n) => n.remove()); } finally { rebuilding = false; }
}

function noteData(n, mode) {
  if (n.classList.contains('doodle')) {
    const paths = doodlePaths(n);
    return paths.length ? { type: 'doodle', x: +n.dataset.x, y: +n.dataset.y, w: +n.dataset.w, h: +n.dataset.h, paths } : null;
  }
  const ed = n.querySelector('.ed');
  if (isBlank(ed)) return null;
  const data = { x: +n.dataset.x, y: +n.dataset.y, html: mode === 'store' ? sanitize(ed.innerHTML, 'store') : ed.innerHTML };
  if (n.dataset.w) data.w = +n.dataset.w;
  return data;
}

// Numbers from a file are checked, so a damaged or hand-edited note can't misplace or break anything.
const num = (v, fallback, min, max) => (Number.isFinite(+v) ? Math.min(max, Math.max(min, +v)) : fallback);

function restoreNote(n, mode) {
  const x = num(n.x, 0, -4000, 4000), y = num(n.y, 0, 0, 200000);
  if (n.type === 'doodle') {
    const paths = Array.isArray(n.paths) ? n.paths.filter(validPath) : [];
    return createDoodle(x, y, paths, Math.round(num(n.w, 360, 140, 1600)), Math.round(num(n.h, 220, 90, 1600)));
  }
  const w = n.w == null ? 0 : Math.round(num(n.w, 0, NOTE_MIN_W, NOTE_MAX_W));
  return createNote(x, y, mode === 'live' ? sanitize(String(n.html || ''), 'live') : n.html, w);
}

function snapshot() {
  const notes = [...board.querySelectorAll('.note')].map((n) => noteData(n)).filter(Boolean);
  return { html: column.innerHTML, notes };
}

function record(kind) {
  const snap = snapshot();
  const key = JSON.stringify(snap);
  const top = history.stack[history.index];
  const now = Date.now();
  if (top && top.key === key) { top.caret = getCaret(); return; }
  const caret = getCaret();
  const spot = caret ? `${caret.ed}:${caret.block}` : '';
  // Consecutive typing (or deleting) in the same paragraph is one undo step.
  const merge = (kind === 'insert' || kind === 'delete') && kind === history.lastKind && spot === history.lastSpot &&
    now - history.lastTime < 1200 && history.index > 0;
  history.stack.length = history.index + 1;
  if (merge) history.stack[history.index] = { ...snap, key, caret };
  else {
    history.stack.push({ ...snap, key, caret });
    if (history.stack.length > 300) history.stack.shift();
    history.index = history.stack.length - 1;
  }
  history.lastKind = kind;
  history.lastSpot = spot;
  history.lastTime = now;
}

function resetHistory() {
  history.stack = [];
  history.index = -1;
  history.lastKind = null;
  record('load');
}

function travel(step) {
  const target = history.stack[history.index + step];
  if (!target) return;
  history.index += step;
  history.lastKind = null;
  const active = document.activeElement;
  const doodleSpot = active && active.classList.contains('doodle') ? `${active.dataset.x},${active.dataset.y}` : null;
  column.innerHTML = target.html;
  clearNotes();
  for (const n of target.notes) restoreNote(n);
  const same = doodleSpot && [...board.querySelectorAll('.doodle')].find((d) => `${d.dataset.x},${d.dataset.y}` === doodleSpot);
  if (same) same.focus({ preventScroll: true }); else setCaret(target.caret);
  afterChange();
}

// ---------- look: themes & fonts ----------

function applyLook() {
  const theme = THEMES.find((t) => t.id === st.settings.theme) || THEMES[0];
  const font = FONTS.find((f) => f.id === (st.settings.fonts[theme.id] || theme.font)) || FONTS[0];
  root.dataset.theme = theme.id;
  root.style.setProperty('--font', font.stack);
  root.style.setProperty('--scale', font.scale);
  root.style.setProperty('--size', `${st.settings.size || 18}px`);
  $('size').value = st.settings.size || 18;
  paletteCache = null;
  const photo = !!(st.settings.bgOn && wall.url);
  root.classList.toggle('has-bg', photo);
  for (const b of $('themes').children) b.classList.toggle('on', b.dataset.id === theme.id || (b.dataset.id === 'photo' && photo));
  for (const b of $('fonts').children) b.classList.toggle('on', b.dataset.id === font.id);
  const cs = getComputedStyle(root);
  const bg = cs.getPropertyValue('--bg').trim();
  makeCursors(cs);
  native.setChrome({
    bg,
    fg: cs.getPropertyValue(photo ? '--text' : '--muted').trim(),
    overlay: photo ? '#00000000' : bg,
  });
  syncWall();
}

// Rounded cursors in the theme's accent colour (softer on the page than the text ink).
const CURSOR_PX = 27; // drawn on a 32-unit grid, shown a touch smaller
const CURSOR_SHAPES = {
  arrow: { hot: [7, 5], draw: (c) => blob('M7 5 L7 21.5 L11.6 17.2 L19.6 17 Z', c.accent) },
  link: { hot: [7, 5], draw: (c) => blob('M7 5 L7 21.5 L11.6 17.2 L19.6 17 Z', c.ink) },
  text: { hot: [16, 16], draw: (c) => line('M16 7.5 V24.5 M12 6.5 H20 M12 25.5 H20', c.accent, 2.4) },
  grab: { hot: [16, 16], draw: (c) => paw(c.accent, PAW_RESTING, 1, 0) },
  grabbing: { hot: [16, 16], draw: (c) => paw(c.accent, PAW_TUCKED, 0.97, 0.4) },
  pen: { hot: [16, 16], draw: (c) => `<circle cx="16" cy="16" r="7" fill="none" stroke="${c.accent}" stroke-opacity=".4" stroke-width="1.4"/><circle cx="16" cy="16" r="2.6" fill="${c.accent}"/>` },
  resize: { hot: [16, 16], draw: (c) => line('M11.5 11.5 L20.5 20.5', c.accent, 2.4) + blob('M8 8 L15 8 L8 15 Z', c.accent) + blob('M24 24 L17 24 L24 17 Z', c.accent) },
};

// A cat paw: resting while you hover a box's handle, toes tucked in while you drag.
const PAW_PAD = 'M16 15.4 C19.7 15.4 23 18.7 23 21.7 C23 24.3 21 25.4 19 25.1 C17.8 24.9 17 24.4 16 24.4 ' +
  'C15 24.4 14.2 24.9 13 25.1 C11 25.4 9 24.3 9 21.7 C9 18.7 12.3 15.4 16 15.4 Z';
const PAW_RESTING = [[9.4, 14.4, -22], [13.3, 10.4, -8], [18.7, 10.4, 8], [22.6, 14.4, 22]];
const PAW_TUCKED = [[11.2, 17.8, -16], [14.2, 15, -5], [17.8, 15, 5], [20.8, 17.8, 16]];
function paw(fill, toes, padScale, padShift) {
  const beans = toes.map(([x, y, r]) => `<ellipse cx="${x}" cy="${y}" rx="2.25" ry="2.8" transform="rotate(${r} ${x} ${y})" fill="${fill}"/>`).join('');
  return `<g transform="translate(16 17) scale(1.15) translate(-16 -17)">${beans}` +
    `<path d="${PAW_PAD}" fill="${fill}" transform="translate(16 ${20 + padShift}) scale(${padScale}) translate(-16 -20)"/></g>`;
}

// Solid shape with softly rounded corners (no outline).
function blob(d, fill) {
  return `<path d="${d}" fill="${fill}" stroke="${fill}" stroke-width="2.2" stroke-linejoin="round"/>`;
}
function line(d, color, w) {
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round"/>`;
}

function makeCursors(cs) {
  const c = {
    ink: cs.getPropertyValue('--text').trim(),
    accent: cs.getPropertyValue('--accent').trim(),
  };
  const fallback = { arrow: 'default', link: 'pointer', text: 'text', grab: 'grab', grabbing: 'grabbing', pen: 'crosshair', resize: 'nwse-resize' };
  for (const [name, shape] of Object.entries(CURSOR_SHAPES)) {
    const art = shape.draw(c);
    const url = (px) => `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 32 32">${art}</svg>`)}")`;
    const [hx, hy] = shape.hot.map((v) => Math.round((v * CURSOR_PX) / 32));
    root.style.setProperty(`--cur-${name}`,
      `-webkit-image-set(${url(CURSOR_PX)} 1x, ${url(CURSOR_PX * 2)} 2x) ${hx} ${hy}, ${fallback[name]}`);
  }
}

// The custom photo lives with the app; fetch it once per version and show it behind everything.
async function syncWall() {
  const v = st.settings.bgVersion || 0;
  if (v === wall.version) return;
  wall.version = v;
  const data = v ? await native.getBackground() : null;
  if (wall.version !== v) return;
  wall.url = data ? liveUrl(data) : null;
  if (wall.url) root.style.setProperty('--wall', `url("${wall.url}")`);
  renderWallSwatches();
  applyLook();
}

function renderWallSwatches() {
  $('themes').querySelectorAll('.photo, .add').forEach((b) => b.remove());
  if (wall.url) {
    const b = document.createElement('button');
    b.className = 'swatch photo'; b.dataset.id = 'photo'; b.title = 'Your background (click to turn on or off)';
    b.addEventListener('click', () => setLook({ bgOn: !st.settings.bgOn }));
    $('themes').append(b);
  }
  const add = document.createElement('button');
  add.className = 'swatch add'; add.textContent = '+'; add.title = 'Use your own background photo';
  add.addEventListener('click', async () => {
    const s = await native.pickBackground();
    if (!s) return;
    st.settings = { ...st.settings, ...s };
    applyLook();
  });
  $('themes').append(add);
}

function setLook(partial) {
  st.settings = { ...st.settings, ...partial };
  applyLook();
  native.setSettings(st.settings);
}

function buildPanel() {
  for (const t of THEMES) {
    const b = document.createElement('button');
    b.className = 'swatch'; b.dataset.id = t.id; b.title = t.name; b.setAttribute('aria-label', `${t.name} theme`);
    b.style.setProperty('--sw-bg', t.swatch[0]);
    b.style.setProperty('--sw-fg', t.swatch[1]);
    b.addEventListener('click', () => setLook({ theme: t.id }));
    $('themes').append(b);
  }
  for (const f of FONTS) {
    const b = document.createElement('button');
    b.dataset.id = f.id; b.textContent = f.name; b.style.fontFamily = f.stack;
    b.addEventListener('click', () => {
      setLook({ fonts: { ...st.settings.fonts, [st.settings.theme]: f.id } });
      hidePops(true);
    });
    $('fonts').append(b);
  }
  renderWallSwatches();
  $('doodle').addEventListener('click', () => {
    const x = +panel.dataset.x, y = +panel.dataset.y;
    hidePops(false);
    if (!plainOnly()) doodleAt(x, y);
  });
  $('recent-btn').addEventListener('click', toggleRecent);
  // Text size for the whole note: live while dragging, remembered when let go.
  $('size').addEventListener('input', (e) => { st.settings.size = +e.target.value; applyLook(); fitBoard(); });
  $('size').addEventListener('change', () => native.setSettings(st.settings));
}

// ---------- formatting: Ctrl+1 size, Ctrl+2 colour, Ctrl+3 box ----------

function cycleInline(kind) {
  if (plainOnly()) return;
  const ed = activeEditor();
  const sel = getSelection();
  if (!ed || !sel.rangeCount) return;
  const list = kind === 'size' ? SIZES : COLORS;
  const command = kind === 'size' ? 'fontName' : 'foreColor';
  let range = sel.getRangeAt(0);
  let caret = null;

  if (range.collapsed) {
    const block = blockOf(range.startContainer, ed) || ed.firstElementChild;
    if (!block) return;
    if (!block.textContent.trim()) {
      // Empty paragraph: set the style for what gets typed next.
      const prev = emptyStyle && emptyStyle.block === block ? emptyStyle[kind] || list[0] : list[0];
      const next = list[(list.indexOf(prev) + 1) % list.length];
      exec(command, next);
      emptyStyle = { ...(emptyStyle && emptyStyle.block === block ? emptyStyle : {}), block, [kind]: next };
      return;
    }
    // No selection: restyle the whole paragraph, then put the caret back.
    caret = getCaret();
    range = document.createRange();
    range.selectNodeContents(block);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  const selector = kind === 'size' ? 'font[face^="opsz-"]' : 'font[color]';
  const attr = kind === 'size' ? 'face' : 'color';
  const current = attrAbove(firstTextIn(range, ed), ed, selector, attr) || list[0];
  const next = list[(Math.max(0, list.indexOf(current)) + 1) % list.length];
  exec(command, next);
  if (caret) {
    normalize(ed);
    setCaret(caret);
  } else {
    // Keep the same text selected so the shortcut can be pressed again.
    const r = getSelection().rangeCount && getSelection().getRangeAt(0);
    normalize(ed);
    if (r && r.startContainer.isConnected) { getSelection().removeAllRanges(); getSelection().addRange(r); }
  }
  changed('format');
}

function cycleBox() {
  if (plainOnly()) return;
  const ed = activeEditor();
  const sel = getSelection();
  if (!ed || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  const blocks = range.collapsed ? [blockOf(range.startContainer, ed)].filter(Boolean) : blocksInRange(range, ed);
  if (!blocks.length) return;
  const current = BOXES.find((b) => b && blocks[0].classList.contains(b)) || '';
  const next = BOXES[(BOXES.indexOf(current) + 1) % BOXES.length];
  for (const b of blocks) {
    b.classList.remove(...BOXES.filter(Boolean));
    if (next) b.classList.add(next);
    if (!b.classList.length) b.removeAttribute('class');
  }
  changed('format');
}

// ---------- notes (free text boxes) ----------

const NOTE_MIN_W = 140, NOTE_MAX_W = 1200;

// Boxes sit at an offset from the page's centre line, clamped so they never hang off either edge:
// the left edge keeps 8px, and the right edge always leaves room for the box (a text box also wraps
// narrower when space runs out). Nothing overflows sideways, so the page stays centred at any zoom.
function placeNote(note) {
  const doodle = note.classList.contains('doodle');
  const need = doodle ? (+note.dataset.w || 360) + 16 : NOTE_MIN_W;
  note.style.setProperty('--l', `clamp(8px, calc(50% + ${note.dataset.x}px), calc(100% - ${need + 8}px))`);
  note.style.left = 'var(--l)';
  note.style.top = `${note.dataset.y}px`;
  if (!doodle) {
    const w = +note.dataset.w;
    note.style.width = w ? `${w}px` : '';
    note.style.setProperty('--mw', w ? `${w}px` : '360px');
  }
}

// ---------- doodles: a little sketch box, one ink pen in the theme's colour ----------
// A stroke is stored as "x y r x y r ..." (centre points + pen radius) and drawn as a smooth filled
// outline, so the line swells when you draw slowly and thins out when you flick.

const SVG_NS = 'http://www.w3.org/2000/svg';
const PEN = { thin: 0.7, thick: 2.7, start: 2.4 };
const ERASER = 11; // radius, comfortably wider than the pen
const r1 = (v) => Math.round(v * 10) / 10;
const validPath = (d) => typeof d === 'string' && d.length < 400000 &&
  (/^M[\d.]+ [\d.]+( L[\d.]+ [\d.]+)*$/.test(d) || /^[\d.]+ [\d.]+ [\d.]+( [\d.]+ [\d.]+ [\d.]+)*$/.test(d));
const doodlePaths = (n) => [...n.querySelectorAll('path')].map((p) => p.dataset.pts);

function parseStroke(d) {
  if (d[0] === 'M') { // 1.2.0 strokes: plain polyline, even width
    return d.slice(1).split(' L').map((s) => { const [x, y] = s.split(' ').map(Number); return [x, y, 1.2]; });
  }
  const n = d.split(' ').map(Number);
  const pts = [];
  for (let i = 0; i + 2 < n.length; i += 3) pts.push([n[i], n[i + 1], n[i + 2]]);
  return pts;
}
const encodeStroke = (pts) => pts.map((p) => `${r1(p[0])} ${r1(p[1])} ${r1(p[2])}`).join(' ');

// Quadratic curves through the midpoints: turns a jittery polyline into a smooth edge.
function smoothEdge(P) {
  const f = (p) => `${r1(p[0])} ${r1(p[1])}`;
  if (P.length < 3) return P.slice(1).map((p) => ` L${f(p)}`).join('');
  let s = '';
  for (let i = 1; i < P.length - 1; i++) s += ` Q${f(P[i])} ${f([(P[i][0] + P[i + 1][0]) / 2, (P[i][1] + P[i + 1][1]) / 2])}`;
  return `${s} L${f(P[P.length - 1])}`;
}

function strokeOutline(pts) {
  if (pts.length === 1) {
    const [x, y, r] = pts[0];
    return `M${r1(x - r)} ${r1(y)}a${r} ${r} 0 1 0 ${r1(2 * r)} 0a${r} ${r} 0 1 0 ${r1(-2 * r)} 0Z`;
  }
  const L = [], R = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len, [x, y, r] = pts[i];
    L.push([x + nx * r, y + ny * r]);
    R.push([x - nx * r, y - ny * r]);
  }
  const f = (p) => `${r1(p[0])} ${r1(p[1])}`;
  const rEnd = r1(pts[pts.length - 1][2]), rStart = r1(pts[0][2]);
  const back = R.slice().reverse();
  return `M${f(L[0])}${smoothEdge(L)} A${rEnd} ${rEnd} 0 0 0 ${f(back[0])}${smoothEdge(back)} A${rStart} ${rStart} 0 0 0 ${f(L[0])}Z`;
}

function addStroke(svg, pts) {
  const path = document.createElementNS(SVG_NS, 'path');
  path.dataset.pts = encodeStroke(pts);
  path.setAttribute('d', strokeOutline(pts));
  svg.append(path);
  return path;
}

function sizeDoodle(note, w, h) {
  note.dataset.w = w;
  note.dataset.h = h;
  const svg = note.querySelector('svg');
  svg.setAttribute('width', w);
  svg.setAttribute('height', h);
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
}

function createDoodle(x, y, paths = [], w = 360, h = 220) {
  const note = document.createElement('div');
  note.className = 'note doodle';
  note.tabIndex = 0;
  note.dataset.x = Math.round(x);
  note.dataset.y = Math.round(Math.max(0, y));
  note.innerHTML = '<div class="grip"></div><svg class="ink"></svg><div class="dsize"></div>';
  sizeDoodle(note, w, h);
  const svg = note.querySelector('svg');
  for (const d of paths) addStroke(svg, parseStroke(d));
  note.classList.toggle('empty', !paths.length);
  svg.addEventListener('pointerdown', (e) => (e.button === 2 ? startErase(e, note, svg) : startStroke(e, note, svg)));
  note.querySelector('.dsize').addEventListener('mousedown', (e) => resizeDoodle(e, note));
  placeNote(note);
  board.append(note);
  return note;
}

function doodleAt(clientX, clientY) {
  const r = board.getBoundingClientRect();
  const note = createDoodle(clampX((clientX - r.left - r.width / 2) / zoom - 20, 360), (clientY - r.top) / zoom - 20);
  note.focus({ preventScroll: true });
  fitBoard();
  return note;
}

// Pointer position in the doodle's own units (works at any zoom).
function inkPoint(ev, note, svg) {
  const r = svg.getBoundingClientRect();
  const k = +note.dataset.w / r.width;
  return [(ev.clientX - r.left) * k, (ev.clientY - r.top) * k];
}

function beginGesture(e, note, svg, onMove, onEnd) {
  e.preventDefault(); // no text selection, no stray mouse events
  hidePops(false);
  note.focus({ preventScroll: true });
  try { svg.setPointerCapture(e.pointerId); } catch {}
  const move = (ev) => {
    for (const ce of (ev.getCoalescedEvents && ev.getCoalescedEvents().length ? ev.getCoalescedEvents() : [ev])) onMove(ce);
  };
  const up = () => {
    svg.removeEventListener('pointermove', move);
    svg.removeEventListener('pointerup', up);
    svg.removeEventListener('pointercancel', up);
    onEnd();
  };
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerup', up);
  svg.addEventListener('pointercancel', up);
}

function startStroke(e, note, svg) {
  if (e.button !== 0) return;
  let [lx, ly] = inkPoint(e, note, svg);
  let lt = e.timeStamp, speed = 0, radius = PEN.start;
  const pts = [[lx, ly, radius]];
  let path = null;
  beginGesture(e, note, svg, (ev) => {
    const [px, py] = inkPoint(ev, note, svg);
    const x = lx + (px - lx) * 0.6, y = ly + (py - ly) * 0.6; // steady the hand a little
    const dist = Math.hypot(x - lx, y - ly);
    if (dist < 1.2) return;
    speed = speed * 0.65 + (dist / Math.max(1, ev.timeStamp - lt)) * 0.35;
    const press = ev.pointerType === 'pen' && ev.pressure > 0 ? ev.pressure : Math.max(0, Math.min(1, 1 - speed / 1.8));
    radius = radius * 0.7 + (PEN.thin + (PEN.thick - PEN.thin) * press) * 0.3;
    pts.push([x, y, radius]);
    lx = x; ly = y; lt = ev.timeStamp;
    if (!path) path = addStroke(svg, pts);
    else path.setAttribute('d', strokeOutline(pts));
  }, () => {
    if (!path) return; // a plain click only selects the doodle
    // Ink tail: the last few points taper off.
    const n = pts.length;
    [0.45, 0.65, 0.85].forEach((k, i) => { const p = pts[n - 1 - i]; if (p && n > 4) p[2] *= k; });
    path.dataset.pts = encodeStroke(pts);
    path.setAttribute('d', strokeOutline(pts));
    note.classList.remove('empty');
    changed('doodle');
  });
}

const segDist = (a, b, cx, cy) => {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((cx - a[0]) * dx + (cy - a[1]) * dy) / l2)) : 0;
  return Math.hypot(a[0] + t * dx - cx, a[1] + t * dy - cy);
};

// Rub out the part of a stroke under the eraser; whatever is left on either side stays.
function cutStroke(pts, cx, cy) {
  const reach = ERASER + 2.5;
  let hit = pts.length === 1 && Math.hypot(pts[0][0] - cx, pts[0][1] - cy) < reach;
  for (let i = 1; i < pts.length && !hit; i++) hit = segDist(pts[i - 1], pts[i], cx, cy) < reach;
  if (!hit) return null;
  const dense = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len > 2 && segDist(a, b, cx, cy) < reach + 2) {
      const k = Math.ceil(len / 1.5);
      for (let j = 1; j < k; j++) dense.push([a[0] + (b[0] - a[0]) * j / k, a[1] + (b[1] - a[1]) * j / k, a[2] + (b[2] - a[2]) * j / k]);
    }
    dense.push(b);
  }
  const runs = [];
  let cur = [];
  for (const p of dense) {
    if (Math.hypot(p[0] - cx, p[1] - cy) < ERASER + p[2] * 0.5) { if (cur.length) runs.push(cur); cur = []; }
    else cur.push(p);
  }
  if (cur.length) runs.push(cur);
  return runs.filter((r) => r.length >= 2);
}

function startErase(e, note, svg) {
  const ring = document.createElement('div');
  ring.className = 'eraser';
  note.append(ring);
  note.classList.add('erasing');
  let erased = false, last = null;
  const rubAt = (x, y) => {
    for (const path of [...svg.querySelectorAll('path')]) {
      const runs = cutStroke(parseStroke(path.dataset.pts), x, y);
      if (!runs) continue;
      erased = true;
      for (const run of runs) svg.insertBefore(addStroke(svg, run), path);
      path.remove();
    }
  };
  const rub = (ev) => {
    const [x, y] = inkPoint(ev, note, svg);
    ring.style.left = `${x - ERASER}px`;
    ring.style.top = `${y - ERASER}px`;
    // Sweep along the whole movement so a quick swipe can't skip over a line.
    const steps = last ? Math.max(1, Math.ceil(Math.hypot(x - last[0], y - last[1]) / (ERASER * 0.6))) : 1;
    for (let i = 1; i <= steps; i++) rubAt(last ? last[0] + (x - last[0]) * i / steps : x, last ? last[1] + (y - last[1]) * i / steps : y);
    last = [x, y];
  };
  ring.style.width = ring.style.height = `${ERASER * 2}px`;
  rub(e);
  beginGesture(e, note, svg, rub, () => {
    ring.remove();
    note.classList.remove('erasing');
    if (!erased) return;
    note.classList.toggle('empty', !svg.querySelector('path'));
    changed('doodle');
  });
}

function resizeDoodle(e, note) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  note.focus({ preventScroll: true });
  const w0 = +note.dataset.w, h0 = +note.dataset.h, sx = e.clientX, sy = e.clientY;
  document.body.classList.add('resizing');
  const move = (ev) => {
    sizeDoodle(note,
      Math.round(Math.min(1600, Math.max(140, w0 + (ev.clientX - sx) / zoom))),
      Math.round(Math.min(1600, Math.max(90, h0 + (ev.clientY - sy) / zoom))));
  };
  const up = () => {
    document.body.classList.remove('resizing');
    removeEventListener('mousemove', move);
    removeEventListener('mouseup', up);
    fitBoard();
    changed('doodle');
  };
  addEventListener('mousemove', move);
  addEventListener('mouseup', up);
}

function resizeNote(e, note) {
  note.focus({ preventScroll: true });
  const w0 = note.getBoundingClientRect().width / zoom, sx = e.clientX;
  document.body.classList.add('resizing-w');
  const move = (ev) => {
    note.dataset.w = Math.round(Math.min(NOTE_MAX_W, Math.max(NOTE_MIN_W, w0 + (ev.clientX - sx) / zoom)));
    placeNote(note);
  };
  const up = () => {
    document.body.classList.remove('resizing-w');
    removeEventListener('mousemove', move);
    removeEventListener('mouseup', up);
    fitBoard();
    changed('resize');
  };
  addEventListener('mousemove', move);
  addEventListener('mouseup', up);
}

// Double-click the width handle: back to fitting the text.
board.addEventListener('dblclick', (e) => {
  const note = e.target.classList && e.target.classList.contains('nsize') && e.target.closest('.note');
  if (!note) return;
  delete note.dataset.w;
  placeNote(note);
  fitBoard();
  changed('resize');
});

function createNote(x, y, html, w = 0) {
  const note = document.createElement('div');
  note.className = 'note';
  note.tabIndex = 0;
  note.dataset.x = Math.round(x);
  note.dataset.y = Math.round(Math.max(0, y));
  if (w) note.dataset.w = w;
  note.innerHTML = '<div class="grip"></div><div class="ed" contenteditable="true" spellcheck="false"></div><div class="nsize" title="Drag to change the width. Double-click to fit the text again."></div>';
  note.querySelector('.ed').innerHTML = html || '<p><br></p>';
  placeNote(note);
  board.append(note);
  return note;
}

// Keep boxes inside the normal (100%) canvas, even when they're placed or dragged while zoomed out.
function clampX(x, width = NOTE_MIN_W) {
  const half = scroller.clientWidth / 2;
  return Math.max(-half + 8, Math.min(half - width - 8, x));
}

function noteAt(clientX, clientY) {
  const r = board.getBoundingClientRect();
  const note = createNote(clampX((clientX - r.left - r.width / 2) / zoom - 14), (clientY - r.top) / zoom - 24);
  focusEnd(note.querySelector('.ed'));
  fitBoard();
  return note;
}

function fitBoard() {
  let bottom = 0;
  for (const n of board.querySelectorAll('.note')) bottom = Math.max(bottom, n.offsetTop + n.offsetHeight + 240);
  board.style.minHeight = bottom ? `${bottom}px` : '';
}

// ---------- document load / save ----------

function serialize() {
  const notes = [...board.querySelectorAll('.note')].map((n) => noteData(n, 'store')).filter(Boolean);
  return { v: 1, html: sanitize(column.innerHTML, 'store'), notes };
}

function loadDoc(doc) {
  column.innerHTML = (doc && sanitize(doc.html || '', 'live')) || '<p><br></p>';
  clearNotes();
  for (const n of (doc && doc.notes) || []) restoreNote(n, 'live');
  editors().forEach(normalize);
  st.ready = true;
  updatePlaceholder();
  fitBoard();
  focusEnd(column);
  scroller.scrollTop = 0;
  resetHistory();
}

const docIsEmpty = () => editors().every(isBlank) && !board.querySelector('.doodle path');

function firstLine() {
  const text = column.innerText.trim() || (board.querySelector('.note .ed') || {}).innerText || '';
  return text.split('\n').find((l) => l.trim()) || '';
}

function updatePlaceholder() {
  column.classList.toggle('empty', isBlank(column) && column.children.length <= 1 && !column.querySelector('[class]'));
}

function applyInfo(r) {
  if (!r || !r.name) return;
  $('name').textContent = r.name;
  document.title = r.name;
  st.locked = !!r.locked;
  st.hasPath = !!r.path && !r.isDraft;
  st.plain = !!r.plain;
  root.classList.toggle('locked', st.locked);
  root.classList.toggle('plain', st.plain);
}

// .txt files stay plain text, so the formatting tools politely point to .opad instead of losing your work.
function plainOnly() {
  if (!st.plain) return false;
  toast('Plain text file. Save it as .opad (Ctrl+Shift+S) to use this.', 3200);
  return true;
}

function loadText(text) {
  column.innerHTML = text.split('\n').map((line) => `<p>${esc(line) || '<br>'}</p>`).join('');
  board.querySelectorAll('.note').forEach((n) => n.remove());
  st.ready = true;
  updatePlaceholder();
  fitBoard();
  column.focus();
  placeCaret(column.firstElementChild, 0);
  scroller.scrollTop = 0;
  resetHistory();
}

// Back to plain text: one paragraph per line, exactly as typed (tabs and spaces included).
const plainText = () => [...column.children].map((b) => b.innerText.replace(/\n$/, '')).join('\n');

function afterChange() {
  dirty = true;
  updatePlaceholder();
  fitBoard();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => save('auto'), 700);
}

function changed(kind) {
  if (!st.ready) return;
  record(kind);
  afterChange();
}

async function save(mode) {
  if (!st.ready) return null;
  clearTimeout(saveTimer);
  while (saving) await saving;
  if (mode === 'auto' && !dirty) return null;
  dirty = false;
  const payload = { doc: serialize(), text: st.plain ? plainText() : undefined, firstLine: firstLine(), empty: docIsEmpty(), mode };
  saving = native.save(payload);
  let r;
  try { r = await saving; } finally { saving = null; }
  if (r.error) { dirty = true; toast(r.error, 4000); }
  else if (r.canceled) { dirty = true; saveTimer = setTimeout(() => save('auto'), 700); }
  else if (mode !== 'auto') toast(`Saved · ${r.name}`);
  applyInfo(r);
  return r;
}

// ---------- pop-overs: context menu & font/theme panel ----------

function showAt(el, x, y) {
  el.classList.remove('hidden');
  const w = el.offsetWidth, h = el.offsetHeight;
  el.style.left = `${Math.max(8, Math.min(x, innerWidth - w - 8))}px`;
  el.style.top = `${Math.max(46, Math.min(y, innerHeight - h - 8))}px`;
}

function hidePops(restore) {
  const wasOpen = !ctx.classList.contains('hidden') || !panel.classList.contains('hidden');
  ctx.classList.add('hidden');
  panel.classList.add('hidden');
  if (wasOpen && restore) restoreSelection(); else if (wasOpen) savedRange = null;
}

function openPanel(x, y) {
  hidePops(false);
  foldRecent();
  rememberSelection();
  if (x == null) {
    const r = savedRange && savedRange.getBoundingClientRect();
    if (r && (r.top || r.left)) { x = r.left; y = r.bottom + 10; }
    else { x = innerWidth / 2 - 130; y = innerHeight / 3; }
  }
  showAt(panel, x, y);
  panel.dataset.x = x;
  panel.dataset.y = y;
  const on = panel.querySelector('#fonts .on') || panel.querySelector('#fonts button');
  on.focus({ preventScroll: true });
}

// "Open recent": unfolds a short list inside the panel; picking one opens it in its own window.
function ago(ms) {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d} days ago`;
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function foldRecent() {
  $('recent').classList.add('hidden');
  $('recent-btn').setAttribute('aria-expanded', 'false');
}

async function toggleRecent() {
  const list = $('recent');
  if (!list.classList.contains('hidden')) { foldRecent(); return; }
  const items = await native.getRecent();
  list.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'rempty';
    empty.textContent = 'Nothing yet';
    list.append(empty);
  }
  for (const it of items) {
    const b = document.createElement('button');
    b.className = 'ritem';
    b.title = it.path;
    const name = document.createElement('span');
    name.className = 'rname';
    name.textContent = it.name;
    const when = document.createElement('span');
    when.className = 'rwhen';
    when.textContent = ago(it.time);
    b.append(name, when);
    b.addEventListener('click', () => { hidePops(false); native.openRecent(it.path); });
    list.append(b);
  }
  list.classList.remove('hidden');
  $('recent-btn').setAttribute('aria-expanded', 'true');
  showAt(panel, parseFloat(panel.style.left), parseFloat(panel.style.top)); // keep the taller panel on screen
  const first = list.querySelector('.ritem');
  if (first) first.focus({ preventScroll: true });
}

function openContext(e) {
  hidePops(false);
  rememberSelection();
  const sel = getSelection();
  ctx.querySelector('[data-act="copy"]').disabled = !sel.rangeCount || sel.isCollapsed;
  ctxPoint = e.target === board ? { x: e.clientX, y: e.clientY } : null;
  showAt(ctx, e.clientX, e.clientY);
}

ctx.addEventListener('mousedown', (e) => e.preventDefault()); // keep the text selection
ctx.addEventListener('click', (e) => {
  const act = e.target.dataset.act;
  if (!act || e.target.disabled) return;
  const point = ctxPoint;
  const at = [parseFloat(ctx.style.left), parseFloat(ctx.style.top)];
  hidePops(true);
  if (act === 'more') { openPanel(at[0], at[1]); return; }
  if (act === 'copy') document.execCommand('copy');
  if (act === 'paste') {
    if (point) noteAt(point.x, point.y);
    native.paste();
  }
});

panel.addEventListener('keydown', (e) => {
  const fonts = [...$('fonts').children];
  const i = fonts.indexOf(document.activeElement);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = i < 0 ? 0 : (i + (e.key === 'ArrowDown' ? 1 : fonts.length - 1)) % fonts.length;
    fonts[n].focus();
  }
});

// ---------- modal (lock / unlock) ----------

let modal = null;

function showModal(cfg) {
  hidePops(false);
  if (!cfg.keepSelection) rememberSelection();
  modal = cfg;
  $('m-title').textContent = cfg.title;
  $('m-fields').replaceChildren(...cfg.fields.map((ph) => {
    const i = document.createElement('input');
    i.type = 'password'; i.placeholder = ph;
    return i;
  }));
  $('m-hint').textContent = cfg.hint || '';
  $('m-err').textContent = '';
  $('m-ok').textContent = cfg.ok;
  $('m-cancel').textContent = cfg.cancelLabel || 'Cancel';
  veil.classList.remove('hidden');
  $('m-fields').firstChild.focus();
}

function closeModal() {
  veil.classList.add('hidden');
  $('m-fields').replaceChildren();
  modal = null;
  restoreSelection();
}

$('modal').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!modal || modal.busy) return;
  const inputs = [...$('m-fields').children];
  modal.busy = true;
  $('m-ok').disabled = true;
  const err = await modal.submit(inputs.map((i) => i.value));
  $('m-ok').disabled = false;
  if (!modal) return;
  modal.busy = false;
  if (err) {
    $('m-err').textContent = err;
    inputs.forEach((i) => { i.value = ''; });
    inputs[0].focus();
  } else closeModal();
});

$('m-cancel').addEventListener('click', () => (modal && modal.cancel ? modal.cancel() : closeModal()));

function lockFlow() {
  if (!st.ready || plainOnly()) return;
  if (st.locked) {
    showModal({
      title: 'Remove the lock?', fields: ['Current password'], ok: 'Remove lock',
      submit: async ([pw]) => {
        const r = await native.removeLock(pw);
        if (r.error) return r.error;
        applyInfo(r); dirty = true; await save('auto');
        toast('Lock removed');
        return null;
      },
    });
  } else {
    showModal({
      title: 'Lock this note', fields: ['Password', 'Repeat password'], ok: 'Lock',
      hint: "You'll be asked for it every time this note opens. A forgotten password can't be recovered.",
      submit: async ([a, b]) => {
        if (!a) return 'Choose a password.';
        if (a !== b) return "Those don't match.";
        applyInfo(await native.setLock(a)); dirty = true; await save('auto');
        toast('Locked');
        return null;
      },
    });
  }
}

function unlockFlow(name) {
  root.classList.add('unlocking');
  showModal({
    title: `“${name}” is locked`, fields: ['Password'], ok: 'Open', cancelLabel: 'Close', keepSelection: true,
    cancel: () => native.close(),
    submit: async ([pw]) => {
      const r = await native.unlock(pw);
      if (r.error) return r.error;
      root.classList.remove('unlocking');
      applyInfo(r);
      loadDoc(r.doc);
      return null;
    },
  });
}

// ---------- paste & drop ----------

const readDataUrl = (blob) => new Promise((res, rej) => {
  const fr = new FileReader();
  fr.onload = () => res(fr.result);
  fr.onerror = rej;
  fr.readAsDataURL(blob);
});

async function imageUrl(file) {
  const bmp = await createImageBitmap(file);
  const MAX = 1800;
  let blob = file;
  if (bmp.width > MAX || file.size > 1.5e6 || !/png|jpe?g|gif|webp/.test(file.type)) {
    // Big screenshots/photos get scaled down so notes stay light.
    const k = Math.min(1, MAX / bmp.width);
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    blob = await new Promise((res) => c.toBlob(res, 'image/webp', 0.9));
  }
  return registerBlob(blob, await readDataUrl(blob));
}

async function insertFrom(dt, ed) {
  const images = [...dt.items].filter((i) => i.kind === 'file' && i.type.startsWith('image/')).map((i) => i.getAsFile());
  const html = dt.getData('text/html');
  const text = dt.getData('text/plain');
  if (images.length && st.plain) {
    plainOnly();
    return;
  } else if (images.length) {
    for (const f of images) exec('insertImage', await imageUrl(f));
  } else if (html && html.includes(CLIP_MARK) && !st.plain) {
    exec('insertHTML', sanitize(html, 'live'));
  } else if (text) {
    exec('insertText', text.replace(/\r\n?/g, '\n'));
    const c = getCaret();
    linkify(ed);
    setCaret(c);
  } else return;
  normalizeKeepingCaret(ed);
  changed('paste');
}

board.addEventListener('paste', (e) => {
  const ed = editorOf(e.target);
  if (!ed) return;
  e.preventDefault();
  insertFrom(e.clipboardData, ed);
});

function copyOut(e, cut) {
  const sel = getSelection();
  if (!sel.rangeCount || sel.isCollapsed || !editorOf(sel.anchorNode)) return;
  const range = sel.getRangeAt(0);
  const ed = editorOf(sel.anchorNode);
  let frag = range.cloneContents();
  // Text picked from inside a coloured/sized run keeps that look when pasted.
  for (let n = range.commonAncestorContainer; n && n !== ed; n = n.parentNode) {
    if (/^(FONT|B|STRONG|I|EM|U|A)$/.test(n.nodeName)) {
      const wrap = n.cloneNode(false);
      wrap.append(frag);
      frag = wrap;
    }
  }
  const div = document.createElement('div');
  div.append(frag);
  e.preventDefault();
  e.clipboardData.setData('text/html', CLIP_MARK + sanitize(div.innerHTML, 'store'));
  e.clipboardData.setData('text/plain', sel.toString());
  if (cut) {
    exec('delete');
    normalizeKeepingCaret(ed);
    changed('cut');
  }
}
board.addEventListener('copy', (e) => copyOut(e, false));
board.addEventListener('cut', (e) => copyOut(e, true));

board.addEventListener('dragstart', () => { dragInside = true; });
board.addEventListener('dragend', () => { dragInside = false; });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  if (dragInside) return; // moving text around inside the note: let the browser do it
  e.preventDefault();
  let ed = editorOf(e.target);
  if (!ed) {
    if (e.target !== board) return;
    ed = noteAt(e.clientX, e.clientY).querySelector('.ed');
  } else {
    const r = document.caretRangeFromPoint(e.clientX, e.clientY);
    ed.focus();
    if (r) { getSelection().removeAllRanges(); getSelection().addRange(r); }
  }
  insertFrom(e.dataTransfer, ed);
});

// ---------- editing events ----------

board.addEventListener('beforeinput', (e) => {
  if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') {
    e.preventDefault();
    travel(e.inputType === 'historyUndo' ? -1 : 1);
  }
});

board.addEventListener('input', (e) => {
  if (commandDepth) return; // our own commands record themselves
  const ed = editorOf(e.target);
  if (!ed) return;
  if (e.inputType === 'insertParagraph') {
    // A new line starts in plain text (a big heading doesn't spill into the next line); boxes carry on.
    const sel = getSelection();
    const block = sel.rangeCount && blockOf(sel.getRangeAt(0).startContainer, ed);
    if (block && isBlank(block) && block.querySelector('font')) {
      block.innerHTML = '<br>';
      placeCaret(block, 0);
    }
  }
  if (e.inputType !== 'insertCompositionText') normalizeKeepingCaret(ed);
  if (e.inputType === 'insertText' && e.data === '-' && !st.plain) dashesToDivider(ed);
  if (e.inputType === 'insertText' && e.data === ' ' && !st.plain) dashToBullet(ed);
  changed(e.inputType === 'insertText' ? 'insert' : e.inputType.startsWith('delete') ? 'delete' : 'edit');
  requestAnimationFrame(keepCaretClear);
});

// "- " typed at the very start of a line turns it into a bullet point.
function dashToBullet(ed) {
  const sel = getSelection();
  const r = sel.rangeCount && sel.getRangeAt(0);
  const block = r && r.collapsed && blockOf(r.startContainer, ed);
  if (!block || block.nodeName === 'HR' || block.classList.contains('bl')) return;
  // (a space typed at the end of a line arrives as a non-breaking space)
  if (textOffset(block, r.startContainer, r.startOffset) !== 2 || !/^-[  ]/.test(block.textContent)) return;
  const first = document.createTreeWalker(block, NodeFilter.SHOW_TEXT).nextNode();
  if (!first || !/^-[  ]/.test(first.data)) return;
  first.deleteData(0, 2);
  block.classList.add('bl');
  if (!block.textContent && !block.querySelector('br')) block.append(document.createElement('br'));
  placeCaret(block, 0);
}

// Hold "-" and a line of dashes turns into a divider; the held key then stops typing.
const DIVIDER_DASHES = 10;
let dashHeld = false;

function dashesToDivider(ed) {
  const sel = getSelection();
  const block = sel.rangeCount && blockOf(sel.getRangeAt(0).startContainer, ed);
  if (!block || block.querySelector('img') || !new RegExp(`^-{${DIVIDER_DASHES},}$`).test(block.textContent)) return;
  const hr = document.createElement('hr');
  const next = document.createElement('p');
  next.innerHTML = '<br>';
  block.replaceWith(hr, next);
  placeCaret(next, 0);
  dashHeld = true;
}

window.addEventListener('keyup', (e) => { if (e.key === '-') dashHeld = false; });

// Typing near the bottom keeps a calm margin under the caret instead of hugging the window edge.
function keepCaretClear() {
  const sel = getSelection();
  if (!sel.rangeCount || !editorOf(sel.anchorNode)) return;
  const r = sel.getRangeAt(0);
  let rect = r.getClientRects()[0];
  if (!rect) {
    const el = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement;
    rect = el.getBoundingClientRect();
  }
  const view = scroller.getBoundingClientRect();
  const room = Math.min(180, view.height * 0.28);
  const over = rect.bottom - (view.bottom - room);
  if (over > 0) scroller.scrollTop += over;
}

board.addEventListener('keyup', (e) => {
  if (/^(ArrowDown|PageDown|End|Enter)$/.test(e.key) && editorOf(e.target)) keepCaretClear();
});

board.addEventListener('keydown', (e) => {
  if (st.plain && editorOf(e.target)) {
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) { e.preventDefault(); document.execCommand('insertText', false, '\t'); return; }
    if ((e.ctrlKey || e.metaKey) && /^Key[BIU]$/.test(e.code)) { e.preventDefault(); return; }
  }
  const ed = editorOf(e.target);
  if (!ed || e.key !== 'Enter' || e.shiftKey) return;
  const sel = getSelection();
  const block = sel.rangeCount && blockOf(sel.getRangeAt(0).startContainer, ed);
  // Enter on an empty bullet ends the list.
  if (block && block.classList.contains('bl') && isBlank(block)) {
    e.preventDefault();
    block.classList.remove('bl');
    if (!block.classList.length) block.removeAttribute('class');
    changed('format');
    return;
  }
  // Enter on an empty line inside a box steps out of the box.
  if (block && block.className && /bx\d/.test(block.className) && isBlank(block)) {
    e.preventDefault();
    block.classList.remove(...BOXES.filter(Boolean));
    if (!block.classList.length) block.removeAttribute('class');
    changed('format');
  }
});

// ---------- Tab indents, Shift+Tab (or Backspace at a line's start) outdents ----------

function indentLevel(block) {
  const c = INDENTS.find((x) => block.classList.contains(x));
  return c ? INDENTS.indexOf(c) + 1 : 0;
}

function setIndent(block, level) {
  block.classList.remove(...INDENTS);
  if (level > 0) block.classList.add(INDENTS[Math.min(level, INDENTS.length) - 1]);
  if (!block.classList.length) block.removeAttribute('class');
}

function shiftIndent(ed, step) {
  const sel = getSelection();
  if (!sel.rangeCount) return false;
  const range = sel.getRangeAt(0);
  const blocks = (range.collapsed ? [blockOf(range.startContainer, ed)] : blocksInRange(range, ed))
    .filter((b) => b && b.nodeName !== 'HR');
  if (!blocks.length) return false;
  let moved = false;
  for (const b of blocks) {
    const now = indentLevel(b), next = Math.max(0, Math.min(INDENTS.length, now + step));
    if (next !== now) { setIndent(b, next); moved = true; }
  }
  if (moved) changed('format');
  return true;
}

board.addEventListener('keydown', (e) => {
  const ed = editorOf(e.target);
  if (!ed || st.plain || e.ctrlKey || e.altKey || e.metaKey) return;
  if (e.key === 'Tab') {
    e.preventDefault(); // stay in the note instead of jumping to the next box
    shiftIndent(ed, e.shiftKey ? -1 : 1);
    return;
  }
  if (e.key === 'Backspace' && !e.shiftKey) {
    const sel = getSelection();
    const r = sel.rangeCount && sel.getRangeAt(0);
    const block = r && r.collapsed && blockOf(r.startContainer, ed);
    if (block && block.classList.contains('bl') && textOffset(block, r.startContainer, r.startOffset) === 0) {
      e.preventDefault();
      block.classList.remove('bl');
      if (!block.classList.length) block.removeAttribute('class');
      changed('format');
      return;
    }
    if (block && indentLevel(block) && textOffset(block, r.startContainer, r.startOffset) === 0) {
      e.preventDefault();
      setIndent(block, indentLevel(block) - 1);
      changed('format');
    }
  }
});

// Ctrl+-: strikethrough (the selection, or the whole line when nothing is selected).
function strike() {
  if (plainOnly()) return;
  const ed = activeEditor();
  const sel = getSelection();
  if (!ed || !sel.rangeCount) return;
  let caret = null;
  if (sel.isCollapsed) {
    const block = blockOf(sel.getRangeAt(0).startContainer, ed);
    if (!block || !block.textContent.trim()) { exec('strikeThrough'); return; }
    caret = getCaret();
    const r = document.createRange();
    r.selectNodeContents(block);
    sel.removeAllRanges();
    sel.addRange(r);
  }
  exec('strikeThrough');
  normalizeKeepingCaret(ed);
  if (caret) setCaret(caret);
  changed('format');
}

board.addEventListener('focusout', (e) => {
  const note = e.target.closest && e.target.closest('.note');
  if (rebuilding || !note || !note.isConnected) return;
  if (!note.contains(e.relatedTarget) && !noteData(note)) {
    note.remove();
    fitBoard();
  }
});

board.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  const frame = e.target.closest('.note');
  if (frame && e.target === frame && !frame.classList.contains('doodle')) {
    e.preventDefault();
    focusEnd(frame.querySelector('.ed'));
    return;
  }
  if (frame && e.target === frame) { // a doodle's margin selects it (then Del removes it)
    e.preventDefault();
    frame.focus({ preventScroll: true });
    return;
  }
  if (frame && e.target.classList.contains('nsize')) {
    e.preventDefault();
    resizeNote(e, frame);
    return;
  }
  if (frame && e.target.classList.contains('grip')) {
    e.preventDefault();
    const note = frame;
    note.focus({ preventScroll: true }); // selected: Delete removes the whole box
    const sx = e.clientX, sy = e.clientY, ox = +note.dataset.x, oy = +note.dataset.y;
    const noteWidth = note.getBoundingClientRect().width / zoom;
    let moved = false;
    document.body.classList.add('dragging');
    const move = (ev) => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 3) return;
      moved = true;
      note.dataset.x = Math.round(clampX(ox + (ev.clientX - sx) / zoom, note.classList.contains('doodle') ? +note.dataset.w + 16 : noteWidth));
      note.dataset.y = Math.round(Math.max(0, oy + (ev.clientY - sy) / zoom));
      placeNote(note);
    };
    const up = () => {
      document.body.classList.remove('dragging');
      removeEventListener('mousemove', move);
      removeEventListener('mouseup', up);
      if (moved) changed('move');
    };
    addEventListener('mousemove', move);
    addEventListener('mouseup', up);
    return;
  }
  if (e.target === board) {
    // Click on empty space: start a new floating text box there (plain text files have just the one column).
    e.preventDefault();
    if (st.plain) focusEnd(column); else noteAt(e.clientX, e.clientY);
  }
});

board.addEventListener('mousedown', (e) => {
  const hr = e.button === 0 && e.target.nodeName === 'HR' && editorOf(e.target);
  if (!hr) return;
  e.preventDefault();
  const ed = editorOf(e.target);
  let next = e.target.nextElementSibling;
  if (!next) { next = Object.assign(document.createElement('p'), { innerHTML: '<br>' }); e.target.after(next); }
  ed.focus({ preventScroll: true });
  placeCaret(next, 0);
});

board.addEventListener('mousedown', (e) => {
  const img = e.button === 0 && e.target.closest('.ed img');
  if (!img) return;
  e.preventDefault();
  editorOf(img).focus({ preventScroll: true });
  const r = document.createRange();
  r.selectNode(img);
  getSelection().removeAllRanges();
  getSelection().addRange(r);
});

board.addEventListener('click', (e) => {
  const a = e.target.closest('.ed a');
  if (a && (e.ctrlKey || e.metaKey)) { e.preventDefault(); native.openExternal(a.getAttribute('href')); }
});

// ---------- Ctrl+scroll zoom, anchored under the mouse ----------

function setZoom(z, clientX, clientY) {
  z = Math.min(1.6, Math.max(0.3, z));
  if ((zoom < 1 && z > 1) || (zoom > 1 && z < 1)) z = 1; // rest briefly at 100%
  if (Math.abs(z - 1) < 0.03) z = 1;
  if (z === zoom) return;
  const view = scroller.getBoundingClientRect();
  const mx = clientX == null ? view.left + view.width / 2 : clientX;
  const my = clientY == null ? view.top + view.height / 2 : clientY;
  // Anchor on what's actually under the mouse: the word there (or a spot in the column) stays put on screen.
  // (The column re-centres itself and boxes spread out at a different rate, so plain scaling math drifts sideways.)
  const col0 = column.getBoundingClientRect();
  const probe = (x) => { const r = document.caretRangeFromPoint(x, my); return r && editorOf(r.startContainer) ? r : null; };
  // the word under the mouse, or else the line of the column at the mouse's height
  const word = probe(mx) || probe(Math.min(Math.max(mx, col0.left + 60), col0.right - 60));
  const spot = () => (word && word.getClientRects()[0]) || null;
  const before = spot();
  const col = column.getBoundingClientRect();
  const fx = (mx - col.left) / col.width, fy = (my - col.top) / col.height;
  zoom = z;
  board.style.zoom = z === 1 ? '' : z;
  const after = spot();
  if (before && after) {
    scroller.scrollLeft += after.left - before.left;
    scroller.scrollTop += after.top - before.top;
  } else {
    const c = column.getBoundingClientRect();
    scroller.scrollLeft += c.left + fx * c.width - mx;
    scroller.scrollTop += c.top + fy * c.height - my;
  }
  // Never let the writing column slide off the side when it fits in the window.
  const c = column.getBoundingClientRect();
  if (c.width <= view.width) {
    if (c.left < view.left + 8) scroller.scrollLeft -= view.left + 8 - c.left;
    else if (c.right > view.right - 8) scroller.scrollLeft += c.right - (view.right - 8);
  }
  $('zoomlvl').textContent = z === 1 ? '' : `${Math.round(z * 100)}%`;
  hidePops(false);
  hideHandle();
}

window.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  if (modal || !st.ready) return;
  setZoom(zoom * Math.exp(-e.deltaY * 0.0016), e.clientX, e.clientY);
}, { passive: false });

// ---------- image resizing: drag the dot on an image's corner ----------

const handle = $('imghandle');
let hoverImg = null, resizing = false;

function placeHandle() {
  const r = hoverImg.getBoundingClientRect();
  handle.style.left = `${r.right - 10}px`;
  handle.style.top = `${r.bottom - 10}px`;
  handle.classList.remove('hidden');
}

function hideHandle() {
  if (resizing) return;
  handle.classList.add('hidden');
  hoverImg = null;
}

window.addEventListener('mousemove', (e) => {
  if (resizing || e.buttons) return;
  const img = e.target.closest && e.target.closest('.ed img');
  if (img) { hoverImg = img; placeHandle(); } else if (e.target !== handle) hideHandle();
});

handle.addEventListener('mousedown', (e) => {
  if (!hoverImg || e.button !== 0) return;
  e.preventDefault();
  const img = hoverImg;
  const ed = editorOf(img);
  const r = img.getBoundingClientRect();
  const w0 = r.width / zoom, ratio = r.width / r.height;
  const sx = e.clientX, sy = e.clientY;
  const max = img.closest('.note') ? 360 : ed.clientWidth;
  resizing = true;
  img.classList.add('sizing');
  document.body.classList.add('resizing');
  const move = (ev) => {
    const dx = (ev.clientX - sx) / zoom, dy = ((ev.clientY - sy) / zoom) * ratio;
    const w = Math.round(Math.min(max, Math.max(48, w0 + (Math.abs(dx) > Math.abs(dy) ? dx : dy))));
    img.setAttribute('width', w);
    placeHandle();
  };
  const up = () => {
    resizing = false;
    img.classList.remove('sizing');
    if (!img.getAttribute('class')) img.removeAttribute('class');
    document.body.classList.remove('resizing');
    removeEventListener('mousemove', move);
    removeEventListener('mouseup', up);
    fitBoard();
    changed('resize');
  };
  addEventListener('mousemove', move);
  addEventListener('mouseup', up);
});

// ---------- first-run tutorial ----------

function showTour() {
  const tour = $('tour');
  tour.classList.remove('hidden');
  const done = (e) => {
    e.preventDefault();
    tour.classList.add('hidden');
    removeEventListener('mousedown', done, true);
    removeEventListener('keydown', done, true);
    st.settings.seenTutorial = true;
    native.setSettings({ seenTutorial: true });
    if (st.ready) focusEnd(column);
  };
  addEventListener('mousedown', done, true);
  addEventListener('keydown', done, true);
}

// ---------- find (Ctrl+F) ----------
// Matches are painted with CSS highlights, so the note itself is never touched (no effect on undo or saving).

const finder = { open: false, matches: [], index: -1, timer: 0 };

// Lower-case and drop accents, one character for one character, so offsets still line up with the text.
function fold(s) {
  let out = '';
  for (const ch of s) {
    const f = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    out += f.length === ch.length ? f : ch;
  }
  return out;
}

function findMatches(query) {
  const q = fold(query);
  const found = [];
  if (!q) return found;
  for (const ed of editors()) {
    const nodes = [];
    let text = '', lastBlock = null;
    const walker = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const block = blockOf(n, ed);
      if (lastBlock && block !== lastBlock) text += '\u0000'; // never match across lines
      lastBlock = block;
      nodes.push([n, text.length]);
      text += fold(n.data);
    }
    const at = (pos, end) => {
      for (const [node, start] of nodes) {
        if (pos >= start && (end ? pos <= start + node.length : pos < start + node.length)) return [node, pos - start];
      }
      return null;
    };
    for (let i = text.indexOf(q); i !== -1; i = text.indexOf(q, i + q.length)) {
      const a = at(i, false), b = at(i + q.length, true);
      if (!a || !b) continue;
      const r = document.createRange();
      r.setStart(a[0], a[1]);
      r.setEnd(b[0], b[1]);
      found.push(r);
    }
  }
  // in reading order down the page, whether a match sits in the column or a floating box
  const pos = new Map(found.map((r) => [r, r.getBoundingClientRect()]));
  return found.sort((a, b) => (pos.get(a).top - pos.get(b).top) || (pos.get(a).left - pos.get(b).left));
}

function paintFind() {
  CSS.highlights.set('find', new Highlight(...finder.matches));
  const cur = finder.matches[finder.index];
  if (cur) CSS.highlights.set('find-current', new Highlight(cur)); else CSS.highlights.delete('find-current');
  $('find-n').textContent = !$('find-q').value ? '' : finder.matches.length ? `${finder.index + 1}/${finder.matches.length}` : 'none';
}

function revealMatch() {
  const cur = finder.matches[finder.index];
  if (!cur) return;
  const r = cur.getBoundingClientRect(), view = scroller.getBoundingClientRect();
  if (r.top < view.top + 40 || r.bottom > view.bottom - 40) scroller.scrollTop += r.top - (view.top + view.height / 3);
}

function runFind(keepPlace) {
  const prev = finder.matches[finder.index];
  finder.matches = findMatches($('find-q').value);
  if (keepPlace && prev) {
    const i = finder.matches.findIndex((m) => m.compareBoundaryPoints(Range.START_TO_START, prev) >= 0);
    finder.index = i < 0 ? 0 : i;
  } else {
    // start at the first match on screen (or the first one after it)
    const top = scroller.getBoundingClientRect().top;
    const i = finder.matches.findIndex((m) => m.getBoundingClientRect().bottom >= top);
    finder.index = finder.matches.length ? Math.max(0, i) : -1;
  }
  paintFind();
  if (!keepPlace) revealMatch();
}

function stepFind(step) {
  if (!finder.matches.length) return;
  const n = finder.matches.length;
  finder.index = (((finder.index + step) % n) + n) % n;
  paintFind();
  revealMatch();
}

function openFind() {
  hidePops(false);
  const sel = getSelection();
  const picked = sel.rangeCount && !sel.isCollapsed && editorOf(sel.anchorNode) ? sel.toString().trim() : '';
  if (picked && picked.length < 80 && !picked.includes('\n')) $('find-q').value = picked;
  $('find').classList.remove('hidden');
  finder.open = true;
  $('find-q').focus();
  $('find-q').select();
  runFind(false);
}

function closeFind(selectMatch) {
  const cur = finder.matches[finder.index];
  finder.open = false;
  $('find').classList.add('hidden');
  CSS.highlights.delete('find');
  CSS.highlights.delete('find-current');
  if (selectMatch && cur && cur.startContainer.isConnected) {
    editorOf(cur.startContainer).focus({ preventScroll: true });
    getSelection().removeAllRanges();
    getSelection().addRange(cur);
  }
  finder.matches = [];
}

$('find-q').addEventListener('input', () => runFind(false));
$('find-q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); }
});
$('find-next').addEventListener('click', () => stepFind(1));
$('find-prev').addEventListener('click', () => stepFind(-1));
$('find-close').addEventListener('click', () => closeFind(true));
$('find').addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
// keep the matches fresh while you edit with the bar open
board.addEventListener('input', () => {
  if (!finder.open) return;
  clearTimeout(finder.timer);
  finder.timer = setTimeout(() => runFind(true), 150);
});

// ---------- pin on top (top-left corner) ----------

$('pin').addEventListener('click', () => {
  const on = !root.classList.contains('pinned');
  root.classList.toggle('pinned', on);
  $('pin').setAttribute('aria-pressed', on);
  $('pin').title = on ? 'Unpin' : 'Keep on top';
  native.setOnTop(on);
});

// ---------- word count on demand (hover the note's name) ----------

const SPOKEN_WPM = 150; // a typical voice-over pace

function wordCount(text) {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

function spoken(words) {
  const secs = Math.round((words / SPOKEN_WPM) * 60);
  if (secs < 60) return `~${secs} s spoken`;
  const m = Math.floor(secs / 60), s = secs % 60;
  return s ? `~${m} min ${s} s spoken` : `~${m} min spoken`;
}

$('title').addEventListener('mouseenter', () => {
  if (!st.ready) return;
  const sel = getSelection();
  const picked = sel.rangeCount && !sel.isCollapsed && editorOf(sel.anchorNode) ? sel.toString() : '';
  const words = wordCount(picked || column.innerText);
  const label = picked ? `${words} ${words === 1 ? 'word' : 'words'} selected` : `${words} ${words === 1 ? 'word' : 'words'}`;
  $('stats').textContent = `${label} · ${spoken(words)}`;
  $('stats').classList.remove('hidden');
});
$('title').addEventListener('mouseleave', () => $('stats').classList.add('hidden'));

// ---------- text cursor only over letters ----------

let hoverFrame = 0;
function overLetters(x, y) {
  const r = document.caretRangeFromPoint(x, y);
  if (!r || r.startContainer.nodeType !== 3 || !editorOf(r.startContainer)) return false;
  const t = r.startContainer, o = r.startOffset, probe = document.createRange();
  for (const [a, b] of [[o, o + 1], [o - 1, o]]) {
    if (a < 0 || b > t.length) continue;
    probe.setStart(t, a);
    probe.setEnd(t, b);
    for (const box of probe.getClientRects()) {
      if (x >= box.left - 3 && x <= box.right + 3 && y >= box.top && y <= box.bottom) return true;
    }
  }
  return false;
}
window.addEventListener('mousemove', (e) => {
  if (hoverFrame || e.buttons) return;
  hoverFrame = requestAnimationFrame(() => {
    hoverFrame = 0;
    root.classList.toggle('over-text', overLetters(e.clientX, e.clientY));
  });
});
// Dragging out a selection keeps the text cursor until the button comes up.
board.addEventListener('mousedown', (e) => {
  if (e.button === 0 && editorOf(e.target) && !e.target.closest('img, hr')) root.classList.add('selecting');
});
window.addEventListener('mouseup', () => root.classList.remove('selecting'));

// ---------- global input ----------

window.addEventListener('mousedown', (e) => {
  if (e.button === 1) e.preventDefault(); // no autoscroll on middle click
  if (!e.target.closest('.pop')) hidePops(false);
});
window.addEventListener('auxclick', (e) => {
  if (e.button !== 1 || modal) return;
  e.preventDefault();
  openPanel(e.clientX, e.clientY);
});
window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (!modal && !e.target.closest('.pop') && !e.target.closest('.doodle')) openContext(e);
});
scroller.addEventListener('scroll', hideHandle);
scroller.addEventListener('wheel', (e) => { if (!e.ctrlKey) hidePops(false); }, { passive: true });
window.addEventListener('blur', () => { document.body.classList.remove('ctrl'); hidePops(false); });
window.addEventListener('resize', () => hidePops(false));
window.addEventListener('keyup', (e) => { if (e.key === 'Control') document.body.classList.remove('ctrl'); });

window.addEventListener('keydown', (e) => {
  if (e.key === 'Control') document.body.classList.add('ctrl');
  if (e.key === 'Escape' && finder.open && !modal) { closeFind(true); return; }
  if (e.key === 'Escape') {
    if (modal) { if (!root.classList.contains('unlocking')) closeModal(); }
    else hidePops(true);
    return;
  }
  const box = document.activeElement && document.activeElement.classList.contains('note') ? document.activeElement : null;
  const typingIn = activeEditor();
  const textBox = typingIn && typingIn !== column ? typingIn.closest('.note') : null;
  if (textBox && !modal && e.key === 'Delete' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
    e.preventDefault();
    textBox.remove();
    fitBoard();
    changed('box');
    return;
  }
  if (box && !modal && (e.key === 'Delete' || e.key === 'Backspace')) {
    e.preventDefault();
    box.remove();
    fitBoard();
    changed('box');
    return;
  }
  if (dashHeld && e.key === '-') { e.preventDefault(); return; }
  if (e.altKey && !e.ctrlKey && !e.metaKey && !modal && (e.code === 'KeyC' || e.code === 'KeyX') && activeEditor()) {
    e.preventDefault();
    document.execCommand('insertText', false, e.code === 'KeyC' ? '✓' : '✗');
    return;
  }
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  // Ctrl+- strikes through (matched by the character, so it works on any keyboard layout and the numpad)
  if (!modal && !e.shiftKey && (e.key === '-' || e.code === 'NumpadSubtract')) { e.preventDefault(); e.stopPropagation(); strike(); return; }
  const key = e.code.replace(/^(Digit|Numpad|Key)/, '');
  const run = {
    W: () => native.close(),
    N: () => native.newWindow(),
    O: () => native.openDialog(!st.hasPath && docIsEmpty()),
  };
  if (e.shiftKey) run.T = async () => { if (!(await native.reopenClosed())) toast('Nothing to reopen'); };
  if (!modal) {
    Object.assign(run, {
      1: () => cycleInline('size'),
      2: () => cycleInline('color'),
      3: () => cycleBox(),
      4: () => (panel.classList.contains('hidden') ? openPanel() : hidePops(true)),
      L: () => lockFlow(),
      F: () => openFind(),
      0: () => setZoom(1),
      S: () => save(e.shiftKey ? 'as' : 'explicit'),
    });
    if (!e.target.closest || !e.target.closest('#find')) { // the find box keeps its own undo
      run.Z = () => travel(e.shiftKey ? 1 : -1);
      run.Y = () => travel(1);
    }
  }
  if (run[key]) { e.preventDefault(); e.stopPropagation(); run[key](); }
}, true);

// ---------- start ----------

native.onSettings((s) => { st.settings = { ...st.settings, ...s }; applyLook(); });
native.onBeforeClose(async () => {
  if (st.ready && (dirty || saving)) { dirty = true; await save('auto'); }
  native.closeReady({ empty: st.ready && docIsEmpty() });
});

(async function start() {
  buildPanel();
  const init = await native.init();
  st.settings = { ...st.settings, ...init.settings, fonts: { ...(init.settings && init.settings.fonts) } };
  applyLook();
  applyInfo(init);
  if (init.needsPassword) unlockFlow(init.name);
  else if (typeof init.text === 'string') loadText(init.text);
  else {
    loadDoc(init.doc);
    if (init.error) toast(init.error, 5000);
  }
  if (!st.settings.seenTutorial) showTour();
})();

// ---------- browser preview stand-in (only used outside the desktop app) ----------

function devApi() {
  const get = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) || d; } catch { return d; } };
  const put = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  let locked = false;
  const info = () => ({ name: 'Preview', path: null, locked });
  return {
    init: async () => ({ ...info(), settings: get('op-settings', { theme: 'paper', fonts: {} }), doc: get('op-doc', null) }),
    save: async ({ doc }) => { put('op-doc', doc); return info(); },
    setLock: async () => { locked = true; return info(); },
    removeLock: async () => { locked = false; return info(); },
    unlock: async () => ({ error: 'Preview only' }),
    openDialog: async () => false,
    getRecent: async () => [], openRecent() {}, reopenClosed: async () => false, setOnTop() {},
    newWindow() {}, openExternal(u) { window.open(u); }, paste() {}, close() {},
    setSettings: (s) => put('op-settings', { ...get('op-settings', {}), ...s }), setChrome() {}, closeReady() {},
    pickBackground: async () => null, getBackground: async () => null,
    onSettings() {}, onBeforeClose() {},
  };
}
