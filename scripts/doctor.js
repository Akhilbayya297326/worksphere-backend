const path = require('node:path');
const { spawn } = require('node:child_process');

const TIMEOUT_MS = 8000;
const value = name => process.env[name]?.trim();

// Inspect nested driver errors locally, then return only fixed, non-secret codes.
function failure(error) {
  const queue = [error];
  const seen = new Set();
  const codes = new Set();
  const names = new Set();
  let auth = false;
  while (queue.length && seen.size < 40) {
    const item = queue.shift();
    if (!item || typeof item !== 'object' || seen.has(item)) continue;
    seen.add(item);
    codes.add(item.code);
    names.add(item.name);
    auth ||= item.code === 18 || item.codeName === 'AuthenticationFailed' || /authentication failed|bad auth/i.test(item.message || '');
    queue.push(item.cause, item.reason, item.error);
    if (item.servers instanceof Map) for (const server of item.servers.values()) queue.push(server.error);
  }
  if (auth) return 'AUTHENTICATION_FAILED';
  if (['ENOTFOUND', 'ENODATA', 'EAI_AGAIN', 'ESERVFAIL', 'EREFUSED'].some(code => codes.has(code))) return 'DNS_LOOKUP_FAILED';
  if ([...codes].some(code => typeof code === 'string' && /CERT|TLS|SSL/.test(code))) return 'TLS_CONNECTION_FAILED';
  if (names.has('MongoParseError') || names.has('MongoInvalidArgumentError')) return 'INVALID_DATABASE_CONFIGURATION';
  if (['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE'].some(code => codes.has(code))) return 'CONNECTION_FAILED';
  if (codes.has('ETIMEDOUT') || codes.has('ECONNABORTED') || names.has('MongoServerSelectionError') || names.has('MongoNetworkTimeoutError')) return 'CONNECTION_TIMEOUT';
  return 'CONNECTION_FAILED';
}

async function mongoWorker() {
  const mongoose = require('mongoose');
  let result;
  try {
    await mongoose.connect(value('MONGO_URI') || 'mongodb://127.0.0.1:27017/worksphere', {
      autoIndex: false, autoCreate: false, bufferCommands: false,
      serverSelectionTimeoutMS: 6000, connectTimeoutMS: 5000, socketTimeoutMS: 5000
    });
    await mongoose.connection.db.command({ ping: 1 });
    result = { ok: true, code: 'PING_OK' };
  } catch (error) {
    result = { ok: false, code: failure(error) };
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
  process.stdout.write(JSON.stringify(result));
}

function checkMongo() {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [__filename, '--mongo-worker'], {
      cwd: path.join(__dirname, '..'), env: process.env, windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    let output = '';
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ service: 'MongoDB', ...result });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, code: 'CONNECTION_TIMEOUT' });
    }, TIMEOUT_MS);
    child.stdout.on('data', chunk => {
      if (output.length < 4096) output += chunk.toString();
    });
    child.once('error', () => finish({ ok: false, code: 'DIAGNOSTIC_PROCESS_FAILED' }));
    child.once('close', () => {
      try {
        const result = JSON.parse(output);
        const allowed = ['PING_OK', 'AUTHENTICATION_FAILED', 'DNS_LOOKUP_FAILED', 'TLS_CONNECTION_FAILED',
          'INVALID_DATABASE_CONFIGURATION', 'CONNECTION_FAILED', 'CONNECTION_TIMEOUT'];
        if (typeof result.ok !== 'boolean' || !allowed.includes(result.code)) throw new Error('Invalid result');
        finish(result);
      } catch {
        finish({ ok: false, code: 'DIAGNOSTIC_PROCESS_FAILED' });
      }
    });
  });
}

function jiraOrigin() {
  const domain = value('JIRA_DOMAIN');
  if (!domain) return null;
  try {
    const url = new URL(domain.includes('://') ? domain : `https://${domain}`);
    return url.protocol === 'https:' && !url.username && !url.password &&
      url.pathname === '/' && !url.search && !url.hash ? url.origin : null;
  } catch { return null; }
}

async function checkService(service, url, headers) {
  try {
    const axios = require('axios');
    await axios.get(url, { headers, timeout: TIMEOUT_MS, maxRedirects: 0 });
    return { service, ok: true, code: 'READ_ACCESS_OK' };
  } catch (error) {
    const status = error.response?.status;
    const code = status === 401 || status === 403 ? 'AUTHENTICATION_OR_PERMISSION_FAILED'
      : status === 404 ? 'RESOURCE_OR_MODEL_NOT_FOUND' : status === 429 ? 'RATE_LIMITED'
        : typeof status === 'number' ? `HTTP_${status}` : failure(error);
    return { service, ok: false, code };
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: npm run doctor -- [--services]\n\nChecks configuration and performs a bounded MongoDB ping in a child process.\n--services additionally reads Gemini model metadata, GitHub /user, and Jira /myself.\nNo generation, model imports, seeding, writes, or index creation.\nUnconfigured optional services are skipped; credentials and database URIs are never printed.');
    return;
  }
  if (args.some(arg => arg !== '--services')) {
    console.error('Unknown option. Run npm run doctor -- --help.');
    process.exitCode = 2;
    return;
  }
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  let invalid = false;
  const warn = message => console.log(`[WARN] ${message}`);
  const configError = message => { invalid = true; console.log(`[FAIL] ${message}`); };
  const port = Number(value('PORT') || 5000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) configError('PORT must be an integer between 1 and 65535.');
  else console.log('[PASS] Server port configuration');
  if (!value('MONGO_URI')) warn('MONGO_URI is missing; checking the project default local MongoDB database.');
  for (const key of ['GITHUB_FRONTEND_REPO', 'GITHUB_BACKEND_REPO']) {
    const repository = value(key);
    if (!repository) warn(`${key} is missing; the corresponding repository link/feed is unavailable.`);
    else if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) configError(`${key} must use owner/repository format.`);
  }
  const probes = [checkMongo()];
  const checkRemote = args.includes('--services');
  const optional = (name, configured, start) => {
    if (!configured) console.log(`[SKIP] ${name}: not configured`);
    else if (!checkRemote) console.log(`[SKIP] ${name}: configured; use --services to verify read access`);
    else probes.push(start());
  };
  const model = (value('GEMINI_MODEL') || 'gemini-2.5-flash').replace(/^models\//, '');
  if (value('GEMINI_API_KEY') && !/^[a-zA-Z0-9._-]+$/.test(model)) configError('GEMINI_MODEL has an invalid format.');
  else optional('Gemini', value('GEMINI_API_KEY'), () => checkService('Gemini',
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}`, { 'x-goog-api-key': value('GEMINI_API_KEY') }));
  const githubToken = value('GITHUB_TOKEN') || value('GITHUB_PAT');
  optional('GitHub', githubToken, () => checkService('GitHub', 'https://api.github.com/user', {
    Authorization: `Bearer ${githubToken}`, Accept: 'application/vnd.github+json'
  }));
  const jiraValues = ['JIRA_DOMAIN', 'JIRA_EMAIL', 'JIRA_API_TOKEN'].map(value);
  const jiraConfigured = jiraValues.every(Boolean);
  if (jiraValues.some(Boolean) && !jiraConfigured) warn('Jira configuration is incomplete; JIRA_DOMAIN, JIRA_EMAIL, and JIRA_API_TOKEN are all required.');
  const jira = jiraOrigin();
  if (jiraConfigured && !jira) configError('JIRA_DOMAIN must be an HTTPS origin without a path, credentials, query, or fragment.');
  else optional('Jira', jiraConfigured, () => checkService('Jira', `${jira}/rest/api/3/myself`, {
    Authorization: `Basic ${Buffer.from(`${value('JIRA_EMAIL')}:${value('JIRA_API_TOKEN')}`).toString('base64')}`,
    Accept: 'application/json'
  }));
  const results = await Promise.all(probes);
  for (const result of results) console.log(`[${result.ok ? 'PASS' : 'FAIL'}] ${result.service}: ${result.code}`);
  console.log('Service reads verify connectivity/access only; AI generation, retrieval data, and writes are not exercised.');
  process.exitCode = invalid || results.some(result => !result.ok) ? 1 : 0;
}

if (process.argv[2] === '--mongo-worker') {
  mongoWorker().catch(() => { process.stdout.write('{"ok":false,"code":"CONNECTION_FAILED"}'); process.exitCode = 1; });
} else {
  main().catch(() => { console.error('[FAIL] Diagnostic could not complete. No credentials were printed.'); process.exitCode = 1; });
}
