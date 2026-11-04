# Foldwing-Relay (Cloudflare Worker)

Der Relay macht Foldwing-Links ohne eigene Domain und ohne Konto weltweit erreichbar.
Die App startet einen Cloudflare Quick Tunnel (`https://<zufall>.trycloudflare.com`) und
meldet dessen Adresse hier an. Wer einen Link wie `https://share.example.com/<T>` öffnet,
landet beim Worker; der schlägt nach, unter welcher Tunnel-Adresse das Gerät gerade
erreichbar ist. Seiten und Schriften reicht er gestreamt durch. Dateien selbst (Rohdaten,
`/<T>/d`) beantwortet er mit einer Weiterleitung (302) auf denselben Pfad beim Tunnel: Die
Dateiinhalte fließen nie durch den Worker.

Der Relay speichert **keine Dateien**. Sie bleiben auf dem Rechner der teilenden Person.

## Aufbau

| Datei | Inhalt |
| --- | --- |
| `src/worker.ts` | `main` für die Workers-Laufzeit: der Relay und der RPC-Einstieg `Admin` |
| `src/index.ts` | Der Relay selbst (ohne `cloudflare:workers`, damit die Tests ihn in Node laden) |
| `src/moderation.ts` | Sperren, Entsperren, Nachschlagen für den Einstieg `Admin` |
| `src/router.ts` | Routing, Besucher-Aufrufe, Weiterleitung der Rohdaten, Cron |
| `src/proxy.ts` | Durchreichen von Seiten und Schriften: Header-Allowlists, Status-Filter, Sicherheits-Header |
| `src/register.ts` | `POST /_/api/register` und `/_/api/unregister` |
| `src/store.ts` | Speicher-Schicht über D1 und kurzer Zwischenspeicher je Isolate |
| `src/pages.ts` | Seiten ohne JavaScript: Info, Melden, offline, gesperrt, Fehler |
| `src/ids.ts`, `src/security.ts`, `src/http.ts` | Formate, Hash und Vergleich, Antwort-Bausteine |
| `schema.sql` | Tabellen `devices` und `blocked_links` |
| `../scripts/moderate.mjs` | Sperren, Entsperren, Nachschlagen |

Die Tests stehen in `tests/relay-worker.test.ts` und `tests/relay-admin.test.ts` im Repo
(`node scripts/test.mjs relay`).
Typprüfung: `npx tsc --noEmit -p worker/relay`.

## Pfade

| Pfad | Bedeutung |
| --- | --- |
| `/<T>`, `/<T>/<F>` | Freigabe-Seite bzw. Seite einer Datei aus einer Sammlung (durchgereicht) |
| `/<T>/d`, `/<T>/<F>/d` | Rohdaten (`?dl=1` = Download): 302 auf `<tunnel>/<T>/…/d?…` |
| `/<T>/_font/Geist-Variable.woff2`, `/<T>/_font/GeistMono-Variable.woff2` | Schriften (durchgereicht) |
| `/` | leitet auf `/_/` |
| `/_/` | Info-Seite |
| `/_/melden?l=<T>` | Melde-Seite mit vorausgefüllter E-Mail |
| `/_/impressum`, `/_/datenschutz`, `/_/regeln` | 302 auf `IMPRINT_URL`, `PRIVACY_URL`, `TERMS_URL` (404, wenn nicht gesetzt) |
| `/robots.txt` | `Disallow: /` |
| `POST /_/api/register`, `POST /_/api/unregister` | An- und Abmeldung der App |

`T` ist die Geräte-ID `D` (8 Zeichen base62) plus die Freigabe-ID `S` (10 Zeichen), `F` die
Datei-ID (6 Zeichen). Alles andere ergibt 404, andere Methoden als `GET`/`HEAD` auf
Besucher-Pfaden 405.

## Einrichten

Du brauchst ein Cloudflare-Konto (kostenloser Tarif reicht), eine Domain als Zone in
diesem Konto und Node.js für `npx wrangler`. Alle Befehle im Ordner `worker/relay`.

1. Anmelden: `npx wrangler login`
2. Datenbank in der EU-Jurisdiktion anlegen:
   `npx wrangler d1 create foldwing-relay --jurisdiction eu`
   Mit `--jurisdiction eu` bleiben die Daten in Rechenzentren der EU. Das lässt sich
   später nicht ändern.
3. `wrangler.example.toml` nach `wrangler.toml` kopieren (die Kopie ignoriert git) und
   eintragen: die `database_id` aus Schritt 2, deinen Hostnamen unter `routes`
   (z. B. `share.example.com`) und die Betreiber-Angaben unter `[vars]`.
4. Schema einspielen: `npx wrangler d1 execute foldwing-relay --remote --file schema.sql`
5. Deployen: `npx wrangler deploy`

**Custom Domain statt Route:** In der Vorlage steht `custom_domain = true`. Dann legt
Cloudflare DNS-Eintrag und Zertifikat selbst an, und der Worker bekommt den ganzen
Hostnamen. `workers_dev` und `preview_urls` sind aus, damit der Relay nicht zusätzlich
unter einer `*.workers.dev`-Adresse erreichbar ist.

### Variablen

| Name | Bedeutung |
| --- | --- |
| `CONTACT_EMAIL` | Kontaktadresse: Info-Seite, Meldungen (`mailto:` auf `/_/melden`), Widerspruch auf der 451-Seite |
| `IMPRINT_URL` | Link zum Impressum |
| `PRIVACY_URL` | Link zur Datenschutzerklärung |
| `TERMS_URL` | Link zu den Nutzungsregeln |
| `SOURCE_URL` | optional, Link zum Quellcode (Info-Seite) |

Wer den Relay betreibt, steht im Impressum, nicht auf den Seiten des Workers. Links werden
nur übernommen, wenn sie mit `https://` (oder `/`) beginnen. Fehlt ein Wert,
lassen die Seiten den Eintrag weg. Die Variablen gehören in die `wrangler.toml`, weil ein
Deploy die im Dashboard gesetzten Variablen sonst überschreibt. Secrets braucht der Relay
keine.

### Ratenbegrenzung

Optional über das Workers-Rate-Limiting-Binding (`[[ratelimits]]` in der Vorlage):

- `REGISTER_LIMITER`: An- und Abmeldungen, gezählt je Gerät und je Netz
- `PROXY_LIMITER`: Besucher-Aufrufe je Netz. Großzügig einstellen, ein Video stellt beim
  Spulen viele Range-Anfragen, und jede holt sich hier eine Weiterleitung.
- `DEVICE_LIMITER` und `LINK_LIMITER`: Volumenbremse je Gerät und je Link (Seitenaufrufe und
  Datei-Weiterleitungen pro Minute), falls ein Link viral geht.

Fehlen die Bindings oder antworten sie nicht, läuft der Worker ohne Begrenzung weiter.

### Lokal testen

```bash
npx wrangler d1 execute foldwing-relay --local --file schema.sql
npx wrangler dev --local --port 8012
```

Die Seiten `/_/`, `/_/melden` und die 503-Seite lassen sich so ansehen. Ein echter
Durchlauf braucht einen laufenden Quick Tunnel mit Foldwing dahinter.

## Moderation

```bash
node worker/scripts/moderate.mjs block   <link|T|D> <kategorie>
node worker/scripts/moderate.mjs unblock <link|T|D>
node worker/scripts/moderate.mjs lookup  <link|T|D>
node worker/scripts/moderate.mjs list
```

- Ein Link oder `T` (18 Zeichen) sperrt genau diesen Link. Besucher sehen dann 451
  „Dieser Link wurde gesperrt.“ mit Datum, Grund und dem Weg zum Widerspruch.
- `D` (8 Zeichen, der Anfang von `T`) sperrt das ganze Gerät: alle Links, und die App
  kann sich nicht mehr anmelden (sie zeigt dann einen Hinweis). Das geht auch für ein
  Gerät, das noch nie angemeldet war.
- `lookup` zeigt Gerät, Online-Status, letzte Meldung, Tunnel-Adresse und Sperren.
- Der Grund ist eine feste Kategorie, kein Freitext (er steht öffentlich auf der
  451-Seite): `urheberrecht`, `schadsoftware`, `betrug`, `persoenlichkeitsrecht`, `gesetz`,
  `missbrauch` (zeigt bewusst nur „Verstoß gegen das Gesetz“), `regeln`.
- Optionen: `--db <name>` (Standard `foldwing-relay`), `--local`, und alles nach `--`
  geht an wrangler.

Das Skript ruft `npx wrangler@4 d1 execute … --remote` im Ordner `worker/relay` auf (ohne
Shell). Eine Sperre greift nach spätestens 30 Sekunden überall, so lange merkt sich jeder
Worker-Prozess eine Zuordnung.

### Moderation über das Admin-Dashboard

Dieselben Aktionen gibt es als RPC-Einstieg `Admin` (`src/worker.ts`, Logik in
`src/moderation.ts`): `categories()`, `counts()`, `list()`, `lookup(ziel)`,
`block(ziel, kategorie)` und `unblock(ziel)`. Er hat keine Adresse im Internet. Erreichbar ist
er nur für einen anderen Worker im selben Cloudflare-Konto, der ihn per Service Binding mit
`entrypoint = "Admin"` einbindet. Die Methoden werfen nie, Fehler kommen als
`{ ok: false, code, error }` (`badTarget`, `badCategory`, `serverError`). Anders als das Skript
gibt `lookup` die Tunnel-Adresse nicht heraus. Das Skript bleibt als Notweg; ein Test hält
Kategorien und Zielerkennung in beiden gleich.

Um eine gemeldete Datei anzusehen, öffne den Link selbst. Das klappt nur, solange der
Rechner der teilenden Person online ist.

## Datenschutz: was gespeichert wird und was nicht

**In D1 (EU-Jurisdiktion):**

- je Gerät: Geräte-ID, SHA-256-Hash des App-Secrets, aktuelle Quick-Tunnel-Adresse,
  online ja/nein, Zeitpunkt der ersten und der letzten Anmeldung, Sperre mit Grund und Zeitpunkt
- je gesperrtem Link: die Link-ID, der Grund, der Zeitpunkt

**Wie lange:** Die App meldet sich alle 6 Stunden, solange sie etwas teilt. Geräte, die
sich 30 Tage nicht gemeldet haben, löscht ein täglicher Cron. Gesperrte Geräte und
gesperrte Links bleiben, bis du sie entsperrst.

**Was nicht gespeichert wird:**

- keine Dateien und keine Dateiinhalte (die laufen gar nicht durch den Worker, siehe
  Weiterleitung; Seiten und Schriften laufen gestreamt durch und werden nicht abgelegt)
- keine Dateinamen, keine Freigabe-Listen
- keine IP-Adressen, weder von Besuchern noch von Apps
- keine Cookies, kein Tracking, keine Logs: `observability` ist aus

**Was wohin geht:**

- An den Tunnel gehen nur die Header `Range`, `If-Range`, `If-None-Match`,
  `If-Modified-Since`, `Accept`, `Accept-Language` und ein fester User-Agent. Keine
  Cookies, kein Referer, keine Besucher-IP. (Unteranfragen eines Workers tragen laut
  Cloudflare-Doku als `CF-Connecting-IP` eine Cloudflare-Adresse, nicht die des Besuchers.)
- Die Ratenbegrenzung zählt je Netz mit einem gekürzten SHA-256-Hash der IP als
  flüchtigem Schlüssel. Er landet nur im Zähler von Cloudflare, nicht in D1.
- Antworten des Tunnels werden nicht im Cloudflare-Cache abgelegt (jede Unteranfrage mit
  `cache: 'no-store'`). Den Besucher-Browsern erlaubt der Worker bei Schriften
  `private, max-age=3600`; Seiten und Weiterleitungen sind `no-store`.
- Bei Rohdaten sieht der Tunnel (also der Rechner der teilenden Person) die IP des
  Besuchers über Cloudflare, so wie bei jedem direkten Link. Den Referer gibt der Worker
  nicht mit (`Referrer-Policy: no-referrer`).

## Sicherheit

Der Worker vertraut dem Tunnel nicht. Hinter einem Quick Tunnel kann statt Foldwing
auch ein eigener Server hängen. Deshalb:

- Anmelden geht nur mit einer Adresse `https://<label>.trycloudflare.com` ohne Pfad und
  Port, und nur, wenn `GET <url>/api/health` (8 s, ohne Weiterleitung) mit
  `app: "Foldwing"` und genau dieser Geräte-ID antwortet. Durchreichen und
  Weiterleiten gehen nur an geprüfte Pfade dieses einen Tunnels; die Adresse wird auch beim
  Lesen aus D1 noch einmal geprüft. Kein offener Proxy, kein offener Redirect, und
  Weiterleitungen des Tunnels werden nicht befolgt (3xx → 502).
- Das Secret wird nur als SHA-256-Hash gespeichert und zeitkonstant verglichen. Eine
  fremde Geräte-ID lässt sich ohne Secret nicht übernehmen (409).
- Antwort-Header kommen nur aus einer Allowlist (`Content-Type`, `Content-Length`,
  `Content-Range`, `Accept-Ranges`, `Content-Disposition`, `ETag`, `Last-Modified`),
  jeweils formatgeprüft. `Set-Cookie`, CORS, `Location`, `Refresh` und alles andere fällt weg.
- Der Worker setzt selbst `X-Content-Type-Options: nosniff`, `Referrer-Policy:
  no-referrer`, `Cross-Origin-Resource-Policy: same-origin`, `X-Robots-Tag`, HSTS,
  `Cache-Control` und eine CSP ohne Skripte. Seiten bekommen die CSP der App-Seiten in
  strenger (`default-src 'none'`, `form-action 'none'`, `frame-ancestors 'none'`); Bild,
  Video und PDF-iframe dürfen zusätzlich von `https://*.trycloudflare.com` kommen, weil
  `/<T>/d` dorthin weiterleitet und die CSP das Ziel mitprüft.
- Die Rohdaten liefert der App-Server auf dem Tunnel-Host selbst aus, mit seinen eigenen
  Sicherheits-Headern (Attachment für HTML/SVG, Sandbox). Der Tunnel-Host ist ein anderer
  Ursprung als der Relay: Selbst eine bösartige Datei dort erreicht keine Relay-Seite.
- Antwortet ein Tunnel auf einem Seiten-Pfad mit etwas anderem als HTML, wird es Download
  (`Content-Disposition: attachment`), außer Bilder (ohne SVG), Video, Audio, PDF und
  `text/plain`, und läuft in `sandbox allow-downloads`.
- Aus HTML-Seiten entfernt der Worker `<meta http-equiv>` (vor allem `refresh`), `<link>`
  und `<base>`. Sonst könnte ein fremder Server den Relay als Weiterleitung für Phishing
  nutzen.
- Körper der API höchstens 2 KB, Antwort des Health-Checks höchstens 1 KB. Seiten und
  Schriften laufen als Strom durch und werden nie gepuffert.
- Kein CORS. Fehler nach außen nur als feste Codes, nie mit Interna.

## Kosten

Der kostenlose Workers-Plan erlaubt 100.000 Anfragen am Tag, D1 im kostenlosen Plan
5 Millionen gelesene Zeilen am Tag. Jeder Besucher-Aufruf ist eine Worker-Anfrage, auch
jede Weiterleitung einer Datei; ein Video mit vielen Range-Anfragen also mehrere. Der
Datenverkehr der Dateien selbst läuft am Worker vorbei. Die Geräte-Zuordnung merkt sich jeder
Worker-Prozess bis zu 30 Sekunden, damit nicht jede Anfrage D1 trifft.
