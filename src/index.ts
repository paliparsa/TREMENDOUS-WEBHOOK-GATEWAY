import { constantTimeEqual, hmacSha256Hex, verifyHmacSha256 } from "./security";

export interface Env {
  DB: D1Database;
  EVENT_QUEUE: Queue<QueueMessage>;
  TREMENDOUS_WEBHOOK_SECRET?: string;
  GATEWAY_ADMIN_TOKEN?: string;
  UPSTREAM_URL?: string;
  UPSTREAM_SECRET?: string;
  MAX_BODY_BYTES?: string;
}

interface QueueMessage {
  eventUuid: string;
}

interface TremendousPayload {
  uuid?: string;
  event?: string;
  created_utc?: string;
  payload?: {
    resource?: {
      id?: string;
      type?: string;
    };
  };
}

const encoder = new TextEncoder();

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function verifyTremendousSignature(request: Request, rawBody: string, secret: string): Promise<boolean> {
  return verifyHmacSha256(
    secret,
    rawBody,
    request.headers.get("Tremendous-Webhook-Signature") ?? "",
  );
}

async function authenticateAdmin(request: Request, env: Env): Promise<boolean> {
  const expected = env.GATEWAY_ADMIN_TOKEN;
  const header = request.headers.get("authorization") ?? "";
  if (!expected || !header.startsWith("Bearer ")) return false;
  return constantTimeEqual(header.slice(7), expected);
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

async function receiveWebhook(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);
  if (!env.TREMENDOUS_WEBHOOK_SECRET) return json({ error: "WEBHOOK_NOT_CONFIGURED" }, 503);

  const maxBytes = Math.max(1024, Number(env.MAX_BODY_BYTES ?? "262144") || 262144);
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > maxBytes) return json({ error: "PAYLOAD_TOO_LARGE" }, 413);

  const rawBody = await readBodyLimited(request, maxBytes);
  if (rawBody === null) return json({ error: "PAYLOAD_TOO_LARGE" }, 413);
  if (!(await verifyTremendousSignature(request, rawBody, env.TREMENDOUS_WEBHOOK_SECRET))) {
    return json({ error: "INVALID_SIGNATURE" }, 401);
  }

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

  const receivedAt = new Date().toISOString();
  const resource = payload.payload?.resource;
  await env.DB.prepare(
    `INSERT INTO webhook_events
      (event_uuid, event_type, resource_type, resource_id, created_utc, received_at, raw_body, processing_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'RECEIVED')
     ON CONFLICT(event_uuid) DO NOTHING`,
  ).bind(
    eventUuid,
    eventType,
    resource?.type ?? null,
    resource?.id ?? null,
    payload.created_utc ?? null,
    receivedAt,
    rawBody,
  ).run();

  const existing = await env.DB.prepare(
    "SELECT processing_status FROM webhook_events WHERE event_uuid = ?",
  ).bind(eventUuid).first<{ processing_status: string }>();

  if (!existing) return json({ error: "EVENT_PERSISTENCE_FAILED" }, 503);
  if (["QUEUED", "FORWARDED", "IGNORED"].includes(existing.processing_status)) {
    return json({ received: true, duplicate: true });
  }

  try {
    await env.EVENT_QUEUE.send({ eventUuid });
    await env.DB.prepare(
      "UPDATE webhook_events SET processing_status = 'QUEUED', last_error = NULL WHERE event_uuid = ?",
    ).bind(eventUuid).run();
  } catch {
    await env.DB.prepare(
      "UPDATE webhook_events SET processing_status = 'FAILED', last_error = 'QUEUE_ENQUEUE_FAILED' WHERE event_uuid = ?",
    ).bind(eventUuid).run();
    return json({ error: "QUEUE_UNAVAILABLE" }, 503);
  }

  return json({ received: true, duplicate: false });
}

async function listEvents(request: Request, env: Env): Promise<Response> {
  if (!(await authenticateAdmin(request, env))) return json({ error: "UNAUTHORIZED" }, 401);
  const url = new URL(request.url);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? "50") || 50));
  const status = url.searchParams.get("status");
  const allowed = new Set(["RECEIVED", "QUEUED", "FORWARDED", "FAILED", "IGNORED"]);
  const result = status && allowed.has(status)
    ? await env.DB.prepare(
        `SELECT event_uuid, event_type, resource_type, resource_id, created_utc, received_at,
                processing_status, attempt_count, last_error, forwarded_at
         FROM webhook_events WHERE processing_status = ? ORDER BY received_at DESC LIMIT ?`,
      ).bind(status, limit).all()
    : await env.DB.prepare(
        `SELECT event_uuid, event_type, resource_type, resource_id, created_utc, received_at,
                processing_status, attempt_count, last_error, forwarded_at
         FROM webhook_events ORDER BY received_at DESC LIMIT ?`,
      ).bind(limit).all();
  return json({ events: result.results, count: result.results.length });
}

async function replayEvent(request: Request, env: Env, eventUuid: string): Promise<Response> {
  if (!(await authenticateAdmin(request, env))) return json({ error: "UNAUTHORIZED" }, 401);
  if (!eventUuid || eventUuid.length > 200) return json({ error: "INVALID_EVENT_ID" }, 400);
  const row = await env.DB.prepare(
    "SELECT processing_status FROM webhook_events WHERE event_uuid = ?",
  ).bind(eventUuid).first<{ processing_status: string }>();
  if (!row) return json({ error: "EVENT_NOT_FOUND" }, 404);
  if (row.processing_status === "QUEUED") return json({ queued: true, alreadyQueued: true });
  try {
    await env.DB.prepare(
      "UPDATE webhook_events SET processing_status = 'QUEUED', last_error = NULL WHERE event_uuid = ?",
    ).bind(eventUuid).run();
    await env.EVENT_QUEUE.send({ eventUuid });
    return json({ queued: true });
  } catch {
    await env.DB.prepare(
      "UPDATE webhook_events SET processing_status = 'FAILED', last_error = 'QUEUE_ENQUEUE_FAILED' WHERE event_uuid = ?",
    ).bind(eventUuid).run();
    return json({ error: "QUEUE_UNAVAILABLE" }, 503);
  }
}

async function handleAdmin(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/admin/events" && request.method === "GET") return listEvents(request, env);
  const match = /^\/admin\/events\/([^/]+)\/replay$/.exec(url.pathname);
  if (match && request.method === "POST") return replayEvent(request, env, decodeURIComponent(match[1]));
  return json({ error: "NOT_FOUND" }, 404);
}

async function processQueue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    const { eventUuid } = message.body;
    try {
      const row = await env.DB.prepare(
        "SELECT raw_body FROM webhook_events WHERE event_uuid = ?",
      ).bind(eventUuid).first<{ raw_body: string }>();
      if (!row) {
        message.ack();
        continue;
      }

      if (!env.UPSTREAM_URL || !env.UPSTREAM_SECRET) {
        await env.DB.prepare(
          "UPDATE webhook_events SET processing_status = 'IGNORED', last_error = 'UPSTREAM_NOT_CONFIGURED', attempt_count = attempt_count + 1 WHERE event_uuid = ?",
        ).bind(eventUuid).run();
        message.ack();
        continue;
      }

      const upstream = new URL(env.UPSTREAM_URL);
      if (upstream.protocol !== "https:") throw new Error("UPSTREAM_MUST_USE_HTTPS");
      const signature = await hmacSha256Hex(env.UPSTREAM_SECRET, row.raw_body);
      const response = await fetch(upstream.toString(), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Tremendous-Gateway-Signature": `sha256=${signature}`,
          "Idempotency-Key": eventUuid,
          "X-Tremendous-Event-Id": eventUuid,
        },
        body: row.raw_body,
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) throw new Error(`UPSTREAM_HTTP_${response.status}`);
      await env.DB.prepare(
        "UPDATE webhook_events SET processing_status = 'FORWARDED', forwarded_at = ?, last_error = NULL, attempt_count = attempt_count + 1 WHERE event_uuid = ?",
      ).bind(new Date().toISOString(), eventUuid).run();
      message.ack();
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 300) : "UNKNOWN_PROCESSING_ERROR";
      await env.DB.prepare(
        "UPDATE webhook_events SET processing_status = 'FAILED', last_error = ?, attempt_count = attempt_count + 1 WHERE event_uuid = ?",
      ).bind(reason, eventUuid).run();
      message.retry();
    }
  }
}

async function pruneOldEvents(env: Env): Promise<void> {
  // Keep 90 days of operational metadata and raw payloads; prune only terminal events.
  await env.DB.prepare(
    `DELETE FROM webhook_events
     WHERE received_at < datetime('now', '-90 days')
       AND processing_status IN ('FORWARDED', 'IGNORED')`,
  ).run();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz" && request.method === "GET") {
      return json({ ok: true, service: "tremendous-webhook-gateway" });
    }
    if (url.pathname === "/webhook" || url.pathname === "/tremendous/webhook") {
      return receiveWebhook(request, env);
    }
    if (url.pathname.startsWith("/admin/")) return handleAdmin(request, env);
    return json({ error: "NOT_FOUND" }, 404);
  },
  async queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
    await processQueue(batch, env);
  },
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    await pruneOldEvents(env);
  },
};
