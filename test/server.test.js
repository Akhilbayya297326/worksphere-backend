const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, startServer, stopServer } = require('../server');
const http = require('node:http');
const net = require('node:net');
const { EventEmitter } = require('node:events');

let runtime;
const database = { connection: { readyState: 1 } };
const messages = new Map();
let writes = 0;
let failWrites = false;
const MessageModel = {
  async findOne({ clientId }) { return messages.get(clientId) || null; },
  async create(data) {
    if (failWrites) throw new Error('simulated storage failure');
    const saved = { ...data, _id: String(++writes) };
    messages.set(data.clientId, saved);
    return saved;
  }
};

before(() => {
  runtime = createRuntime({ database, MessageModel });
});
after(async () => { await runtime.io.close(); });

// Sandbox loopback can be denied or hang. Use Node's actual HTTP request/response
// objects to exercise Express in process; lifecycle bind failures are injected below.
async function api(endpoint, options = {}) {
  const requestData = new Request(`http://offline.test${endpoint}`, options);
  const body = Buffer.from(await requestData.arrayBuffer());
  return new Promise((resolve, reject) => {
    const req = new http.IncomingMessage(new net.Socket());
    req.url = endpoint;
    req.method = requestData.method;
    req.headers = Object.fromEntries(requestData.headers);
    req.headers['content-length'] = String(body.length);
    const res = new http.ServerResponse(req);
    res.end = function (value) {
      const encoded = value?.toString() || '';
      resolve({ status: this.statusCode, json: async () => JSON.parse(encoded) });
      return this;
    };
    runtime.app.handle(req, res, reject);
    req.push(body);
    req.push(null);
  });
}

function mockEnv(t, key, value) {
  const previous = process.env[key];
  process.env[key] = value;
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
}

test('root health remains available for the existing hosting health check', async () => {
  const response = await api('/');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).service, 'WorkSphere backend');
});

test('readiness tracks connection loss and database requests fail immediately', async () => {
  let response = await api('/api/health');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).database, 'connected');
  database.connection.readyState = 0;
  try {
    response = await api('/api/health/ready');
    assert.equal(response.status, 503);
    assert.equal((await response.json()).success, false);
    const started = Date.now();
    response = await api('/api/projects');
    assert.equal(response.status, 503);
    assert.ok(Date.now() - started < 1500, 'must not wait for Mongoose buffering');
    assert.equal((await api('/api/health/live')).status, 200);
  } finally { database.connection.readyState = 1; }
});

test('knowledge and codebase modules are mounted and validate requests', async () => {
  for (const module of ['knowledge', 'codebase']) {
    const response = await api('/api/' + module + '/query', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).success, false);
  }
});

test('malformed JSON, oversized requests, and unknown routes return JSON errors', async () => {
  let response = await api('/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{broken'
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /valid JSON/);
  response = await api('/api/knowledge/query', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'x'.repeat(2 * 1024 * 1024) })
  });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).success, false);
  response = await api('/api/nonexistent');
  assert.equal(response.status, 404);
  assert.equal((await response.json()).success, false);
});

test('telemetry uses real numeric metrics and unsupported actions report unavailable', async () => {
  const response = await api('/api/workspace/telemetry');
  const { data } = await response.json();
  assert.ok(data.cpu >= 0 && data.cpu <= 100);
  assert.ok(data.ram >= 0 && data.ram <= 100);
  assert.equal(data.networkAvailable, false);
  for (const action of ['deploy', 'ai-diagnostic']) {
    const result = await api('/api/workspace/' + action, { method: 'POST' });
    assert.equal(result.status, 501);
    assert.equal((await result.json()).success, false);
  }
});

const clients = new Set();
function client() {
  const socket = new EventEmitter();
  socket.broadcast = { emit: (event, value) => {
    for (const recipient of clients) if (recipient !== socket) recipient.emit(event, value);
  } };
  socket.disconnect = () => { socket.emit('disconnect'); clients.delete(socket); };
  runtime.io.sockets.listeners('connection')[0](socket);
  clients.add(socket);
  return socket;
}
function send(socket, data) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chat acknowledgement timed out.')), 2000);
    socket.emit('send_message', data, reply => { clearTimeout(timer); resolve(reply); });
  });
}

test('chat acknowledges persistence, broadcasts saved data, and deduplicates retries', async () => {
  const sender = client();
  const recipient = client();
  try {
    const received = new Promise(resolve => recipient.once('receive_message', resolve));
    const data = { clientId: 'server-test-message', author: 'Test User', text: 'Hello', messageType: 'update', timestamp: '2000-01-01' };
    const reply = await send(sender, data);
    assert.equal(reply.success, true);
    assert.equal(reply.message.clientId, data.clientId);
    assert.equal(reply.message.messageType, 'update');
    assert.ok(new Date(reply.message.timestamp).getTime() > Date.now() - 10000);
    assert.equal((await received)._id, reply.message._id);
    const previousWrites = writes;
    const retry = await send(sender, data);
    assert.equal(retry.message._id, reply.message._id);
    assert.equal(writes, previousWrites);
  } finally { sender.disconnect(); recipient.disconnect(); }
});

test('chat acknowledges invalid input, disconnected storage, and failed saves', async () => {
  const socket = client();
  try {
    for (const data of [null, {}, { author: 'Tester', text: '' }, { author: 'Tester', text: 'ok', channel: {} },
      { author: 'Tester', text: 'ok', clientId: 'x'.repeat(129) }, { author: 'Tester', text: 'ok', messageType: {} }]) {
      assert.equal((await send(socket, data)).success, false);
    }
    database.connection.readyState = 0;
    assert.equal((await send(socket, { author: 'Tester', text: 'Unavailable' })).success, false);
    database.connection.readyState = 1;
    failWrites = true;
    assert.equal((await send(socket, { author: 'Tester', text: 'Save fails' })).success, false);
  } finally { database.connection.readyState = 1; failWrites = false; socket.disconnect(); }
});

test('startup refuses database failures and cleans up when the port is occupied', async t => {
  let disconnected = 0;
  const failedDatabase = {
    connection: { readyState: 0 },
    async connect() { throw new Error('test database unreachable'); },
    async disconnect() { disconnected++; }
  };
  await assert.rejects(startServer({ port: 0, database: failedDatabase }), /test database unreachable/);
  assert.equal(disconnected, 1);
  const connectedDatabase = {
    connection: { readyState: 1 }, async connect() {}, async disconnect() { disconnected++; }
  };
  t.mock.method(http.Server.prototype, 'listen', function () {
    queueMicrotask(() => this.emit('error', Object.assign(new Error('occupied'), { code: 'EADDRINUSE' })));
    return this;
  });
  await assert.rejects(startServer({ port: 5000, database: connectedDatabase }), { code: 'EADDRINUSE' });
  assert.equal(disconnected, 2);
  await assert.rejects(startServer({ port: 'invalid', database: connectedDatabase }), /PORT/);
});

test('startup preserves the original database failure when cleanup also fails', async () => {
  const original = Object.assign(new Error('Original connection failure'), { code: 'CONNECT_FAILED' });
  const failedDatabase = {
    connection: { readyState: 0 },
    async connect() { throw original; },
    async disconnect() { throw new Error('Secondary cleanup failure'); }
  };
  await assert.rejects(startServer({ port: 0, database: failedDatabase }), error => error === original);
});

test('startup has an external deadline even when DNS/driver connect never settles', { timeout: 2000 }, async t => {
  mockEnv(t, 'DB_CONNECT_TIMEOUT_MS', '100');
  let disconnected = false;
  const failedDatabase = {
    connection: { readyState: 0 }, connect: () => new Promise(() => {}),
    async disconnect() { disconnected = true; }
  };
  const started = Date.now();
  await assert.rejects(startServer({ port: 0, database: failedDatabase }), { code: 'DB_CONNECT_TIMEOUT' });
  assert.ok(Date.now() - started < 1500);
  assert.equal(disconnected, true);
});

test('startup cleanup itself is bounded when disconnect never settles', { timeout: 2000 }, async t => {
  mockEnv(t, 'DB_CONNECT_TIMEOUT_MS', '100');
  const original = new Error('Original connect error');
  const failedDatabase = {
    connection: { readyState: 0 }, async connect() { throw original; },
    disconnect: () => new Promise(() => {})
  };
  await assert.rejects(startServer({ port: 0, database: failedDatabase }), error => error === original);
});

test('shutdown stops readiness, closes HTTP/socket resources and disconnects storage', async () => {
  const calls = [];
  const lifecycle = {
    beginShutdown: () => calls.push('draining'),
    io: { async close() { calls.push('close'); } }, server: { closeAllConnections() { calls.push('force'); } }
  };
  await stopServer(lifecycle, { database: { async disconnect() { calls.push('disconnect'); } } });
  assert.deepEqual(calls, ['draining', 'close', 'disconnect']);
});

test('shutdown disconnect failure is reported, not an unhandled async callback rejection', async () => {
  const failure = new Error('Disconnect failed');
  let forced = false;
  const lifecycle = { io: { async close() {} }, server: { closeAllConnections() { forced = true; } } };
  await assert.rejects(stopServer(lifecycle, { database: { async disconnect() { throw failure; } } }), error => error === failure);
  assert.equal(forced, true);
});

test('shutdown timeout forces remaining HTTP connections closed', { timeout: 1000 }, async () => {
  let forced = false;
  const lifecycle = { io: { async close() {} }, server: { closeAllConnections() { forced = true; } } };
  await assert.rejects(stopServer(lifecycle, { database: { disconnect: () => new Promise(() => {}) }, timeoutMs: 25 }), { code: 'SHUTDOWN_TIMEOUT' });
  assert.equal(forced, true);
});

test('draining runtime rejects storage requests even while database is still connected', async () => {
  runtime.beginShutdown();
  assert.equal((await api('/api/health/ready')).status, 503);
  assert.equal((await api('/api/projects')).status, 503);
});
