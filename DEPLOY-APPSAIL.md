# AppSail deploy and environment variables

## Why dashboard values disappear

`catalyst deploy` uploads **`app-config.json`** → `env_variables` to AppSail. That **replaces** what you set in the Catalyst console. If `app-config.json` has `PAYSTACK_SECRET_KEY: ""`, Paystack stops working after every deploy.

## Recommended workflow

1. Keep real secrets only in **`backend/.env`** (gitignored), not in `app-config.json`.
2. From `backend/`, deploy with:
   ```bash
   npm run deploy
   ```
   - **predeploy** (in `app-config.json`): copies secrets from `.env` into `app-config.json`
   - **catalyst deploy**: ships code + full env to AppSail
   - **deploy:strip**: removes secrets from `app-config.json` again so you do not commit them

3. Or run `catalyst deploy` alone — **predeploy still runs** and injects from `.env` before upload.

You do **not** need to re-enter Paystack/SMTP/JWT in the AppSail console on every deploy if `.env` has them.

## Optional: console-only secrets

If you prefer secrets **only** in the Catalyst UI:

- Remove secret keys from `app-config.json` entirely (already done for JWT, Paystack, SMTP password).
- Remove or disable `scripts.predeploy` in `app-config.json` so deploy does not push empty overrides.

Note: any key still present in `app-config.json` on deploy will overwrite the console value for that key.

## Live URLs vs local `.env`

`PORTAL_BASE_URL` and `API_PUBLIC_URL` in `app-config.json` point at **Slate / AppSail**. Local `.env` may still use `localhost` — that is fine for `npm run dev:node`. Deploy uses the URLs in `app-config.json` for those keys unless you also set them in `.env` (inject script only updates the keys listed in `scripts/inject-app-config-env.js`).
