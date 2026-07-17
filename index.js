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
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');
const axios = require('axios');
const fs = require('fs');
const express = require('express');

// ==========================================
// 1. SYSTEM & DATABASE INITIALIZATION
// ==========================================
const app = express();
app.use(express.json());

// Start the server immediately so Render doesn't kill the app during pairing
const PORT = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('Kukatai PA Agent is Online'));
app.listen(PORT, () => console.log(`🚀 Health Check Active on Port ${PORT}`));

mongoose.connect(process.env.MONGODB_URI).then(() => console.log('🟢 MongoDB Connected'));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ==========================================
// 2. DATA MODELS
// ==========================================
const Vendor = mongoose.model('Vendor', new mongoose.Schema({
  phoneNumber: { type: String, required: true, unique: true },
  businessName: String,
  email: String,
  bankCode: String,
  bankName: String,
  accountNumber: String,
  accountName: String,
  flwSubaccountId: String,
  description: String,
  faqs: String,
  catalog: [{ imageUrl: String, caption: String, price: Number }],
  activeGroups: [String],
  onboardingStep: { type: String, default: 'none' },
  isApproved: { type: Boolean, default: false }
}));

const Transaction = mongoose.model('Transaction', new mongoose.Schema({
  txRef: { type: String, unique: true },
  customerPhone: String,
  vendorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor' },
  amount: Number,
  status: { type: String, enum: ['pending', 'success'], default: 'pending' },
  virtualAccount: String,
  createdAt: { type: Date, default: Date.now }
}));

// ==========================================
// 3. FLUTTERWAVE V4 SERVICE
// ==========================================
class FlutterwaveService {
  constructor() {
    this.token = null;
    this.expiry = 0;
    this.bankCache = [];
  }

  async getAuth() {
    if (this.token && Date.now() < this.expiry) return this.token;
    const res = await axios.post('https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token', 
      new URLSearchParams({ client_id: process.env.FLW_CLIENT_ID, client_secret: process.env.FLW_CLIENT_SECRET, grant_type: 'client_credentials' }));
    this.token = res.data.access_token;
    this.expiry = Date.now() + (res.data.expires_in - 60) * 1000;
    return this.token;
  }

  async fetchBanks() {
    const token = await this.getAuth();
    const res = await axios.get(`${process.env.FLW_BASE_URL}/banks?country=NG`, { headers: { Authorization: `Bearer ${token}` } });
    this.bankCache = res.data.data;
  }

  async verifyAccount(number, code) {
    const token = await this.getAuth();
    try {
      const res = await axios.post(`${process.env.FLW_BASE_URL}/banks/account-resolve`, { account: { code, number }, currency: 'NGN' }, { headers: { Authorization: `Bearer ${token}` } });
      return res.data.data;
    } catch (e) { return null; }
  }

  async createSubaccount(vendor) {
    const token = await this.getAuth();
    const res = await axios.post(`${process.env.FLW_BASE_URL}/subaccounts`, {
      account_bank: vendor.bankCode,
      account_number: vendor.accountNumber,
      business_name: vendor.businessName,
      business_email: vendor.email || 'vendor@kukatapai.com',
      split_type: "percentage",
      split_value: 0.05 // Your 5% commission
    }, { headers: { Authorization: `Bearer ${token}` } });
    return res.data.data.subaccount_id;
  }

  async createVirtualAccount(amount, subaccountId) {
    const token = await this.getAuth();
    const txRef = `KUKA-${Date.now()}`;
    const res = await axios.post(`${process.env.FLW_BASE_URL}/virtual-account-numbers`, {
      email: "sales@kukatapai.com", amount, currency: "NGN", tx_ref: txRef,
      is_permanent: false, frequency: 1, subaccounts: [{ id: subaccountId }]
    }, { headers: { Authorization: `Bearer ${token}` } });
    return { ...res.data.data, txRef };
  }
}
const flw = new FlutterwaveService();

// ==========================================
// 4. WHATSAPP BOT ENGINE
// ==========================================
let pairingRequested = false;

async function startAgent() {
  console.log('📡 Starting WhatsApp Handshake...');
  
  // FETCH LATEST VERSION DYNAMICALLY
  let version = [2, 3000, 1017578213]; // Fallback
  try {
    const { version: latestVersion } = await fetchLatestBaileysVersion();
    version = latestVersion;
    console.log(`✅ Using WA Protocol Version: ${version.join('.')}`);
  } catch (e) { console.log('⚠️ Could not fetch latest version, using fallback.'); }

  const { state, saveCreds } = await useMultiFileAuthState('auth_session');

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    logger: pino({ level: 'silent' }),
    
    // GENERIC DESKTOP CHROME IDENTITY
    browser: ['Chrome (Desktop)', '', ''], 
    
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 15000,
    generateHighQualityLinkPreview: true,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !sock.authState.creds.registered && !pairingRequested) {
      pairingRequested = true;
      const pairingNumber = process.env.PAIRING_NUMBER;
      if (pairingNumber) {
        console.log(`⏳ Stabilizing socket for pairing...`);
        await delay(10000); 
        try {
          const code = await sock.requestPairingCode(pairingNumber.replace(/[^0-9]/g, ''));
          console.log(`🔑 YOUR PAIRING CODE: ${code}`);
        } catch (e) { 
            console.error("Pairing request failed:", e.message);
            pairingRequested = false; 
        }
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      pairingRequested = false;
      
      console.log(`🔴 Connection Lost (Status: ${statusCode})`);

      // AUTO-HEALING: If session is poisoned, wipe and restart
      if (statusCode === 405 || statusCode === 401 || statusCode === DisconnectReason.badSession) {
        console.log('🧹 Session corrupted. Wiping auth_session folder...');
        if (fs.existsSync('./auth_session')) fs.rmSync('./auth_session', { recursive: true, force: true });
        setTimeout(startAgent, 10000);
      } else if (statusCode !== DisconnectReason.loggedOut) {
        setTimeout(startAgent, 5000);
      }
    } else if (connection === 'open') {
      console.log('🟢 SUCCESS: AGENT IS CONNECTED AND ONLINE');
      pairingRequested = false;
      await flw.fetchBanks();
      initSupabaseObserver(sock);
      startCatalogLoop(sock);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = jidNormalizedUser(msg.key.remoteJid);
    const rawText = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || "");
    const cleanText = rawText.toLowerCase().trim();

    console.log(`📩 [${sender}]: ${cleanText}`);

    const vendor = await Vendor.findOne({ phoneNumber: sender }) || await Vendor.findOne({ isApproved: true });

    // ONBOARDING
    if (vendor && vendor.onboardingStep !== 'none' && vendor.onboardingStep !== 'completed') {
      return handleOnboarding(sock, sender, rawText, vendor);
    }

    // REGISTRATION
    if (cleanText === "i want to register") {
      await Vendor.findOneAndUpdate({ phoneNumber: sender }, { onboardingStep: 'askName' }, { upsert: true });
      return sock.sendMessage(sender, { text: "👋 Welcome! I am your AI Sales PA. What is your *Official Business Name*?" });
    }

    // AI SALES CHAT
    if (vendor && vendor.isApproved) {
      await sock.sendPresenceUpdate('composing', sender);
      const aiResponse = await getAIResponse(rawText, vendor);

      if (aiResponse.includes("TRIGGER_PAYMENT:")) {
        const amount = aiResponse.split(":")[1].trim();
        const pay = await flw.createVirtualAccount(amount, vendor.flwSubaccountId);
        await new Transaction({ txRef: pay.txRef, customerPhone: sender, vendorId: vendor._id, amount, virtualAccount: pay.account_number }).save();
        await sock.sendMessage(sender, { text: `💰 *Secure Payment Generated!* \n\nPlease transfer ₦${amount} to:\n🏦 *${pay.bank_name}*\n🔢 *${pay.account_number}*\n\nI'll confirm the deal the moment it lands! ✨` });
      } else {
        await sock.sendMessage(sender, { text: aiResponse });
      }
    }
  });
}

// ==========================================
// 5. HELPER LOGIC (Onboarding, AI, Observers)
// ==========================================
async function handleOnboarding(sock, sender, input, vendor) {
  switch (vendor.onboardingStep) {
    case 'askName':
      vendor.businessName = input; vendor.onboardingStep = 'askBank';
      await vendor.save();
      await sock.sendMessage(sender, { text: "Got it. Which *Bank* (e.g. Opay, Zenith, GTB) do you use?" });
      break;
    case 'askBank':
      const bank = flw.bankCache.find(b => b.name.toLowerCase().includes(input.toLowerCase()));
      if (!bank) return sock.sendMessage(sender, { text: "⚠️ Bank not found. Please type the full name (e.g. Guaranty Trust Bank):" });
      vendor.bankName = bank.name; vendor.bankCode = bank.code;
      vendor.onboardingStep = 'askAcc'; await vendor.save();
      await sock.sendMessage(sender, { text: `Bank Set: *${bank.name}*. Now, send your *10-digit Account Number*:` });
      break;
    case 'askAcc':
      const verified = await flw.verifyAccount(input.trim(), vendor.bankCode);
      if (!verified) return sock.sendMessage(sender, { text: "❌ Verification failed. Please re-send the 10-digit number:" });
      vendor.accountNumber = input.trim(); vendor.accountName = verified.account_name;
      vendor.onboardingStep = 'finalize'; await vendor.save();
      await sock.sendMessage(sender, { text: `✅ Verified: *${verified.account_name}*\n\nFinal step: Send a short *Business Description*:` });
      break;
    case 'finalize':
      vendor.description = input;
      vendor.flwSubaccountId = await flw.createSubaccount(vendor);
      vendor.onboardingStep = 'completed'; vendor.isApproved = true;
      await vendor.save();
      await sock.sendMessage(sender, { text: `🎉 *Registration Complete!*\n\nBusiness: ${vendor.businessName}\nStatus: Active. I am now your PA!` });
      break;
  }
}

async function getAIResponse(text, vendor) {
  const prompt = `You are a jovial sales PA for ${vendor.businessName}. Tone: Helpful, Fun, Nigerian. Description: ${vendor.description}. If the customer wants to buy, calculate the amount and strictly respond with TRIGGER_PAYMENT:[amount].`;
  const res = await openai.chat.completions.create({
    model: "gpt-3.5-turbo", messages: [{ role: "system", content: prompt }, { role: "user", content: text }]
  });
  return res.choices[0].message.content;
}

function initSupabaseObserver(sock) {
  supabase.channel('transactions').on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'transactions' }, async (payload) => {
    if (payload.new.status === 'success') {
      const tx = await Transaction.findOne({ txRef: payload.new.tx_ref, status: 'pending' });
      if (tx) {
        tx.status = 'success'; await tx.save();
        await sock.sendMessage(tx.customerPhone, { text: "💰 *PAYMENT CONFIRMED!* Your order has been placed. Thank you for your purchase! 🥳✨" });
      }
    }
  }).subscribe();
}

function startCatalogLoop(sock) {
  setInterval(async () => {
    const vendors = await Vendor.find({ isApproved: true });
    for (const v of vendors) {
      if (v.catalog.length > 0 && v.activeGroups.length > 0) {
        const item = v.catalog[Math.floor(Math.random() * v.catalog.length)];
        for (const g of v.activeGroups) {
          await sock.sendMessage(g, { image: { url: item.imageUrl }, caption: `🔥 *Check this out from ${v.businessName}!* \n\nOnly ₦${item.price.toLocaleString()}` });
        }
      }
    }
  }, 8 * 60 * 60 * 1000);
}

startAgent();
