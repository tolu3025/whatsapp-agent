const axios = require('axios');
const Vendor = require('./models/Vendor');

// Major Nigerian Bank mapping
const COMMON_BANKS = {
    "access": "044",
    "gtb": "058",
    "gtbank": "058",
    "zenith": "057",
    "uba": "033",
    "opay": "999992",
    "kuda": "50211",
    "moniepoint": "50515",
    "palmpay": "999991"
};

async function handleVendorOnboarding(sock, msg, textMessage, lowerText) {
    const senderJid = msg.key.remoteJid;

    // Find or create the vendor's database profile
    let vendor = await Vendor.findOne({ phoneNumber: senderJid });
    if (!vendor) {
        vendor = new Vendor({ phoneNumber: senderJid });
        await vendor.save();
    }

    // 1️⃣ USER INITIATES ONBOARDING
    if (lowerText === 'register' || lowerText === 'setup' || lowerText === 'onboard') {
        vendor.onboardingStep = "WAITING_BIZ_NAME";
        await vendor.save();
        await sock.sendMessage(senderJid, { 
            text: "Welcome, Boss! Let's get your business set up with KukaPay in under 60 seconds. 🎉\n\nFirst, wetin be your *Business Name*? (Reply with just the name)" 
        });
        return true; // Intercepted
    }

    // 2️⃣ CAPTURE BUSINESS NAME
    if (vendor.onboardingStep === "WAITING_BIZ_NAME") {
        vendor.tempData = { businessName: textMessage };
        vendor.onboardingStep = "WAITING_BANK";
        await vendor.save();
        
        await sock.sendMessage(senderJid, { 
            text: "Nice name! Next, write your *Bank Name* (e.g., Access, GTBank, Zenith, Opay, Kuda, Moniepoint):" 
        });
        return true;
    }

    // 3️⃣ CAPTURE BANK & MATCH BANK CODE
    if (vendor.onboardingStep === "WAITING_BANK") {
        const cleanBank = lowerText.replace(/\s+/g, '');
        const bankCode = COMMON_BANKS[cleanBank];

        if (!bankCode) {
            await sock.sendMessage(senderJid, { 
                text: "Ah, I didn't get that bank. Please type a major bank like GTBank, Opay, Zenith, or Kuda." 
            });
            return true;
        }

        vendor.tempData = { ...vendor.tempData, bankCode, bankName: textMessage };
        vendor.onboardingStep = "WAITING_ACCT";
        await vendor.save();

        await sock.sendMessage(senderJid, { 
            text: `Perfect! Now drop your *10-digit Account Number* for ${vendor.tempData.bankName}:` 
        });
        return true;
    }

    // 4️⃣ CAPTURE ACCOUNT NUMBER & RUN VERIFICATION
    if (vendor.onboardingStep === "WAITING_ACCT") {
        const accountNumber = textMessage.trim();
        if (!/^\d{10}$/.test(accountNumber)) {
            await sock.sendMessage(senderJid, { text: "Boss, that account number no complete. It must be exactly 10 digits. Type am again:" });
            return true;
        }

        await sock.sendMessage(senderJid, { text: "Checking bank database, make I verify details... 🔍" });

        try {
            // Verify Bank Account details via Flutterwave API
            const verifyRes = await axios.post(
                'https://api.flutterwave.com/v3/accounts/resolve',
                {
                    account_number: accountNumber,
                    account_bank: vendor.tempData.bankCode
                },
                { headers: { Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}` } }
            );

            if (verifyRes.data && verifyRes.data.status === 'success') {
                const accountName = verifyRes.data.data.account_name;
                
                vendor.tempData = { ...vendor.tempData, accountNumber, accountName };
                vendor.onboardingStep = "CONFIRMATION";
                await vendor.save();

                await sock.sendMessage(senderJid, { 
                    text: `Sweet! I found these details:\n\n👤 *Account Name:* ${accountName}\n🏦 *Bank:* ${vendor.tempData.bankName}\n🔢 *Account:* ${accountNumber}\n\nIs this correct? Reply *YES* to activate your account or *NO* to restart.` 
                });
            } else {
                throw new Error("Could not verify name.");
            }
        } catch (err) {
            await sock.sendMessage(senderJid, { text: "❌ We couldn't verify those account details. Please type the *10-digit Account Number* again:" });
        }
        return true;
    }

    // 5️⃣ FINAL STEP: CREATE FLUTTERWAVE SUBACCOUNT & ACTIVATE
    if (vendor.onboardingStep === "CONFIRMATION") {
        if (lowerText === 'yes') {
            await sock.sendMessage(senderJid, { text: "Creating your merchant system now, wait small... ⏳" });

            try {
                // Create the actual subaccount under your corporate Flutterwave account
                const subaccountRes = await axios.post(
                    'https://api.flutterwave.com/v3/subaccounts',
                    {
                        account_bank: vendor.tempData.bankCode,
                        account_number: vendor.tempData.accountNumber,
                        business_name: vendor.tempData.businessName,
                        business_email: `${vendor.tempData.businessName.replace(/\s+/g, '').toLowerCase()}@kukapay.com`,
                        split_type: "percentage",
                        split_value: 0.03, // You charge a 3% SaaS fee!
                        country: "NG"
                    },
                    { headers: { Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}` } }
                );

                const subaccountId = subaccountRes.data.data.subaccount_id;

                // Save final merchant to database
                vendor.businessName = vendor.tempData.businessName;
                vendor.bankCode = vendor.tempData.bankCode;
                vendor.accountNumber = vendor.tempData.accountNumber;
                vendor.accountName = vendor.tempData.accountName;
                vendor.subaccountId = subaccountId;
                vendor.onboardingStep = "COMPLETED";
                vendor.tempData = {};
                await vendor.save();

                await sock.sendMessage(senderJid, { 
                    text: `🎉 *CONGRATULATIONS, BOSS!* 🎉\n\nYour KukaPay AI Merchant account is live! \n\n💼 Business: *${vendor.businessName}*\n\nYour customers can now make payment transfers directly to your AI sales agent!` 
                });
            } catch (err) {
                console.error("Flutterwave Subaccount Creation Failed:", err.response?.data || err.message);
                await sock.sendMessage(senderJid, { text: "❌ Setup failed due to a network glitch. Reply *YES* to try again." });
            }
        } else {
            vendor.onboardingStep = "IDLE";
            vendor.tempData = {};
            await vendor.save();
            await sock.sendMessage(senderJid, { text: "Reset complete! Drop a message whenever you are ready to setup again." });
        }
        return true;
    }

    // If they are registered but sending standard messages, let them pass
    if (vendor.onboardingStep === "COMPLETED") {
        return false;
    }

    return false; // Did not intercept
}

module.exports = { handleVendorOnboarding };
