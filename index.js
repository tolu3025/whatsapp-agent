const { default: makeWASocket, useMultiFileAuthState, delay, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { OpenAI } = require('openai');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const express = require('express'); 

// The API key is securely pulled from Render's Environment Variables
const openai = new OpenAI({ 
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 60000,   
    maxRetries: 3     
});

// 🔥 AMNESIA FIX: Agent is now ON by default when the server boots
let agentModeActive = true; 

// 🧠 TRUE MEMORY BANK
const chatHistory = {}; 

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
        } catch (err) {
            console.error('Error requesting pairing code:', err);
        }
    }

    sock.ev.on('connection.update', (update) => {
        const { connection } = update;
        if (connection === 'open') console.log('🚀 KUKATAI EXECUTIVE ASSISTANT (AUTONOMOUS CLOUD VERSION) IS LIVE!');
        if (connection === 'close') startAgent();
    });

    sock.ev.on('call', async (callEvents) => {
        if (!agentModeActive) return; 
        for (const call of callEvents) {
            if (call.status === 'timeout' || call.status === 'reject') {
                const remoteJid = call.from;
                try {
                    await sock.sendMessage(remoteJid, { 
                        text: `Hello. Toluwanimi's assistant here. He missed your call and is currently offline. Please leave a text message here, and I'll make sure he sees it as soon as he's back.` 
                    });
                } catch (err) { console.error(err); }
            }
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify' && m.type !== 'append') return;

        for (const msg of m.messages) {
            if (!msg.message) continue;

            const remoteJid = msg.key.remoteJid;
            
            // 🛑 CORE FILTERS
            const isGroup = remoteJid.endsWith('@g.us');
            const isStatus = remoteJid === 'status@broadcast';
            const isNewsletter = remoteJid.endsWith('@newsletter');
            const fromMe = msg.key.fromMe;
            
            let textMessage = msg.message.conversation || 
                                msg.message.extendedTextMessage?.text || 
                                msg.message.imageMessage?.caption ||
                                "";

            const isAudioMessage = msg.message.audioMessage;
            const isStickerMessage = msg.message.stickerMessage;
            const isImageMessage = msg.message.imageMessage;

            // 🎛️ MANUAL REMOTE SWITCH
            if (fromMe && textMessage) {
                const lowerMsg = textMessage.toLowerCase().trim();
                if (lowerMsg === '.agent on') {
                    agentModeActive = true;
                    await sock.sendMessage(remoteJid, { text: "💼 *Assistant Mode Activated.* Cloud systems running." });
                    continue;
                }
                if (lowerMsg === '.agent off') {
                    agentModeActive = false;
                    await sock.sendMessage(remoteJid, { text: "👋 *Assistant Mode Deactivated.* Bot is now sleeping." });
                    continue;
                }
            }

            if (isStatus || isNewsletter) continue;

            // 🎙️ VOICE NOTE PIPELINE
            if (agentModeActive && !isGroup && isAudioMessage) {
                try {
                    const buffer = await downloadMediaMessage(msg, 'buffer', {});
                    const tempOgg = path.join(__dirname, `temp_${Date.now()}.ogg`);
                    const tempMp3 = path.join(__dirname, `temp_${Date.now()}.mp3`);
                    fs.writeFileSync(tempOgg, buffer);
                    await convertAudio(tempOgg, tempMp3);

                    const transcription = await openai.audio.transcriptions.create({
                        file: fs.createReadStream(tempMp3),
                        model: "whisper-1",
                    });
                    textMessage = transcription.text;

                    if (fs.existsSync(tempOgg)) fs.unlinkSync(tempOgg);
                    if (fs.existsSync(tempMp3)) fs.unlinkSync(tempMp3);
                } catch (err) { continue; }
            }

            if (agentModeActive && !isGroup && isStickerMessage) {
                textMessage = `[User sent a WhatsApp Sticker reaction.]`;
            }

            if (!textMessage && !isImageMessage) continue;

            // 🧠 UPDATE CONVERSATION MEMORY & QUOTES
            if (!isGroup) {
                if (!chatHistory[remoteJid]) chatHistory[remoteJid] = [];
                
                let memoryText = textMessage || "[Image Media Sent]";

                if (msg.message.extendedTextMessage?.contextInfo?.quotedMessage) {
                    const qMsg = msg.message.extendedTextMessage.contextInfo.quotedMessage;
                    let quotedTextContext = qMsg.conversation || qMsg.extendedTextMessage?.text || "[Media/Sticker]";
                    memoryText = `(User quoted/replied to this older message: "${quotedTextContext}")\nUser's new reply: ${memoryText}`;
                }
                
                chatHistory[remoteJid].push({
                    role: fromMe ? "assistant" : "user",
                    content: memoryText
                });

                if (chatHistory[remoteJid].length > 6) {
                    chatHistory[remoteJid].shift();
                }
            }

            // 👥 STRICT GROUP HANDLER (ONLY REPLIES IF TAGGED)
            if (isGroup && !fromMe && agentModeActive) {
                const botNumber = sock.user.id.split(':')[0] + '@s.whatsapp.net';
                const mentionedJids = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
                
                if (mentionedJids.includes(botNumber)) {
                    console.log(`🎯 Bot was explicitly tagged in a group!`);
                    try {
                        const completion = await openai.chat.completions.create({
                            model: "gpt-4o-mini",
                            messages: [
                                { role: "system", content: "You are Toluwanimi's intelligent assistant. You were just tagged in a group chat. Keep your reply brief, sharp, and helpful." },
                                { role: "user", content: textMessage }
                            ],
                        });
                        await sock.sendMessage(remoteJid, { text: completion.choices[0].message.content }, { quoted: msg });
                    } catch (err) {
                        console.error("Group error:", err.message);
                    }
                }
                continue; 
            }

            // 📩 PERSONAL INTELLECTUAL DM ASSISTANT LOGIC
            if (agentModeActive && !isGroup && !fromMe) {
                console.log(`🎯 Processing DM for ${remoteJid}...`);
                try {
                    let openAiMessages = [
                        { 
                            role: "system", 
                            content: `
                            You are the highly advanced AI Personal Assistant to Toluwanimi. You reply on his behalf when he is away.
                            
                            STRICT ROLE RULES:
                            1. If asked who you are, proudly introduce yourself as Toluwanimi's automated assistant.
                            2. NEVER offer to "draft a response". Never use labels like "[Auto-Reply]".
                            
                            🕵️ AGE & GENDER DETECTION (RESPECT PROTOCOL):
                            - Scan the chat history to deduce the user's age and gender based on how they speak and how Toluwanimi speaks to them.
                            - If the user appears older/senior (or Toluwanimi addressed them formally like "Sir", "Ma", "Mr"), automatically use highly respectful Nigerian language (e.g., "Good afternoon, sir/ma").
                            - If it is a male peer, you can use "bro", "boss", or "my gee" IF the tone fits.
                            - If it is a female peer, keep it friendly and warm. 
                            - If unsure, remain neutral but polite.
                            
                            🎭 CHAMELEON PERSONA (TONE MATCHING):
                            - You MUST mirror their exact energy and language!
                            - If they use Nigerian Pidgin, reply in Nigerian Pidgin smoothly.
                            - If the conversation is formal English, reply in formal English.
                            - Be brief, natural, and grounded.
                            
                            CONVERSATION FLOW:
                            - Only use the "LET IT GO" rule if the user says "Thanks", "Okay", or sends a thumbs up to close the chat. 
                            ` 
                        }
                    ];

                    openAiMessages.push(...chatHistory[remoteJid]);

                    if (isImageMessage) {
                        const imgBuffer = await downloadMediaMessage(msg, 'buffer', {});
                        const base64Image = imgBuffer.toString('base64');
                        
                        openAiMessages[openAiMessages.length - 1] = {
                            role: "user",
                            content: [
                                { type: "text", text: textMessage || "Examine this image." },
                                { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
                            ]
                        };
                    }

                    const completion = await openai.chat.completions.create({
                        model: "gpt-4o-mini",
                        messages: openAiMessages,
                    });

                    const replyText = completion.choices[0].message.content;
                    
                    chatHistory[remoteJid].push({ role: "assistant", content: replyText });
                    if (chatHistory[remoteJid].length > 6) chatHistory[remoteJid].shift();

                    await sock.sendMessage(remoteJid, { text: replyText }, { quoted: msg });
                    console.log(`✅ Response delivered.`);
                    await delay(2000);
                } catch (err) {
                    console.error("Personal desk engine error:", err.message);
                }
            }
        }
    });
}

startAgent();

// 🌐 DUMMY WEB SERVER FOR RENDER 
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Kukatai Agent is running 24/7 in the cloud!'));
app.listen(port, () => console.log(`🌐 Web server active on port ${port}`));
