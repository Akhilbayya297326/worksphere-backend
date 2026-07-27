const mongoose = require('mongoose');

const AuditLogSchema = new mongoose.Schema({
  actionType: { type: String, required: true },
  performedBy: { type: String, default: 'System' },
  resourceId: { type: mongoose.Schema.Types.ObjectId },
  details: { type: String, required: true },
  securityLevel: { type: String, default: 'Standard' }
}, { timestamps: true });

module.exports = mongoose.model('AuditLog', AuditLogSchema);