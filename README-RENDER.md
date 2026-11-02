# JAI MARUTHI AUTOMATION Attendance — Render Deployment

## Deploy
1. Push this folder to GitHub. Do not commit `.env`, `node_modules`, or SQLite files.
2. In Render, choose **New → Web Service** (language **Node**, NOT Ruby) and connect the repository. The repo root must contain `server.js` and `package.json`.
3. Use:
   - Build command: `npm ci`
   - Start command: `npm start`
4. Add environment variables:
   - `SUPABASE_URL` = your Supabase project URL
   - `SUPABASE_SERVICE_ROLE_KEY` = your current server-side service-role key
   - `SESSION_SECRET` = a long random secret (Render can generate this)
   - `NODE_ENV` = `production`
   - `TZ` = `Asia/Kolkata` (so check-in times are in India time)
   - `DATA_DIR` = `./data`
5. Deploy. Health check: `/health`

## Security
The original uploaded project contained a Supabase service-role key. That key has been removed from this deployment package. Rotate/revoke the exposed key in Supabase and use the replacement key in Render Environment Variables.

## Supabase
Run `supabase-schema.sql` in the Supabase SQL Editor before first use if the database schema has not already been created.

## Note about sessions
The app currently uses SQLite for Express sessions. Render's normal filesystem is ephemeral, so active login sessions can be lost after a restart/redeploy. Attendance data remains in Supabase.


## Run locally
Copy `.env.example` to `.env`, fill the values, then `npm install` and `npm run local`.
