const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const mongoose = require('mongoose');
require('dotenv').config();

// --- 1. Express Server & Health Check ---
const app = express();
app.listen(process.env.PORT || 10000, () => console.log("Server running"));

// --- 2. Database ---
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log("Connected to MongoDB"))
    .catch(err => console.error("DB Error:", err));

// --- 3. Persistent Auth (Uses AUTH_DIR from Environment Variables) ---
const authPath = process.env.AUTH_DIR || './auth_info_baileys';

async function startKukaTai() {
    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const { version } = await fetchLatestBaileysVersion();
    
    const sock = makeWASocket({ 
        auth: state, 
        version,
        logger: pino({ level: 'silent' }), 
        browser: ['KukaTai-Scale', 'Chrome', '1.0.0'] 
    });

    sock.ev.on('creds.update', saveCreds);

    // --- 4. Pairing & Connection Logic ---
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'open') {
            console.log("✅ Connection Open!");
            // Only request pairing if not already registered
            if (!sock.authState.creds.registered && process.env.BOT_PHONE_NUMBER) {
                console.log("⚠️ Not registered. Requesting pairing code...");
                try {
                    const code = await sock.requestPairingCode(process.env.BOT_PHONE_NUMBER.replace(/[^0-9]/g, ''));
                    console.log("🔑 PAIRING CODE:", code);
                } catch (e) {
                    console.error("Pairing Error:", e.message);
                }
            }
        }
        
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startKukaTai();
        }
    });

    // --- 5. Message Handler ---
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;
        
        const jid = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
        
        // Basic response to verify bot is alive
        if (text.toLowerCase() === "/ping") {
            await sock.sendMessage(jid, { text: "KukaTai is active and scaling! 🚀" });
        }
    });
}

startKukaTai();
