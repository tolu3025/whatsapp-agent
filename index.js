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
// 1. DATABASE & SUPABASE CONFIG
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
let sock; // Global access

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
                    text: `✅ *PAYMENT CONFIRMED!*\n\n*${v?.businessName || 'The Vendor'}* has received your payment of *₦${tx.amount.toLocaleString()}*.\n\nYour order is now being processed! 🚚` 
                });
            } catch (e) { console.log("Supabase notify failed"); }
        }
    }).subscribe();
};

// ==========================================
// 3. WHATSAPP ENGINE (REPLY FIX & STABILITY)
// ==========================================
async function startWhatsAppBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_session');
  
  console.log('📡 Fetching latest WhatsApp protocol...');
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    browser: ["Mac OS", "Chrome", "126.0.0.0"], 
    
    syncFullHistory: false, 
    fireInitQueries: false,
    shouldSyncHistoryMessage: () => false, 
    
    connectTimeoutMs: 60000, 
    defaultQueryTimeoutMs: 0, 
    keepAliveIntervalMs: 15000,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (!sock.authState.creds.registered && !hasRequestedCode) {
        hasRequestedCode = true;
        const pairingNumber = process.env.PAIRING_NUMBER;
        if (pairingNumber) {
            await delay(10000); 
            try {
                const code = await sock.requestPairingCode(pairingNumber.replace(/[^0-9]/g, ''));
                console.log(`🔑 YOUR PAIRING CODE: ${code}`);
            } catch (e) { hasRequestedCode = false; }
        }
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log(`🔴 Connection Closed. Code: ${code}`);
      hasRequestedCode = false;
      if (code === 401 || code === 405) {
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

  // --- MESSAGE LISTENER (THE FIX IS HERE) ---
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = jidNormalizedUser(msg.key.remoteJid);
    const text = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || "").trim();
    const cleanInput = text.toLowerCase();

    console.log(`📩 [${sender}]: ${text}`); // See exactly what users are sending

    // 1. Logic for Customers messaging a Live Vendor
    const liveVendor = await Vendor.findOne({ isLive: true }); 
    if (liveVendor && !registrationState.has(sender) && !['register', 'onboard', 'start'].some(t => cleanInput.includes(t))) {
        return handleSalesAI(sender, text, liveVendor);
    }

    // 2. Logic for Onboarding (Fixed Trigger)
    const onboardingTriggers = ['register', 'onboard', 'start', 'i want to register'];
    if (registrationState.has(sender) || onboardingTriggers.some(t => cleanInput.includes(t))) {
        return handleVendorOnboarding(sender, msg);
    }
  });
}

// ==========================================
// 4. SALES AI MODE
// ==========================================
async function handleSalesAI(customerJid, text, vendor) {
    const input = text.toLowerCase();
    if (input.includes('price') || input.includes('catalog')) {
        const items = vendor.catalog.map(i => `🛍️ *${i.caption}*\n💰 ₦${i.price.toLocaleString()}\n`).join('\n');
        await sock.sendMessage(customerJid, { text: `You have great taste! 😍 Check out our catalog for *${vendor.businessName}*:\n\n${items}` });
    } else if (input.includes('buy') || input.match(/\d+/)) {
        try {
            const res = await axios.post('https://api.flutterwave.com/v3/payments', {
                tx_ref: `KUKA-${Date.now()}`, amount: "5000", currency: "NGN", 
                customer: { email: "customer@kuka.ai" }, customizations: { title: vendor.businessName }
            }, { headers: { Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}` } });
            await sock.sendMessage(customerJid, { text: `Let's close this deal! 🚀 Pay securely here:\n\n${res.data.data.link}` });
        } catch (e) { await sock.sendMessage(customerJid, { text: "Link error. Try 'buy' again!" }); }
    } else {
        await sock.sendMessage(customerJid, { text: `Welcome to *${vendor.businessName}*! 🌟 I'm your AI Sales Assistant. Ask for our catalog to start shopping!` });
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
            await sock.sendMessage(sender, { text: `Please verify your bank details, then reply *Yes* to continue.` });
            break;
        case 'confirm':
            if (text.toLowerCase() === 'yes') {
                state.step = 'desc'; await sock.sendMessage(sender, { text: "Verified! ✅ Business Description?" });
            } else {
                state.step = 'bank'; await sock.sendMessage(sender, { text: "Bank Name?" });
            }
            break;
        case 'desc':
            state.description = text; state.step = 'faq';
            await sock.sendMessage(sender, { text: "Provide an *FAQ*:" });
            break;
        case 'faq':
            state.faq = text; state.step = 'catalog'; state.catalog = [];
            await sock.sendMessage(sender, { text: "Final Task: *Upload Catalog Photos*. Include the *Price* in the caption! Type *Done* when finished." });
            break;
        case 'catalog':
            if (text.toLowerCase() === 'done') {
                const newVendor = new Vendor({ ...state, phoneNumber: sender, isLive: true });
                await newVendor.save();
                registrationState.delete(sender);
                await sock.sendMessage(sender, { text: "🎉 *LIVE!* I am now your Sales Agent. I will attend to your customers and handle payments via Kukapay." });
            } else if (msg.message?.imageMessage) {
                const cap = msg.message.imageMessage.caption || "";
                const price = parseInt(cap.match(/\d+/)?.[0]) || 0;
                state.catalog.push({ imageUrl: "internal", caption: cap, price });
                await sock.sendMessage(sender, { text: "✅ Added! Next or Done." });
            }
            break;
    }
    registrationState.set(sender, state);
}

// Keep Render Awake
app.get('/', (req, res) => res.send('Bot Active ⚡'));
setInterval(() => {
    if (process.env.RENDER_EXTERNAL_URL) axios.get(process.env.RENDER_EXTERNAL_URL).catch(() => {});
}, 300000);

initSupabase(); 
startWhatsAppBot();
app.listen(process.env.PORT || 10000);
