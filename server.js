const path = require('node:path');
// Resolve configuration here, including when started from the project root.
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const http = require('node:http');
const mongoose = require('mongoose');
const cors = require('cors');
const { Server } = require('socket.io');
const os = require('node:os');

// Fail promptly during disconnects instead of buffering database writes.
mongoose.set('bufferCommands', false);
const Message = require('./models/Message');

function createTelemetry() {
  let previous = os.cpus();
  return () => {
    const current = os.cpus();
    let total = 0;
    let idle = 0;
    current.forEach((cpu, index) => {
      const before = previous[index]?.times || cpu.times;
      for (const key of Object.keys(cpu.times)) total += cpu.times[key] - before[key];
      idle += cpu.times.idle - before.idle;
    });
    previous = current;
    const cpu = Number((total > 0 ? 100 * (1 - idle / total) : 0).toFixed(1));
    const ram = Number((100 * (1 - os.freemem() / os.totalmem())).toFixed(1));
    return {
      cpu, ram, network: 0, networkAvailable: false,
      cpuLoad: cpu, ramUsage: ram, networkThroughput: null,
      uptime: os.uptime()
    };
  };
}

function createRuntime({ database = mongoose, MessageModel = Message, origins = process.env.CORS_ORIGINS } = {}) {
  const app = express();
  const server = http.createServer(app);
  const origin = origins ? origins.split(',').map(value => value.trim()).filter(Boolean) : '*';
  const io = new Server(server, { cors: { origin, methods: ['GET', 'POST', 'PUT', 'DELETE'] } });
  const readTelemetry = createTelemetry();
  let shuttingDown = false;
  const databaseReady = () => !shuttingDown && database.connection.readyState === 1;

  app.disable('x-powered-by');
  app.use(cors({ origin }));
  app.use(express.json({ limit: '2mb' }));
  app.set('io', io);

  // Preserve the root health endpoint used by the existing hosted service.
  app.get('/', (req, res) => res.json({ success: true, service: 'WorkSphere backend', status: 'alive' }));

  const health = (req, res) => {
    const ready = databaseReady();
    res.status(ready ? 200 : 503).json({
      success: ready, status: ready ? 'ready' : 'degraded',
      database: ready ? 'connected' : 'disconnected', uptime: process.uptime()
    });
  };
  app.get('/api/health', health);
  app.get('/api/health/ready', health);
  app.get('/api/health/live', (req, res) => res.json({ success: true, status: 'alive' }));
  app.get('/api/workspace/telemetry', (req, res) => res.json({ success: true, data: readTelemetry() }));
  app.post('/api/workspace/deploy', (req, res) => res.status(501).json({
    success: false, error: 'Deployment is unavailable: no CI/CD runner is configured for this project.'
  }));
  app.post('/api/workspace/ai-diagnostic', (req, res) => res.status(501).json({
    success: false, error: 'Repository diagnostics are unavailable: no repository checkout or test runner is connected.'
  }));

  // Independent integrations stay accessible while database requests fail fast.
  app.use(['/api/auth', '/api/talent', '/api/projects', '/api/orchestration', '/api/analysis', '/api/chat'], (req, res, next) => {
    if (databaseReady()) return next();
    return res.status(503).json({ success: false, error: 'Database is unavailable. Check MongoDB connectivity and retry.' });
  });

  // Broken modules must fail startup visibly instead of silently becoming 404s.
  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/talent', require('./routes/talent'));
  app.use('/api/projects', require('./routes/projects'));
  app.use('/api/orchestration', require('./routes/orchestration'));
  app.use('/api/chat', require('./routes/chat'));
  app.use('/api/integrations', require('./routes/integrations'));
  app.use('/api/analysis', require('./routes/analysis'));
  app.use('/api/knowledge', require('./routes/knowledge'));
  app.use('/api/codebase', require('./routes/codebase'));

  app.use((req, res) => res.status(404).json({ success: false, error: 'API route not found.' }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.code === 'LIMIT_FILE_SIZE' || error.type === 'entity.too.large' ? 413
      : error.name === 'MulterError' || error.type === 'entity.parse.failed' || error instanceof URIError ? 400
        : error.status >= 400 && error.status < 500 ? error.status : 500;
    const message = status === 413 ? 'Request or uploaded file exceeds the allowed size.'
      : error.type === 'entity.parse.failed' ? 'Request body must contain valid JSON.'
        : status === 400 ? 'Invalid request or upload.' : 'Unexpected server error.';
    if (status === 500) console.error('Request failed:', error.name);
    res.status(status).json({ success: false, error: message });
  });

  io.on('connection', socket => {
    const telemetryInterval = setInterval(() => socket.emit('server_telemetry', readTelemetry()), 3000);
    socket.on('trigger_chaos_monkey', () => io.emit('sev1_alert', {
      type: 'SIMULATED_OUTAGE', region: 'Simulation',
      message: 'Hardware outage simulation requested.', timestamp: new Date().toISOString()
    }));
    socket.on('send_message', async (data, acknowledge) => {
      const reply = typeof acknowledge === 'function' ? acknowledge : () => {};
      if (!databaseReady()) return reply({ success: false, error: 'Chat storage is unavailable. Message was not saved.' });
      if (!data || typeof data !== 'object' || typeof data.author !== 'string' || !data.author.trim()
        || typeof data.text !== 'string' || !data.text.trim() || data.text.length > 10000
        || data.author.length > 200 || (data.clientId !== undefined && (typeof data.clientId !== 'string' || !data.clientId.trim() || data.clientId.length > 128))
        || (data.messageType !== undefined && (typeof data.messageType !== 'string' || !data.messageType.trim() || data.messageType.length > 50))
        || (data.channel !== undefined && (typeof data.channel !== 'string' || !data.channel.trim() || data.channel.length > 100))) {
        return reply({ success: false, error: 'A valid author and message are required (maximum 10,000 characters).' });
      }
      try {
        const existing = data.clientId ? await MessageModel.findOne({ clientId: data.clientId }) : null;
        if (existing) return reply({ success: true, message: existing });
        const savedMessage = await MessageModel.create({
          author: data.author.trim(), role: typeof data.role === 'string' ? data.role.slice(0, 100) : 'Staff',
          text: data.text.trim(), channel: data.channel?.trim() || 'global-orchestration',
          clientId: data.clientId, messageType: data.messageType?.trim() || 'message',
          isBot: data.isBot === true, urgent: data.urgent === true,
          timestamp: new Date()
        });
        socket.broadcast.emit('receive_message', savedMessage);
        reply({ success: true, message: savedMessage });
      } catch (error) {
        if (error.code === 11000 && data.clientId) {
          try {
            const existing = await MessageModel.findOne({ clientId: data.clientId });
            if (existing) return reply({ success: true, message: existing });
          } catch { /* Return the explicit failure below. */ }
        }
        console.error('Socket message save failed:', error.name);
        reply({ success: false, error: 'Message could not be saved. Please retry.' });
      }
    });
    socket.on('trigger_workspace_update', () => socket.broadcast.emit('workspace_updated'));
    socket.on('disconnect', () => clearInterval(telemetryInterval));
  });
  return { app, server, io, beginShutdown() { shuttingDown = true; } };
}

async function withDeadline(operation, timeoutMs, code, message) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(message), { code })), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function stopServer(runtime, { database = mongoose, timeoutMs = 10000 } = {}) {
  runtime.beginShutdown?.();
  // The deadline also covers a database disconnect that never resolves.
  const cleanup = (async () => {
    try { await runtime.io.close(); }
    finally { await database.disconnect(); }
  })();
  try {
    await withDeadline(cleanup, timeoutMs, 'SHUTDOWN_TIMEOUT', 'Backend shutdown timed out.');
  } catch (error) {
    runtime.server.closeAllConnections?.();
    throw error;
  }
}

async function startServer({ port = process.env.PORT || 5000, mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/worksphere', database = mongoose, ...options } = {}) {
  if (!/^\d+$/.test(String(port)) || Number(port) < 0 || Number(port) > 65535) throw new Error('PORT must be a number between 0 and 65535.');
  const timeout = Number(process.env.DB_CONNECT_TIMEOUT_MS || 5000);
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 60000) throw new Error('DB_CONNECT_TIMEOUT_MS must be between 100 and 60000.');
  const runtime = createRuntime({ database, ...options });
  try {
    // DNS/SRV resolution can outlast the driver's own server selection timeout.
    await withDeadline(database.connect(mongoUri, { serverSelectionTimeoutMS: timeout, connectTimeoutMS: timeout, socketTimeoutMS: 15000 }),
      timeout, 'DB_CONNECT_TIMEOUT', 'MongoDB connection timed out. Check DNS, network access, and database configuration.');
    await new Promise((resolve, reject) => {
      runtime.server.once('error', reject);
      runtime.server.listen(Number(port), () => {
        runtime.server.removeListener('error', reject);
        resolve();
      });
    });
    return runtime;
  } catch (error) {
    try { await stopServer(runtime, { database, timeoutMs: Math.min(timeout, 5000) }); }
    catch (cleanupError) { console.error('Startup cleanup failed:', cleanupError.code || cleanupError.name); }
    throw error;
  }
}

if (require.main === module) {
  mongoose.connection.on('error', () => console.error('MongoDB connection error. Check database access and network configuration.'));
  mongoose.connection.on('disconnected', () => console.error('MongoDB disconnected. Database requests return 503 until reconnection.'));
  startServer().then(runtime => {
    console.log('WorkSphere backend ready on port ' + runtime.server.address().port + '; MongoDB connected.');
    let shuttingDown = false;
    const shutdown = async (exitCode = 0) => {
      if (shuttingDown) return;
      shuttingDown = true;
      try { await stopServer(runtime); }
      catch (error) {
        console.error('Backend shutdown failed:', error.code || error.name);
        exitCode = 1;
      }
      process.exit(exitCode);
    };
    process.once('SIGINT', () => { void shutdown(); });
    process.once('SIGTERM', () => { void shutdown(); });
    runtime.server.on('error', error => {
      console.error('HTTP server failed:', error.code || error.name);
      void shutdown(1);
    });
  }).catch(error => {
    console.error('Backend startup failed:', error.code === 'EADDRINUSE' ? 'The configured port is already in use.'
      : error.name === 'MongooseServerSelectionError' || error.name === 'MongoServerSelectionError' ? 'MongoDB is unreachable. Check MONGO_URI, DNS/network access, and the Atlas IP access list.'
        : error.code || error.message.replace(/mongodb(?:\+srv)?:\/\/\S+/g, '[database URI]'));
    process.exit(1);
  });
}

module.exports = { createRuntime, startServer, stopServer, createTelemetry };
