const express = require('express');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason,
    delay
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const mongoose = require('mongoose');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// ==========================================
// 🗄️ MULTI-TENANT VENDOR SCHEMA
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

// ==========================================
// 🌐 EXPRESS SERVER
// ==========================================
const app = express();
app.get('/', (req, res) => { res.status(200).send("KukaPay Active."); });
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => { console.log(`🌐 Express health server on Port ${PORT}`); });

const COMMON_BANKS = {
    "access": "044", "gtb": "058", "gtbank": "058", "zenith": "057",
    "uba": "033", "opay": "999992", "kuda": "50211", "moniepoint": "50515",
    "palmpay": "999991", "firstbank": "011", "fbn": "011", "wema": "035"
};

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
                            text: `🔔 *KukaPay Instant Credit!* 🔔\n\nYour account has been credited with *₦${amount}*!\n📈 Updated Balance: *₦${vendor.dashboardBalance}*`
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
        await sock.sendMessage(senderJid, { text: "Welcome! Let's get your business set up on KukaPay. 🚀\n\nFirst, what is your **Business Name**? (Just reply with the name)" });
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
        await sock.sendMessage(senderJid, { text: "Verifying account details... 🔍" });
        try {
            const verifyRes = await axios.post(
                'https://api.flutterwave.com/v3/accounts/resolve',
                { account_number: accountNumber, account_bank: vendor.tempData.bankCode },
                { headers: { Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}` } }
            );

            if (verifyRes.data && verifyRes.data.status === 'success') {
                const accountName = verifyRes.data.data.account_name;
                vendor.tempData = { ...vendor.tempData, accountNumber, accountName };
                vendor.onboardingStep = "CONFIRMATION";
                await vendor.save();
                await sock.sendMessage(senderJid, { 
                    text: `Is this correct?\n\n👤 **Name:** ${accountName}\n🏦 **Bank:** ${vendor.tempData.bankName}\n🔢 **Acct:** ${accountNumber}\n\nReply *YES* to activate or *NO* to reset.` 
                });
            }
        } catch (err) {
            console.error("Account Verification Error:", err.message);
            await sock.sendMessage(senderJid, { text: "❌ Verification failed. Re-enter your 10-digit account number:" });
        }
        return true;
    }

    if (vendor.onboardingStep === "CONFIRMATION") {
        if (lowerText === 'yes') {
            try {
                const subRes = await axios.post(
                    'https://api.flutterwave.com/v3/subaccounts',
                    {
                        account_bank: vendor.tempData.bankCode,
                        account_number: vendor.tempData.accountNumber,
                        business_name: vendor.tempData.businessName,
                        business_email: `${vendor.tempData.businessName.replace(/\s+/g, '').toLowerCase()}@kukapay.com`,
                        split_type: "percentage",
                        split_value: 0.03,
                        country: "NG"
                    },
                    { headers: { Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}` } }
                );

                vendor.businessName = vendor.tempData.businessName;
                vendor.bankCode = vendor.tempData.bankCode;
                vendor.accountNumber = vendor.tempData.accountNumber;
                vendor.accountName = vendor.tempData.accountName;
                vendor.subaccountId = subRes.data.data.subaccount_id;
                vendor.onboardingStep = "COMPLETED";
                vendor.tempData = {};
                await vendor.save();

                await sock.sendMessage(senderJid, { 
                    text: `🎉 *REGISTRATION COMPLETE!* 🎉\n\nYour KukaPay AI Merchant profile is live for *${vendor.businessName}*! 🚀\n\nHere is your **Quick-Start Checklist** to configure your AI Personal Assistant so it can start making sales for you:\n\n---\n\n### 💬 1. Teach Your AI How to Sell (Rules & FAQs)\nTell me your custom business rules, prices, tone of voice, or FAQ guidelines using the \`/setrules\` command.\n👉 *Example:* \`/setrules We sell premium sneakers. Air Force 1 is ₦45,000, Crocs are ₦15,000. Always speak in a friendly tone, offer a 5% discount if they buy two, and tell them to DM us to pay.\`\n\n### 👥 2. Link Your WhatsApp Group\nTo let your AI assist, answer customer questions, and take orders in your group:\n👉 *Step A:* Send me the command \`/linkgroup\` in this private chat.\n👉 *Step B:* Add this bot number to your WhatsApp Group, and then type \`/here\` inside that group chat.\n\n### 📸 3. Upload Your Product Catalog / Promo Pics\nSimply send or forward product photos or marketing flyers directly to this DM. I will automatically save them and cycle through them to post beautiful promotional updates in your group!\n\n---\n\n💡 *Remember:* I am your AI assistant. You can ask me questions right here in this DM whenever you need help setting up!` 
                });
            } catch (err) {
                console.error("Subaccount Creation Error:", err.message);
                await sock.sendMessage(senderJid, { text: "❌ Gateway error. Reply YES to try again." });
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

    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    const sock = makeWASocket({ 
        auth: state, 
        printQRInTerminal: !process.env.BOT_PHONE_NUMBER, // Disable QR printing if linking via phone number
        logger: pino({ level: 'silent' }) 
    });
    
    sock.ev.on('creds.update', saveCreds);

    // 🔑 SECURE PHONE PAIRING LOGIC (For easy linking on Render)
    if (process.env.BOT_PHONE_NUMBER && !sock.authState.creds.registered) {
        let phoneNumber = process.env.BOT_PHONE_NUMBER.replace(/[^0-9]/g, '');
        console.log(`📱 Attempting to pair with phone number: ${phoneNumber}`);
        
        await delay(3000); // Wait for socket to be completely initialized
        try {
            let code = await sock.requestPairingCode(phoneNumber);
            console.log(`\n🔑 ==========================================`);
            console.log(`🔑 WHATSAPP PAIRING CODE: ${code}`);
            console.log(`🔑 ==========================================\n`);
        } catch (err) {
            console.error("❌ Failed to request pairing code:", err);
        }
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log(`🔌 Connection closed. Reconnecting? ${shouldReconnect}`);
            if (shouldReconnect) startKukaTai();
        } else if (connection === 'open') {
            console.log('🚀 KukaPay Dynamic PA Engine Live and Connected to WhatsApp!');
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
                                { role: "system", content: `You are the executive assistant for "${vendor.businessName}". Provide professional help configuring rules, linking groups, etc.` },
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
