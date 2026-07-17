
# Write a completely clean JavaScript file with NO comments, NO Python, NO markdown
# Just pure JS code that can be copy-pasted directly into index.js

js_code = """const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay, downloadMediaMessage, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const mongoose = require('mongoose');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const REQUIRED_ENV = ['MONGODB_URI', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'FLUTTERWAVE_CLIENT_ID', 'FLUTTERWAVE_CLIENT_SECRET', 'OPENAI_API_KEY'];
for (const key of REQUIRED_ENV) {
    if (!process.env[key]) {
        console.error('Missing required environment variable: ' + key);
        process.exit(1);
    }
}

const FLW_BASE_URL = process.env.NODE_ENV === 'production' ? 'https://f4bexperience.flutterwave.com' : 'https://developersandbox-api.flutterwave.com';
const FLW_IDP_URL = 'https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token';

class FlutterwaveTokenManager {
    constructor() {
        this.token = null;
        this.expiresAt = 0;
    }
    async getToken() {
        if (this.token && Date.now() < this.expiresAt - 60000) return this.token;
        const response = await axios.post(FLW_IDP_URL, new URLSearchParams({ client_id: process.env.FLUTTERWAVE_CLIENT_ID, client_secret: process.env.FLUTTERWAVE_CLIENT_SECRET, grant_type: 'client_credentials' }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        this.token = response.data.access_token;
        this.expiresAt = Date.now() + (response.data.expires_in * 1000);
        return this.token;
    }
}

const flwTokenManager = new FlutterwaveTokenManager();

async function flwRequest(method, endpoint, data, extraHeaders) {
    extraHeaders = extraHeaders || {};
    const token = await flwTokenManager.getToken();
    const config = { method, url: FLW_BASE_URL + endpoint, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'X-Trace-Id': crypto.randomUUID(), 'X-Idempotency-Key': crypto.randomUUID(), ...extraHeaders }, timeout: 30000 };
    if (data) config.data = data;
    return axios(config);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const VendorSchema = new mongoose.Schema({
    phoneNumber: { type: String, required: true, unique: true, index: true },
    businessName: { type: String, required: true },
    bankCode: { type: String, required: true },
    bankName: { type: String },
    accountNumber: { type: String, required: true },
    accountName: { type: String, required: true },
    recipientId: { type: String },
    customerId: { type: String },
    dashboardBalance: { type: Number, default: 0 },
    onboardingStep: { type: String, enum: ["IDLE", "WAITING_BIZ_NAME", "WAITING_BANK", "WAITING_ACCT", "CONFIRMATION", "COMPLETED"], default: "IDLE" },
    tempData: { type: Object, default: {} },
    targetGroupId: { type: String },
    groupRules: { type: String, default: "Be polite, showcase our products, and tell them to DM us to order.", maxlength: 2000 },
    customKeywords: { type: [String], default: ["price", "cost", "buy", "order", "available"] },
    lastGroupBlast: { type: Date, default: Date.now },
    blastIntervalHours: { type: Number, default: 6, min: 1, max: 168 },
    savedPromoImages: [{ url: String, caption: String, uploadedAt: { type: Date, default: Date.now } }],
    lastMessageAt: { type: Date },
    messageCount: { type: Number, default: 0 },
    messageCountResetAt: { type: Date },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
}, { timestamps: true });

VendorSchema.index({ targetGroupId: 1, onboardingStep: 1 });
const Vendor = mongoose.models.Vendor || mongoose.model('Vendor', VendorSchema);

const TransactionSchema = new mongoose.Schema({
    tx_ref: { type: String, required: true, index: true },
    amount: { type: Number, required: true },
    status: { type: String, required: true },
    vendorPhone: { type: String, index: true },
    flw_ref: { type: String },
    currency: { type: String, default: 'NGN' },
    createdAt: { type: Date, default: Date.now }
});
const Transaction = mongoose.models.Transaction || mongoose.model('Transaction', TransactionSchema);

const ProcessedMessageSchema = new mongoose.Schema({
    messageId: { type: String, required: true, unique: true, index: true },
    processedAt: { type: Date, default: Date.now, expires: 86400 }
});
const ProcessedMessage = mongoose.models.ProcessedMessage || mongoose.model('ProcessedMessage', ProcessedMessageSchema);

const app = express();
app.use(express.json());
app.get('/', function(req, res) { res.status(200).json({ status: "KukaTai Agent Active", timestamp: new Date().toISOString() }); });
const PORT = process.env.PORT || 10000;
app.listen(PORT, function() { console.log('KukaTai Agent server on Port ' + PORT); });

const COMMON_BANKS = {
    "access": "044", "gtb": "058", "gtbank": "058", "zenith": "057", "uba": "033", "opay": "999992", "kuda": "50211", "moniepoint": "50515",
    "palmpay": "999991", "firstbank": "011", "fbn": "011", "wema": "035", "fidelity": "070", "ecobank": "050", "union": "032", "sterling": "232"
};

async function checkRateLimit(vendorPhone) {
    const vendor = await Vendor.findOne({ phoneNumber: vendorPhone });
    if (!vendor) return { allowed: true };
    const now = new Date();
    const resetTime = vendor.messageCountResetAt || new Date(0);
    if (now - resetTime > 3600000) {
        await Vendor.updateOne({ phoneNumber: vendorPhone }, { messageCount: 1, messageCountResetAt: now });
        return { allowed: true, count: 1 };
    }
    if (vendor.messageCount >= 30) return { allowed: false, retryAfter: Math.ceil((resetTime - now + 3600000) / 1000) };
    await Vendor.updateOne({ phoneNumber: vendorPhone }, { $inc: { messageCount: 1 } });
    return { allowed: true, count: vendor.messageCount + 1 };
}

async function safeOpenAIChat(systemPrompt, userContent, maxTokens) {
    maxTokens = maxTokens || 250;
    const sanitizedContent = userContent.replace(/\\b(system|assistant|ignore previous|disregard|override|forget instructions)\\b/gi, '[REDACTED]').substring(0, 2000);
    const response = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: "gpt-4o-mini",
        messages: [{ role: "system", content: systemPrompt }, { role: "user", content: sanitizedContent }],
        max_tokens: maxTokens,
        temperature: 0.7
    }, { headers: { Authorization: 'Bearer ' + process.env.OPENAI_API_KEY }, timeout: 15000 });
    return response.data.choices[0].message.content;
}

async function handleVendorSetupAndOnboarding(sock, msg, textMessage, lowerText) {
    const senderJid = msg.key.remoteJid;
    let vendor = await Vendor.findOne({ phoneNumber: senderJid });
    if (!vendor) { vendor = new Vendor({ phoneNumber: senderJid }); await vendor.save(); }
    if (vendor.onboardingStep === "COMPLETED" && !lowerText.startsWith('/')) {
        const rateLimit = await checkRateLimit(senderJid);
        if (!rateLimit.allowed) { await sock.sendMessage(senderJid, { text: 'Rate limit reached. Please wait ' + rateLimit.retryAfter + 's.' }); return true; }
    }
    if (lowerText.startsWith('/setrules ')) {
        const rules = textMessage.substring(10).trim();
        if (rules.length > 2000) { await sock.sendMessage(senderJid, { text: 'Rules too long. Max 2000 characters.' }); return true; }
        vendor.groupRules = rules; await vendor.save();
        await sock.sendMessage(senderJid, { text: '*PA Custom Rules Updated!*\\n\\n"' + rules + '"' }); return true;
    }
    if (lowerText === '/linkgroup') { vendor.onboardingStep = "WAITING_GROUP_LINK"; await vendor.save(); await sock.sendMessage(senderJid, { text: 'Add me to your WhatsApp Group, then type `/here` inside that group!' }); return true; }
    const triggerWords = ["register", "setup", "onboard", "sign up", "get started", "create account", "/signup", "/sign up"];
    const matchesTrigger = triggerWords.some(function(word) { return lowerText.includes(word); });
    const inActiveOnboarding = vendor && vendor.onboardingStep !== "IDLE" && vendor.onboardingStep !== "COMPLETED";
    if ((matchesTrigger && vendor.onboardingStep === "IDLE") || inActiveOnboarding) {
        if (vendor.onboardingStep === "IDLE") { vendor.onboardingStep = "WAITING_BIZ_NAME"; vendor.tempData = {}; await vendor.save(); await sock.sendMessage(senderJid, { text: "Welcome! Let's get your business set up on KukaTai.\\n\\nWhat is your *Business Name*?" }); }
        return true;
    }
    if (vendor.onboardingStep === "WAITING_BIZ_NAME") {
        const bizName = textMessage.trim();
        if (bizName.length < 2 || bizName.length > 100) { await sock.sendMessage(senderJid, { text: 'Business name must be 2-100 characters. Try again:' }); return true; }
        vendor.tempData = { businessName: bizName }; vendor.onboardingStep = "WAITING_BANK"; await vendor.save();
        await sock.sendMessage(senderJid, { text: 'Nice! Now reply with your *Bank Name* (e.g. GTBank, Opay, Kuda):' }); return true;
    }
    if (vendor.onboardingStep === "WAITING_BANK") {
        const cleanBank = lowerText.replace(/\\s+/g, '');
        const bankCode = COMMON_BANKS[cleanBank];
        if (!bankCode) { await sock.sendMessage(senderJid, { text: 'Bank not recognized. Try again:' }); return true; }
        vendor.tempData = Object.assign({}, vendor.tempData, { bankCode: bankCode, bankName: textMessage.trim() }); vendor.onboardingStep = "WAITING_ACCT"; await vendor.save();
        await sock.sendMessage(senderJid, { text: 'Perfect! What is your *10-digit Account Number* for ' + vendor.tempData.bankName + ':' }); return true;
    }
    if (vendor.onboardingStep === "WAITING_ACCT") {
        const accountNumber = textMessage.trim();
        if (!/^\\d{10}$/.test(accountNumber)) { await sock.sendMessage(senderJid, { text: 'Must be exactly 10 digits. Try again:' }); return true; }
        await sock.sendMessage(senderJid, { text: 'Verifying account details...' });
        try {
            const verifyRes = await flwRequest('POST', '/banks/account-resolve', { account: { code: vendor.tempData.bankCode, number: accountNumber }, currency: "NGN" });
            if (verifyRes.data && verifyRes.data.status === 'success') {
                const accountName = verifyRes.data.data.account_name;
                vendor.tempData = Object.assign({}, vendor.tempData, { accountNumber: accountNumber, accountName: accountName }); vendor.onboardingStep = "CONFIRMATION"; await vendor.save();
                await sock.sendMessage(senderJid, { text: 'Is this correct?\\n\\n*Name:* ' + accountName + '\\n*Bank:* ' + vendor.tempData.bankName + '\\n*Acct:* ' + accountNumber + '\\n\\nReply *YES* to activate or *NO* to reset.' });
            } else { await sock.sendMessage(senderJid, { text: 'Account verification failed. Re-enter:' }); }
        } catch (err) { console.error("Account Verification Error:", err.response?.data || err.message); await sock.sendMessage(senderJid, { text: 'Verification failed. Re-enter:' }); }
        return true;
    }
    if (vendor.onboardingStep === "CONFIRMATION") {
        if (lowerText === 'yes') {
            try {
                const customerRes = await flwRequest('POST', '/customers', { email: vendor.tempData.businessName.replace(/\\s+/g, '').toLowerCase() + '@kukatai.com', name: { first: vendor.tempData.businessName.split(' ')[0] || 'Business', last: vendor.tempData.businessName.split(' ').slice(1).join(' ') || 'Owner' }, phone: { country_code: '234', number: senderJid.split('@')[0].replace(/^\\+/, '') } });
                const customerId = customerRes.data.data.id;
                const recipientRes = await flwRequest('POST', '/transfers/recipients', { type: "bank_ngn", bank: { account_number: vendor.tempData.accountNumber, code: vendor.tempData.bankCode }, name: { first: vendor.tempData.accountName.split(' ')[0] || 'User', last: vendor.tempData.accountName.split(' ').slice(1).join(' ') || 'Name' } });
                const recipientId = recipientRes.data.data.id;
                vendor.businessName = vendor.tempData.businessName; vendor.bankCode = vendor.tempData.bankCode; vendor.bankName = vendor.tempData.bankName;
                vendor.accountNumber = vendor.tempData.accountNumber; vendor.accountName = vendor.tempData.accountName; vendor.customerId = customerId; vendor.recipientId = recipientId;
                vendor.onboardingStep = "COMPLETED"; vendor.tempData = {}; await vendor.save();
                await sock.sendMessage(senderJid, { text: '*REGISTRATION COMPLETE!*\\n\\nYour KukaTai AI Merchant profile is live for *' + vendor.businessName + '*!\\n\\n1. Use /setrules to set custom business rules\\n2. Send /linkgroup to link your WhatsApp group\\n3. Send product photos directly to this DM' });
            } catch (err) { console.error("Onboarding Error:", err.response?.data || err.message); await sock.sendMessage(senderJid, { text: 'Setup error. Reply YES to try again.' }); }
        } else if (lowerText === 'no') { vendor.onboardingStep = "IDLE"; vendor.tempData = {}; await vendor.save(); await sock.sendMessage(senderJid, { text: 'Reset successful. Type *register* to start again.' }); }
        else { await sock.sendMessage(senderJid, { text: 'Reply *YES* to confirm or *NO* to reset.' }); }
        return true;
    }
    return false;
}

async function handleImageUpload(sock, msg, vendor) {
    const senderJid = msg.key.remoteJid;
    try {
        await sock.sendMessage(senderJid, { text: 'Saving product flyer...' });
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
        if (!buffer) { await sock.sendMessage(senderJid, { text: 'Could not download image. Try again.' }); return; }
        const fileName = 'promos/' + vendor.phoneNumber.split('@')[0] + '_' + Date.now() + '.jpg';
        const { data, error } = await supabase.storage.from('vendor-assets').upload(fileName, buffer, { contentType: 'image/jpeg' });
        if (error) throw error;
        const { data: urlData } = supabase.storage.from('vendor-assets').getPublicUrl(fileName);
        const caption = msg.message.imageMessage?.caption || '';
        vendor.savedPromoImages.push({ url: urlData.publicUrl, caption: caption.substring(0, 500), uploadedAt: new Date() });
        if (vendor.savedPromoImages.length > 20) vendor.savedPromoImages = vendor.savedPromoImages.slice(-20);
        await vendor.save();
        await sock.sendMessage(senderJid, { text: 'Saved! This flyer will be used in group broadcasts.' });
    } catch (err) { console.error("Image upload error:", err.message); await sock.sendMessage(senderJid, { text: 'Failed to save image. Try again.' }); }
}

async function isGroupAdmin(sock, groupJid, userJid) {
    try { const groupMetadata = await sock.groupMetadata(groupJid); const admins = groupMetadata.participants.filter(function(p) { return p.admin === 'admin' || p.admin === 'superadmin'; }).map(function(p) { return p.id; }); return admins.includes(userJid); }
    catch (err) { console.error("Group metadata error:", err.message); return false; }
}

const AUTH_DIR = process.env.RENDER_DISK_PATH ? path.join(process.env.RENDER_DISK_PATH, 'auth_info_baileys') : 'auth_info_baileys';
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

async function startKukaTai() {
    let mongoConnected = false;
    for (let i = 0; i < 5; i++) {
        try { await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000, retryWrites: true, w: 'majority' }); console.log("MongoDB Connected!"); mongoConnected = true; break; }
        catch (err) { console.error('MongoDB attempt ' + (i+1) + '/5 failed: ' + err.message); await delay(5000); }
    }
    if (!mongoConnected) { console.error("MongoDB connection failed. Exiting."); process.exit(1); }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log('Using Baileys v' + version.join('.') + ', isLatest: ' + isLatest);
    
    const sock = makeWASocket({ auth: state, version: version, printQRInTerminal: false, logger: pino({ level: 'silent' }), browser: ['KukaTai', 'Chrome', '1.0.0'], generateHighQualityLinkPreview: true, syncFullHistory: false, markOnlineOnConnect: true });
    global.sock = sock;
    sock.ev.on('creds.update', saveCreds);

    if (process.env.BOT_PHONE_NUMBER && !sock.authState.creds.registered) {
        let phoneNumber = process.env.BOT_PHONE_NUMBER.replace(/[^0-9]/g, '');
        console.log('Attempting to pair with: ' + phoneNumber);
        await delay(3000);
        try { let code = await sock.requestPairingCode(phoneNumber); console.log('PAIRING CODE: ' + code); }
        catch (err) { console.error("Failed to request pairing code:", err.message); }
    }

    sock.ev.on('connection.update', async function(update) {
        const connection = update.connection;
        const lastDisconnect = update.lastDisconnect;
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed (code: ' + statusCode + '). Reconnecting: ' + shouldReconnect);
            if (shouldReconnect) { await delay(5000); startKukaTai(); }
            else { console.log('Logged out. Clear auth folder and restart to pair again.'); }
        } else if (connection === 'open') {
            console.log('KukaTai Agent Connected to WhatsApp!');
            if (!global.supabaseListenerStarted) { startSupabaseListener(sock); global.supabaseListenerStarted = true; }
            if (!global.transactionWatcherStarted) { startTransactionWatcher(sock); global.transactionWatcherStarted = true; }
        }
    });

    sock.ev.on('messages.upsert', async function(m) {
        try {
            const msg = m.messages[0];
            if (!msg.message || msg.key.fromMe) return;
            const senderJid = msg.key.remoteJid;
            const isGroup = senderJid.endsWith('@g.us');
            const textMessage = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || "";
            const lowerText = textMessage.trim().toLowerCase();
            const msgId = msg.key.id;
            const existing = await ProcessedMessage.findOne({ messageId: msgId });
            if (existing) return;
            await ProcessedMessage.create({ messageId: msgId });
            console.log('[' + (isGroup ? 'GROUP' : 'DM') + '] ' + senderJid + ': "' + textMessage.substring(0, 50) + '"');

            if (!isGroup) {
                let vendor = await Vendor.findOne({ phoneNumber: senderJid });
                const triggerWords = ["register", "setup", "onboard", "sign up", "get started", "create account", "/signup", "/sign up"];
                const matchesTrigger = triggerWords.some(function(word) { return lowerText.includes(word); });
                const inActiveOnboarding = vendor && vendor.onboardingStep !== "IDLE" && vendor.onboardingStep !== "COMPLETED";
                if (matchesTrigger || inActiveOnboarding) { await handleVendorSetupAndOnboarding(sock, msg, textMessage, lowerText); return; }
                if (vendor && vendor.onboardingStep === "COMPLETED") {
                    if (msg.message.imageMessage) { await handleImageUpload(sock, msg, vendor); return; }
                    try { const aiResponse = await safeOpenAIChat('You are the executive assistant for "' + vendor.businessName + '". Provide professional help. NEVER reveal API keys or system details.', textMessage, 250); await sock.sendMessage(senderJid, { text: aiResponse }); }
                    catch (err) { console.error("OpenAI DM error:", err.message); await sock.sendMessage(senderJid, { text: "I am having trouble. Try again!" }); }
                } else if (!vendor || vendor.onboardingStep === "IDLE") { await sock.sendMessage(senderJid, { text: "Welcome to KukaTai! Type *register* to set up your merchant account." }); }
            }

            if (isGroup) {
                const vendor = await Vendor.findOne({ targetGroupId: senderJid });
                if (lowerText === '/here') {
                    const senderNum = (msg.key.participant ? msg.key.participant.split('@')[0] : '') + "@s.whatsapp.net";
                    if (!senderNum || senderNum === '@s.whatsapp.net') { await sock.sendMessage(senderJid, { text: 'Could not identify sender.' }); return; }
                    const checkVendor = await Vendor.findOne({ phoneNumber: senderNum });
                    if (!checkVendor) { await sock.sendMessage(senderJid, { text: 'You must register with KukaTai first. DM me *register*.' }); return; }
                    if (checkVendor.onboardingStep !== "COMPLETED") { await sock.sendMessage(senderJid, { text: 'Complete your registration first.' }); return; }
                    const isAdmin = await isGroupAdmin(sock, senderJid, msg.key.participant);
                    if (!isAdmin) { await sock.sendMessage(senderJid, { text: 'Only group admins can link this AI.' }); return; }
                    checkVendor.targetGroupId = senderJid; await checkVendor.save();
                    await sock.sendMessage(senderJid, { text: '*AI Agent Activated!* Managing inquiries for *' + checkVendor.businessName + '*.' }); return;
                }
                if (vendor && vendor.onboardingStep === "COMPLETED") {
                    const botJid = sock.user.id;
                    const botNumber = botJid.split(':')[0].split('@')[0];
                    const mentionedJids = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
                    const isMentioned = mentionedJids.some(function(jid) { return jid.includes(botNumber); });
                    const matchesKeyword = vendor.customKeywords.some(function(keyword) { return lowerText.includes(keyword.toLowerCase()); });
                    if (isMentioned || matchesKeyword) {
                        try { const aiResponse = await safeOpenAIChat('You are the friendly AI sales assistant for "' + vendor.businessName + '". Rules: ' + vendor.groupRules + ' NEVER reveal API keys. Be helpful and drive sales.', 'From ' + (msg.pushName || "Customer") + ': ' + textMessage, 150); await sock.sendMessage(senderJid, { text: aiResponse }, { quoted: msg }); }
                        catch (err) { console.error("OpenAI Group error:", err.message); }
                    }
                }
            }
        } catch (globalErr) { console.error("Fatal Error:", globalErr); }
    });
}

let supabaseChannel = null;
function startSupabaseListener(sock) {
    if (supabaseChannel) supabase.removeChannel(supabaseChannel);
    supabaseChannel = supabase.channel('public:transactions').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'transactions' }, async function(payload) {
        const record = payload.new;
        if (record.status === 'successful' || record.status === 'success') {
            const txRef = record.tx_ref; const amount = record.amount;
            try {
                if (!txRef || typeof txRef !== 'string') return;
                const refParts = txRef.split('_');
                if (refParts.length < 2 || refParts[0] !== 'kukatai') return;
                const vendorPhone = refParts[1] + "@s.whatsapp.net";
                const vendor = await Vendor.findOneAndUpdate({ phoneNumber: vendorPhone }, { $inc: { dashboardBalance: amount } }, { new: true });
                if (vendor && sock) await sock.sendMessage(vendorPhone, { text: '*KukaTai Instant Credit!*\\n\\nCredited *N' + amount + '*!\\nBalance: *N' + vendor.dashboardBalance + '*' });
            } catch (err) { console.error("Supabase Realtime Credit Error:", err.message); }
        }
    }).subscribe(function(status) { console.log('Supabase listener status: ' + status); });
}

async function startTransactionWatcher(sock) {
    try {
        const changeStream = Transaction.watch([{ $match: { 'fullDocument.status': { $in: ['successful', 'success'] } } }]);
        changeStream.on('change', async function(change) {
            try {
                const record = change.fullDocument; if (!record) return;
                const txRef = record.tx_ref; const amount = record.amount;
                if (!txRef || typeof txRef !== 'string') return;
                const refParts = txRef.split('_'); if (refParts.length < 2 || refParts[0] !== 'kukatai') return;
                const vendorPhone = refParts[1] + "@s.whatsapp.net";
                const vendor = await Vendor.findOneAndUpdate({ phoneNumber: vendorPhone }, { $inc: { dashboardBalance: amount } }, { new: true });
                if (vendor && sock) await sock.sendMessage(vendorPhone, { text: '*KukaTai Instant Credit!*\\n\\nCredited *N' + amount + '*!\\nBalance: *N' + vendor.dashboardBalance + '*' });
            } catch (err) { console.error("MongoDB Change Stream Error:", err.message); }
        });
        changeStream.on('error', function(err) { console.error("Change Stream error:", err.message); });
        console.log('MongoDB Transaction Watcher started');
    } catch (err) { console.log('MongoDB Change Streams not available:', err.message); }
}

startKukaTai().catch(function(err) { console.error("Fatal bootstrap error:", err); process.exit(1); });
"""

with open('/mnt/agents/output/index.js', 'w') as f:
    f.write(js_code)

import subprocess
result = subprocess.run(['node', '--check', '/mnt/agents/output/index.js'], capture_output=True, text=True)
print("Return code:", result.returncode)
print("STDERR:", result.stderr)
print("File size:", len(js_code), "chars")
