# Foldwing – Leitfaden für KI-Agenten (und Menschen)

Diese Datei ist verbindlich. Lies sie ganz, bevor du Code anfasst. Sie gilt für jeden, der
an Foldwing arbeitet; was nur auf einem einzelnen Rechner gilt (eigene Pfade, Konten,
Domains), gehört in eine lokale, nicht verfolgte Datei, nie hierher.

Foldwing hieß bis zur ersten öffentlichen Version Foldwing. Der Anzeigename kommt aus
`src/main/brand.ts` und `src/renderer/src/brand.ts`; Code-Bezeichner, Datenordner
(`%APPDATA%\foldwing`), `window.foldwing`, die Kennung `app: 'Foldwing'` in `/api/health`
und die Paketierung in `package.json` tragen vorerst noch den alten Namen.

---

## 1. Was Foldwing ist

Selbst gehostetes Datei-Sharing im WeTransfer-Stil als **Desktop-App** (Electron 45 + React +
TypeScript, gebaut mit electron-vite). Man zieht Dateien hinein und bekommt sofort einen Link.
Wer ihn öffnet, sieht die Datei im Browser (Vorschau) und lädt sie verlustfrei herunter.

**Plattformen:** Windows 10/11 (x64, NSIS-Installer und Portable) und Linux (x64, AppImage
und .deb). Beide werden in GitHub Actions gebaut und gehören zu jedem Release. Entwickelt und
überwiegend getestet wird unter Windows. Plattform-Spezifisches (Scanner, Autostart,
Kontextmenü, Fenster-Erkennung, cloudflared-Binärname, Update-Art) läuft über
`src/main/platform.ts` und je-Plattform-Zweige – neue Features müssen unter Windows
funktionieren und unter Linux mindestens sauber degradieren (Wayland: keine Fensterliste).

**Drei unverhandelbare Leitprinzipien** (jede Entscheidung daran messen):

1. **Datenhoheit** – alles läuft lokal. **Keine Dateiinhalte an Dritt-Dienste.**
   Kein Cloud-OCR, keine Inhalts-KI, keine externen Viewer. Der öffentliche Relay reicht nur
   die Freigabe-Seiten durch; Dateien gehen per Weiterleitung (302) direkt vom PC über dessen
   Quick Tunnel zum Empfänger. Der Relay analysiert nichts und speichert weder Dateien noch
   Seiten, nur Geräte-ID, Hash des Geräte-Geheimnisses, Tunnel-Adresse und Zeitstempel.
   (Der Cloudflare-Tunnel leitet nur durch, analysiert nicht.) Neue Features, die das
   verletzen, sind tabu – auch im Relay-Worker.
2. **Verlustfrei** – die heruntergeladene Datei ist bit-identisch zum Original.
   Vorschauen sind reine Ansicht und dürfen die Datei nie verändern. Auch das
   ZIP einer Sammlung ist unkomprimiert („stored“) – kein Kompressions-Umweg,
   der die Bit-Identität gefährden könnte.
3. **Kostenfrei betreibbar** – keine laufenden Serverkosten als Grundannahme. Der Relay
   läuft im kostenlosen Workers-Tarif; im eigenen Netzwerk läuft alles ohne Konto, eine
   eigene Domain ist optional.

---

## 2. Architektur

Der **Electron-Main-Prozess** startet einen eingebetteten **HTTP-Server**, der
Freigabe-Seiten und Dateien (mit HTTP-Range) ausliefert. Mehrere Dateien lassen sich zu EINER
Sammlung unter EINEM Link bündeln (bis 100 Dateien) – der Empfänger sieht eine Übersicht mit
Vorschau-Kacheln, lädt einzelne Dateien oder alle zusammen als ZIP. Das ZIP wird
unkomprimiert („stored“) gestreamt, damit Leitprinzip 2 auch hier gilt und der
Speicherverbrauch konstant bleibt. Uploads laufen ausschließlich **per IPC** aus der eigenen
App in die Ablage (Fenster, Rechtsklick-Eintrag, Screenshots) – es gibt keinen öffentlichen
Upload-Endpunkt.

**Betriebsarten** (`linkMode` in der Config, Karte „Links“ in den Einstellungen):
- **`relay`** (Standard): Links `https://share.fynn.land/<T>` mit `T` = Geräte-ID `D`
  (8 Zeichen base62) + Freigabe-ID `S` (10 Zeichen). Die App startet einen **Cloudflare Quick
  Tunnel** ohne Konto, prüft `<tunnel>/api/health` selbst und meldet die Tunnel-Adresse beim
  Relay an (`POST /_/api/register`, Heartbeat alle 6 h, Abmeldung, wenn nichts mehr geteilt
  ist). Der Server lauscht dann nur auf `127.0.0.1`. Vor der ersten Anmeldung muss der
  Hinweis-Dialog (`RelayNotice.tsx`, `relay.noticeAccepted`) bestätigt sein.
- **`lan`**: Links `http://<LAN-IP>:8787/s/<S>`, kein Tunnel, nichts geht nach außen.
- **`domain`**: eigene Domain mit eigenem Cloudflare-Tunnel **per Token**,
  Links `<publicBaseUrl>/s/<S>`; der Relay ist nicht beteiligt.

**Pfadfamilien** (`links.ts`): Dieselbe Freigabe ist unter `/s/<S>`, `/s/<S>/<F>`,
`/f/<S>`, `/f/<S>/<F>`, `/_font/…` (LAN/Domain) und unter `/<T>`, `/<T>/<F>`, `/<T>/d`,
`/<T>/<F>/d`, `/<T>/_font/…` (Relay) erreichbar. Relay-Pfade bedient der Server nur für die
eigene Geräte-ID (sonst 404), und Seiten einer Familie verlinken nur Pfade derselben Familie;
der Vorschau-Cache hat die Familie im Schlüssel.

**Relay** (`worker/relay/`, Cloudflare Worker + D1 in der EU-Jurisdiktion): reicht Seiten
und Schriften gestreamt durch, beantwortet Rohdaten mit 302 auf den Tunnel, vertraut dem
Tunnel nicht (Header-Allowlists, `<meta http-equiv>`/`<link>`/`<base>` raus, keine
Weiterleitungen befolgen), speichert keine IP-Adressen und hat keine Logs. Ein täglicher Cron
löscht Geräte nach 30 Tagen ohne Meldung. Melde-Seite `/_/melden`, Sperren über
`worker/scripts/moderate.mjs`. Die App kennt den Relay als Konstante `DEFAULT_RELAY_URL` in
`relay.ts`; nur für Tests/Entwicklung überschreibt `FOLDWING_RELAY_URL` sie. Forks betreiben
ihren eigenen Relay. Details: `docs/relay.md`.

**Teilen nach Bedarf:** Server und Tunnel laufen nur, solange es etwas zu teilen gibt
(gültige Freigabe, laufender Upload, zwei Minuten Festhalten nach Wechsel der Betriebsart,
Speichern der Domain-Einstellungen oder Verbindungstest). Fällt der letzte Grund weg, stoppen
sie nach 60 s Schonfrist, und die App meldet sich beim Relay ab. Die Regel steht als reine,
getestete Logik in `src/main/sharing-policy.ts`; `reconcileSharing()` in `index.ts` wendet
sie über eine serialisierte Kette an.

**Updates:** Alle Builds prüfen (Einstellung `updates.auto`, Standard an) über
electron-updater mit dem GitHub-Provider aus `build.publish` in `package.json`. Installer
(NSIS) und AppImage laden und installieren selbst, Portable und .deb zeigen nur einen Hinweis
mit Link auf die Releases-Seite, Dev-Läufe und entpackte Test-Builds prüfen nie
(`update-mode.ts`).

**Speicher im Leerlauf:** Foldwing soll im Leerlauf kaum Speicher belegen. Das Hauptfenster
wird beim Schließen samt Renderer zerstört (während eines Uploads nur versteckt), die
Screenshot-Overlays entstehen erst beim Tastendruck, der Fenster-Helfer endet 60 s nach der
letzten Aufnahme (`capture-idle.ts`), und `xlsx`, `mammoth` und `electron-updater` werden
erst bei Gebrauch geladen. Wer Neues baut, hält sich an dieses Muster. Die Ladeanzeige beim
Start steht als reines HTML/CSS in `src/renderer/index.html` (kein Skript, CSP).

Team-Modus (team.json, Provisioner-Worker, Subdomains, Update-Ordner und Route `/update`,
benannter Tunnel, `/impressum`) und die Zugangs-Sperre gibt es seit 1.4.0 nicht mehr.

---

## 3. Verzeichnisstruktur

```
src/main/             Electron-Hauptprozess (Node-Umgebung)
  index.ts            Fenster, Tray, IPC-Handler, Lifecycle, Teilen nach Bedarf, Betriebsarten
  brand.ts            Anzeigename und Logo für Main-Prozess und Freigabe-Seiten
  sharing-policy.ts   Wann Server und Tunnel laufen, Link-Status, Tray-Tooltip (rein, getestet)
  relay.ts            Relay-Client: IDs, Geheimnis (safeStorage), Anmeldung, Backoff,
                      Heartbeat, DEFAULT_RELAY_URL (rein, getestet)
  links.ts            Pfadfamilien LAN/Domain und Relay, routeSharePath() (rein, getestet)
  update-mode.ts      Welche Update-Art zu diesem Build passt (rein, getestet)
  updater.ts          Updates über GitHub-Releases (electron-updater, lazy)
  server.ts           HTTP-Server: / /api/health, beide Pfadfamilien, Range,
                      Security-Header, Vorschau-Cache
  store.ts            Freigabe-Ablage (gestreamt), Sammlungen (beginBundle/finalizeBundle/
                      abortBundle), Ablauf, Dateinamen-Bereinigung, verwaiste Uploads
  pages.ts            HTML der Freigabe-/Sammlungs-/Landing-Seiten (kein Client-JS!)
  preview.ts          Vorschau: Bild/Video/Audio, PDF (iframe), Word (mammoth), Excel/CSV
                      (xlsx) mit HTML-Sanitizer, Text/Code, ZIP-Baum
  zip.ts              ZIP-Verzeichnis lesen (nur Central Directory, RAM-schonend)
  zip-write.ts        ZIP-Sammel-Download schreiben (streamend, „stored“, ZIP64, Größe vorab)
  tunnel.ts           cloudflared-Kindprozess (Quick Tunnel oder Token), Binär-Erkennung
  scanner.ts          Virenscan der Uploads (Windows Defender bzw. ClamAV), lokal, fail-open
  config.ts           Persistente Config (userData), Defaults, Migrationen, LAN-Adresse
  platform.ts         Plattform-Weichen Windows/Linux
  context-menu.ts     Rechtsklick-Eintrag „Mit Foldwing teilen“ (HKCU-Registry / .desktop)
  capture.ts          Screenshot: Hotkey, Overlays je Monitor, Aktionsleiste
  capture-idle.ts     Aufnahme-Ressourcen im Leerlauf abbauen (rein, getestet)
  capture-window-list.ts, capture-windows.ts, capture-linux.ts
                      Fenster-Erkennung (PowerShell-Helfer bzw. xprop/xwininfo unter X11)
  capture-geometry.ts Umrechnung logischer/physischer Pixel
src/preload/          contextBridge-API (window.foldwing) – einzige Renderer↔Main-Brücke
src/renderer/         React-UI (Browser-Umgebung, KEIN Node/fs)
  index.html          Ladeanzeige ohne Skript
  src/App.tsx         Zustands-Orchestrierung
  src/brand.ts        Anzeigename im Renderer
  src/components/     Dropzone, ShareView, ShareCard, SettingsView, RelayNotice, TunnelBanner,
                      UpdateBanner, Header, Icon, Logo, CaptureOverlay, CaptureActions
  src/lib/            upload.ts (Chunks), hotkey.ts (Kürzel aufnehmen), format.ts
worker/relay/         Relay-Worker: src/ (router, proxy, register, store, pages, ids,
                      security, http), schema.sql, README.md, wrangler.example.toml
worker/scripts/       moderate.mjs (Links/Geräte sperren, entsperren, nachschlagen)
resources/            fonts/; lokal und ignoriert: cloudflared.exe, cloudflared-linux-amd64
build/                Icons, installer.nsh (Aufräumen beim Deinstallieren)
scripts/              test.mjs, fetch-cloudflared.mjs, third-party-notices.mjs,
                      make-icon.mjs, build-linux.sh
tests/                node:test-Tests, dazu Wächter: repo-guards.test.mjs, repo-readme.test.mjs
docs/                 architecture, relay, cloudflare-tunnel (en/de), releasing; media/
.github/              CI (tests.yml), Release (release.yml), Dependabot, Issue-Formulare,
                      PR-Vorlage
```

---

## 4. Befehle

```bash
npm ci              # Abhängigkeiten exakt nach Lockfile
npm run dev         # App im Dev-Modus (installierte App vorher beenden, s. u.)
npm run typecheck   # tsc für Main + Renderer (IMMER vor "fertig")
npm test            # Headless-Tests (node:test + esbuild), rund 300 Tests in tests/
node scripts/test.mjs relay   # nur Testdateien mit „relay“ im Namen
npm run build       # electron-vite Produktions-Bundle nach out/
npm run dist:win    # Setup + Portable nach release/ (nur auf Windows)
npm run dist:linux  # AppImage + .deb nach release/ (nur auf Linux)
node scripts/fetch-cloudflared.mjs [win|linux]  # cloudflared nach resources/ (feste
                                                # Version + SHA256; dist:* ruft es selbst auf)
node scripts/third-party-notices.mjs [--check]  # THIRD-PARTY-NOTICES.md erzeugen/prüfen
bash scripts/build-linux.sh  # Linux-Build in einem eigenen Spiegel unter
                             # ~/.cache/foldwing-linux-build (holt Node + Linux-node_modules)
npx tsc --noEmit -p worker/relay              # Typprüfung des Relay-Workers
node worker/scripts/moderate.mjs <befehl> …   # Moderation (block/unblock/lookup/list)
```

- `FOLDWING_TEST_OUT=<name>` gibt einem Testlauf einen eigenen Ausgabeordner
  (`.test-out-<name>`), damit parallele Läufe sich nicht die Bundles löschen.
- Veröffentlicht wird nur über GitHub Actions (`.github/workflows/release.yml`): Tag `vX.Y.Z`
  pushen → Windows- und Linux-Builds → Release-Entwurf mit `SHA256SUMS.txt` und den Notizen
  aus dem CHANGELOG → Entwurf prüfen → von Hand veröffentlichen
  ([docs/releasing.md](docs/releasing.md)). Lokal gebaute Installer nie hochladen.
- `dist:win` bündelt `cloudflared.exe` → Installer rund 98 MB.
- Dev-Läufe und Test-Builds nutzen denselben Datenordner (`%APPDATA%\foldwing`) wie eine
  installierte App, und es läuft nur eine Instanz: installierte App vorher beenden.
- Liegt derselbe Projektordner unter Windows und Linux (geteilte Platte), gehören
  `node_modules` der zuletzt installierenden Plattform: unter Linux dann nie direkt im Ordner
  installieren oder bauen, sondern `scripts/build-linux.sh` nehmen.
- Die README-Medien in `docs/media/` erzeugt `docs/media/make_media.mjs` aus der echten
  Oberfläche mit erfundenen Daten neu; der Aufruf steht im Kopf des Skripts. Medien nie von
  Hand mit echten Daten aufnehmen.

---

## 5. Wie du abzuliefern hast (verbindlich)

> Der Grundsatz: **Nichts gilt als erledigt, ohne dass du es bewiesen hast.**
> Behaupte nie, etwas funktioniere, wenn du es nicht gezeigt hast.

1. **Verifizieren statt behaupten.** Nach jeder inhaltlichen Änderung:
   `npm run typecheck` **muss** grün sein, und `npm test` **muss** grün sein (node:test
   + esbuild, rund 300 Tests in `tests/`). Neue testbare Logik im Main-Prozess
   (electron-frei) bekommt eine dauerhafte Datei `tests/<thema>.test.ts` – gegen Mocks,
   wo echte externe Dienste nötig wären (z. B. der Relay-Worker gegen einen Fake-Store und
   gestubbte Tunnel, der Relay-Client mit `fetch`-Stub; nie gegen den echten Relay). Nur für
   ein Wegwerf-Experiment ohne Verbleib im Repo bleibt das alte Muster erlaubt: kleine
   `_test.ts` schreiben, mit `./node_modules/.bin/esbuild … --bundle --platform=node
   --format=esm --external:mammoth --external:xlsx` bündeln, mit `node` laufen lassen,
   Temp-Dateien danach löschen.

2. **Bei Änderungen am Main-Prozess neu paketieren** (`npm run dist:win`) und die gepackte
   App (`release/win-unpacked/<Produktname>.exe`) mindestens per Smoke-Test starten: Läuft
   sie? Antwortet nach dem Teilen einer Datei `http://localhost:8787/api/health`? (Der Server
   läuft nur, solange etwas geteilt ist.) Sonst testest du am ausgelieferten Artefakt vorbei
   (Beispiel: fehlende Dateien im asar).

3. **Ehrlich berichten.** Sag klar, was du getestet hast und was **nicht** (z. B.
   „GUI nicht visuell durchgeklickt“, „Relay nur gegen Mock, kein echter Quick Tunnel“).
   Fehlerhafte oder nur teilweise erledigte Dinge nennst du als solche.

4. **Sicherheit ist kein Extra.** Behandle jeden Upload und jeden Dateinamen als
   feindlich – und im Relay-Worker jeden Tunnel. Prüfe neue Ausgabewege auf gespeichertes
   XSS (HTML/SVG **niemals** inline ausliefern), Auth auf Timing/Brute-Force, Ressourcen auf
   Limits. Die Freigabe-Seiten haben `script-src 'none'` – verlass dich nicht auf Client-JS,
   es läuft dort keins.

5. **Deutsche UI-Texte müssen menschlich klingen**, nicht nach KI oder Behörde.
   Kurz, direkt, per „du“. Keine steifen Aufzählungs-Imperative in der Oberfläche.

6. **Zum Prinzip passen.** Bevor du ein Feature baust, das Dateien analysiert oder
   nach außen gibt: Stopp. Verletzt es die Datenhoheit, wird es nicht gebaut –
   erkläre stattdessen den lokalen/Notice-and-Takedown-Weg.

7. **Kein Scope-Wildwuchs.** Halte dich an die konkrete Aufgabe. Wenn du unterwegs
   ein echtes Problem findest, benenne es und frag, statt ungefragt umzubauen.

8. **Doku mitziehen.** Ändert sich, was Nutzer sehen oder tun, gehören README.md und
   README.de.md (gleiche Abschnitte, gleiche Medien) und die betroffene Datei in `docs/`
   dazu; `tests/repo-readme.test.mjs` prüft Parität und Links. Version und CHANGELOG
   (deutsch, *Neu*/*Geändert*/*Behoben*/*Entfernt*/*Sicherheit*, für Nutzer geschrieben)
   pflegt der Maintainer; `tests/repo-guards.test.mjs` verlangt einen Abschnitt für die
   Version aus `package.json`. Nach Änderungen an Abhängigkeiten
   `node scripts/third-party-notices.mjs` ausführen.

---

## 6. Fallen, die schon Zeit gekostet haben

- **Steuerzeichen in Regex-Literalen** (`/[\u0000-\u001f]/`) als rohe Bytes brechen
  Bash-Heredocs und das Edit-Tool. Immer als `\uXXXX`-Escapes schreiben.
- **Backslashes in Bash-Heredocs:** In einem ungequoteten Heredoc (`<<EOF`) macht die Shell
  (auch Git Bash) aus `\\` ein `\`. Code mit Backslashes mit dem Edit-Werkzeug schreiben
  oder den Heredoc quoten (`<<'EOF'`); in JavaScript hilft `String.raw`.
- **Quick Tunnel und `~/.cloudflared/config.yml`:** Ohne eigene Config liest cloudflared die
  Datei eines früher eingerichteten benannten Tunnels und übernimmt Zugangsdatei und
  Einstellungen; je nach Version verweigert es den Quick Tunnel dann ganz. Deshalb startet
  `tunnel.ts` ihn immer mit `--config <userData>/cloudflared-quick.yml`. Die Datei darf nicht
  leer sein (cloudflared meldet „was empty“), sie enthält `no-autoupdate: true`.
- **`api.trycloudflare.com` ist nicht die Tunnel-Adresse:** Die cloudflared-Ausgabe nennt auch
  den Vergabe-Dienst; `parseQuickTunnelUrl()` überspringt ihn. Der Relay nimmt nur
  `^https://[a-z0-9-]+\.trycloudflare\.com$` an.
- **Ein Quick Tunnel antwortet erst nach ein paar Sekunden.** Deshalb erst der Selbsttest
  gegen `<tunnel>/api/health`, dann die Anmeldung; 422 vom Relay heißt „noch nicht
  erreichbar“, nicht „kaputt“.
- **Relay-Pfade nur fürs eigene Gerät:** `routeSharePath()` liefert `foreign` für fremde
  Geräte-IDs. Wer neue Pfade einführt, muss sie in beiden Familien (`links.ts`) und im
  Worker-Router anlegen, sonst zeigen Bilder und Downloads beim Empfänger ins Leere.
- **Health-Kennung ist Protokoll:** `/api/health` muss `app: 'Foldwing'` und die Geräte-ID
  liefern, sonst lehnt der Relay die Anmeldung ab (422). Eine Umbenennung braucht vorher
  einen Worker, der beide Kennungen annimmt.
- **PowerShell und Registry-Pfade mit `*`:** `HKCU:\Software\Classes\*\shell\Foldwing`
  enthält ein `*`, das PowerShell als Platzhalter liest. Solche Pfade nur mit
  `-LiteralPath` ansprechen.
- **Test-Builds dürfen das System nicht umbiegen:** Ein entpackter Build aus
  `release/win-unpacked` darf Rechtsklick-Eintrag und Autostart nicht anfassen und prüft
  keine Updates, sonst zeigen sie danach auf den Test-Build. Dafür sorgen `isInstalledBuild()`
  in `index.ts` (gepackt, nicht portabel, Deinstallierer neben der Exe; unter Linux stabiler
  Installationspfad) und `decideUpdateMode()` – neue Systemeingriffe auch daran hängen.
- **winCodeSign ohne Entwicklermodus:** electron-builder lädt `winCodeSign-2.6.0.7z` (Releases
  von `electron-userland/electron-builder-binaries`) und entpackt es in seinen Cache
  (`%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\`); die macOS-Symlinks im Ordner
  `darwin` scheitern ohne Symlink-Recht. Lösung: Windows-Entwicklermodus einschalten oder das
  Archiv einmal von Hand ohne `darwin` nach `…\Cache\winCodeSign\winCodeSign-2.6.0\`
  entpacken, z. B. mit
  `node_modules\7zip-bin\win\x64\7za.exe x winCodeSign-2.6.0.7z -o<Zielordner> -xr!darwin`.
  Liegt der Ordner vollständig da, lädt electron-builder nichts mehr nach.
- **Das Update darf den Rechtsklick-Eintrag nicht löschen:** Ein Update startet zuerst den
  Deinstallierer der alten Version. `build/installer.nsh` räumt deshalb nur auf, wenn
  `${isUpdated}` falsch ist (so geschehen bis 1.3.0).
- **Release-Dateien gehören zusammen:** `latest.yml`, `latest-linux.yml` und die
  `.blockmap`-Dateien müssen am Release hängen, sonst finden installierte Apps keine Updates.
  `appId` und `nsis.guid` nie ändern, sonst installiert ein Update doppelt.
- **`asar list`** gibt unter Windows **Backslash**-Pfade aus – beim Grep beachten.
- **`xlsx`, `mammoth` und `electron-updater`** sind CommonJS → unter ESM liegt die API auf
  `default` (`import XLSX from 'xlsx'` bzw. `(await import('xlsx')).default`), nicht
  `import * as`.
- **electron-builder `files`** muss `node_modules/**/*` enthalten, sonst fehlen
  Produktions-Deps im asar (Vorschau schweigt dann in der EXE).
- **Preload wird als `index.mjs` gebaut** – im Main so referenzieren.
- **Cloudflare Email-Obfuscation** ersetzt E-Mails auf proxied Seiten per Skript;
  da unsere CSP Skripte blockt, `<!--email_off-->…<!--email_on-->` um Adressen setzen.
- Headless-Node-Tests werfen beim `process.exit` manchmal einen libuv-Assertion-
  Fehler **nach** der Ausgabe – die Check-Ergebnisse zählen, nicht der Exit-Krach.

---

## 7. Geheimnisse und private Dateien

Alles, was committet wird, ist für immer öffentlich. Nie in Code, Tests, Logs, Ausgaben,
Screenshots oder Commits:

- **`worker/relay/wrangler.toml`** – die lokale Deploy-Datei des Relays (Vorlage
  `wrangler.example.toml`), ignoriert, weil sie Datenbank-ID, Hostnamen und
  Betreiber-Angaben trägt. Ebenso eine alte `worker/wrangler.toml` und eine alte
  `resources/team.json`, falls sie noch herumliegen.
- **Geräte-Geheimnisse und echte Geräte-IDs** aus der Config; das Geheimnis liegt per
  `safeStorage` verschlüsselt, Fehlerausgaben nennen es nie.
- **Tunnel-Tokens** (`eyJ…`) und die Config aus `%APPDATA%\foldwing` – Fehlerausgaben
  nennen nur die Meldung (`logError`, `cloudflaredErrorLine()`), nie Tokens.
- **Cloudflare-API-Tokens** braucht weder die App noch der Relay. Wer für Deploys einen
  nutzt, hält ihn bei wrangler, nie im Repo.
- **`privat/`** – Arbeitsnotizen (Bauplan, Rechtliches) bleiben lokal.
- **Echte Daten:** Beispiele und Medien nur mit erfundenen Daten, Domain `example.com`,
  Nutzer „Alex“. Keine Klarnamen, privaten Mailadressen, Heimatpfade oder echten Domains.
  Ausnahme: der Standard-Relay `https://share.fynn.land` ist bewusst öffentlich.

`tests/repo-guards.test.mjs` sucht nach Schlüsselformaten, Heimatpfaden und prüft, dass
diese Dateien unverfolgt bleiben – das fängt nur die gröbsten Fälle.
