# Changelog

## 2.0.2

- Fix the Cloudflare Workers v5 SQLite query generic constraint by declaring the stored event row as a `Record<string, SqlStorageValue>`.
- Keep the row fields strongly typed without using `any` or weakening TypeScript strictness.


## 2.0.1

- Fix npm installation by replacing the unpublished Cloudflare Workers types v4 range with the published v5.20261030.1 release.
- Close superseded Dependabot pull requests after applying the required dependency fix directly.

## 2.0.0

- Replace manually provisioned D1 and Queues with SQLite-backed Durable Object storage and alarm-based retries.
- Provision the Durable Object namespace through Wrangler on first deployment.
- Declare `notify.roshava.app` as a Wrangler Custom Domain.
- Align deployment with Cloudflare Workers Builds Git integration; remove the separate Cloudflare API-token GitHub deployment path.
- Reduce initial runtime configuration to two Worker secrets: `TREMENDOUS_WEBHOOK_SECRET` and `GATEWAY_ADMIN_TOKEN`.

## 1.1.0

- Added GitHub Actions bootstrap workflow for D1/Queues and manual Cloudflare deployment.

## 1.0.0

- Initial webhook gateway with HMAC verification, D1 persistence, queue processing, optional signed upstream forwarding, admin event listing/replay, and scheduled retention cleanup.
