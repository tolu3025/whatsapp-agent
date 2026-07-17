const express = require('express');
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
for (const key of REQUIRED_ENV) { if (!process.env[key]) process.exit(1); }

const FLW_BASE_URL = 'https://api.flutterwave.com/v3';
const flwTokenManager = {
    token: null, expiresAt: 0,
    async getToken() {
        if (this.token && Date.now() < this.expiresAt - 60000) return this.token;
        const res = await axios.post('https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token', new URLSearchParams({ client_id: process.env.FLUTTERWAVE_CLIENT_ID, client_secret: process.env.FLUTTERWAVE_CLIENT_SECRET, grant_type: 'client_credentials' }));
        this.token = res.data.access_token;
        this.expiresAt = Date.now() + (res.data.expires_in * 1000);
        return this.token;
    }
};

async function flwRequest(method, endpoint, data) {
    const token = await flwTokenManager.getToken();
    return axios({ method, url: FLW_BASE_URL + endpoint, data, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } });
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const VendorSchema = new mongoose.Schema({
    phoneNumber: { type: String, required: true, unique: true },
    businessName: String, bankCode: String, bankName: String, accountNumber: String, accountName: String,
    recipientId: String, customerId: String,
    onboardingStep: { type: String, enum: ["IDLE", "WAITING_BIZ_NAME", "WAITING_BANK", "WAITING_ACCT", "CONFIRMATION", "COMPLETED"], default: "IDLE" },
    tempData: Object, groupRules: { type: String, default: "Be polite, showcase our products." },
    savedPromoImages: [{ url: String, caption: String }]
}, { timestamps: true });
const Vendor = mongoose.models.Vendor || mongoose.model('Vendor', VendorSchema);

const app = express();
app.use(express.json());
app.listen(process.env.PORT || 10000);

async function safeOpenAIChat(systemPrompt, userContent) {
    const res = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: "gpt-4o-mini",
        messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userContent }],
        max_tokens: 300
    }, { headers: { Authorization: 'Bearer ' + process.env.OPENAI_API_KEY } });
    return res.data.choices[0].message.content;
}

async function handleVendorFlow(sock, msg, text, lower) {
    const jid = msg.key.remoteJid;
    let v = await Vendor.findOne({ phoneNumber: jid }) || new Vendor({ phoneNumber: jid });
    
    if (lower.includes("register") && v.onboardingStep === "IDLE") { v.onboardingStep = "WAITING_BIZ_NAME"; await v.save(); await sock.sendMessage(jid, { text: "Business Name?" }); return true; }
    if (v.onboardingStep === "WAITING_BIZ_NAME") { v.tempData = { businessName: text }; v.onboardingStep = "WAITING_BANK"; await v.save(); await sock.sendMessage(jid, { text: "Bank Name?" }); return true; }
    if (v.onboardingStep === "WAITING_BANK") { v.tempData.bankName = text; v.onboardingStep = "WAITING_ACCT"; await v.save(); await sock.sendMessage(jid, { text: "Account Number?" }); return true; }
    if (v.onboardingStep === "WAITING_ACCT") {
        const res = await flwRequest('POST', '/banks/account-resolve', { account: { code: "058", number: text }, currency: "NGN" });
        if (res.data?.status === 'success') { v.tempData.accountNumber = text; v.tempData.accountName = res.data.data.account_name; v.onboardingStep = "CONFIRMATION"; await v.save(); await sock.sendMessage(jid, { text: `Confirm ${res.data.data.account_name}? (YES/NO)` }); }
        return true;
    }
    if (v.onboardingStep === "CONFIRMATION" && lower === 'yes') {
        v.businessName = v.tempData.businessName; v.accountNumber = v.tempData.accountNumber; v.accountName = v.tempData.accountName; v.onboardingStep = "COMPLETED"; v.tempData = {}; await v.save();
        await sock.sendMessage(jid, { text: "Registration Complete!" }); return true;
    }
    return false;
}

const AUTH_DIR = 'auth_info_baileys';
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR);

async function startKukaTai() {
    await mongoose.connect(process.env.MONGODB_URI);
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const sock = makeWASocket({ auth: state, logger: pino({ level: 'silent' }), browser: ['KukaTai', 'Chrome', '1.0.0'] });
    sock.ev.on('creds.update', saveCreds);

    if (process.env.BOT_PHONE_NUMBER && !sock.authState.creds.registered) {
        try { await sock.requestPairingCode(process.env.BOT_PHONE_NUMBER.replace(/[^0-9]/g, '')); } catch (e) {}
    }

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;
        const jid = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
        if (await handleVendorFlow(sock, msg, text, text.toLowerCase())) return;
        let v = await Vendor.findOne({ phoneNumber: jid });
        if (v?.onboardingStep === "COMPLETED") {
            const reply = await safeOpenAIChat('Assistant for ' + v.businessName + '. Rules: ' + v.groupRules, text);
            await sock.sendMessage(jid, { text: reply });
        }
    });
}
startKukaTai();
