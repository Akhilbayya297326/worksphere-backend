const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');
const Employee = require('../models/Employee');
const Project = require('../models/Project');
const Message = require('../models/Message');
const { generateJson, requireText } = require('../utils/ai');
const knowledge = require('../routes/knowledge');
const codebase = require('../routes/codebase');
const analysis = require('../routes/analysis');
const orchestration = require('../routes/orchestration');
const integrations = require('../routes/integrations');

const environmentKeys = ['GEMINI_API_KEY', 'GEMINI_MODEL', 'AI_REQUEST_TIMEOUT_MS', 'GITHUB_TOKEN', 'GITHUB_PAT',
  'GITHUB_FRONTEND_REPO', 'GITHUB_BACKEND_REPO', 'JIRA_API_TOKEN', 'JIRA_EMAIL', 'JIRA_DOMAIN', 'WEBEX_WORKSPACE'];
let previousEnvironment;
beforeEach(t => {
  previousEnvironment = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
  for (const key of environmentKeys) delete process.env[key];
  // Any unmocked network/database access is a test failure, never a real request.
  const unexpected = () => { throw new Error('Unexpected external operation'); };
  t.mock.method(axios, 'get', unexpected);
  t.mock.method(GoogleGenerativeAI.prototype, 'getGenerativeModel', unexpected);
  t.mock.method(Employee, 'find', unexpected);
  t.mock.method(Project, 'findById', unexpected);
  t.mock.method(Project, 'create', unexpected);
  t.mock.method(Message, 'create', unexpected);
  t.mock.method(console, 'error', () => {});
});
afterEach(() => {
  for (const key of environmentKeys) {
    if (previousEnvironment[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnvironment[key];
  }
});

function handler(router, path, index = -1) {
  return router.stack.find(layer => layer.route?.path === path).route.stack.at(index).handle;
}
function response() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}
async function invoke(router, path, request = {}) {
  const res = response();
  await handler(router, path)({ body: {}, params: {}, app: { get: () => null }, ...request }, res);
  return res;
}
function aiResult(t, data, inspect = () => {}) {
  process.env.GEMINI_API_KEY = 'test-api-key';
  GoogleGenerativeAI.prototype.getGenerativeModel.mock.mockImplementation(config => {
    inspect(config);
    return { generateContent: async (content, options) => {
      assert.ok(options.signal instanceof AbortSignal);
      return { response: { text: () => typeof data === 'string' ? data : JSON.stringify(data) } };
    } };
  });
}
const employee = { _id: '507f1f77bcf86cd799439011', name: 'Example Employee', role: 'Developer', skills: ['Node.js'] };
const task = { title: 'Build API', description: 'Implement the project API.', complexity: 'Medium' };

test('AI without a key returns a configuration error before touching the SDK', async () => {
  await assert.rejects(generateJson('question'), error => error.status === 503 && /GEMINI_API_KEY/.test(error.message));
});

test('AI uses the configured model, JSON mode and parses code-fenced output', async t => {
  process.env.GEMINI_MODEL = 'configured-model';
  aiResult(t, '```json\n{"answer":"yes"}\n```', config => {
    assert.equal(config.model, 'configured-model');
    assert.equal(config.generationConfig.responseMimeType, 'application/json');
  });
  assert.deepEqual(await generateJson('question', data => data.answer === 'yes'), { answer: 'yes' });
});

test('AI rejects malformed JSON, non-object roots and incomplete schemas as upstream errors', async t => {
  for (const value of ['not JSON', 'null', '[]', '{"other":true}']) {
    aiResult(t, value);
    await assert.rejects(generateJson('question', data => typeof data.answer === 'string'), error => error.status === 502);
  }
});

test('AI provider failures return a sanitized availability error', async () => {
  process.env.GEMINI_API_KEY = 'test-api-key';
  GoogleGenerativeAI.prototype.getGenerativeModel.mock.mockImplementation(() => ({
    generateContent: async () => { throw new Error('https://provider.invalid/?key=secret'); }
  }));
  await assert.rejects(generateJson('question'), error => error.status === 503 && !error.message.includes('secret'));
});

test('AI enforces its deadline and aborts an unresponsive SDK request', async () => {
  process.env.GEMINI_API_KEY = 'test-api-key';
  process.env.AI_REQUEST_TIMEOUT_MS = '1000';
  let signal;
  GoogleGenerativeAI.prototype.getGenerativeModel.mock.mockImplementation(() => ({
    generateContent: (content, options) => { signal = options.signal; return new Promise(() => {}); }
  }));
  await assert.rejects(generateJson('question'), error => error.status === 504);
  assert.equal(signal.aborted, true);
});

test('the installed Gemini SDK forwards cancellation to fetch without a network request', async t => {
  process.env.GEMINI_API_KEY = 'test-api-key';
  process.env.AI_REQUEST_TIMEOUT_MS = '1000';
  // Exercise the actual installed SDK instead of its model stub.
  GoogleGenerativeAI.prototype.getGenerativeModel.mock.restore();
  let fetchSignal;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    fetchSignal = options.signal;
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => {
      const error = new Error('Aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true }));
  });
  await assert.rejects(generateJson('question'), error => error.status === 504);
  assert.equal(fetchSignal.aborted, true);
  assert.equal(globalThis.fetch.mock.callCount(), 1);
});

test('text validation rejects blank strings, objects, arrays and oversized input', () => {
  for (const input of [undefined, '  ', {}, ['question'], 12]) {
    assert.throws(() => requireText(input, 'Query'), error => error.status === 400);
  }
  assert.throws(() => requireText('abcd', 'Query', 3), error => error.status === 400);
  assert.equal(requireText(' question ', 'Query'), 'question');
});

test('knowledge and codebase routes validate queries and expose missing AI configuration', async () => {
  for (const router of [knowledge, codebase]) {
    assert.equal((await invoke(router, '/query', { body: { query: {} } })).statusCode, 400);
    assert.equal((await invoke(router, '/query', { body: { query: 'Question' } })).statusCode, 503);
  }
});

test('knowledge rejects invalid source types and labels its existing sample retrieval context', async t => {
  const data = { overview: 'JWT authentication.', keyPoints: [], technicalDetails: '', actionItems: [], sources: ['Guide'], confidenceScore: '90%' };
  aiResult(t, data);
  let res = await invoke(knowledge, '/query', { body: { query: 'Authentication?' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.contextType, 'sample');
  aiResult(t, { ...data, sources: { name: 'Guide' } });
  res = await invoke(knowledge, '/query', { body: { query: 'Authentication?' } });
  assert.equal(res.statusCode, 502);
});

test('document analysis returns an explicit configuration error rather than mock success', async () => {
  const res = await invoke(analysis, '/analyze-doc', { body: { text: 'Build an API.' } });
  assert.equal(res.statusCode, 503);
  assert.equal(Employee.find.mock.callCount(), 0);
});

test('document analysis validates AI tasks and drops names outside the available workforce', async t => {
  Employee.find.mock.mockImplementation(() => ({ select: async () => [employee] }));
  aiResult(t, { projectSummary: 'API project.', aiShortlist: [
    { name: employee.name, role: 'Invented role', reason: 'Node skills' }, { name: 'Invented Employee' }
  ], tasks: [task] });
  const res = await invoke(analysis, '/analyze-doc', { body: { documentData: 'Build an API.' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.tasks, [task]);
  assert.deepEqual(res.body.analysis.aiShortlist, [{ name: employee.name, role: employee.role, reason: 'Node skills' }]);
});

test('vision requests reject a missing image before database or AI access', async () => {
  const res = await invoke(orchestration, '/vision-orchestrate', { body: { title: 'Vision' } });
  assert.equal(res.statusCode, 400);
  assert.equal(Employee.find.mock.callCount(), 0);
});

async function upload(mimetype, bytes) {
  const boundary = 'worksphere-test-boundary';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="image.bin"\r\nContent-Type: ${mimetype}\r\n\r\n`),
    bytes, Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
  const req = Readable.from([body]);
  req.headers = { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(body.length) };
  return new Promise((resolve, reject) => {
    const res = response();
    res.json = function (data) { this.body = data; resolve(this); return this; };
    handler(orchestration, '/vision-orchestrate', 0)(req, res, error => error ? reject(error) : resolve({ next: true, req }));
  });
}

test('vision upload rejects unsupported MIME types and oversized files with JSON errors', async () => {
  assert.equal((await upload('application/pdf', Buffer.from('PDF'))).statusCode, 400);
  assert.equal((await upload('image/png', Buffer.alloc(10 * 1024 * 1024 + 1))).statusCode, 413);
  assert.equal((await upload('image/png', Buffer.from('small image'))).next, true);
});

test('draft and confirm routes reject invalid ObjectIds before database queries', async () => {
  for (const path of ['/draft-plan/:projectId', '/confirm-allocation/:projectId']) {
    const res = await invoke(orchestration, path, { params: { projectId: 'not-an-id' } });
    assert.equal(res.statusCode, 400);
  }
  assert.equal(Project.findById.mock.callCount(), 0);
});

test('dispatch rejects missing tasks, invalid repositories, and unknown employees without writes', async () => {
  assert.equal((await invoke(orchestration, '/dispatch')).statusCode, 400);
  const body = { title: 'Project', finalizedTasks: [{ ...task, assignedTo: employee.name }] };
  assert.equal((await invoke(orchestration, '/dispatch', { body: { ...body, repositories: [{ repoType: 'Backend', url: 'javascript:alert(1)' }] } })).statusCode, 400);
  Employee.find.mock.mockImplementation(async () => []);
  assert.equal((await invoke(orchestration, '/dispatch', { body })).statusCode, 400);
  assert.equal(Project.create.mock.callCount(), 0);
});

test('dispatch resolves employee IDs and preserves match reasons using the actual Project schema', async () => {
  Employee.find.mock.mockImplementation(async () => [employee]);
  Project.create.mock.mockImplementation(async data => {
    const project = new Project(data);
    await project.validate();
    return project;
  });
  Message.create.mock.mockImplementation(async data => data);
  const res = await invoke(orchestration, '/dispatch', { body: {
    title: 'Project', finalizedTasks: [{ ...task, assignedTo: employee.name }],
    aiShortlistedTeam: [{ name: employee.name, matchReason: 'Node expertise' }]
  } });
  assert.equal(res.statusCode, 200);
  assert.equal(String(res.body.project.allocatedTasks[0].assignedTo), employee._id);
  assert.equal(res.body.project.aiShortlistedTeam[0].reason, 'Node expertise');
  assert.equal(Employee.find.mock.callCount(), 1);
  assert.equal(Message.create.mock.callCount(), 1);
});

test('draft plans normalize every knowledge-base array and preserve shortlist reasons', async t => {
  const project = new Project({ title: 'Project' });
  t.mock.method(project, 'save', async () => project);
  Project.findById.mock.mockImplementation(async () => project);
  Employee.find.mock.mockImplementation(() => ({ select: async () => [employee] }));
  aiResult(t, {
    shortlistedTeam: [{ employeeId: employee._id, matchReason: 'Node expertise' }], draftedTasks: [task],
    projectKnowledgeBase: { systemArchitecture: ['API', 'DB'], coreFeatures: ['Search'], databaseDesign: ['Documents'], setupInstructions: ['npm install'], qaTestingStrategy: ['API tests'] }
  });
  const res = await invoke(orchestration, '/draft-plan/:projectId', { params: { projectId: String(project._id) } });
  assert.equal(res.statusCode, 200);
  assert.equal(project.projectKnowledgeBase.systemArchitecture, 'API\nDB');
  assert.equal(project.projectKnowledgeBase.databaseDesign, 'Documents');
  assert.equal(project.aiShortlistedTeam[0].reason, 'Node expertise');
  assert.equal(project.save.mock.callCount(), 1);
});

test('integration feed contains no fabricated events or operational claims when unconfigured', async () => {
  const res = await invoke(integrations, '/omni-feed');
  assert.deepEqual(res.body.omniFeed, []);
  assert.equal(res.body.systemHealth.github, 'Not configured');
  assert.equal(res.body.systemHealth.jira, 'Not configured');
  assert.equal(res.body.systemHealth.webex, 'Not monitored');
  assert.equal(axios.get.mock.callCount(), 0);
});

test('a GitHub outage preserves live Jira results with provider deadlines and current JQL search', async () => {
  Object.assign(process.env, { GITHUB_PAT: 'test', GITHUB_FRONTEND_REPO: 'org/repo', JIRA_API_TOKEN: 'test', JIRA_EMAIL: 'user@example.com', JIRA_DOMAIN: 'https://example.atlassian.net/' });
  axios.get.mock.mockImplementation(async (url, options) => {
    assert.equal(options.timeout, 8000);
    if (url.startsWith('https://api.github.com/')) throw new Error('GitHub unavailable');
    assert.equal(url, 'https://example.atlassian.net/rest/api/3/search/jql');
    assert.match(options.params.fields, /summary/);
    return { data: { issues: [{ key: 'EX-1', fields: { summary: 'Ship API', updated: '2026-10-24T00:00:00Z' } }] } };
  });
  const res = await invoke(integrations, '/omni-feed');
  assert.equal(res.body.omniFeed.length, 1);
  assert.equal(res.body.omniFeed[0].platform, 'Jira');
  assert.equal(res.body.omniFeed[0].status, 'Unknown');
  assert.equal(res.body.systemHealth.github, 'Unavailable');
  assert.equal(res.body.systemHealth.jira, 'Operational');
});

test('GitHub accepts the existing GITHUB_TOKEN environment variable and ignores malformed entries', async () => {
  Object.assign(process.env, { GITHUB_TOKEN: 'token-from-existing-config', GITHUB_FRONTEND_REPO: 'org/repo' });
  axios.get.mock.mockImplementation(async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer token-from-existing-config');
    return { data: [null, { sha: 'sha', commit: { author: { name: 'Developer', date: '2026-10-24T00:00:00Z' }, message: 'Ship' } }] };
  });
  const res = await invoke(integrations, '/omni-feed');
  assert.equal(res.body.systemHealth.github, 'Operational');
  assert.equal(res.body.omniFeed.length, 1);
});

test('integration links normalize configured URLs and omit unrelated demo URLs', async () => {
  let res = await invoke(integrations, '/links');
  assert.deepEqual(Object.values(res.body.links), [null, null, null, null]);
  process.env.JIRA_DOMAIN = 'https://example.atlassian.net/';
  process.env.GITHUB_FRONTEND_REPO = 'org/frontend';
  res = await invoke(integrations, '/links');
  assert.equal(res.body.links.jiraBoard, 'https://example.atlassian.net');
  assert.equal(res.body.links.githubFrontend, 'https://github.com/org/frontend');
});
