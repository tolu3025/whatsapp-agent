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
    savedPromoImages: { type: [String], default: [] } 
}, { timestamps: true });

const Vendor = mongoose.models.Vendor || mongoose.model('Vendor', VendorSchema);
const BaileysAuthSchema = new mongoose.Schema({ keyId: { type: String, required: true, unique: true }, value: { type: String, required: true } });
const BaileysAuth = mongoose.models.BaileysAuth || mongoose.model('BaileysAuth', BaileysAuthSchema);

async function useMongooseAuthState(sessionId) {
    const writeData = async (data, id) => { await BaileysAuth.updateOne({ keyId: `${sessionId}:${id}` }, { value: JSON.stringify(data, BufferJSON.replacer) }, { upsert: true }); };
    const readData = async (id) => {
        const doc = await BaileysAuth.findOne({ keyId: `${sessionId}:${id}` });
        return doc ? JSON.parse(doc.value, BufferJSON.reviver) : null;
    };
    let creds = await readData('creds') || initAuthCreds();
    return { state: { creds, keys: { get: async (t, ids) => {}, set: async (d) => {} } }, saveCreds: async () => await writeData(creds, 'creds') };
}

// ==========================================
// 🌐 EXPRESS SERVER
// ==========================================
const app = express();
app.use(express.json());
app.get('/', (req, res) => res.status(200).send("KukaPay Active."));
app.listen(process.env.PORT || 10000);

// ==========================================
// 🚀 MAIN BAILEYS BOOTSTRAP (FIXED)
// ==========================================
async function startKukaTai() {
    await mongoose.connect(process.env.MONGODB_URI);
    const { state, saveCreds } = await useMongooseAuthState('kuka_pay_agent_session');
    
    const sock = makeWASocket({ 
        version: [2, 3000, 1015901307],
        auth: state, 
        browser: Browsers.macOS('Chrome'),
        logger: pino({ level: 'silent' }) 
    });
    
    sock.ev.on('creds.update', saveCreds);

    let pairingRequested = false;
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'open') {
            console.log('🚀 KukaPay Engine Live!');
            if (process.env.BOT_PHONE_NUMBER && !sock.authState.creds.registered && !pairingRequested) {
                pairingRequested = true;
                try {
                    let code = await sock.requestPairingCode(process.env.BOT_PHONE_NUMBER.replace(/[^0-9]/g, ''));
                    console.log(`\n🔑 PAIRING CODE: ${code}\n`);
                } catch (e) { 
                    console.error("Pairing Error:", e.message); 
                    pairingRequested = false; 
                }
            }
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                await delay(10000); 
                startKukaTai();
            }
        }
    });
}

startKukaTai();
