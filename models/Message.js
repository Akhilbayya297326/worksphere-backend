// File: backend/models/Message.js
const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema({
    author: { type: String, required: true },
    role: { type: String, default: 'Staff' },
    text: { type: String, required: true },
    channel: { type: String, default: 'global-orchestration' },
    isBot: { type: Boolean, default: false },
    urgent: { type: Boolean, default: false },
    messageType: { type: String, default: 'message', maxlength: 50 },
    clientId: { type: String, maxlength: 128 },
    timestamp: { type: Date, default: Date.now }
});

MessageSchema.index({ channel: 1, timestamp: -1, _id: -1 });
MessageSchema.index({ clientId: 1 }, { unique: true, partialFilterExpression: { clientId: { $type: 'string' } } });

module.exports = mongoose.model('Message', MessageSchema);
