require('dotenv').config();
const { 
  default: makeWASocket, 
  useMultiFileAuthState, 
  DisconnectReason, 
  delay,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  jidNormalizedUser,
  Browse
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const mongoose = require('mongoose');
const axios = require('axios');
const express = require('express');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// ... (Database & Supabase setup remains exactly the same as your previous code) ...
mongoose.connect(process.env.MONGODB_URI).then(() => console.log('🟢 MongoDB Connected'));
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const Vendor = mongoose.model('Vendor', new mongoose.Schema({
  phoneNumber: { type: String, required: true, unique: true },
  businessName: String, 
  businessDescription: String,
  bankName: String,
  bankCode: String,
  accountNumber: String,
  accountName: String,
  faq: String,
  catalog: [{ imageUrl: String, caption: String, price: Number }],
  isLive: { type: Boolean, default: false }
}));

const registrationState = new Map();
let hasRequestedCode = false;

// ==========================================
// 2. WHATSAPP ENGINE (STABILITY & LINK FIX)
// ==========================================
async function startWhatsAppBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_session');
  const { version } = await fetchLatestBaileysVersion();
  
  console.log(`📡 Connecting with WA v${version.join('.')}`);

  const sock = makeWASocket({
    version,
    // Use fatal level to keep logs clean and reduce CPU usage during link
    logger: pino({ level: 'fatal' }), 
    auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' })),
    },
    // BROSWER FIX: "Chrome" identity helps with pairing stability
    browser: ["Ubuntu", "Chrome", "121.0.6167.160"],
    
    // --- ABSOLUTE STABILITY SETTINGS TO PREVENT 515 & PAIRING HANG ---
    printQRInTerminal: false,
    mobile: false, // Ensure we aren't identified as a mobile client
    keepAliveIntervalMs: 30000,
    connectTimeoutMs: 60000,
    msgRetryCounterCache: undefined, // Don't retry old messages
    maxMsgRetryCount: 1, 
    syncFullHistory: false, // DO NOT sync old chats
    fireInitQueries: false, // DO NOT fetch labels/contacts
    shouldSyncHistoryMessage: () => false, // DO NOT sync any history
    // -----------------------------------------------------------------

    // Add a placeholder to prevent crashes on message upsert
    getMessage: async (key) => { return { conversation: 'Message' } }
  });

  sock.ev.on('creds.update', saveCreds);

  // SUPABASE Transaction Listener (Kukapay)
  supabase.channel('public:transactions')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'transactions' }, async (payload) => {
        const tx = payload.new;
        if (tx.status === 'successful') {
            const vendor = await Vendor.findOne({ phoneNumber: tx.vendor_id });
            await sock.sendMessage(tx.customer_jid, { text: `✅ *PAYMENT CONFIRMED!*\n\nThank you for shopping with *${vendor?.businessName}*. Your order is now processing! 🚚` });
        }
    }).subscribe();

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Logic for Pairing Code
    if (!sock.authState.creds.registered && !hasRequestedCode) {
        hasRequestedCode = true;
        const pairingNumber = process.env.PAIRING_NUMBER;
        if (pairingNumber) {
            console.log(`⏳ Getting pairing code for ${pairingNumber}...`);
            await delay(10000); // 10 second delay allows socket to stabilize
            try {
                const code = await sock.requestPairingCode(pairingNumber.replace(/[^0-9]/g, ''));
                console.log(`🔑 YOUR PAIRING CODE: ${code}`);
            } catch (e) {
                console.error("❌ Pairing Error:", e.message);
                hasRequestedCode = false;
            }
        }
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log(`🔴 Connection closed (Reason: ${code})`);

      // If it's a stream error or timeout, restart immediately
      if (code === 515 || code === 408 || code === DisconnectReason.connectionLost) {
        setTimeout(startWhatsAppBot, 5000);
      } 
      // If linking was rejected, clear session
      else if (code === 401 || code === DisconnectReason.loggedOut) {
        console.log("🧹 Clearing session and retrying...");
        if (fs.existsSync('./auth_session')) fs.rmSync('./auth_session', { recursive: true, force: true });
        hasRequestedCode = false;
        setTimeout(startWhatsAppBot, 5000);
      } else {
        setTimeout(startWhatsAppBot, 10000);
      }
    } else if (connection === 'open') {
      console.log('🟢 SUCCESS: AI Sales Agent is Linked and Online!');
      hasRequestedCode = false;
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = jidNormalizedUser(msg.key.remoteJid);
    const text = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || "").trim();
    const cleanInput = text.toLowerCase();

    // Check if Live Vendor for AI Sales Mode
    const liveVendor = await Vendor.findOne({ isLive: true }); 
    if (liveVendor && !registrationState.has(sender) && !['register', 'onboard'].includes(cleanInput)) {
        return handleSalesAI(sock, sender, text, liveVendor);
    }

    // Onboarding Mode
    if (registrationState.has(sender) || ['register', 'onboard'].includes(cleanInput)) {
        return handleVendorOnboarding(sock, sender, msg);
    }
  });
}

// ... (handleSalesAI and handleVendorOnboarding remain exactly the same) ...

startWhatsAppBot();
app.listen(process.env.PORT || 10000);
