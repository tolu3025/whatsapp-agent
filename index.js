// ====================================================================
// 1. MODULES & CONFIGURATION
// ====================================================================
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

const app = express();
app.use(express.json());

// ====================================================================
// 2. DATABASE MODELS
// ====================================================================
mongoose.connect(process.env.MONGODB_URI);

const VendorSchema = new mongoose.Schema({
  phoneNumber: { type: String, required: true, unique: true },
  businessName: String,
  email: String,
  bankCode: String,
  accountNumber: String,
  flwSubaccountId: String, // Flutterwave ID for split payments
  catalog: [{ imageUrl: String, caption: String, price: Number }],
  faqs: String,
  description: String,
  activeGroups: [String],
  onboardingStep: { type: String, default: 'none' },
  isApproved: { type: Boolean, default: false }
});

const TransactionSchema = new mongoose.Schema({
  txRef: { type: String, unique: true },
  customerPhone: String,
  vendorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor' },
  amount: Number,
  status: { type: String, enum: ['pending', 'success', 'expired'], default: 'pending' },
  virtualAccount: String,
  createdAt: { type: Date, default: Date.now }
});

const Vendor = mongoose.model('Vendor', VendorSchema);
const Transaction = mongoose.model('Transaction', TransactionSchema);

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ====================================================================
// 3. FLUTTERWAVE V4 SERVICE (OAUTH & SPLIT PAYMENTS)
// ====================================================================
class FlutterwaveService {
  constructor() {
    this.accessToken = null;
    this.tokenExpiry = 0;
  }

  async getAuthToken() {
    if (this.accessToken && Date.now() < this.tokenExpiry) return this.accessToken;
    const res = await axios.post('https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token', 
      new URLSearchParams({
        client_id: process.env.FLW_CLIENT_ID,
        client_secret: process.env.FLW_CLIENT_SECRET,
        grant_type: 'client_credentials'
      }));
    this.accessToken = res.data.access_token;
    this.tokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
    return this.accessToken;
  }

  /**
   * Create a Subaccount for a Vendor to enable split payments
   */
  async createSubaccount(vendor) {
    const token = await this.getAuthToken();
    const res = await axios.post(`${process.env.FLW_BASE_URL}/subaccounts`, {
      account_bank: vendor.bankCode,
      account_number: vendor.accountNumber,
      business_name: vendor.businessName,
      business_email: vendor.email,
      split_type: "percentage",
      split_value: 0.03 // Your 3% platform commission
    }, { headers: { Authorization: `Bearer ${token}` } });
    return res.data.data.subaccount_id;
  }

  /**
   * Generate a temporary (dynamic) virtual account for a specific deal
   */
  async createTemporaryAccount(amount, email, subaccountId) {
    const token = await this.getAuthToken();
    const txRef = `KUK-${Date.now()}`;
    const res = await axios.post(`${process.env.FLW_BASE_URL}/virtual-account-numbers`, {
      email: email,
      amount: amount,
      currency: "NGN",
      tx_ref: txRef,
      is_permanent: false,
      frequency: 1, // Single use
      subaccounts: [{ id: subaccountId }] // Splits money automatically
    }, { headers: { Authorization: `Bearer ${token}` } });
    return { ...res.data.data, txRef };
  }
}
const flw = new FlutterwaveService();

// ====================================================================
// 4. THE AI PA (SALES LOGIC & GUARDRAILS)
// ====================================================================
async function getAIReponse(customerMessage, vendor) {
  const prompt = `You are a jovial, enthusiastic sales PA for "${vendor.businessName}". 
  Your job: Chat with customers, promote products, and close deals.
  Tone: Friendly, Nigerian-English (jovial), helpful.
  
  Business Bio: ${vendor.description}
  FAQs: ${vendor.faqs}
  Catalog: ${JSON.stringify(vendor.catalog)}

  STRICT SECURITY RULES:
  1. If the customer wants to buy, calculate the total price.
  2. If they are ready to pay, respond ONLY with "TRIGGER_PAYMENT:[amount]".
  3. Never promise prices lower than the catalog.
  4. If asked about politics/religion, jovially redirect to the products.`;

  const completion = await openai.chat.completions.create({
    model: "gpt-3.5-turbo",
    messages: [{ role: "system", content: prompt }, { role: "user", content: customerMessage }],
  });

  return completion.choices[0].message.content;
}

// ====================================================================
// 5. WHATSAPP BOT & AUTOMATION
// ====================================================================
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
    browser: ['Mac OS', 'Chrome', '10.0.0'],
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = jidNormalizedUser(msg.key.remoteJid);
    const text = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || "");

    // Logic to find vendor (based on the group or if they are DMing the vendor's bot)
    const vendor = await Vendor.findOne({ isApproved: true }); // Simplification for demo

    // 1. Simulate Typing (Guardrail against bans)
    await sock.sendPresenceUpdate('composing', sender);
    await delay(2000);

    const aiResponse = await getAIReponse(text, vendor);

    if (aiResponse.includes("TRIGGER_PAYMENT:")) {
      const amount = aiResponse.split(":")[1].trim();
      
      await sock.sendMessage(sender, { text: "Coming right up! Generating your secure one-time payment account... ✨" });

      const payData = await flw.createTemporaryAccount(amount, "sales@vendor.com", vendor.flwSubaccountId);
      
      await new Transaction({
        txRef: payData.txRef,
        customerPhone: sender,
        vendorId: vendor._id,
        amount: amount,
        virtualAccount: payData.account_number
      }).save();

      const payMsg = `🛒 *Deal Ready!*\n\nPlease transfer ₦${amount} to:\n\n` +
                     `🏦 Bank: *${payData.bank_name}*\n` +
                     `🔢 Account: *${payData.account_number}*\n\n` +
                     `I'm standing by to confirm your order the moment you're done! 😊`;
      await sock.sendMessage(sender, { text: payMsg });
    } else {
      await sock.sendMessage(sender, { text: aiResponse });
    }
  });

  // ====================================================================
  // 6. 8-HOUR CATALOG BROADCASTER (ANTI-SPAM)
  // ====================================================================
  setInterval(async () => {
    const vendors = await Vendor.find({ isApproved: true });
    for (const vendor of vendors) {
      if (vendor.catalog.length > 0) {
        const item = vendor.catalog[Math.floor(Math.random() * vendor.catalog.length)];
        for (const gid of vendor.activeGroups) {
          // Gaussian Jitter delay (simulates human timing)
          const jitter = Math.floor(Math.random() * 10000) + 5000;
          await delay(jitter);
          await sock.sendMessage(gid, { 
            image: { url: item.imageUrl }, 
            caption: `📢 *VENDOR SPOTLIGHT: ${vendor.businessName}*\n\n${item.caption}\nPrice: ₦${item.price}\n\nTag me to buy now! 🛍️`
          });
        }
      }
    }
  }, 8 * 60 * 60 * 1000);

  return sock;
}

// ====================================================================
// 7. SUPABASE REALTIME OBSERVER (PAYMENT CONFIRMATION)
// ====================================================================
async function initSupabaseObserver(sock) {
  supabase
    .channel('transactions')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'transactions' }, async (payload) => {
      const { tx_ref, status, customer_phone } = payload.new;
      
      if (status === 'success') {
        const tx = await Transaction.findOne({ txRef: tx_ref, status: 'pending' });
        if (tx) {
          tx.status = 'success';
          await tx.save();

          await sock.sendMessage(tx.customerPhone, { 
            text: `💰 *PAYMENT CONFIRMED!*\n\nThank you! Your order has been placed successfully. The vendor has been notified to start shipping. 🥳✨` 
          });
        }
      }
    })
    .subscribe();
}

// ====================================================================
// 8. INITIALIZATION
// ====================================================================
const mainSock = startAgent();
mainSock.then(sock => initSupabaseObserver(sock));

app.listen(process.env.PORT || 10000);
