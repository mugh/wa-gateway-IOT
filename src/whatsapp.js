const {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} = require('baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const path = require('path');

const AUTH_DIR = path.join(__dirname, '..', 'auth_session');

const logger = pino({ level: 'silent' });

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
    const { version } = await fetchLatestBaileysVersion();

    this.status = 'connecting';

    this.sock = makeWASocket({
      version,
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: [process.env.DEVICE_NAME || 'WA Gateway', 'Chrome', '1.0.0'],
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
    // Sudah JID lengkap (personal atau grup)
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

    // groupFetchAllParticipating() return object { [jid]: GroupMetadata }
    const raw = await this.sock.groupFetchAllParticipating();

    return Object.values(raw)
      .map(g => ({
        id: g.id,                           // contoh: 628xxx-1234567890@g.us
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
