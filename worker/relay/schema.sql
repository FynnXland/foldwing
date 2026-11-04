-- Foldwing-Relay: D1-Schema.
-- Einspielen: npx wrangler d1 execute foldwing-relay --remote --file schema.sql
-- Zeiten sind Millisekunden seit 1970 (Date.now()). Keine IP-Adressen, keine Besucherdaten.

-- Ein Eintrag je Foldwing-Installation, die den Relay nutzt.
--   id           Geräte-ID D (8 Zeichen base62)
--   secret_hash  SHA-256 (hex) des Secrets der App; das Secret selbst liegt nur in der App
--   url          aktuelle Quick-Tunnel-Adresse (https://<zufall>.trycloudflare.com)
--   online       1 = angemeldet, 0 = abgemeldet
--   created_at   erste Anmeldung
--   seen_at      letzte Anmeldung bzw. letzter Heartbeat (alle 6 h)
--   blocked      1 = gesperrt (Moderation); gesperrte Geräte löscht der Cron nicht
--   block_reason Grund der Sperre (Kategorie aus moderate.mjs, steht auf der 451-Seite)
--   blocked_at   Zeitpunkt der Sperre (steht auf der 451-Seite)
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  url TEXT,
  online INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  seen_at INTEGER NOT NULL,
  blocked INTEGER NOT NULL DEFAULT 0,
  block_reason TEXT,
  blocked_at INTEGER
);

-- Für den täglichen Cron (Geräte, die 30 Tage nicht gesehen wurden).
CREATE INDEX IF NOT EXISTS devices_seen_at ON devices (seen_at);

-- Einzelne gesperrte Links (T = D + S, 18 Zeichen base62). reason und created_at
-- stehen auf der 451-Seite.
CREATE TABLE IF NOT EXISTS blocked_links (
  token TEXT PRIMARY KEY,
  reason TEXT,
  created_at INTEGER NOT NULL
);
