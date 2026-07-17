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
// 1. RENDER HEALTH CHECK
// ==========================================
const PORT = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('Kukatai PA Online'));
app.listen(PORT, () => console.log(`🚀 Server live on port ${PORT}`));

// ==========================================
// 2. SERVICES
// ==========================================
mongoose.connect(process.env.MONGODB_URI).then(() => console.log('🟢 MongoDB Connected'));
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ==========================================
// 3. WHATSAPP BOT (LOOP-BREAKER VERSION)
// ==========================================
let isPairingRequested = false;

async function startWhatsAppBot() {
  console.log('📡 Fetching latest WhatsApp protocol...');
  
  // DYNAMIC VERSION FETCHING (Prevents 405)
  let version = [2, 3000, 1015901307]; // Safe fallback
  try {
    const { version: latest } = await fetchLatestBaileysVersion();
    version = latest;
    console.log(`✅ Using WA Version: ${version.join('.')}`);
  } catch (e) {
    console.log('⚠️ Version fetch failed, using fallback.');
  }

  const { state, saveCreds } = await useMultiFileAuthState('auth_session');

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    logger: pino({ level: 'silent' }),
    
    // WINDOWS CHROME FINGERPRINT (More stable for linking)
    browser: ['Windows', 'Chrome', '110.0.5481.178'], 
    
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 30000,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !sock.authState.creds.registered && !isPairingRequested) {
      isPairingRequested = true;
      const pairingNumber = process.env.PAIRING_NUMBER;
      
      if (pairingNumber) {
        console.log(`⏳ Stabilizing connection for ${pairingNumber}...`);
        await delay(20000); // 20-second delay to ensure socket is ready
        
        try {
          const code = await sock.requestPairingCode(pairingNumber.replace(/[^0-9]/g, ''));
          console.log(`🔑 ==========================================`);
          console.log(`🔑 NEW PAIRING CODE: ${code}`);
          console.log(`🔑 ==========================================`);
        } catch (e) {
          console.error("🔴 Pairing request failed. Will retry...");
          isPairingRequested = false;
        }
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      isPairingRequested = false;

      // Only wipe if it's a truly fatal session error
      if (statusCode === 401) {
        console.log('🧹 Session expired/logged out. Wiping...');
        if (fs.existsSync('./auth_session')) {
          fs.rmSync('./auth_session', { recursive: true, force: true });
        }
        setTimeout(startWhatsAppBot, 10000);
      } 
      else if (statusCode === 405) {
        console.log('⚠️ WhatsApp rejected version (405). Retrying with delay...');
        setTimeout(startWhatsAppBot, 20000); // Wait longer to avoid IP flagging
      }
      else if (statusCode !== DisconnectReason.loggedOut) {
        console.log(`🔄 Reconnecting (Status: ${statusCode})...`);
        setTimeout(startWhatsAppBot, 10000);
      }
    } else if (connection === 'open') {
      console.log('🟢 SUCCESS: AGENT IS ONLINE!');
      isPairingRequested = false;
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
        await sock.sendMessage(sender, { text: "👋 I'm online! I've detected your registration request. What is your *Business Name*?" });
    }
  });
}

startWhatsAppBot();
