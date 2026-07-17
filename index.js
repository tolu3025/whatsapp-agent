require('dotenv').config();
const { 
  default: makeWASocket, 
  useMultiFileAuthState, 
  DisconnectReason, 
  delay,
  fetchLatestBaileysVersion, // Critical for 405
  makeCacheableSignalKeyStore,
  jidNormalizedUser 
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
  accountNumber: String, 
  isApproved: { type: Boolean, default: false }
}));

const REGISTRATION_TRIGGERS = ['register', 'i want to register', 'onboard'];
const registrationState = new Map();
let hasRequestedCode = false;

// ==========================================
// 2. THE WHATSAPP ENGINE (FIXED FOR 405)
// ==========================================
async function startWhatsAppBot() {
  console.log('📡 Fetching latest WhatsApp protocol version...');
  
  let version;
  try {
    // This fetches the actual latest version from WhatsApp servers
    const { version: latestVersion, isLatest } = await fetchLatestBaileysVersion();
    version = latestVersion;
    console.log(`✅ Using WA Version: ${version.join('.')} (Latest: ${isLatest})`);
  } catch (err) {
    console.log('⚠️ Failed to fetch version, using fallback.');
    version = [2, 3000, 1017578213]; // Safe fallback high version
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
    // Changing browser to Linux/Chrome helps bypass Render IP flags
    browser: ['Ubuntu', 'Chrome', '114.0.5735.198'], 
    syncFullHistory: false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 0,
    keepAliveIntervalMs: 10000,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !sock.authState.creds.registered && !hasRequestedCode) {
      hasRequestedCode = true;
      const pairingNumber = process.env.PAIRING_NUMBER;
      if (pairingNumber) {
        console.log(`⏳ Requesting Pairing Code for: ${pairingNumber}`);
        await delay(10000); // 10 second delay is safer for pairing
        try {
          const code = await sock.requestPairingCode(pairingNumber.replace(/[^0-9]/g, ''));
          console.log(`🔑 YOUR PAIRING CODE: ${code}`);
        } catch (e) {
          console.error("Pairing Error:", e.message);
          hasRequestedCode = false;
        }
      }
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log(`🔴 Connection Closed (Code: ${code}).`);

      // If session is corrupt or rejected, clear and restart
      if (code === 405 || code === 401 || code === DisconnectReason.loggedOut) {
        console.log('🧹 Session invalid. Clearing auth_session folder...');
        if (fs.existsSync('./auth_session')) {
            fs.rmSync('./auth_session', { recursive: true, force: true });
        }
        setTimeout(startWhatsAppBot, 5000);
      } else {
        console.log('🔄 Attempting standard reconnect in 10s...');
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

    console.log(`📩 [${sender}]: ${cleanInput}`);

    if (registrationState.has(sender)) {
      await handleRegistrationWizard(sock, sender, messageText);
      return;
    }

    if (REGISTRATION_TRIGGERS.some(t => cleanInput.includes(t))) {
      registrationState.set(sender, { step: 'businessName' });
      await sock.sendMessage(sender, { text: 'Welcome! Let’s get you started.\n\nWhat is your *Business Name*?' });
    }
  });
}

async function handleRegistrationWizard(sock, sender, text) {
  const state = registrationState.get(sender);
  if (state.step === 'businessName') {
    state.businessName = text;
    state.step = 'bank';
    registrationState.set(sender, state);
    await sock.sendMessage(sender, { text: 'Got it! Now, type your *Bank Name*:' });
  } else if (state.step === 'bank') {
    state.bankName = text;
    state.step = 'account';
    registrationState.set(sender, state);
    await sock.sendMessage(sender, { text: 'Send your *10-digit Account Number*:' });
  } else if (state.step === 'account') {
    const newVendor = new Vendor({
      phoneNumber: sender,
      businessName: state.businessName,
      bankName: state.bankName,
      accountNumber: text,
      isApproved: true
    });
    await newVendor.save();
    registrationState.delete(sender);
    await sock.sendMessage(sender, { text: `✅ *Onboarding Complete!*\n\nBusiness: ${state.businessName}\nWelcome to the platform.` });
  }
}

// Start
startWhatsAppBot();

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
