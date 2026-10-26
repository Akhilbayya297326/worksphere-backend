# WorkSphere Backend

Express, MongoDB/Mongoose, and Socket.IO API for WorkSphere projects, talent, chat, uploads, and AI-assisted workflows.

## Run locally

Requires Node.js 24, npm, and a reachable MongoDB database.

1. Run `npm ci`.
2. Copy `.env.example` to `.env` and configure the values below.
3. Run `npm run doctor` to check configuration and MongoDB access.
4. Run `npm start`, or `npm run dev` for automatic restarts during development.

The default port is `5000`. Startup waits for MongoDB and exits with an error if the database connection or HTTP listener fails. Uploaded files and suggested patches use `UPLOAD_DIR` when configured, otherwise the local `uploads/` directory. Use persistent storage for this directory when hosting.

## Deploy to Render

The root `render.yaml` configures a Free Node web service with `npm ci --omit=dev`, `npm start`, and `/api/health/ready`. Leave the hosting Root Directory empty because this repository already contains the backend at its root. Supply MongoDB and CORS settings through Render; secrets are not stored in the Blueprint. Follow [DEPLOYMENT.md](DEPLOYMENT.md) for the Render/Vercel setup and storage limits.

## Environment

Use `.env.example` as the configuration template. Keep `.env` and real credentials outside Git.

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP and Socket.IO port; defaults to `5000`. |
| `MONGO_URI` | MongoDB connection string; defaults to the local `worksphere` database. |
| `DB_CONNECT_TIMEOUT_MS` | Startup connection deadline; defaults to `5000`. |
| `CORS_ORIGINS` | Comma-separated allowed browser origins. Configure the deployed frontend origin explicitly. |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | Optional AI provider credentials and model. |
| `AI_REQUEST_TIMEOUT_MS` | AI request deadline; defaults to `30000`. |
| `GITHUB_TOKEN` | Optional token with read access for the GitHub feed. |
| `GITHUB_FRONTEND_REPO`, `GITHUB_BACKEND_REPO` | Repository names in `owner/repository` format. The feed reads frontend commits; both values provide repository links. |
| `JIRA_DOMAIN`, `JIRA_EMAIL`, `JIRA_API_TOKEN` | Optional Jira site origin and account credentials; all three are required together. |
| `WEBEX_WORKSPACE` | Optional Webex meeting/workspace link value. |

If `CORS_ORIGINS` is omitted, the server allows all origins. CORS configuration does not authenticate users.

## Verify and troubleshoot

```sh
npm test
npm run doctor
npm run doctor -- --services
```

The tests use isolated storage/provider substitutes and do not establish that live services work. The doctor performs a bounded MongoDB ping. `--services` also reads Gemini model metadata, GitHub account access, and Jira account access for configured providers. Diagnostics do not seed data, create indexes, generate AI content, or write to remote services, and print sanitized results. A failed check returns a nonzero exit code.

Check `GET /api/health/live` for process liveness and `GET /api/health/ready` for database readiness. Database-dependent requests return `503` during a disconnect. For MongoDB SRV failures, verify DNS resolution, network/firewall access, the Atlas IP access list, and the connection string. For integration failures, verify provider credentials and repository/site access, then rerun the doctor.

`seed.js` deletes all existing employee records and inserts demonstration profiles with shared passwords. Run it only against a disposable development database.

## Current limitations

- Authentication is a prototype: passwords are stored and compared without hashing, login does not issue a signed session, and manager checks trust a client-supplied role header. Routes and sockets need server-verified authentication and authorization before production use. New employees receive a shared default password.
- Knowledge and codebase answers use labelled sample context. Vault analysis reads filenames and project context, not uploaded document contents. ROI figures are demonstration data.
- Deployment and repository diagnostics return `501` until real runners/connectors are implemented. Saved AI patches are vault artifacts for review; they do not modify repositories or execute code.
- Webex and Confluence are not monitored. GitHub and Jira feed availability depends on valid configuration and provider access. AI generation additionally depends on model access and quota; metadata checks do not verify generation.
