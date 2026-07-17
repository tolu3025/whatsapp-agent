require('dotenv').config();
const { 
  default: makeWASocket, 
  useMultiFileAuthState, 
  DisconnectReason, 
  delay,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  jidNormalizedUser,
  Browsers // Crucial for device identity
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
            const v = await Vendor.findOne({ phoneNumber: tx.vendor_id });
            try {
                await sock.sendMessage(tx.customer_jid, { 
                    text: `✅ *PAYMENT CONFIRMED!*\n\nAmount: ₦${tx.amount.toLocaleString()}\n\n*${v?.businessName || 'The Vendor'}* is processing your order! 🚚` 
                });
            } catch (e) {}
        }
    }).subscribe();
};

// ==========================================
// 3. WHATSAPP ENGINE (DEVICE IDENTITY FIX)
// ==========================================
async function startWhatsAppBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_session');
  
  // Dynamic version fetching with fallback
  let version;
  try {
    const { version: latest } = await fetchLatestBaileysVersion();
    version = latest;
  } catch (e) {
    version = [2, 3000, 1015901307]; // Stable high-version fallback
  }

  sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    // FIX: The browser MUST look like a desktop "Web" device for pairing codes
    browser: Browsers.macOS('Chrome'), 
    
    syncFullHistory: false, 
    fireInitQueries: false,
    shouldSyncHistoryMessage: () => false, 
    
    // Pairing-specific timeouts
    connectTimeoutMs: 120000, 
    defaultQueryTimeoutMs: 0, 
    keepAliveIntervalMs: 10000,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // --- PAIRING CODE LOGIC (GUARDED) ---
    if (!sock.authState.creds.registered && !hasRequestedCode) {
        hasRequestedCode = true;
        const pairingNumber = process.env.PAIRING_NUMBER;
        if (pairingNumber) {
            // We wait 12s to ensure the socket has completed the encryption handshake
            // before asking for the pairing code.
            console.log(`⏳ Authenticating device for ${pairingNumber}...`);
            await delay(12000); 
            try {
                const code = await sock.requestPairingCode(pairingNumber.replace(/[^0-9]/g, ''));
                console.log(`🔑 YOUR PAIRING CODE: ${code}`);
            } catch (e) {
                console.error("❌ Link Request Denied:", e.message);
                hasRequestedCode = false; 
            }
        }
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      hasRequestedCode = false;
      
      // Force wipe on auth errors to prevent the "Loading" hang
      if (code === 401 || code === 405 || code === DisconnectReason.loggedOut) {
        if (fs.existsSync('./auth_session')) fs.rmSync('./auth_session', { recursive: true, force: true });
        setTimeout(startWhatsAppBot, 5000);
      } else {
        setTimeout(startWhatsAppBot, 10000);
      }
    } else if (connection === 'open') {
      console.log('🟢 SUCCESS: Device Recognized & Agent Online!');
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

    const liveVendor = await Vendor.findOne({ isLive: true }); 
    if (liveVendor && !registrationState.has(sender) && !['register', 'onboard'].includes(cleanInput)) {
        return handleSalesAI(sender, text, liveVendor);
    }
    if (registrationState.has(sender) || ['register', 'onboard'].includes(cleanInput)) {
        return handleVendorOnboarding(sender, msg);
    }
  });
}

// ==========================================
// 4. SALES AGENT LOGIC
// ==========================================
async function handleSalesAI(customerJid, text, vendor) {
    const input = text.toLowerCase();
    if (input.includes('price') || input.includes('catalog')) {
        const items = vendor.catalog.map(i => `🛍️ *${i.caption}*\n💰 ₦${i.price.toLocaleString()}\n`).join('\n');
        await sock.sendMessage(customerJid, { text: `Omo! You have great taste! 😍 Here is our catalog for *${vendor.businessName}*:\n\n${items}` });
    } else if (input.includes('buy') || input.match(/\d+/)) {
        try {
            const res = await axios.post('https://api.flutterwave.com/v3/payments', {
                tx_ref: `KUKA-${Date.now()}`, amount: "5000", currency: "NGN", 
                customer: { email: "customer@kuka.ai" }, customizations: { title: vendor.businessName }
            }, { headers: { Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}` } });
            await sock.sendMessage(customerJid, { text: `Pay securely here: ${res.data.data.link}\n\nI'll confirm automatically! ✅` });
        } catch (e) { await sock.sendMessage(customerJid, { text: "Link error. Try 'buy' again." }); }
    } else {
        await sock.sendMessage(customerJid, { text: `Hello! 😊 Welcome to *${vendor.businessName}*. Ask for our price list to see what we have!` });
    }
}

// ==========================================
// 5. ONBOARDING LOGIC
// ==========================================
async function handleVendorOnboarding(sender, msg) {
    if (!registrationState.has(sender)) {
        registrationState.set(sender, { step: 'name' });
        return sock.sendMessage(sender, { text: "Hello Vendor! 👋 What is your *Business Name*?" });
    }
    const state = registrationState.get(sender);
    const text = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || "").trim();

    switch (state.step) {
        case 'name': state.businessName = text; state.step = 'bank'; await sock.sendMessage(sender, { text: "What is your *Bank Name*?" }); break;
        case 'bank': state.bankName = text; state.step = 'account'; await sock.sendMessage(sender, { text: "Your *10-digit Account Number*?" }); break;
        case 'account':
            state.accountNumber = text; state.step = 'confirm';
            await sock.sendMessage(sender, { text: `Please confirm your bank name and account are correct, then reply 'Yes' to continue.` }); break;
        case 'confirm':
            if (text.toLowerCase() === 'yes') { state.step = 'desc'; await sock.sendMessage(sender, { text: "Give me a *Business Description*:" }); }
            else { state.step = 'bank'; await sock.sendMessage(sender, { text: "Let's try again. Bank Name?" }); } break;
        case 'desc': state.description = text; state.step = 'faq'; await sock.sendMessage(sender, { text: "Provide an *FAQ*:" }); break;
        case 'faq': state.faq = text; state.step = 'catalog'; state.catalog = []; await sock.sendMessage(sender, { text: "Final Task: *Send Catalog Photos*. Include the *Price* in the caption! Type *Done* when finished." }); break;
        case 'catalog':
            if (text.toLowerCase() === 'done') {
                const newVendor = new Vendor({ ...state, phoneNumber: sender, isLive: true });
                await newVendor.save(); registrationState.delete(sender);
                await sock.sendMessage(sender, { text: "🎉 *YOU ARE LIVE!* I am now your Sales Agent." });
            } else if (msg.message?.imageMessage) {
                const cap = msg.message.imageMessage.caption || "";
                state.catalog.push({ imageUrl: "received", caption: cap, price: parseInt(cap.match(/\d+/)?.[0]) || 0 });
                await sock.sendMessage(sender, { text: "✅ Added! Next photo or type *Done*." });
            } break;
    }
    registrationState.set(sender, state);
}

initSupabase(); 
startWhatsAppBot();
app.listen(process.env.PORT || 10000);
