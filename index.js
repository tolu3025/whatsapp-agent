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
                    text: `✅ *PAYMENT CONFIRMED!*\n\nHello! I've received your payment of *₦${tx.amount.toLocaleString()}*.\n\n*${v?.businessName || 'The Vendor'}* is now processing your order! 🚚✨` 
                });
            } catch (e) { console.log("Supabase msg fail"); }
        }
    }).subscribe();
};

// ==========================================
// 3. WHATSAPP ENGINE (PAIRING HANDSHAKE FIX)
// ==========================================
async function startWhatsAppBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_session');
  
  // Use a hardcoded recent version to prevent fetch-delays on Render
  const version = [2, 3000, 1015901307]; 

  sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    // FIX: Exact Browser Array for Device Recognition
    browser: ["Windows", "Chrome", "110.0.5481.178"], 
    
    syncFullHistory: false, 
    fireInitQueries: false,
    shouldSyncHistoryMessage: () => false, 
    
    // Pairing Stability
    connectTimeoutMs: 120000, 
    defaultQueryTimeoutMs: 90000, 
    keepAliveIntervalMs: 15000,
    generateHighQualityLinkPreview: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // --- SECURE PAIRING HANDSHAKE ---
    if (!sock.authState.creds.registered && !hasRequestedCode) {
        hasRequestedCode = true;
        const pairingNumber = process.env.PAIRING_NUMBER;
        
        if (pairingNumber) {
            console.log(`⏳ Initializing Device Identity for ${pairingNumber}...`);
            
            // Allow the socket to complete the internal crypto handshake
            await delay(10000); 
            
            try {
                const code = await sock.requestPairingCode(pairingNumber.replace(/[^0-9]/g, ''));
                console.log(`🔑 YOUR PAIRING CODE: ${code}`);
            } catch (e) {
                console.error("❌ Pairing Handshake Denied:", e.message);
                hasRequestedCode = false; 
            }
        }
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log(`🔴 Connection Lost. Reason: ${code}`);
      hasRequestedCode = false;

      // Wipe session only on total auth failure
      if (code === 401 || code === DisconnectReason.loggedOut) {
        if (fs.existsSync('./auth_session')) fs.rmSync('./auth_session', { recursive: true, force: true });
        setTimeout(startWhatsAppBot, 5000);
      } else {
        setTimeout(startWhatsAppBot, 10000);
      }
    } else if (connection === 'open') {
      console.log('🟢 SUCCESS: Device Linked & Agent Online!');
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

    if (liveVendor && !registrationState.has(sender) && !['register', 'onboard', 'start'].includes(cleanInput)) {
        return handleSalesAI(sender, text, liveVendor);
    }

    if (registrationState.has(sender) || ['register', 'onboard', 'start'].includes(cleanInput)) {
        return handleVendorOnboarding(sender, msg);
    }
  });
}

// ==========================================
// 4. SALES AI MODE (JOVIAL & PROFESSIONAL)
// ==========================================
async function handleSalesAI(customerJid, text, vendor) {
    const input = text.toLowerCase();
    
    if (input.includes('price') || input.includes('catalog')) {
        const items = vendor.catalog.map(i => `🛍️ *${i.caption}*\n💰 ₦${i.price.toLocaleString()}\n`).join('\n');
        await sock.sendMessage(customerJid, { text: `Omo! You have great taste! 😍 Check out our catalog for *${vendor.businessName}*:\n\n${items}` });
    } 
    else if (input.includes('buy') || input.includes('order') || input.match(/\d+/)) {
        try {
            const res = await axios.post('https://api.flutterwave.com/v3/payments', {
                tx_ref: `KUKA-${Date.now()}`, amount: "5000", currency: "NGN", 
                customer: { email: "customer@kuka.ai" },
                customizations: { title: vendor.businessName }
            }, { headers: { Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}` } });
            
            await sock.sendMessage(customerJid, { text: `Let's close this deal! 🚀 Pay securely here:\n\n${res.data.data.link}\n\nI'll confirm your order immediately once it's done! ✅` });
        } catch (e) {
            await sock.sendMessage(customerJid, { text: "Oops! Link error. Try 'buy' again! 🙏" });
        }
    }
    else {
        await sock.sendMessage(customerJid, { text: `Welcome to *${vendor.businessName}*! 🌟 I'm here to find you the best deals. Ask for our catalog to start!` });
    }
}

// ==========================================
// 5. ONBOARDING FLOW
// ==========================================
async function handleVendorOnboarding(sender, msg) {
    if (!registrationState.has(sender)) {
        registrationState.set(sender, { step: 'name' });
        return sock.sendMessage(sender, { text: "Hello! 👋 I'm your AI Agent. What is your *Business Name*?" });
    }
    const state = registrationState.get(sender);
    const text = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || "").trim();

    switch (state.step) {
        case 'name':
            state.businessName = text; state.step = 'bank';
            await sock.sendMessage(sender, { text: "What is your *Bank Name*?" });
            break;
        case 'bank':
            state.bankName = text; state.step = 'account';
            await sock.sendMessage(sender, { text: "And your *10-digit Account Number*?" });
            break;
        case 'account':
            state.accountNumber = text; state.step = 'confirm';
            await sock.sendMessage(sender, { text: `Please verify your details manually, then reply *Yes* to continue.` });
            break;
        case 'confirm':
            if (text.toLowerCase() === 'yes') {
                state.step = 'desc';
                await sock.sendMessage(sender, { text: "Verified! ✅ Business Description?" });
            } else {
                state.step = 'bank';
                await sock.sendMessage(sender, { text: "Bank Name?" });
            }
            break;
        case 'desc':
            state.description = text; state.step = 'faq';
            await sock.sendMessage(sender, { text: "Provide an *FAQ*:" });
            break;
        case 'faq':
            state.faq = text; state.step = 'catalog'; state.catalog = [];
            await sock.sendMessage(sender, { text: "Upload Catalog Photos. Include the *Price* in the caption! Type *Done* when finished." });
            break;
        case 'catalog':
            if (text.toLowerCase() === 'done') {
                const newVendor = new Vendor({ ...state, phoneNumber: sender, isLive: true });
                await newVendor.save();
                registrationState.delete(sender);
                await sock.sendMessage(sender, { text: "🎉 *LIVE!* I am now your Sales Agent." });
            } else if (msg.message?.imageMessage) {
                const cap = msg.message.imageMessage.caption || "";
                state.catalog.push({ imageUrl: "internal", caption: cap, price: parseInt(cap.match(/\d+/)?.[0]) || 0 });
                await sock.sendMessage(sender, { text: "✅ Added! Next or Done." });
            }
            break;
    }
    registrationState.set(sender, state);
}

initSupabase(); 
startWhatsAppBot();
app.listen(process.env.PORT || 10000);
