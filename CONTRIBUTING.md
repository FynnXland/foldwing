# Contributing to Foldwing

Thanks for your interest in Foldwing. Bug reports and ideas are welcome, in English or German
(*Deutsch ist genauso willkommen*).

Foldwing is maintained by one person. **Pull requests only after we have agreed on them in an
issue:** describe the problem and your idea first, so nobody spends time on a change that
doesn't fit.

- **Bugs and ideas:** use the [issue forms](https://github.com/FynnXland/foldwing/issues/new/choose).
- **Security problems:** report them privately, see [SECURITY.md](SECURITY.md).
- **How the code is organised:** [docs/architecture.md](docs/architecture.md).

## Development setup

Windows 10 or 11 or a Linux x64 desktop, with [Git](https://git-scm.com) and a current
[Node.js](https://nodejs.org) LTS release (CI uses `lts/*`).

```powershell
git clone https://github.com/FynnXland/foldwing.git
cd foldwing
npm ci
npm run dev          # starts the app from source
```

- **Quit an installed Foldwing first** (tray icon → *Beenden* (Quit)). A run from source uses
  the same data folder (`%APPDATA%\foldwing`, on Linux `~/.config/foldwing`) with the same
  shares and settings, and only one instance can run: otherwise `npm run dev` just brings up
  the installed app's window.
- Runs from source don't register the right-click entry or the autostart entry and never check
  for updates. Only the installed app registers those entries.
- **Internet links from source** register with the public relay `share.fynn.land` like the
  installed app. To work against a relay of your own, for example `npx wrangler dev` in
  `worker/relay`, set `FOLDWING_RELAY_URL` before `npm run dev`. Details:
  [docs/relay.md](docs/relay.md).
- **cloudflared** is only bundled into packaged builds. To try a tunnel from source, run
  `node scripts/fetch-cloudflared.mjs` (it lands in `resources/`), or install it with
  `winget install Cloudflare.cloudflared`.
- **Linux:** `npm ci` and `npm run dist:linux` build an AppImage and a .deb. If the project
  folder is shared with Windows, use `bash scripts/build-linux.sh` instead: it builds in its own
  copy under `~/.cache/foldwing-linux-build`, so the folder keeps its Windows `node_modules`.

## Tests

```powershell
npm run typecheck
npm test
```

- `npm test` bundles every `tests/*.test.ts` and `*.test.mjs` with esbuild and runs them with
  `node --test`: about 300 tests, usually in under a minute. Both commands must pass.
  `FOLDWING_TEST_OUT=<name>` gives a run its own output folder, and
  `node scripts/test.mjs relay` runs only the files with "relay" in their name.
- Electron isn't loaded in tests, so testable logic lives in electron-free modules, such as
  `src/main/sharing-policy.ts` next to `index.ts`. New logic in the main process gets its own
  `tests/<topic>.test.ts`.
- External services are replaced: the relay worker runs against a fake store and stubbed
  tunnels (its SQL against `node:sqlite`), the relay client gets a `fetch` stub, the scanner
  tests use a Node process with a chosen exit code, and timers are mocked where needed. Nothing
  talks to Cloudflare or the public relay. Server and store tests work on temporary folders; one ZIP test also
  unpacks with PowerShell's `Expand-Archive` and is skipped where that is missing.
- `tests/repo-guards.test.mjs` scans the repository for keys, home paths and the license files;
  `tests/repo-readme.test.mjs` checks that both READMEs match and that local links work.
- **Every new behaviour needs a test.** A bug fix comes with a test that fails without the fix.
- **Main-process changes** also need a packaged check: `npm run dist:win`, then start
  `release\win-unpacked\Foldwing.exe` at least once and share a file. Such test builds never
  touch the right-click entry or the autostart entry.
- GitHub Actions runs typecheck, tests and build on Windows for every pull request and every
  push to `main` ([.github/workflows/tests.yml](.github/workflows/tests.yml)). Release builds
  for Windows and Linux come from [.github/workflows/release.yml](.github/workflows/release.yml).

## Code conventions

- **Language:** identifiers are English; code comments, commit messages and the
  [CHANGELOG](CHANGELOG.md) are German. UI texts are German, short and direct, addressing the
  user as *du*, with proper umlauts.
- **Main process and renderer:** the renderer (`src/renderer/`) has no Node or file access and
  only talks to the main process through `window.foldwing` from `src/preload/index.ts`.
- **Platform-specific code** goes through the helpers in `src/main/platform.ts` (`isWindows`,
  `isLinux`, …), not through scattered `process.platform` checks. New features must work on
  Windows and degrade cleanly on Linux.
- **Treat every file and every file name as hostile.** Share pages run no JavaScript
  (`script-src 'none'`); never serve HTML or SVG inline, and keep the sanitizer for library HTML
  in `src/main/preview.ts`.
- **Foldwing's principles:** file contents never go to third-party services (no cloud OCR, no
  AI, no online viewers; the relay only passes pages through and redirects downloads to the
  sharing PC); a download is always bit-identical to the original; running Foldwing must not
  require a paid server. Ideas that break these won't be merged.
- **Dependencies:** runtime packages go into `dependencies`, tools into `devDependencies`. After
  changing them, run `node scripts/third-party-notices.mjs`; the tests fail while
  [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) is out of date, and the script refuses
  licenses that aren't permissive (no GPL).
- **UI changes:** attach a before/after screenshot to the pull request, made with sample data.

## Privacy

Everything committed is public forever, including the history of a branch you delete later.
Never commit, not in code, tests, screenshots or commit messages:

- `worker/relay/wrangler.toml` (your relay's database ID and operator details) or anything
  from your Foldwing data folder;
- tunnel tokens (they start with `eyJ`), device secrets, Cloudflare API tokens or other keys;
- real shared files, real links or device IDs, your own domain if it should stay private;
- user names, local paths and screenshots with real data. Test data is made up; examples use
  `example.com` and the user "Alex".

`tests/repo-guards.test.mjs` catches common key formats and home paths, but only the worst cases.

## Versions, changelog and building

The maintainer raises the version in `package.json` and writes the CHANGELOG entry; please
don't change either in a pull request. Describe in the pull request what changes for someone
who *uses* Foldwing instead; that text becomes the changelog entry.

`npm run dist:win` builds the installer and the portable app into `release\`,
`npm run dist:linux` the AppImage and the .deb into `release/`. Both download cloudflared in a
fixed version and check its SHA-256. If electron-builder fails while extracting `winCodeSign`
with a symlink error, turn on Developer Mode in the Windows settings (*For developers*).
Official releases are built by GitHub Actions and published by the maintainer
([docs/releasing.md](docs/releasing.md)).

## AI coding agents

[CLAUDE.md](CLAUDE.md) holds the instructions the maintainer gives AI coding agents (in German).
It contains the same rules as this guide plus pitfalls that have cost time before, and nothing
that only applies to the maintainer's machine. If you work with an agent, point it there.

## License

Foldwing is licensed under the [MIT License](LICENSE). Unless you explicitly state otherwise,
any contribution you submit for inclusion in Foldwing is licensed under the MIT License as
well, without additional terms or conditions.
