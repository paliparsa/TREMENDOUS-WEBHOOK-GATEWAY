# Changelog

## 1.1.0

- Add one-click GitHub Actions workflow to provision D1 and Queues idempotently, apply migrations, upload Worker secrets, and deploy.
- Document Cloudflare token permissions, GitHub repository variables/secrets, and secure admin-token generation.
- Keep custom-domain attachment and Tremendous webhook registration as explicit post-deploy steps.

## 1.0.0

- Initial Cloudflare webhook gateway with HMAC verification, D1 persistence, queue processing, optional signed upstream forwarding, admin event listing/replay, and scheduled retention cleanup.
