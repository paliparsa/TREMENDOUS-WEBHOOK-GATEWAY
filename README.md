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
Cloudflare Queue
   | async, retryable delivery
   v
Optional upstream endpoint (your own application)
```

A separate hostname is a deployment choice, not a way to conceal business activity or bypass provider terms, sanctions, recipient restrictions, or compliance review.

## Features

- HMAC-SHA256 verification using the exact raw body and Tremendous signature header.
- UUID-based idempotency and duplicate delivery handling.
- Durable D1 event store with resource identifiers and processing state.
- Queue-based asynchronous forwarding; the webhook receiver responds quickly.
- Signed gateway-to-upstream requests and an idempotency header.
- Admin-only event listing and replay endpoints.
- Bounded payload size, no-store responses, safe error messages.
- Scheduled pruning of terminal event records after 90 days.
- GitHub Actions CI and Cloudflare deploy workflow.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/healthz` | Basic health check |
| POST | `/webhook` | Tremendous webhook receiver |
| POST | `/tremendous/webhook` | Alias for receiver |
| GET | `/admin/events?limit=50&status=FAILED` | List event metadata (Bearer admin token) |
| POST | `/admin/events/{uuid}/replay` | Requeue an event (Bearer admin token) |

The admin event list never returns the raw webhook body. Raw payloads are retained in D1 to support controlled processing/replay and may contain personal data. Restrict D1 access.

## 1. Cloudflare bootstrap

Prerequisites: Node.js 20+, npm, Wrangler authenticated to the intended Cloudflare account.

```bash
npm ci
npx wrangler d1 create tremendous-webhook-gateway
npx wrangler queues create tremendous-webhook-events
npx wrangler queues create tremendous-webhook-events-dlq
```

Copy the D1 `database_id` returned by Wrangler into `wrangler.toml`, replacing `REPLACE_WITH_D1_DATABASE_ID`.

Apply the migration:

```bash
npx wrangler d1 migrations apply tremendous-webhook-gateway --remote
```

Set Worker secrets (never commit them):

```bash
openssl rand -hex 32
npx wrangler secret put TREMENDOUS_WEBHOOK_SECRET
openssl rand -hex 32
npx wrangler secret put GATEWAY_ADMIN_TOKEN
```

Paste the Tremendous webhook `private_key` as `TREMENDOUS_WEBHOOK_SECRET`. Use a different random value for `GATEWAY_ADMIN_TOKEN`.

Optional upstream forwarding, only after your receiving application has implemented and secured the endpoint:

```bash
npx wrangler secret put UPSTREAM_SECRET
npx wrangler secret put UPSTREAM_URL
```

- `UPSTREAM_URL`: exact HTTPS endpoint on your own application.
- `UPSTREAM_SECRET`: shared secret used to sign the exact forwarded body with HMAC-SHA256.
- The receiver must verify `X-Tremendous-Gateway-Signature: sha256=<hex>` and deduplicate `Idempotency-Key`.

If upstream settings are absent, events are stored and marked `IGNORED`; they are not forwarded. Configure upstream first, then replay stored events.

## 2. Deploy

```bash
npm run typecheck
npm test
npx wrangler deploy
```

After deployment, add `notify.roshava.app` as a Worker Custom Domain in Cloudflare. The Worker custom domain must be attached to this Worker; a DNS record alone is insufficient.

Use this Tremendous endpoint URL:

```text
https://notify.roshava.app/webhook
```

The code also accepts `/tremendous/webhook`.

## 3. Configure Tremendous

Tremendous organizations support one webhook endpoint. Before saving a new endpoint, inspect the organization's existing webhook configuration so you do not replace an endpoint used by another integration.

Set the endpoint URL in the Tremendous dashboard if your account provides manual configuration. Save the returned webhook private key immediately as the Worker secret `TREMENDOUS_WEBHOOK_SECRET`. Never put it in frontend code, Git, a URL, or a public issue.

Receiving webhook POSTs does not require a Tremendous API key. Creating or managing webhook configuration through Tremendous's API is a separate operation and requires API credentials.

## 4. Admin operations

```bash
curl -H "Authorization: Bearer $GATEWAY_ADMIN_TOKEN" \
  "https://notify.roshava.app/admin/events?limit=50"

curl -X POST \
  -H "Authorization: Bearer $GATEWAY_ADMIN_TOKEN" \
  "https://notify.roshava.app/admin/events/EVENT_UUID/replay"
```

The downstream application must also deduplicate using `Idempotency-Key`.

## 5. GitHub Actions deployment

Configure repository secret `CLOUDFLARE_API_TOKEN` with the least permissions needed for this Worker deployment, and repository variable `CLOUDFLARE_ACCOUNT_ID`.

The deploy workflow runs on pushes to `main` and can also be started manually. It deploys code only; D1/Queue creation, secrets, and custom-domain setup are one-time Cloudflare tasks.

## Local development

Create an untracked `.dev.vars` file:

```dotenv
TREMENDOUS_WEBHOOK_SECRET=local-test-secret
GATEWAY_ADMIN_TOKEN=local-admin-token
```

Then run `npm run dev`. Apply local D1 migrations with:

```bash
npx wrangler d1 migrations apply tremendous-webhook-gateway --local
```

## Security and operational notes

- Signature verification is mandatory and happens before JSON parsing.
- Do not log raw request bodies or secrets.
- Restrict D1 and Worker settings access; rotate secrets if exposed.
- Set upstream only to an HTTPS endpoint you control.
- HTTP 200 means durably accepted, not that a reward was delivered or redeemed.
- LINK reward delivery/redemption must not be inferred from webhook receipt.
- This project does not automate provider dashboard login, customer onboarding, payment collection, reward issuance, or eligibility checks.
- Follow current Tremendous terms and obtain written approval for the exact business model and recipient markets before operational use.

## License

Private project. All rights reserved.
