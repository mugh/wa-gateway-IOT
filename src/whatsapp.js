const {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
} = require('baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const path = require('path');

const AUTH_DIR = path.join(__dirname, '..', 'auth_session');

const logger = pino({ level: 'silent' });

// Fallback: versi WA Web minimum yang diketahui masih diterima WhatsApp.
// Update angka ini kalau suatu saat masih ditolak lagi (cek issue di
// github.com/WhiskeySockets/Baileys atau proyek sejenis untuk versi terbaru).
const MIN_WA_VERSION = [2, 3000, 1044015310];

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

class WhatsAppService {
  constructor() {
    this.sock = null;
    this.qr = null;
    this.status = 'disconnected'; // disconnected | connecting | qr | connected
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
  }

  async start() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const version = await resolveWaVersion();

    this.status = 'connecting';

    this.sock = makeWASocket({
      version,
      auth: state,
      logger,
      printQRInTerminal: false,
      // Platform.WEB mulai ditolak WhatsApp (Feb 2026+), jadi pakai jalur Android
      // supaya client mengaku sebagai Platform.ANDROID, bukan Platform.WEB.
      browser: Browsers.android(process.env.DEVICE_NAME || 'WA Gateway'),
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.qr = qr;
        this.status = 'qr';
      }

      if (connection === 'open') {
        this.qr = null;
        this.status = 'connected';
        this.reconnectAttempts = 0;
        console.log('[WA] Terhubung ke WhatsApp.');
      }

      if (connection === 'close') {
        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;

        this.status = 'disconnected';
        this.qr = null;

        if (loggedOut) {
          console.log('[WA] Logged out. Hapus folder auth_session dan scan ulang.');
        } else if (this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts += 1;
          console.log(`[WA] Koneksi putus, reconnect attempt ${this.reconnectAttempts}...`);
          setTimeout(() => this.start(), 2000 * this.reconnectAttempts);
        } else {
          console.log('[WA] Gagal reconnect setelah beberapa percobaan. Restart manual diperlukan.');
        }
      }
    });

    return this.sock;
  }

  getStatus() {
    return {
      status: this.status,
      hasQr: !!this.qr,
    };
  }

  getQr() {
    return this.qr;
  }

  isConnected() {
    return this.status === 'connected' && this.sock;
  }

  /**
   * Normalisasi nomor HP atau Group ID ke format JID WhatsApp.
   * Terima: 08123456789, 628123456789, +628123456789,
   *         1234567890-123456789@g.us, atau JID lengkap.
   */
  normalizeJid(numberOrJid) {
    if (numberOrJid.includes('@')) return numberOrJid;

    let digits = numberOrJid.replace(/[^0-9]/g, '');

    if (digits.startsWith('0')) {
      digits = '62' + digits.slice(1);
    }

    return `${digits}@s.whatsapp.net`;
  }

  async sendTextMessage(numberOrJid, text) {
    if (!this.isConnected()) {
      throw new Error('WhatsApp belum terhubung. Scan QR terlebih dahulu.');
    }

    const jid = this.normalizeJid(numberOrJid);
    const result = await this.sock.sendMessage(jid, { text });
    return result;
  }

  /**
   * Ambil daftar semua grup yang diikuti nomor ini.
   * Return array of { id, name, participantCount, description }
   */
  async getGroups() {
    if (!this.isConnected()) {
      throw new Error('WhatsApp belum terhubung.');
    }

    const raw = await this.sock.groupFetchAllParticipating();

    return Object.values(raw)
      .map(g => ({
        id: g.id,
        name: g.subject || '(tanpa nama)',
        participantCount: g.participants?.length || 0,
        description: g.desc || '',
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'id'));
  }

  async logout() {
    if (this.sock) {
      try {
        await this.sock.logout();
      } catch (e) {
        // ignore
      }
    }
    this.status = 'disconnected';
    this.qr = null;
  }
}

module.exports = new WhatsAppService();const {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
} = require('baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const path = require('path');

const AUTH_DIR = path.join(__dirname, '..', 'auth_session');

const logger = pino({ level: 'silent' });

// Fallback: versi WA Web minimum yang diketahui masih diterima WhatsApp.
// Update angka ini kalau suatu saat masih ditolak lagi (cek issue di
// github.com/WhiskeySockets/Baileys atau proyek sejenis untuk versi terbaru).
const MIN_WA_VERSION = [2, 3000, 1044015310];

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

class WhatsAppService {
  constructor() {
    this.sock = null;
    this.qr = null;
    this.status = 'disconnected'; // disconnected | connecting | qr | connected
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
  }

  async start() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const version = await resolveWaVersion();

    this.status = 'connecting';

    this.sock = makeWASocket({
      version,
      auth: state,
      logger,
      printQRInTerminal: false,
      // Platform.WEB mulai ditolak WhatsApp (Feb 2026+), jadi pakai jalur Android
      // supaya client mengaku sebagai Platform.ANDROID, bukan Platform.WEB.
      browser: Browsers.android(process.env.DEVICE_NAME || 'WA Gateway'),
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.qr = qr;
        this.status = 'qr';
      }

      if (connection === 'open') {
        this.qr = null;
        this.status = 'connected';
        this.reconnectAttempts = 0;
        console.log('[WA] Terhubung ke WhatsApp.');
      }

      if (connection === 'close') {
        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;

        this.status = 'disconnected';
        this.qr = null;

        if (loggedOut) {
          console.log('[WA] Logged out. Hapus folder auth_session dan scan ulang.');
        } else if (this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts += 1;
          console.log(`[WA] Koneksi putus, reconnect attempt ${this.reconnectAttempts}...`);
          setTimeout(() => this.start(), 2000 * this.reconnectAttempts);
        } else {
          console.log('[WA] Gagal reconnect setelah beberapa percobaan. Restart manual diperlukan.');
        }
      }
    });

    return this.sock;
  }

  getStatus() {
    return {
      status: this.status,
      hasQr: !!this.qr,
    };
  }

  getQr() {
    return this.qr;
  }

  isConnected() {
    return this.status === 'connected' && this.sock;
  }

  /**
   * Normalisasi nomor HP atau Group ID ke format JID WhatsApp.
   * Terima: 08123456789, 628123456789, +628123456789,
   *         1234567890-123456789@g.us, atau JID lengkap.
   */
  normalizeJid(numberOrJid) {
    if (numberOrJid.includes('@')) return numberOrJid;

    let digits = numberOrJid.replace(/[^0-9]/g, '');

    if (digits.startsWith('0')) {
      digits = '62' + digits.slice(1);
    }

    return `${digits}@s.whatsapp.net`;
  }

  async sendTextMessage(numberOrJid, text) {
    if (!this.isConnected()) {
      throw new Error('WhatsApp belum terhubung. Scan QR terlebih dahulu.');
    }

    const jid = this.normalizeJid(numberOrJid);
    const result = await this.sock.sendMessage(jid, { text });
    return result;
  }

  /**
   * Ambil daftar semua grup yang diikuti nomor ini.
   * Return array of { id, name, participantCount, description }
   */
  async getGroups() {
    if (!this.isConnected()) {
      throw new Error('WhatsApp belum terhubung.');
    }

    const raw = await this.sock.groupFetchAllParticipating();

    return Object.values(raw)
      .map(g => ({
        id: g.id,
        name: g.subject || '(tanpa nama)',
        participantCount: g.participants?.length || 0,
        description: g.desc || '',
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'id'));
  }

  async logout() {
    if (this.sock) {
      try {
        await this.sock.logout();
      } catch (e) {
        // ignore
      }
    }
    this.status = 'disconnected';
    this.qr = null;
  }
}

module.exports = new WhatsAppService();
