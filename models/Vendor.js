const mongoose = require('mongoose');

const VendorSchema = new mongoose.Schema({
    phoneNumber: { type: String, required: true, unique: true }, // The vendor's JID (e.g. 23481...@s.whatsapp.net)
    businessName: { type: String, required: true },
    bankCode: { type: String, required: true },
    accountNumber: { type: String, required: true },
    accountName: { type: String, required: true },
    subaccountId: { type: String, required: true }, // Flutterwave subaccount ID
    dashboardBalance: { type: Number, default: 0 },
    onboardingStep: { type: String, default: "IDLE" }, // IDLE, WAITING_BIZ_NAME, WAITING_BANK, WAITING_ACCT, CONFIRMATION
    tempData: { type: Object, default: {} } // For holding progress during the chat
});

module.exports = mongoose.model('Vendor', VendorSchema);
