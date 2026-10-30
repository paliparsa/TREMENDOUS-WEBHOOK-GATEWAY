CREATE TABLE IF NOT EXISTS webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_uuid TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  created_utc TEXT,
  received_at TEXT NOT NULL,
  raw_body TEXT NOT NULL,
  processing_status TEXT NOT NULL DEFAULT 'RECEIVED'
    CHECK (processing_status IN ('RECEIVED', 'QUEUED', 'FORWARDED', 'FAILED', 'IGNORED')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  forwarded_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_status_received
  ON webhook_events(processing_status, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_events_resource
  ON webhook_events(resource_type, resource_id);

CREATE TABLE IF NOT EXISTS gateway_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
