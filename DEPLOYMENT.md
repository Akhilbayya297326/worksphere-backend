# Backend on Render

Deploy this repository as a persistent Node web service; the separate frontend runs on Vercel. Node 24 is pinned in `.node-version` and `package.json`.

1. Open the [Render dashboard](https://dashboard.render.com/) and create a Blueprint from `Akhilbayya297326/worksphere-backend`, branch `main`. Review the root `render.yaml`. It selects a Free service in Singapore and does not create a paid database or disk.
2. Enter a working `MONGO_URI` for your MongoDB Atlas database. Configure Atlas network access for the Render service's outbound IP ranges and verify the database user's permissions. A localhost URI cannot reach your computer from Render. Existing employee accounts must be present; deployment does not seed the database.
3. Set `CORS_ORIGINS` to the exact Vercel HTTPS origin, without a trailing slash. If the Vercel URL is not known yet, update this setting after Vercel assigns its production domain. Multiple exact origins can be comma-separated. Wildcard preview-host patterns are not supported.
4. Add `GEMINI_API_KEY` only if using AI features. Optional GitHub/Jira settings are listed in `.env.example`; do not enter dummy credentials. `GITHUB_FRONTEND_REPO` and `GITHUB_BACKEND_REPO` are `Akhilbayya297326/worksphere-frontend` and `Akhilbayya297326/worksphere-backend` respectively.
5. Deploy, copy the actual `onrender.com` URL, and open `/api/health/ready`. HTTP 200 with `database: "connected"` is required for login and persistence. Startup exits if MongoDB cannot connect.
6. In Vercel, set `VITE_API_URL` to the Render URL plus `/api`, and `VITE_SOCKET_URL` to the same Render origin without `/api`. Deploy the frontend, then update Render's `CORS_ORIGINS` with its actual production origin and save.

For manual Web Service creation, leave Root Directory empty and use:

| Setting | Value |
| --- | --- |
| Repository | `Akhilbayya297326/worksphere-backend` |
| Branch | `main` |
| Runtime | Node |
| Build | `npm ci --omit=dev` |
| Start | `npm start` |
| Health check | `/api/health/ready` |
| Node | `24` |
| Environment | `NODE_ENV=production`, `DB_CONNECT_TIMEOUT_MS=15000`, plus your MongoDB/CORS settings |

Let Render assign `PORT`; the application reads it automatically. Keep `.env` files and secrets outside Git. The Blueprint prompts for secret/config values only on initial creation; add or change environment variables manually for an existing service.

## Storage and cold starts

Render Free sleeps after 15 minutes without inbound traffic and can take about a minute to wake. Retry the first request if it times out. Its local uploads are lost on restarts, redeploys, and spin-down. MongoDB metadata does not preserve the physical file bytes.

For durable uploads, use persistent storage. If you later attach a paid disk mounted at `/var/data`, set `UPLOAD_DIR=/var/data/uploads`. This Blueprint does not provision or purchase a disk. Keep the service on a single instance while using local disk storage.

## Verify and troubleshoot

Use Render deployment logs for startup errors. MongoDB failures require checking the URI, DNS, Atlas network access, and credentials; never publish full connection strings in logs or screenshots. `/api/health/live` checks process liveness, while `/api/health/ready` checks database readiness. Browser-only failures often indicate a mismatch between the Vercel origin and `CORS_ORIGINS`.

`npm test` runs isolated regression checks. `npm run doctor -- --services` performs read-only connectivity checks. Never run `seed.js` against an existing database: it deletes employee records. Authentication still needs signed sessions, server-verified authorization, and password hashing before using real production data.

References: [Render Express deployment](https://render.com/docs/deploy-node-express-app), [Blueprint specification](https://render.com/docs/blueprint-spec), [Node versions](https://render.com/docs/node-version), [Free limits](https://render.com/docs/free), [Persistent disks](https://render.com/docs/disks).
