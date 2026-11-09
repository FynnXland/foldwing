# Releasing Foldwing

Status: Foldwing 1.4.3. For the maintainer. Every public step (tag, push, publishing a
release, relay deploy) happens only when the maintainer decides to.

Releases are built by GitHub Actions, never on a local machine: the workflow
[`.github/workflows/release.yml`](../.github/workflows/release.yml) builds the Windows and Linux
packages from exactly the tagged commit and attaches them to a release **draft**. Publishing
the draft is a manual step. Don't upload installers you built yourself; a local `release\`
folder may contain test builds or files that don't belong in public.

## 1. Version and changelog

1. Pick the version (SemVer for an app): major when using Foldwing or its data breaks,
   minor for a new feature, patch for fixes.
2. Set it without creating a tag yet; this updates `package.json` and `package-lock.json`:
   ```powershell
   npm version 1.5.0 --no-git-tag-version
   ```
3. Add a section to [CHANGELOG.md](../CHANGELOG.md): `## [1.5.0] - YYYY-MM-DD`, newest first,
   in German, written for people who use Foldwing (*Neu* (New), *Geändert* (Changed),
   *Behoben* (Fixed), *Entfernt* (Removed), *Sicherheit* (Security)), starting with one bold
   sentence about the most important change. The workflow copies this section into the
   release notes, so write it for the release page. `tests/repo-guards.test.mjs` fails if the
   version has no section.
4. Check the README in both languages ([README.md](../README.md),
   [README.de.md](../README.de.md)): features, sizes, test count and settings must match the
   new version. Rounded numbers ("about 138 MB") only change when the rounding does.

## 2. Check locally

```powershell
npm run typecheck
npm test
npm run dist:win
```

All three must pass. `dist:win` is the packaged smoke test, not the release: quit your
installed Foldwing first (a test build uses the same data folder and only one instance can
run), start `release\win-unpacked\Foldwing.exe`, share a test file, open
`http://localhost:8787/api/health` (expect `"app":"Foldwing"`) and the share link, then
delete the test share and quit. A test build from `win-unpacked` doesn't touch the right-click
entry, the autostart entry or the update check. Linux packages can be tried the same way with
`npm run dist:linux` on Linux, or `bash scripts/build-linux.sh` from a folder shared with
Windows.

## 3. Tag and let Actions build

Commit the version and the changelog on the default branch, then tag that commit and push the
tag:

```bash
git tag v1.5.0
git push origin v1.5.0
```

The workflow then

1. checks that the tag matches the version in `package.json` and that `CHANGELOG.md` has a
   section for it (otherwise it stops before building);
2. on `windows-latest`: `npm ci`, typecheck, tests, `npm run dist:win`;
3. on `ubuntu-latest`: `npm ci`, tests, `npm run dist:linux`;
4. collects all files, writes `SHA256SUMS.txt`, takes the release notes from the CHANGELOG
   section and creates the draft `Foldwing 1.5.0`. If a draft for the tag already exists, it
   replaces the files on it.

The workflow can also be started by hand (*Actions → Release → Run workflow*) with a tag that
already exists, for example to rebuild after a failed run.

## 4. Check the draft

Open the draft on the Releases page and check:

- **Files:** `Foldwing-<version>-Setup.exe`, `Foldwing-<version>-Portable.exe`,
  `Foldwing-<version>-linux.AppImage`, `Foldwing-<version>-linux-amd64.deb`, `latest.yml`,
  `latest-linux.yml`, the `.blockmap` files and `SHA256SUMS.txt`. The two `latest*.yml` files
  and the blockmaps must stay: the installed apps read them to find and verify updates.
- **Sizes:** Setup about 138 MB, Portable about 125 MB, AppImage about 150 MB, .deb about
  120 MB (1.4.0); a sudden jump means something new got packed.
- **Notes:** the CHANGELOG section, readable for users, without the version heading.
- If you can: download the Setup from the draft, compare its hash with `SHA256SUMS.txt`
  (`Get-FileHash <file> -Algorithm SHA256`) and install it over an existing installation.
  Shares and settings must still be there.

## 5. Publish

```bash
gh release edit v1.5.0 --draft=false
gh release view v1.5.0 --json tagName,isDraft,isPrerelease,assets
```

Once the release is published, installed apps with *Automatisch nach Updates suchen* find it
within 6 hours: the Windows installer and the AppImage update themselves, the portable app and
the .deb show a note with a link to the release. A draft or a prerelease is never offered as
an update.

After the release, compare the repository's *About* text and the README with what the release
contains.

## Relay changes

The relay (`worker/relay/`) is deployed separately, with your local, untracked
`worker/relay/wrangler.toml` ([worker/relay/README.md](../worker/relay/README.md)):

```powershell
cd worker/relay
npx wrangler deploy
```

Variables must be in `wrangler.toml`, because a deploy replaces the variables set in the
dashboard. `tests/relay-worker.test.ts` tests the worker as part of `npm test`; type check it
with `npx tsc --noEmit -p worker/relay`. Logs are off on purpose.

Order matters when app and relay change together. Installed apps update over hours or days,
and some never do:

- If the relay starts to **require** something new from the app, older apps can't register
  any more and their links go offline. Avoid that; accept the old form alongside the new one.
- If the app starts to **use** something new from the relay, deploy the relay first, then
  release the app.

## Dependencies

Dependabot only updates the GitHub Actions. Update npm packages by hand, then run
`node scripts/third-party-notices.mjs` to regenerate
[THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md); `npm test` fails while it is out of date.
A new cloudflared version goes into `scripts/fetch-cloudflared.mjs` (version and both
SHA-256 values), followed by the same script.
