// Patch whatsapp DULU sebelum apapun di-require
const Module = require('module');
const orig = Module._load;
Module._load = function(r, parent, ...a) {
  if (parent && r === './whatsapp') return {
    start: () => Promise.resolve(),
    getStatus: () => ({ status: 'connected' }),
    getQr: () => null,
    isConnected: () => true,
    sendTextMessage: () => Promise.resolve({ key: { id: 'fakeid' } }),
    logout: () => Promise.resolve(),
  };
  return orig.call(this, r, parent, ...a);
};

// Set env sebelum dotenv di-load oleh server
process.env.LOGIN_PASSWORD  = 'testpass123';
process.env.API_KEY         = 'testapikey123';
process.env.SESSION_SECRET  = 'testsecretxyz';
process.env.PORT            = '3001';
process.env.DEVICE_NAME     = 'Test';

// Patch dotenv agar tidak override env yang sudah di-set
const dotenv = require('dotenv');
const origConfig = dotenv.config;
dotenv.config = () => ({});

require('./src/server');
