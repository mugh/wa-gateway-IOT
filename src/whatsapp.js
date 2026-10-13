'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
} = require('baileys');
const pino = require('pino');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, '..', 'auth_session');
const CREDS_FILE = path.join(AUTH_DIR, 'creds.json');
const CREDS_BACKUP = `${CREDS_FILE}.bak`;

const MAX_BACKOFF_MS = 60 * 1000;
const SEND_TIMEOUT_MS = 30 * 1000;
const GROUPS_CACHE_MS = 60 * 1000;
const MESSAGE_CACHE_SIZE = 500;
const BAD_SESSION_LIMIT = 3; // berapa kali 500 beruntun sebelum session dianggap rusak

// Kode disconnect (sama dengan DisconnectReason di Baileys). Ditulis numerik
// supaya tidak ada risiko undefined === undefined kalau enum berubah.
const CODE = {
  badSession: 500,
  connectionReplaced: 440,
  forbidden: 403,
  loggedOut: 401,
  multideviceMismatch: 411,
  restartRequired: 515,
};

const logger = pino({ level: 'silent' });

// Fallback: versi WA Web minimum yang diketahui masih diterima WhatsApp.
const MIN_WA_VERSION = [2, 3000, 1044015310];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function compareVersion(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

async function resolveWaVersion() {
  try {
    const { version, isLatest } = await fetchLatestBaileysVersion();
    if (compareVersion(version, MIN_WA_VERSION) < 0) {
      console.log(
        `[WA] Versi hasil fetch (${version.join('.')}) lebih lama dari MIN_WA_VERSION (${MIN_WA_VERSION.join('.')}), pakai MIN_WA_VERSION.`
      );
      return MIN_WA_VERSION;
    }
    console.log(`[WA] Pakai versi WA ${version.join('.')} (isLatest: ${isLatest}).`);
    return version;
  } catch (e) {
    console.log(`[WA] Gagal fetch versi WA (${e.message}), pakai MIN_WA_VERSION.`);
    return MIN_WA_VERSION;
  }
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function isValidJsonFile(file) {
  try {
    JSON.parse(await fsp.readFile(file, 'utf8'));
    return true;
  } catch {
    return false;
  }
}

async function atomicCopy(src, dst) {
  const tmp = `${dst}.tmp`;
  await fsp.copyFile(src, tmp);
  await fsp.rename(tmp, dst);
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------
class WhatsAppService {
  constructor() {
    this.sock = null;
    this.qr = null;
    this.status = 'disconnected'; // disconnected | connecting | qr | connected

    this.socketId = 0; // generasi socket; event dari socket lama diabaikan
    this.starting = false;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.badSessionCount = 0;
    this.lastDisconnect = null; // { code, message, at }

    this.saveChain = Promise.resolve(); // serialisasi tulis creds
    this.messageCache = new Map(); // untuk getMessage (retry decrypt)
    this.groupsCache = { at: 0, data: null };
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------
  /**
   * Idempotent: aman dipanggil berulang (auto-start, tombol dashboard, timer
   * reconnect). Tidak akan pernah membuat dua socket sekaligus.
   */
  async start() {
    if (this.starting) return this.sock;
    if (this.sock && (this.status === 'connected' || this.status === 'qr')) {
      return this.sock;
    }

    this.starting = true;
    this._clearReconnectTimer();

    try {
      this._teardownSocket();
      await this._ensureValidCreds();

      const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
      const version = await resolveWaVersion();

      const id = ++this.socketId;
      this.status = 'connecting';

      const sock = makeWASocket({
        version,
        auth: state,
        logger,
        printQRInTerminal: false,
        // Platform.WEB mulai ditolak WhatsApp (Feb 2026+), pakai jalur Android.
        browser: Browsers.android(process.env.DEVICE_NAME || 'WA Gateway'),

        // Stabilitas koneksi (penting di belakang NAT / Docker / jaringan IoT)
        keepAliveIntervalMs: 25_000,
        connectTimeoutMs: 60_000,
        defaultQueryTimeoutMs: 60_000,
        retryRequestDelayMs: 500,

        // Kurangi beban & risiko: gateway cuma kirim pesan
        markOnlineOnConnect: false,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,

        getMessage: async (key) => this.messageCache.get(key.id),
      });

      this.sock = sock;

      sock.ev.on('creds.update', () => this._persistCreds(saveCreds));
      sock.ev.on('connection.update', (update) => this._onConnectionUpdate(id, update));

      return sock;
    } catch (err) {
      console.error('[WA] Gagal start:', err.message);
      this.status = 'disconnected';
      this._scheduleReconnect();
      return null;
    } finally {
      this.starting = false;
    }
  }

  /** Matikan koneksi tanpa logout (dipakai saat shutdown). Session tetap tersimpan. */
  async stop() {
    this.socketId += 1;
    this._clearReconnectTimer();
    this._teardownSocket();
    this.status = 'disconnected';
    this.qr = null;
    await this.saveChain;
  }

  /**
   * Logout + hapus session + otomatis siapkan QR baru.
   * Tidak perlu lagi hapus folder auth_session manual.
   */
  async logout({ restart = true } = {}) {
    this.socketId += 1; // abaikan event close dari logout ini
    this._clearReconnectTimer();

    const sock = this.sock;
    if (sock && this.status === 'connected') {
      try {
        await withTimeout(sock.logout(), 5000, 'logout timeout');
      } catch {
        // abaikan, session tetap kita hapus lokal
      }
    }

    this._teardownSocket();
    this.status = 'disconnected';
    this.qr = null;
    this.reconnectAttempts = 0;
    this.badSessionCount = 0;
    this.groupsCache = { at: 0, data: null };

    await this._clearAuthDir();

    if (restart) {
      this.start().catch((e) => console.error('[WA] Gagal start setelah logout:', e.message));
    }
  }

  // -------------------------------------------------------------------------
  // Connection events
  // -------------------------------------------------------------------------
  _onConnectionUpdate(id, update) {
    if (id !== this.socketId) return; // event dari socket lama

    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      this.qr = qr;
      this.status = 'qr';
      this.reconnectAttempts = 0; // QR muncul = alur normal, bukan error
    }

    if (connection === 'connecting' && this.status !== 'qr') {
      this.status = 'connecting';
    }

    if (connection === 'open') {
      this.qr = null;
      this.status = 'connected';
      this.reconnectAttempts = 0;
      this.badSessionCount = 0;
      this.lastDisconnect = null;
      console.log('[WA] Terhubung ke WhatsApp.');
    }

    if (connection === 'close') {
      this._handleClose(lastDisconnect);
    }
  }

  _handleClose(lastDisconnect) {
    // Jangan pakai `new Boom(undefined)`: hasilnya statusCode 500 palsu.
    const code = lastDisconnect?.error?.output?.statusCode;
    const message = lastDisconnect?.error?.message || 'unknown';
    this.lastDisconnect = { code, message, at: new Date().toISOString() };

    this.qr = null;
    this.socketId += 1; // invalidasi socket ini
    this._teardownSocket();

    console.log(`[WA] Koneksi tertutup (code: ${code ?? '-'}, ${message}).`);

    switch (code) {
      case CODE.loggedOut:
      case CODE.multideviceMismatch:
        console.log('[WA] Session tidak valid lagi. Menghapus session & menyiapkan QR baru...');
        this._resetAuthAndRestart();
        return;

      case CODE.badSession:
        this.badSessionCount += 1;
        if (this.badSessionCount >= BAD_SESSION_LIMIT) {
          console.log('[WA] Session rusak berulang kali. Reset session & siapkan QR baru...');
          this._resetAuthAndRestart();
        } else {
          this._scheduleReconnect();
        }
        return;

      case CODE.connectionReplaced:
        // Ada instance lain yang pakai session yang sama. Reconnect di sini
        // hanya akan membuat dua instance saling menendang tanpa henti.
        this.status = 'disconnected';
        console.log('[WA] Session dipakai instance lain (440). Berhenti reconnect. Pastikan hanya 1 instance yang jalan.');
        return;

      case CODE.forbidden:
        this.status = 'disconnected';
        console.log('[WA] Akses ditolak WhatsApp (403). Berhenti reconnect.');
        return;

      case CODE.restartRequired:
        // Normal setelah scan QR / pairing: langsung buka socket baru.
        this._scheduleReconnect({ immediate: true });
        return;

      default:
        this._scheduleReconnect();
    }
  }

  async _resetAuthAndRestart() {
    this.status = 'connecting';
    try {
      await this.saveChain; // pastikan tidak ada tulis creds yang masih jalan
      await this._clearAuthDir();
    } catch (e) {
      console.error('[WA] Gagal reset session:', e.message);
    }
    this.badSessionCount = 0;
    this.reconnectAttempts = 0;
    this._scheduleReconnect({ delayMs: 1000 });
  }

  _scheduleReconnect({ immediate = false, delayMs } = {}) {
    if (this.reconnectTimer) return;

    let delay;
    if (delayMs !== undefined) {
      delay = delayMs;
    } else if (immediate) {
      delay = 0;
    } else {
      this.reconnectAttempts += 1;
      const backoff = Math.min(1000 * 2 ** (this.reconnectAttempts - 1), MAX_BACKOFF_MS);
      delay = backoff + Math.floor(Math.random() * 1000);
      console.log(`[WA] Reconnect attempt ${this.reconnectAttempts} dalam ${Math.round(delay / 1000)}s...`);
    }

    this.status = 'connecting';
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.start().catch((e) => console.error('[WA] Reconnect gagal:', e.message));
    }, delay);
  }

  _clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  _teardownSocket() {
    const sock = this.sock;
    this.sock = null;
    if (!sock) return;

    try {
      sock.ev.removeAllListeners('connection.update');
    } catch {
      // ignore
    }
    try {
      sock.end(undefined);
    } catch {
      // ignore
    }
  }

  // -------------------------------------------------------------------------
  // Auth state (creds) handling
  // -------------------------------------------------------------------------
  /** Tulis creds satu per satu (tidak tumpang tindih) + simpan backup yang valid. */
  _persistCreds(saveCreds) {
    this.saveChain = this.saveChain.then(async () => {
      try {
        await saveCreds();
        if (await isValidJsonFile(CREDS_FILE)) {
          await atomicCopy(CREDS_FILE, CREDS_BACKUP);
        }
      } catch (e) {
        console.error('[WA] Gagal simpan creds:', e.message);
      }
    });
    return this.saveChain;
  }

  /** Kalau creds.json korup (mis. mati listrik saat nulis), pulihkan dari backup. */
  async _ensureValidCreds() {
    await fsp.mkdir(AUTH_DIR, { recursive: true });

    if (!fs.existsSync(CREDS_FILE)) return;
    if (await isValidJsonFile(CREDS_FILE)) return;

    if (await isValidJsonFile(CREDS_BACKUP)) {
      await atomicCopy(CREDS_BACKUP, CREDS_FILE);
      console.log('[WA] creds.json korup, dipulihkan dari backup.');
      return;
    }

    console.log('[WA] creds.json korup dan tidak ada backup. Reset session.');
    await this._clearAuthDir();
  }

  /**
   * Hapus ISI folder, bukan foldernya. Kalau auth_session adalah bind mount
   * Docker, menghapus foldernya sendiri gagal dengan EBUSY, dan itu penyebab
   * session "tidak mau terhapus" kalau dilakukan lewat fs.rm(authDir).
   */
  async _clearAuthDir() {
    await fsp.mkdir(AUTH_DIR, { recursive: true });
    const entries = await fsp.readdir(AUTH_DIR);
    await Promise.all(
      entries.map((name) =>
        fsp.rm(path.join(AUTH_DIR, name), { recursive: true, force: true })
      )
    );
  }

  // -------------------------------------------------------------------------
  // Public getters
  // -------------------------------------------------------------------------
  getStatus() {
    return {
      status: this.status,
      hasQr: !!this.qr,
      reconnectAttempts: this.reconnectAttempts,
      lastDisconnect: this.lastDisconnect,
    };
  }

  getQr() {
    return this.qr;
  }

  isConnected() {
    return this.status === 'connected' && !!this.sock;
  }

  // -------------------------------------------------------------------------
  // Messaging
  // -------------------------------------------------------------------------
  /**
   * Normalisasi nomor HP atau Group ID ke format JID WhatsApp.
   * Terima: 08123456789, 628123456789, +628123456789,
   *         1234567890-123456789@g.us, atau JID lengkap.
   */
  normalizeJid(numberOrJid) {
    const input = String(numberOrJid).trim();
    if (input.includes('@')) return input;

    let digits = input.replace(/[^0-9]/g, '');
    if (digits.startsWith('0')) digits = '62' + digits.slice(1);

    return `${digits}@s.whatsapp.net`;
  }

  async sendTextMessage(numberOrJid, text) {
    if (!this.isConnected()) {
      throw new Error('WhatsApp belum terhubung. Scan QR terlebih dahulu.');
    }

    const jid = this.normalizeJid(numberOrJid);
    const result = await withTimeout(
      this.sock.sendMessage(jid, { text }),
      SEND_TIMEOUT_MS,
      'Timeout saat mengirim pesan'
    );

    this._cacheMessage(result);
    return result;
  }

  _cacheMessage(result) {
    const id = result?.key?.id;
    if (!id || !result.message) return;
    this.messageCache.set(id, result.message);
    if (this.messageCache.size > MESSAGE_CACHE_SIZE) {
      this.messageCache.delete(this.messageCache.keys().next().value);
    }
  }

  /**
   * Ambil daftar semua grup. Di-cache 60 detik karena groupFetchAllParticipating
   * itu berat dan kalau dipanggil terlalu sering bisa kena rate limit WhatsApp.
   */
  async getGroups() {
    if (!this.isConnected()) {
      throw new Error('WhatsApp belum terhubung.');
    }

    const now = Date.now();
    if (this.groupsCache.data && now - this.groupsCache.at < GROUPS_CACHE_MS) {
      return this.groupsCache.data;
    }

    const raw = await withTimeout(
      this.sock.groupFetchAllParticipating(),
      30_000,
      'Timeout saat mengambil daftar grup'
    );

    const data = Object.values(raw)
      .map((g) => ({
        id: g.id,
        name: g.subject || '(tanpa nama)',
        participantCount: g.participants?.length || 0,
        description: g.desc || '',
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'id'));

    this.groupsCache = { at: now, data };
    return data;
  }
}

module.exports = new WhatsAppService();
