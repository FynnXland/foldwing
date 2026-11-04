// HTML der Worker-eigenen Seiten: Info, Melden, offline, gesperrt, Fehler.
// Ohne JavaScript, im Stil der Foldwing-Freigabe-Seiten (Farben, Kopfzeile),
// Systemschrift statt Geist – die Schriften liegen nur auf den Rechnern der App.
// Texte aus der Rechtsprüfung; Links und Kontakt kommen aus Worker-Variablen.

import type { Env } from './env'

export function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Nur https-Links (oder relative Pfade) aus der Konfiguration übernehmen. */
export function safeLink(value: string | undefined): string | null {
  const v = (value ?? '').trim()
  if (!v) return null
  if (v.startsWith('/') && !v.startsWith('//')) return v
  try {
    const u = new URL(v)
    return u.protocol === 'https:' ? u.href : null
  } catch {
    return null
  }
}

function safeEmail(value: string | undefined): string | null {
  const v = (value ?? '').trim()
  return /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/.test(v) ? v : null
}

export interface Operator {
  email: string | null
  imprint: string | null
  privacy: string | null
  terms: string | null
  source: string | null
}

export function operatorFrom(env: Env): Operator {
  return {
    email: safeEmail(env.CONTACT_EMAIL),
    imprint: safeLink(env.IMPRINT_URL),
    privacy: safeLink(env.PRIVACY_URL),
    terms: safeLink(env.TERMS_URL),
    source: safeLink(env.SOURCE_URL)
  }
}

/** Was jede Seite über die Anfrage wissen muss. */
export interface PageCtx {
  op: Operator
  /** Hostname, z. B. share.example.com */
  host: string
  /** Ursprung, z. B. https://share.example.com */
  origin: string
}

/** Link, wenn eine Adresse da ist – sonst nur der Text. */
function linkOr(text: string, href: string | null): string {
  return href ? `<a href="${escapeHtml(href)}">${text}</a>` : text
}

/** Kontaktadresse geschützt vor Cloudflares E-Mail-Verschleierung (braucht Skript). */
function emailHtml(email: string): string {
  return `<!--email_off--><code>${escapeHtml(email)}</code><!--email_on-->`
}

/** Datum auf Deutsch, z. B. „3. November 2026“. */
export function formatDate(ms: number): string {
  try {
    return new Date(ms).toLocaleDateString('de-DE', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'Europe/Berlin'
    })
  } catch {
    return new Date(ms).toISOString().slice(0, 10)
  }
}

// Gleiche Papierflieger-Marke wie in der App (src/main/brand.ts), mit eigener Kachel.
const LOGO_SVG = `<svg width="26" height="26" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect width="120" height="120" rx="26" fill="#2563eb"/><path d="M106 18 L8 56 L42 70 L64 77 Z" fill="#ffffff"/><path d="M106 18 L64 77 L58 110 Z" fill="#c3d6ff"/><path d="M42 70 L64 77 L58 110 Z" fill="#1a3d9c"/></svg>`

/* Dieselben Farb-Token wie die Freigabe-Seiten der App (src/main/pages.ts). */
const CSS = `
  :root {
    --accent: #2e6ff2; --accent-hover: #1f57d6; --accent-soft: #eef4ff;
    --bg-base: #f6f8fa; --surface-card: #ffffff;
    --border-subtle: #e5e9ee; --border-default: #d8dee6;
    --text-primary: #151a20; --text-secondary: #4c5763; --text-tertiary: #6b7684;
    --shadow-md: 0 4px 12px rgba(21,26,32,.07), 0 1px 3px rgba(21,26,32,.06);
    --font-sans: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    --font-mono: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
    color-scheme: light;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --accent: #5c86f8; --accent-hover: #8fb0ff; --accent-soft: rgba(46,111,242,.18);
      --bg-base: #0c0f13; --surface-card: #151a20;
      --border-subtle: rgba(255,255,255,.07); --border-default: rgba(255,255,255,.12);
      --text-primary: #eef1f5; --text-secondary: #98a2b0; --text-tertiary: #8a94a2;
      --shadow-md: 0 4px 14px rgba(0,0,0,.5), 0 1px 3px rgba(0,0,0,.4);
      color-scheme: dark;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; background: var(--bg-base); color: var(--text-primary);
    font-family: var(--font-sans); font-size: 15px; line-height: 1.6;
  }
  .topbar {
    display: flex; align-items: center; height: 60px; padding: 0 24px;
    border-bottom: 1px solid var(--border-subtle); background: var(--surface-card);
  }
  .brand { display: flex; align-items: center; gap: 10px; color: inherit; text-decoration: none; }
  .brand__logo { width: 26px; height: 26px; display: grid; flex-shrink: 0; }
  .brand__name { font-size: 19px; font-weight: 600; letter-spacing: -0.02em; }
  .wrap { max-width: 680px; margin: 0 auto; padding: 32px 20px 48px; }
  .card {
    background: var(--surface-card); border: 1px solid var(--border-subtle);
    border-radius: 16px; box-shadow: var(--shadow-md); padding: 28px 30px;
  }
  .eyebrow {
    font-family: var(--font-mono); font-size: 11px; text-transform: uppercase;
    letter-spacing: .06em; color: var(--text-tertiary); margin: 0 0 6px;
  }
  h1 { margin: 0 0 12px; font-size: 24px; font-weight: 600; letter-spacing: -0.01em; line-height: 1.25; }
  h2 { margin: 22px 0 6px; font-size: 16px; font-weight: 600; }
  p, li { color: var(--text-secondary); }
  p { margin: 0 0 10px; }
  ol { margin: 0 0 12px; padding-left: 22px; }
  li { margin: 2px 0; }
  strong { color: var(--text-primary); font-weight: 600; }
  a { color: var(--accent); }
  a:hover { color: var(--accent-hover); }
  code {
    font-family: var(--font-mono); font-size: 13px; word-break: break-all;
    background: var(--accent-soft); padding: 2px 6px; border-radius: 6px; color: var(--text-primary);
  }
  .btn {
    display: inline-flex; align-items: center; height: 42px; padding: 0 18px; margin: 4px 0 12px;
    border-radius: 12px; background: var(--accent); color: #ffffff; font-weight: 500;
    text-decoration: none;
  }
  .btn:hover { background: var(--accent-hover); color: #ffffff; }
  .foot { color: var(--text-tertiary); font-size: 12.5px; margin-top: 26px; text-align: center; }
  .foot a { color: var(--text-tertiary); text-decoration: none; }
  .foot a:hover { text-decoration: underline; }
  @media (prefers-color-scheme: dark) { .btn, .btn:hover { color: #0c0f13; } }
  @media (max-width: 620px) {
    .topbar { padding: 0 16px; }
    .wrap { padding: 20px 12px 36px; }
    .card { padding: 22px 18px; border-radius: 12px; }
    h1 { font-size: 21px; }
    .btn { width: 100%; justify-content: center; }
  }
`

/** Fußzeile: Über · Impressum · Datenschutz · Regeln · Melden (fehlende Links fallen weg). */
function footer(ctx: PageCtx, token?: string | null): string {
  const { op } = ctx
  const links = [`<a href="/_/">Über ${escapeHtml(ctx.host)}</a>`]
  if (op.imprint) links.push(`<a href="${escapeHtml(op.imprint)}">Impressum</a>`)
  if (op.privacy) links.push(`<a href="${escapeHtml(op.privacy)}">Datenschutz</a>`)
  if (op.terms) links.push(`<a href="${escapeHtml(op.terms)}">Regeln</a>`)
  links.push(`<a href="/_/melden${token ? `?l=${encodeURIComponent(token)}` : ''}">Melden</a>`)
  return `<div class="foot">${links.join(' · ')}</div>`
}

function layout(ctx: PageCtx, title: string, body: string, token?: string | null): string {
  return `<!doctype html>
<html lang="de"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head><body>
  <header class="topbar">
    <a class="brand" href="/_/"><span class="brand__logo">${LOGO_SVG}</span><span class="brand__name">Foldwing</span></a>
  </header>
  <main class="wrap">
    <div class="card">
${body}
    </div>
    ${footer(ctx, token)}
  </main>
</body></html>`
}

/** Info-Seite `/_/`. */
export function infoPage(ctx: PageCtx): string {
  const { op } = ctx
  const h = escapeHtml(ctx.host)
  const contact = op.email
    ? `<p>${emailHtml(op.email)}</p>
      <p>Über diese Adresse erreichst du mich für alles rund um den Relay, auch als Behörde. Ich lese
      sie selbst und antworte auf Deutsch oder Englisch.</p>`
    : `<p>Hier ist noch keine Kontaktadresse hinterlegt.</p>`
  const app = op.source
    ? `Foldwing gibt es kostenlos auf ${linkOr('GitHub', op.source)}.`
    : 'Foldwing gibt es kostenlos als Open-Source-App.'
  return layout(
    ctx,
    `Über ${ctx.host}`,
    `      <div class="eyebrow">Über ${h}</div>
      <h1>Dateien teilen, die bei dir bleiben</h1>
      <p>${h} ist der Relay für Foldwing, eine kostenlose Open-Source-App für Windows und
      Linux. Du ziehst eine Datei in die App und bekommst einen Link. Wer ihn öffnet, lädt die Datei
      direkt von deinem Rechner.</p>
      <p>Der Relay reicht dabei nur durch. Er speichert keine Dateien und schaut nicht hinein. Er merkt
      sich bloß, unter welcher Adresse dein Rechner gerade erreichbar ist. Ist der Rechner aus, geht
      auch der Link nicht.</p>

      <h2>Wer das betreibt</h2>
      <p>Ich betreibe den Relay privat und ohne Geld dafür zu nehmen. Wer ich bin, steht im
      ${linkOr('Impressum', op.imprint)}.</p>

      <h2>Regeln und Datenschutz</h2>
      <p>Was erlaubt ist und was ich bei Verstößen tue, steht in den ${linkOr('Regeln', op.terms)}. Welche
      Daten anfallen, steht im ${linkOr('Datenschutz', op.privacy)}. Kurz: keine Konten, keine Cookies,
      keine Protokolle über dich.</p>

      <h2>Etwas stimmt nicht?</h2>
      <p>Wenn du über einen Link hier auf etwas Rechtswidriges stößt: <a href="/_/melden">Link melden</a>.</p>

      <h2>Kontakt</h2>
      ${contact}

      <h2>Die App</h2>
      <p>${app} Wer den Relay nicht nutzen will, kann Links auch nur im eigenen Netzwerk oder über
      eine eigene Domain teilen.</p>`,
    null
  )
}

/** mailto-Vorlage der Melde-Seite (Betreff und Text, noch nicht kodiert). */
export function reportMail(ctx: PageCtx, token: string | null): { subject: string; body: string } {
  const link = token ? `${ctx.origin}/${token}` : ''
  return {
    subject: token ? `Meldung ${ctx.host}: ${token}` : `Meldung ${ctx.host}`,
    body:
      `Link: ${link}\n\n` +
      'Was ist daran rechtswidrig, und warum?\n\n\n' +
      'Mein Name:\n' +
      'Meine Mailadresse:\n' +
      '(Bei Missbrauchsdarstellungen von Kindern kannst du beides weglassen.)\n\n' +
      'Ich bin in gutem Glauben überzeugt, dass meine Angaben richtig und vollständig sind.\n'
  }
}

/** Melde-Seite `/_/melden?l=<T>`. `token` ist bereits geprüft (oder null). */
export function reportPage(ctx: PageCtx, token: string | null): string {
  const { op } = ctx
  const reported = token
    ? `<p><strong>Gemeldeter Link:</strong> <code>${escapeHtml(`${ctx.origin}/${token}`)}</code></p>`
    : ''
  let how: string
  if (op.email) {
    const mail = reportMail(ctx, token)
    const href = `mailto:${op.email}?subject=${encodeURIComponent(mail.subject)}&body=${encodeURIComponent(mail.body)}`
    how = `<p>Schick eine Mail an <strong>${emailHtml(op.email)}</strong>. Am schnellsten mit diesem
      Knopf, dann ist alles schon vorbereitet:</p>
      <!--email_off--><a class="btn" href="${escapeHtml(href)}">Meldung per Mail schreiben</a><!--email_on-->
      <p>Wenn sich kein Mailprogramm öffnet, kopier die Adresse oben und schreib mir das hier:</p>`
  } else {
    how = `<p>Hier ist noch keine Kontaktadresse hinterlegt. Wenn du eine Adresse des Betreibers
      kennst, schreib dorthin:</p>`
  }
  return layout(
    ctx,
    'Link melden',
    `      <div class="eyebrow">Melden</div>
      <h1>Link melden</h1>
      <p>Du bist über einen Link hier auf etwas gestoßen, das gegen das Gesetz verstößt? Schreib mir.
      Ich prüfe jede Meldung selbst und sperre den Link, wenn sie zutrifft.</p>
      ${reported}

      <h2>So geht's</h2>
      ${how}
      <ol>
        <li>den Link,</li>
        <li>was daran rechtswidrig ist, und warum,</li>
        <li>deinen Namen und deine Mailadresse,</li>
        <li>den Satz: „Ich bin in gutem Glauben überzeugt, dass meine Angaben richtig und vollständig sind.“</li>
      </ol>
      <p>Geht es um deine eigenen Rechte, etwa an einem Foto oder Film, sag kurz dazu, wie du sie
      belegen kannst.</p>

      <h2>Bei Missbrauchsdarstellungen von Kindern</h2>
      <p>Du musst keinen Namen angeben. Lade die Datei bitte nicht herunter und schick sie nicht mit;
      der Link reicht. Du kannst das auch direkt bei der Polizei anzeigen.</p>
      <p><strong>Wenn jemand in Gefahr ist:</strong> Ruf 110 an.</p>

      <p>Was ich mit deiner Meldung mache, steht im ${linkOr('Datenschutz', op.privacy)}.</p>`,
    token
  )
}

export function offlinePage(ctx: PageCtx, token: string | null): string {
  return layout(
    ctx,
    'Gerade nicht erreichbar',
    `      <div class="eyebrow">Nicht erreichbar</div>
      <h1>Der Rechner, auf dem diese Datei liegt, ist gerade nicht online.</h1>
      <p>Die Datei liegt nicht hier, sondern direkt bei der Person, die sie geteilt hat. Versuch es
      später noch mal oder sag ihr Bescheid.</p>`,
    token
  )
}

/** Sperrgrund für die Seite: höchstens 200 Zeichen, escaped beim Einsetzen. */
function cleanReason(reason: string | null | undefined): string | null {
  const r = (reason ?? '').trim()
  return r ? r.slice(0, 200) : null
}

export function blockedPage(
  ctx: PageCtx,
  token: string,
  block: { reason: string | null; at: number | null } | null | undefined
): string {
  const { op } = ctx
  const reason = cleanReason(block?.reason)
  const when = block?.at ? `am ${escapeHtml(formatDate(block.at))} ` : ''
  const why = reason ? ` Grund: ${escapeHtml(reason)}${/[.!?]$/.test(reason) ? '' : '.'}` : ''
  const link = escapeHtml(`${ctx.origin}/${token}`)
  const objection = op.email
    ? `<p>Hast du den Link geteilt und hältst die Sperre für falsch? Schreib mir an ${emailHtml(op.email)}
      und nenn diesen Link: <code>${link}</code>. Ich schaue es mir noch einmal an.</p>`
    : `<p>Hast du den Link geteilt und hältst die Sperre für falsch? Schreib dem Betreiber und nenn
      diesen Link: <code>${link}</code>. Ich schaue es mir noch einmal an.</p>`
  return layout(
    ctx,
    'Link gesperrt',
    `      <div class="eyebrow">Gesperrt</div>
      <h1>Dieser Link wurde gesperrt.</h1>
      <p>Ich habe ihn ${when}gesperrt.${why}</p>
      ${objection}`,
    null
  )
}

export function notFoundPage(ctx: PageCtx): string {
  return layout(
    ctx,
    'Nicht gefunden',
    `      <div class="eyebrow">Nicht gefunden</div>
      <h1>Hier ist nichts.</h1>
      <p>Diese Adresse gibt es nicht. Schau nach, ob der Link vollständig ist – er ist ziemlich
      lang, da geht beim Kopieren schnell ein Stück verloren.</p>`
  )
}

export function methodPage(ctx: PageCtx): string {
  return layout(
    ctx,
    'Geht nicht',
    `      <div class="eyebrow">Geht nicht</div>
      <h1>Das geht hier nicht.</h1>
      <p>Diese Adresse kann man nur öffnen, nicht beschreiben.</p>`
  )
}

export function badGatewayPage(ctx: PageCtx, token: string | null): string {
  return layout(
    ctx,
    'Fehler',
    `      <div class="eyebrow">Fehler</div>
      <h1>Da ist etwas schiefgelaufen.</h1>
      <p>Der Rechner, auf dem die Datei liegt, hat eine Antwort geschickt, mit der wir nichts
      anfangen können. Versuch es später noch mal.</p>`,
    token
  )
}

export function unavailablePage(ctx: PageCtx): string {
  return layout(
    ctx,
    'Kurz nicht erreichbar',
    `      <div class="eyebrow">Kurz nicht erreichbar</div>
      <h1>Gerade klemmt es hier.</h1>
      <p>Das liegt nicht an dir und nicht an der Datei. Versuch es in ein paar Minuten noch mal.</p>`
  )
}

export function tooManyPage(ctx: PageCtx): string {
  return layout(
    ctx,
    'Zu viele Aufrufe',
    `      <div class="eyebrow">Langsam</div>
      <h1>Das waren gerade sehr viele Aufrufe.</h1>
      <p>Warte einen Moment und lade die Seite dann neu.</p>`
  )
}
