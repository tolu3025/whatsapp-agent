// ====================================================================
// 1. ENVIRONMENT INITIALIZATION (MUST BE THE ABSOLUTE FIRST STEP)
// ====================================================================
require('dotenv').config();

const { 
  default: makeWASocket, 
  useMultiFileAuthState, 
  DisconnectReason, 
  delay,
  Browsers
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const mongoose = require('mongoose');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const express = require('express');

const app = express();
app.use(express.json());

// ==========================================
// 2. DATABASE SCHEMAS & INITIALIZATION
// ==========================================
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('🟢 MongoDB Connected successfully.'))
  .catch(err => console.error('🔴 MongoDB Connection Error:', err));

const VendorSchema = new mongoose.Schema({
  phoneNumber: { type: String, required: true, unique: true },
  businessName: { type: String, required: true },
  email: { type: String, required: true },
  bankCode: { type: String, required: true },
  bankName: { type: String, required: true },
  accountNumber: { type: String, required: true },
  accountName: { type: String, required: true },
  isApproved: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

const GroupSchema = new mongoose.Schema({
  groupId: { type: String, required: true, unique: true }, // JID from WhatsApp (@g.us)
  vendorPhoneNumber: { type: String, required: true },
  groupName: { type: String },
  status: { type: String, enum: ['onboarding', 'active', 'closed'], default: 'onboarding' },
  createdAt: { type: Date, default: Date.now }
});

const TransactionSchema = new mongoose.Schema({
  txRef: { type: String, required: true, unique: true },
  groupId: { type: String, required: true },
  vendorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', required: true },
  amount: { type: Number, required: true },
  status: { type: String, enum: ['pending', 'paid', 'disbursed', 'failed'], default: 'pending' },
  flutterwaveRef: { type: String },
  createdAt: { type: Date, default: Date.now }
});

const Vendor = mongoose.model('Vendor', VendorSchema);
const Group = mongoose.model('Group', GroupSchema);
const Transaction = mongoose.model('Transaction', TransactionSchema);

// Supabase Client Setup (Initialized safely after environment validation)
const supabase = createClient(
  process.env.SUPABASE_URL, 
  process.env.SUPABASE_SERVICE_KEY
);

// ==========================================
// 3. LIVE FLUTTERWAVE V4 UTILITIES
// ==========================================
const FLW_BASE_URL = process.env.FLW_BASE_URL || 'https://f4bexperience.flutterwave.com';
const FLW_CLIENT_ID = process.env.FLW_CLIENT_ID;
const FLW_CLIENT_SECRET = process.env.FLW_CLIENT_SECRET;

let accessToken = null;
let tokenExpiresAt = 0;
let bankCache = [];

/**
 * Dynamically obtains OAuth2 Token for Live Flutterwave v4.
 */
async function getAuthToken() {
  if (accessToken && Date.now() < tokenExpiresAt) {
    return accessToken;
  }

  try {
    const response = await axios.post(
      'https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token',
      new URLSearchParams({
        client_id: FLW_CLIENT_ID,
        client_secret: FLW_CLIENT_SECRET,
        grant_type: 'client_credentials',
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    if (response.data && response.data.access_token) {
      accessToken = response.data.access_token;
      tokenExpiresAt = Date.now() + (response.data.expires_in - 30) * 1000;
      return accessToken;
    }
    throw new Error('OAuth token generation returned empty payload.');
  } catch (error) {
    console.error('🔴 [FW v4 Auth Error]:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * Fetch and cache banks from Live Flutterwave v4.
 */
async function fetchAndCacheBanks() {
  try {
    const token = await getAuthToken();
    const response = await axios.get(`${FLW_BASE_URL}/banks?country=NG`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
    
    if (response.data && response.data.data) {
      bankCache = response.data.data.map(b => ({
        id: b.id,
        code: b.code,
        name: b.name.toUpperCase()
      }));
      console.log(`🏦 [FW v4 Live] Successfully cached ${bankCache.length} banks.`);
    }
  } catch (error) {
    console.error('🔴 Error fetching banks from Flutterwave v4:', error.response?.data || error.message);
  }
}

// Initial bank pull and refresh loop every 24 hours
fetchAndCacheBanks();
setInterval(fetchAndCacheBanks, 24 * 60 * 60 * 1000);

/**
 * Smart Match Bank Autocomplete Suggestion Tool
 */
function suggestBank(inputName) {
  if (!inputName) return null;
  const cleanInput = inputName.trim().toUpperCase();

  // Try direct match
  let match = bankCache.find(b => b.name === cleanInput || b.name.includes(cleanInput));
  if (match) return match;

  // Exact abbreviation dictionaries to match user prompts
  const abbreviations = {
    'GTB': 'GUARANTY TRUST',
    'GTBANK': 'GUARANTY TRUST',
    'UBA': 'UNITED BANK FOR AFRICA',
    'FCMB': 'FIRST CITY MONUMENT',
    'FBN': 'FIRST BANK',
    'VFD': 'VFD MICROFINANCE',
    'OPAY': 'OPAY',
    'PALMPAY': 'PALMPAY',
    'ACCESS': 'ACCESS BANK',
    'ZENITH': 'ZENITH BANK',
    'KUDA': 'KUDA'
  };

  if (abbreviations[cleanInput]) {
    const resolvedName = abbreviations[cleanInput];
    match = bankCache.find(b => b.name.includes(resolvedName));
    if (match) return match;
  }

  // Multi-word lookup matching
  const matches = bankCache.filter(b => {
    return cleanInput.split(' ').every(word => b.name.includes(word));
  });

  return matches.length > 0 ? matches[0] : null;
}

/**
 * Resolve Account Number using v4 payload rules on Live Endpoint
 */
async function verifyAccountNumber(accountNumber, bankCode) {
  try {
    const token = await getAuthToken();
    const response = await axios.post(`${FLW_BASE_URL}/banks/account-resolve`, {
      account: {
        code: bankCode,
        number: accountNumber
      },
      currency: 'NGN'
    }, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    if (response.data && response.data.data) {
      return response.data.data;
    }
    return null;
  } catch (error) {
    console.error('🔴 Account validation failed on FW v4 Live:', error.response?.data || error.message);
    return null;
  }
}

// ==========================================
// 4. WHATSAPP BOT ENGINE (BAILEYS V7 RC)
// ==========================================
const registrationState = new Map();

const REGISTRATION_TRIGGERS = [
  '!register',
  'register',
  'i want to register',
  'onboard me',
  'create vendor account',
  'sign up',
  'vendor registration',
  'want to onboard'
];

async function startWhatsAppBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_session');
  
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false, 
    logger: pino({ level: 'silent' }),
    // Use Ubuntu Chrome standard identity
    browser: Browsers.ubuntu('Chrome')
  });

  sock.ev.on('creds.update', saveCreds);

  // Connection State Update and QR/Pairing Logic
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Trigger pairing code ONLY when the socket successfully handshakes (emits the 'qr' state)
    if (qr && !sock.authState.creds.registered) {
      const pairingNumber = process.env.PAIRING_NUMBER;
      if (pairingNumber) {
        try {
          console.log(`⏳ Handshake successful. Generating pairing code for ${pairingNumber}...`);
          await delay(1500); // 1.5-second buffer to ensure raw socket registration is complete
          const code = await sock.requestPairingCode(pairingNumber.trim());
          console.log(`🔑 ================================================`);
          console.log(`🔑 ENTER THIS WHATSAPP PAIRING CODE: ${code}`);
          console.log(`🔑 ================================================`);
        } catch (err) {
          console.error('🔴 Error generating WhatsApp Pairing Code:', err.message || err);
        }
      } else {
        console.log('⚠️ PAIRING_NUMBER environment variable is missing.');
      }
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('🔴 Connection closed. Reconnecting...', shouldReconnect);
      
      if (shouldReconnect) {
        console.log('⏳ Waiting 10 seconds before attempting reconnection to prevent log spam...');
        setTimeout(() => {
          startWhatsAppBot();
        }, 10000);
      }
    } else if (connection === 'open') {
      console.log('🟢 WhatsApp Connection successfully opened!');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try {
        await handleWhatsAppFlow(sock, msg);
      } catch (err) {
        console.error('🔴 Message handler error:', err);
      }
    }
  });
}

// ==========================================
// 5. FLOW HANDLERS (ONBOARDING, GROUP, TRANSACTIONS)
// ==========================================
async function handleWhatsAppFlow(sock, msg) {
  const sender = msg.key.remoteJid;
  const isGroup = sender.endsWith('@g.us');
  const messageText = msg.message?.conversation || msg.message?.extendedTextMessage?.text;

  if (!messageText) return;
  const cleanInput = messageText.toLowerCase().trim();

  // --- PRIVATE CHATS: CONVERSATIONAL ONBOARDING WIZARD ---
  if (!isGroup) {
    if (registrationState.has(sender)) {
      await handleRegistrationWizard(sock, sender, messageText);
      return;
    }

    // Checking against all vendor registration phrases
    const isTriggerWord = REGISTRATION_TRIGGERS.some(trigger => cleanInput.includes(trigger));
    if (isTriggerWord) {
      const existingVendor = await Vendor.findOne({ phoneNumber: sender });
      if (existingVendor) {
        await sock.sendMessage(sender, { text: `You are already registered as *${existingVendor.businessName}*!` });
        return;
      }
      
      registrationState.set(sender, { step: 'businessName' });
      await sock.sendMessage(sender, { text: 'Welcome to Vendor Onboarding!\n\nPlease enter your *Business Name*:' });
      return;
    }
  }

  // --- GROUP CHATS: ESCROW MANAGEMENT ---
  if (isGroup) {
    if (cleanInput.startsWith('!init-escrow')) {
      const senderPhone = msg.key.participant || msg.key.fromMe;
      const vendor = await Vendor.findOne({ phoneNumber: senderPhone });
      
      if (!vendor) {
        await sock.sendMessage(sender, { text: '⚠️ Only registered vendors can initialize escrow groups. Send me a private message with *register* or *I want to register* to onboard.' });
        return;
      }

      let group = await Group.findOne({ groupId: sender });
      if (!group) {
        group = new Group({
          groupId: sender,
          vendorPhoneNumber: vendor.phoneNumber,
          groupName: 'Escrow Group',
          status: 'active'
        });
        await group.save();
        await sock.sendMessage(sender, { text: `✅ Escrow integration activated for this group under Vendor: *${vendor.businessName}*.\n\nBuyers can now pay securely using:\n*!buy [amount]*` });
      } else {
        await sock.sendMessage(sender, { text: 'ℹ️ Escrow session is already active in this group.' });
      }
    }

    if (cleanInput.startsWith('!buy')) {
      const group = await Group.findOne({ groupId: sender, status: 'active' });
      if (!group) {
        await sock.sendMessage(sender, { text: '⚠️ No active escrow session in this group. Ask the vendor to initiate using *!init-escrow*.' });
        return;
      }

      const args = cleanInput.split(' ');
      const amount = parseFloat(args[1]);

      if (isNaN(amount) || amount <= 0) {
        await sock.sendMessage(sender, { text: '⚠️ Invalid format. Use: *!buy [amount]* (e.g., !buy 15000)' });
        return;
      }

      const buyerPhone = msg.key.participant;
      const vendor = await Vendor.findOne({ phoneNumber: group.vendorPhoneNumber });
      const txRef = `TX-ESC-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

      const transaction = new Transaction({
        txRef,
        groupId: sender,
        vendorId: vendor._id,
        amount
      });
      await transaction.save();

      await sock.sendMessage(sender, { 
        text: `🛒 *Transaction Initialized!*\n\n*Merchant:* ${vendor.businessName}\n*Buyer:* @${buyerPhone.split('@')[0]}\n*Amount:* ₦${amount.toLocaleString()}\n*Ref:* ${txRef}\n\n_Complete your payment transfer to secure your order._`,
        mentions: [buyerPhone]
      });
    }
  }
}

/**
 * Handles Onboarding Steps Sequentially and Triggers Tasks list upon validation
 */
async function handleRegistrationWizard(sock, sender, text) {
  const state = registrationState.get(sender);

  switch (state.step) {
    case 'businessName':
      state.businessName = text.trim();
      state.step = 'email';
      registrationState.set(sender, state);
      await sock.sendMessage(sender, { text: 'Got it. Now enter your *Email Address*:' });
      break;

    case 'email':
      state.email = text.trim();
      state.step = 'bankName';
      registrationState.set(sender, state);
      await sock.sendMessage(sender, { text: 'Please type your *Bank Name* (e.g., Opay, Zenith, GTB, First Bank):' });
      break;

    case 'bankName':
      const matchedBank = suggestBank(text);
      if (!matchedBank) {
        await sock.sendMessage(sender, { text: '⚠️ Could not resolve that bank. Please type out your bank name again (e.g., Sterling, Access):' });
        return;
      }

      state.bankCode = matchedBank.code;
      state.bankName = matchedBank.name;
      state.step = 'accountNumber';
      registrationState.set(sender, state);
      await sock.sendMessage(sender, { text: `🏦 Auto-matched Bank: *${matchedBank.name}*\n\nNow, send your *10-Digit Account Number*:` });
      break;

    case 'accountNumber':
      const accountNo = text.trim();
      if (!/^\d{10}$/.test(accountNo)) {
        await sock.sendMessage(sender, { text: '⚠️ Account number must be exactly 10 digits. Try again:' });
        return;
      }

      await sock.sendMessage(sender, { text: '⏳ Verifying account details with Live Flutterwave...' });

      const resolvedAccount = await verifyAccountNumber(accountNo, state.bankCode);
      if (!resolvedAccount) {
        await sock.sendMessage(sender, { text: `❌ Verification failed. The account details did not match *${state.bankName}*. Please enter your correct 10-digit account number:` });
        return;
      }

      // Save verified Vendor data
      const newVendor = new Vendor({
        phoneNumber: sender,
        businessName: state.businessName,
        email: state.email,
        bankCode: state.bankCode,
        bankName: state.bankName,
        accountNumber: accountNo,
        accountName: resolvedAccount.account_name,
        isApproved: true
      });

      await newVendor.save();
      registrationState.delete(sender);

      // Welcome Message + Dynamic Onboarding Tasks
      await sock.sendMessage(sender, { 
        text: `🎉 *Onboarding Successful!*\n\n*Merchant:* ${newVendor.businessName}\n*Verified Settlement Name:* ${newVendor.accountName}\n*Bank Name:* ${newVendor.bankName}\n\nYour Live settlement account has been linked successfully.\n\n-----------------------------\n📋 *YOUR ONBOARDING TASKS*\n-----------------------------\n\nTo activate and test your escrow setup, complete the following steps:\n\n1️⃣ *Initialize Your Group Escrow*\nGo to any WhatsApp transactional group where you sell products and type:\n👉 \`!init-escrow\`\n\n2️⃣ *Simulate a Customer Purchase*\nHave a buyer in that group (or your own secondary number) initiate a deal by typing:\n👉 \`!buy 10000\` (replacing 10000 with any test transaction amount).\n\n3️⃣ *Review Your Dashboard Insights*\nLog in to your Supabase merchant panel to verify that your business profile and newly initialized transaction logs sync immediately.\n\nLet me know if you run into any issues during setup!` 
      });
      break;
  }
}

// Start WhatsApp Connection Setup
startWhatsAppBot();

// Express Server Setup
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
