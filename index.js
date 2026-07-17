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
const express = require('express');

const app = express();
app.use(express.json());

// ==========================================
// 1. DATABASE & SESSION PERSISTENCE
// ==========================================
mongoose.connect(process.env.MONGODB_URI).then(() => console.log('🟢 MongoDB Connected'));

// We create a Schema to store the WhatsApp login keys so Render doesn't delete them
const SessionSchema = new mongoose.Schema({ id: String, data: String });
const Session = mongoose.model('Session', SessionSchema);

const Vendor = mongoose.model('Vendor', new mongoose.Schema({
  phoneNumber: { type: String, required: true, unique: true },
  businessName: String, onboardingStep: { type: String, default: 'none' },
  isApproved: { type: Boolean, default: false }
}));

// ==========================================
// 2. WHATSAPP ENGINE (DATABASE-DRIVEN)
// ==========================================
async function startWhatsAppBot() {
  // We use useMultiFileAuthState but we'll manually ensure it survives
  const { state, saveCreds } = await useMultiFileAuthState('auth_session');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    logger: pino({ level: 'silent' }),
    browser: ['Ubuntu', 'Chrome', '114.0.0'],
    syncFullHistory: false, // STOP THE 515 ERROR: Tell WA not to send old chats
    markOnlineOnConnect: true,
  });

  // Save credentials whenever they change
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !sock.authState.creds.registered) {
      const pairingNumber = process.env.PAIRING_NUMBER;
      if (pairingNumber) {
        await delay(5000);
        try {
          const code = await sock.requestPairingCode(pairingNumber.replace(/[^0-9]/g, ''));
          console.log(`🔑 PAIRING CODE: ${code}`);
        } catch (e) { console.log("Waiting for stable connection..."); }
      }
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log(`🔴 Connection Closed (${code}).`);
      
      // If it's a temporary error, restart. 
      // If it's a 401 (Unauthorized), it means the session is dead.
      if (code !== DisconnectReason.loggedOut) {
        setTimeout(startWhatsAppBot, 5000);
      }
    } else if (connection === 'open') {
      console.log('🟢 AGENT IS LIVE AND SCANNING FOR MESSAGES!');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = jidNormalizedUser(msg.key.remoteJid);
    const text = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || "").toLowerCase().trim();

    // THIS IS THE FIX: This log proves the bot is "hearing" you
    console.log(`📩 RECEIVED FROM [${sender}]: ${text}`);

    const vendor = await Vendor.findOne({ phoneNumber: sender });

    if (vendor && vendor.onboardingStep !== 'none') {
        return handleOnboarding(sock, sender, text, vendor);
    }

    if (text.includes("i want to register")) {
      await Vendor.findOneAndUpdate({ phoneNumber: sender }, { onboardingStep: 'askName' }, { upsert: true });
      await sock.sendMessage(sender, { text: "👋 I hear you! Let's get started. What is your *Business Name*?" });
    }
  });
}

async function handleOnboarding(sock, sender, input, vendor) {
    if (vendor.onboardingStep === 'askName') {
        vendor.businessName = input;
        vendor.onboardingStep = 'completed';
        vendor.isApproved = true;
        await vendor.save();
        await sock.sendMessage(sender, { text: `✅ Thank you ${input}! Your registration is being processed.` });
    }
}

startWhatsAppBot();
app.listen(process.env.PORT || 10000);
