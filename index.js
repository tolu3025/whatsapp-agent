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
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');
const fs = require('fs');
const express = require('express');

const app = express();
app.use(express.json());

// ==========================================
// 1. RENDER HEALTH CHECK (Keeps App Alive)
// ==========================================
const PORT = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('PA Agent Active'));
app.listen(PORT, () => console.log(`🚀 Server live on port ${PORT}`));

// ==========================================
// 2. SERVICES
// ==========================================
mongoose.connect(process.env.MONGODB_URI).then(() => console.log('🟢 MongoDB Connected'));
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ==========================================
// 3. WHATSAPP BOT (MAC OS CHROME IDENTITY)
// ==========================================
let pairingCodeActive = false;

async function startWhatsAppBot() {
  console.log('📡 Starting Secure Handshake...');

  // Use the absolute latest known stable version
  const version = [2, 3000, 1017578213]; 

  const { state, saveCreds } = await useMultiFileAuthState('auth_session');

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    logger: pino({ level: 'silent' }),
    
    // 🖥️ PERFECT MAC OS CHROME FINGERPRINT
    browser: ['Mac OS', 'Chrome', '126.0.6478.127'], 
    
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    connectTimeoutMs: 90000, // Longer timeout for Render
    defaultQueryTimeoutMs: 0,
    keepAliveIntervalMs: 5000, // Frequent pings to keep socket open
    emitOwnEvents: true,
    generateHighQualityLinkPreview: true,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !sock.authState.creds.registered && !pairingCodeActive) {
      pairingCodeActive = true;
      const pairingNumber = process.env.PAIRING_NUMBER;
      
      if (pairingNumber) {
        console.log(`⏳ Stabilizing socket for +${pairingNumber}...`);
        await delay(15000); // 15s delay to ensure the socket is 100% stable
        
        try {
          const code = await sock.requestPairingCode(pairingNumber.replace(/[^0-9]/g, ''));
          console.log(`🔑 ==========================================`);
          console.log(`🔑 YOUR PAIRING CODE: ${code}`);
          console.log(`🔑 ==========================================`);
        } catch (e) {
          console.error("🔴 Pairing request failed:", e.message);
          pairingCodeActive = false;
        }
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      pairingCodeActive = false;

      console.log(`🔴 Connection Lost (Code: ${statusCode})`);

      // Reset on fatal session errors
      if (statusCode === 401 || statusCode === 405) {
        console.log('🧹 Clearing session folder...');
        if (fs.existsSync('./auth_session')) {
          fs.rmSync('./auth_session', { recursive: true, force: true });
        }
        setTimeout(startWhatsAppBot, 5000);
      } else if (statusCode !== DisconnectReason.loggedOut) {
        setTimeout(startWhatsAppBot, 10000);
      }
    } else if (connection === 'open') {
      console.log('🟢 SUCCESS: AGENT CONNECTED AS MAC OS CHROME!');
      pairingCodeActive = false;
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = jidNormalizedUser(msg.key.remoteJid);
    const text = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || "").toLowerCase().trim();

    console.log(`📩 [${sender}]: ${text}`);

    if (text.includes("i want to register")) {
        await sock.sendMessage(sender, { text: "👋 I see you! Ready to set up your Vendor PA. What is your *Business Name*?" });
    }
  });
}

startWhatsAppBot();
