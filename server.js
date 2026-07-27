const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const cors = require('cors');
const { Server } = require('socket.io');
const os = require('os');
require('dotenv').config();

const Message = require('./models/Message');

const app = express();
const server = http.createServer(app);

// 1. Core Middleware
app.use(cors({ origin: '*' }));
app.use(express.json());

// 2. Database Connection
mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/worksphere')
  .then(() => console.log('✅ MongoDB Enterprise Cluster Connected'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

// 3. Real-Time WebSockets Engine
const io = new Server(server, { 
  cors: { origin: '*', methods: ["GET", "POST", "PUT", "DELETE"] } 
});

// 🚀 CRITICAL: Expose 'io' to the rest of the backend for automated triggers
app.set('io', io);

io.on('connection', (socket) => {
  console.log(`🔌 Secure Node Connected: ${socket.id}`);

  // Telemetry Streaming
  const telemetryInterval = setInterval(() => {
    socket.emit('server_telemetry', {
      cpuLoad: os.loadavg()[0].toFixed(2),
      ramUsage: (((os.totalmem() - os.freemem()) / os.totalmem()) * 100).toFixed(1),
      networkThroughput: `${Math.floor(Math.random() * 100) + 50} Mbps`,
      uptime: os.uptime()
    });
  }, 3000);

  // Chaos Monkey
  socket.on('trigger_chaos_monkey', () => {
    io.emit('sev1_alert', {
      type: 'SEV-1_OUTAGE',
      region: 'US-East',
      message: 'CRITICAL: Hardware outage simulated. Emergency re-routing active.',
      timestamp: new Date().toISOString()
    });
  });

  // Real-Time Comm-Link Message Save & Broadcast
  socket.on('send_message', async (data) => {
    try {
      // 1. Save to Database Permanently
      const savedMessage = await Message.create({
        author: data.author,
        role: data.role,
        text: data.text,
        channel: data.channel || 'global-orchestration',
        isBot: data.isBot || false,
        urgent: data.urgent || false,
        timestamp: data.timestamp || new Date()
      });

      // 2. Broadcast to ALL OTHER connected clients
      socket.broadcast.emit('receive_message', savedMessage);
    } catch (error) {
      console.error("Socket Message Save Error:", error);
    }
  });

  // Kanban Workspace Trigger
  socket.on('trigger_workspace_update', () => {
    socket.broadcast.emit('workspace_updated');
  });

  socket.on('disconnect', () => {
    clearInterval(telemetryInterval);
    console.log(`🔌 Node Disconnected: ${socket.id}`);
  });
});

// 4. REST API Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/talent', require('./routes/talent'));
app.use('/api/projects', require('./routes/projects'));
app.use('/api/orchestration', require('./routes/orchestration')); 
app.use('/api/chat', require('./routes/chat')); // 👈 Route for history

// Fallbacks
try { app.use('/api/integrations', require('./routes/integrations')); } catch (e) {}
try { app.use('/api/analysis', require('./routes/analysis')); } catch (e) {}

// 5. Initialize
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 WorkSphere AI Backend running on port ${PORT}`);
  console.log(`⚡ Telemetry & Real-Time Sockets Active`);
});