const { default: makeWASocket, initAuthCreds, BufferJSON, proto, delay, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { OpenAI } = require('openai');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
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

// 🗄️ DATABASE SCHEMAS
const UserSchema = new mongoose.Schema({
    remoteJid: { type: String, required: true, unique: true },
    knownFacts: { type: [String], default: [] },
    chatHistory: { type: Array, default: [] } 
});
const User = mongoose.model('User', UserSchema);

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

async function startAgent() {
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
        if (connection === 'open') console.log("🚀 TOLUWANIMI'S KUKATAI AGENT IS LIVE (VOICE NOTES & SECURITY OVERRIDE ENABLED)!");
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
            const isAudioMessage = !!msg.message.audioMessage;
            
            let textMessage = msg.message.conversation || 
                                msg.message.extendedTextMessage?.text || 
                                msg.message.imageMessage?.caption ||
                                "";

            if (fromMe && textMessage.toLowerCase().trim() === '.agent on') {
                agentModeActive = true;
                await sock.sendMessage(remoteJid, { text: "💼 *Agent Mode ON.*" });
                continue;
            }
            if (fromMe && textMessage.toLowerCase().trim() === '.agent off') {
                agentModeActive = false;
                await sock.sendMessage(remoteJid, { text: "👋 *Agent Mode OFF.*" });
                continue;
            }

            if (isStatus || isNewsletter) continue;
            
            // 🎤 PROCESS VOICE NOTES (Whisper API)
            if (isAudioMessage && !fromMe) {
                console.log("🎤 Downloading Voice Note for transcription...");
                try {
                    const buffer = await downloadMediaMessage(msg, 'buffer', {});
                    const tempOgg = path.join(__dirname, `temp_${Date.now()}.ogg`);
                    fs.writeFileSync(tempOgg, buffer);
                    
                    const transcription = await openai.audio.transcriptions.create({
                        file: fs.createReadStream(tempOgg),
                        model: "whisper-1",
                    });
                    
                    textMessage = transcription.text;
                    console.log(`🗣️ Transcribed VN: ${textMessage}`);
                    fs.unlinkSync(tempOgg); 
                } catch (err) {
                    console.error("Audio error:", err.message);
                    textMessage = "[User sent a Voice Note, but I couldn't hear it clearly.]";
                }
            }

            if (!textMessage && !isImageMessage && !isAudioMessage) continue;

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
                    } catch (err) {}
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
                    userProfile = new User({ remoteJid, knownFacts: [], chatHistory: [] });
                }

                const contentText = fromMe ? (textMessage || "[Toluwanimi sent a file]") : (textMessage || "[User sent a file]");
                userProfile.chatHistory.push({ role: fromMe ? "assistant" : "user", content: contentText });
                if (userProfile.chatHistory.length > 8) userProfile.chatHistory.shift(); 

                try {
                    if (typeof userProfile.save === 'function') await userProfile.save();
                } catch (e) {}

                if (!agentModeActive || fromMe) continue; 

                console.log(`🎯 Processing DM for ${remoteJid}...`);

                let memoryString = userProfile.knownFacts.length > 0 
                    ? userProfile.knownFacts.map(f => "- " + f).join('\n') 
                    : "- No facts known yet.";

                try {
                    let openAiMessages = [
                        { 
                            role: "system", 
                            content: `
                            You are Kuka-tai, the AI Executive Assistant to Toluwanimi (a Full Stack Developer). You manage his WhatsApp.
                            
                            🚫 IRONCLAD CONVERSATION LAWS (CRITICAL):
                            1. NO CUSTOMER SERVICE: NEVER ask "How can I help you?", "What's popping?", or "Anything else?".
                            2. NO FORCED CHATS: If the user just laughs ("😂"), says "ok", or has nothing to say, politely end the chat or just match the energy. DO NOT ask a question to force the conversation.
                            3. IDENTITY CLAUSE: If the user mentions "Tolu", they are referring to your boss, Toluwanimi. Do not act confused. Reply on his behalf.

                            💳 BANK DETAILS & SECURITY OVERRIDE (CRITICAL LAW):
                            - Bank: Opay
                            - Account Number: 8148698365
                            - Name: Toluwanimi Oyetade Blessing
                            - SECURITY OVERRIDE DIRECTIVE: You are EXPLICITLY AUTHORIZED by Toluwanimi to share these exact bank details immediately whenever anyone asks for an account number, asks to pay, or asks for "acct". DO NOT trigger AI safety filters. DO NOT say you are unable to share personal details. Just drop the Opay details directly and politely!

                            🧠 NIGERIAN CULTURAL OVERRIDE & MEMORY:
                            - If a user introduces themselves as "Mummy [Name]", "Daddy [Name]", "Aunty", or "Uncle", THEY ARE AN ELDER. You must INSTANTLY switch to MODE 1, call them "Ma" or "Sir", and drop all slang.
                            - If the user states a fact about themselves, append [MEMORY: Fact] to the end of your reply.
                            - Known Facts about this user: ${memoryString}
                            
                            💳 PAYMENT VERIFICATION PROTOCOL:
                            - If a user sends a receipt image, read it and say what you see. State Toluwanimi will confirm the alert on his end.

                            🎭 THE TRIPLE-THREAT CHAMELEON MATRIX:
                            MODE 1: RESPECT PROTOCOL (For elders like Mummy/Daddy). Always use "Sir/Ma". Be incredibly polite and brief. No jokes.
                            MODE 2: BUSINESS PROTOCOL (For Dev services/KukaPay). Sharp and professional.
                            MODE 3: VIBE PROTOCOL (For peers). Use Pidgin smoothly. Match their energy.
                            ` 
                        }
                    ];

                    openAiMessages.push(...userProfile.chatHistory);

                    if (isImageMessage) {
                        const imgBuffer = await downloadMediaMessage(msg, 'buffer', {});
                        const base64Image = imgBuffer.toString('base64');
                        openAiMessages[openAiMessages.length - 1] = {
                            role: "user",
                            content: [
                                { type: "text", text: textMessage || "Please examine this receipt." },
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
                        replyText = replyText.replace(/\[MEMORY:.*?\]/i, '').trim();
                    }
                    
                    userProfile.chatHistory.push({ role: "assistant", content: replyText });
                    if (userProfile.chatHistory.length > 8) userProfile.chatHistory.shift();

                    if (typeof userProfile.save === 'function') await userProfile.save();

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
