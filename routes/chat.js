const express = require('express');
const router = express.Router();
const Message = require('../models/Message');

// GET: Fetch ALL global chat history (Used on App Load)
router.get('/', async (req, res) => {
    try {
        // Fetch the last 200 messages, sorted chronologically
        const messages = await Message.find().sort({ timestamp: 1 }).limit(200);
        res.json({ success: true, messages });
    } catch (err) {
        console.error("Chat Fetch Error:", err);
        res.status(500).json({ success: false, error: 'Failed to retrieve chat history.' });
    }
});

// GET: Fetch the last 100 messages for a specific channel
router.get('/history/:channel', async (req, res) => {
  try {
    const messages = await Message.find({ channel: req.params.channel })
      .sort({ timestamp: 1 }) 
      .limit(100); 
      
    res.json({ success: true, messages });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET: Filter messages by specific type
router.get('/filter/:type', async (req, res) => {
  try {
    const messages = await Message.find({ messageType: req.params.type })
      .sort({ timestamp: -1 });
      
    res.json({ success: true, messages });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;