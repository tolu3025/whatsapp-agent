// index.js - The entry point
const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const mongoose = require('mongoose');
require('dotenv').config();

// --- 1. Database Connection (Modular) ---
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log("Connected to MongoDB"))
    .catch(err => console.error("DB Connection Error:", err));

// --- 2. Express Server (For Health Checks) ---
const app = express();
app.use(express.json());
app.get('/health', (req, res) => res.status(200).send('OK'));
app.listen(process.env.PORT || 10000);

// --- 3. Persistent Authentication ---
// Use RENDER_DISK_PATH for Render persistent storage
const authPath = process.env.RENDER_DISK_PATH || './auth_info_baileys';

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    
    const sock = makeWASocket({ 
        auth: state, 
        logger: pino({ level: 'silent' }),
        browser: ['KukaTai-Scale', 'Chrome', '1.0.0'] 
    });

    sock.ev.on('creds.update', saveCreds);

    // --- 4. Event Handling (The "Engine") ---
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        try {
            await handleIncomingMessage(sock, msg);
        } catch (err) {
            console.error("Message Handler Error:", err);
        }
    });

    // --- 5. Auto-reconnect Logic ---
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        }
    });
}

// --- 6. Logic (Recommend moving this to a separate service file) ---
async function handleIncomingMessage(sock, msg) {
    // Logic for onboarding, AI processing, and banking here.
    // Ensure you use try-catch blocks to prevent global crashes.
}

startBot();
