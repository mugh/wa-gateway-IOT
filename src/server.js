require('dotenv').config();

const express = require('express');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const wa        = require('./whatsapp');
const ep        = require('./endpoints');
const { requireSession, requireApiKey } = require('./middleware');

// --- Validasi env wajib ---
const REQUIRED_ENV = ['LOGIN_PASSWORD', 'API_KEY', 'SESSION_SECRET'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`[FATAL] Env "${key}" belum di-set di .env`);
    process.exit(1);
  }
}

const app = express();
const PORT = process.env.PORT || 3000;

// Wajib kalau di belakang reverse proxy / Docker network yang forward X-Forwarded-For
// Kalau langsung expose tanpa proxy, ganti ke false
app.set('trust proxy', 1);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Request logger sederhana ---
const RESET = '\x1b[0m';
const DIM   = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED   = '\x1b[31m';
const CYAN  = '\x1b[36m';

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const code = res.statusCode;
    const color = code >= 500 ? RED : code >= 400 ? YELLOW : code >= 300 ? CYAN : GREEN;
    const ip = req.ip || req.socket?.remoteAddress || '-';
    const ts = new Date().toTimeString().slice(0, 8);
    console.log(
      `${DIM}[${ts}]${RESET} ${color}${code}${RESET} ${req.method.padEnd(6)} ${req.path.padEnd(24)} ${DIM}${ms}ms  ${ip}${RESET}`
    );
  });
  next();
});

app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 12, // 12 jam
    },
  })
);

// Rate limit khusus halaman login, anti brute-force password
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Terlalu banyak percobaan login. Coba lagi dalam 15 menit.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limit untuk REST API kirim pesan, jaga-jaga dari salah pakai / loop
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { ok: false, error: 'Terlalu banyak request, coba lagi sebentar.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ----------------- LOGIN -----------------
app.get('/login', (req, res) => {
  if (req.session.loggedIn) return res.redirect('/dashboard');
  const html = fs
    .readFileSync(path.join(__dirname, 'public', 'login.html'), 'utf8')
    .replace('{{ERROR}}', '');
  res.send(html);
});

app.post('/login', loginLimiter, (req, res) => {
  const { password } = req.body;
  if (password === process.env.LOGIN_PASSWORD) {
    req.session.loggedIn = true;
    return res.redirect('/dashboard');
  }
  const html = fs
    .readFileSync(path.join(__dirname, 'public', 'login.html'), 'utf8')
    .replace('{{ERROR}}', 'Password salah.');
  res.status(401).send(html);
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ----------------- DASHBOARD (perlu login session) -----------------
app.get('/dashboard', requireSession, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/dashboard/status', requireSession, async (req, res) => {
  const status = wa.getStatus();
  let qrImage = null;

  if (status.status === 'qr' && wa.getQr()) {
    qrImage = await QRCode.toDataURL(wa.getQr(), { width: 240, margin: 1 });
  }

  res.json({ ...status, qrImage });
});

app.post('/dashboard/start', requireSession, async (req, res) => {
  if (wa.getStatus().status === 'disconnected') {
    wa.start().catch((err) => console.error('[WA] Gagal start:', err));
  }
  res.redirect('/dashboard');
});

app.post('/dashboard/logout', requireSession, async (req, res) => {
  await wa.logout();
  // Hapus folder session biar bener-bener logout dan minta scan QR baru
  const authDir = path.join(__dirname, '..', 'auth_session');
  fs.rm(authDir, { recursive: true, force: true }, () => {
    res.redirect('/dashboard');
  });
});

// ----------------- REST API (perlu x-api-key) -----------------
app.post('/api/send', apiLimiter, requireApiKey, async (req, res) => {
  const { number, message } = req.body;

  if (!number || !message) {
    return res.status(400).json({ ok: false, error: 'Field "number" dan "message" wajib diisi.' });
  }

  try {
    const result = await wa.sendTextMessage(number, message);
    res.json({ ok: true, messageId: result?.key?.id || null });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/status', requireApiKey, (req, res) => {
  res.json({ ok: true, ...wa.getStatus() });
});

// Daftar grup (perlu login session — data internal, bukan publik)
app.get('/dashboard/groups', requireSession, async (req, res) => {
  try {
    const groups = await wa.getGroups();
    res.json({ ok: true, groups });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ----------------- API: CRUD CUSTOM ENDPOINTS (perlu x-api-key) -----------------
// Sama persis dengan yang di dashboard, tapi auth pakai x-api-key bukan session
// Berguna untuk automation / provisioning dari app lain tanpa buka browser

app.get('/api/endpoints', requireApiKey, (req, res) => {
  res.json({ ok: true, endpoints: ep.getAll() });
});

app.post('/api/endpoints', apiLimiter, requireApiKey, (req, res) => {
  const { triggerPath, key, number, message, label } = req.body;
  try {
    const entry = ep.add({ triggerPath, key, number, message, label });
    res.json({ ok: true, entry });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.delete('/api/endpoints/:id', requireApiKey, (req, res) => {
  try {
    ep.remove(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ ok: false, error: err.message });
  }
});

// ----------------- CUSTOM ENDPOINTS - manajemen (perlu login) -----------------
app.get('/dashboard/endpoints', requireSession, (req, res) => {
  res.json(ep.getAll());
});

app.post('/dashboard/endpoints', requireSession, (req, res) => {
  const { triggerPath, key, number, message, label } = req.body;
  try {
    const entry = ep.add({ triggerPath, key, number, message, label });
    res.json({ ok: true, entry });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.delete('/dashboard/endpoints/:id', requireSession, (req, res) => {
  try {
    ep.remove(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ ok: false, error: err.message });
  }
});

// Rate limit khusus trigger publik — lebih ketat dari API utama
const triggerLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(404).end(), // tetap 404 biar gak bocor info
});

// ----------------- CUSTOM ENDPOINTS - trigger publik (GET, no auth header) -----------------
app.get('/trigger/:triggerPath', triggerLimiter, async (req, res) => {
  const entry = ep.getByPath(req.params.triggerPath);

  // Semua kondisi gagal → 404, gak ada bedanya bagi caller
  if (!entry)                              return res.status(404).end();
  if (req.query.key !== entry.key)         return res.status(404).end();
  if (!wa.isConnected())                   return res.status(404).end();

  try {
    await wa.sendTextMessage(entry.number, entry.message);
    ep.recordHit(entry.id);
    res.json({ ok: true });
  } catch (err) {
    // Error kirim pesan tetap 500 (ini beda kasus — key sudah benar)
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ----------------- Root -----------------
app.get('/', (req, res) => {
  res.redirect(req.session?.loggedIn ? '/dashboard' : '/login');
});

app.listen(PORT, () => {
  console.log(`[Server] WA Gateway jalan di port ${PORT}`);
  // Auto-start koneksi WA saat server nyala (kalau sudah ada session tersimpan)
  wa.start().catch((err) => console.error('[WA] Gagal start awal:', err));
});
