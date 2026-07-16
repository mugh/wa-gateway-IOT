const fs   = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'endpoints.json');

function ensureFile() {
  const dir = path.dirname(FILE);
  if (!fs.existsSync(dir))  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, '[]', 'utf8');
}

function load() {
  ensureFile();
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return [];
  }
}

function save(list) {
  ensureFile();
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2), 'utf8');
}

// Validasi: path hanya boleh alphanumeric + dash + underscore
function isValidPath(p) {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(p);
}

function getAll() {
  return load();
}

function getByPath(triggerPath) {
  return load().find(e => e.path === triggerPath) || null;
}

function add({ triggerPath, key, number, message, label }) {
  if (!isValidPath(triggerPath)) {
    throw new Error('Path hanya boleh huruf, angka, dash, underscore (max 64 karakter).');
  }
  if (!key || key.length < 8) {
    throw new Error('Key minimal 8 karakter.');
  }
  if (!number || !message) {
    throw new Error('Nomor dan pesan wajib diisi.');
  }

  const list = load();
  if (list.find(e => e.path === triggerPath)) {
    throw new Error(`Path "/${triggerPath}" sudah dipakai.`);
  }

  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    path: triggerPath,
    key,
    number,
    message,
    label: label || triggerPath,
    createdAt: new Date().toISOString(),
    hitCount: 0,
    lastHit: null,
  };

  list.push(entry);
  save(list);
  return entry;
}

function remove(id) {
  const list = load();
  const idx  = list.findIndex(e => e.id === id);
  if (idx === -1) throw new Error('Endpoint tidak ditemukan.');
  const [removed] = list.splice(idx, 1);
  save(list);
  return removed;
}

function recordHit(id) {
  const list = load();
  const entry = list.find(e => e.id === id);
  if (entry) {
    entry.hitCount  = (entry.hitCount || 0) + 1;
    entry.lastHit   = new Date().toISOString();
    save(list);
  }
}

module.exports = { getAll, getByPath, add, remove, recordHit, isValidPath };
