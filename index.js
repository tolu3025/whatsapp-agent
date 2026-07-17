const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const mongoose = require('mongoose');
require('dotenv').config();

const app = express();
app.listen(process.env.PORT || 10000, () => console.log("Server running"));

mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log("Connected to MongoDB"))
    .catch(err => console.error("DB Error:", err));

const authPath = process.env.AUTH_DIR || './auth_info_baileys';

async function startKukaTai() {
    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const { version } = await fetchLatestBaileysVersion();
    
    const sock = makeWASocket({ 
        auth: state, 
        version,
        logger: pino({ level: 'silent' }), 
        browser: ['KukaTai-Force', 'Chrome', '1.0.0'] 
    });

    sock.ev.on('creds.update', saveCreds);

    // --- FORCE PAIRING LOGIC ---
    setTimeout(async () => {
        console.log("DEBUG: Checking BOT_PHONE_NUMBER:", process.env.BOT_PHONE_NUMBER);
        if (!process.env.BOT_PHONE_NUMBER) {
            console.error("ERROR: BOT_PHONE_NUMBER is not set in your Environment Variables!");
            return;
        }
        try {
            console.log("Attempting to generate pairing code...");
            const code = await sock.requestPairingCode(process.env.BOT_PHONE_NUMBER.replace(/[^0-9]/g, ''));
            console.log("🔑 PAIRING CODE IS: " + code);
        } catch (e) {
            console.error("Pairing Error:", e.message);
        }
    }, 10000); // Waits 10 seconds after startup to ensure socket is ready
}

startKukaTai();
