const express = require('express');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const mongoose = require('mongoose');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// ==========================================
// 🗄️ UPGRADED BUSINESS & PA SCHEMA
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
app.get('/', (req, res) => { res.status(200).send("KukaPay PA Active with Natural Language Processing."); });
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

    // Direct Group Rules Command
    if (lowerText.startsWith('/setrules ')) {
        const rules = textMessage.substring(10);
        vendor.groupRules = rules;
        await vendor.save();
        await sock.sendMessage(senderJid, { text: `✅ *PA Custom Rules Updated!* Your AI will now engage groups using this style:\n\n"${rules}"` });
        return true;
    }

    // Direct Group Link Command
    if (lowerText === '/linkgroup') {
        vendor.onboardingStep = "WAITING_GROUP_LINK";
        await vendor.save();
        await sock.sendMessage(senderJid, { text: "Drop the WhatsApp Group JID or add me to the group and type `/here` inside that group so I can capture its ID!" });
        return true;
    }

    // Trigger onboarding sequence manually (or caught by intent detectors)
    const triggerWords = ["register", "setup", "onboard", "sign up", "get started", "create account"];
    const matchesTrigger = triggerWords.some(word => lowerText.includes(word));

    if ((matchesTrigger && vendor.onboardingStep === "IDLE") || vendor.onboardingStep === "TRIGGERED") {
        vendor.onboardingStep = "WAITING_BIZ_NAME";
        vendor.tempData = {};
        await vendor.save();
        await sock.sendMessage(senderJid, { text: "Welcome! Let's get your business set up on KukaPay. 🚀\n\nFirst, what is your **Business Name**? (Just reply with the name)" });
        return true;
    }

    // Onboarding Step Machine
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

                await sock.sendMessage(senderJid, { text: `🎉 *Setup Successful!* Your AI Merchant profile is live for *${vendor.businessName}*!` });
            } catch (err) {
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
    const sock = makeWASocket({ auth: state, printQRInTerminal: true, logger: pino({ level: 'silent' }) });
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startKukaTai();
        } else if (connection === 'open') {
            console.log('🚀 KukaPay PA Engine active with Natural Onboarding!');
            startSupabaseListener(sock);
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const senderJid = msg.key.remoteJid;
        const isGroup = senderJid.endsWith('@g.us');
        const textMessage = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
        const lowerText = textMessage.trim().toLowerCase();

        // 1️⃣ HANDLE PRIVATE DM (VENDOR & CLIENTS)
        if (!isGroup) {
            const activeVendor = await Vendor.findOne({ phoneNumber: senderJid });
            const inFunnel = activeVendor && activeVendor.onboardingStep !== "IDLE" && activeVendor.onboardingStep !== "COMPLETED";

            // Natural Onboarding Regex Check (Layer 1)
            const naturalRegisterRegex = /register|onboard|sign\s?up|get\s?started|setup|set\s?up|create\s?account/i;
            const matchesLocalTrigger = naturalRegisterRegex.test(lowerText) || lowerText.startsWith('/setrules ') || lowerText === '/linkgroup';

            // Allow vendor to send promo pictures
            if (activeVendor && msg.message.imageMessage) {
                try {
                    await sock.sendMessage(senderJid, { text: "Saving this image for your scheduled group promotions... 📥" });
                    activeVendor.savedPromoImages.push(JSON.stringify(msg.key));
                    await activeVendor.save();
                    await sock.sendMessage(senderJid, { text: "✅ Image saved! I will cycle through this and other saved images during scheduled group blasts." });
                    return;
                } catch (err) {
                    console.error("Media Save Error:", err);
                }
            }

            if (matchesLocalTrigger || inFunnel) {
                const intercepted = await handleVendorSetupAndOnboarding(sock, msg, textMessage, lowerText);
                if (intercepted) return;
            } else {
                // ==========================================
                // 🧠 CONVERSATIONAL AI & INTENT CLASSIFIER (Layer 2)
                // ==========================================
                try {
                    const myJid = sock.user.id.split(':')[0] + "@s.whatsapp.net";
                    const vendor = await Vendor.findOne({ phoneNumber: myJid });
                    
                    const systemPrompt = vendor 
                        ? `You are the executive PA for "${vendor.businessName}". Rules: ${vendor.groupRules}. Close sales, provide payment details if they are ready, and be ultra-professional.`
                        : `You are the professional setup agent for KukaPay. If the user wants to sign up, register their business, start, or set up their account, reply in a friendly tone welcoming them and append exactly '[TRIGGER_ONBOARDING]' to the very end of your message.`;

                    const response = await axios.post('https://api.openai.com/v1/chat/completions', {
                        model: "gpt-4o-mini",
                        messages: [
                            { role: "system", content: systemPrompt },
                            { role: "user", content: textMessage }
                        ],
                        max_tokens: 200
                    }, { headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}` } });

                    let aiReply = response.data.choices[0].message.content;

                    // Intercept the Smart AI triggering request
                    if (aiReply.includes('[TRIGGER_ONBOARDING]')) {
                        aiReply = aiReply.replace('[TRIGGER_ONBOARDING]', '').trim();
                        
                        // Instantly transition vendor state to get ready for onboarding
                        const prospectiveVendor = activeVendor || new Vendor({ phoneNumber: senderJid });
                        prospectiveVendor.onboardingStep = "TRIGGERED";
                        await prospectiveVendor.save();

                        // Send conversational transition reply
                        await sock.sendMessage(senderJid, { text: aiReply });
                        
                        // Fire the next state loop to ask for their business name
                        await handleVendorSetupAndOnboarding(sock, msg, textMessage, lowerText);
                        return;
                    }

                    await sock.sendMessage(senderJid, { text: aiReply });
                } catch (err) {
                    console.error("DM AI Error:", err.message);
                }
            }
        }

        // 2️⃣ HANDLE GROUP INTERACTION & TRIGGER-BASED ENGAGEMENT
        if (isGroup) {
            const vendor = await Vendor.findOne({ targetGroupId: senderJid });
            
            if (lowerText === '/here') {
                const senderNum = msg.key.participant.split('@')[0] + "@s.whatsapp.net";
                const checkVendor = await Vendor.findOne({ phoneNumber: senderNum });
                if (checkVendor) {
                    checkVendor.targetGroupId = senderJid;
                    checkVendor.onboardingStep = "COMPLETED";
                    await checkVendor.save();
                    await sock.sendMessage(senderJid, { text: `🎉 *AI Agent Activated for this Group!* I will now assist your customers using your customized rules.` });
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
                                { 
                                    role: "system", 
                                    content: `You are the resident AI assistant in the business group of "${vendor.businessName}". Tone: Fun, helpful, yet business-focused. Strict Instructions: ${vendor.groupRules}` 
                                },
                                { role: "user", content: `From ${msg.pushName || "Customer"}: ${textMessage}` }
                            ],
                            max_tokens: 150
                        }, { headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}` } });

                        await sock.sendMessage(senderJid, { text: response.data.choices[0].message.content }, { quoted: msg });
                    } catch (err) {
                        console.error("Group AI Error:", err.message);
                    }
                }

                const now = new Date();
                const hoursSinceLastBlast = (now - new Date(vendor.lastGroupBlast)) / (1000 * 60 * 60);

                if (hoursSinceLastBlast >= vendor.blastIntervalHours) {
                    vendor.lastGroupBlast = now;
                    await vendor.save();

                    if (vendor.savedPromoImages.length > 0) {
                        const randomImageKey = JSON.parse(vendor.savedPromoImages[Math.floor(Math.random() * vendor.savedPromoImages.length)]);
                        await sock.forwardMessage(senderJid, randomImageKey);
                        await sock.sendMessage(senderJid, { 
                            text: `✨ *Quick Update from KukaPay PA:* Check out this top pick! DMs are open to secure yours now! 🛍️` 
                        });
                    }
                }
            }
        }
    });
}

startKukaTai();
