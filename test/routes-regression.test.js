const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Employee = require('../models/Employee');
const Project = require('../models/Project');
const Message = require('../models/Message');
const AuditLog = require('../models/AuditLog');

// Exercise the actual Express/multer pipeline in process, without any network access.
// Do not import server.js, load .env, or connect to MongoDB in this suite.
const app = express();
app.use(express.json());
app.use('/auth', require('../routes/auth'));
app.use('/talent', require('../routes/talent'));
app.use('/projects', require('../routes/projects'));
app.use('/chat', require('../routes/chat'));
app.use((error, req, res, next) => res.status(400).json({ success: false, error: 'Invalid request.' }));
const validId = '507f1f77bcf86cd799439011';

async function request(t, endpoint, options = {}) {
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
      try { resolve({ status: this.statusCode, data: JSON.parse(value.toString()) }); }
      catch (error) { reject(error); }
      return this;
    };
    app.handle(req, res, reject);
    req.push(body);
    req.push(null);
  });
}

function json(method, data) {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) };
}

function managerJson(method, data) {
  const options = json(method, data);
  options.headers['x-user-role'] = 'Manager';
  return options;
}

function fakeAI(t, value) {
  mockEnv(t, 'GEMINI_API_KEY', 'offline-test-key');
  t.mock.method(GoogleGenerativeAI.prototype, 'getGenerativeModel', () => ({
    generateContent: async () => ({ response: { text: () => JSON.stringify(value) } })
  }));
}

function mockEnv(t, key, value) {
  const previous = process.env[key];
  process.env[key] = value;
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
}

test('login rejects query operator injection before querying employees', async t => {
  const find = t.mock.method(Employee, 'findOne', () => { throw new Error('Unexpected database call'); });
  const result = await request(t, '/auth/login', json('POST', { email: { $ne: null }, password: 'value' }));
  assert.equal(result.status, 400);
  assert.equal(find.mock.callCount(), 0);
});

test('demo password cannot bypass the stored password', async t => {
  t.mock.method(Employee, 'findOne', () => ({ select: async () => ({ password: 'different-secret' }) }));
  const result = await request(t, '/auth/login', json('POST', { email: 'employee@example.test', password: 'cisco2026' }));
  assert.equal(result.status, 401);
});

test('nonexistent demo admin is not invented', async t => {
  t.mock.method(Employee, 'findOne', () => ({ select: async () => null }));
  const result = await request(t, '/auth/login', json('POST', { email: 'admin@worksphere.com', password: 'cisco2026' }));
  assert.equal(result.status, 401);
});

test('seeded account login normalizes email and omits credentials', async t => {
  let query;
  t.mock.method(Employee, 'findOne', filter => {
    query = filter;
    return { select: async () => ({ _id: validId, name: 'User', role: 'Manager', email: 'user@example.test', password: 'cisco2026' }) };
  });
  const result = await request(t, '/auth/login', json('POST', { email: ' USER@example.test ', password: 'cisco2026' }));
  assert.equal(result.status, 200);
  assert.deepEqual(query, { email: 'user@example.test' });
  assert.equal(result.data.user.password, undefined);
});

test('employee JSON never exposes passwords', () => {
  const employee = new Employee({ name: 'User', email: 'user@example.test', password: 'secret' });
  assert.equal(employee.toJSON().password, undefined);
  assert.equal(Employee.schema.path('password').options.select, false);
});

test('adding talent accepts string arrays and removes empty duplicate skills', async t => {
  let employee;
  t.mock.method(Employee.prototype, 'save', async function () { employee = this; return this; });
  const result = await request(t, '/talent/add', managerJson('POST', { name: 'User', email: 'user@example.test', skills: [' React ', '', 'React', 'Node.js'] }));
  assert.equal(result.status, 201);
  assert.deepEqual([...employee.skills], ['React', 'Node.js']);
  assert.equal(result.data.employee.password, undefined);
});

test('invalid talent skills return a useful 400', async t => {
  const result = await request(t, '/talent/add', managerJson('POST', { name: 'User', email: 'user@example.test', skills: { invalid: true } }));
  assert.equal(result.status, 400);
});

test('duplicate employee email returns 409', async t => {
  t.mock.method(Employee.prototype, 'save', async () => { throw Object.assign(new Error('Duplicate'), { code: 11000 }); });
  const result = await request(t, '/talent/add', managerJson('POST', { name: 'User', email: 'user@example.test' }));
  assert.equal(result.status, 409);
});

test('talent edit normalizes skills and ignores credential/internal fields', async t => {
  let update;
  t.mock.method(Employee, 'findByIdAndUpdate', async (id, data) => { update = data; return { _id: id }; });
  const result = await request(t, `/talent/${validId}`, managerJson('PUT', { _id: validId, password: 'injected', skills: ' React, Node.js, React ' }));
  assert.equal(result.status, 200);
  assert.deepEqual(update, { $set: { skills: ['React', 'Node.js'] } });
});

test('talent manager mutations reject absent and developer roles', async t => {
  const update = t.mock.method(Employee, 'findByIdAndUpdate', () => { throw new Error('Unexpected DB mutation'); });
  const remove = t.mock.method(Employee, 'findByIdAndDelete', () => { throw new Error('Unexpected DB mutation'); });
  const save = t.mock.method(Employee.prototype, 'save', () => { throw new Error('Unexpected DB mutation'); });
  for (const role of [undefined, 'Developer']) {
    for (const [method, endpoint] of [['POST', '/talent/add'], ['PUT', `/talent/${validId}`], ['DELETE', `/talent/${validId}`], ['POST', `/talent/${validId}/suggest-skills`]]) {
      const options = json(method, { name: 'User', email: 'user@example.test' });
      if (role) options.headers['x-user-role'] = role;
      const result = await request(t, endpoint, options);
      assert.equal(result.status, 403, `${method} ${endpoint}`);
    }
  }
  assert.equal(update.mock.callCount(), 0);
  assert.equal(remove.mock.callCount(), 0);
  assert.equal(save.mock.callCount(), 0);
});

test('unsupported workspace integration returns an explicit 501 instead of invalid ID', async t => {
  const find = t.mock.method(Project, 'findById', () => { throw new Error('Unexpected database read'); });
  const result = await request(t, '/projects/workspace-integrations');
  assert.equal(result.status, 501);
  assert.equal(result.data.success, false);
  assert.match(result.data.error, /no connector is implemented/);
  assert.equal(find.mock.callCount(), 0);
});

test('invalid dynamic IDs never reach the database', async t => {
  const employeeFind = t.mock.method(Employee, 'findById', () => { throw new Error('Unexpected DB call'); });
  const projectFind = t.mock.method(Project, 'findById', () => { throw new Error('Unexpected DB call'); });
  for (const endpoint of ['/talent/bad-id/roadmap', '/talent/bad-id/suggest-skills', '/projects/bad-id/vault-analysis', '/projects/bad-id/agent-swarm', '/projects/bad-id/apply-patch']) {
    const result = await request(t, endpoint, json('POST', {}));
    assert.equal(result.status, 400, endpoint);
  }
  assert.equal(employeeFind.mock.callCount(), 0);
  assert.equal(projectFind.mock.callCount(), 0);
});

test('chat retrieves newest 200 messages and returns them chronologically', async t => {
  let order;
  let limit;
  t.mock.method(Message, 'find', () => ({ sort: value => { order = value; return { limit: async value => { limit = value; return [{ text: 'newest' }, { text: 'older' }]; } }; } }));
  const result = await request(t, '/chat');
  assert.deepEqual(order, { timestamp: -1, _id: -1 });
  assert.equal(limit, 200);
  assert.deepEqual(result.data.messages.map(message => message.text), ['older', 'newest']);
});

test('channel history queries newest 100 before chronological presentation', async t => {
  let filter;
  let order;
  let limit;
  t.mock.method(Message, 'find', value => { filter = value; return { sort: value => { order = value; return { limit: async value => { limit = value; return [{ text: 'new' }, { text: 'old' }]; } }; } }; });
  const result = await request(t, '/chat/history/engineering');
  assert.deepEqual(filter, { channel: 'engineering' });
  assert.deepEqual(order, { timestamp: -1, _id: -1 });
  assert.equal(limit, 100);
  assert.deepEqual(result.data.messages.map(message => message.text), ['old', 'new']);
});

test('upload returns persisted subdocument ID and writes into backend vault', async t => {
  const project = new Project({ title: 'Upload test' });
  t.mock.method(Project, 'findById', async () => project);
  t.mock.method(project, 'save', async () => project);
  const form = new FormData();
  form.append('file', new Blob(['offline regression fixture']), 'fixture.txt');
  const result = await request(t, `/projects/${validId}/upload`, { method: 'POST', body: form });
  t.after(() => Promise.all(project.files.map(file => fs.rm(file.path, { force: true }))));
  assert.equal(result.status, 200);
  assert.ok(result.data.file._id);
  assert.equal(path.dirname(result.data.file.path), path.resolve(__dirname, '../uploads'));
  assert.equal(await fs.readFile(result.data.file.path, 'utf8'), 'offline regression fixture');
});

test('upload for missing project cleans up the written file', async t => {
  t.mock.method(Project, 'findById', async () => null);
  const before = new Set(await fs.readdir(path.resolve(__dirname, '../uploads')));
  const form = new FormData();
  form.append('file', new Blob(['offline regression fixture']), 'fixture.txt');
  const result = await request(t, `/projects/${validId}/upload`, { method: 'POST', body: form });
  assert.equal(result.status, 404);
  assert.deepEqual(new Set(await fs.readdir(path.resolve(__dirname, '../uploads'))), before);
});

test('vault analysis returns persisted analysis ID for immediate deletion', async t => {
  const project = new Project({ title: 'Review test', files: [{ originalName: 'requirements.txt' }] });
  t.mock.method(Project, 'findById', async () => project);
  t.mock.method(project, 'save', async () => project);
  fakeAI(t, { projectSummary: 'Filename-based review', analysisWorkflows: [], businessRequirements: [], functionalReqs: [], nonFunctionalReqs: [], securityMeasures: [], technicalEnv: [], constraints: [] });
  const result = await request(t, `/projects/${validId}/vault-analysis`, json('POST', {}));
  assert.equal(result.status, 200);
  assert.ok(result.data.analysis._id);
});

test('empty vault returns 400 before invoking AI', async t => {
  t.mock.method(Project, 'findById', async () => new Project({ title: 'Empty' }));
  const result = await request(t, `/projects/${validId}/vault-analysis`, json('POST', {}));
  assert.equal(result.status, 400);
});

test('patch validation rejects missing code before DB/file writes', async t => {
  const find = t.mock.method(Project, 'findById', () => { throw new Error('Unexpected DB call'); });
  const result = await request(t, `/projects/${validId}/apply-patch`, json('POST', {}));
  assert.equal(result.status, 400);
  assert.equal(find.mock.callCount(), 0);
});

test('saved patch succeeds even when notification persistence fails', async t => {
  const project = new Project({ title: 'Patch test' });
  t.mock.method(Project, 'findById', async () => project);
  t.mock.method(project, 'save', async () => project);
  t.mock.method(Message, 'create', async () => { throw new Error('Notification unavailable'); });
  app.set('io', { emit: () => {} });
  t.after(() => { app.set('io', undefined); return Promise.all(project.files.map(file => fs.rm(file.path, { force: true }))); });
  const result = await request(t, `/projects/${validId}/apply-patch`, json('POST', { patchedCode: 'export const fixed = true;' }));
  assert.equal(result.status, 200);
  assert.equal(project.files.length, 1);
  assert.ok(result.data.file._id);
  assert.equal(await fs.readFile(project.files[0].path, 'utf8'), 'export const fixed = true;');
  assert.match(result.data.message, /saved to the vault/);
});

test('failed patch database save removes the orphan file', async t => {
  const project = new Project({ title: 'Patch failure' });
  t.mock.method(Project, 'findById', async () => project);
  t.mock.method(project, 'save', async () => { throw new Error('Offline database'); });
  const result = await request(t, `/projects/${validId}/apply-patch`, json('POST', { patchedCode: 'const fix = true;' }));
  assert.equal(result.status, 500);
  await assert.rejects(fs.access(project.files[0].path), { code: 'ENOENT' });
});

test('invalid project statuses do not perform an update', async t => {
  const update = t.mock.method(Project, 'findByIdAndUpdate', () => { throw new Error('Unexpected DB call'); });
  const result = await request(t, `/projects/${validId}/status`, json('PUT', { status: 'Unknown' }));
  assert.equal(result.status, 400);
  assert.equal(update.mock.callCount(), 0);
});

test('invalid task and project IDs are rejected before database access', async t => {
  const find = t.mock.method(Project, 'findById', () => { throw new Error('Unexpected database call'); });
  for (const endpoint of [
    `/projects/${validId}/tasks/bad-id`,
    `/projects/bad-id/tasks/${validId}`,
  ]) {
    const result = await request(t, endpoint, json('PUT', { status: 'In Progress' }));
    assert.equal(result.status, 400);
    assert.equal(result.data.success, false);
  }
  assert.equal(find.mock.callCount(), 0);
});

test('invalid task statuses cause no database reads or mutations', async t => {
  const find = t.mock.method(Project, 'findById', () => { throw new Error('Unexpected database call'); });
  const save = t.mock.method(Project.prototype, 'save', () => { throw new Error('Unexpected mutation'); });
  for (const status of [undefined, 'Unknown', '', ['Completed'], { $ne: null }, 'toString']) {
    const result = await request(t, `/projects/${validId}/tasks/${validId}`, json('PUT', { status }));
    assert.equal(result.status, 400);
    assert.match(result.data.error, /Invalid task status/);
  }
  assert.equal(find.mock.callCount(), 0);
  assert.equal(save.mock.callCount(), 0);
});

test('task updates return 404 for a missing project or missing task without saving', async t => {
  let project = null;
  t.mock.method(Project, 'findById', async () => project);
  const save = t.mock.method(Project.prototype, 'save', () => { throw new Error('Unexpected mutation'); });
  let result = await request(t, `/projects/${validId}/tasks/${validId}`, json('PUT', { status: 'Completed' }));
  assert.equal(result.status, 404);
  assert.equal(result.data.error, 'Project not found.');
  project = new Project({ title: 'Task test', allocatedTasks: [{ title: 'Existing task', status: 'To Do' }] });
  result = await request(t, `/projects/${validId}/tasks/${validId}`, json('PUT', { status: 'Completed' }));
  assert.equal(result.status, 404);
  assert.equal(result.data.error, 'Task not found.');
  assert.equal(project.allocatedTasks[0].status, 'To Do');
  assert.equal(save.mock.callCount(), 0);
});

test('task updates persist every canonical status and normalize legacy aliases before notifying', async t => {
  let project;
  const steps = [];
  t.mock.method(Project, 'findById', async id => { assert.equal(id, validId); return project; });
  const save = t.mock.method(Project.prototype, 'save', async function () {
    await this.validate();
    steps.push(['saved', this.allocatedTasks[0].status]);
    return this;
  });
  app.set('io', { emit: event => { steps.push(['emitted', event]); } });
  t.after(() => app.set('io', undefined));
  for (const [requested, expected] of [
    ['To Do', 'To Do'], ['In Progress', 'In Progress'], ['Awaiting QA', 'Awaiting QA'],
    ['Completed', 'Completed'], ['Done', 'Awaiting QA'], ['Approved', 'Completed'],
  ]) {
    project = new Project({ title: 'Task test', allocatedTasks: [{ title: 'Build API', status: 'To Do' }] });
    const taskId = String(project.allocatedTasks[0]._id);
    const result = await request(t, `/projects/${validId}/tasks/${taskId}`, json('PUT', { status: requested, title: 'Injected title', assignedTo: validId }));
    assert.equal(result.status, 200);
    assert.equal(result.data.success, true);
    assert.equal(result.data.task._id, taskId);
    assert.equal(result.data.task.status, expected);
    assert.equal(result.data.project.allocatedTasks[0].status, expected);
    assert.equal(project.allocatedTasks[0].title, 'Build API');
    assert.equal(project.allocatedTasks[0].assignedTo, undefined);
    assert.deepEqual(steps.splice(0), [['saved', expected], ['emitted', 'workspace_updated']]);
  }
  assert.equal(save.mock.callCount(), 6);
});

test('task save failures return an error without emitting a workspace update', async t => {
  const project = new Project({ title: 'Task test', allocatedTasks: [{ title: 'Build API' }] });
  t.mock.method(Project, 'findById', async () => project);
  t.mock.method(project, 'save', async () => { throw new Error('Database unavailable'); });
  const emit = t.mock.fn(() => {});
  app.set('io', { emit });
  t.after(() => app.set('io', undefined));
  const result = await request(t, `/projects/${validId}/tasks/${project.allocatedTasks[0]._id}`, json('PUT', { status: 'In Progress' }));
  assert.equal(result.status, 500);
  assert.equal(result.data.success, false);
  assert.equal(emit.mock.callCount(), 0);
});

test('a committed task update succeeds when workspace notification throws', async t => {
  const project = new Project({ title: 'Task test', allocatedTasks: [{ title: 'Build API' }] });
  t.mock.method(Project, 'findById', async () => project);
  const save = t.mock.method(project, 'save', async () => project);
  app.set('io', { emit: () => { throw new Error('Socket unavailable'); } });
  t.after(() => app.set('io', undefined));
  const result = await request(t, `/projects/${validId}/tasks/${project.allocatedTasks[0]._id}`, json('PUT', { status: 'Completed' }));
  assert.equal(result.status, 200);
  assert.equal(result.data.task.status, 'Completed');
  assert.equal(save.mock.callCount(), 1);
});

test('destructive purge is disabled by default and never deletes data', async t => {
  mockEnv(t, 'ENABLE_DESTRUCTIVE_RESET', 'false');
  const projectDelete = t.mock.method(Project, 'deleteMany', () => { throw new Error('Unexpected deletion'); });
  const auditDelete = t.mock.method(AuditLog, 'deleteMany', () => { throw new Error('Unexpected deletion'); });
  const result = await request(t, '/projects/admin/purge-all', { method: 'DELETE' });
  assert.equal(result.status, 403);
  assert.equal(projectDelete.mock.callCount(), 0);
  assert.equal(auditDelete.mock.callCount(), 0);
});

test('enabled destructive purge still requires manager role', async t => {
  mockEnv(t, 'ENABLE_DESTRUCTIVE_RESET', 'true');
  mockEnv(t, 'NODE_ENV', 'test');
  const projectDelete = t.mock.method(Project, 'deleteMany', () => { throw new Error('Unexpected deletion'); });
  const result = await request(t, '/projects/admin/purge-all', { method: 'DELETE' });
  assert.equal(result.status, 403);
  assert.equal(projectDelete.mock.callCount(), 0);
});

test('production destructive purge stays disabled even with manager header', async t => {
  mockEnv(t, 'ENABLE_DESTRUCTIVE_RESET', 'true');
  mockEnv(t, 'NODE_ENV', 'production');
  const projectDelete = t.mock.method(Project, 'deleteMany', () => { throw new Error('Unexpected deletion'); });
  const result = await request(t, '/projects/admin/purge-all', { method: 'DELETE', headers: { 'x-user-role': 'Manager' } });
  assert.equal(result.status, 403);
  assert.equal(projectDelete.mock.callCount(), 0);
});

test('missing AI configuration is an explicit 503 instead of fabricated results', async t => {
  mockEnv(t, 'GEMINI_API_KEY', '');
  t.mock.method(Employee, 'findById', async () => new Employee({ name: 'User', email: 'user@example.test', password: 'unused' }));
  const result = await request(t, `/talent/${validId}/roadmap`, json('POST', {}));
  assert.equal(result.status, 503);
  assert.match(result.data.error, /not configured/);
});

test('incomplete AI roadmap is rejected before the frontend can crash on it', async t => {
  t.mock.method(Employee, 'findById', async () => new Employee({ name: 'User', email: 'user@example.test', password: 'unused' }));
  fakeAI(t, { executiveSummary: 'Missing required arrays' });
  const result = await request(t, `/talent/${validId}/roadmap`, json('POST', {}));
  assert.equal(result.status, 502);
});

test('encoded filename traversal is rejected', async t => {
  const result = await request(t, '/projects/download/..%5Cpackage.json');
  assert.equal(result.status, 400);
});
