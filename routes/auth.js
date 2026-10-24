const express = require('express');
const router = express.Router();
const Employee = require('../models/Employee');

// POST: Enterprise Login Gateway
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (typeof email !== 'string' || !email.trim() || typeof password !== 'string' || !password) {
      return res.status(400).json({ success: false, error: 'Email and password are required.' });
    }

    const user = await Employee.findOne({ email: email.trim().toLowerCase() }).select('+password');
    if (!user || user.password !== password) {
      return res.status(401).json({ success: false, error: 'Invalid credentials.' });
    }

    res.json({
      success: true,
      user: {
        _id: user._id,
        name: user.name,
        role: user.role,
        email: user.email
      }
    });
  } catch (err) {
    console.error("Auth Error:", err);
    res.status(500).json({ success: false, error: 'Authentication service down.' });
  }
});

module.exports = router;
