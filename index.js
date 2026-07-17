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
// 3. WHATSAPP ENGINE (PAIRING & SYNC FIXED)
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
    // Standard Browser Identity
    browser: ["Ubuntu", "Chrome", "121.0.6167.160"],
    
    // --- STABILITY SETTINGS ---
    printQRInTerminal: false,
    mobile: false,
    markOnlineOnConnect: true, // Must be true for initial pairing handshake
    syncFullHistory: false, 
    fireInitQueries: false,
    shouldSyncHistoryMessage: () => false, // Prevents loading hang
    
    connectTimeoutMs: 100000, 
    defaultQueryTimeoutMs: 0, 
    keepAliveIntervalMs: 30000,
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
            await delay(7000); // Shorter delay to prevent handshake timeout
            try {
                const code = await sock.requestPairingCode(pairingNumber.replace(/[^0-9]/g, ''));
                console.log(`🔑 YOUR PAIRING CODE: ${code}`);
            } catch (e) {
                console.error("Pairing Request Failed:", e.message);
                hasRequestedCode = false; 
            }
        }
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log(`🔴 Connection Lost. Reason: ${code}`);
      hasRequestedCode = false;

      if (code === 401 || code === 405 || code === 408 || code === DisconnectReason.loggedOut) {
        console.log("🧹 Wiping auth_session to start fresh...");
        if (fs.existsSync('./auth_session')) fs.rmSync('./auth_session', { recursive: true, force: true });
        setTimeout(startWhatsAppBot, 5000);
      } else {
        setTimeout(startWhatsAppBot, 10000);
      }
    } else if (connection === 'open') {
      console.log('🟢 SUCCESS: Sales Agent Online!');
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
// 4. SALES AI (PROFESSIONAL & JOVIAL)
// ==========================================
async function handleSalesAI(customerJid, text, vendor) {
    const input = text.toLowerCase();
    
    if (input.includes('price') || input.includes('catalog')) {
        const items = vendor.catalog.map(i => `🛍️ *${i.caption}*\n💰 ₦${i.price.toLocaleString()}\n`).join('\n');
        await sock.sendMessage(customerJid, { text: `You have great taste! 😍 Check out what *${vendor.businessName}* has for you:\n\n${items}\nWhich one are we closing today?` });
    } 
    else if (input.includes('buy') || input.match(/\d+/)) {
        try {
            const ref = `KUKA-${Date.now()}`;
            const res = await axios.post('https://api.flutterwave.com/v3/payments', {
                tx_ref: ref, amount: "5000", currency: "NGN", 
                customer: { email: "customer@kuka.ai" },
                customizations: { title: vendor.businessName }
            }, { headers: { Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}` } });
            await sock.sendMessage(customerJid, { text: `Let's close this deal! 🚀 Pay securely here:\n\n${res.data.data.link}\n\nI'll send your receipt automatically once it's done! ✅` });
        } catch (e) {
            await sock.sendMessage(customerJid, { text: "Sorry! Had a tiny glitch. Can you say 'buy' again? 🙏" });
        }
    }
    else {
        await sock.sendMessage(customerJid, { text: `Welcome to *${vendor.businessName}*! 🌟 I'm here to help you get the best deals.\n\nAsk me for our price list to start! 😊` });
    }
}

// ==========================================
// 5. VENDOR ONBOARDING FLOW
// ==========================================
async function handleVendorOnboarding(sender, msg) {
    if (!registrationState.has(sender)) {
        registrationState.set(sender, { step: 'name' });
        return sock.sendMessage(sender, { text: "Hello Vendor! 👋 Let's set up your Sales Agent. What is your *Business Name*?" });
    }
    const state = registrationState.get(sender);
    const text = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || "").trim();

    switch (state.step) {
        case 'name':
            state.businessName = text; state.step = 'bank';
            await sock.sendMessage(sender, { text: `Great, *${text}*! What is your *Bank Name*?` });
            break;
        case 'bank':
            state.bankName = text; state.step = 'account';
            await sock.sendMessage(sender, { text: "Your *10-digit Account Number*?" });
            break;
        case 'account':
            const v = await axios.post(`${process.env.FLW_BASE_URL}/banks/account-resolve`, { account_number: text, account_bank: "057" }, { headers: { Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}` } }).catch(() => null);
            state.accountName = v?.data?.data?.account_name || "Vendor";
            state.accountNumber = text;
            state.step = 'confirm';
            await sock.sendMessage(sender, { text: `Confirm: *${state.accountName}*?` });
            break;
        case 'confirm':
            if (text.toLowerCase() === 'yes') { state.step = 'desc'; await sock.sendMessage(sender, { text: "Description?" }); }
            else { state.step = 'bank'; await sock.sendMessage(sender, { text: "Bank Name?" }); }
            break;
        case 'desc':
            state.description = text; state.step = 'faq';
            await sock.sendMessage(sender, { text: "FAQ?" });
            break;
        case 'faq':
            state.faq = text; state.step = 'catalog'; state.catalog = [];
            await sock.sendMessage(sender, { text: "Final Task: *Send Catalog Photos* with *Price* in caption. Type *Done* when finished." });
            break;
        case 'catalog':
            if (text.toLowerCase() === 'done') {
                const newVendor = new Vendor({ ...state, phoneNumber: sender, isLive: true });
                await newVendor.save(); registrationState.delete(sender);
                await sock.sendMessage(sender, { text: "🎉 *LIVE!*" });
            } else if (msg.message?.imageMessage) {
                const cap = msg.message.imageMessage.caption || "";
                state.catalog.push({ imageUrl: "received", caption: cap, price: parseInt(cap.match(/\d+/)?.[0]) || 0 });
                await sock.sendMessage(sender, { text: "✅ Added! Next or Done." });
            }
            break;
    }
    registrationState.set(sender, state);
}

initSupabase(); 
startWhatsAppBot();
app.listen(process.env.PORT || 10000);
