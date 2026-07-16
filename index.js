const { default: makeWASocket, initAuthCreds, BufferJSON, proto, delay, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { OpenAI } = require('openai');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose'); 
const cron = require('node-cron'); 
const axios = require('axios'); 
const os = require('os');

const openai = new OpenAI({ 
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 60000,   
    maxRetries: 3     
});

// 📦 CONNECT TO MONGO CLOUD DATABASE
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log("📦 PERMANENT DATABASE: Connected to MongoDB Atlas Cloud!"))
    .catch(err => console.error("❌ MongoDB Connection Error:", err.message));

// 🗄️ DATABASE SCHEMAS
const UserSchema = new mongoose.Schema({
    remoteJid: { type: String, required: true, unique: true },
    isActive: { type: Boolean, default: false },
    knownFacts: { type: [String], default: [] },
    chatHistory: { type: Array, default: [] } 
});
const User = mongoose.model('User', UserSchema);

const AuthSchema = new mongoose.Schema({
    _id: { type: String, required: true },
    data: { type: String, required: true }
});
const Auth = mongoose.model('Auth', AuthSchema);

const ScheduleSchema = new mongoose.Schema({
    task: { type: String, required: true },
    date: { type: String, required: true }, 
    time: { type: String, required: true }, 
    alertSent: { type: Boolean, default: false }
});
const Schedule = mongoose.model('Schedule', ScheduleSchema);

// 🔐 CUSTOM MONGODB AUTH ADAPTER
async function useMongoDBAuthState() {
    const writeData = async (data, id) => {
        const stringified = JSON.stringify(data, BufferJSON.replacer);
        await Auth.updateOne({ _id: id }, { $set: { data: stringified } }, { upsert: true });
    };
    const readData = async (id) => {
        const doc = await Auth.findOne({ _id: id });
        if (doc && doc.data) return JSON.parse(doc.data, BufferJSON.reviver);
        return null;
    };
    const removeData = async (id) => { await Auth.deleteOne({ _id: id }); };
    const creds = await readData('creds') || initAuthCreds();
    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async id => {
                        let value = await readData(`${type}-${id}`);
                        if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            tasks.push(value ? writeData(value, key) : removeData(key));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => writeData(creds, 'creds')
    };
}

// 🧠 ATOMIC SELF-TRAINING ENGINE
async function runSelfTrainingUpdateLoop(userDoc) {
    try {
        const lastConversations = userDoc.chatHistory.slice(-6).map(c => `${c.role.toUpperCase()}: ${c.text}`).join('\n');
        
        const selfTrainingPrompt = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            response_format: { type: "json_object" },
            messages: [{
                role: "system",
                content: `Identify user habits/corrections. Return JSON: { "newFacts": ["fact"] }.`
            }, {
                role: "user",
                content: `Recent Chat Activity:\n${lastConversations}`
            }]
        });

        const result = JSON.parse(selfTrainingPrompt.choices[0].message.content);
        if (result.newFacts?.length > 0) {
            await User.updateOne({ _id: userDoc._id }, { $addToSet: { knownFacts: { $each: result.newFacts } } });
        }
    } catch (e) { console.error("Self-training thread paused:", e.message); }
}

async function startAgent() {
    const { state, saveCreds } = await useMongoDBAuthState();
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: ["Ubuntu", "Chrome", "20.0.04"] 
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update) => {
        if (update.connection === 'close') startAgent();
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;

        for (const msg of m.messages) {
            if (!msg.message || msg.key.fromMe) continue;

            const remoteJid = msg.key.remoteJid;
            const isGroup = remoteJid.endsWith('@g.us');
            let userDoc = await User.findOne({ remoteJid });
            
            if (!userDoc) {
                userDoc = await User.create({ remoteJid, isActive: false });
            }

            // Command logic omitted for brevity, add your .agent logic back here
            if (!userDoc.isActive || isGroup) continue;

            try {
                // ... (Perform AI Completion here) ...
                const aiResponse = "Response content..."; // Generated by OpenAI

                // ✅ ATOMIC UPDATE: No Version Conflicts
                await User.findOneAndUpdate(
                    { remoteJid },
                    { $push: { chatHistory: { $each: [{ role: 'user', text: "msg" }, { role: 'me', text: aiResponse }] } } }
                );

                await sock.sendMessage(remoteJid, { text: aiResponse });

                // Non-blocking training trigger
                process.nextTick(() => runSelfTrainingUpdateLoop(userDoc));
            } catch (err) { console.error(err); }
        }
    });
}

startAgent();
