# Tremendous Webhook Gateway

Cloudflare Worker that receives Tremendous webhooks, verifies the HMAC signature against the exact raw request body, persists events in a SQLite-backed Durable Object, deduplicates deliveries, and optionally forwards events asynchronously to an upstream endpoint.

> This service is a notification gateway only. It does not create Tremendous orders, issue rewards, process customer payments, or change Tremendous eligibility, geographic, or business restrictions.

## Zero-resource-provisioning architecture

```text
Tremendous
   | HTTPS POST + Tremendous-Webhook-Signature
   v
Cloudflare Worker (notify.roshava.app)
   | verify HMAC and payload
   v
SQLite Durable Object (created automatically by Wrangler migration)
   | persistent event log + alarm-based retries
   v
Optional signed upstream endpoint
```

There is no manually-created D1 database, Queue, or dead-letter Queue. The Durable Object SQLite namespace is declared in Wrangler and provisioned by Cloudflare on the first deployment.

A separate hostname is a deployment choice, not a way to conceal business activity or bypass provider terms, sanctions, recipient restrictions, or compliance review.

## Features

- HMAC-SHA256 verification using the exact raw body and Tremendous signature header.
- UUID-based idempotency and duplicate delivery handling.
- SQLite-backed Durable Object persistence; no external database setup.
- Alarm-based asynchronous forwarding with exponential retry and a 12-attempt ceiling.
- Admin-only event listing and replay endpoints.
- Bounded payload size, safe errors, and scheduled 90-day retention cleanup.
- Cloudflare Workers Builds deploys every push to the connected production branch.
- Build-time type-checking and test execution before each production deployment.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/healthz` | Health check |
| POST | `/webhook` | Tremendous webhook receiver |
| POST | `/tremendous/webhook` | Receiver alias |
| GET | `/admin/events?limit=50&status=FAILED` | List event metadata |
| POST | `/admin/events/{uuid}/replay` | Replay an event |

Admin endpoints require `Authorization: Bearer <GATEWAY_ADMIN_TOKEN>`. The event list never returns raw webhook bodies.

## Cloudflare Workers Builds configuration

Connect this repository to the Worker named `tremendous-webhook-gateway` and configure the production trigger as follows:

| Cloudflare setting | Value |
| --- | --- |
| Git repository | `paliparsa/TREMENDOUS-WEBHOOK-GATEWAY` |
| Production branch | `main` |
| Root directory | `/` (repository root) |
| Build command | `npm run check` |
| Deploy command | `npm run deploy` |
| Preview command (optional) | Leave the Cloudflare default, or use `npx wrangler versions upload` for preview versions |

Cloudflare Workers Builds installs the dependencies from `package.json`. The build command runs:

- `npm run typecheck` — TypeScript validation (`tsc --noEmit`).
- `npm test` — Vitest test suite.

The deploy command runs the package script `wrangler deploy`. Wrangler bundles `src/index.ts` and deploys the Worker using `wrangler.toml`; this project does not need a separate frontend build or generated output directory.

Every push to `main` triggers validation and, if validation succeeds, deployment. No GitHub Actions Cloudflare token, Cloudflare account ID variable, manually-created D1 database, or Queue is required. Workers Builds manages its own Cloudflare deployment authorization by default.

The `notify.roshava.app` Custom Domain is declared in `wrangler.toml`. On first deployment Wrangler asks Cloudflare to attach it and create the DNS/certificate configuration. The `roshava.app` zone must be active in this same Cloudflare account, and the hostname must not already have a conflicting DNS record or Custom Domain.

## Runtime secrets

In Cloudflare Dashboard, open:

**Workers & Pages → tremendous-webhook-gateway → Settings → Variables and Secrets**

Add both values as type **Secret**:

| Name | Value |
| --- | --- |
| `TREMENDOUS_WEBHOOK_SECRET` | Tremendous webhook `private_key` |
| `GATEWAY_ADMIN_TOKEN` | A random 32-byte token you generate |

To generate the admin token in Windows PowerShell:

```powershell
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
-join ($bytes | ForEach-Object { $_.ToString("x2") })
```

Or on macOS/Linux:

```bash
openssl rand -hex 32
```

Paste the resulting 64-character value as `GATEWAY_ADMIN_TOKEN`. It is not supplied by Tremendous or Cloudflare. Anyone who obtains it can access admin event operations. Keep it private.

After adding or changing runtime secrets, deploy the Worker if Cloudflare prompts you to do so. Secrets remain attached to the Worker across code deployments. Do not put runtime secrets in Workers Builds build variables; use **Settings → Variables and Secrets**.

## First deployment and webhook registration

After the first successful deployment, open:

```text
https://notify.roshava.app/healthz
```

Then configure this URL in Tremendous:

```text
https://notify.roshava.app/webhook
```

Tremendous organizations support one webhook endpoint. Check whether an existing webhook is in use before replacing it. Save the displayed webhook `private_key` as `TREMENDOUS_WEBHOOK_SECRET`.

## Optional upstream forwarding

The VisaPrepaidPlatform receiver is `POST https://YOUR_MAIN_APP_HOST/api/internal/webhooks/tremendous`. It verifies the exact raw request body using HMAC-SHA256 and requires `Idempotency-Key` to match the Tremendous webhook UUID. The receiver is implemented on the main Worker and stores provider events before acknowledging them.

Add these as Worker Secrets in Cloudflare after the main application has deployed its receiver and migration:

- `UPSTREAM_URL`: `https://YOUR_MAIN_APP_HOST/api/internal/webhooks/tremendous` (replace with the actual public origin of VisaPrepaidPlatform).
- `UPSTREAM_SECRET`: shared HMAC secret of at least 32 characters; it must exactly match `GATEWAY_SHARED_SECRET` on VisaPrepaidPlatform.

If upstream settings are absent, events are durably stored and marked `IGNORED`; they are not forwarded. Once upstream is configured, replay stored events through the admin endpoint. The main application correlates `ORDERS.*` events by Tremendous order ID against an existing issuance record; other event types are retained as ignored and unmatched order IDs are retained for review.

## Admin operations

List latest events:

```bash
curl -H "Authorization: Bearer $GATEWAY_ADMIN_TOKEN" \
  "https://notify.roshava.app/admin/events?limit=50"
```

Replay an event:

```bash
curl -X POST \
  -H "Authorization: Bearer $GATEWAY_ADMIN_TOKEN" \
  "https://notify.roshava.app/admin/events/EVENT_UUID/replay"
```

## Local development

Create an untracked `.dev.vars` file:

```dotenv
TREMENDOUS_WEBHOOK_SECRET=local-test-secret
GATEWAY_ADMIN_TOKEN=local-admin-token
```

Then run:

```bash
npm install
npm run dev
```

Run the same validation used by Cloudflare before submitting changes:

```bash
npm run check
```

## Latest changes

### 2.0.3

- Fixed deployment rejection caused by a compatibility date one day ahead of Cloudflare's API date; set `compatibility_date` to `2026-10-30`.

### 2.0.2

- Fixed the TypeScript build error from Cloudflare Workers v5: SQLite query row types now satisfy `Record<string, SqlStorageValue>` while retaining strict field types.
- No `any` casts or relaxed compiler settings were introduced.

### 2.0.1

- Fixed the npm `ETARGET` installation failure by updating `@cloudflare/workers-types` to the published `^5.20261030.1` release.
- Closed five superseded Dependabot pull requests after reviewing their proposed dependency updates; unnecessary major upgrades to TypeScript and Vitest were not adopted.
- Documented the exact Cloudflare Workers Builds validation and deployment commands.
- Kept the existing TypeScript and Vitest major versions unchanged.

### 2.0.0

- Replaced manually provisioned D1 and Queues with SQLite-backed Durable Object storage and alarm-based retries.
- Provisioned the Durable Object namespace through Wrangler on first deployment.
- Declared `notify.roshava.app` as a Wrangler Custom Domain.
- Aligned deployment with Cloudflare Workers Builds Git integration; removed the separate Cloudflare API-token GitHub deployment path.
- Reduced initial runtime configuration to two Worker secrets: `TREMENDOUS_WEBHOOK_SECRET` and `GATEWAY_ADMIN_TOKEN`.

## Security and operational notes

- Signature verification happens before JSON parsing and uses the exact raw request body.
- Never commit secrets or expose them in frontend code, URLs, logs, or public issues.
- Restrict Worker settings access; rotate secrets if exposed.
- HTTP 200 means durably accepted, not that a reward was delivered or redeemed.
- LINK reward delivery/redemption must not be inferred from webhook receipt.
- This project does not automate provider dashboard login, customer onboarding, payment collection, reward issuance, or eligibility checks.
- Obtain written approval for the exact business model and recipient markets before operational use.

## License

Private project. All rights reserved.
