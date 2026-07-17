const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const mongoose = require('mongoose');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());
app.get('/', (req, res) => res.status(200).json({ status: "Active" }));
app.listen(process.env.PORT || 10000);

const AUTH_DIR = process.env.RENDER_DISK_PATH ? path.join(process.env.RENDER_DISK_PATH, 'auth_info_baileys') : 'auth_info_baileys';
if (!fs.existsSync(AUTH_DIR)) {
    try { fs.mkdirSync(AUTH_DIR, { recursive: true }); } catch (e) { console.error("Auth dir error", e); }
}

async function startKukaTai() {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log("Connected to MongoDB");
        
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
        const { version } = await fetchLatestBaileysVersion();
        
        const sock = makeWASocket({ 
            auth: state, 
            version, 
            logger: pino({ level: 'silent' }), 
            browser: ['KukaTai', 'Chrome', '1.0.0'] 
        });

        sock.ev.on('creds.update', saveCreds);

        if (process.env.BOT_PHONE_NUMBER && !sock.authState.creds.registered) {
            setTimeout(async () => {
                try {
                    const code = await sock.requestPairingCode(process.env.BOT_PHONE_NUMBER.replace(/[^0-9]/g, ''));
                    console.log("PAIRING CODE:", code);
                } catch (e) { console.error("Pairing error:", e.message); }
            }, 5000);
        }

        sock.ev.on('connection.update', (update) => {
            if (update.connection === 'close') {
                if (update.lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
                    startKukaTai();
                }
            }
        });

    } catch (err) {
        console.error("Startup error:", err);
        process.exit(1);
    }
}

startKukaTai();
