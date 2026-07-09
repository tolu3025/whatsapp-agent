const { default: makeWASocket, useMultiFileAuthState, delay, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { OpenAI } = require('openai');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const express = require('express'); 

const openai = new OpenAI({ 
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 60000,   
    maxRetries: 3     
});

let agentModeActive = true; 
const chatHistory = {}; 

const dbPath = path.join(__dirname, 'users.json');

function loadUsers() {
    if (fs.existsSync(dbPath)) return JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    return {};
}

function saveUsers(users) {
    fs.writeFileSync(dbPath, JSON.stringify(users, null, 2));
}

let usersDB = loadUsers();

function convertAudio(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        exec(`ffmpeg -i "${inputPath}" -acodec libmp3lame -y "${outputPath}"`, (error) => {
            if (error) return reject(error);
            resolve(outputPath);
        });
    });
}

async function startAgent() {
    const { state, saveCreds } = await useMultiFileAuthState('agent_auth');
    
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
        if (connection === 'open') console.log("🚀 TOLUWANIMI'S KUKATAI AGENT IS LIVE (WITH VISION ENABLED)!");
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
            
            // 👁️ IMAGE DETECTION ADDED HERE
            const isImageMessage = !!msg.message.imageMessage;
            
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
            // Ignore messages that have no text AND no image
            if (!textMessage && !isImageMessage) continue;

            // 📡 1. THE GROUP CHAT RADAR
            if (isGroup && agentModeActive && !fromMe) {
                const lowerMsg = textMessage.toLowerCase();
                const botNumber = sock.user.id.split(':')[0] + '@s.whatsapp.net';
                const mentionedJids = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
                const isTagged = mentionedJids.includes(botNumber);
                
                const isTriggered = isTagged || lowerMsg.includes('toluwanimi') || lowerMsg.includes('admin') || lowerMsg.includes('softdev') || lowerMsg.includes('agent');

                if (isTriggered) {
                    console.log(`📡 Group Radar Triggered!`);
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

            if (!isGroup) {
                if (!chatHistory[remoteJid]) chatHistory[remoteJid] = [];
                chatHistory[remoteJid].push({ role: fromMe ? "assistant" : "user", content: textMessage || "[User sent an image]" });
                if (chatHistory[remoteJid].length > 6) chatHistory[remoteJid].shift();
            }

            // 📩 2. PERSONAL DM ASSISTANT
            if (!isGroup && agentModeActive && !fromMe) {
                console.log(`🎯 Processing DM for ${remoteJid}...`);
                
                let userProfile = usersDB[remoteJid] || { knownFacts: [] };
                let memoryString = userProfile.knownFacts.length > 0 
                    ? userProfile.knownFacts.map(f => "- " + f).join('\n') 
                    : "- No facts known yet.";

                try {
                    let openAiMessages = [
                        { 
                            role: "system", 
                            content: `
                            You are the highly advanced AI Executive Assistant to Toluwanimi. 
                            
                            🧠 YOUR KNOWLEDGE BASE:
                            - Boss: Toluwanimi (A jovial, caring guy and a highly skilled Full Stack Developer).
                            - Company: KukaPay (Fintech app, crypto-to-cash, vendor payments).
                            - Bank Details: Opay - 8148698365 - Toluwanimi Oyetade Blessing.
                            
                            🗄️ ABOUT THIS USER:
                            ${memoryString}

                            🕵️ HOW TO MEMORIZE:
                            If the user states a fact about themselves, append this to the END of your reply: [MEMORY: Fact goes here].
                            
                            💳 PAYMENT VERIFICATION PROTOCOL (CRITICAL):
                            - If a user says they have transferred money, politely ask them to send the receipt as an image.
                            - If the user sends an image, carefully read the text on it. 
                            - Tell them what you see (e.g., "I can see the receipt for ₦X from [Name]").
                            - NEVER confirm the payment is fully successful. ALWAYS conclude by saying Toluwanimi will confirm the alert on his end before proceeding.

                            🎭 THE TRIPLE-THREAT CHAMELEON MATRIX:
                            MODE 1: RESPECT PROTOCOL (For elders/formal users). Always use "Sir/Ma".
                            MODE 2: BUSINESS PROTOCOL (For KukaPay/Dev services). Sharp and helpful.
                            MODE 3: VIBE PROTOCOL (For peers/friends). Match their energy, use Pidgin. NEVER act like customer service.
                            ` 
                        }
                    ];

                    openAiMessages.push(...chatHistory[remoteJid]);

                    // 👁️ VISION ENGINE: If the user sent an image, download it and show it to the AI
                    if (isImageMessage) {
                        console.log("📸 Downloading image for AI analysis...");
                        const imgBuffer = await downloadMediaMessage(msg, 'buffer', {});
                        const base64Image = imgBuffer.toString('base64');
                        
                        // Replace the last message in the array with a Vision format
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
                        usersDB[remoteJid] = userProfile;
                        saveUsers(usersDB);
                        replyText = replyText.replace(/\[MEMORY:.*?\]/i, '').trim();
                    }
                    
                    chatHistory[remoteJid].push({ role: "assistant", content: replyText });
                    if (chatHistory[remoteJid].length > 6) chatHistory[remoteJid].shift();

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
