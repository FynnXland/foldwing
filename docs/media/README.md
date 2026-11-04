# README media

Status: Foldwing 1.4.0.

The GIF and the screenshots used in the project README. All of them come from
`make_media.mjs` in this folder. The script runs Foldwing's real interface and its real
share server with invented sample data, renders them off-screen at 2x resolution and
turns the frames into a GIF with ffmpeg. Nothing here is a screen recording.

| File | What it shows |
|---|---|
| `hero.gif` | Three files dropped onto the drop zone become one collection, the progress bar runs, the finished card shows its `foldwing.online` link, *Link kopieren* (Copy link) turns into *Kopiert* (Copied). Then the page the recipient sees in the browser: the collection with preview tiles and *Alle als ZIP herunterladen* (Download all as ZIP), and `Quartalszahlen.xlsx` opened as a table. About 11 seconds, 20 fps |
| `app.png` | Main window in the light theme, *Teilen* (Share) tab: the status line (*Links über foldwing.online · erreichbar*), the drop zone and three shares: the collection with thumbnails, a text file without expiry and a screenshot link with 23 hours left |
| `share-page.png` | The recipient's page for the collection (light) |
| `file-preview.png` | The recipient's view of the spreadsheet, dark: the page follows the system's dark mode |
| `social-preview.png` | GitHub social preview (1280×640), uploaded by hand in the repository settings (*General → Social preview*) |
| `logo.svg` | The app logo, taken from `scripts/make-icon.mjs`, which also builds the app icon from it |

The GIF and the screenshots are rendered at 2x: show the GIF with `width="760"` and the
screenshots with `width="838"`.

## The data is invented

- The script generates every file itself: `Moodboard.png` and `Grundriss.png` are drawn
  shapes, `Quartalszahlen.xlsx` holds made-up figures, plus `Notizen.txt` and
  `Screenshot 2026-10-14 09-12-48.png`. The user is "alex". Links use the default relay
  address `https://foldwing.online/` followed by an invented device ID (`Rk4mT7qa`) and the
  share ID.
- Clock and IDs are fixed (14 October 2026, 09:41; share IDs come from a seeded random
  source), so every run produces the same images.
- Real: the interface and its preload bridge as built by `npm run build`, the share store
  and the HTTP server from `src/main/`, including the table preview. In the GIF the files
  go through the app's own upload code, and every progress step is a real state of that
  upload.
- Staged: the main process is a stand-in that answers the interface's calls and skips
  the virus scan, the tunnel and the relay. It reports the links as online
  (*erreichbar*); nothing is sent to `foldwing.online`. The recipient pages come from the
  real server on 127.0.0.1 under the same paths the relay would pass through. The window buttons, the mouse pointer, the drag image
  with the "3" badge and the browser bar around the recipient pages are demo elements
  drawn by the script; in real use Windows and the browser draw them. *Kopieren* does
  not touch the real clipboard while rendering, and CSS transitions are off so each
  frame shows a settled state.
- The interface is German, so the images show German labels.
- GIF time is stretched: the upload takes a fraction of a second, the GIF holds each step
  long enough to read it.

## Regenerating

Run this from the repository root. ffmpeg has to be on the `PATH`, or set the `FFMPEG`
environment variable.

```
npm run build && npm run media
npm run media -- --keep         # keep the temp folder with the frames and the sample store
npm run media -- --port 8017    # fixed port for the server instead of one the system picks
npm run media -- --site <dir>   # also write images for a project page outside the repo
```

`--site` writes `background.webp` (1920×1200), a short loop of the GIF's frames
(`media/teilen.webm`, `.mp4`, 1280×800, with a poster) and three stills (`media/*.webp`,
1600×1000) into `<dir>`. Nothing of it lands in `docs/media`.

The script stops if the build in `out/` is older than `src/renderer` or `src/preload`.
It has been run on Windows.

It never touches your own Foldwing data. Before Electron starts, `APPDATA`,
`LOCALAPPDATA`, `USERPROFILE`, `HOME`, `XDG_*` and `TEMP` point to a fresh temporary
folder and the user name is "alex"; the script stops if any of Electron's data paths lies
outside that folder. To keep that folder somewhere specific, point `TEMP` (and `TMP`) there
before you start the script. Foldwing's real main process does not run, so your settings, the
tunnel and the relay stay untouched. No window appears on screen, the server
listens on 127.0.0.1 only, every other request is blocked, and nothing opens in the
system browser.
