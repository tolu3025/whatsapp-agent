require('dotenv').config();
const { 
  default: makeWASocket, 
  useMultiFileAuthState, 
  DisconnectReason, 
  delay,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  jidNormalizedUser 
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const mongoose = require('mongoose');
const fs = require('fs');
const express = require('express');

const app = express();
app.use(express.json());

// ==========================================
// 1. RENDER HEALTH CHECK
// ==========================================
const PORT = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('Kukatai PA Active'));
app.listen(PORT, () => console.log(`🚀 Health check live on port ${PORT}`));

// ==========================================
// 2. DATABASE
// ==========================================
mongoose.connect(process.env.MONGODB_URI).then(() => console.log('🟢 MongoDB Connected'));

// ==========================================
// 3. WHATSAPP ENGINE (DEFINITIVE 405 FIX)
// ==========================================
async function startWhatsAppBot() {
  console.log('📡 Requesting WhatsApp Protocol Version...');

  // 405 FIX: WhatsApp recently deprecated version 1027934701.
  // We use the latest known working protocol version statically to avoid library defaults.
  const version = [2, 3000, 1034074495]; 
  console.log(`✅ Forcing Stable Version: ${version.join('.')}`);

  const { state, saveCreds } = await useMultiFileAuthState('auth_session');

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    logger: pino({ level: 'silent' }),
    
    // 🖥️ TRUSTED IDENTITY: Windows/Chrome is currently more stable for Cloud IPs like Render
    browser: ['Windows', 'Chrome', '126.0.6478.127'], 
    
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 0,
    keepAliveIntervalMs: 15000,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !sock.authState.creds.registered) {
      console.log('⏳ Handshake stable. Requesting Pairing Code...');
      await delay(10000); // Wait for socket stabilization
      try {
        const code = await sock.requestPairingCode(process.env.PAIRING_NUMBER.replace(/[^0-9]/g, ''));
        console.log(`🔑 PAIRING CODE: ${code}`);
      } catch (e) { console.error("Pairing Error", e.message); }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log(`🔴 Connection Lost (Code: ${statusCode})`);

      // DEFINITIVE 405/401 RECOVERY: Wipe session and restart
      if (statusCode === 405 || statusCode === 401) {
        console.log('🧹 Protocol Mismatch/Bad Session. Clearing auth_session and restarting...');
        if (fs.existsSync('./auth_session')) {
          fs.rmSync('./auth_session', { recursive: true, force: true });
        }
        setTimeout(startWhatsAppBot, 10000); // 10s wait before retry to avoid IP lockout
      } 
      else if (statusCode !== DisconnectReason.loggedOut) {
        setTimeout(startWhatsAppBot, 10000);
      }
    } else if (connection === 'open') {
      console.log('🟢 SUCCESS: AGENT IS LIVE');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = jidNormalizedUser(msg.key.remoteJid);
    const text = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || "").toLowerCase();
    console.log(`📩 [${sender}]: ${text}`);

    if (text.includes("i want to register")) {
      await sock.sendMessage(sender, { text: "👋 I see you! Ready to onboard. What is your *Business Name*?" });
    }
  });
}

startWhatsAppBot();
