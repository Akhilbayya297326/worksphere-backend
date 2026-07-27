// File: backend/models/Message.js
const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema({
    author: { type: String, required: true },
    role: { type: String, default: 'Staff' },
    text: { type: String, required: true },
    channel: { type: String, default: 'global-orchestration' },
    isBot: { type: Boolean, default: false },
    urgent: { type: Boolean, default: false },
    timestamp: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Message', MessageSchema);