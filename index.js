const { default: makeWASocket, initAuthCreds, BufferJSON, proto, delay, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { OpenAI } = require('openai');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const express = require('express'); 
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

// 💱 LIVE FCSAPI FOREX ENGINE
async function fetchFcsapiForexMatrix() {
    try {
        const fxKey = process.env.FOREX_API_KEY;
        if (!fxKey) return "Error: FOREX_API_KEY environment variable is unconfigured.";
        
        const response = await axios.get(`https://fcsapi.com/api-v3/forex/latest?id=1,2,3&access_key=${fxKey}`);
        
        if (response.data && response.data.status && response.data.response) {
            return response.data.response.map(q => 
                `📌 Pair: ${q.s}\n• Price: ${q.c}\n• 24h High: ${q.h} | 24h Low: ${q.l}\n• Last Change: ${q.ch || '0.00'}`
            ).join('\n\n');
        }
        return "FCSAPI reporting flat execution channels currently.";
    } catch (err) {
        console.error("FCSAPI Matrix Fetch Failed:", err.message);
        return "Fallback Framework: Live liquidity fields matching standard WAT baseline structures.";
    }
}

// 🧠 BACKEND SELF-TRAINING RECURSIVE SYNTAX ENGINE
async function runSelfTrainingUpdateLoop(userDoc) {
    try {
        const lastConversations = userDoc.chatHistory.slice(-6).map(c => `${c.role.toUpperCase()}: ${c.text}`).join('\n');
        const activeFacts = userDoc.knownFacts.join(', ') || "None";

        const selfTrainingPrompt = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            response_format: { type: "json_object" },
            messages: [{
                role: "system",
                content: `You are an automated backend user behavioral extraction engine tracking real-time user traits.
                Review the last message exchanges and identify preferences, corrections, habits, names, or formatting rules.
                
                Look for:
                - If the user corrected the AI's language style, behavior, or native pidgin tone.
                - Important custom billing requests or recurring operational requests.

                Current facts stored: [${activeFacts}]

                Return a structured JSON object with an array under the key "newFacts":
                Example: { "newFacts": ["User prefers very short responses", "User loves simple business overviews"] }
                If nothing important changed, return an empty array.`
            }, {
                role: "user",
                content: `Recent Chat Activity Logs:\n${lastConversations}`
            }]
        });

        const result = JSON.parse(selfTrainingPrompt.choices[0].message.content);
        if (result.newFacts && result.newFacts.length > 0) {
            result.newFacts.forEach(fact => {
                if (!userDoc.knownFacts.includes(fact)) {
                    userDoc.knownFacts.push(fact);
                }
            });
            if (userDoc.knownFacts.length > 15) userDoc.knownFacts.shift();
            await userDoc.save();
            console.log(`💡 AGENT SELF-TRAINED MEMORY EXPANDED FOR USER:`, result.newFacts);
        }
    } catch (e) {
        console.error("⚠️ Background self-training execution tick failed:", e.message);
    }
}

// ⏰ AUTOMATED CRON SCHEDULER CONTROLLER
function startProactiveAutomationClocks(sock) {

    // 🌅 1. Daily Morning Financial Briefing Loop (7:00 AM WAT)
    cron.schedule('0 7 * * *', async () => {
        const todayStr = new Date().toISOString().split('T')[0];
        let agendaList = "No events scheduled for today, boss. Free space!";
        try {
            const items = await Schedule.find({ date: todayStr });
            if (items.length > 0) agendaList = items.map((item, i) => `- [${item.time}]: ${item.task}`).join('\n');
        } catch (e) {}

        const liveForexMatrixContext = await fetchFcsapiForexMatrix();

        try {
            const completion = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [
                    { 
                        role: "system", 
                        content: `You are Kuka-tai, executive assistant to Toluwanimi. 
                        Build an elite, motivational daily morning briefing using bold authentic Nigerian Pidgin mixed with developer confidence.
                        
                        🚨 FORMATTING MANDATE:
                        DO NOT USE ANY ASTERISKS OR STARS (e.g., do NOT use **, ***, or *). 
                        Format your response completely in clean, plain text using line breaks, capital letters, emojis, and dashes to divide your sections nicely.
                        
                        Synthesize the provided live market data feed into crisp, general market trends, followed immediately by listing his scheduled agenda items for the day layout.` 
                    },
                    { role: "user", content: `Date context: 2026-07-15\n\nCalendar Items:\n${agendaList}\n\nLive Raw Market Feed:\n${liveForexMatrixContext}` }
                ]
            });
            await sock.sendMessage(myDmJid, { text: `🌅 KUKA-TAI DAILY MORNING BRIEFING\n\n${completion.choices[0].message.content}` });
        } catch (err) { console.error("Morning brief error:", err.message); }
    }, { timezone: "Africa/Lagos" });

    // 📊 2. Automated 4-Hour Proactive Market Intelligence Loop (Fires every 4 hours)
    cron.schedule('0 */4 * * *', async () => {
        console.log("⏰ Running 4-hour automated live forex structural pulse ticker...");
        const fxDataMatrix = await fetchFcsapiForexMatrix();

        try {
            const completion = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [
                    { 
                        role: "system", 
                        content: `You are Kuka-tai, Toluwanimi's Lead Quantitative Risk Engine. 
                        Every 4 hours, you intercept real-time price metrics to map institutional volatility.
                        
                        🚨 RISK STRATEGY OVERRIDE:
                        - If the currency change (ch) is positive and price is closer to the High, construct a BUY/LONG breakout trade.
                        - If the currency change (ch) is negative or price is closer to the Low, construct a SELL/SHORT breakdown trade. DO NOT force buy recommendations on bearish market structures.
                        
                        You must output clear setup indicators using professional developer confidence mixed with smooth trading natural Pidgin:
                        1. Directional Bias Strategy (Buy Stop / Sell Stop / Market Execution)
                        2. Calculated Entry Zone
                        3. Strict Take Profit Levels (TP1 and TP2 targets)
                        4. Risk Mitigation Stop Loss (SL level positioned directly outside standard session volatility boundaries)
                        
                        ⚠️ CRITICAL FORMATTING RULE: 
                        YOU ARE STRICTLY FORBIDDEN FROM USING ASTERISKS (*) OR MARKOVER SHARP SIGNS (#). 
                        Do NOT use double asterisks (** text **) for bolding. For section headers, use UPPERCASE text. 
                        Format using clear line breaks, simple dashes (-), and emojis. Avoid all news.` 
                    },
                    { role: "user", content: `Live FCSAPI Forex Feed:\n\n${fxDataMatrix}` }
                ]
            });
            await sock.sendMessage(myDmJid, { text: `📊 KUKA-TAI 4-HOUR AUTOMATED MARKET BRIEF\n\n${completion.choices[0].message.content}` });
        } catch (err) { console.error("4-hour automated FX pulse failed:", err.message); }
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
                    text: `🔔 KUKA-TAI SCHEDULE ALERT\n\nBoss, quick heads up! In exactly 30 minutes (${dynamicMatch.time}), you have:\n👉 ${dynamicMatch.task}\n\nMake I prepare any logs or keep system running?` 
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
            console.log("🚀 TOLUWANIMI'S KUKATAI AGENT IS LIVE (MEDIA & VISUAL CHECKS RE-ENGINEERED)!");
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
            const isStickerMessage = !!msg.message.stickerMessage;
            const isAudioMessage = !!msg.message.audioMessage || !!msg.message.pttMessage;
            
            let textMessage = msg.message.conversation || 
                                msg.message.extendedTextMessage?.text || 
                                msg.message.imageMessage?.caption ||
                                "";

            let lowerText = textMessage.toLowerCase().trim();

            // 🎙️ VOICE NOTE AUDIO PROCESSING ENGINE (WHISPER)
            if (isAudioMessage && (!isGroup || fromMe)) {
                try {
                    console.log("🎙️ Audio message captured. Processing Transcription...");
                    const audioBuffer = await downloadMediaMessage(msg, 'buffer', {}, {
                        logger: pino({ level: 'silent' }),
                        rekeyThresholdBytes: 1800000 
                    });
                    
                    const tempAudioFile = path.join(os.tmpdir(), `audio_${Date.now()}.ogg`);
                    fs.writeFileSync(tempAudioFile, audioBuffer);

                    const transcription = await openai.audio.transcriptions.create({
                        file: fs.createReadStream(tempAudioFile),
                        model: "whisper-1",
                    });

                    try { fs.unlinkSync(tempAudioFile); } catch (e) {}

                    textMessage = transcription.text;
                    lowerText = textMessage.toLowerCase().trim();
                    console.log(`📝 Audio transcribed successfully: "${textMessage}"`);
                } catch (audioErr) {
                    console.error("❌ Whisper Transcription engine runtime failed:", audioErr.message);
                }
            }

            // 🛠️ DEFENSIVE INTERNAL COMMAND HANDLING
            if (fromMe && !isGroup) {
                if (lowerText === '.agent on') {
                    agentModeActive = true;
                    await sock.sendMessage(remoteJid, { text: "💼 Agent Mode ON." });
                    continue;
                }
                if (lowerText === '.agent off') {
                    agentModeActive = false;
                    await sock.sendMessage(remoteJid, { text: "👋 Agent Mode OFF." });
                    continue;
                }

                // 📊 MANUAL MARKET TICKER FOREX SCANNER COMMAND (FCSAPI)
                if (lowerText === '.market') {
                    try {
                        await sock.sendMessage(remoteJid, { text: "⏳ Intercepting liquid exchange matrix and computing session support/resistance channels..." });
                        const fxMatrix = await fetchFcsapiForexMatrix();

                        const completion = await openai.chat.completions.create({
                            model: "gpt-4o-mini",
                            messages: [
                                { 
                                    role: "system", 
                                    content: `You are Kuka-tai, Toluwanimi's Quantum FX Terminal. Take live metrics from FCSAPI and calculate structural ranges. 
                                    
                                    🚨 TWO-SIDED MARKET ANALYSIS MANDATE:
                                    - If change (ch) is positive, write a LONG/BUY setup above high.
                                    - If change (ch) is negative or price is closer to the low, write a SHORT/SELL setup below low. Never force buys on structural downtrends.
                                    
                                    ⚠️ CRITICAL FORMATTING RULE:
                                    DO NOT USE ANY ASTERISKS (*) OR HASHTAGS (#). 
                                    Write sections in clean UPPERCASE text blocks instead. Use spaces and line breaks for layout formatting.` 
                                },
                                { role: "user", content: `Live FCSAPI Feed Data:\n\n${fxMatrix}` }
                            ]
                        });
                        await sock.sendMessage(remoteJid, { text: `💱 ON-DEMAND FOREX SCALPING MATRIX\n\n${completion.choices[0].message.content}` });
                    } catch (err) { console.error("Manual market loop failed:", err.message); }
                    continue;
                }
                
                // 🧠 OpenAI-Powered Schedule Action Parser (CREATE, UPDATE, DELETE, LIST)
                if (lowerText.startsWith('.schedule')) {
                    try {
                        const commandBody = textMessage.replace(/^\.schedule/i, '').trim();

                        const completion = await openai.chat.completions.create({
                            model: "gpt-4o-mini",
                            response_format: { type: "json_object" },
                            messages: [
                                {
                                    role: "system",
                                    content: `You are a scheduling command analyzer. Classify the user's instructions into one of these actions:
                                    1. "list" -> If the user wants to see, display, or list upcoming tasks (e.g. ".schedule list").
                                    2. "delete" -> If they want to remove, cancel, or clear a task (e.g. ".schedule delete Friday task").
                                    3. "update" -> If they want to change, modify, edit, or adjust an existing task's details, date, or time (e.g. ".schedule change Friday task time to 9:00").
                                    4. "create" -> ONLY if they are describing a completely new task to log from scratch (e.g. ".schedule 2026-07-17 @ 09:00 - IFT 212 exam").
                                    
                                    Return a strictly structured JSON object with these keys:
                                    - "action": "create" | "update" | "delete" | "list"
                                    - "date": "YYYY-MM-DD" (Calculated correctly from context; only for create/update)
                                    - "time": "HH:MM" (24-hour format; only for create/update)
                                    - "task": "clean description" (The task details; only for create/update)
                                    - "searchQuery": "fragment" (For delete/update. Extract the target task keyword, e.g. "IFT 212" or "Friday")
                                    - "updateField": "date" | "time" | "task" | "all" (Only for update)
                                    
                                    Current Date context: Wednesday, July 15, 2026.`
                                },
                                { role: "user", content: commandBody }
                            ]
                        });

                        const data = JSON.parse(completion.choices[0].message.content);
                        console.log("Resolved AI Schedule Action Plan:", data);

                        if (data.action === "list") {
                            const upcoming = await Schedule.find({}).sort({ date: 1, time: 1 }).limit(10);
                            if (upcoming.length > 0) {
                                const listStr = upcoming.map((ev, i) => `${i+1}. [${ev.date} @ ${ev.time} WAT] - ${ev.task}`).join('\n');
                                await sock.sendMessage(remoteJid, { text: `📅 CURRENT SCHEDULED TASKS\n\n${listStr}` });
                            } else {
                                await sock.sendMessage(remoteJid, { text: "📅 CURRENT SCHEDULED TASKS\n\nNo scheduled tasks found in database cloud." });
                            }
                        } 
                        else if (data.action === "delete") {
                            const result = await Schedule.deleteOne({ task: { $regex: data.searchQuery, $options: 'i' } });
                            if (result.deletedCount > 0) {
                                await sock.sendMessage(remoteJid, { text: `🗑️ TASK DELETED SUCCESSFULLY\n\nRemoved schedule matching query: "${data.searchQuery}"` });
                            } else {
                                await sock.sendMessage(remoteJid, { text: `❌ TASK NOT FOUND\n\nCould not find any upcoming schedule matching: "${data.searchQuery}"` });
                            }
                        } 
                        else if (data.action === "update") {
                            const queryCondition = data.searchQuery 
                                ? { task: { $regex: data.searchQuery, $options: 'i' } } 
                                : { date: data.date };

                            const event = await Schedule.findOne(queryCondition);
                            if (event) {
                                if (data.date && data.updateField !== "time" && data.updateField !== "task") event.date = data.date;
                                if (data.time) event.time = data.time;
                                if (data.task && data.updateField === "task") event.task = data.task;
                                await event.save();
                                await sock.sendMessage(remoteJid, { text: `📝 TASK UPDATED SUCCESSFULLY\n\n📅 Date: ${event.date}\n🕒 Time: ${event.time}\n📌 Task: ${event.task}` });
                            } else {
                                await sock.sendMessage(remoteJid, { text: `❌ TARGET TASK NOT FOUND\n\nCould not locate an active schedule matching: "${data.searchQuery || data.date}"` });
                            }
                        } 
                        else if (data.action === "create") {
                            const newEvent = new Schedule({
                                task: data.task,
                                date: data.date,
                                time: data.time,
                                alertSent: false
                            });
                            await newEvent.save();
                            await sock.sendMessage(remoteJid, { text: `✅ NEW TASK LOGGED SUCCESSFULLY\n\n📅 Date: ${data.date}\n🕒 Time: ${data.time}\n📌 Task: ${data.task}` });
                        }
                    } catch (err) {
                        console.error("Schedule Parse Engine failed:", err.message);
                        await sock.sendMessage(remoteJid, { text: "❌ System parsing error handling that schedule instruction format." });
                    }
                    continue;
                }
            }

            // 🛑 SKIP IF AGENT IS DISABLED OR OUTSIDE VALID DIRECT MESSAGE SCOPE
            if (!agentModeActive || isGroup || isStatus || isNewsletter) continue;

            try {
                // 🔄 FETCH OR INITIALIZE USER STATE FROM DATABASE
                let userDoc = await User.findOne({ remoteJid });
                if (!userDoc) {
                    userDoc = new User({ remoteJid, knownFacts: [], chatHistory: [] });
                }

                // Limit conversation history boundary array
                const recentHistory = userDoc.chatHistory.slice(-8);

                // 🛠️ MULTIMODAL PAYLOAD FIELD EXTRACTION
                let messageContentPayload = [];

                if (textMessage) {
                    messageContentPayload.push({ type: "text", text: textMessage });
                }

                // 🖼️ VISUAL CHECKING FOR IMAGES
                if (isImageMessage) {
                    try {
                        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { 
                            logger: pino({ level: 'silent' }),
                            rekeyThresholdBytes: 1800000 
                        });
                        const base64Image = buffer.toString('base64');
                        
                        messageContentPayload.push({
                            type: "image_url",
                            image_url: { url: `data:image/jpeg;base64,${base64Image}` }
                        });
                        
                        if (!textMessage) {
                            messageContentPayload.push({ type: "text", text: "[User dropped an image file for immediate layout verification]" });
                        }
                    } catch (mediaErr) {
                        console.error("❌ Failed to download visual message attachment:", mediaErr.message);
                    }
                }

                // 🎭 VISUAL CHECKING FOR STICKERS
                if (isStickerMessage) {
                    try {
                        console.log("🎭 Sticker captured. Downloading asset buffer for visual tracking...");
                        const stickerBuffer = await downloadMediaMessage(msg, 'buffer', {}, {
                            logger: pino({ level: 'silent' }),
                            rekeyThresholdBytes: 1800000 
                        });
                        const base64Sticker = stickerBuffer.toString('base64');

                        messageContentPayload.push({
                            type: "image_url",
                            image_url: { url: `data:image/webp;base64,${base64Sticker}` }
                        });

                        messageContentPayload.push({ type: "text", text: "[User just reacted with this exact sticker image]" });
                    } catch (stickerErr) {
                        console.error("❌ Failed to extract webp sticker packet data buffer:", stickerErr.message);
                    }
                }

                if (messageContentPayload.length === 0) continue;

                // 🧠 MAP PERSISTENT SELF-TRAINED MEMORY TRACKS FOR RUNTIME INJECTION
                const profileMemory = userDoc.knownFacts.length > 0 
                    ? `USER PROFILE PERSISTENT TRAINED MEMORY:\n${userDoc.knownFacts.map(f => `- ${f}`).join('\n')}`
                    : "USER PROFILE PERSISTENT TRAINED MEMORY: Fresh profile segment.";

                // 🛑 SYSTEM INSTRUCTION FRAMEWORK LAYER
                const systemPromptInstruction = {
                    role: "system",
                    content: `You are Kuka-tai, Toluwanimi's smart business assistant engine. 
                    
                    TONE AND LANGUAGE MANDATE:
                    - Talk in natural, standard, everyday Nigerian Pidgin English. 
                    - DO NOT use robotic textbook translations. Do not sound like a machine trying to speak pidgin.
                    - Keep it short, blunt, helpful, and sharp. 
                    - Avoid phrases like "I cannot fulfill this request" or "As an AI". Instead, say something natural like "Baba, I no fit run this kind thing abeg" or "No structure things on top guess work."

                    ${profileMemory}

                    CRITICAL CONTEXT VISUAL RULES:
                    1. ALWAYS analyze incoming media payload data (Images and Stickers) carefully before replying. Do not guess what is inside blindly.
                    2. If the user drops an image or a sticker that shows a Google Review or star rating, read the text/stars inside. Reply enthusiastically based on that review context (e.g., "Omo, check out this clean 5-star review! The work pure cleanly!"). Never assume it's a payment screenshot.
                    3. If the user drops a sticker or an image showing a payment slip/bank alert transfer proof, check the transfer details. State that you spot the alert verification image and tell them: "Abeg wait make Tolu check backend confirm the alert." Never confirm a credit receipt unless the image explicitly shows valid bank transaction details.
                    4. Treat every incoming message boundary as isolated fresh context. Never carry over previous errors or refused login issues from past text logs over to a completely new review image.
                    5. If a user drops log-in profile profiles, pins, or banking passwords inside a chat, image, or sticker, state: "Abeg hold on, I no dey keep account credentials or log-in pins. Clear am."

                    FORMATTING RULES:
                    - NEVER USE ASTERISKS (*) OR HASHTAGS (#). No bold decorations, no bracket stars.
                    - Use plain UPPERCASE lines for section header separation.`
                };

                let apiMessages = [systemPromptInstruction];

                // Append historical context variables
                recentHistory.forEach(h => {
                    apiMessages.push({ role: h.role === 'me' ? 'assistant' : 'user', content: h.text });
                });

                // Map contemporary message structures
                apiMessages.push({
                    role: "user",
                    content: messageContentPayload
                });

                // Call Inference Generation Engine
                const completion = await openai.chat.completions.create({
                    model: "gpt-4o-mini",
                    messages: apiMessages,
                    max_tokens: 400
                });

                const aiResponse = completion.choices[0].message.content;

                // Push message back over the air
                await sock.sendMessage(remoteJid, { text: aiResponse });

                // Commit parameters straight to Atlas
                userDoc.chatHistory.push({ role: 'user', text: textMessage || (isStickerMessage ? "[Sticker Received]" : "[Image Received]") });
                userDoc.chatHistory.push({ role: 'me', text: aiResponse });
                await userDoc.save();

                // 🚀 NON-BLOCKING RECURSIVE AUTONOMOUS SELF-TRAINING TICK TRIGGER
                process.nextTick(async () => {
                    await runSelfTrainingUpdateLoop(userDoc);
                });

            } catch (err) {
                console.error("❌ Core Agent Response processing loop caught unexpected error:", err.message);
            }
        }
    });
}

// 🌐 INITIALIZE SYSTEM APPARATUS WORKLOAD
startAgent();
