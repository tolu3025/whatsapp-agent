const { 
    default: makeWASocket, 
    DisconnectReason, 
    BufferJSON, 
    initAuthCreds,
    Browsers 
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const mongoose = require('mongoose');
const express = require('express');
const axios = require('axios');
require('dotenv').config();

// ==========================================
// 🚀 EXPRESS HEALTH SERVER FOR RENDER
// ==========================================
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 10000;
app.get('/health', (req, res) => res.status(200).send("OK"));
app.listen(PORT, () => console.log(`🌐 Express health server on Port ${PORT}`));

// ==========================================
// 🍃 MONGODB MODELS FOR AUTHENTICATION & VENDORS
// ==========================================
const MongoURI = process.env.MONGODB_URI || process.env.MONGO_URI;

if (!MongoURI) {
    console.error("⚠️ ERROR: MongoDB URI is missing! Please set MONGODB_URI in Render environment variables.");
}

const SessionSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    data: { type: String, required: true } 
});
const Session = mongoose.model('Session', SessionSchema);

const VendorSchema = new mongoose.Schema({
    jid: { type: String, required: true, unique: true },
    businessName: String,
    bankName: String,
    bankCode: String, // Added to store mapped bank code
    accountNumber: String,
    verifiedName: String,
    onboardingStep: { type: String, default: 'IDLE' }, 
    isLinked: { type: Boolean, default: false },
    linkedGroupJid: String
});
const Vendor = mongoose.model('Vendor', VendorSchema);

// Helper function to resolve popular Nigerian bank names to codes
function getBankCode(bankName) {
    const cleanName = bankName.toLowerCase().replace(/[\s\.\-]/g, "");
    
    const bankCodes = {
        "opay": "999992",
        "paycom": "999992",
        "palmpay": "999991",
        "moniepoint": "50515",
        "kuda": "50211",
        "gtb": "058",
        "gtbank": "058",
        "guarantytrust": "058",
        "zenith": "057",
        "zenithbank": "057",
        "access": "044",
        "accessbank": "044",
        "uba": "033",
        "unitedbankforafrica": "033",
        "firstbank": "011",
        "fbn": "011",
        "wema": "035",
        "wemabank": "035",
        "fcmb": "214",
        "firstcitymonumentbank": "214",
        "union": "032",
        "unionbank": "032",
        "stanbic": "221",
        "stanbicibtc": "221",
        "fidelity": "070",
        "fidelitybank": "070",
        "sterling": "050",
        "sterlingbank": "050",
        "providus": "101",
        "providusbank": "101",
        "taj": "302",
        "tajbank": "302",
        "jaiz": "301",
        "jaizbank": "301",
        "keystone": "082",
        "keystonebank": "082"
    };

    return bankCodes[cleanName] || null;
}

// ==========================================
// 🔑 CUSTOM MONGODB AUTH STATE FOR BAILEYS
// ==========================================
async function useMongoAuthState(sessionId) {
    const writeData = async (data, id) => {
        try {
            const stringified = JSON.stringify(data, BufferJSON.replacer);
            await Session.updateOne({ id }, { data: stringified }, { upsert: true });
        } catch (err) {
            console.error(`Error saving auth session state for ${id}:`, err);
        }
    };

    const readData = async (id) => {
        try {
            const sessionObj = await Session.findOne({ id });
            if (!sessionObj) return null;
            return JSON.parse(sessionObj.data, BufferJSON.reviver);
        } catch (err) {
            console.error(`Error loading auth session state for ${id}:`, err);
            return null;
        }
    };

    const removeData = async (id) => {
        try {
            await Session.deleteOne({ id });
        } catch (err) {
            console.error(`Error deleting session ${id}:`, err);
        }
    };

    let creds = await readData(`${sessionId}:creds`);
    if (!creds) {
        creds = initAuthCreds();
        await writeData(creds, `${sessionId}:creds`);
    }

    const state = {
        creds,
        keys: {
            get: async (type, ids) => {
                const data = {};
                for (const id of ids) {
                    let value = await readData(`${sessionId}:${type}:${id}`);
                    if (type === 'app-state-sync-key' && value) {
                        value = proto.Message.AppStateSyncKeyData.fromObject(value);
                    }
                    data[id] = value;
                }
                return data;
            },
            set: async (data) => {
                const tasks = [];
                for (const category of Object.keys(data)) {
                    for (const id of Object.keys(data[category])) {
                        const value = data[category][id];
                        const key = `${sessionId}:${category}:${id}`;
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
    };

    return {
        state,
        saveCreds: async () => {
            await writeData(state.creds, `${sessionId}:creds`);
        }
    };
}

// ==========================================
// 🤖 WHATSAPP AGENT INITIALIZATION
// ==========================================
async function startWhatsAppBot() {
    console.log("⚙️ Initializing dynamic MongoDB-backed session...");
    
    const { state, saveCreds } = await useMongoAuthState("kukatai_session");

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false, 
        browser: Browsers.macOS('Chrome') 
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'connecting') {
            console.log("⏳ Connecting to WhatsApp...");
        }

        if (!sock.authState.creds.registered && process.env.BOT_PHONE_NUMBER) {
            setTimeout(async () => {
                try {
                    let code = await sock.requestPairingCode(process.env.BOT_PHONE_NUMBER);
                    code = code?.match(/.{1,4}/g)?.join('-') || code;
                    console.log(`\n🔑 ==========================================`);
                    console.log(`🔑 USE THIS WHATSAPP PAIRING CODE: ${code}`);
                    console.log(`🔑 ==========================================\n`);
                } catch (err) {
                    console.error("Error generating pairing code:", err);
                }
            }, 5000); 
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom) 
                ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut 
                : true;
            
            console.log("🔌 Connection closed. Reconnecting?", shouldReconnect);
            if (shouldReconnect) {
                startWhatsAppBot(); 
            }
        } else if (connection === 'open') {
            console.log("🚀 Kukatai Agent Engine Live, Persistent, and Connected to WhatsApp!");
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const jid = msg.key.remoteJid;

        if (jid === 'status@broadcast' || jid.endsWith('@g.us')) {
            return; 
        }

        const senderName = msg.pushName || "Unknown Vendor";
        const textMessage = (msg.message.conversation || 
                            msg.message.extendedTextMessage?.text || 
                            msg.message.imageMessage?.caption || 
                            "").trim();

        if (!textMessage) return; 

        console.log(`✉️ Direct Message from [${jid}] (${senderName}): "${textMessage}"`);

        let vendor = await Vendor.findOne({ jid });

        const triggers = ["i want to register", "/signup", "register", "setup"];
        if (triggers.includes(textMessage.toLowerCase())) {
            if (vendor && vendor.onboardingStep === 'COMPLETED') {
                return await sock.sendMessage(jid, { text: `✅ You are already registered as *${vendor.businessName}* on Kukatai!` });
            }

            vendor = await Vendor.findOneAndUpdate(
                { jid },
                { onboardingStep: 'WAITING_NAME' },
                { upsert: true, new: true }
            );

            return await sock.sendMessage(jid, { 
                text: `Welcome! Let's get your business setup on *Kukatai*. 🚀\n\nFirst, what is your *Business Name*? (Just reply directly with the name)` 
            });
        }

        if (vendor && vendor.onboardingStep !== 'COMPLETED' && vendor.onboardingStep !== 'IDLE') {
            switch(vendor.onboardingStep) {
                
                case 'WAITING_NAME':
                    vendor.businessName = textMessage;
                    vendor.onboardingStep = 'WAITING_BANK';
                    await vendor.save();
                    return await sock.sendMessage(jid, { text: `Great! Next, what is your *Bank Name*? (e.g. Opay, GTBank, Kuda, Moniepoint)` });

                case 'WAITING_BANK':
                    const resolvedCode = getBankCode(textMessage);
                    if (!resolvedCode) {
                        return await sock.sendMessage(jid, { 
                            text: `⚠️ I couldn't recognize "${textMessage}". Please enter a popular bank like *Opay, Palmpay, GTBank, Kuda, Moniepoint, Access, or Zenith*:` 
                        });
                    }
                    vendor.bankName = textMessage;
                    vendor.bankCode = resolvedCode;
                    vendor.onboardingStep = 'WAITING_ACCOUNT';
                    await vendor.save();
                    return await sock.sendMessage(jid, { text: `Understood (${textMessage}). Please provide your *10-digit Account Number*:` });

                case 'WAITING_ACCOUNT':
                    if (textMessage.length !== 10 || isNaN(textMessage)) {
                        return await sock.sendMessage(jid, { text: `⚠️ Invalid input. Please reply with a valid *10-digit* account number.` });
                    }
                    vendor.accountNumber = textMessage;
                    vendor.onboardingStep = 'WAITING_VERIFY';
                    await vendor.save();

                    await sock.sendMessage(jid, { text: `🔍 Verifying account details with Flutterwave, please hold...` });

                    try {
                        // 🛠️ FIX 1 & 2: Sending a POST request with correct raw json parameters
                        const flwResponse = await axios.post(
                            `https://api.flutterwave.com/v3/accounts/resolve`,
                            { 
                                account_number: vendor.accountNumber, 
                                account_bank: vendor.bankCode 
                            },
                            {
                                headers: { 
                                    Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}`,
                                    'Content-Type': 'application/json'
                                }
                            }
                        );

                        if (flwResponse.data && flwResponse.data.status === 'success') {
                            const accountName = flwResponse.data.data.account_name;
                            vendor.verifiedName = accountName;
                            await vendor.save();

                            return await sock.sendMessage(jid, { 
                                text: `Is this your account name?\n\n*🏦 ${accountName}*\n\nReply *YES* to confirm, or *NO* to restart.` 
                            });
                        } else {
                            throw new Error("Unable to resolve name.");
                        }

                    } catch (error) {
                        console.error("❌ Account Verification Error:", error.response?.data || error.message);
                        vendor.onboardingStep = 'WAITING_BANK'; 
                        await vendor.save();
                        return await sock.sendMessage(jid, { 
                            text: `❌ Verification failed. Let's try again.\n\nPlease type your *Bank Name* (e.g., Opay, Moniepoint, Kuda):` 
                        });
                    }

                case 'WAITING_VERIFY':
                    if (textMessage.toUpperCase() === 'YES') {
                        vendor.onboardingStep = 'COMPLETED';
                        await vendor.save();

                        const checklist = `🎉 *CONGRATULATIONS!* You are officially registered on *Kukatai*!\n\n` +
                                          `Your business details:\n` +
                                          `• *Business Name:* ${vendor.businessName}\n` +
                                          `• *Account Name:* ${vendor.verifiedName}\n` +
                                          `• *Bank:* ${vendor.bankName} (${vendor.accountNumber})\n\n` +
                                          `📋 *YOUR ONBOARDING CHECKLIST:*\n` +
                                          `1️⃣ Add this bot to your client customer group chats.\n` +
                                          `2️⃣ In your private chat here, type \`/linkgroup\` to connect a customer group.\n` +
                                          `3️⃣ Go to the customer group and type \`/here\` to activate the bot inside it!`;

                        return await sock.sendMessage(jid, { text: checklist });
                    } else {
                        vendor.onboardingStep = 'WAITING_NAME';
                        await vendor.save();
                        return await sock.sendMessage(jid, { text: `Alright, let's start over. What is your *Business Name*?` });
                    }
            }
        }
    });
}

// ==========================================
// 🔌 INITIALIZE DATABASE CONNECTION FIRST
// ==========================================
console.log("🔌 Connecting to MongoDB Database...");
mongoose.connect(MongoURI)
    .then(() => {
        console.log("🔋 MongoDB Connected Successfully!");
        startWhatsAppBot();
    })
    .catch(err => {
        console.error("❌ MongoDB Connection Error:", err);
    });
