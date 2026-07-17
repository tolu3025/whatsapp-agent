/**
 * PRODUCTION-READY MULTI-TENANT WHATSAPP ENGINE & PAYMENTS INTEGRATION
 * Supported Library: @whiskeysockets/baileys (v7 RC Compatible)
 * Format: CommonJS (Prevents ES Module 'type: module' crashes)
 */

const makeWASocket = require('@whiskeysockets/baileys').default || require('@whiskeysockets/baileys');
const {
    DisconnectReason,
    fetchLatestBaileysVersion,
    delay,
    jidDecode
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const { createClient } = require('@supabase/supabase-js');
const { MongoClient } = require('mongodb');
const express = require('express');
const cors = require('cors');

// Load environment variables
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// Initialize logger
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// =========================================================================
// 1. SERVICES & DATABASE INITIALIZATION
// =========================================================================

const mongoClient = new MongoClient(process.env.MONGODB_URI);
let db;

// Supabase configuration
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Memory cache for tenant instance sockets and states
const activeInstances = new Map();

// =========================================================================
// 2. STABLE MONGODB AUTH ADAPTER (Baileys v7)
// =========================================================================
/**
 * Custom session manager retrieving credentials directly from MongoDB
 * allowing server-less horizontal scaling & persistent sessions.
 */
async function useMongoAuthState(tenantId) {
    const collection = db.collection('whatsapp_sessions');

    const writeData = async (data, key) => {
        try {
            await collection.updateOne(
                { tenantId, key },
                { $set: { data: JSON.stringify(data), updatedAt: new Date() } },
                { upsert: true }
            );
        } catch (err) {
            logger.error(`[MongoAuth] Failed to write key: ${key} for tenant ${tenantId}`, err);
        }
    };

    const readData = async (key) => {
        try {
            const result = await collection.findOne({ tenantId, key });
            return result ? JSON.parse(result.data) : null;
        } catch (err) {
            logger.error(`[MongoAuth] Failed to read key: ${key} for tenant ${tenantId}`, err);
            return null;
        }
    };

    const removeData = async (key) => {
        try {
            await collection.deleteOne({ tenantId, key });
        } catch (err) {
            logger.error(`[MongoAuth] Failed to delete key: ${key} for tenant ${tenantId}`, err);
        }
    };

    const credsDoc = await readData('creds');
    const creds = credsDoc || {};

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await readData(`${type}-${id}`);
                            if (value) {
                                data[id] = value;
                            }
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

// =========================================================================
// 3. CORE WA ENGINE & RECONNECTION CONTROLLER
// =========================================================================

/**
 * Initializes/Restarts a dedicated WhatsApp Socket for a Specific Tenant
 * Fixes: "428 Connection Closed" by forcing clean browser parameters and execution order
 */
async function startTenantSocket(tenantId, options = {}) {
    logger.info(`[Instance] Initializing client for Tenant: ${tenantId}...`);

    if (activeInstances.has(tenantId)) {
        try {
            const oldSock = activeInstances.get(tenantId);
            oldSock.ev.removeAllListeners('connection.update');
            oldSock.ev.removeAllListeners('creds.update');
            oldSock.ev.removeAllListeners('messages.upsert');
            oldSock.end();
        } catch (e) {
            logger.debug(`[Cleanup] Safe-bypass cleanup of ${tenantId}: ${e.message}`);
        }
        activeInstances.delete(tenantId);
    }

    const { state, saveCreds } = await useMongoAuthState(tenantId);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    logger.info(`[WA-Version] Using WA Web Version: ${version.join('.')} (isLatest: ${isLatest})`);

    /**
     * CRITICAL BUGFIX: 428 Connection Closed
     * Bypasses strict desktop user-agent checks by presenting Chrome/Ubuntu parameters
     */
    const sockConfig = {
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        browser: ['Ubuntu', 'Chrome', '20.0.0'],
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 25000,
        emitOwnEvents: true,
        defaultQueryTimeoutMs: 0,
        syncFullHistory: false,
        markOnlineOnConnect: true,
    };

    const sock = makeWASocket(sockConfig);
    activeInstances.set(tenantId, sock);

    // Dynamic pairing code flow if requested
    if (options.requestPairingCode && options.phoneNumber) {
        // Wait exactly 5 seconds to let handshake negotiate cleanly before calling requestPairingCode
        setTimeout(async () => {
            try {
                const formattedPhone = options.phoneNumber.replace(/[^0-9]/g, '');
                logger.info(`[Pairing] Requesting pairing code for ${formattedPhone} (Tenant: ${tenantId})`);
                const code = await sock.requestPairingCode(formattedPhone);
                logger.info(`[Pairing] Successfully retrieved Pairing Code: ${code}`);

                // Store pairing code inside MongoDB so UI can pull it
                await db.collection('pairing_codes').updateOne(
                    { tenantId },
                    { $set: { code, phoneNumber: formattedPhone, createdAt: new Date() } },
                    { upsert: true }
                );
            } catch (err) {
                logger.error(`[Pairing] Failed to acquire pairing code for ${tenantId}:`, err);
            }
        }, 5000);
    }

    // --- EVENT LISTENERS ---
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && !options.phoneNumber) {
            // Store QR string in Database for dynamic web rendering
            await db.collection('whatsapp_sessions').updateOne(
                { tenantId, key: 'qr_string' },
                { $set: { data: qr, updatedAt: new Date() } },
                { upsert: true }
            );
            logger.info(`[QR-Update] Saved fresh QR code sequence for Tenant: ${tenantId}`);
        }

        if (connection === 'connecting') {
            logger.info(`[Socket-State] Tenant ${tenantId} is connecting...`);
        }

        if (connection === 'open') {
            logger.info(`[Socket-State] Tenant ${tenantId} is CONNECTED & active.`);
            await db.collection('pairing_codes').deleteOne({ tenantId });
            await db.collection('whatsapp_sessions').deleteOne({ tenantId, key: 'qr_string' });
            
            await db.collection('vendors').updateOne(
                { tenantId },
                { $set: { status: 'connected', lastSeen: new Date() } },
                { upsert: true }
            );
        }

        if (connection === 'close') {
            const lastDisconnectError = lastDisconnect && lastDisconnect.error;
            const statusCode = lastDisconnectError ? lastDisconnectError.output && lastDisconnectError.output.statusCode : null;
            const errorDescription = lastDisconnectError ? lastDisconnectError.message : 'Unknown Error';
            logger.warn(`[Socket-Closed] Tenant ${tenantId} closed: Code ${statusCode} - ${errorDescription}`);

            await db.collection('vendors').updateOne(
                { tenantId },
                { $set: { status: 'disconnected', offlineAt: new Date() } }
            );

            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            if (shouldReconnect) {
                let reconnectDelay = 5000;
                if (statusCode === DisconnectReason.restartRequired || statusCode === 515) {
                    reconnectDelay = 1000;
                } else if (statusCode === 428) {
                    reconnectDelay = 10000;
                }

                logger.info(`[Instance-Recovery] Re-initializing ${tenantId} in ${reconnectDelay / 1000}s...`);
                setTimeout(() => {
                    startTenantSocket(tenantId);
                }, reconnectDelay);
            } else {
                logger.error(`[Instance-LoggedOut] Tenant ${tenantId} terminated permanently. Deleting instance credentials.`);
                await db.collection('whatsapp_sessions').deleteMany({ tenantId });
                await db.collection('pairing_codes').deleteOne({ tenantId });
                activeInstances.delete(tenantId);
            }
        }
    });

    sock.ev.on('messages.upsert', async (chatUpdate) => {
        try {
            const { messages, type } = chatUpdate;
            if (type !== 'notify') return;

            for (const msg of messages) {
                if (!msg.message) continue;
                if (msg.key.fromMe) continue;

                const senderJid = msg.key.remoteJid;
                const textMessage = msg.message.conversation || 
                                    (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text) || 
                                    (msg.message.imageMessage && msg.message.imageMessage.caption) || '';

                logger.debug(`[Inbound] ${senderJid} said: "${textMessage}"`);

                const vendor = await db.collection('vendors').findOne({ tenantId });
                if (vendor && vendor.aiAgentEnabled && textMessage) {
                    await handleAIAgentResponse(tenantId, sock, senderJid, textMessage, msg);
                }

                if (senderJid.endsWith('@g.us')) {
                    await handleGroupAssistant(tenantId, sock, senderJid, textMessage, msg);
                }
            }
        } catch (err) {
            logger.error(`[Upsert-Handler] Error processing incoming WhatsApp event for ${tenantId}:`, err);
        }
    });

    return sock;
}

// =========================================================================
// 4. AI WHATSAPP AGENT & NLP ROUTER (Context Aware)
// =========================================================================
async function handleAIAgentResponse(tenantId, sock, jid, text, originMsg) {
    await sock.sendPresenceUpdate('composing', jid);
    await delay(2000);

    const vendor = await db.collection('vendors').findOne({ tenantId });
    const bizName = (vendor && vendor.businessName) || 'Our Store';
    const supportFallback = (vendor && vendor.supportPhone) || 'our support line';

    let replyText = '';
    const normalizedText = text.toLowerCase();

    if (normalizedText.includes('order') || normalizedText.includes('buy')) {
        replyText = `Welcome to *${bizName}*! 🛒 \nTo make placing your order fast, you can browse through our menu or catalog here. Type "pay" to check out our automated payment options.`;
    } else if (normalizedText.includes('price') || normalizedText.includes('cost')) {
        replyText = `Our active catalog pricing varies by custom configuration. If you're a registered multi-tenant client, navigate to your Dashboard or simply text us your targeted order specifications!`;
    } else if (normalizedText.includes('pay') || normalizedText.includes('checkout')) {
        replyText = `We securely accept card, account transfers, and USSD payments directly via *Flutterwave* integrations! 💳 Type "onboard" if you are a vendor wishing to accept payments on your platform.`;
    } else {
        replyText = `Hi there! Thanks for reaching out to *${bizName}* 🤖. How can we help you today? \n\nFeel free to ask about our custom automation features, vendor setup, or request support at ${supportFallback}.`;
    }

    await sock.sendMessage(jid, { text: replyText }, { quoted: originMsg });
    await sock.sendPresenceUpdate('paused', jid);
}

// =========================================================================
// 5. GROUP ASSISTANT ACTIONS
// =========================================================================
async function handleGroupAssistant(tenantId, sock, groupJid, text, originMsg) {
    const isCommand = text.startsWith('/');
    if (!isCommand) return;

    const command = text.slice(1).trim().split(' ')[0].toLowerCase();

    if (command === 'rules') {
        const rules = `*Group Rules:*\n1. No spamming links or promotional spam.\n2. Respect other group elements.\n3. Type /help to view active assistant actions.`;
        await sock.sendMessage(groupJid, { text: rules }, { quoted: originMsg });
    } else if (command === 'help') {
        const helpText = `🤖 *Group Assistant Commands:*\n- \`/rules\` : View default rules.\n- \`/status\` : Check WA node health status.`;
        await sock.sendMessage(groupJid, { text: helpText }, { quoted: originMsg });
    } else if (command === 'status') {
        await sock.sendMessage(groupJid, { text: `✅ System is fully operational under Tenant Node ID: ${tenantId}` }, { quoted: originMsg });
    }
}

// =========================================================================
// 6. SUPABASE REAL-TIME PAYMENT LISTENER & FLUTTERWAVE CONTROLLER
// =========================================================================
function initializePaymentListener() {
    logger.info('[Supabase-Payments] Booting real-time subscription listener...');

    supabase
        .channel('schema-db-changes')
        .on(
            'postgres_changes',
            {
                event: 'INSERT',
                schema: 'public',
                table: 'transactions'
            },
            async (payload) => {
                const { tenantId, amount, currency, status, reference, customerPhone, txId } = payload.new;
                logger.info(`[Payment-Event] New payment registered. Tx: ${txId}, Tenant: ${tenantId}, Status: ${status}`);

                if (status !== 'successful' && status !== 'completed') return;

                const tenantSock = activeInstances.get(tenantId);
                if (tenantSock) {
                    try {
                        const targetJid = customerPhone.includes('@s.whatsapp.net') ? customerPhone : `${customerPhone}@s.whatsapp.net`;
                        const confirmationMessage = `🎉 *Payment Confirmed!* \n\nThank you for your order. We have successfully processed your payment of *${currency} ${amount}* (Ref: ${reference}). Your service/shipment process is starting now.`;
                        
                        await tenantSock.sendMessage(targetJid, { text: confirmationMessage });
                        logger.info(`[Payment-WhatsApp] Sent confirmation message directly to: ${targetJid}`);
                    } catch (err) {
                        logger.error(`[Payment-WhatsApp-Error] Failed to transmit receipt confirmation to customer phone:`, err);
                    }
                }
            }
        )
        .subscribe();
}

// =========================================================================
// 7. MULTI-TENANT ONBOARDING FLOW (VENDOR CREATOR)
// =========================================================================
async function registerNewVendor(vendorConfig) {
    const { tenantId, businessName, email } = vendorConfig;

    if (!tenantId || !businessName) {
        throw new Error('Crucial properties (tenantId, businessName) missing from registration parameters.');
    }

    await db.collection('vendors').updateOne(
        { tenantId },
        {
            $set: {
                businessName,
                email,
                onboardingStatus: 'pending',
                aiAgentEnabled: true,
                createdAt: new Date(),
                updatedAt: new Date()
            }
        },
        { upsert: true }
    );

    logger.info(`[Onboarding] Tenant '${tenantId}' has been registered in storage.`);
}

// =========================================================================
// 8. EXPRESS CONTROL WEB APIs
// =========================================================================

app.post('/api/tenant/onboard', async (req, res) => {
    try {
        const { tenantId, businessName, email, initialPhone } = req.body;
        await registerNewVendor({ tenantId, businessName, email, initialPhone });
        
        res.status(200).json({ 
            success: true, 
            message: 'Vendor record registered. Proceed to /api/tenant/connect to trigger QR generation or pairing.' 
        });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

app.post('/api/tenant/connect', async (req, res) => {
    try {
        const { tenantId, phoneNumber, usePairingCode } = req.body;

        if (!tenantId) {
            return res.status(400).json({ success: false, error: 'tenantId property is required.' });
        }

        if (usePairingCode && !phoneNumber) {
            return res.status(400).json({ success: false, error: 'phoneNumber is required when using Pairing Code.' });
        }

        await startTenantSocket(tenantId, {
            requestPairingCode: !!usePairingCode,
            phoneNumber: phoneNumber || null
        });

        res.status(200).json({
            success: true,
            message: usePairingCode 
                ? 'Pairing code connection request queued. Pairing string will update in db shortly.' 
                : 'QR listener initialized. Fetch current state to render output.'
        });
    } catch (err) {
        logger.error('[API Connect Error]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/tenant/status/:tenantId', async (req, res) => {
    try {
        const { tenantId } = req.params;
        const tenant = await db.collection('vendors').findOne({ tenantId });
        const pairingDoc = await db.collection('pairing_codes').findOne({ tenantId });
        const qrDoc = await db.collection('whatsapp_sessions').findOne({ tenantId, key: 'qr_string' });

        res.status(200).json({
            tenantId,
            status: (tenant && tenant.status) || 'disconnected',
            pairingCode: (pairingDoc && pairingDoc.code) || null,
            qrCode: (qrDoc && qrDoc.data) || null
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/webhooks/flutterwave', async (req, res) => {
    try {
        const signature = req.headers['verif-hash'];
        if (process.env.FLUTTERWAVE_SECRET_HASH && signature !== process.env.FLUTTERWAVE_SECRET_HASH) {
            return res.status(401).json({ error: 'Unauthorized signature payload' });
        }

        const { event, data } = req.body;
        logger.info(`[Flutterwave-Webhook] Event received: ${event}`);

        if (event === 'charge.completed' && data.status === 'successful') {
            const { tx_ref, amount, currency, customer, id } = data;
            const tenantId = tx_ref.split('_')[0] || 'default';

            const { error } = await supabase.from('transactions').insert({
                tenantId,
                amount,
                currency,
                status: 'successful',
                reference: tx_ref,
                customerPhone: customer.phone_number || '',
                txId: String(id)
            });

            if (error) {
                logger.error('[Flutterwave-Webhook] DB Insert Error:', error);
                throw error;
            }
        }

        res.status(200).send('Event processed smoothly.');
    } catch (err) {
        logger.error('[Webhook Error]', err);
        res.status(500).json({ error: err.message });
    }
});

// =========================================================================
// 9. CLEAN BOOTSTRAP INITIALIZATION
// =========================================================================
async function bootstrap() {
    try {
        logger.info('Starting Multi-Tenant Core Services...');
        
        // 1. Establish MongoDB connection first
        await mongoClient.connect();
        db = mongoClient.db(process.env.MONGO_DB_NAME || 'whatsapp_tenant_db');
        logger.info('Connected securely to MongoDB.');

        // 2. Start Payment Event Real-time Subscriptions
        initializePaymentListener();

        // 3. Start Express HTTP Server
        const PORT = process.env.PORT || 3000;
        app.listen(PORT, () => {
            logger.info(`🚀 Multi-Tenant WhatsApp Server running seamlessly on Port ${PORT}`);
        });

    } catch (err) {
        logger.error('CRITICAL BOOTSTRAP FAILURE:', err);
        process.exit(1);
    }
}

bootstrap();
