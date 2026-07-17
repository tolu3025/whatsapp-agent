require('dotenv').config();
const { 
  default: makeWASocket, 
  useMultiFileAuthState, 
  DisconnectReason, 
  delay,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  jidNormalizedUser,
  downloadContentFromMessage 
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const mongoose = require('mongoose');
const axios = require('axios');
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// ==========================================
// 1. DATABASE & CONFIG
// ==========================================
mongoose.connect(process.env.MONGODB_URI).then(() => console.log('🟢 MongoDB Connected'));

const Vendor = mongoose.model('Vendor', new mongoose.Schema({
  phoneNumber: { type: String, required: true, unique: true },
  businessName: String, 
  bankName: String,
  bankCode: String,
  accountNumber: String,
  accountName: String,
  businessDescription: String,
  faq: String,
  catalog: [{ imageUrl: String, caption: String }],
  isApproved: { type: Boolean, default: false }
}));

const REGISTRATION_TRIGGERS = ['register', 'i want to register', 'onboard'];
const registrationState = new Map();
let hasRequestedCode = false;

// Helper to fetch Bank Code from Flutterwave
async function getBankCode(bankName) {
    try {
        const res = await axios.get('https://api.flutterwave.com/v3/banks/NG', {
            headers: { Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}` }
        });
        const banks = res.data.data;
        const match = banks.find(b => b.name.toLowerCase().includes(bankName.toLowerCase()));
        return match ? match.code : null;
    } catch (e) {
        return null;
    }
}

// Helper to resolve Account Number
async function verifyBankAccount(accountNumber, bankCode) {
    try {
        const res = await axios.post('https://api.flutterwave.com/v3/accounts/resolve', 
        { account_number: accountNumber, account_bank: bankCode },
        { headers: { Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}` } });
        return res.data.data.account_name;
    } catch (e) {
        return null;
    }
}

// ==========================================
// 2. THE WHATSAPP ENGINE
// ==========================================
async function startWhatsAppBot() {
  console.log('📡 Fetching latest WhatsApp protocol version...');
  
  let version;
  try {
    const { version: latestVersion, isLatest } = await fetchLatestBaileysVersion();
    version = latestVersion;
    console.log(`✅ Using WA Version: ${version.join('.')} (Latest: ${isLatest})`);
  } catch (err) {
    version = [2, 3000, 1017578213];
  }

  const { state, saveCreds } = await useMultiFileAuthState('auth_session');
  
  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    printQRInTerminal: false,
    logger: pino({ level: 'error' }),
    browser: ['Ubuntu', 'Chrome', '114.0.5735.198'], 
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr && !sock.authState.creds.registered && !hasRequestedCode) {
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
      if (code === 405 || code === 401 || code === DisconnectReason.loggedOut) {
        if (fs.existsSync('./auth_session')) fs.rmSync('./auth_session', { recursive: true, force: true });
        setTimeout(startWhatsAppBot, 5000);
      } else {
        setTimeout(startWhatsAppBot, 10000);
      }
    } else if (connection === 'open') {
      console.log('🟢 SUCCESS: Agent is Online!');
      hasRequestedCode = false;
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = jidNormalizedUser(msg.key.remoteJid);
    const messageText = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
    const cleanInput = messageText.toLowerCase().trim();

    if (registrationState.has(sender)) {
      await handleRegistrationWizard(sock, sender, msg);
      return;
    }

    if (REGISTRATION_TRIGGERS.some(t => cleanInput.includes(t))) {
      registrationState.set(sender, { step: 'businessName' });
      await sock.sendMessage(sender, { text: 'Welcome! Let’s get you started.\n\nWhat is your *Business Name*?' });
    }
  });
}

async function handleRegistrationWizard(sock, sender, msg) {
  const state = registrationState.get(sender);
  const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
  const cleanText = text.toLowerCase().trim();

  switch (state.step) {
    case 'businessName':
      state.businessName = text;
      state.step = 'bank';
      registrationState.set(sender, state);
      await sock.sendMessage(sender, { text: 'Got it! What is your *Bank Name*? (e.g., GTBank, Zenith)' });
      break;

    case 'bank':
      const bankCode = await getBankCode(text);
      if (!bankCode) {
        await sock.sendMessage(sender, { text: 'Sorry, I couldn’t find that bank. Please type the full name correctly:' });
      } else {
        state.bankName = text;
        state.bankCode = bankCode;
        state.step = 'account';
        registrationState.set(sender, state);
        await sock.sendMessage(sender, { text: `Found ${text}. Now, send your *10-digit Account Number*:` });
      }
      break;

    case 'account':
      if (text.length !== 10) {
        await sock.sendMessage(sender, { text: 'Please send a valid 10-digit account number.' });
        return;
      }
      await sock.sendMessage(sender, { text: '🔍 Verifying account details with Flutterwave...' });
      const accountName = await verifyBankAccount(text, state.bankCode);
      if (!accountName) {
        await sock.sendMessage(sender, { text: '❌ Could not verify account. Please check the number and bank name, then try again:' });
        state.step = 'bank'; // Reset to bank step
      } else {
        state.accountNumber = text;
        state.accountName = accountName;
        state.step = 'confirmAccount';
        registrationState.set(sender, state);
        await sock.sendMessage(sender, { text: `Is this your account name?\n\n*${accountName}*\n\nReply *Yes* to continue or *No* to restart.` });
      }
      break;

    case 'confirmAccount':
      if (cleanText === 'yes') {
        state.step = 'description';
        registrationState.set(sender, state);
        await sock.sendMessage(sender, { text: 'Great! Now, please provide a short *Business Description* (What do you sell/do?):' });
      } else {
        state.step = 'bank';
        await sock.sendMessage(sender, { text: 'Let’s try again. What is your *Bank Name*?' });
      }
      break;

    case 'description':
      state.description = text;
      state.step = 'faq';
      registrationState.set(sender, state);
      await sock.sendMessage(sender, { text: 'Provide a common *FAQ* (e.g., "Do you deliver? Yes, nationwide."):' });
      break;

    case 'faq':
      state.faq = text;
      state.step = 'catalog';
      state.catalog = [];
      registrationState.set(sender, state);
      await sock.sendMessage(sender, { text: 'Now, let’s build your catalog. Please *Send a Picture* of your product with a *Caption*.\n\nType *Done* when you are finished uploading.' });
      break;

    case 'catalog':
      if (cleanText === 'done') {
        if (state.catalog.length === 0) {
            await sock.sendMessage(sender, { text: 'Please upload at least one product picture before typing Done.' });
            return;
        }
        // Save to DB
        const newVendor = new Vendor({
          phoneNumber: sender,
          businessName: state.businessName,
          bankName: state.bankName,
          bankCode: state.bankCode,
          accountNumber: state.accountNumber,
          accountName: state.accountName,
          businessDescription: state.description,
          faq: state.faq,
          catalog: state.catalog,
          isApproved: true
        });
        await newVendor.save();
        registrationState.delete(sender);
        await sock.sendMessage(sender, { text: `✅ *Onboarding Complete!*\n\nBusiness: ${state.businessName}\nAccount: ${state.accountName}\n\nYour profile is now active.` });
      } else if (msg.message?.imageMessage) {
        // Simple placeholder logic for image handling. 
        // In production, you would upload this to Cloudinary/S3.
        const caption = msg.message.imageMessage.caption || "Product Image";
        state.catalog.push({ imageUrl: "stored_locally_or_cloud", caption });
        registrationState.set(sender, state);
        await sock.sendMessage(sender, { text: `✅ Added to catalog! Send another image or type *Done* to finish.` });
      } else {
        await sock.sendMessage(sender, { text: 'Please send an *Image* or type *Done*.' });
      }
      break;
  }
}

startWhatsAppBot();

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
