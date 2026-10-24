const express = require('express');
const router = express.Router();
const axios = require('axios');

const REQUEST_TIMEOUT_MS = 8000;
const validRepository = value => typeof value === 'string' && /^[\w.-]+\/[\w.-]+$/.test(value);

function jiraOrigin() {
  const domain = process.env.JIRA_DOMAIN?.trim();
  if (!domain) return null;
  try {
    const url = new URL(domain.includes('://') ? domain : `https://${domain}`);
    return url.protocol === 'https:' && !url.username && !url.password &&
      (!url.pathname || url.pathname === '/') && !url.search && !url.hash ? url.origin : null;
  } catch {
    return null;
  }
}

// Providers run independently so one failure cannot block the other feed.
router.get('/omni-feed', async (req, res) => {
  const systemHealth = { github: 'Not configured', jira: 'Not configured', webex: 'Not monitored', confluence: 'Not monitored' };
  const [githubFeed, jiraFeed] = await Promise.all([
    (async () => {
      const repository = process.env.GITHUB_FRONTEND_REPO?.trim();
      const token = process.env.GITHUB_TOKEN?.trim() || process.env.GITHUB_PAT?.trim();
      if (!repository || !token) return [];
      systemHealth.github = 'Unavailable';
      if (!validRepository(repository)) return [];
      try {
        const response = await axios.get(`https://api.github.com/repos/${repository}/commits`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
          params: { per_page: 3 }, timeout: REQUEST_TIMEOUT_MS, maxRedirects: 0
        });
        if (!Array.isArray(response.data)) throw new Error('Invalid GitHub response');
        const feed = response.data.filter(commit => typeof commit?.sha === 'string' && commit.commit?.author &&
          typeof commit.commit.message === 'string' && Number.isFinite(Date.parse(commit.commit.author.date)))
          .map(commit => ({
            id: commit.sha, platform: 'GitHub', type: 'COMMIT',
            user: typeof commit.commit.author.name === 'string' ? commit.commit.author.name : 'Team Member', message: commit.commit.message,
            timestamp: commit.commit.author.date, url: commit.html_url, status: 'Success'
          }));
        systemHealth.github = 'Operational';
        return feed;
      } catch {
        return [];
      }
    })(),
    (async () => {
      const token = process.env.JIRA_API_TOKEN?.trim();
      const email = process.env.JIRA_EMAIL?.trim();
      if (!token || !email || !process.env.JIRA_DOMAIN?.trim()) return [];
      systemHealth.jira = 'Unavailable';
      const origin = jiraOrigin();
      if (!origin) return [];
      try {
        const response = await axios.get(`${origin}/rest/api/3/search/jql`, {
          headers: { Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`, Accept: 'application/json' },
          params: {
            jql: 'updated >= -30d ORDER BY updated DESC', maxResults: 3,
            fields: 'summary,creator,updated,status'
          },
          timeout: REQUEST_TIMEOUT_MS, maxRedirects: 0
        });
        if (!Array.isArray(response.data?.issues)) throw new Error('Invalid Jira response');
        const feed = response.data.issues.filter(issue => typeof issue?.key === 'string' &&
          typeof issue.fields?.summary === 'string' && Number.isFinite(Date.parse(issue.fields.updated)))
          .map(issue => ({
            id: issue.key, platform: 'Jira', type: 'TICKET_UPDATE',
            user: typeof issue.fields.creator?.displayName === 'string' ? issue.fields.creator.displayName : 'Team Member',
            message: `Updated ticket: ${issue.fields.summary}`, timestamp: issue.fields.updated,
            url: `${origin}/browse/${encodeURIComponent(issue.key)}`, status: issue.fields.status?.name || 'Unknown'
          }));
        systemHealth.jira = 'Operational';
        return feed;
      } catch {
        return [];
      }
    })()
  ]);
  const omniFeed = [...githubFeed, ...jiraFeed].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  res.json({ success: true, omniFeed, systemHealth });
});

router.get('/links', (req, res) => {
  const frontendRepository = process.env.GITHUB_FRONTEND_REPO?.trim();
  const backendRepository = process.env.GITHUB_BACKEND_REPO?.trim();
  res.json({
    success: true,
    links: {
      githubFrontend: validRepository(frontendRepository) ? `https://github.com/${frontendRepository}` : null,
      githubBackend: validRepository(backendRepository) ? `https://github.com/${backendRepository}` : null,
      jiraBoard: jiraOrigin(),
      webexWorkspace: process.env.WEBEX_WORKSPACE?.trim()
        ? `https://web.webex.com/meetings/${encodeURIComponent(process.env.WEBEX_WORKSPACE.trim())}` : null
    }
  });
});

module.exports = router;
