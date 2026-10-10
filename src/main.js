// Optima Pad: main process.
// One window = one note = one .opad file. Locked notes are encrypted with AES-256-GCM
// using a key derived from the password with scrypt; the password itself is never stored.
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, globalShortcut, screen, session } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

const DEV = !app.isPackaged;

// The installed app refuses to be started with a debugger attached, so no other program can read an unlocked note.
if (!DEV && ['remote-debugging-port', 'remote-debugging-pipe', 'inspect', 'inspect-brk'].some((s) => app.commandLine.hasSwitch(s))) {
  app.exit(0);
}

// Development only: run a separate profile so a test copy never merges into an installed, running Optima Pad.
if (DEV && process.env.OPTIMA_PAD_PROFILE) app.setPath('userData', process.env.OPTIMA_PAD_PROFILE);
const EXT = 'opad';
const QUICK_NOTE_KEY = 'CommandOrControl+Alt+O';
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

// ---------- settings (theme + font choice, shared by all windows) ----------

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
let settings = {
  theme: 'paper', fonts: {}, size: 18, bgOn: false, bgFile: null, bgVersion: 0, seenTutorial: false, recent: [], closed: [],
  chrome: { bg: '#ece3d0', fg: '#8f8069', overlay: '#ece3d0' },
};
const RENDERER_KEYS = ['theme', 'fonts', 'size', 'bgOn', 'seenTutorial'];
const publicSettings = () => ({
  theme: settings.theme, fonts: settings.fonts, size: settings.size,
  bgOn: settings.bgOn, bgVersion: settings.bgFile ? settings.bgVersion : 0, seenTutorial: settings.seenTutorial,
});

function broadcastSettings(exceptId) {
  for (const [id, st] of states) if (id !== exceptId) st.win.webContents.send('settings', publicSettings());
}

function loadSettings() {
  try { settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; } catch {}
}
function saveSettings() {
  try { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch {}
}

// ---------- files ----------

const notesDir = () => (DEV && process.env.OPTIMA_PAD_NOTES) || path.join(app.getPath('documents'), 'Optima Pad');

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
}

// A short, readable file name from the note's first line ("Spring launch ideas").
function nameFromLine(line) {
  let s = safeName(line);
  if (s.length > 48) s = s.slice(0, 48).replace(/\s+\S*$/, '');
  return s.replace(/[. ]+$/, '');
}

// Where an unsaved note lives. Locked notes never take their name from the text (that would leak it).
function draftPath(firstLine, locked, current) {
  const curBase = current ? path.basename(current, path.extname(current)).replace(/ \(\d+\)$/, '') : '';
  let base;
  if (locked) base = curBase.startsWith('Locked note') ? curBase : `Locked note ${stamp()}`;
  else base = nameFromLine(firstLine) || (current && !curBase.startsWith('Locked note') ? curBase : `Note ${stamp()}`);
  fs.mkdirSync(notesDir(), { recursive: true });
  let p = path.join(notesDir(), `${base}.${EXT}`);
  for (let i = 2; fs.existsSync(p) && !samePath(p, current); i++) p = path.join(notesDir(), `${base} (${i}).${EXT}`);
  return p;
}

const insideNotesDir = (p) => !!p && path.resolve(p).toLowerCase().startsWith(path.resolve(notesDir()).toLowerCase() + path.sep);

function forgetPath(p) {
  settings.recent = (settings.recent || []).filter((q) => !samePath(q, p));
  settings.closed = (settings.closed || []).filter((q) => !samePath(q, p));
  saveSettings();
}

function renamePath(from, to) {
  settings.recent = (settings.recent || []).map((q) => (samePath(q, from) ? to : q));
  settings.closed = (settings.closed || []).map((q) => (samePath(q, from) ? to : q));
  saveSettings();
}

function safeName(s) {
  return (s || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60).replace(/[. ]+$/, '');
}

function writeFileSafe(p, data) {
  const tmp = `${p}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, p);
  } catch {
    // OneDrive and antivirus can briefly hold files; fall back to a direct write.
    try { fs.unlinkSync(tmp); } catch {}
    fs.writeFileSync(p, data);
  }
}

function encode(doc, st) {
  if (!st.key) return JSON.stringify({ app: 'optima-pad', v: 1, doc });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', st.key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(doc), 'utf8'), cipher.final()]);
  return JSON.stringify({
    app: 'optima-pad', v: 1, locked: true, kdf: 'scrypt',
    salt: st.salt.toString('base64'), iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64'),
  });
}

function decrypt(file, key) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(file.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(file.tag, 'base64'));
  const out = Buffer.concat([decipher.update(Buffer.from(file.data, 'base64')), decipher.final()]);
  return JSON.parse(out.toString('utf8'));
}

// Recently opened/saved notes, newest first (shown under "Open recent" in the panel).
function rememberRecent(p) {
  if (!p) return;
  const list = (settings.recent || []).filter((q) => !samePath(q, p));
  settings.recent = [path.resolve(p), ...list].slice(0, 20);
  saveSettings();
}

const isNoteFile = (p) => path.extname(p).toLowerCase() === `.${EXT}`;
// .opad notes show their bare name; plain text files keep their extension so you can tell them apart.
const displayName = (p) => (!p ? 'Untitled' : isNoteFile(p) ? path.basename(p, path.extname(p)) : path.basename(p));

// ---------- plain text files (.txt and friends) ----------
// Read and written back in their original encoding and line endings, so other programs never notice.

const CP1252 = (() => {
  const dec = new TextDecoder('windows-1252');
  const back = new Map();
  for (let b = 0x80; b <= 0x9f; b++) back.set(dec.decode(Uint8Array.of(b)), b);
  return { dec, back };
})();

function looksUtf16(buf) {
  const n = Math.min(buf.length, 4096) & ~1;
  if (n < 4) return null;
  let even = 0, odd = 0;
  for (let i = 0; i < n; i += 2) { if (buf[i] === 0) even++; if (buf[i + 1] === 0) odd++; }
  const pairs = n / 2;
  if (odd > pairs * 0.4 && even < pairs * 0.05) return 'utf16le-nobom';
  if (even > pairs * 0.4 && odd < pairs * 0.05) return 'utf16be-nobom';
  return null;
}

function readText(file) {
  const buf = fs.readFileSync(file);
  let encoding = 'utf8', text;
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) { encoding = 'utf8bom'; text = buf.subarray(3).toString('utf8'); }
  else if (buf[0] === 0xff && buf[1] === 0xfe) { encoding = 'utf16le'; text = buf.subarray(2).toString('utf16le'); }
  else if (buf[0] === 0xfe && buf[1] === 0xff) { encoding = 'utf16be'; text = Buffer.from(buf.subarray(2)).swap16().toString('utf16le'); }
  else if (looksUtf16(buf)) {
    // UTF-16 without a byte-order mark (some Windows tools write these): every other byte is zero.
    encoding = looksUtf16(buf);
    text = encoding === 'utf16le-nobom' ? buf.toString('utf16le') : Buffer.from(buf).swap16().toString('utf16le');
  } else {
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
    catch { encoding = 'cp1252'; text = CP1252.dec.decode(buf); } // older "ANSI" files
  }
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  text = text.replace(/\r\n?/g, '\n');
  const finalNewline = text.endsWith('\n');
  if (finalNewline) text = text.slice(0, -1);
  return { text, meta: { encoding, eol, finalNewline } };
}

function encodeText(text, meta) {
  let t = text.replace(/\n/g, meta.eol);
  if (meta.finalNewline) t += meta.eol;
  if (meta.encoding === 'utf8bom') return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(t, 'utf8')]);
  if (meta.encoding === 'utf16le') return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(t, 'utf16le')]);
  if (meta.encoding === 'utf16be') return Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(t, 'utf16le').swap16()]);
  if (meta.encoding === 'utf16le-nobom') return Buffer.from(t, 'utf16le');
  if (meta.encoding === 'utf16be-nobom') return Buffer.from(t, 'utf16le').swap16();
  if (meta.encoding === 'cp1252') {
    const bytes = [];
    for (const ch of t) {
      const c = ch.codePointAt(0);
      if (c < 0x80 || (c >= 0xa0 && c <= 0xff)) bytes.push(c);
      else if (CP1252.back.has(ch)) bytes.push(CP1252.back.get(ch));
      else { meta.encoding = 'utf8'; return Buffer.from(t, 'utf8'); } // a character ANSI can't hold: switch to UTF-8
    }
    return Buffer.from(bytes);
  }
  return Buffer.from(t, 'utf8');
}
const samePath = (a, b) => a && b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// ---------- windows ----------

const states = new Map(); // webContents.id -> { win, path, isDraft, key, salt, raw, closing }

function createWindow(filePath = null, quick = false) {
  const prev = BrowserWindow.getFocusedWindow();
  const opts = {
    width: quick ? 460 : 980, height: quick ? 340 : 800, minWidth: 300, minHeight: 220, show: false,
    backgroundColor: settings.chrome.bg,
    title: displayName(filePath),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: settings.chrome.overlay || settings.chrome.bg, symbolColor: settings.chrome.fg, height: 38 },
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, sandbox: true, spellcheck: false,
    },
  };
  if (quick) {
    // centred on the screen the mouse is on
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    opts.x = Math.round(area.x + (area.width - opts.width) / 2);
    opts.y = Math.round(area.y + (area.height - opts.height) / 2);
  } else if (prev) {
    const [x, y] = prev.getPosition();
    opts.x = x + 28; opts.y = y + 28;
  }
  const win = new BrowserWindow(opts);
  const st = { win, path: filePath, isDraft: false, key: null, salt: null, raw: null, closing: false, textMeta: null };
  rememberRecent(filePath);
  const id = win.webContents.id;
  states.set(id, st);

  win.loadFile(path.join(__dirname, 'index.html'));
  win.once('ready-to-show', () => {
    win.show();
    if (quick) {
      // pop in front of whatever app you were in
      win.setAlwaysOnTop(true);
      win.focus();
      setTimeout(() => { if (!win.isDestroyed() && !st.pinned) win.setAlwaysOnTop(false); }, 400);
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  win.on('close', (e) => {
    if (st.closing) return;
    e.preventDefault();
    win.webContents.send('before-close');
    // Never let a stuck renderer keep the window open forever.
    setTimeout(() => { if (!win.isDestroyed()) { st.closing = true; win.close(); } }, 5000);
  });
  win.on('closed', () => {
    states.delete(id);
    // Remember it for Ctrl+Shift+T (kept across restarts, like the recent list).
    if (st.path && fs.existsSync(st.path)) {
      settings.closed = [path.resolve(st.path), ...(settings.closed || []).filter((q) => !samePath(q, st.path))].slice(0, 20);
      saveSettings();
    }
  });
  return win;
}

function openFile(p) {
  for (const st of states.values()) {
    if (samePath(st.path, p)) { if (st.win.isMinimized()) st.win.restore(); st.win.focus(); return; }
  }
  createWindow(path.resolve(p));
}

function openExternal(url) {
  if (/^(https?:|mailto:)/i.test(url)) shell.openExternal(url);
}

function filesFromArgv(argv) {
  return argv.slice(1).filter((a) => {
    if (a.startsWith('-')) return false;
    try { return fs.statSync(a).isFile(); } catch { return false; }
  });
}

// ---------- IPC ----------

const stateOf = (e) => states.get(e.sender.id);
const info = (st) => ({ name: displayName(st.path), path: st.path, isDraft: st.isDraft, locked: !!st.key, plain: !!st.textMeta });

ipcMain.handle('init', (e) => {
  const st = stateOf(e);
  const base = { settings: publicSettings() };
  if (!st.path) return { ...base, ...info(st), doc: null };
  if (!isNoteFile(st.path)) {
    try {
      const { text, meta } = readText(st.path);
      st.textMeta = meta;
      return { ...base, ...info(st), text };
    } catch (err) {
      return { ...base, ...info(st), doc: null, error: `Couldn't read this file (${err.code || err.message}).` };
    }
  }
  try {
    const text = fs.readFileSync(st.path, 'utf8');
    if (!text.trim()) return { ...base, ...info(st), doc: null }; // fresh file from Explorer's New menu
    const file = JSON.parse(text);
    if (file.locked) { st.raw = file; return { ...base, ...info(st), locked: true, needsPassword: true }; }
    return { ...base, ...info(st), doc: file.doc || null };
  } catch (err) {
    return { ...base, ...info(st), doc: null, error: `Couldn't read this file (${err.code || err.message}).` };
  }
});

ipcMain.handle('unlock', async (e, password) => {
  const st = stateOf(e);
  if (!st.raw) return { error: 'Nothing to unlock.' };
  const salt = Buffer.from(st.raw.salt, 'base64');
  const key = await scrypt(String(password), salt, 32, SCRYPT);
  try {
    const doc = decrypt(st.raw, key);
    st.key = key; st.salt = salt; st.raw = null;
    return { doc, ...info(st) };
  } catch {
    return { error: 'Wrong password.' };
  }
});

ipcMain.handle('set-lock', async (e, password) => {
  const st = stateOf(e);
  if (st.textMeta) return info(st); // plain text files can't hold a lock
  st.salt = crypto.randomBytes(16);
  st.key = await scrypt(String(password), st.salt, 32, SCRYPT);
  return info(st);
});

ipcMain.handle('remove-lock', async (e, password) => {
  const st = stateOf(e);
  if (!st.key) return info(st);
  const key = await scrypt(String(password), st.salt, 32, SCRYPT);
  if (!crypto.timingSafeEqual(key, st.key)) return { error: 'Wrong password.' };
  st.key = null; st.salt = null;
  return info(st);
});

ipcMain.handle('save', async (e, { doc, text, firstLine, empty, mode }) => {
  const st = stateOf(e);
  // A plain text window writes plain text; everything else writes an .opad note.
  const write = (file) => writeFileSafe(file, st.textMeta ? encodeText(text || '', st.textMeta) : encode(doc, st));
  try {
    const wantsDialog = mode === 'as' || (mode === 'explicit' && (!st.path || st.isDraft));
    if (wantsDialog) {
      const plain = !!st.textMeta;
      const base = plain ? path.basename(st.path, path.extname(st.path)) : safeName(firstLine) || 'Untitled';
      const suggested = path.join(plain ? path.dirname(st.path) : notesDir(), `${base}.${EXT}`);
      fs.mkdirSync(notesDir(), { recursive: true });
      const r = await dialog.showSaveDialog(st.win, {
        defaultPath: st.path && !st.isDraft && !plain ? st.path : suggested,
        filters: plain
          ? [{ name: 'Optima Pad note (keeps formatting)', extensions: [EXT] }, { name: 'Plain text', extensions: ['txt'] }]
          : [{ name: 'Optima Pad note', extensions: [EXT] }],
      });
      if (r.canceled || !r.filePath) return { canceled: true, ...info(st) };
      const draft = st.isDraft ? st.path : null;
      // Saving a text file as .opad turns this window into a full note; .txt stays plain.
      if (plain && isNoteFile(r.filePath)) st.textMeta = null;
      write(r.filePath);
      st.path = r.filePath; st.isDraft = false;
      rememberRecent(st.path);
      if (draft && !samePath(draft, r.filePath)) { try { fs.unlinkSync(draft); } catch {} }
    } else if (!st.path) {
      if (empty) return info(st); // nothing worth keeping yet
      st.path = draftPath(firstLine, !!st.key, null); st.isDraft = true;
      write(st.path);
      rememberRecent(st.path);
    } else if (st.isDraft) {
      // the draft's file name follows its first line while it's still a draft
      const want = draftPath(firstLine, !!st.key, st.path);
      if (!samePath(want, st.path)) {
        try { fs.renameSync(st.path, want); renamePath(st.path, want); st.path = want; } catch {}
      }
      write(st.path);
    } else {
      write(st.path);
    }
    st.win.setTitle(displayName(st.path));
    return info(st);
  } catch (err) {
    return { error: `Couldn't save (${err.code || err.message}).`, ...info(st) };
  }
});

ipcMain.handle('open-dialog', async (e, pristine) => {
  const st = stateOf(e);
  const r = await dialog.showOpenDialog(st.win, {
    defaultPath: fs.existsSync(notesDir()) ? notesDir() : app.getPath('documents'),
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Notes and text files', extensions: [EXT, 'txt', 'md', 'log'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (r.canceled || !r.filePaths.length) return false;
  r.filePaths.forEach(openFile);
  if (pristine && !r.filePaths.some((p) => samePath(p, st.path))) { st.closing = true; st.win.close(); }
  return true;
});

ipcMain.on('new-window', () => createWindow());

// The pin in the top-left corner keeps a note above other windows.
ipcMain.on('set-on-top', (e, on) => {
  const st = stateOf(e);
  st.pinned = !!on;
  st.win.setAlwaysOnTop(!!on, 'floating');
});

// Ctrl+Shift+T: bring back the most recently closed note that isn't open already.
ipcMain.handle('reopen-closed', () => {
  const list = settings.closed || [];
  while (list.length) {
    const p = list.shift();
    const open = [...states.values()].some((st) => samePath(st.path, p));
    if (!open && fs.existsSync(p)) {
      settings.closed = list;
      saveSettings();
      openFile(p);
      return true;
    }
  }
  settings.closed = [];
  saveSettings();
  return false;
});

ipcMain.handle('get-recent', (e) => {
  const own = stateOf(e).path;
  const out = [];
  for (const p of settings.recent || []) {
    if (samePath(p, own)) continue;
    try {
      const stat = fs.statSync(p);
      out.push({ path: p, name: displayName(p), folder: path.basename(path.dirname(p)), time: stat.mtimeMs });
    } catch {} // moved or deleted: just skip it
    if (out.length === 8) break;
  }
  return out;
});
ipcMain.on('open-recent', (_e, p) => {
  if ((settings.recent || []).some((q) => samePath(q, p)) && fs.existsSync(p)) openFile(p);
});
ipcMain.on('open-external', (_e, url) => openExternal(url));
ipcMain.on('paste', (e) => e.sender.paste());
ipcMain.on('close-window', (e) => stateOf(e)?.win.close());

ipcMain.on('set-settings', (e, partial) => {
  for (const k of RENDERER_KEYS) if (k in partial) settings[k] = partial[k];
  saveSettings();
  broadcastSettings(e.sender.id);
});

ipcMain.on('set-chrome', (e, chrome) => {
  const st = stateOf(e);
  settings.chrome = chrome;
  saveSettings();
  try {
    st.win.setBackgroundColor(chrome.bg);
    st.win.setTitleBarOverlay({ color: chrome.overlay || chrome.bg, symbolColor: chrome.fg, height: 38 });
  } catch {}
});

// Custom background photo: copied into the app's own folder so moving/deleting the original doesn't matter.
const IMAGE_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

ipcMain.handle('pick-background', async (e) => {
  const st = stateOf(e);
  const r = await dialog.showOpenDialog(st.win, {
    defaultPath: app.getPath('pictures'),
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }],
  });
  if (r.canceled || !r.filePaths.length) return null;
  const src = r.filePaths[0];
  const ext = path.extname(src).toLowerCase();
  if (!IMAGE_TYPES[ext]) return null;
  const dir = app.getPath('userData');
  for (const f of fs.readdirSync(dir)) if (f.startsWith('background.')) { try { fs.unlinkSync(path.join(dir, f)); } catch {} }
  fs.copyFileSync(src, path.join(dir, `background${ext}`));
  settings = { ...settings, bgFile: `background${ext}`, bgVersion: Date.now(), bgOn: true };
  saveSettings();
  broadcastSettings(e.sender.id);
  return publicSettings();
});

ipcMain.handle('get-background', () => {
  if (!settings.bgFile) return null;
  try {
    const buf = fs.readFileSync(path.join(app.getPath('userData'), settings.bgFile));
    return `data:${IMAGE_TYPES[path.extname(settings.bgFile)]};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
});

ipcMain.on('close-ready', (e, { empty }) => {
  const st = stateOf(e);
  if (!st) return;
  // An empty note doesn't leave an empty file behind (drafts, and notes in the Optima Pad folder).
  if (empty && st.path && !st.textMeta && (st.isDraft || (isNoteFile(st.path) && insideNotesDir(st.path)))) {
    try { fs.unlinkSync(st.path); forgetPath(st.path); } catch {}
    st.path = null;
  }
  st.closing = true;
  st.win.close();
});

// ---------- app lifecycle ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const files = filesFromArgv(argv);
    if (files.length) files.forEach(openFile); else createWindow();
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    // A notes app never needs the camera, microphone, location, notifications and so on: deny every request.
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    loadSettings();
    // Ctrl+Alt+O from anywhere: a small fresh note.
    globalShortcut.register(QUICK_NOTE_KEY, () => createWindow(null, true));
    if (!DEV) {
      // start quietly with Windows so the shortcut works right away (Task Manager > Startup apps can turn this off)
      app.setLoginItemSettings({ openAtLogin: true, name: 'Optima Pad', args: ['--background'] });
    }
    const files = filesFromArgv(process.argv);
    if (files.length) files.forEach(openFile);
    else if (!process.argv.includes('--background')) createWindow();
  });

  // The installed app stays running without windows, so the quick-note shortcut keeps working.
  app.on('window-all-closed', () => { if (DEV) app.quit(); });
  app.on('will-quit', () => globalShortcut.unregisterAll());
}
