const { default: makeWASocket, initAuthCreds, BufferJSON, proto, delay, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { OpenAI } = require('openai');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const express = require('express'); 
const mongoose = require('mongoose'); 

const openai = new OpenAI({ 
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 60000,   
    maxRetries: 3     
});

// 📦 CONNECT TO MONGO CLOUD DATABASE
const mongoURI = process.env.MONGODB_URI;
if (!mongoURI) {
    console.error("❌ CRITICAL ERROR: MONGODB_URI environment variable is missing!");
} else {
    mongoose.connect(mongoURI)
        .then(() => console.log("📦 PERMANENT DATABASE: Connected to MongoDB Atlas Cloud!"))
        .catch(err => console.error("❌ MongoDB Connection Error:", err.message));
}

// 🗄️ UPGRADED DATABASE SCHEMAS
// 1. User Memory Schema
const UserSchema = new mongoose.Schema({
    remoteJid: { type: String, required: true, unique: true },
    knownFacts: { type: [String], default: [] },
    chatHistory: { type: Array, default: [] } 
});
const User = mongoose.model('User', UserSchema);

// 2. NEW: Authentication State Schema (Prevents Render Amnesia)
const AuthSchema = new mongoose.Schema({
    _id: { type: String, required: true },
    data: { type: String, required: true }
});
const Auth = mongoose.model('Auth', AuthSchema);

// 🔐 CUSTOM MONGODB AUTH ADAPTER
async function useMongoDBAuthState() {
    const writeData = async (data, id) => {
        const stringified = JSON.stringify(data, BufferJSON.replacer);
        await Auth.updateOne({ _id: id }, { $set: { data: stringified } }, { upsert: true });
    };
    
    const readData = async (id) => {
        const doc = await Auth.findOne({ _id: id });
        if (doc && doc.data) {
            return JSON.parse(doc.data, BufferJSON.reviver);
        }
        return null;
    };
    
    const removeData = async (id) => {
        await Auth.deleteOne({ _id: id });
    };

    const creds = await readData('creds') || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async id => {
                        let value = await readData(`${type}-${id}`);
                        if (type === 'app-state-sync-key' && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
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

let agentModeActive = true; 

function convertAudio(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        exec(`ffmpeg -i "${inputPath}" -acodec libmp3lame -y "${outputPath}"`, (error) => {
            if (error) return reject(error);
            resolve(outputPath);
        });
    });
}

async function startAgent() {
    // 🚀 SWITCHED FROM LOCAL FOLDER TO MONGODB AUTH
    const { state, saveCreds } = await useMongoDBAuthState();
    
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ["Ubuntu", "Chrome", "20.0.04"] 
    });

    sock.ev.on('creds.update', saveCreds);

    if (!sock.authState.creds.registered) {
        await delay(3000); 
        const phoneNumber = "2348148698365"; 
        try {
            const code = await sock.requestPairingCode(phoneNumber);
            console.log(`\n🔑 WHATSAPP PAIRING CODE: ${code}\n`);
        } catch (err) {}
    }

    sock.ev.on('connection.update', (update) => {
        const { connection } = update;
        if (connection === 'open') console.log("🚀 TOLUWANIMI'S KUKATAI AGENT IS LIVE (CLOUD AUTH & SILENT OBSERVER ACTIVE)!");
        if (connection === 'close') startAgent();
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify' && m.type !== 'append') return;

        for (const msg of m.messages) {
            if (!msg.message) continue;

            const remoteJid = msg.key.remoteJid;
            const isGroup = remoteJid.endsWith('@g.us');
            const isStatus = remoteJid === 'status@broadcast';
            const isNewsletter = remoteJid.endsWith('@newsletter');
            const fromMe = msg.key.fromMe;
            
            const isImageMessage = !!msg.message.imageMessage;
            
            let textMessage = msg.message.conversation || 
                                msg.message.extendedTextMessage?.text || 
                                msg.message.imageMessage?.caption ||
                                "";

            if (fromMe && textMessage.toLowerCase().trim() === '.agent on') {
                agentModeActive = true;
                await sock.sendMessage(remoteJid, { text: "💼 *Agent Mode ON.* I am taking over the conversation based on your recent context." });
                continue;
            }
            if (fromMe && textMessage.toLowerCase().trim() === '.agent off') {
                agentModeActive = false;
                await sock.sendMessage(remoteJid, { text: "👋 *Agent Mode OFF.* I am now silently observing and taking notes." });
                continue;
            }

            if (isStatus || isNewsletter) continue;
            if (!textMessage && !isImageMessage) continue;

            // 📡 1. THE GROUP CHAT RADAR
            if (isGroup && agentModeActive && !fromMe) {
                const lowerMsg = textMessage.toLowerCase();
                const botNumber = sock.user.id.split(':')[0] + '@s.whatsapp.net';
                const mentionedJids = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
                const isTagged = mentionedJids.includes(botNumber);
                
                const isTriggered = isTagged || lowerMsg.includes('toluwanimi') || lowerMsg.includes('admin') || lowerMsg.includes('softdev') || lowerMsg.includes('agent');

                if (isTriggered) {
                    try {
                        const completion = await openai.chat.completions.create({
                            model: "gpt-4o-mini",
                            messages: [
                                { role: "system", content: `You are Toluwanimi's Assistant. Keep group replies brief. Direct Softdev business to DM.` },
                                { role: "user", content: textMessage }
                            ],
                        });
                        await sock.sendMessage(remoteJid, { text: completion.choices[0].message.content }, { quoted: msg });
                    } catch (err) { console.error("Group error:", err.message); }
                }
                continue; 
            }

            // 📩 2. PERSONAL DM ASSISTANT & SILENT OBSERVER
            if (!isGroup) {
                
                let userProfile;
                try {
                    userProfile = await User.findOne({ remoteJid });
                    if (!userProfile) {
                        userProfile = new User({ remoteJid, knownFacts: [], chatHistory: [] });
                    }
                } catch (dbErr) {
                    console.error("Database fetch failure:", dbErr.message);
                    userProfile = new User({ remoteJid, knownFacts: [], chatHistory: [] });
                }

                const contentText = fromMe ? (textMessage || "[Toluwanimi sent an attachment]") : (textMessage || "[User sent an image]");
                userProfile.chatHistory.push({ role: fromMe ? "assistant" : "user", content: contentText });
                if (userProfile.chatHistory.length > 8) userProfile.chatHistory.shift(); 

                try {
                    if (typeof userProfile.save === 'function') await userProfile.save();
                } catch (e) {}

                if (!agentModeActive || fromMe) {
                    continue; 
                }

                console.log(`🎯 Processing DM for ${remoteJid}...`);

                let memoryString = userProfile.knownFacts.length > 0 
                    ? userProfile.knownFacts.map(f => "- " + f).join('\n') 
                    : "- No facts known yet.";

                try {
                    let openAiMessages = [
                        { 
                            role: "system", 
                            content: `
                            You are the highly advanced AI Executive Assistant to Toluwanimi. 
                            
                            🚫 GLOBAL PROHIBITIONS (CRITICAL RULE):
                            - NEVER act like a customer service agent.
                            - NEVER end your messages with phrases like "How can I help you?", "What can I do for you?", or "Do you have any questions?". 
                            - Always converse naturally as a human assistant.
                            
                            🧠 YOUR KNOWLEDGE BASE:
                            - Boss: Toluwanimi (A jovial, caring guy and a highly skilled Full Stack Developer).
                            - Company: KukaPay (Fintech app, crypto-to-cash, vendor payments).
                            - Bank Details: Opay - 8148698365 - Toluwanimi Oyetade Blessing.
                            
                            🗄️ ABOUT THIS USER:
                            ${memoryString}

                            🕵️ HOW TO MEMORIZE:
                            If the user states a fact about themselves, append this to the END of your reply: [MEMORY: Fact goes here].
                            
                            🕵️ GENDER RECONNAISSANCE PROTOCOL:
                            - If the user's gender is unknown, use neutral terms ("my person", "boss"). Wait for them to use a gendered term to save it.

                            💳 PAYMENT VERIFICATION PROTOCOL:
                            - Ask for receipt images. If sent, read them aloud but state Toluwanimi will confirm the alert on his end.

                            🎭 THE TRIPLE-THREAT CHAMELEON MATRIX:
                            MODE 1: RESPECT PROTOCOL (For elders/formal users). Always use "Sir/Ma".
                            MODE 2: BUSINESS PROTOCOL (For KukaPay/Dev services). Sharp and helpful.
                            MODE 3: VIBE PROTOCOL (For peers/friends). Match their energy, use Pidgin smoothly. 
                            ` 
                        }
                    ];

                    openAiMessages.push(...userProfile.chatHistory);

                    if (isImageMessage) {
                        console.log("📸 Downloading image for AI analysis...");
                        const imgBuffer = await downloadMediaMessage(msg, 'buffer', {});
                        const base64Image = imgBuffer.toString('base64');
                        
                        openAiMessages[openAiMessages.length - 1] = {
                            role: "user",
                            content: [
                                { type: "text", text: textMessage || "Please examine this image/receipt." },
                                { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
                            ]
                        };
                    }

                    const completion = await openai.chat.completions.create({
                        model: "gpt-4o-mini",
                        messages: openAiMessages,
                    });

                    let replyText = completion.choices[0].message.content;

                    const memoryMatch = replyText.match(/\[MEMORY:(.*?)\]/i);
                    if (memoryMatch) {
                        const newFact = memoryMatch[1].trim();
                        userProfile.knownFacts.push(newFact);
                        console.log(`\n💾 PERMANENT MEMORY CLOUD SAVED: ${newFact}\n`);
                        replyText = replyText.replace(/\[MEMORY:.*?\]/i, '').trim();
                    }
                    
                    userProfile.chatHistory.push({ role: "assistant", content: replyText });
                    if (userProfile.chatHistory.length > 8) userProfile.chatHistory.shift();

                    if (typeof userProfile.save === 'function') {
                        await userProfile.save();
                    }

                    await sock.sendMessage(remoteJid, { text: replyText });
                } catch (err) {
                    console.error("Personal desk engine error:", err.message);
                }
            }
        }
    });
}

startAgent();

const app = express();
app.get('/', (req, res) => res.send('Kukatai Agent is running 24/7 in the cloud!'));
app.listen(process.env.PORT || 3000, () => console.log(`🌐 Web server active`));
