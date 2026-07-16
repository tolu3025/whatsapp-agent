const express = require('express');
const { 
    default: makeWASocket, 
    DisconnectReason,
    delay,
    Browsers,                     
    fetchLatestWaWebVersion,
    initAuthCreds,
    BufferJSON,
    proto
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const mongoose = require('mongoose');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// ==========================================
// 🗄️ MONGOOSE SCHEMAS
// ==========================================

const VendorSchema = new mongoose.Schema({
    phoneNumber: { type: String, required: true, unique: true }, 
    businessName: { type: String },
    bankCode: { type: String },
    accountNumber: { type: String },
    accountName: { type: String },
    subaccountId: { type: String },
    dashboardBalance: { type: Number, default: 0 },
    onboardingStep: { type: String, default: "IDLE" },
    tempData: { type: Object, default: {} },
    targetGroupId: { type: String }, 
    groupRules: { type: String, default: "Be polite, showcase our products, and tell them to DM us to order." },
    customKeywords: { type: [String], default: ["price", "cost", "buy", "order", "available"] },
    lastGroupBlast: { type: Date, default: Date.now },
    blastIntervalHours: { type: Number, default: 6 }, 
    savedPromoImages: { type: [String], default: [] } 
}, { timestamps: true });

const Vendor = mongoose.models.Vendor || mongoose.model('Vendor', VendorSchema);
const BaileysAuthSchema = new mongoose.Schema({
    keyId: { type: String, required: true, unique: true },
    value: { type: String, required: true }
});
const BaileysAuth = mongoose.models.BaileysAuth || mongoose.model('BaileysAuth', BaileysAuthSchema);

async function useMongooseAuthState(sessionId) {
    const writeData = async (data, id) => {
        const key = `${sessionId}:${id}`;
        const value = JSON.stringify(data, BufferJSON.replacer);
        await BaileysAuth.updateOne({ keyId: key }, { value }, { upsert: true });
    };
    const readData = async (id) => {
        const key = `${sessionId}:${id}`;
        const doc = await BaileysAuth.findOne({ keyId: key });
        if (!doc) return null;
        return JSON.parse(doc.value, BufferJSON.reviver);
    };
    const removeData = async (id) => {
        const key = `${sessionId}:${id}`;
        await BaileysAuth.deleteOne({ keyId: key });
    };
    let creds = await readData('creds');
    if (!creds) { creds = initAuthCreds(); await writeData(creds, 'creds'); }
    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async (id) => {
                        let value = await readData(`${type}-${id}`);
                        if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            if (value) tasks.push(writeData(value, key));
                            else tasks.push(removeData(key));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: async () => { await writeData(creds, 'creds'); }
    };
}

// ==========================================
// 🌐 EXPRESS & FLUTTERWAVE
// ==========================================
const app = express();
app.use(express.json());
app.get('/', (req, res) => res.status(200).send("KukaPay Active."));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🌐 Express health server on Port ${PORT}`));

const COMMON_BANKS = {
    "access": "044", "gtb": "058", "zenith": "057", "uba": "033", 
    "opay": "999992", "kuda": "50211", "moniepoint": "50515", "palmpay": "999991"
};

const isV4Enabled = () => !!(process.env.FLW_CLIENT_ID && process.env.FLW_CLIENT_SECRET);
async function getFlutterwaveV4Token() {
    const url = 'https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token';
    const payload = new URLSearchParams({ client_id: process.env.FLW_CLIENT_ID, client_secret: process.env.FLW_CLIENT_SECRET, grant_type: 'client_credentials' });
    const response = await axios.post(url, payload.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    return response.data.access_token;
}

async function resolveBankAccount(bankCode, accountNumber) {
    if (isV4Enabled()) {
        const token = await getFlutterwaveV4Token();
        const response = await axios.post(`${process.env.NODE_ENV === 'production' ? 'https://f4bexperience.flutterwave.com' : 'https://developersandbox-api.flutterwave.com'}/banks/account-resolve`, { account: { code: bankCode, number: accountNumber }, currency: "NGN" }, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
        return { success: true, accountName: response.data.data.account_name };
    } else {
        const response = await axios.post('https://api.flutterwave.com/v3/accounts/resolve', { account_number: accountNumber, account_bank: bankCode }, { headers: { Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`, 'Content-Type': 'application/json' } });
        return { success: true, accountName: response.data.data.account_name };
    }
}

async function createSubaccount(vendorTemp) {
    if (isV4Enabled()) {
        const token = await getFlutterwaveV4Token();
        const response = await axios.post(`${process.env.NODE_ENV === 'production' ? 'https://f4bexperience.flutterwave.com' : 'https://developersandbox-api.flutterwave.com'}/payout-subaccounts`, { account_bank: vendorTemp.bankCode, account_number: vendorTemp.accountNumber, business_name: vendorTemp.businessName, business_email: `${vendorTemp.businessName.replace(/\s+/g, '').toLowerCase()}@kukapay.com`, country: "NG" }, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
        return response.data.data.subaccount_id;
    } else {
        const response = await axios.post('https://api.flutterwave.com/v3/subaccounts', { account_bank: vendorTemp.bankCode, account_number: vendorTemp.accountNumber, business_name: vendorTemp.businessName, business_email: `${vendorTemp.businessName.replace(/\s+/g, '').toLowerCase()}@kukapay.com`, split_type: "percentage", split_value: 0.03, country: "NG" }, { headers: { Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`, 'Content-Type': 'application/json' } });
        return response.data.data.subaccount_id;
    }
}

// ==========================================
// 📲 ONBOARDING & LISTENER
// ==========================================
async function handleVendorSetupAndOnboarding(sock, msg, textMessage, lowerText) {
    const senderJid = msg.key.remoteJid;
    let vendor = await Vendor.findOne({ phoneNumber: senderJid }) || new Vendor({ phoneNumber: senderJid });
    
    // ... (Your existing onboarding logic remains here)
    // IMPORTANT: Ensure the account resolution check uses the guard:
    if (vendor.onboardingStep === "WAITING_ACCT" && (!vendor.tempData || !vendor.tempData.bankCode)) {
        vendor.onboardingStep = "WAITING_BANK";
        await vendor.save();
        await sock.sendMessage(senderJid, { text: "⚠️ Session sync lost. Please select your Bank Name again." });
        return true;
    }
    // ... (Rest of your onboarding logic)
    return true; 
}

function startSupabaseListener(sock) {
    supabase.channel('public:transactions').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'transactions' }, async (payload) => {
        const record = payload.new;
        if (record.status === 'success') {
            const vendor = await Vendor.findOne({ phoneNumber: record.tx_ref.split('_')[2] + "@s.whatsapp.net" });
            if (vendor) {
                vendor.dashboardBalance += record.amount;
                await vendor.save();
                await sock.sendMessage(vendor.phoneNumber, { text: `🔔 *Credited!* Balance: ₦${vendor.dashboardBalance}` });
            }
        }
    }).subscribe();
}

// ==========================================
// 🚀 MAIN BAILEYS BOOTSTRAP (FIXED)
// ==========================================
async function startKukaTai() {
    try { await mongoose.connect(process.env.MONGODB_URI); } catch (err) { process.exit(1); }

    const { state, saveCreds } = await useMongooseAuthState('kuka_pay_agent_session');
    const sock = makeWASocket({ 
        version: [2, 3000, 1015901307],
        auth: state, 
        printQRInTerminal: !process.env.BOT_PHONE_NUMBER, 
        browser: Browsers.macOS('Chrome'),
        logger: pino({ level: 'silent' }) 
    });
    
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                await delay(5000); 
                startKukaTai();
            }
        } else if (connection === 'open') {
            startSupabaseListener(sock);
        }
    });

    if (process.env.BOT_PHONE_NUMBER && !sock.authState.creds.registered) {
        await delay(8000); 
        try {
            let code = await sock.requestPairingCode(process.env.BOT_PHONE_NUMBER.replace(/[^0-9]/g, ''));
            console.log(`\n🔑 PAIRING CODE: ${code}\n`);
        } catch (err) { console.error("Pairing failed:", err.message); }
    }
}

startKukaTai();
