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
const express = require('express');
const fs = require('fs');

// ==========================================
// 1. INITIALIZATION & GUARDRAILS
// ==========================================
const app = express();
app.use(express.json());

const requiredEnv = ['MONGODB_URI', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'OPENAI_API_KEY', 'FLW_CLIENT_ID', 'FLW_CLIENT_SECRET'];
requiredEnv.forEach(v => { if (!process.env[v]) console.error(`🔴 MISSING ENV: ${v}`); });

mongoose.connect(process.env.MONGODB_URI).then(() => console.log('🟢 MongoDB Connected'));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ==========================================
// 2. DATABASE MODELS
// ==========================================
const Vendor = mongoose.model('Vendor', new mongoose.Schema({
  phoneNumber: { type: String, required: true, unique: true },
  businessName: String,
  email: String,
  bankCode: String,
  accountNumber: String,
  accountName: String,
  flwSubaccountId: String, // Critical for split payments
  catalog: [{ imageUrl: String, caption: String, price: Number }],
  description: String,
  faqs: String,
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
// 3. FLUTTERWAVE V4 SERVICE (Split Payments)
// ==========================================
class FlutterwaveService {
  constructor() {
    this.token = null;
    this.expiry = 0;
  }

  async getAuth() {
    if (this.token && Date.now() < this.expiry) return this.token;
    const res = await axios.post('https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token', 
      new URLSearchParams({ client_id: process.env.FLW_CLIENT_ID, client_secret: process.env.FLW_CLIENT_SECRET, grant_type: 'client_credentials' }));
    this.token = res.data.access_token;
    this.expiry = Date.now() + (res.data.expires_in - 60) * 1000;
    return this.token;
  }

  async createSubaccount(vendor) {
    const token = await this.getAuth();
    const res = await axios.post(`${process.env.FLW_BASE_URL}/subaccounts`, {
      account_bank: vendor.bankCode,
      account_number: vendor.accountNumber,
      business_name: vendor.businessName,
      business_email: vendor.email,
      split_type: "percentage",
      split_value: 0.05 // Your 5% commission
    }, { headers: { Authorization: `Bearer ${token}` } });
    return res.data.data.subaccount_id;
  }

  async createVirtualAccount(amount, subaccountId) {
    const token = await this.getAuth();
    const txRef = `KUKA-${Date.now()}`;
    const res = await axios.post(`${process.env.FLW_BASE_URL}/virtual-account-numbers`, {
      email: "sales@kukatapai.com",
      amount,
      currency: "NGN",
      tx_ref: txRef,
      is_permanent: false,
      frequency: 1,
      subaccounts: [{ id: subaccountId }]
    }, { headers: { Authorization: `Bearer ${token}` } });
    return { ...res.data.data, txRef };
  }
}
const flw = new FlutterwaveService();

// ==========================================
// 4. WHATSAPP ENGINE & AI LOGIC
// ==========================================
async function startAgent() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_session');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    logger: pino({ level: 'silent' }),
    browser: ['Ubuntu', 'Chrome', '114.0.0'],
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr && !sock.authState.creds.registered) {
      const code = await sock.requestPairingCode(process.env.PAIRING_NUMBER.replace(/[^0-9]/g, ''));
      console.log(`🔑 PAIRING CODE: ${code}`);
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) startAgent();
    } else if (connection === 'open') {
      console.log('🟢 AGENT ONLINE');
      initSupabaseListener(sock);
      startCatalogLoop(sock);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = jidNormalizedUser(msg.key.remoteJid);
    const text = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || "");
    const vendor = await Vendor.findOne({ phoneNumber: sender }) || await Vendor.findOne({ isApproved: true });

    // ONBOARDING FLOW
    if (vendor && vendor.onboardingStep !== 'none' && vendor.onboardingStep !== 'completed') {
      return handleOnboarding(sock, sender, text, vendor);
    }

    // TRIGGER REGISTRATION
    if (text.toLowerCase().includes("i want to register")) {
      await Vendor.findOneAndUpdate({ phoneNumber: sender }, { onboardingStep: 'askName' }, { upsert: true });
      return sock.sendMessage(sender, { text: "👋 Welcome! What is your *Business Name*?" });
    }

    // AI SALES CHAT
    await sock.sendPresenceUpdate('composing', sender);
    const aiResponse = await getAIResponse(text, vendor);

    if (aiResponse.includes("TRIGGER_PAYMENT:")) {
      const amount = aiResponse.split(":")[1].trim();
      const pay = await flw.createVirtualAccount(amount, vendor.flwSubaccountId);
      await new Transaction({ txRef: pay.txRef, customerPhone: sender, vendorId: vendor._id, amount, virtualAccount: pay.account_number }).save();
      
      const payMsg = `🎉 *Ready to close the deal!*\n\nTransfer ₦${amount} to:\n🏦 *${pay.bank_name}*\n🔢 *${pay.account_number}*\n\nI'm waiting here to confirm! ✨`;
      await sock.sendMessage(sender, { text: payMsg });
    } else {
      await sock.sendMessage(sender, { text: aiResponse });
    }
  });
}

// ==========================================
// 5. HELPER FLOWS (Onboarding, AI, Realtime)
// ==========================================
async function handleOnboarding(sock, sender, input, vendor) {
  if (vendor.onboardingStep === 'askName') {
    vendor.businessName = input; vendor.onboardingStep = 'askBank';
    await vendor.save();
    await sock.sendMessage(sender, { text: "Got it. What is your *Bank Name*?" });
  } else if (vendor.onboardingStep === 'askBank') {
    vendor.bankCode = "058"; // Simplified for demo; use a bank list lookup here
    vendor.onboardingStep = 'askAcc';
    await vendor.save();
    await sock.sendMessage(sender, { text: "Send your *10-digit Account Number*:" });
  } else if (vendor.onboardingStep === 'askAcc') {
    vendor.accountNumber = input;
    vendor.flwSubaccountId = await flw.createSubaccount(vendor);
    vendor.onboardingStep = 'completed'; vendor.isApproved = true;
    await vendor.save();
    await sock.sendMessage(sender, { text: "✅ *Setup Complete!* You are now a verified vendor." });
  }
}

async function getAIResponse(text, vendor) {
  const prompt = `You are a jovial sales PA for ${vendor.businessName}. Tone: Helpful, Fun, Nigerian. If customer is ready to buy, say TRIGGER_PAYMENT:[price]. Info: ${vendor.description}`;
  const res = await openai.chat.completions.create({
    model: "gpt-3.5-turbo",
    messages: [{ role: "system", content: prompt }, { role: "user", content: text }]
  });
  return res.choices[0].message.content;
}

function initSupabaseListener(sock) {
  supabase.channel('tx').on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'transactions' }, async (payload) => {
    if (payload.new.status === 'success') {
      const tx = await Transaction.findOne({ txRef: payload.new.tx_ref, status: 'pending' });
      if (tx) {
        tx.status = 'success'; await tx.save();
        await sock.sendMessage(tx.customerPhone, { text: "💰 *PAYMENT CONFIRMED!* Your deal is closed. 🥳" });
      }
    }
  }).subscribe();
}

function startCatalogLoop(sock) {
  setInterval(async () => {
    const vendors = await Vendor.find({ isApproved: true });
    for (const v of vendors) {
      if (v.catalog.length > 0 && v.activeGroups.length > 0) {
        const item = v.catalog[0];
        for (const g of v.activeGroups) {
          await sock.sendMessage(g, { image: { url: item.imageUrl }, caption: `🔥 *Check this out from ${v.businessName}!* \n\nOnly ₦${item.price}` });
        }
      }
    }
  }, 8 * 60 * 60 * 1000);
}

startAgent();
app.listen(process.env.PORT || 10000);
