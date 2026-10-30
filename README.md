# Tremendous Webhook Gateway

An isolated Cloudflare Worker for receiving Tremendous webhook notifications, verifying their HMAC signature, persisting events in D1, deduplicating deliveries, and forwarding accepted events asynchronously to an optional upstream endpoint.

> This service is a notification gateway only. It does not create Tremendous orders, issue rewards, process customer payments, or change Tremendous eligibility, geographic, or business restrictions.

## Architecture

```text
Tremendous
   | HTTPS POST + Tremendous-Webhook-Signature
   v
Cloudflare Worker (notify.roshava.app)
   | verify HMAC against exact raw request body
   | persist UUID with UNIQUE constraint in D1
   v
Cloudflare Queue -> optional signed upstream endpoint
```

A separate hostname is a deployment choice, not a way to conceal business activity or bypass provider terms, sanctions, recipient restrictions, or compliance review.

## Features

- HMAC-SHA256 verification using the exact raw body and Tremendous signature header.
- UUID-based idempotency and duplicate delivery handling.
- Durable D1 event store and Queue-based asynchronous processing.
- Optional signed forwarding to an upstream endpoint.
- Admin-only event listing and replay endpoints.
- Bounded payload size, safe errors, and scheduled pruning.
- GitHub Actions CI and one-click Cloudflare bootstrap/deploy workflow.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/healthz` | Health check |
| POST | `/webhook` | Tremendous webhook receiver |
| POST | `/tremendous/webhook` | Receiver alias |
| GET | `/admin/events?limit=50&status=FAILED` | List event metadata |
| POST | `/admin/events/{uuid}/replay` | Replay an event |

Admin endpoints require `Authorization: Bearer GATEWAY_ADMIN_TOKEN`. The event list does not return raw payloads.

## One-time GitHub setup

Open **Settings -> Secrets and variables -> Actions** in this repository.

### Repository secrets

Add these four secrets:

1. `CLOUDFLARE_API_TOKEN` — Cloudflare API token.
2. `TREMENDOUS_WEBHOOK_SECRET` — the webhook `private_key` shown by Tremendous.
3. `GATEWAY_ADMIN_TOKEN` — a random, private admin bearer token (generate one as described below).

### Repository variable

Add:

- `CLOUDFLARE_ACCOUNT_ID` — your Cloudflare account ID.

The Cloudflare API token needs account-level permissions to manage **D1: Edit**, **Queues: Edit**, and **Workers Scripts: Edit** for the intended account. Scope it to that account; do not use your Global API Key.

### Generate the admin token

On Windows PowerShell:

```powershell
[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLower()
```

Or on macOS/Linux:

```bash
openssl rand -hex 32
```

Copy the generated 64-character value into the GitHub secret `GATEWAY_ADMIN_TOKEN`. It is not supplied by Tremendous or Cloudflare. Keep it private; anyone who has it can access admin event operations. To rotate it, replace the GitHub secret and run the workflow again.

### Run bootstrap and deploy

Go to **Actions -> Bootstrap and deploy Cloudflare Gateway -> Run workflow**.

The workflow will:
1. Create the D1 database if it does not exist.
2. Create both Queues if they do not exist.
3. Apply D1 migrations.
4. Upload the two Worker secrets.
5. Deploy the Worker.

It is safe to rerun; resource creation is idempotent. The workflow does not configure a custom domain or register the webhook with Tremendous.

## After the first deploy

In Cloudflare, open the Worker and add the Custom Domain `notify.roshava.app`. Then check:

```text
https://notify.roshava.app/healthz
```

Once it responds successfully, configure this webhook URL in Tremendous:

```text
https://notify.roshava.app/webhook
```

Tremendous organizations support one webhook endpoint. Check whether an existing webhook is in use before replacing it. Save the displayed webhook `private_key` as the GitHub secret `TREMENDOUS_WEBHOOK_SECRET`, then rerun the workflow so it is uploaded to the Worker.

## Optional upstream forwarding

Do not configure upstream until the receiving endpoint in your main application has implemented HMAC verification and `Idempotency-Key` deduplication. Without upstream settings, events are stored but not forwarded.

## Local development

Create an untracked `.dev.vars` file:

```dotenv
TREMENDOUS_WEBHOOK_SECRET=local-test-secret
GATEWAY_ADMIN_TOKEN=local-admin-token
```

Then run `npm install` and `npm run dev`. Apply local migrations with:

```bash
npx wrangler d1 migrations apply tremendous-webhook-gateway --local
```

## Security and operational notes

- Signature verification happens before JSON parsing and uses the exact raw request body.
- Never commit secrets or expose them in frontend code, URLs, logs, or public issues.
- Restrict D1 and Worker settings access; rotate secrets if exposed.
- HTTP 200 means durably accepted, not that a reward was delivered or redeemed.
- LINK reward delivery/redemption must not be inferred from webhook receipt.
- This project does not automate provider dashboard login, customer onboarding, payment collection, reward issuance, or eligibility checks.
- Obtain written approval for the exact business model and recipient markets before operational use.

## License

Private project. All rights reserved.
