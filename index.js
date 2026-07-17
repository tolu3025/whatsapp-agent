const { 
  default: makeWASocket, 
  useMultiFileAuthState, 
  DisconnectReason, 
  Browsers,
  delay 
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

/**
 * Main function to initialize and start the WhatsApp Integration Bot
 */
async function startWhatsAppBot() {
  console.log('🚀 Initializing WhatsApp connection...');

  // Always initialize authentication state using local folder storage
  const { state, saveCreds } = await useMultiFileAuthState('auth_session');
  
  // Create socket with optimized configurations for Render serverless hosting
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false, // Set to false to support phone number pairing codes
    logger: pino({ level: 'silent' }), // Suppress verbose engine logs

    // 💻 Emulate macOS Desktop (Critical for bypassing pairing handshakes restrictions)
    browser: Browsers.macOS('Desktop'), 

    // ⚙️ Essential Timeout and Socket Keepalive configurations
    connectTimeoutMs: 60000,       // Extended handshake timeout window (default is often too short for Render)
    keepAliveIntervalMs: 30000,    // Periodically ping WhatsApp to prevent Render from idling the socket
    defaultQueryTimeoutMs: 60000,  // Prevents queries from failing on slow networking
  });

  // Save auth updates automatically
  sock.ev.on('creds.update', saveCreds);

  // Monitor Connection Updates
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Trigger pairing code ONLY when the socket successfully connects & isn't registered
    if (qr && !sock.authState.creds.registered) {
      const pairingNumber = process.env.PAIRING_NUMBER;
      
      if (pairingNumber) {
        // Remove symbols, spacing, and the leading '+' (must be pure numeric E.164)
        const cleanNumber = pairingNumber.replace(/[^0-9]/g, ''); 
        
        try {
          console.log(`⏳ Network handshake established. Requesting pairing code for: +${cleanNumber}...`);
          
          // Delay to ensure the WebSockets channel is fully stabilized before invoking pairing methods
          await delay(5000); 
          
          const code = await sock.requestPairingCode(cleanNumber);
          
          console.log(`\n🔑 ================================================`);
          console.log(`🔑 YOUR WHATSAPP PAIRING CODE: ${code}`);
          console.log(`🔑 ================================================` + '\n');
        } catch (err) {
          console.error('🔴 Error generating WhatsApp Pairing Code:', err.message || err);
        }
      } else {
        console.warn('⚠️ No PAIRING_NUMBER specified in your environment variables.');
      }
    }

    // Handle Connection Termination & Reconnections
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut; // Avoid loop if deliberately unlinked
      
      console.log(`🔴 Connection closed. Status Code: ${statusCode || 'Unknown'}. Attempting Reconnect: ${shouldReconnect}`);
      
      if (shouldReconnect) {
        console.log('⏳ Reconnection queued in 10 seconds to avoid server rate-limiting...');
        setTimeout(() => {
          startWhatsAppBot();
        }, 10000);
      }
    } else if (connection === 'open') {
      console.log('🟢 ================================================');
      console.log('🟢 WhatsApp Connection Successfully Established!');
      console.log('🟢 ================================================');
    }
  });

  // Message Listener Flow
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return; // Ignore non-notification frames
    
    for (const msg of messages) {
      try {
        // Integrate your message processing logic here (e.g., Supabase storage, Flutterwave APIs, etc.)
        await handleIncomingFlow(sock, msg);
      } catch (err) {
        console.error('🔴 Error handling message context:', err);
      }
    }
  });
}

/**
 * Stub representing your flow logic
 */
async function handleIncomingFlow(sock, msg) {
  // Your custom integration code
}

// Kick off bot execution
startWhatsAppBot();
