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

// Helpers for Flutterwave
async function getBankCode(bankName) {
    try {
        const res = await axios.get('https://api.flutterwave.com/v3/banks/NG', {
            headers: { Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}` }
        });
        const match = res.data.data.find(b => b.name.toLowerCase().includes(bankName.toLowerCase()));
        return match ? match.code : null;
    } catch (e) { return null; }
}

async function verifyBankAccount(accountNumber, bankCode) {
    try {
        const res = await axios.post('https://api.flutterwave.com/v3/accounts/resolve', 
        { account_number: accountNumber, account_bank: bankCode },
        { headers: { Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}` } });
        return res.data.data.account_name;
    } catch (e) { return null; }
}

// ==========================================
// 2. THE WHATSAPP ENGINE (DEBUGGED LINKING)
// ==========================================
async function startWhatsAppBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_session');
  const { version, isLatest } = await fetchLatestBaileysVersion();
  
  console.log(`📡 Connecting with WA v${version.join('.')} (Latest: ${isLatest})`);

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'error' }),
    printQRInTerminal: false,
    auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    // FIX: More realistic browser string to bypass Render IP flags
    browser: ["Ubuntu", "Chrome", "120.0.6099.129"],
    markOnlineOnConnect: true,
    generateHighQualityLinkPreview: true,
    syncFullHistory: false, // Prevents session overload
    linkPreviewHighQuality: true,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Logic for Pairing Code
    if (!sock.authState.creds.registered && !hasRequestedCode) {
        hasRequestedCode = true;
        const pairingNumber = process.env.PAIRING_NUMBER;
        
        if (pairingNumber) {
            console.log(`⏳ Getting pairing code for ${pairingNumber}...`);
            await delay(8000); // Wait for socket to stabilize
            try {
                const code = await sock.requestPairingCode(pairingNumber.replace(/[^0-9]/g, ''));
                console.log(`🔑 YOUR PAIRING CODE: ${code}`);
            } catch (e) {
                console.error("❌ Failed to get pairing code:", e.message);
                hasRequestedCode = false;
            }
        }
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log(`🔴 Connection closed. Reason code: ${code}`);

      // If linking failed (401/405/428), clear session and retry fresh
      if (code === DisconnectReason.loggedOut || code === 401 || code === 405) {
        console.log('🧹 Clearing corrupt session for fresh retry...');
        if (fs.existsSync('./auth_session')) fs.rmSync('./auth_session', { recursive: true, force: true });
        hasRequestedCode = false;
        setTimeout(startWhatsAppBot, 5000);
      } else {
        setTimeout(startWhatsAppBot, 10000);
      }
    } else if (connection === 'open') {
      console.log('🟢 SUCCESS: Agent is Online!');
      hasRequestedCode = false;
    }
  });

  // Message Handling Logic
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

// ==========================================
// 3. ONBOARDING WIZARD (FLUTTERWAVE + TASKS)
// ==========================================
async function handleRegistrationWizard(sock, sender, msg) {
    const state = registrationState.get(sender);
    const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
    const cleanText = text.toLowerCase().trim();
  
    switch (state.step) {
      case 'businessName':
        state.businessName = text;
        state.step = 'bank';
        registrationState.set(sender, state);
        await sock.sendMessage(sender, { text: 'Got it! What is your *Bank Name*? (e.g., GTBank, UBA)' });
        break;
  
      case 'bank':
        const bankCode = await getBankCode(text);
        if (!bankCode) {
          await sock.sendMessage(sender, { text: '❌ Could not find that bank. Please type the full name correctly:' });
        } else {
          state.bankName = text;
          state.bankCode = bankCode;
          state.step = 'account';
          registrationState.set(sender, state);
          await sock.sendMessage(sender, { text: `Found it. Now, send your *10-digit Account Number*:` });
        }
        break;
  
      case 'account':
        if (text.length !== 10) {
          await sock.sendMessage(sender, { text: 'Please send a valid 10-digit number.' });
          return;
        }
        await sock.sendMessage(sender, { text: '🔍 Verifying account with Flutterwave...' });
        const accountName = await verifyBankAccount(text, state.bankCode);
        if (!accountName) {
          await sock.sendMessage(sender, { text: '❌ Verification failed. Check details and type your *Bank Name* again:' });
          state.step = 'bank';
        } else {
          state.accountNumber = text;
          state.accountName = accountName;
          state.step = 'confirmAccount';
          registrationState.set(sender, state);
          await sock.sendMessage(sender, { text: `Is this you?\n\n*${accountName}*\n\nReply *Yes* to continue or *No* to restart.` });
        }
        break;
  
      case 'confirmAccount':
        if (cleanText === 'yes') {
          state.step = 'description';
          registrationState.set(sender, state);
          await sock.sendMessage(sender, { text: 'Verified! Now, provide a brief *Business Description*:' });
        } else {
          state.step = 'bank';
          await sock.sendMessage(sender, { text: 'Restarting. What is your *Bank Name*?' });
        }
        break;
  
      case 'description':
        state.description = text;
        state.step = 'faq';
        registrationState.set(sender, state);
        await sock.sendMessage(sender, { text: 'Great. Provide a common *FAQ* (Question & Answer):' });
        break;
  
      case 'faq':
        state.faq = text;
        state.step = 'catalog';
        state.catalog = [];
        registrationState.set(sender, state);
        await sock.sendMessage(sender, { text: 'Final Step: *Send a Photo* of your product with a caption.\n\nType *Done* when you have finished adding items.' });
        break;
  
      case 'catalog':
        if (cleanText === 'done') {
            if (state.catalog.length === 0) return sock.sendMessage(sender, { text: 'Please send at least one image first.' });
            
            const newVendor = new Vendor({
                phoneNumber: sender,
                businessName: state.businessName,
                bankName: state.bankName,
                accountNumber: state.accountNumber,
                accountName: state.accountName,
                businessDescription: state.description,
                faq: state.faq,
                catalog: state.catalog,
                isApproved: true
            });
            await newVendor.save();
            registrationState.delete(sender);
            await sock.sendMessage(sender, { text: `✅ *Onboarding Complete!*\n\nWelcome aboard, ${state.businessName}.` });
        } else if (msg.message?.imageMessage) {
            const caption = msg.message.imageMessage.caption || "No caption";
            state.catalog.push({ imageUrl: "Pending Upload", caption });
            registrationState.set(sender, state);
            await sock.sendMessage(sender, { text: '✅ Item added! Send another or type *Done*.' });
        }
        break;
    }
}

startWhatsAppBot();

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
