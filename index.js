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
// 🗄️ MONGOOSE SCHEMAS (Multi-Tenant & Session)
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
    
    // PA & Group Customizations
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

// Custom Database-backed Auth Adapter for Baileys
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
    if (!creds) {
        creds = initAuthCreds();
        await writeData(creds, 'creds');
    }

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
                    for (const category in data) {
                        for (const id in data[category]) {
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
// 🌐 EXPRESS SERVER
// ==========================================
const app = express();
app.use(express.json());
app.get('/', (req, res) => { res.status(200).send("kukatai-agent Active."); });
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => { console.log(`🌐 Express health server on Port ${PORT}`); });

// Supported Banks Code Dictionary
const COMMON_BANKS = {
    "access": "044", "accessbank": "044", "gtb": "058", "gtbank": "058", 
    "guarantytrust": "058", "zenith": "057", "zenithbank": "057", "uba": "033", 
    "unitedbankforafrica": "033", "opay": "999992", "paycom": "999992",
    "kuda": "50211", "kudabank": "50211", "moniepoint": "50515", "palmpay": "999991", 
    "firstbank": "011", "fbn": "011", "wema": "035", "wemabank": "035", "fcmb": "214",
    "firstcitymonumentbank": "214", "union": "032", "unionbank": "032", "stanbic": "221",
    "stanbicibtc": "221", "fidelity": "070", "fidelitybank": "070", "sterling": "050",
    "sterlingbank": "050", "providus": "101", "providusbank": "101"
};

// ==========================================
// ⚡ FLUTTERWAVE AUTO-DETECT INTEGRATION (v3/v4)
// ==========================================

const isV4Enabled = () => !!(process.env.FLW_CLIENT_ID && process.env.FLW_CLIENT_SECRET);

async function getFlutterwaveV4Token() {
    const url = 'https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token';
    const payload = new URLSearchParams({
        client_id: process.env.FLW_CLIENT_ID,
        client_secret: process.env.FLW_CLIENT_SECRET,
        grant_type: 'client_credentials'
    });

    const response = await axios.post(url, payload.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    
    return response.data.access_token;
}

// Unified Bank Account Resolution
async function resolveBankAccount(bankCode, accountNumber) {
    if (isV4Enabled()) {
        console.log("⚡ [Flutterwave] Executing via v4 API");
        const token = await getFlutterwaveV4Token();
        const baseUrl = process.env.NODE_ENV === 'production' 
            ? 'https://f4bexperience.flutterwave.com' 
            : 'https://developersandbox-api.flutterwave.com';

        const response = await axios.post(
            `${baseUrl}/banks/account-resolve`, 
            {
                account: {
                    code: bankCode,
                    number: accountNumber
                },
                currency: "NGN"
            },
            {
                headers: {
                    Authorization: `Bearer ${token}`, 
                    'Content-Type': 'application/json'
                }
            }
        );
        return { success: true, accountName: response.data.data.account_name };
    } else {
        console.log("⚡ [Flutterwave] Executing via v3 API");
        const response = await axios.post(
            'https://api.flutterwave.com/v3/accounts/resolve', 
            {
                account_number: accountNumber, 
                account_bank: bankCode 
            },
            {
                headers: {
                    Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`, 
                    'Content-Type': 'application/json'
                }
            }
        );
        return { success: true, accountName: response.data.data.account_name };
    }
}

// Unified Subaccount Creation
async function createSubaccount(vendorTemp) {
    if (isV4Enabled()) {
        console.log("⚡ [Flutterwave] Creating v4 Payout Subaccount");
        const token = await getFlutterwaveV4Token();
        const baseUrl = process.env.NODE_ENV === 'production' 
            ? 'https://f4bexperience.flutterwave.com' 
            : 'https://developersandbox-api.flutterwave.com';

        const response = await axios.post(
            `${baseUrl}/payout-subaccounts`,
            {
                account_bank: vendorTemp.bankCode,
                account_number: vendorTemp.accountNumber,
                business_name: vendorTemp.businessName,
                business_email: `${vendorTemp.businessName.replace(/\s+/g, '').toLowerCase()}@kukatai.com`,
                country: "NG"
            },
            {
                headers: {
                    Authorization: `Bearer ${token}`, 
                    'Content-Type': 'application/json'
                }
            }
        );
        return response.data.data.subaccount_id;
    } else {
        console.log("⚡ [Flutterwave] Creating v3 Collection Subaccount");
        const response = await axios.post(
            'https://api.flutterwave.com/v3/subaccounts', 
            {
                account_bank: vendorTemp.bankCode,
                account_number: vendorTemp.accountNumber,
                business_name: vendorTemp.businessName,
                business_email: `${vendorTemp.businessName.replace(/\s+/g, '').toLowerCase()}@kukatai.com`,
                split_type: "percentage",
                split_value: 0.03,
                country: "NG"
            },
            {
                headers: {
                    Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`, 
                    'Content-Type': 'application/json'
                }
            }
        );
        return response.data.data.subaccount_id;
    }
}

// ==========================================
// ⚡ SUPABASE REAL-TIME PAYMENT LISTENER
// ==========================================
function startSupabaseListener(sock) {
    supabase
        .channel('public:transactions') 
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'transactions' }, async (payload) => {
            const record = payload.new;
            if (record.status === 'successful' || record.status === 'success') {
                const txRef = record.tx_ref; 
                const amount = record.amount;

                try {
                    const refParts = txRef.split('_');
                    const vendorPhone = refParts[2] + "@s.whatsapp.net";

                    const vendor = await Vendor.findOne({ phoneNumber: vendorPhone });
                    if (vendor) {
                        vendor.dashboardBalance += amount;
                        await vendor.save();

                        await sock.sendMessage(vendorPhone, {
                            text: `🔔 *Kukatai Agent Instant Credit!* 🔔\n\nYour account has been credited with *₦${amount}*!\n📈 Updated Balance: *₦${vendor.dashboardBalance}*`
                        });
                    }
                } catch (err) {
                    console.error("❌ Realtime Credit Error:", err.message);
                }
            }
        }).subscribe();
}

// ==========================================
// 📲 ONBOARDING STATE MACHINE
// ==========================================
async function handleVendorSetupAndOnboarding(sock, msg, textMessage, lowerText) {
    const senderJid = msg.key.remoteJid;
    let vendor = await Vendor.findOne({ phoneNumber: senderJid });
    if (!vendor) {
        vendor = new Vendor({ phoneNumber: senderJid });
        await vendor.save();
    }

    if (lowerText.startsWith('/setrules ')) {
        const rules = textMessage.substring(10);
        vendor.groupRules = rules;
        await vendor.save();
        await sock.sendMessage(senderJid, { text: `✅ *PA Custom Rules Updated!* Your AI will now engage your groups using this custom style:\n\n"${rules}"` });
        return true;
    }

    if (lowerText === '/linkgroup') {
        vendor.onboardingStep = "WAITING_GROUP_LINK";
        await vendor.save();
        await sock.sendMessage(senderJid, { text: "Drop the WhatsApp Group JID or add me to the group and type `/here` inside that group so I can capture its ID!" });
        return true;
    }

    const triggerWords = ["register", "setup", "onboard", "sign up", "get started", "create account", "/signup", "/sign up"];
    const matchesTrigger = triggerWords.some(word => lowerText.includes(word));

    if ((matchesTrigger && vendor.onboardingStep === "IDLE") || vendor.onboardingStep === "TRIGGERED" || (matchesTrigger && !vendor.onboardingStep)) {
        vendor.onboardingStep = "WAITING_BIZ_NAME";
        vendor.tempData = {};
        await vendor.save();
        await sock.sendMessage(senderJid, { text: "Welcome! Let's get your business set up on kukatai-agent. 🚀\n\nFirst, what is your **Business Name**? (Just reply with the name)" });
        return true;
    }

    if (vendor.onboardingStep === "WAITING_BIZ_NAME") {
        vendor.tempData = { businessName: textMessage };
        vendor.onboardingStep = "WAITING_BANK";
        await vendor.save();
        await sock.sendMessage(senderJid, { text: "Nice! Now reply with your **Bank Name** (e.g. GTBank, Opay, Kuda):" });
        return true;
    }

    if (vendor.onboardingStep === "WAITING_BANK") {
        const cleanBank = lowerText.replace(/\s+/g, '');
        const bankCode = COMMON_BANKS[cleanBank];
        if (!bankCode) {
            await sock.sendMessage(senderJid, { text: "❌ Bank not recognized. Try again (e.g. Opay, GTBank):" });
            return true;
        }
        vendor.tempData = { ...vendor.tempData, bankCode, bankName: textMessage };
        vendor.onboardingStep = "WAITING_ACCT";
        await vendor.save();
        await sock.sendMessage(senderJid, { text: `Perfect! What is your **10-digit Account Number** for ${vendor.tempData.bankName}:` });
        return true;
    }

    if (vendor.onboardingStep === "WAITING_ACCT") {
        const accountNumber = textMessage.trim();
        if (!/^\d{10}$/.test(accountNumber)) {
            await sock.sendMessage(senderJid, { text: "❌ Must be exactly 10 digits. Try again:" });
            return true;
        }

        // STATE GUARD FIX: Ensure we have the bankCode before verifying
        if (!vendor.tempData || !vendor.tempData.bankCode) {
            vendor.onboardingStep = "WAITING_BANK";
            await vendor.save();
            await sock.sendMessage(senderJid, { text: "⚠️ Session sync lost. Please select your **Bank Name** first (e.g., Opay, GTBank, Kuda):" });
            return true;
        }

        await sock.sendMessage(senderJid, { text: "Verifying account details... 🔍" });
        try {
            const verifyRes = await resolveBankAccount(vendor.tempData.bankCode, accountNumber);

            if (verifyRes && verifyRes.success) {
                const accountName = verifyRes.accountName;
                vendor.tempData = { ...vendor.tempData, accountNumber, accountName };
                vendor.onboardingStep = "CONFIRMATION";
                await vendor.save();
                await sock.sendMessage(senderJid, { 
                    text: `Is this correct?\n\n👤 **Name:** ${accountName}\n🏦 **Bank:** ${vendor.tempData.bankName}\n🔢 **Acct:** ${accountNumber}\n\nReply *YES* to activate or *NO* to reset.` 
                });
            }
        } catch (err) {
            console.error("❌ Account Verification Error:", err.response?.data || err.message);
            await sock.sendMessage(senderJid, { text: "❌ Verification failed. Re-enter your 10-digit account number:" });
        }
        return true;
    }

    if (vendor.onboardingStep === "CONFIRMATION") {
        if (lowerText === 'yes') {
            try {
                const subaccountId = await createSubaccount(vendor.tempData);

                vendor.businessName = vendor.tempData.businessName;
                vendor.bankCode = vendor.tempData.bankCode;
                vendor.accountNumber = vendor.tempData.accountNumber;
                vendor.accountName = vendor.tempData.accountName;
                vendor.subaccountId = subaccountId;
                vendor.onboardingStep = "COMPLETED";
                vendor.tempData = {};
                await vendor.save();

                await sock.sendMessage(senderJid, { 
                    text: `🎉 *REGISTRATION COMPLETE!* 🎉\n\nYour kukatai-agent Merchant profile is live for *${vendor.businessName}*! 🚀\n\nHere is your **Quick-Start Checklist** to configure your AI Personal Assistant so it can start making sales for you:\n\n---\n\n### 💬 1. Teach Your AI How to Sell (Rules & FAQs)\nTell me your custom business rules, prices, tone of voice, or FAQ guidelines using the \`/setrules\` command.\n👉 *Example:* \`/setrules We sell premium sneakers. Air Force 1 is ₦45,000, Crocs are ₦15,000. Always speak in a friendly tone, offer a 5% discount if they buy two, and tell them to DM us to pay.\`\n\n### 👥 2. Link Your WhatsApp Group\nTo let your AI assist, answer customer questions, and take orders in your group:\n👉 *Step A:* Send me the command \`/linkgroup\` in this private chat.\n👉 *Step B:* Add this bot number to your WhatsApp Group, and then type \`/here\` inside that group chat.\n\n### 📸 3. Upload Your Product Catalog / Promo Pics\nSimply send or forward product photos or marketing flyers directly to this DM. I will automatically save them and cycle through them to post beautiful promotional updates in your group!\n\n---\n\n💡 *Remember:* I am your AI assistant. You can ask me questions right here in this DM whenever you need help setting up!` 
                });
            } catch (err) {
                console.error("Subaccount Creation Error:", err.response?.data || err.message);
                await sock.sendMessage(senderJid, { text: "❌ Gateway error during registration. Reply YES to try again." });
            }
        } else {
            vendor.onboardingStep = "IDLE";
            await vendor.save();
            await sock.sendMessage(senderJid, { text: "Reset successful. Type *register* to start again." });
        }
        return true;
    }

    return false;
}

// ==========================================
// 🚀 MAIN BAILEYS BOOTSTRAP
// ==========================================
async function startKukaTai() {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log("🔋 MongoDB Connected Successfully!");
    } catch (err) {
        console.error("❌ Database Connection Error:", err.message);
        process.exit(1);
    }

    // Forcefully wipe old credential documents on start to allow fresh pairing code sequence
    try {
        await BaileysAuth.deleteMany({});
        console.log("🧹 Previous session data cleared for a fresh pairing sequence.");
    } catch (e) {
        console.log("⚠️ Session clearing error:", e.message);
    }

    const { state, saveCreds } = await useMongooseAuthState('kukatai_agent_session');
    
    let waVersion = [2, 3000, 1015901307];
    try {
        const { version } = await fetchLatestWaWebVersion();
        if (version) waVersion = version;
        console.log("📡 Fetched WA Web version:", waVersion.join('.'));
    } catch (e) {
        console.log(`⚠️ Version fetch failed, utilizing stable fallback version.`);
    }

    const sock = makeWASocket({ 
        version: waVersion,
        auth: state, 
        printQRInTerminal: false,
        browser: Browsers.macOS('Chrome'), 
        logger: pino({ level: 'silent' }) 
    });
    
    sock.ev.on('creds.update', saveCreds);

    // 🔌 Connection Update & Smart Pairing Event Handler
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // ⚡ SAFE PAIRING CODE TRIGGER inside the connection flow when QR challenge is emitted
        if (qr && !sock.authState.creds.registered && process.env.BOT_PHONE_NUMBER) {
            let phoneNumber = process.env.BOT_PHONE_NUMBER.replace(/[^0-9]/g, '');
            console.log(`📱 [kukatai-agent] Challenge generated. Requesting pairing code for: ${phoneNumber}`);
            
            try {
                await delay(2000); // Small window to verify websocket sanity
                let code = await sock.requestPairingCode(phoneNumber);
                console.log(`\n🔑 ==========================================`);
                console.log(`🔑 KUKATAI-AGENT PAIRING CODE: ${code}`);
                console.log(`🔑 ==========================================\n`);
            } catch (err) {
                console.error("❌ Failed to request pairing code safely:", err.message);
            }
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            const isLoggedOut = statusCode === DisconnectReason.loggedOut;
            const shouldReconnect = !isLoggedOut;
            
            console.log(`🔌 Connection closed (Code: ${statusCode}). Reconnecting? ${shouldReconnect}`);
            if (shouldReconnect) {
                await delay(8000); 
                startKukaTai();
            }
        } else if (connection === 'open') {
            console.log('🚀 kukatai-agent Engine Live and Connected to WhatsApp!');
            startSupabaseListener(sock);
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg.message || msg.key.fromMe) return;

            const senderJid = msg.key.remoteJid;
            const isGroup = senderJid.endsWith('@g.us');
            const textMessage = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || "";
            const lowerText = textMessage.trim().toLowerCase();

            console.log(`📩 Message from [${senderJid}]: "${textMessage}"`);

            if (!isGroup) {
                let vendor = await Vendor.findOne({ phoneNumber: senderJid });
                const naturalRegisterRegex = /register|onboard|sign\s?up|get\s?started|setup|set\s?up|create\s?account|\/signup|\/sign\s?up/i;
                const matchesTrigger = naturalRegisterRegex.test(lowerText) || lowerText.startsWith('/setrules ') || lowerText === '/linkgroup';
                const inActiveOnboarding = vendor && vendor.onboardingStep !== "IDLE" && vendor.onboardingStep !== "COMPLETED";

                if (matchesTrigger || inActiveOnboarding) {
                    await handleVendorSetupAndOnboarding(sock, msg, textMessage, lowerText);
                    return;
                } else if (vendor && vendor.onboardingStep === "COMPLETED") {
                    if (msg.message.imageMessage) {
                        try {
                            await sock.sendMessage(senderJid, { text: "Saving product flyer... 📥" });
                            vendor.savedPromoImages.push(JSON.stringify(msg.key));
                            await vendor.save();
                            await sock.sendMessage(senderJid, { text: "✅ Saved! This flyer will cycle through group broadcasts." });
                            return;
                        } catch (err) {
                            console.error(err);
                        }
                    }

                    try {
                        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
                            model: "gpt-4o-mini",
                            messages: [
                                { role: "system", content: `You are the executive assistant for "${vendor.businessName}". Provide professional help configuring rules, linking groups, etc. for their kukatai-agent configuration.` },
                                { role: "user", content: textMessage }
                            ],
                            max_tokens: 250
                        }, { headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}` } });

                        await sock.sendMessage(senderJid, { text: response.data.choices[0].message.content });
                    } catch (err) {
                        console.error(err.message);
                    }
                }
            }

            if (isGroup) {
                const vendor = await Vendor.findOne({ targetGroupId: senderJid });
                if (lowerText === '/here') {
                    const senderNum = msg.key.participant.split('@')[0] + "@s.whatsapp.net";
                    const checkVendor = await Vendor.findOne({ phoneNumber: senderNum });
                    if (checkVendor) {
                        checkVendor.targetGroupId = senderJid;
                        checkVendor.onboardingStep = "COMPLETED";
                        await checkVendor.save();
                        await sock.sendMessage(senderJid, { text: `🎉 *AI Agent Activated for this Group!* I will now manage customer inquiries using custom rules.` });
                        return;
                    }
                }

                if (vendor) {
                    const botJid = sock.user.id.split(':')[0];
                    const isMentioned = textMessage.includes(`@${botJid}`);
                    const matchesKeyword = vendor.customKeywords.some(keyword => lowerText.includes(keyword));

                    if (isMentioned || matchesKeyword) {
                        try {
                            const response = await axios.post('https://api.openai.com/v1/chat/completions', {
                                model: "gpt-4o-mini",
                                messages: [
                                    { role: "system", content: `You are the friendly AI assistant for "${vendor.businessName}" sales group. Rules: ${vendor.groupRules}` },
                                    { role: "user", content: `From ${msg.pushName || "Customer"}: ${textMessage}` }
                                ],
                                max_tokens: 150
                            }, { headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}` } });

                            await sock.sendMessage(senderJid, { text: response.data.choices[0].message.content }, { quoted: msg });
                        } catch (err) {
                            console.error(err);
                        }
                    }
                }
            }
        } catch (globalErr) {
            console.error("Fatal Error:", globalErr);
        }
    });
}

startKukaTai();
