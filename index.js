require('dotenv').config();
const { 
  default: makeWASocket, 
  useMultiFileAuthState, 
  DisconnectReason, 
  delay,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  jidNormalizedUser // Added for ID cleaning
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const mongoose = require('mongoose');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const express = require('express');
const fs = require('fs');

const app = express();
app.use(express.json());

// ==========================================
// 1. DATABASE SETUP
// ==========================================
mongoose.connect(process.env.MONGODB_URI).then(() => console.log('🟢 MongoDB Connected'));

const Vendor = mongoose.model('Vendor', new mongoose.Schema({
  phoneNumber: { type: String, required: true, unique: true },
  businessName: String, email: String, bankCode: String, bankName: String,
  accountNumber: String, accountName: String, isApproved: { type: Boolean, default: false }
}));

// ==========================================
// 2. WHATSAPP BOT ENGINE (FIXED)
// ==========================================
const registrationState = new Map();
const REGISTRATION_TRIGGERS = ['register', 'i want to register', 'onboard', 'setup vendor'];
let hasRequestedCode = false;

async function startWhatsAppBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_session');
  
  // Use a hardcoded high-version to bypass 405 errors
  const version = [2, 3000, 1015901307]; 

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    printQRInTerminal: false,
    logger: pino({ level: 'error' }), // Only log errors to keep Render logs clean
    browser: ['Mac OS', 'Chrome', '110.0.5481.177'], // Modern Chrome fingerprint
    syncFullHistory: false,
    markOnlineOnConnect: true,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !sock.authState.creds.registered && !hasRequestedCode) {
      hasRequestedCode = true;
      const pairingNumber = process.env.PAIRING_NUMBER;
      if (pairingNumber) {
        await delay(5000);
        try {
          const code = await sock.requestPairingCode(pairingNumber.replace(/[^0-9]/g, ''));
          console.log(`🔑 NEW PAIRING CODE: ${code}`);
        } catch (e) { hasRequestedCode = false; }
      }
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log(`🔴 Connection Closed (Code: ${code}). Reconnecting...`);
      if (code !== DisconnectReason.loggedOut) {
        setTimeout(startWhatsAppBot, 5000);
      }
    } else if (connection === 'open') {
      console.log('🟢 AGENT ONLINE: Standing by for messages...');
      hasRequestedCode = false;
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    // 1. CLEAN THE DATA
    const sender = jidNormalizedUser(msg.key.remoteJid); // Essential: converts 234...:1 to 234...
    const messageText = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
    const cleanInput = messageText.toLowerCase().trim();

    console.log(`📩 Message from [${sender}]: "${cleanInput}"`); // DEBUG LOG

    // 2. CHECK REGISTRATION FLOW
    if (registrationState.has(sender)) {
      await handleRegistrationWizard(sock, sender, messageText);
      return;
    }

    // 3. CHECK TRIGGER WORDS
    const isTrigger = REGISTRATION_TRIGGERS.some(t => cleanInput.includes(t));
    if (isTrigger) {
      const vendor = await Vendor.findOne({ phoneNumber: sender });
      if (vendor) {
        await sock.sendMessage(sender, { text: `Hello! You are already registered as *${vendor.businessName}*.` });
      } else {
        registrationState.set(sender, { step: 'businessName' });
        await sock.sendMessage(sender, { text: 'Welcome! Let’s get you started.\n\nWhat is your *Business Name*?' });
      }
    }
  });
}

// ==========================================
// 3. REGISTRATION WIZARD
// ==========================================
async function handleRegistrationWizard(sock, sender, text) {
  const state = registrationState.get(sender);

  if (state.step === 'businessName') {
    state.businessName = text;
    state.step = 'bank';
    registrationState.set(sender, state);
    await sock.sendMessage(sender, { text: 'Got it! Now, please type your *Bank Name* (e.g. Opay, GTB, Zenith):' });
  } 
  else if (state.step === 'bank') {
    state.bankName = text;
    state.step = 'account';
    registrationState.set(sender, state);
    await sock.sendMessage(sender, { text: 'Finally, send your *10-digit Account Number*:' });
  }
  else if (state.step === 'account') {
    // Basic verification simulation for brevity
    const newVendor = new Vendor({
      phoneNumber: sender,
      businessName: state.businessName,
      bankName: state.bankName,
      accountNumber: text,
      isApproved: true
    });
    await newVendor.save();
    registrationState.delete(sender);
    await sock.sendMessage(sender, { text: `✅ *Registration Complete!*\n\nBusiness: ${state.businessName}\nStatus: Active` });
  }
}

startWhatsAppBot();

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
