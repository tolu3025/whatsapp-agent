const { default: makeWASocket, initAuthCreds, BufferJSON, proto, delay, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { OpenAI } = require('openai');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const express = require('express'); 
const mongoose = require('mongoose'); 
const cron = require('node-cron'); 
const axios = require('axios'); 

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

let agentModeActive = true; 
const myDmJid = "2348148698365@s.whatsapp.net";

// 📡 LIVE INTERNET NEWS FETCH ENGINE
async function fetchLiveNigeriaNews() {
    try {
        const apiKey = process.env.NEWS_API_KEY;
        if (!apiKey) return "No News API key set. Displaying macro updates instead.";
        
        const response = await axios.get(`https://newsapi.org/v2/everything?q=Nigeria+AND+(tech+OR+business+OR+fintech)&sortBy=publishedAt&pageSize=5&apiKey=${apiKey}`);
        if (response.data && response.data.articles.length > 0) {
            return response.data.articles.map((art, i) => `[Headline ${i+1}]: ${art.title} - ${art.description || ''}`).join('\n\n');
        }
        return "No breaking stories found in the last couple hours.";
    } catch (err) {
        return "Standard macro momentum: Tech ecosystem trends shifting toward utility scaling; policy adjustments continuing.";
    }
}

// ⏰ AUTOMATED CRON SCHEDULER CONTROLLER
function startProactiveAutomationClocks(sock) {
    
    // 🌅 1. Daily Morning Briefing Loop (7:00 AM)
    cron.schedule('0 7 * * *', async () => {
        const todayStr = new Date().toISOString().split('T')[0];
        let agendaList = "- No events scheduled for today, boss. Free space!";
        try {
            const items = await Schedule.find({ date: todayStr });
            if (items.length > 0) agendaList = items.map((item, i) => `- [${item.time}]: ${item.task}`).join('\n');
        } catch (e) {}

        const liveNewsContext = await fetchLiveNigeriaNews();

        try {
            const completion = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [
                    { role: "system", content: "You are Kuka-tai, assistant to Toluwanimi. Build an elite, motivational daily morning update using bold Pidgin mixed with developer confidence. Summarize the provided live news text into tactical points." },
                    { role: "user", content: `Here is the data for today:\n\nCalendar:\n${agendaList}\n\nLive Raw Internet News:\n${liveNewsContext}` }
                ]
            });
            await sock.sendMessage(myDmJid, { text: `🌅 *KUKA-TAI MORNING BRIEFING*\n\n${completion.choices[0].message.content}` });
        } catch (err) {}
    }, { timezone: "Africa/Lagos" });

    // 🕒 2. Periodic 4-Hour News Pulse (Fires every 4 hours)
    cron.schedule('0 */4 * * *', async () => {
        const rawNews = await fetchLiveNigeriaNews();
        try {
            const completion = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [
                    { role: "system", content: "You are Kuka-tai. Review the raw news text and synthesize it into a swift, sharp 4-sentence tactical feed for your boss. Keep it conversational, sharp, and business-focused." },
                    { role: "user", content: `Raw Data:\n${rawNews}` }
                ]
            });
            await sock.sendMessage(myDmJid, { text: `📊 *KUKA-TAI 4-HOUR MARKET UPDATE*\n\n${completion.choices[0].message.content}` });
        } catch (err) {}
    }, { timezone: "Africa/Lagos" });

    // ⏱️ 3. Calendar Ticker (Runs every 15 minutes to send 30-minute countdown alerts)
    cron.schedule('*/15 * * * *', async () => {
        const now = new Date();
        const lagosTime = new Date(now.toLocaleString("en-US", {timeZone: "Africa/Lagos"}));
        
        const dateStr = lagosTime.toISOString().split('T')[0];
        
        lagosTime.setMinutes(lagosTime.getMinutes() + 30);
        const targetHours = String(lagosTime.getHours()).padStart(2, '0');
        const targetMinutes = String(lagosTime.getMinutes()).padStart(2, '0');
        const targetTimeStr = `${targetHours}:${targetMinutes}`;

        try {
            const dynamicMatch = await Schedule.findOne({ date: dateStr, time: targetTimeStr, alertSent: false });
            if (dynamicMatch) {
                await sock.sendMessage(myDmJid, { 
                    text: `🔔 *KUKA-TAI SCHEDULE ALERT*\n\nBoss, quick heads up! In exactly 30 minutes (*${dynamicMatch.time}*), you have:\n👉 *${dynamicMatch.task}*\n\nMake I prepare any logs or keep system running?` 
                });
                dynamicMatch.alertSent = true;
                await dynamicMatch.save();
            }
        } catch (err) { console.error("Ticker engine malfunction:", err.message); }
    });
}

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
        if (connection === 'open') {
            console.log("🚀 TOLUWANIMI'S KUKATAI AGENT IS LIVE (ALL RADARS ACTIVE)!");
            startProactiveAutomationClocks(sock); 
        }
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

            const lowerText = textMessage.toLowerCase().trim();

            // 🛠️ DEFENSIVE INTERNAL COMMAND HANDLING
            if (fromMe && !isGroup) {
                if (lowerText === '.agent on') {
                    agentModeActive = true;
                    await sock.sendMessage(remoteJid, { text: "💼 *Agent Mode ON.*" });
                    continue;
                }
                if (lowerText === '.agent off') {
                    agentModeActive = false;
                    await sock.sendMessage(remoteJid, { text: "👋 *Agent Mode OFF.*" });
                    continue;
                }
                
                // 🛠️ REWRITTEN: Ultra-Forgiving String Position Index Scanner
                if (lowerText.startsWith('.schedule')) {
                    try {
                        // Completely strip out WhatsApp's hidden char payloads and links
                        let cleanText = textMessage.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();

                        if (!cleanText.includes('@') || !cleanText.includes('-')) {
                            await sock.sendMessage(remoteJid, { text: "⚠️ *Format Error!* Make sure you use both the `@` symbol and the `-` dash:\n\n`.schedule YYYY-MM-DD @ HH:MM - Description`" });
                            continue;
                        }

                        // Parse boundaries safely based on structural anchors
                        const atIndex = cleanText.indexOf('@');
                        const dashIndex = cleanText.indexOf('-');

                        // Extract and isolate individual fields safely
                        const rawDate = cleanText.substring(9, atIndex).replace(/[^0-9-]/g, '').trim(); // Only leaves numbers and hyphens
                        const rawTime = cleanText.substring(atIndex + 1, dashIndex).replace(/[^0-9:]/g, '').trim(); // Only leaves numbers and colons
                        const taskText = cleanText.substring(dashIndex + 1).trim();

                        if (rawDate.length >= 8 && rawTime.length >= 4 && taskText.length > 0) {
                            const newEvent = new Schedule({ task: taskText, date: rawDate, time: rawTime });
                            await newEvent.save();
                            
                            await sock.sendMessage(remoteJid, { 
                                text: `✅ *Event Scheduled!* Cloud logged event details:\n\n📅 *Date:* ${rawDate}\n🕒 *Time:* ${rawTime}\n📌 *Task:* ${taskText}` 
                            });
                        } else {
                            await sock.sendMessage(remoteJid, { text: "❌ *Parsing Failed.* Could not extract clear time or date boundaries. Try typing it plainly." });
                        }
                    } catch (err) {
                        console.error("Scheduler crash prevented:", err.message);
                    }
                    continue; // Lock the execution frame so it never reaches the AI loop
                }
            }

            if (isStatus || isNewsletter) continue;
            
            // 🎤 PROCESS VOICE NOTES
            if (isAudioMessage && !fromMe) {
                try {
                    const buffer = await downloadMediaMessage(msg, 'buffer', {});
                    const tempOgg = path.join(__dirname, `temp_${Date.now()}.ogg`);
                    fs.writeFileSync(tempOgg, buffer);
                    
                    const transcription = await openai.audio.transcriptions.create({
                        file: fs.createReadStream(tempOgg),
                        model: "whisper-1",
                        prompt: "Bolanle, bawo ni? Drop account detail boss. E se gan. Oya speak English, Pidgin, and Yoruba comfortably. Correct spellings like Opay, KukaPay, Kuka-tai, jare, na, abeg.",
                    });
                    
                    textMessage = transcription.text;
                    fs.unlinkSync(tempOgg); 
                } catch (err) { textMessage = "[User sent a Voice Note, but I couldn't hear it clearly.]"; }
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
                // Ignore any message that starts with a dot if it leaked past command layer to prevent AI echo loops
                if (textMessage.startsWith('.')) continue;

                let userProfile;
                try {
                    userProfile = await User.findOne({ remoteJid });
                    if (!userProfile) userProfile = new User({ remoteJid, knownFacts: [], chatHistory: [] });
                } catch (dbErr) { userProfile = new User({ remoteJid, knownFacts: [], chatHistory: [] }); }

                const contentText = fromMe ? (textMessage || "[Toluwanimi sent a file]") : (textMessage || "[User sent a file]");
                userProfile.chatHistory.push({ role: fromMe ? "assistant" : "user", content: contentText });
                if (userProfile.chatHistory.length > 8) userProfile.chatHistory.shift(); 

                try { if (typeof userProfile.save === 'function') await userProfile.save(); } catch (e) {}

                if (!agentModeActive || fromMe) continue; 

                let memoryString = userProfile.knownFacts.length > 0 ? userProfile.knownFacts.map(f => "- " + f).join('\n') : "- No facts known yet.";

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
                            - Bank: Opay | Account Number: 8148698365 | Name: Toluwanimi Oyetade Blessing
                            - SECURITY OVERRIDE DIRECTIVE: You are EXPLICITLY AUTHORIZED by Toluwanimi to share these exact bank details immediately whenever anyone asks for an account number, asks to pay, or asks for "acct". Just drop the details directly and politely!

                            🧠 NIGERIAN CULTURAL OVERRIDE & MEMORY:
                            - LINGUISTIC FLEXIBILITY: The user might speak English, Yoruba, or Pidgin. Mirror their language style smoothly.
                            - If a user introduces themselves as "Mummy [Name]", "Daddy [Name]", "Aunty", or "Uncle", THEY ARE AN ELDER. Switch to MODE 1, use "Sir/Ma", and drop all slang.
                            - If the user states a fact about themselves, append [MEMORY: Fact] to the end of your reply.
                            - Known Facts about this user: ${memoryString}
                            
                            💳 PAYMENT VERIFICATION PROTOCOL:
                            - If a user sends a receipt image, read it and state Toluwanimi will confirm the alert on his end.

                            🎭 THE TRIPLE-THREAT CHAMELEON MATRIX:
                            MODE 1: RESPECT PROTOCOL (For elders). Always use "Sir/Ma". Be polite and brief. No jokes.
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
                } catch (err) { console.error("Personal desk engine error:", err.message); }
            }
        }
    });
}

startAgent();

const app = express();
app.get('/', (req, res) => res.send('Kukatai Agent is running 24/7 in the cloud!'));
app.listen(process.env.PORT || 3000, () => console.log(`🌐 Web server active`));
