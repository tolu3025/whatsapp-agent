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
        // The syntax error here is completely fixed!
        if (connection === 'open') console.log("🚀 TOLUWANIMI'S KUKATAI AGENT (MEMORY EVOLUTION) IS LIVE!");
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

            if (isStatus || isNewsletter || !textMessage || isGroup) continue;

            if (!chatHistory[remoteJid]) chatHistory[remoteJid] = [];
            chatHistory[remoteJid].push({ role: fromMe ? "assistant" : "user", content: textMessage });
            if (chatHistory[remoteJid].length > 6) chatHistory[remoteJid].shift();

            if (agentModeActive && !fromMe) {
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
                            You are the highly advanced AI Executive Assistant to Toluwanimi. You reply on his behalf when he is away.
                            
                            🧠 YOUR COMPANY KNOWLEDGE:
                            - Boss: Toluwanimi
                            - Company: KukaPay (Fintech app, crypto-to-cash, vendor payments).
                            - Bank Details: [Insert Bank Name] - [Insert Account Number] - [Insert Account Name] (Only provide if asked for payment).

                            🗄️ ABOUT THIS SPECIFIC USER:
                            Here are the facts you have permanently memorized about the person you are talking to right now:
                            ${memoryString}

                            🕵️ HOW TO MEMORIZE NEW FACTS (CRITICAL RULE):
                            If the user tells you their name, their business, or a key detail you should remember for the future, you MUST append a secret note to the END of your reply exactly like this:
                            [MEMORY: The user's name is John]
                            Do NOT acknowledge the memory note in your normal text. Just put it at the very end.

                            🎭 CHAMELEON PERSONA:
                            - Mirror their tone. If they are formal, be formal. If Pidgin, use Pidgin.
                            - STRICT RULE: If Toluwanimi previously called them "Sir" or "Ma", DO NOT use slang. Always be highly respectful.
                            ` 
                        }
                    ];

                    openAiMessages.push(...chatHistory[remoteJid]);

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
                        
                        console.log(`\n💾 NEW MEMORY SAVED: ${newFact}\n`);
                        
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
