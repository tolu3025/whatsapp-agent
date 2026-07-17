require('dotenv').config();

const { 
  default: makeWASocket, 
  DisconnectReason, 
  initAuthCreds,       
  proto,
  Browsers 
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const mongoose = require('mongoose');
const express = require('express');
const app = express();

// ==========================================
// 1. MONGODB AUTH STORAGE
// ==========================================
mongoose.connect(process.env.MONGODB_URI);
const AuthStateSchema = new mongoose.Schema({ _id: String, data: String });
const AuthState = mongoose.model('AuthState', AuthStateSchema);

async function useMongoAuthState() {
  const writeData = async (data, id) => {
    await AuthState.replaceOne({ _id: id }, { data: JSON.stringify(data) }, { upsert: true });
  };
  const readData = async (id) => {
    const doc = await AuthState.findById(id);
    return doc ? JSON.parse(doc.data) : null;
  };
  const creds = (await readData('creds')) || initAuthCreds();
  return {
    state: { creds, keys: { get: async () => ({}), set: async () => {} } },
    saveCreds: async () => { await writeData(creds, 'creds'); }
  };
}

// ==========================================
// 2. WHATSAPP BOT ENGINE
// ==========================================
let hasRequestedCode = false;

async function startWhatsAppBot() {
  console.log('🚀 Initializing WhatsApp connection...');
  const { state, saveCreds } = await useMongoAuthState();
  
  const sock = makeWASocket({
    // Using a known stable protocol version
    version: [2, 3000, 1034074495], 
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: Browsers.macOS('Chrome'),
    // THIS CONFIGURATION IS VITAL FOR RENDER 405 ERRORS
    generateHighQualityLinkPreview: true,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 30000
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !hasRequestedCode) {
      hasRequestedCode = true; 
      const code = await sock.requestPairingCode(process.env.PAIRING_NUMBER.replace(/[^0-9]/g, ''));
      console.log(`🔑 ================================================`);
      console.log(`🔑 ENTER THIS WHATSAPP PAIRING CODE: ${code}`);
      console.log(`🔑 ================================================`);
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log(`🔴 Connection closed. Code: ${statusCode}`);
      hasRequestedCode = false;
      
      // If 405 or 401, clear credentials to force a clean re-handshake
      if (statusCode === 405 || statusCode === 401) {
        await AuthState.deleteMany({});
      }
      setTimeout(startWhatsAppBot, 10000); // Increased wait time for cloud stability
    } else if (connection === 'open') {
      console.log('🟢 WhatsApp Connection Opened!');
    }
  });
}

startWhatsAppBot();
app.listen(process.env.PORT || 3000);
