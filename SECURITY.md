# Security policy

## Supported versions

Only the [latest release](https://github.com/FynnXland/foldwing/releases/latest) gets
security fixes. The Windows installer and the AppImage update themselves; the portable app and
the .deb show a note when a new version is out. If you build from source, use the current
`main` branch. Foldwing 1.4.0 is built on Electron 45.

## Reporting a vulnerability

**Please don't open a public issue for security problems.** Report them privately via GitHub:
[**Report a vulnerability**](https://github.com/FynnXland/foldwing/security/advisories/new)
(also on the repository's *Security* tab). This covers the app and the relay code in
`worker/relay/`, including weaknesses of the public relay `foldwing.online` itself.

Helpful to include:

- the Foldwing version and your operating system. Foldwing shows its version in the settings
  (gear icon) on the card *Über Foldwing* (About Foldwing).
- the link mode you use (*Internet*, *Nur im eigenen Netzwerk* or *Eigene Domain*)
- what an attacker can do, and under which conditions
- steps to reproduce, ideally a minimal proof of concept
- whether you'd like to be credited in the advisory

Please leave out real files, links to real shares, tunnel tokens, device secrets and other
personal data, even in a private report. Don't test against other people's links or devices on
the public relay; run your own relay for that ([docs/relay.md](docs/relay.md)).

Foldwing is maintained by one person in their spare time, so responses are best effort. You
can expect an acknowledgement within 7 days. Once a fix is released, the advisory is published
and you are credited if you want to be.

## Reporting abuse

A link on `foldwing.online` with illegal content is not a security problem. Use *Melden*
(Report) at the bottom of the shared page, or open `https://foldwing.online/_/melden`. The
operator checks every report and blocks the link or the device if it is justified. Please
don't report content through GitHub issues or security advisories.

## Scope

Foldwing runs a web server on your PC that anyone with a link can reach, it renders files of
any origin as previews, and in its default mode it registers with a public relay. Reports about
these areas are especially welcome:

- **Share pages** ([`src/main/server.ts`](src/main/server.ts),
  [`src/main/pages.ts`](src/main/pages.ts)): HTML pages are built on the server and sent with a
  `Content-Security-Policy` that includes `script-src 'none'`, `base-uri 'none'` and
  `form-action 'none'`; names are HTML-escaped. Share, file and device IDs are random base62
  strings (10, 6 and 8 characters); links have no password. Running script on a share page's
  origin, or opening a share without its link, is in scope.
- **Downloads:** HTML, XHTML, SVG, `text/xml` and `application/xml` are always sent as an
  attachment. Every raw response except PDFs carries
  `Content-Security-Policy: sandbox allow-downloads`, and `X-Content-Type-Options: nosniff` is
  set. A file that still runs as a page is in scope.
- **Previews** ([`src/main/preview.ts`](src/main/preview.ts)): Word (mammoth) and Excel/CSV
  (SheetJS `xlsx`) content is turned into HTML and then passes an allowlist sanitizer built
  on a tokenizer: only table and text tags remain, without any attributes, and a second check
  falls back to plain text. Limits: 30 MB for Word, 20 MB for spreadsheets, 3 MB of text shown,
  2 MB of generated HTML. Previews are computed one at a time and cached. A sanitizer bypass,
  or a file that makes the preview hang Foldwing, is in scope.
- **The relay** ([`worker/relay/`](worker/relay/README.md), [docs/relay.md](docs/relay.md)):
  it treats every tunnel as hostile. It accepts only `https://<label>.trycloudflare.com`
  addresses that answer the health check with the right device ID, passes pages through to
  fixed paths of that one tunnel, redirects raw data there, filters request and response
  headers through allowlists, strips `<meta http-equiv>`, `<link>` and `<base>` from pages and
  never follows redirects from a tunnel. Using the relay as an open proxy or open redirect, for
  phishing on its origin, taking over another device's ID, making it store data it shouldn't
  (IP addresses, file names), or getting around blocks is in scope.
- **Relay registration** ([`src/main/relay.ts`](src/main/relay.ts)): a device proves itself
  with a 32-byte secret; the relay stores only its SHA-256 hash and compares in constant time.
  On the PC the secret is encrypted with Electron's `safeStorage`; on Linux without a keyring
  it is stored as base64 and marked as unencrypted.
- **Uploads** only come from the app itself (the window, the right-click entry, screenshots);
  the server has no upload endpoint. Files are stored under random IDs, never under their
  original name. Virus scanning is fail-open: without a scanner, on a scanner error or after 5
  minutes, a file is shared without a scan result.
- **Updates** ([`src/main/updater.ts`](src/main/updater.ts)): electron-updater reads
  `latest.yml` and `latest-linux.yml` from the GitHub releases of this repository over HTTPS
  and checks the download against the SHA-512 in that file. The packages are not code-signed,
  so there is **no signature check**: whoever can publish a release in this repository can
  deliver code to every installation that updates itself. Releases are built by GitHub Actions
  from the tagged commit and published by hand.
- **Tunnel token** (own domain only): stored in plain text in the settings file
  (`%APPDATA%\foldwing\foldwing-config.json`). Anyone who can read that file can run your
  tunnel.
- **The app window** ([`src/main/index.ts`](src/main/index.ts)): it can't navigate away from
  its own interface, and links open in the default browser, `http` and `https` only. The
  interface reaches the main process only through the preload bridge.
- **Local files:** the data folder (shares, settings), the right-click entry and the autostart
  entry, and the installer.

## Out of scope

- The SmartScreen warning: the packages are not code-signed.
- Antivirus false positives. Please report them to the antivirus vendor; an issue here is still
  welcome so others can find it.
- Vulnerabilities in Electron, cloudflared, Cloudflare's network, mammoth or SheetJS
  themselves. Please report them upstream. If Foldwing uses one of them unsafely, that is in
  scope.
- The known prototype-pollution and ReDoS issues of the `xlsx` package from npm (0.18.5), which
  Foldwing bundles. They lie in parsing and are only mitigated: parsing only happens for
  spreadsheets the user of that PC chose to share, up to 20 MB; the sanitizer only cleans the
  HTML output.
- That traffic through a Cloudflare Tunnel, Quick Tunnels included, is decrypted at
  Cloudflare: this is how tunnels work, and the README says so.
- That the sharing PC sees the IP address of a recipient who downloads a file: downloads come
  from that PC directly, as the README says.
- Load on the public relay (flooding, many registrations). Rate limits exist; report a way
  around them, not the load itself.
- Attacks that require an attacker who already controls the user account, for example reading
  the tunnel token from the settings file.
