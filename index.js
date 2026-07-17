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
                    text: `✅ *PAYMENT CONFIRMED!*\n\nReference: ${tx.tx_ref}\nAmount: ₦${tx.amount}\n\n*${vendor?.businessName || 'The Vendor'}* has received your payment. Your order is now being processed! 🚚✨` 
                });
                if (vendor) await sock.sendMessage(vendor.phoneNumber, { text: `💰 *Alert:* Your Sales Agent closed a ₦${tx.amount} deal with ${tx.customer_name}!` });
            } catch (e) { console.log("Supabase message failed."); }
        }
    }).subscribe();
};

// ==========================================
// 3. FLUTTERWAVE V4 HELPERS
// ==========================================
let cachedToken = null;
let tokenExpiry = 0;
async function getFlwV4Token() {
    if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
    try {
        const res = await axios.post('https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token', 
            new URLSearchParams({ client_id: process.env.FLW_CLIENT_ID, client_secret: process.env.FLW_CLIENT_SECRET, grant_type: 'client_credentials' }), 
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );
        cachedToken = res.data.access_token;
        tokenExpiry = Date.now() + (res.data.expires_in * 1000) - 60000;
        return cachedToken;
    } catch (e) { return null; }
}

async function verifyVendorV4(accountNumber, bankName) {
    const token = await getFlwV4Token();
    try {
        const banks = await axios.get(`${process.env.FLW_BASE_URL}/banks/NG`, { headers: { Authorization: `Bearer ${token}` } });
        const bank = banks.data.data.find(b => b.name.toLowerCase().includes(bankName.toLowerCase()));
        if (!bank) return null;
        const resolve = await axios.post(`${process.env.FLW_BASE_URL}/banks/account-resolve`, { account_number: accountNumber, account_bank: bank.code }, { headers: { Authorization: `Bearer ${token}` } });
        return { name: resolve.data.data.account_name, code: bank.code };
    } catch (e) { return null; }
}

// ==========================================
// 4. WHATSAPP ENGINE (PAIRING STABILITY FIX)
// ==========================================
async function startWhatsAppBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_session');
  const { version } = await fetchLatestBaileysVersion();
  
  // Clean Logger to prevent CPU spikes on Render
  const logger = pino({ level: 'silent' });

  sock = makeWASocket({
    version,
    logger,
    auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    // BROWSWER IDENTITY: Critical for Render IP reputation
    browser: ["Ubuntu", "Chrome", "121.0.6167.160"],
    
    // --- STABILITY FLAGS ---
    printQRInTerminal: false,
    mobile: false,
    syncFullHistory: false, 
    fireInitQueries: false,
    shouldSyncHistoryMessage: () => false, 
    
    // TIMEOUTS: Increased to prevent connection death during pairing
    connectTimeoutMs: 100000, 
    defaultQueryTimeoutMs: 0, 
    keepAliveIntervalMs: 20000,
    generateHighQualityLinkPreview: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // --- PAIRING CODE LOGIC ---
    if (!sock.authState.creds.registered && !hasRequestedCode) {
        hasRequestedCode = true;
        const pairingNumber = process.env.PAIRING_NUMBER;
        if (pairingNumber) {
            console.log(`⏳ Waiting for socket to warm up for ${pairingNumber}...`);
            await delay(15000); // 15s delay is safer on Render
            try {
                const code = await sock.requestPairingCode(pairingNumber.replace(/[^0-9]/g, ''));
                console.log(`🔑 YOUR PAIRING CODE: ${code}`);
            } catch (e) {
                console.error("❌ Pairing Failed:", e.message);
                hasRequestedCode = false; 
            }
        }
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log(`🔴 Connection Lost. Reason: ${code}`);
      hasRequestedCode = false;

      // If session is corrupt or rejected, clear it
      if (code === 401 || code === 405 || code === DisconnectReason.loggedOut) {
        console.log("🧹 Wiping auth_session...");
        if (fs.existsSync('./auth_session')) fs.rmSync('./auth_session', { recursive: true, force: true });
        setTimeout(startWhatsAppBot, 5000);
      } else {
        // Standard reconnect for network glitches (515, 408)
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
// 5. SALES & ONBOARDING LOGIC
// ==========================================
async function handleSalesAI(customerJid, text, vendor) {
    const input = text.toLowerCase();
    if (input.includes('price') || input.includes('catalog')) {
        const items = vendor.catalog.map(i => `🛍️ *${i.caption}*\n💰 ₦${i.price.toLocaleString()}\n`).join('\n');
        await sock.sendMessage(customerJid, { text: `You have great taste! 😍 Check out what *${vendor.businessName}* has:\n\n${items}` });
    } else if (input.includes('buy') || input.match(/\d+/)) {
        try {
            const res = await axios.post('https://api.flutterwave.com/v3/payments', {
                tx_ref: `KUKA-${Date.now()}`, amount: "5000", currency: "NGN", 
                customer: { email: "customer@kuka.ai" }, customizations: { title: vendor.businessName }
            }, { headers: { Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}` } });
            await sock.sendMessage(customerJid, { text: `Secure checkout: ${res.data.data.link}` });
        } catch (e) { await sock.sendMessage(customerJid, { text: "Glitch! Say 'buy' again." }); }
    } else {
        await sock.sendMessage(customerJid, { text: `Hello! 🌟 Welcome to *${vendor.businessName}*. Ask for our prices!` });
    }
}

async function handleVendorOnboarding(sender, msg) {
    if (!registrationState.has(sender)) {
        registrationState.set(sender, { step: 'name' });
        return sock.sendMessage(sender, { text: "Hello Vendor! Business Name?" });
    }
    const state = registrationState.get(sender);
    const text = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || "").trim();
    switch (state.step) {
        case 'name': state.businessName = text; state.step = 'bank'; await sock.sendMessage(sender, { text: "Bank Name?" }); break;
        case 'bank': state.bankName = text; state.step = 'account'; await sock.sendMessage(sender, { text: "Account Number?" }); break;
        case 'account':
            const v = await verifyVendorV4(text, state.bankName);
            if (!v) { state.step = 'bank'; return sock.sendMessage(sender, { text: "Failed. Bank Name?" }); }
            state.accountName = v.name; state.accountNumber = text; state.step = 'confirm';
            await sock.sendMessage(sender, { text: `Confirm: *${v.name}*?` }); break;
        case 'confirm':
            if (text.toLowerCase() === 'yes') { state.step = 'desc'; await sock.sendMessage(sender, { text: "Description?" }); }
            else { state.step = 'bank'; await sock.sendMessage(sender, { text: "Bank Name?" }); } break;
        case 'desc': state.description = text; state.step = 'faq'; await sock.sendMessage(sender, { text: "FAQ?" }); break;
        case 'faq': state.faq = text; state.step = 'catalog'; state.catalog = []; await sock.sendMessage(sender, { text: "Catalog photos + Price in caption. Type Done." }); break;
        case 'catalog':
            if (text.toLowerCase() === 'done') {
                const newVendor = new Vendor({ ...state, phoneNumber: sender, isLive: true });
                await newVendor.save(); registrationState.delete(sender);
                await sock.sendMessage(sender, { text: "🎉 Live!" });
            } else if (msg.message?.imageMessage) {
                const cap = msg.message.imageMessage.caption || "";
                state.catalog.push({ imageUrl: "received", caption: cap, price: parseInt(cap.match(/\d+/)?.[0]) || 0 });
                await sock.sendMessage(sender, { text: "✅ Added! Next or Done." });
            } break;
    }
    registrationState.set(sender, state);
}

initSupabase(); 
startWhatsAppBot();
app.listen(process.env.PORT || 10000);
