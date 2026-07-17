// ====================================================================
// 1. ENVIRONMENT INITIALIZATION
// ====================================================================
require('dotenv').config();
const { 
  default: makeWASocket, 
  useMultiFileAuthState, 
  DisconnectReason, 
  delay,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore // Essential for fixing Bad MAC
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const mongoose = require('mongoose');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// ==========================================
// 2. DATABASE & SESSION UTILS
// ==========================================
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('🟢 MongoDB Connected'))
  .catch(err => console.error('🔴 MongoDB Error:', err));

// (Schemas remain the same as your provided code...)
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
const Vendor = mongoose.model('Vendor', VendorSchema);
const Group = mongoose.model('Group', new mongoose.Schema({ groupId: String, vendorPhoneNumber: String, status: String }));
const Transaction = mongoose.model('Transaction', new mongoose.Schema({ txRef: String, groupId: String, vendorId: mongoose.Schema.Types.ObjectId, amount: Number, status: String }));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

/**
 * SESSION EMERGENCY CLEANUP
 * This fixes the "Bad MAC" error by wiping corrupt session files
 */
function clearSession() {
  const sessionPath = path.join(__dirname, 'auth_session');
  if (fs.existsSync(sessionPath)) {
    console.log('🧹 Clearing corrupted session folder...');
    fs.rmSync(sessionPath, { recursive: true, force: true });
  }
}

// ==========================================
// 3. FLUTTERWAVE V4 UTILITIES (Same as your logic)
// ==========================================
const FLW_BASE_URL = process.env.FLW_BASE_URL || 'https://f4bexperience.flutterwave.com';
let accessToken = null;
let bankCache = [];

async function getAuthToken() {
  if (accessToken) return accessToken;
  try {
    const res = await axios.post('https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token', 
      new URLSearchParams({ client_id: process.env.FLW_CLIENT_ID, client_secret: process.env.FLW_CLIENT_SECRET, grant_type: 'client_credentials' }));
    accessToken = res.data.access_token;
    return accessToken;
  } catch (e) { console.error("Auth Error", e.message); return null; }
}

async function verifyAccountNumber(accountNumber, bankCode) {
    try {
      const token = await getAuthToken();
      const response = await axios.post(`${FLW_BASE_URL}/banks/account-resolve`, {
        account: { code: bankCode, number: accountNumber },
        currency: 'NGN'
      }, { headers: { 'Authorization': `Bearer ${token}` } });
      return response.data.data;
    } catch (error) { return null; }
}

// ====================================================================
// 4. WHATSAPP BOT ENGINE (FIXED FOR BAD MAC & RENDER)
// ====================================================================
const registrationState = new Map();
let hasRequestedCode = false;

async function startWhatsAppBot() {
  console.log('🚀 Starting WhatsApp Agent...');

  const { state, saveCreds } = await useMultiFileAuthState('auth_session');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: {
        creds: state.creds,
        // makeCacheableSignalKeyStore is critical to prevent key desync
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Mac OS', 'Chrome', '10.0.0'], 
    generateHighQualityLinkPreview: true,
    syncFullHistory: false, // Set to false to reduce "Bad MAC" risks from old messages
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Handle Pairing Code logic
    if (qr && !sock.authState.creds.registered && !hasRequestedCode) {
        hasRequestedCode = true;
        const pairingNumber = process.env.PAIRING_NUMBER;
        if (pairingNumber) {
            await delay(6000);
            try {
                const code = await sock.requestPairingCode(pairingNumber.replace(/[^0-9]/g, ''));
                console.log(`🔑 PAIRING CODE: ${code}`);
            } catch (e) {
                console.error("Pairing Error", e);
                hasRequestedCode = false;
            }
        }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      
      console.log(`🔴 Connection Lost: ${statusCode}. Reconnecting: ${shouldReconnect}`);

      if (statusCode === DisconnectReason.badSession || statusCode === 411) {
        console.error('❌ Corrupt Session Detected (Bad MAC). Performing Emergency Reset...');
        clearSession();
        startWhatsAppBot();
      } else if (shouldReconnect) {
        setTimeout(() => startWhatsAppBot(), 5000);
      } else {
        console.log('❌ Logged out. Please delete auth_session and restart.');
      }
    } else if (connection === 'open') {
      console.log('🟢 Agent Online & Ready!');
      hasRequestedCode = false;
    }
  });

  // MESSAGE HANDLER WITH ERROR WRAPPING
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try {
        // Prevent crashing on encrypted messages that can't be read
        if (!msg.message) continue;
        await handleWhatsAppFlow(sock, msg);
      } catch (err) {
        // This stops the "Bad MAC" from crashing the whole process
        if (err.message.includes('MAC')) {
            console.error('⚠️ Skipping a message due to decryption error (Bad MAC).');
        } else {
            console.error('🔴 Msg Error:', err);
        }
      }
    }
  });
}

// (The rest of your handleWhatsAppFlow and RegistrationWizard remain exactly the same...)
// Just ensure you call startWhatsAppBot() at the end.

async function handleWhatsAppFlow(sock, msg) {
    // ... Copy your existing handleWhatsAppFlow logic here ...
}

async function handleRegistrationWizard(sock, sender, text) {
    // ... Copy your existing handleRegistrationWizard logic here ...
}

startWhatsAppBot();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Port ${PORT}`));
