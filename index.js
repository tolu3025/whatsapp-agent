// ====================================================================
// 1. ENVIRONMENT INITIALIZATION
// ====================================================================
require('dotenv').config();

const { 
  default: makeWASocket, 
  DisconnectReason, 
  delay,
  fetchLatestBaileysVersion,
  BufferJSON,         
  initAuthCreds,       
  proto,
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

const AuthStateSchema = new mongoose.Schema({
  _id: { type: String, required: true }, 
  data: { type: String, required: true }  
});
const AuthState = mongoose.model('AuthState', AuthStateSchema);

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
  groupId: { type: String, required: true, unique: true },
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

const supabase = createClient(
  process.env.SUPABASE_URL, 
  process.env.SUPABASE_SERVICE_KEY
);

// ====================================================================
// 3. CUSTOM MONGO AUTH STATE HANDLER
// ====================================================================
async function useMongoAuthState() {
  const writeData = async (data, id) => {
    const serialized = JSON.stringify(data, BufferJSON.replacer);
    await AuthState.replaceOne({ _id: id }, { data: serialized }, { upsert: true });
  };

  const readData = async (id) => {
    const doc = await AuthState.findById(id);
    if (!doc) return null;
    return JSON.parse(doc.data, BufferJSON.reviver);
  };

  const removeData = async (id) => {
    await AuthState.deleteOne({ _id: id });
  };

  const creds = (await readData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category of Object.keys(data)) {
            for (const id of Object.keys(data[category])) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              if (value) {
                tasks.push(writeData(value, key));
              } else {
                tasks.push(removeData(key));
              }
            }
          }
          await Promise.all(tasks);
        }
      }
    },
    saveCreds: async () => {
      await writeData(creds, 'creds');
    }
  };
}

// ==========================================
// 4. FLUTTERWAVE UTILITIES
// ==========================================
const FLW_BASE_URL = process.env.FLW_BASE_URL || 'https://f4bexperience.flutterwave.com';
const FLW_CLIENT_ID = process.env.FLW_CLIENT_ID;
const FLW_CLIENT_SECRET = process.env.FLW_CLIENT_SECRET;

let accessToken = null;
let tokenExpiresAt = 0;
let bankCache = [];

async function getAuthToken() {
  if (accessToken && Date.now() < tokenExpiresAt) return accessToken;
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
    accessToken = response.data.access_token;
    tokenExpiresAt = Date.now() + (response.data.expires_in - 30) * 1000;
    return accessToken;
  } catch (error) {
    console.error('🔴 [FW Auth Error]:', error.message);
    throw error;
  }
}

async function fetchAndCacheBanks() {
  try {
    const token = await getAuthToken();
    const response = await axios.get(`${FLW_BASE_URL}/banks?country=NG`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    bankCache = response.data.data.map(b => ({ code: b.code, name: b.name.toUpperCase() }));
    console.log(`🏦 Cached ${bankCache.length} banks.`);
  } catch (error) { console.error('🔴 Error fetching banks'); }
}

fetchAndCacheBanks();
setInterval(fetchAndCacheBanks, 24 * 60 * 60 * 1000);

function suggestBank(inputName) {
  const cleanInput = inputName.trim().toUpperCase();
  return bankCache.find(b => b.name === cleanInput || b.name.includes(cleanInput)) || null;
}

async function verifyAccountNumber(accountNumber, bankCode) {
  try {
    const token = await getAuthToken();
    const response = await axios.post(`${FLW_BASE_URL}/banks/account-resolve`, 
      { account: { code: bankCode, number: accountNumber }, currency: 'NGN' },
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    return response.data.data;
  } catch (error) { return null; }
}

// ==========================================
// 5. WHATSAPP BOT ENGINE
// ==========================================
let hasRequestedCode = false;

async function startWhatsAppBot() {
  console.log('🚀 Initializing WhatsApp connection...');
  const { state, saveCreds } = await useMongoAuthState();
  
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: Browsers.macOS('Chrome'), 
    name: 'kukatai-agent',
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !sock.authState.creds.registered && !hasRequestedCode) {
      hasRequestedCode = true; 
      const code = await sock.requestPairingCode(process.env.PAIRING_NUMBER.replace(/[^0-9]/g, ''));
      console.log(`🔑 ================================================`);
      console.log(`🔑 ENTER THIS WHATSAPP PAIRING CODE: ${code}`);
      console.log(`🔑 ================================================`);
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const isUnregistered = !sock.authState.creds.registered;
      const shouldReconnect = isUnregistered || (statusCode !== DisconnectReason.loggedOut);
      
      console.log(`🔴 Connection closed. Code: ${statusCode}. Reconnecting: ${shouldReconnect}`);
      hasRequestedCode = false;

      if (statusCode === 411 || statusCode === 412) {
        await AuthState.deleteMany({});
        startWhatsAppBot();
      } else if (shouldReconnect) {
        setTimeout(startWhatsAppBot, 5000);
      }
    } else if (connection === 'open') {
      console.log('🟢 WhatsApp Connection Opened!');
      hasRequestedCode = false;
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
       // Logic to handle flows omitted for brevity (same as previous)
    }
  });
}

startWhatsAppBot();
app.listen(process.env.PORT || 3000);
