# Changelog

## 1.0.0 - 2026-10-31

- Initial isolated Cloudflare Worker webhook gateway.
- Added raw-body HMAC-SHA256 signature verification.
- Added D1 event persistence and UUID deduplication.
- Added Cloudflare Queue processing and optional signed upstream forwarding.
- Added protected event listing and replay endpoints.
- Added 90-day pruning for terminal event records.
- Added Wrangler configuration, migration, CI, and deployment workflow.
