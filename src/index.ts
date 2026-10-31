import { adminHtml } from "./admin";
import { constantTimeEqual, hmacSha256Hex, verifyHmacSha256 } from "./security";

export interface Env {
  WEBHOOK_STORE: DurableObjectNamespace;
  TREMENDOUS_WEBHOOK_SECRET?: string;
  GATEWAY_ADMIN_TOKEN?: string;
  UPSTREAM_URL?: string;
  UPSTREAM_SECRET?: string;
  MAX_BODY_BYTES?: string;
}

interface TremendousPayload {
  uuid?: string;
  event?: string;
  created_utc?: string;
  payload?: { resource?: { id?: string; type?: string } };
}

interface StoredEvent extends Record<string, SqlStorageValue> {
  event_uuid: string;
  event_type: string;
  resource_type: string | null;
  resource_id: string | null;
  created_utc: string | null;
  received_at: string;
  raw_body: string;
  processing_status: string;
  attempt_count: number;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function readBodyLimited(request: Request, maxBytes: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function store(env: Env): DurableObjectStub {
  const id = env.WEBHOOK_STORE.idFromName("tremendous-webhook-events");
  return env.WEBHOOK_STORE.get(id);
}

async function callStore(env: Env, path: string, body?: unknown): Promise<Response> {
  const startedAt = Date.now();
  try {
    const namespace = env.WEBHOOK_STORE;
    if (!namespace) {
      console.error("Durable Object binding is missing", { path });
      return json({ error: "STORE_BINDING_MISSING" }, 503);
    }
    const id = namespace.idFromName("tremendous-webhook-events");
    console.info("Durable Object request dispatched", { path, objectId: id.toString() });
    const response = await namespace.get(id).fetch(new Request(`https://webhook-store.internal${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));
    console.info("Durable Object request completed", { path, status: response.status, elapsedMs: Date.now() - startedAt });
    return response;
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 240) : "UNKNOWN_STORE_ERROR";
    console.error("Durable Object request failed", { path, detail, elapsedMs: Date.now() - startedAt });
    return json({ error: "STORE_UNAVAILABLE", detail }, 503);
  }
}

function adminAuthError(request: Request, env: Env): string | null {
  const expected = env.GATEWAY_ADMIN_TOKEN;
  if (typeof expected !== "string" || expected.length === 0) return "ADMIN_TOKEN_NOT_CONFIGURED";
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return "MISSING_BEARER_TOKEN";
  // Trim accidental whitespace from dashboard/Cloudflare secret copy-paste.
  return constantTimeEqual(match[1].trim(), expected.trim()) ? null : "INVALID_ADMIN_TOKEN";
}

async function receiveWebhook(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);
  if (!env.TREMENDOUS_WEBHOOK_SECRET) return json({ error: "WEBHOOK_NOT_CONFIGURED" }, 503);

  const maxBytes = Math.max(1024, Number(env.MAX_BODY_BYTES ?? "262144") || 262144);
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > maxBytes) return json({ error: "PAYLOAD_TOO_LARGE" }, 413);

  const rawBody = await readBodyLimited(request, maxBytes);
  if (rawBody === null) return json({ error: "PAYLOAD_TOO_LARGE" }, 413);
  if (!(await verifyHmacSha256(
    env.TREMENDOUS_WEBHOOK_SECRET,
    rawBody,
    request.headers.get("Tremendous-Webhook-Signature") ?? "",
  ))) return json({ error: "INVALID_SIGNATURE" }, 401);

  let payload: TremendousPayload;
  try {
    payload = JSON.parse(rawBody) as TremendousPayload;
  } catch {
    return json({ error: "INVALID_JSON" }, 400);
  }

  const eventUuid = typeof payload.uuid === "string" ? payload.uuid.trim() : "";
  const eventType = typeof payload.event === "string" ? payload.event.trim() : "";
  if (!eventUuid || eventUuid.length > 200 || !eventType || eventType.length > 200) {
    return json({ error: "MISSING_EVENT_ID_OR_TYPE" }, 400);
  }

  const resource = payload.payload?.resource;
  const response = await callStore(env, "/ingest", {
    eventUuid,
    eventType,
    resourceType: resource?.type ?? null,
    resourceId: resource?.id ?? null,
    createdUtc: payload.created_utc ?? null,
    receivedAt: new Date().toISOString(),
    rawBody,
  });
  if (!response.ok) return json({ error: "EVENT_PERSISTENCE_FAILED" }, 503);
  return response;
}

async function handleAdmin(request: Request, env: Env): Promise<Response> {
  const authError = adminAuthError(request, env);
  if (authError) return json({ error: authError }, 401);
  const url = new URL(request.url);

  if (url.pathname === "/admin/events" && request.method === "GET") {
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? "50") || 50));
    const status = url.searchParams.get("status") ?? "";
    const allowed = new Set(["RECEIVED", "PROCESSING", "FORWARDED", "FAILED", "IGNORED"]);
    const query = new URLSearchParams({ limit: String(limit) });
    if (allowed.has(status)) query.set("status", status);
    return callStore(env, `/events?${query.toString()}`);
  }

  const detail = /^\/admin\/events\/([^/]+)$/.exec(url.pathname);
  if (detail && request.method === "GET") {
    return callStore(env, "/events/" + encodeURIComponent(decodeURIComponent(detail[1])));
  }

  const match = /^\/admin\/events\/([^/]+)\/replay$/.exec(url.pathname);
  if (match && request.method === "POST") {
    return callStore(env, `/events/${encodeURIComponent(decodeURIComponent(match[1]))}/replay`, {});
  }
  return json({ error: "NOT_FOUND" }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/admin" || url.pathname === "/admin/") {
      if (request.method !== "GET") return json({ error: "METHOD_NOT_ALLOWED" }, 405);
      return new Response(adminHtml, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "x-frame-options": "DENY",
        },
      });
    }
    if (url.pathname === "/healthz" && request.method === "GET") {
      return json({ ok: true, service: "tremendous-webhook-gateway", storage: "durable-object-sqlite" });
    }
    if (url.pathname === "/webhook" || url.pathname === "/tremendous/webhook") {
      return receiveWebhook(request, env);
    }
    if (url.pathname.startsWith("/admin/")) return handleAdmin(request, env);
    return json({ error: "NOT_FOUND" }, 404);
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await callStore(env, "/prune", {});
  },
};

export class WebhookStore {
  private readonly sql: SqlStorage;

  constructor(private readonly ctx: DurableObjectState, private readonly env: Env) {
    this.sql = ctx.storage.sql;
    // Initialize SQLite schema behind the Durable Object input gate.
    // This prevents fetch/alarm events from racing first-time schema setup.
    ctx.blockConcurrencyWhile(async () => {
      try {
        this.sql.exec(`
          CREATE TABLE IF NOT EXISTS webhook_events (
            event_uuid TEXT PRIMARY KEY,
            event_type TEXT NOT NULL,
            resource_type TEXT,
            resource_id TEXT,
            created_utc TEXT,
            received_at TEXT NOT NULL,
            raw_body TEXT NOT NULL,
            processing_status TEXT NOT NULL DEFAULT 'RECEIVED'
              CHECK (processing_status IN ('RECEIVED','PROCESSING','FORWARDED','FAILED','IGNORED')),
            attempt_count INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            forwarded_at TEXT
          )
        `);
        this.sql.exec("CREATE INDEX IF NOT EXISTS idx_events_status_received ON webhook_events(processing_status, received_at DESC)");
      } catch (error) {
        console.error("WebhookStore SQLite initialization failed", error);
        throw error;
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    console.info("WebhookStore fetch started", { path: url.pathname, method: request.method });
    if (url.pathname === "/ingest" && request.method === "POST") {
      const event = await request.json() as {
        eventUuid: string; eventType: string; resourceType: string | null;
        resourceId: string | null; createdUtc: string | null; receivedAt: string; rawBody: string;
      };
      const existing = this.sql.exec<{ processing_status: string }>(
        "SELECT processing_status FROM webhook_events WHERE event_uuid = ?", event.eventUuid,
      ).toArray()[0];
      if (existing) return json({ received: true, duplicate: true });
      this.sql.exec(
        `INSERT INTO webhook_events
          (event_uuid,event_type,resource_type,resource_id,created_utc,received_at,raw_body,processing_status)
         VALUES (?,?,?,?,?,?,?,'RECEIVED')`,
        event.eventUuid, event.eventType, event.resourceType, event.resourceId,
        event.createdUtc, event.receivedAt, event.rawBody,
      );
      await this.ctx.storage.setAlarm(Date.now() + 1000);
      return json({ received: true, duplicate: false });
    }

    if (url.pathname === "/events" && request.method === "GET") {
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? "50") || 50));
      const status = url.searchParams.get("status");
      const allowed = new Set(["RECEIVED", "PROCESSING", "FORWARDED", "FAILED", "IGNORED"]);
      const rows = status && allowed.has(status)
        ? this.sql.exec(
            `SELECT event_uuid,event_type,resource_type,resource_id,created_utc,received_at,
                    processing_status,attempt_count,last_error,forwarded_at
             FROM webhook_events WHERE processing_status = ? ORDER BY received_at DESC LIMIT ?`,
            status, limit,
          ).toArray()
        : this.sql.exec(
            `SELECT event_uuid,event_type,resource_type,resource_id,created_utc,received_at,
                    processing_status,attempt_count,last_error,forwarded_at
             FROM webhook_events ORDER BY received_at DESC LIMIT ?`,
            limit,
          ).toArray();
      return json({ events: rows, count: rows.length });
    }

    const detail = /^\/events\/([^/]+)$/.exec(url.pathname);
    if (detail && request.method === "GET") {
      const eventUuid = decodeURIComponent(detail[1]);
      const event = this.sql.exec(
        "SELECT event_uuid,event_type,resource_type,resource_id,created_utc,received_at,raw_body,processing_status,attempt_count,last_error,forwarded_at FROM webhook_events WHERE event_uuid = ?",
        eventUuid,
      ).toArray()[0];
      if (!event) return json({ error: "EVENT_NOT_FOUND" }, 404);
      return json({ event });
    }

    const replay = /^\/events\/([^/]+)\/replay$/.exec(url.pathname);
    if (replay && request.method === "POST") {
      const eventUuid = decodeURIComponent(replay[1]);
      const result = this.sql.exec(
        "UPDATE webhook_events SET processing_status='RECEIVED',last_error=NULL WHERE event_uuid=?",
        eventUuid,
      );
      if (result.rowsWritten === 0) return json({ error: "EVENT_NOT_FOUND" }, 404);
      await this.ctx.storage.setAlarm(Date.now() + 1000);
      return json({ queued: true });
    }

    if (url.pathname === "/prune" && request.method === "POST") {
      this.sql.exec(
        "DELETE FROM webhook_events WHERE received_at < datetime('now','-90 days') AND processing_status IN ('FORWARDED','IGNORED')",
      );
      return json({ pruned: true });
    }
    return json({ error: "NOT_FOUND" }, 404);
  }

  async alarm(): Promise<void> {
    const pending = this.sql.exec<StoredEvent>(
      `SELECT event_uuid,event_type,resource_type,resource_id,created_utc,received_at,raw_body,
              processing_status,attempt_count
       FROM webhook_events
       WHERE processing_status IN ('RECEIVED','FAILED','PROCESSING')
       ORDER BY received_at ASC LIMIT 20`,
    ).toArray();

    let retryAt: number | null = null;
    for (const event of pending) {
      if (!this.env.UPSTREAM_URL || !this.env.UPSTREAM_SECRET) {
        this.sql.exec(
          "UPDATE webhook_events SET processing_status='IGNORED',last_error='UPSTREAM_NOT_CONFIGURED' WHERE event_uuid=?",
          event.event_uuid,
        );
        continue;
      }
      if (event.attempt_count >= 12) {
        this.sql.exec(
          "UPDATE webhook_events SET processing_status='FAILED',last_error='MAX_ATTEMPTS_EXCEEDED' WHERE event_uuid=?",
          event.event_uuid,
        );
        continue;
      }

      this.sql.exec(
        "UPDATE webhook_events SET processing_status='PROCESSING' WHERE event_uuid=?",
        event.event_uuid,
      );
      try {
        const upstream = new URL(this.env.UPSTREAM_URL);
        if (upstream.protocol !== "https:") throw new Error("UPSTREAM_MUST_USE_HTTPS");
        const signature = await hmacSha256Hex(this.env.UPSTREAM_SECRET, event.raw_body);
        const response = await fetch(upstream.toString(), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Tremendous-Gateway-Signature": `sha256=${signature}`,
            "Idempotency-Key": event.event_uuid,
            "X-Tremendous-Event-Id": event.event_uuid,
          },
          body: event.raw_body,
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw new Error(`UPSTREAM_HTTP_${response.status}`);
        this.sql.exec(
          "UPDATE webhook_events SET processing_status='FORWARDED',forwarded_at=?,last_error=NULL,attempt_count=attempt_count+1 WHERE event_uuid=?",
          new Date().toISOString(), event.event_uuid,
        );
      } catch (error) {
        const attempts = event.attempt_count + 1;
        const reason = error instanceof Error ? error.message.slice(0, 300) : "UNKNOWN_PROCESSING_ERROR";
        this.sql.exec(
          "UPDATE webhook_events SET processing_status='FAILED',last_error=?,attempt_count=? WHERE event_uuid=?",
          reason, attempts, event.event_uuid,
        );
        if (attempts < 12) {
          const delay = Math.min(60 * 60 * 1000, 30_000 * (2 ** Math.min(attempts - 1, 7)));
          retryAt = Math.min(retryAt ?? Number.MAX_SAFE_INTEGER, Date.now() + delay);
        }
      }
    }

    const remaining = this.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM webhook_events WHERE processing_status='RECEIVED'",
    ).toArray()[0]?.count ?? 0;
    if (remaining > 0) retryAt = Math.min(retryAt ?? Number.MAX_SAFE_INTEGER, Date.now() + 1000);
    if (retryAt !== null) await this.ctx.storage.setAlarm(retryAt);
  }
}
