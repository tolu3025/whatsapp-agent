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
// 1. DATABASE & SUPABASE SETUP
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
let sock; // GLOBAL SOCKET VARIABLE TO FIX SUPABASE ERROR

// ==========================================
// 2. KUKAPAY REALTIME LISTENER (MOVED OUTSIDE)
// ==========================================
// This runs once and stays active regardless of WhatsApp reconnects
supabase.channel('public:transactions')
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'transactions' }, async (payload) => {
      const tx = payload.new;
      if (tx.status === 'successful') {
          const vendor = await Vendor.findOne({ phoneNumber: tx.vendor_id });
          
          // Verify we have a live WhatsApp connection before sending
          if (sock) {
              await sock.sendMessage(tx.customer_jid, { 
                  text: `✅ *PAYMENT CONFIRMED!*\n\nReference: ${tx.tx_ref}\nAmount: ₦${tx.amount}\n\n*${vendor?.businessName || 'The Vendor'}* has received your payment. Your order is now being processed! 🚚✨` 
              });
              if (vendor) {
                  await sock.sendMessage(vendor.phoneNumber, { text: `💰 *Cha-Ching!* Your Sales Agent just closed a ₦${tx.amount} deal with ${tx.customer_name}!` });
              }
          }
      }
  }).subscribe();

// ==========================================
// 3. FLUTTERWAVE V4 OAUTH & BANK AI
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
// 4. WHATSAPP ENGINE (RENDER STABILITY)
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
    browser: ["Ubuntu", "Chrome", "121.0.6167.160"],
    
    // FIX: NO HISTORY / NO 515 ERRORS
    syncFullHistory: false, 
    fireInitQueries: false,
    shouldSyncHistoryMessage: () => false, 
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 0,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !sock.authState.creds.registered && !hasRequestedCode) {
        hasRequestedCode = true;
        const pairingNumber = process.env.PAIRING_NUMBER;
        if (pairingNumber) {
            await delay(8000);
            try {
                const code = await sock.requestPairingCode(pairingNumber.replace(/[^0-9]/g, ''));
                console.log(`🔑 YOUR PAIRING CODE: ${code}`);
            } catch (e) { hasRequestedCode = false; }
        }
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log(`🔴 Connection closed. Code: ${code}`);
      
      if (code === 515 || code === 401 || code === DisconnectReason.loggedOut) {
        if (fs.existsSync('./auth_session')) fs.rmSync('./auth_session', { recursive: true, force: true });
        hasRequestedCode = false;
        setTimeout(startWhatsAppBot, 5000);
      } else {
        setTimeout(startWhatsAppBot, 10000);
      }
    } else if (connection === 'open') {
      console.log('🟢 SUCCESS: Sales Agent Online (No History Synced)');
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

    // AI SALES MODE
    const liveVendor = await Vendor.findOne({ isLive: true }); 
    if (liveVendor && !registrationState.has(sender) && !['register', 'onboard'].includes(cleanInput)) {
        return handleSalesAI(sender, text, liveVendor);
    }

    // ONBOARDING MODE
    if (registrationState.has(sender) || ['register', 'onboard'].includes(cleanInput)) {
        return handleVendorOnboarding(sender, msg);
    }
  });
}

// ==========================================
// 5. SALES AI & ONBOARDING
// ==========================================
async function handleSalesAI(customerJid, text, vendor) {
    const input = text.toLowerCase();
    
    if (input.includes('price') || input.includes('catalog') || input.includes('list')) {
        const items = vendor.catalog.map(i => `🛍️ *${i.caption}*\n💰 ₦${i.price.toLocaleString()}\n`).join('\n');
        await sock.sendMessage(customerJid, { text: `Omo! You have great taste! 😍 Check out what *${vendor.businessName}* has for you:\n\n${items}\nWhich one are we closing today? 🛍️` });
    } 
    else if (input.includes('buy') || input.includes('order') || input.match(/\d+/)) {
        try {
            const ref = `KUKA-${Date.now()}`;
            const res = await axios.post('https://api.flutterwave.com/v3/payments', {
                tx_ref: ref, amount: "5000", currency: "NGN", 
                customer: { email: "customer@kuka.ai", name: "WhatsApp Buyer" },
                customizations: { title: vendor.businessName, description: "Kukapay Secure Payment" }
            }, { headers: { Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}` } });

            await sock.sendMessage(customerJid, { text: `Let's get this deal closed! 🚀 Pay securely here:\n\n${res.data.data.link}\n\nI'll send your receipt automatically once it's done! ✅` });
        } catch (e) {
            await sock.sendMessage(customerJid, { text: "My apologies! I had a tiny glitch. Can you say 'buy' again? 🙏" });
        }
    }
    else {
        await sock.sendMessage(customerJid, { text: `Welcome to *${vendor.businessName}*! 🌟 I'm here to help you get the best deals.\n\nAbout us: ${vendor.businessDescription}\n\nAsk me for our price list to start! 😊` });
    }
}

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
            await sock.sendMessage(sender, { text: "🔍 *Verifying via Flutterwave v4...*" });
            const v = await verifyVendorV4(text, state.bankName);
            if (!v) { state.step = 'bank'; return sock.sendMessage(sender, { text: "❌ Verification failed. Re-type your *Bank Name*:" }); }
            state.accountName = v.name; state.accountNumber = text; state.bankCode = v.code;
            state.step = 'confirm';
            await sock.sendMessage(sender, { text: `Is this your account: *${v.name}*? (Yes/No)` });
            break;
        case 'confirm':
            if (text.toLowerCase() === 'yes') { state.step = 'desc'; await sock.sendMessage(sender, { text: "Verified! ✅ Provide your *Business Description*:" }); }
            else { state.step = 'bank'; await sock.sendMessage(sender, { text: "What is your *Bank Name*?" }); }
            break;
        case 'desc':
            state.description = text; state.step = 'faq';
            await sock.sendMessage(sender, { text: "Provide your *FAQ*:" });
            break;
        case 'faq':
            state.faq = text; state.step = 'catalog'; state.catalog = [];
            await sock.sendMessage(sender, { text: "Final Task: *Send Catalog Photos* with *Price* in caption. Type *Done* when finished." });
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
                await sock.sendMessage(sender, { text: "🎉 *YOU ARE LIVE!* I'll now attend to your customers and handle payments via Kukapay." });
            } else if (msg.message?.imageMessage) {
                const cap = msg.message.imageMessage.caption || "";
                const price = parseInt(cap.match(/\d+/)?.[0]) || 0;
                state.catalog.push({ imageUrl: "received", caption: cap, price });
                await sock.sendMessage(sender, { text: "✅ Added! Send more or type *Done*." });
            }
            break;
    }
    registrationState.set(sender, state);
}

startWhatsAppBot();
app.listen(process.env.PORT || 10000);
