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
// 1. DATABASE & SUPABASE (KUKAPAY SHARED)
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

// ==========================================
// 2. FLUTTERWAVE V4 OAUTH & BANK AI
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
        // Get Bank Code
        const banks = await axios.get(`${process.env.FLW_BASE_URL}/banks/NG`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        const bank = banks.data.data.find(b => b.name.toLowerCase().includes(bankName.toLowerCase()));
        if (!bank) return null;

        // Resolve Account
        const resolve = await axios.post(`${process.env.FLW_BASE_URL}/banks/account-resolve`, 
            { account_number: accountNumber, account_bank: bank.code },
            { headers: { Authorization: `Bearer ${token}` } }
        );
        return { name: resolve.data.data.account_name, code: bank.code };
    } catch (e) { return null; }
}

// ==========================================
// 3. WHATSAPP ENGINE (RENDER STABILITY FIX)
// ==========================================
async function startWhatsAppBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_session');
  const { version } = await fetchLatestBaileysVersion();
  
  const sock = makeWASocket({
    version,
    logger: pino({ level: 'error' }),
    auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    browser: ["Ubuntu", "Chrome", "120.0.6099.129"],
    
    // --- RENDER FIX: NO HISTORY READING / NO 515 ERRORS ---
    syncFullHistory: false, 
    fireInitQueries: false,
    shouldSyncHistoryMessage: () => false, 
    connectTimeoutMs: 120000,
    defaultQueryTimeoutMs: 0,
    // ------------------------------------------------------
  });

  sock.ev.on('creds.update', saveCreds);

  // --- SUPABASE REALTIME: KUKAPAY WEBHOOK LISTENER ---
  supabase.channel('public:transactions')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'transactions' }, async (payload) => {
        const tx = payload.new;
        if (tx.status === 'successful') {
            const vendor = await Vendor.findOne({ phoneNumber: tx.vendor_id });
            // Send receipt to customer
            await sock.sendMessage(tx.customer_jid, { 
                text: `✅ *PAYMENT RECEIVED!*\n\nReference: ${tx.tx_ref}\nAmount: ₦${tx.amount}\n\nThank you for shopping with *${vendor?.businessName || 'us'}*. Your order is now being processed for delivery! 🚚✨` 
            });
            // Notify Vendor
            if (vendor) await sock.sendMessage(vendor.phoneNumber, { text: `💰 *Cha-Ching!* You just closed a deal. ₦${tx.amount} received from ${tx.customer_name}.` });
        }
    }).subscribe();

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr && !sock.authState.creds.registered && !hasRequestedCode) {
        hasRequestedCode = true;
        const pairingNumber = process.env.PAIRING_NUMBER;
        if (pairingNumber) {
            await delay(10000);
            const code = await sock.requestPairingCode(pairingNumber.replace(/[^0-9]/g, ''));
            console.log(`🔑 PAIRING CODE: ${code}`);
        }
    }
    if (connection === 'open') {
        console.log('🟢 SUCCESS: AI Sales Agent is Live!');
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

    // 1. Check if the sender is a registered LIVE VENDOR (Customer is messaging them)
    // In this multi-vendor setup, we check if the recipient of the message is a vendor
    // or if the sender is interacting with a vendor instance.
    const liveVendor = await Vendor.findOne({ isLive: true }); // Simplified for single-instance bot

    if (liveVendor && !registrationState.has(sender) && !['register', 'onboard'].includes(cleanInput)) {
        return handleSalesAI(sock, sender, text, liveVendor);
    }

    // 2. Onboarding Flow for new Vendors
    if (registrationState.has(sender) || ['register', 'i want to register', 'onboard'].includes(cleanInput)) {
        return handleVendorOnboarding(sock, sender, msg);
    }
  });
}

// ==========================================
// 4. SALES AI: THE NEGOTIATOR
// ==========================================
async function handleSalesAI(sock, customerJid, text, vendor) {
    const input = text.toLowerCase();
    
    // Professional & Jovial Personality Logic
    if (input.includes('hello') || input.includes('hi')) {
        await sock.sendMessage(customerJid, { text: `Hey there! 😊 Welcome to *${vendor.businessName}*. I'm your dedicated assistant here to help you find the best deals. What can I get for you today?` });
    } 
    else if (input.includes('price') || input.includes('catalog') || input.includes('list')) {
        const items = vendor.catalog.map(i => `🛍️ *${i.caption}*\n💰 Price: ₦${i.price.toLocaleString()}\n`).join('\n');
        await sock.sendMessage(customerJid, { text: `We've got some amazing stuff! Check these out:\n\n${items}\n\nWhich one catches your eye? 😍` });
    }
    else if (input.includes('buy') || input.includes('order') || input.match(/\d+/)) {
        // Generate dynamic Flutterwave link (Using v3 for payment links as it is standard)
        try {
            const ref = `KUKA-${Date.now()}`;
            const res = await axios.post('https://api.flutterwave.com/v3/payments', {
                tx_ref: ref, amount: "5000", currency: "NGN", // Demo amount
                customer: { email: "customer@kukai.ai", name: "WhatsApp Customer" },
                customizations: { title: vendor.businessName }
            }, { headers: { Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}` } });
            
            await sock.sendMessage(customerJid, { 
                text: `Awesome choice! 🚀 Let's wrap this up. You can make payment securely here:\n\n${res.data.data.link}\n\nI'll be right here waiting to send your receipt once it's done! ✅` 
            });
        } catch (e) {
            await sock.sendMessage(customerJid, { text: "Oops! I had a slight hiccup generating your payment link. Can you try again in a second? 🙏" });
        }
    }
    else {
        await sock.sendMessage(customerJid, { text: `I love that energy! ✨ Tell me more about what you're looking for, or ask about our delivery process!` });
    }
}

// ==========================================
// 5. VENDOR ONBOARDING FLOW
// ==========================================
async function handleVendorOnboarding(sock, sender, msg) {
    if (!registrationState.has(sender)) {
        registrationState.set(sender, { step: 'name' });
        return sock.sendMessage(sender, { text: "Hello Vendor! 👋 Let's set up your AI Sales Agent. What is your *Business Name*?" });
    }

    const state = registrationState.get(sender);
    const text = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || "").trim();

    switch (state.step) {
        case 'name':
            state.businessName = text;
            state.step = 'bank';
            await sock.sendMessage(sender, { text: `Nice one, *${text}*! Now, what is your *Bank Name*?` });
            break;
        case 'bank':
            state.bankName = text;
            state.step = 'account';
            await sock.sendMessage(sender, { text: "And your *10-digit Account Number*?" });
            break;
        case 'account':
            await sock.sendMessage(sender, { text: "🔍 *AI is verifying your account via Flutterwave v4...*" });
            const v = await verifyVendorV4(text, state.bankName);
            if (!v) {
                state.step = 'bank';
                return sock.sendMessage(sender, { text: "❌ Verification failed. Please re-type your *Bank Name* correctly:" });
            }
            state.accountName = v.name;
            state.accountNumber = text;
            state.bankCode = v.code;
            state.step = 'confirm';
            await sock.sendMessage(sender, { text: `I found this account: *${v.name}*\n\nIs this correct? (Yes/No)` });
            break;
        case 'confirm':
            if (text.toLowerCase() === 'yes') {
                state.step = 'desc';
                await sock.sendMessage(sender, { text: "Verified! ✅ Now the fun part. Give me a *Business Description* for the AI to use:" });
            } else {
                state.step = 'bank';
                await sock.sendMessage(sender, { text: "Let's try again. What is your *Bank Name*?" });
            }
            break;
        case 'desc':
            state.description = text;
            state.step = 'faq';
            await sock.sendMessage(sender, { text: "Next Task: Provide a common *FAQ* (e.g. Question & Answer):" });
            break;
        case 'faq':
            state.faq = text;
            state.step = 'catalog';
            state.catalog = [];
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
                await sock.sendMessage(sender, { text: "🎉 *CONGRATULATIONS!* Your AI Sales Agent is now active. I will handle your customers, negotiate deals, and manage payments via Kukapay!" });
            } else if (msg.message?.imageMessage) {
                const cap = msg.message.imageMessage.caption || "";
                const price = parseInt(cap.match(/\d+/)?.[0]) || 0;
                state.catalog.push({ imageUrl: "internal", caption: cap, price });
                await sock.sendMessage(sender, { text: "✅ Added! Send more or type *Done*." });
            }
            break;
    }
    registrationState.set(sender, state);
}

startWhatsAppBot();
app.listen(process.env.PORT || 10000);
