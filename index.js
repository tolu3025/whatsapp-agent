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
let sock; // Global socket access for listeners

// ==========================================
// 2. KUKAPAY REALTIME LISTENER (Global Fix)
// ==========================================
const initSupabaseListener = () => {
    console.log('📡 Initializing Supabase Realtime for Kukapay...');
    const channel = supabase.channel('public:transactions');
    
    channel.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'transactions' }, async (payload) => {
        const tx = payload.new;
        // status check and ensure we have a valid socket connection
        if (tx.status === 'successful' && sock && sock.authState.creds.registered) {
            const vendor = await Vendor.findOne({ phoneNumber: tx.vendor_id });
            try {
                // Receipt to Customer
                await sock.sendMessage(tx.customer_jid, { 
                    text: `✅ *PAYMENT CONFIRMED!*\n\nHello! I've received your payment of *₦${tx.amount.toLocaleString()}* for *${vendor?.businessName || 'the order'}*.\n\nReference: ${tx.tx_ref}\n\nYour order is now being processed for delivery! 🚚✨` 
                });
                // Alert to Vendor
                if (vendor) {
                    await sock.sendMessage(vendor.phoneNumber, { text: `💰 *Sales Alert:* You just closed a deal! ₦${tx.amount.toLocaleString()} received from ${tx.customer_name}.` });
                }
            } catch (e) { console.error("Supabase notification failed."); }
        }
    }).subscribe((status) => {
        if (status === 'SUBSCRIBED') console.log('✅ Supabase: Subscribed to Transactions table');
    });
};

// ==========================================
// 3. FLUTTERWAVE V4 OAUTH & RESOLVE
// ==========================================
let cachedToken = null;
let tokenExpiry = 0;

async function getFlwV4Token() {
    if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
    try {
        const res = await axios.post('https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token', 
            new URLSearchParams({
                client_id: process.env.FLW_CLIENT_ID,
                client_secret: process.env.FLW_CLIENT_SECRET,
                grant_type: 'client_credentials'
            }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );
        cachedToken = res.data.access_token;
        tokenExpiry = Date.now() + (res.data.expires_in * 1000) - 60000;
        return cachedToken;
    } catch (e) { return null; }
}

async function verifyVendorV4(accountNumber, bankName) {
    const token = await getFlwV4Token();
    try {
        const banks = await axios.get(`${process.env.FLW_BASE_URL}/banks/NG`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        const bank = banks.data.data.find(b => b.name.toLowerCase().includes(bankName.toLowerCase()));
        if (!bank) return null;

        const resolve = await axios.post(`${process.env.FLW_BASE_URL}/banks/account-resolve`, 
            { account_number: accountNumber, account_bank: bank.code },
            { headers: { Authorization: `Bearer ${token}` } }
        );
        return { name: resolve.data.data.account_name, code: bank.code };
    } catch (e) { return null; }
}

// ==========================================
// 4. WHATSAPP ENGINE (PAIRING STABILITY)
// ==========================================
async function startWhatsAppBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_session');
  const { version } = await fetchLatestBaileysVersion();
  
  sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    // FINGERPRINT: Mac OS identity is best for pairing link stability
    browser: ["Mac OS", "Chrome", "10.15.7"],
    
    // RENDER FIXES: Block history push to prevent 515/408 errors
    syncFullHistory: false, 
    fireInitQueries: false,
    shouldSyncHistoryMessage: () => false, 
    
    // TIMEOUTS: Wait indefinitely for pairing handshake
    connectTimeoutMs: 120000, 
    defaultQueryTimeoutMs: 0, 
    keepAliveIntervalMs: 20000,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // --- Pairing Code Logic ---
    if (!sock.authState.creds.registered && !hasRequestedCode) {
        hasRequestedCode = true;
        const pairingNumber = process.env.PAIRING_NUMBER;
        if (pairingNumber) {
            console.log(`⏳ Stabilizing socket for ${pairingNumber}...`);
            await delay(10000); 
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
      console.log(`🔴 Connection Lost. Code: ${code}`);
      hasRequestedCode = false;

      if (code === 401 || code === DisconnectReason.loggedOut) {
        if (fs.existsSync('./auth_session')) fs.rmSync('./auth_session', { recursive: true, force: true });
        setTimeout(startWhatsAppBot, 5000);
      } else {
        setTimeout(startWhatsAppBot, 10000);
      }
    } else if (connection === 'open') {
      console.log('🟢 SUCCESS: Sales Agent Linked & Online!');
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

    // Check if the recipient or owner of the bot instance is a LIVE VENDOR
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
// 5. SALES AI MODE (JOVIAL & PROFESSIONAL)
// ==========================================
async function handleSalesAI(customerJid, text, vendor) {
    const input = text.toLowerCase();
    
    if (input.includes('price') || input.includes('catalog') || input.includes('list')) {
        const items = vendor.catalog.map(i => `🛍️ *${i.caption}*\n💰 ₦${i.price.toLocaleString()}\n`).join('\n');
        await sock.sendMessage(customerJid, { text: `You have great taste! 😍 Here's what we have available at *${vendor.businessName}*:\n\n${items}\nWhich one catches your eye? 😊` });
    } 
    else if (input.includes('buy') || input.includes('order') || input.match(/\d+/)) {
        try {
            const ref = `KUKA-${Date.now()}`;
            const res = await axios.post('https://api.flutterwave.com/v3/payments', {
                tx_ref: ref, amount: "5000", currency: "NGN", 
                customer: { email: "customer@kuka.ai", name: "WhatsApp Customer" },
                customizations: { title: vendor.businessName }
            }, { headers: { Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}` } });
            
            await sock.sendMessage(customerJid, { text: `Awesome choice! 🚀 You can make payment securely via this link:\n\n${res.data.data.link}\n\nI'll send your receipt immediately once it's done! ✅` });
        } catch (e) {
            await sock.sendMessage(customerJid, { text: "Oops! My payment link generator hit a snag. Can you say 'buy' again? 🙏" });
        }
    }
    else {
        await sock.sendMessage(customerJid, { text: `Welcome to *${vendor.businessName}*! 🌟 I'm here to help you get the best deals.\n\nDescription: ${vendor.businessDescription}\n\nAsk me for our price list or catalog to get started! 😊` });
    }
}

// ==========================================
// 6. VENDOR ONBOARDING MODE
// ==========================================
async function handleVendorOnboarding(sender, msg) {
    if (!registrationState.has(sender)) {
        registrationState.set(sender, { step: 'name' });
        return sock.sendMessage(sender, { text: "Hello! 👋 I'm here to set up your AI Sales Agent. What is your *Business Name*?" });
    }

    const state = registrationState.get(sender);
    const text = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || "").trim();

    switch (state.step) {
        case 'name':
            state.businessName = text; state.step = 'bank';
            await sock.sendMessage(sender, { text: `Great! Now, what is your *Bank Name*?` });
            break;
        case 'bank':
            state.bankName = text; state.step = 'account';
            await sock.sendMessage(sender, { text: "And your *10-digit Account Number*?" });
            break;
        case 'account':
            await sock.sendMessage(sender, { text: "🔍 *AI is verifying via Flutterwave v4...*" });
            const v = await verifyVendorV4(text, state.bankName);
            if (!v) {
                state.step = 'bank';
                return sock.sendMessage(sender, { text: "❌ Verification failed. Please re-type your *Bank Name* correctly:" });
            }
            state.accountName = v.name; state.accountNumber = text; state.bankCode = v.code;
            state.step = 'confirm';
            await sock.sendMessage(sender, { text: `Is this correct?\n\n*Name:* ${v.name}\n\nReply *Yes* to continue or *No* to restart.` });
            break;
        case 'confirm':
            if (text.toLowerCase() === 'yes') {
                state.step = 'desc';
                await sock.sendMessage(sender, { text: "Verified! ✅ Now provide a *Business Description* (What do you sell?):" });
            } else {
                state.step = 'bank';
                await sock.sendMessage(sender, { text: "No problem. Let's try again. What is your *Bank Name*?" });
            }
            break;
        case 'desc':
            state.description = text; state.step = 'faq';
            await sock.sendMessage(sender, { text: "Task 2: Provide your *FAQ* (e.g. Question & Answer):" });
            break;
        case 'faq':
            state.faq = text; state.step = 'catalog'; state.catalog = [];
            await sock.sendMessage(sender, { text: "Final Task: *Upload Catalog Photos*. Include the *Price* in the caption!\n\nType *Done* when you're finished." });
            break;
        case 'catalog':
            if (text.toLowerCase() === 'done') {
                const newVendor = new Vendor({
                    phoneNumber: sender, businessName: state.businessName,
                    businessDescription: state.description, bankName: state.bankName,
                    accountNumber: state.accountNumber, accountName: state.accountName,
                    faq: state.faq, catalog: state.catalog, isLive: true
                });
                await newVendor.save();
                registrationState.delete(sender);
                await sock.sendMessage(sender, { text: "🎉 *YOU ARE LIVE!* I'll now handle your customers, negotiate deals, and manage payments via Kukapay!" });
            } else if (msg.message?.imageMessage) {
                const cap = msg.message.imageMessage.caption || "";
                const price = parseInt(cap.match(/\d+/)?.[0]) || 0;
                state.catalog.push({ imageUrl: "internal", caption: cap, price });
                await sock.sendMessage(sender, { text: `✅ Added: ${cap}. Next or Done?` });
            }
            break;
    }
    registrationState.set(sender, state);
}

// ==========================================
// 7. BOOTSTRAP
// ==========================================
initSupabaseListener(); // Runs once
startWhatsAppBot(); // Handles restarts
app.listen(process.env.PORT || 10000);
