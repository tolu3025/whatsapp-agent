require('dotenv').config();

const { 
  default: makeWASocket, 
  DisconnectReason, 
  delay,
  fetchLatestBaileysVersion,
  BufferJSON,         
  initAuthCreds,       
  proto,
  Browsers 
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const mongoose = require('mongoose');
const axios = require('axios');
const express = require('express');

const app = express();
app.use(express.json());

// ==========================================
// 1. MONGODB AUTH STORAGE
// ==========================================
mongoose.connect(process.env.MONGODB_URI);
const AuthStateSchema = new mongoose.Schema({ _id: String, data: String });
const AuthState = mongoose.model('AuthState', AuthStateSchema);

async function useMongoAuthState() {
  const writeData = async (data, id) => {
    const serialized = JSON.stringify(data, BufferJSON.replacer);
    await AuthState.replaceOne({ _id: id }, { data: serialized }, { upsert: true });
  };
  const readData = async (id) => {
    const doc = await AuthState.findById(id);
    if (!doc) return null;
    return JSON.parse(doc.data, BufferJSON.reviver);
  };
  const creds = (await readData('creds')) || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(ids.map(async (id) => { data[id] = await readData(`${type}-${id}`); }));
          return data;
        },
        set: async (data) => {
          for (const cat of Object.keys(data)) {
            for (const id of Object.keys(data[cat])) {
              await writeData(data[cat][id], `${cat}-${id}`);
            }
          }
        }
      }
    },
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
    // FORCING STABLE VERSION TO PREVENT 405 ERRORS
    version: [2, 3000, 1017578213], 
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: Browsers.macOS('Chrome'), 
    name: 'kukatai-agent',
    patchMessageBeforeSending: (msg) => {
      const needsPatch = !!(msg.buttonsMessage || msg.templateMessage || msg.listMessage);
      return needsPatch ? { viewOnceMessage: { message: { messageContextInfo: { deviceListMetadataVersion: 2, deviceListMetadata: {} }, ...msg } } } : msg;
    },
    defaultQueryTimeoutMs: 60000,
    connectTimeoutMs: 60000
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !sock.authState.creds.registered && !hasRequestedCode) {
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

      // Handle 401/405 by resetting session to get a fresh handshake
      if (statusCode === 401 || statusCode === 405) {
        await AuthState.deleteMany({});
      }
      setTimeout(startWhatsAppBot, 5000);
    } else if (connection === 'open') {
      console.log('🟢 WhatsApp Connection Opened!');
      hasRequestedCode = false;
    }
  });
}

startWhatsAppBot();
app.listen(process.env.PORT || 3000);
