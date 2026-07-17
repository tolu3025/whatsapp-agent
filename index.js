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
const axios = require('axios');
const express = require('express');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// ==========================================
// 1. DATABASE & SUPABASE
// ==========================================
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
let sock; 

// ==========================================
// 2. KUKAPAY REALTIME LISTENER
// ==========================================
const initSupabase = () => {
    const channel = supabase.channel('public:transactions');
    channel.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'transactions' }, async (payload) => {
        const tx = payload.new;
        if (tx.status === 'successful' && sock && sock.authState.creds.registered) {
            const vendor = await Vendor.findOne({ phoneNumber: tx.vendor_id });
            try {
                await sock.sendMessage(tx.customer_jid, { 
                    text: `✅ *PAYMENT CONFIRMED!*\n\nReference: ${tx.tx_ref}\nAmount: ₦${tx.amount}\n\n*${vendor?.businessName || 'The Vendor'}* has received your payment. Order is processing! 🚚` 
                });
            } catch (e) { console.log("Supabase msg fail"); }
        }
    }).subscribe();
};

// ==========================================
// 3. WHATSAPP ENGINE (LINKING RE-OPTIMIZED)
// ==========================================
async function startWhatsAppBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_session');
  const { version } = await fetchLatestBaileysVersion();
  
  const logger = pino({ level: 'silent' });

  sock = makeWASocket({
    version,
    logger,
    auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    browser: ["Ubuntu", "Chrome", "121.0.6167.160"],
    
    // --- AGGRESSIVE SILENCE FLAGS ---
    printQRInTerminal: false,
    mobile: false,
    markOnlineOnConnect: false, // Don't announce presence during link
    syncFullHistory: false, 
    fireInitQueries: false,
    shouldSyncHistoryMessage: () => false, 
    
    // TIMEOUTS: Extended to allow the phone to finish linking
    connectTimeoutMs: 120000, 
    defaultQueryTimeoutMs: 0, 
    keepAliveIntervalMs: 30000,
    
    // REDUCE DATA USAGE: Prevents the bot from requesting any old message data
    getMessage: async () => { return { conversation: ' ' } }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Pairing Logic
    if (!sock.authState.creds.registered && !hasRequestedCode) {
        hasRequestedCode = true;
        const pairingNumber = process.env.PAIRING_NUMBER;
        if (pairingNumber) {
            console.log(`⏳ Stabilizing socket for ${pairingNumber}...`);
            await delay(15000); // Wait 15s to ensure the network pipe is quiet
            try {
                const code = await sock.requestPairingCode(pairingNumber.replace(/[^0-9]/g, ''));
                console.log(`🔑 YOUR PAIRING CODE: ${code}`);
            } catch (e) {
                hasRequestedCode = false; 
            }
        }
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log(`🔴 Link Broken. Reason: ${code}`);
      hasRequestedCode = false;

      if (code === 401 || code === 405 || code === 408 || code === DisconnectReason.loggedOut) {
        console.log("🧹 Wiping auth_session to fix the loading hang...");
        if (fs.existsSync('./auth_session')) fs.rmSync('./auth_session', { recursive: true, force: true });
        setTimeout(startWhatsAppBot, 5000);
      } else {
        setTimeout(startWhatsAppBot, 10000);
      }
    } else if (connection === 'open') {
      console.log('🟢 SUCCESS: Sales Agent Linked and Live!');
      hasRequestedCode = false;
      await sock.sendPresenceUpdate('available'); // Now we can go online
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = jidNormalizedUser(msg.key.remoteJid);
    const text = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || "").trim();
    const cleanInput = text.toLowerCase();

    const liveVendor = await Vendor.findOne({ isLive: true }); 
    if (liveVendor && !registrationState.has(sender) && !['register', 'onboard'].includes(cleanInput)) {
        return handleSalesAI(sender, text, liveVendor);
    }
    if (registrationState.has(sender) || ['register', 'onboard'].includes(cleanInput)) {
        return handleVendorOnboarding(sender, msg);
    }
  });
}

// ... (handleSalesAI and handleVendorOnboarding remain exactly the same) ...

initSupabase(); 
startWhatsAppBot();
app.listen(process.env.PORT || 10000);
