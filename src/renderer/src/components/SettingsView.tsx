import { useEffect, useId, useState } from 'react'
import type {
  AppInfo,
  LinkMode,
  LinksInfo,
  LinkStatus,
  ServerInfo,
  UpdateStatus,
  UpdatesInfo
} from '../types'
import { captureHotkey, hotkeyLabel } from '../lib/hotkey'
import { APP_NAME } from '../brand'
import { Icon } from './Icon'
import { dotClass } from './ShareView'

interface Props {
  server: ServerInfo | null
  theme: 'dark' | 'light'
  onSetTheme: (theme: 'dark' | 'light') => void
  links: LinksInfo | null
  linkStatus: LinkStatus | null
  onLinksChanged: (info: LinksInfo) => void
}

type TestState =
  | { phase: 'idle' }
  | { phase: 'running' }
  | { phase: 'done'; ok: boolean; target: string; detail: string }

// Plattformgerechte Beschriftungen (die App läuft auf Windows und Linux).
const PLATFORM = window.foldwing.platform
const IS_WIN = PLATFORM === 'win32'

const host = (url: string): string => url.replace(/^https?:\/\//, '').replace(/\/$/, '')

function modes(relayHost: string): { mode: LinkMode; title: string; desc: string }[] {
  return [
    {
      mode: 'relay',
      title: 'Über das Internet',
      desc: `Der Link funktioniert überall. Er läuft über ${relayHost}, die Dateien bleiben auf deinem Rechner; der Relay reicht sie nur durch.`
    },
    {
      mode: 'lan',
      title: 'Nur im eigenen Netzwerk',
      desc: 'Der Link funktioniert nur bei Leuten im selben WLAN oder Netzwerk. Nichts geht übers Internet.'
    },
    {
      mode: 'domain',
      title: 'Über deine eigene Domain',
      desc: `Mit deinem eigenen Cloudflare-Tunnel. ${relayHost} ist dann nicht beteiligt.`
    }
  ]
}

function statusLineClass(s: LinkStatus | null): string {
  if (!s) return ''
  if (s.state === 'online') return 'status-line--ok'
  if (s.state === 'offline' || s.state === 'error' || s.state === 'blocked') return 'status-line--problem'
  return ''
}

function updateText(u: UpdateStatus | null, info: UpdatesInfo | null): string {
  switch (u?.state) {
    case 'checking':
      return 'Sucht nach Updates …'
    case 'available':
      return `Version ${u.version} gefunden, wird geladen …`
    case 'downloading':
      return `Update wird geladen: ${u.percent} %`
    case 'downloaded':
      return `Version ${u.version} ist bereit.`
    case 'manual':
      return `Version ${u.version} ist da. Du findest sie auf GitHub.`
    case 'none':
      return 'Du hast die neueste Version.'
    case 'error':
      return 'Die Suche hat gerade nicht geklappt. Versuch es später noch mal.'
    case 'disabled':
      return 'Diese Version sucht nicht nach Updates.'
    default:
      return info?.auto ? 'Sucht von selbst nach neuen Versionen.' : 'Sucht nur, wenn du auf „Jetzt suchen“ klickst.'
  }
}

/** Eine Einstellung mit Schalter. Der Name der Einstellung ist die Beschriftung des Schalters. */
function SwitchSetting({
  title,
  hint,
  checked,
  onChange
}: {
  title: string
  hint?: React.ReactNode
  checked: boolean
  onChange: (v: boolean) => void
}): JSX.Element {
  const id = useId()
  return (
    <div className="setting-row setting-row--between">
      <div className="setting-label">
        <span id={`${id}-t`}>{title}</span>
        {hint && (
          <span className="setting-label__hint" id={`${id}-h`}>
            {hint}
          </span>
        )}
      </div>
      <label className="switch-row">
        <input
          type="checkbox"
          role="switch"
          className="switch"
          aria-labelledby={`${id}-t`}
          aria-describedby={hint ? `${id}-h` : undefined}
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span aria-hidden>{checked ? 'An' : 'Aus'}</span>
      </label>
    </div>
  )
}

export function SettingsView({
  server,
  theme,
  onSetTheme,
  links,
  linkStatus,
  onLinksChanged
}: Props): JSX.Element {
  const fid = useId()
  // ---- Links ----
  const [domain, setDomain] = useState('')
  const [token, setToken] = useState('')
  const [linkMsg, setLinkMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [linkBusy, setLinkBusy] = useState(false)
  const [test, setTest] = useState<TestState>({ phase: 'idle' })
  const [showDomain, setShowDomain] = useState(false)

  useEffect(() => {
    if (!links) return
    setDomain(links.publicBaseUrl)
    setShowDomain(links.mode === 'domain')
  }, [links?.publicBaseUrl, links?.mode])

  const chooseMode = async (mode: LinkMode): Promise<void> => {
    setLinkMsg(null)
    setTest({ phase: 'idle' })
    // Eigene Domain erst übernehmen, wenn Adresse und Token stehen; bis dahin nur aufklappen.
    if (mode === 'domain' && !(links?.publicBaseUrl && links.hasToken)) {
      setShowDomain(true)
      return
    }
    setShowDomain(mode === 'domain')
    setLinkBusy(true)
    try {
      onLinksChanged(await window.foldwing.linksSet({ mode }))
    } finally {
      setLinkBusy(false)
    }
  }

  const saveDomain = async (): Promise<void> => {
    setLinkBusy(true)
    setLinkMsg(null)
    try {
      const patch: { mode: LinkMode; publicBaseUrl: string; token?: string } = {
        mode: 'domain',
        publicBaseUrl: domain
      }
      if (token.trim()) patch.token = token
      const r = await window.foldwing.linksSet(patch)
      onLinksChanged(r)
      if (!r.ok) {
        setLinkMsg({ ok: false, text: r.error ?? 'Das hat nicht geklappt.' })
      } else if (!r.publicBaseUrl || !r.hasToken) {
        setLinkMsg({ ok: false, text: 'Trag bitte Adresse und Tunnel-Token ein.' })
      } else {
        setToken('')
        setLinkMsg({ ok: true, text: 'Gespeichert. Deine Links laufen jetzt über deine Domain.' })
      }
    } finally {
      setLinkBusy(false)
    }
  }

  const runTest = async (): Promise<void> => {
    setTest({ phase: 'running' })
    const res = await window.foldwing.linksTestDomain()
    let detail: string
    if (res.ok) {
      detail = `Deine Domain erreicht ${APP_NAME} auf diesem Rechner. Die Links funktionieren.`
    } else if (res.isThisServer === false && res.status) {
      detail = `Unter der Adresse antwortet etwas anderes (HTTP ${res.status}). Schau im Cloudflare-Dashboard nach, wohin der Tunnel zeigt.`
    } else if (res.error === 'timeout') {
      detail = 'Keine Antwort. Wahrscheinlich zeigt die Domain noch nicht auf diesen Tunnel.'
    } else {
      detail = 'Nicht erreichbar. Domain oder Tunnel sind noch nicht fertig eingerichtet.'
    }
    setTest({ phase: 'done', ok: res.ok, target: res.target, detail })
  }

  // Freigaben und App (Standard-Ablauf, Infobereich, Autostart, Virenscan)
  const [appSettings, setAppSettings] = useState<{
    defaultTtlHours: number
    closeToTray: boolean
    autostart: boolean
    scanUploads: boolean
    scannerFound?: boolean
  } | null>(null)

  useEffect(() => {
    void (async () => setAppSettings(await window.foldwing.settingsGet()))()
  }, [])

  const patchSettings = async (patch: {
    defaultTtlHours?: number
    closeToTray?: boolean
    autostart?: boolean
    scanUploads?: boolean
  }): Promise<void> => {
    setAppSettings(await window.foldwing.settingsSet(patch))
  }

  // Screenshot-Aufnahme
  const [cap, setCap] = useState<{
    enabled: boolean
    hotkey: string
    saveDir: string
    editorPath: string
    magnifier: boolean
    alwaysSave: boolean
    hotkeyActive: boolean
    unavailable?: 'wayland' | null
  } | null>(null)

  useEffect(() => {
    void (async () => setCap(await window.foldwing.captureGet()))()
  }, [])

  const patchCap = async (patch: {
    enabled?: boolean
    hotkey?: string
    saveDir?: string
    editorPath?: string
    magnifier?: boolean
    alwaysSave?: boolean
  }): Promise<void> => {
    setCap(await window.foldwing.captureSet(patch))
  }
  const pickSaveDir = async (): Promise<void> => {
    const r = await window.foldwing.capturePickSaveDir()
    if (r.ok) setCap(await window.foldwing.captureGet())
  }
  const pickEditor = async (): Promise<void> => {
    const r = await window.foldwing.capturePickEditor()
    if (r.ok) setCap(await window.foldwing.captureGet())
  }

  // Tastenkürzel per Drücken aufnehmen statt eintippen.
  const [listeningHotkey, setListeningHotkey] = useState(false)
  const [hotkeyMsg, setHotkeyMsg] = useState('')

  useEffect(() => {
    if (!listeningHotkey) return
    // Manche Tasten (v. a. Druck) feuern unter Windows KEIN keydown, Windows
    // schnappt sie sich für den Screenshot. Deshalb zusätzlich keyup auswerten,
    // aber nur für Tasten ohne vorheriges keydown (keine Doppelerkennung).
    const seenOnKeydown = new Set<string>()
    const handle = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      const r = captureHotkey({
        key: e.key,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        shiftKey: e.shiftKey,
        metaKey: e.metaKey
      })
      if (r.kind === 'pending') return
      if (r.kind === 'cancel') {
        setListeningHotkey(false)
        return
      }
      if (r.kind === 'rejected') {
        setHotkeyMsg(r.reason)
        return
      }
      setListeningHotkey(false)
      setHotkeyMsg('')
      void patchCap({ hotkey: r.value })
    }
    const onDown = (e: KeyboardEvent): void => {
      seenOnKeydown.add(e.key)
      handle(e)
    }
    const onUp = (e: KeyboardEvent): void => {
      if (!seenOnKeydown.has(e.key)) handle(e)
    }
    window.addEventListener('keydown', onDown, true)
    window.addEventListener('keyup', onUp, true)
    return () => {
      window.removeEventListener('keydown', onDown, true)
      window.removeEventListener('keyup', onUp, true)
    }
  }, [listeningHotkey])

  const startHotkeyCapture = (): void => {
    setHotkeyMsg('')
    setListeningHotkey(true)
  }

  // ---- Updates und Über ----
  const [about, setAbout] = useState<AppInfo | null>(null)
  const [updates, setUpdates] = useState<UpdatesInfo | null>(null)
  const [update, setUpdate] = useState<UpdateStatus | null>(null)
  useEffect(() => {
    void (async () => {
      setAbout(await window.foldwing.appInfo())
      setUpdates(await window.foldwing.updatesGet())
      setUpdate(await window.foldwing.updateGetStatus())
    })()
    return window.foldwing.onUpdateStatus(setUpdate)
  }, [])
  const setAutoUpdates = async (auto: boolean): Promise<void> => {
    setUpdates(await window.foldwing.updatesSet({ auto }))
  }
  const releasesUrl = updates?.releasesUrl ?? about?.releasesUrl ?? ''
  const guideUrl = about ? `${about.repoUrl}/blob/main/docs/cloudflare-tunnel.de.md` : ''

  const mode = links?.mode ?? 'relay'
  const relayHost = links?.relayBase ? host(links.relayBase) : 'foldwing.online'
  const domainPending = showDomain && mode !== 'domain'
  const hotkeyText = cap?.hotkey ? hotkeyLabel(cap.hotkey, PLATFORM) : ''

  return (
    <div>
      <h1 className="page-title">Einstellungen</h1>

      <div className="settings">
        {/* ---- Links ---- */}
        <section className="setting-card" aria-labelledby="set-links">
          <h2 className="setting-card__title" id="set-links">
            Links
          </h2>
          <p className="setting-card__desc">Wie deine Links bei den Leuten ankommen, die sie öffnen.</p>

          <div className="mode-list" role="radiogroup" aria-labelledby="set-links">
            {modes(relayHost).map((m) => {
              const active =
                m.mode === 'domain' ? showDomain || mode === 'domain' : mode === m.mode && !showDomain
              return (
                <div key={m.mode}>
                  <label className={`mode-option ${active ? 'mode-option--active' : ''}`}>
                    <input
                      type="radio"
                      name="link-mode"
                      checked={active}
                      disabled={linkBusy}
                      onChange={() => void chooseMode(m.mode)}
                    />
                    <span>
                      <span className="mode-option__title">{m.title}</span>
                      <span className="mode-option__desc">{m.desc}</span>
                    </span>
                  </label>

                  {m.mode === 'domain' && active && (
                    <div className="mode-extra">
                      {domainPending && (
                        <p className="mode-extra__note">
                          Noch nicht aktiv. Trag Adresse und Tunnel-Token ein und speichere, dann
                          laufen deine Links über deine Domain.
                        </p>
                      )}
                      <div className="field">
                        <label className="field__label" htmlFor={`${fid}-domain`}>
                          Adresse
                        </label>
                        <input
                          id={`${fid}-domain`}
                          className="input input--mono"
                          placeholder="share.example.com"
                          spellCheck={false}
                          value={domain}
                          onChange={(e) => setDomain(e.target.value)}
                        />
                      </div>
                      <div className="field">
                        <label className="field__label" htmlFor={`${fid}-token`}>
                          Tunnel-Token
                        </label>
                        <input
                          id={`${fid}-token`}
                          className="input input--mono"
                          type="password"
                          autoComplete="off"
                          placeholder={
                            links?.hasToken
                              ? 'Ist gespeichert. Zum Ändern einen neuen eintragen.'
                              : 'eyJ… aus dem Cloudflare-Dashboard'
                          }
                          value={token}
                          onChange={(e) => setToken(e.target.value)}
                        />
                        {guideUrl && (
                          <span className="field__hint">
                            Wie du Domain und Tunnel einrichtest, steht in der{' '}
                            <button className="textlink" onClick={() => window.foldwing.openExternal(guideUrl)}>
                              Anleitung
                            </button>
                            .
                          </span>
                        )}
                      </div>
                      <div className="setting-row">
                        <button className="btn btn--primary" onClick={saveDomain} disabled={linkBusy}>
                          {domainPending ? 'Speichern und verwenden' : 'Speichern'}
                        </button>
                        {mode === 'domain' && (
                          <button className="btn" onClick={runTest} disabled={test.phase === 'running'}>
                            {test.phase === 'running' ? 'Teste …' : 'Verbindung testen'}
                          </button>
                        )}
                      </div>
                      {linkMsg && (
                        <p
                          className={`status-line ${linkMsg.ok ? 'status-line--ok' : 'status-line--problem'}`}
                          role={linkMsg.ok ? 'status' : 'alert'}
                          style={{ marginTop: 0 }}
                        >
                          {linkMsg.text}
                        </p>
                      )}
                      {test.phase === 'done' && (
                        <div className={`test-result ${test.ok ? 'test-result--ok' : 'test-result--fail'}`} role="status">
                          <span className="test-result__icon" aria-hidden>
                            <Icon name={test.ok ? 'check' : 'alert'} size={18} />
                          </span>
                          <div>
                            <div className="test-result__head">
                              {test.ok ? 'Erreichbar' : 'Noch nicht erreichbar'}
                            </div>
                            <div className="test-result__detail">{test.detail}</div>
                            <code className="test-result__target">{test.target}</code>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          <p className={`status-line ${statusLineClass(linkStatus)}`} role="status">
            <span className={`dot ${dotClass(linkStatus)}`} aria-hidden />
            <span>
              Gerade: {linkStatus?.text ?? '…'}
              {linkStatus?.state !== 'resting' && server?.effectiveBaseUrl && (
                <>
                  {' '}
                  <strong>{host(server.effectiveBaseUrl)}</strong>
                </>
              )}
            </span>
          </p>
          {linkStatus?.state === 'blocked' && links?.deviceId && (
            <p className="note">
              Hältst du die Sperre für falsch, schreib an die Adresse im{' '}
              {about?.relayImprintUrl ? (
                <button className="textlink" onClick={() => window.foldwing.openExternal(about.relayImprintUrl)}>
                  Impressum von {relayHost}
                </button>
              ) : (
                <>Impressum von {relayHost}</>
              )}{' '}
              und nenn deine Geräte-ID: <code>{links.deviceId}</code>
            </p>
          )}
          {mode === 'relay' && !showDomain && links && (
            <p className="note">
              <button className="textlink" onClick={() => window.foldwing.openExternal(links.relayInfoUrl)}>
                Was ist {relayHost}?
              </button>
            </p>
          )}
        </section>

        {/* ---- Freigaben ---- */}
        <section className="setting-card" aria-labelledby="set-shares">
          <h2 className="setting-card__title" id="set-shares">
            Freigaben
          </h2>
          <div className="setting-row setting-row--between">
            <div className="setting-label">
              <label htmlFor={`${fid}-ttl`}>Ablauf neuer Freigaben</label>
              <span className="setting-label__hint">
                Danach wird die Freigabe gelöscht und der Link geht nicht mehr. Bei jeder Freigabe
                kannst du das einzeln ändern.
              </span>
            </div>
            <select
              id={`${fid}-ttl`}
              className="select"
              value={String(appSettings?.defaultTtlHours ?? 0)}
              onChange={(e) => patchSettings({ defaultTtlHours: Number(e.target.value) })}
            >
              <option value="0">Nie</option>
              <option value="1">Nach 1 Stunde</option>
              <option value="24">Nach 24 Stunden</option>
              <option value="168">Nach 7 Tagen</option>
              <option value="720">Nach 30 Tagen</option>
            </select>
          </div>
          <SwitchSetting
            title="Dateien auf Schadsoftware prüfen"
            hint={
              appSettings?.scannerFound === false
                ? IS_WIN
                  ? 'Windows Defender wurde nicht gefunden. Dateien werden deshalb gerade ungeprüft geteilt.'
                  : 'ClamAV ist nicht installiert. Dateien werden deshalb gerade ungeprüft geteilt. Mit dem Paket clamav prüft Foldwing jede Datei vor dem Teilen.'
                : IS_WIN
                ? 'Windows Defender prüft jede Datei auf deinem Rechner, bevor sie geteilt wird. Findet er etwas, wird sie nicht geteilt.'
                : 'ClamAV prüft jede Datei auf deinem Rechner, bevor sie geteilt wird. Findet es etwas, wird sie nicht geteilt.'
            }
            checked={appSettings?.scanUploads ?? true}
            onChange={(v) => void patchSettings({ scanUploads: v })}
          />
        </section>

        {/* ---- Screenshots ---- */}
        <section className="setting-card" aria-labelledby="set-capture">
          <h2 className="setting-card__title" id="set-capture">
            Screenshots
          </h2>
          <p className="setting-card__desc">
            Ein Tastendruck, dann wählst du einen Bereich. Danach teilst du ihn als Link, kopierst,
            speicherst oder bearbeitest ihn.
          </p>
          <SwitchSetting
            title="Screenshot per Tastenkürzel"
            hint={
              cap?.unavailable === 'wayland'
                ? 'Unter Wayland kann Foldwing keine Tasten abfangen und keinen Bildschirm aufnehmen. Melde dich mit einer X11-Sitzung an, wenn du Screenshots brauchst.'
                : cap?.enabled
                ? cap.hotkeyActive
                  ? `Bereit: ${hotkeyText}.`
                  : 'Das Kürzel ist schon von einem anderen Programm belegt. Nimm unten ein anderes.'
                : 'Ist aus.'
            }
            checked={cap?.enabled ?? false}
            onChange={(v) => void patchCap({ enabled: v })}
          />

          <div className="field">
            <span className="field__label" id={`${fid}-hk`}>
              Tastenkürzel
            </span>
            <div className="setting-row">
              <span
                className={`hotkey-chip ${listeningHotkey ? 'hotkey-chip--listening' : ''}`}
                aria-labelledby={`${fid}-hk`}
                aria-live="polite"
              >
                {listeningHotkey ? 'Drück jetzt die Tasten …' : hotkeyText || 'Keins'}
              </span>
              <button className="btn" onClick={startHotkeyCapture} disabled={listeningHotkey}>
                Ändern
              </button>
            </div>
            {hotkeyMsg ? (
              <span className="field__hint field__hint--warn" role="alert">
                {hotkeyMsg}
              </span>
            ) : (
              <span className="field__hint">
                Klick auf „Ändern“ und drück die Kombination, <kbd>Esc</kbd> bricht ab. Belegt das
                System die Druck-Taste schon selbst{IS_WIN ? '' : ' (zum Beispiel Spectacle unter KDE)'},
                nimm etwa Strg+Druck.
              </span>
            )}
          </div>

          <div className="field">
            <label className="field__label" htmlFor={`${fid}-dir`}>
              Speicherordner
            </label>
            <div className="setting-row">
              <input
                id={`${fid}-dir`}
                className="input"
                readOnly
                value={cap?.saveDir || (IS_WIN ? 'Standard: Bilder\\Foldwing' : 'Standard: Bilder/Foldwing')}
              />
              <button className="btn" onClick={pickSaveDir}>
                Ordner wählen
              </button>
            </div>
          </div>

          <SwitchSetting
            title="Jeden Screenshot auch als Datei ablegen"
            hint="Auch wenn du ihn nur teilst oder kopierst, landet eine Kopie im Speicherordner."
            checked={cap?.alwaysSave ?? false}
            onChange={(v) => void patchCap({ alwaysSave: v })}
          />

          <div className="field">
            <label className="field__label" htmlFor={`${fid}-editor`}>
              Programm zum Bearbeiten
            </label>
            <div className="setting-row">
              <input
                id={`${fid}-editor`}
                className="input"
                readOnly
                value={cap?.editorPath || (IS_WIN ? 'Windows fragt jedes Mal („Öffnen mit“)' : 'Standard-Programm des Systems')}
              />
              {cap?.editorPath ? (
                <button className="btn" onClick={() => patchCap({ editorPath: '' })}>
                  Zurücksetzen
                </button>
              ) : (
                <button className="btn" onClick={pickEditor}>
                  Programm wählen
                </button>
              )}
            </div>
          </div>

          <SwitchSetting
            title="Pixel-Lupe"
            hint={
              <>
                Zeigt beim Auswählen die Stelle unter dem Mauszeiger vergrößert. Mit <kbd>M</kbd>{' '}
                schaltest du sie unterwegs um.
              </>
            }
            checked={cap?.magnifier ?? true}
            onChange={(v) => void patchCap({ magnifier: v })}
          />
        </section>

        {/* ---- App ---- */}
        <section className="setting-card" aria-labelledby="set-app">
          <h2 className="setting-card__title" id="set-app">
            App
          </h2>
          <SwitchSetting
            title="Im Hintergrund weiterlaufen"
            hint={`Beim Schließen bleibt ${APP_NAME} im Infobereich. Deine Links bleiben erreichbar, und das Screenshot-Kürzel funktioniert weiter. Ist es aus, beendet Schließen die App.`}
            checked={appSettings?.closeToTray ?? true}
            onChange={(v) => void patchSettings({ closeToTray: v })}
          />
          <SwitchSetting
            title={IS_WIN ? 'Mit Windows starten' : 'Beim Anmelden starten'}
            hint={`${APP_NAME} startet still im Infobereich. Das Screenshot-Kürzel ist sofort bereit, und geteilte Links sind wieder erreichbar.`}
            checked={appSettings?.autostart ?? true}
            onChange={(v) => void patchSettings({ autostart: v })}
          />
          <div className="setting-row setting-row--between">
            <div className="setting-label">
              <span id={`${fid}-theme`}>Design</span>
            </div>
            <div className="segmented" role="radiogroup" aria-labelledby={`${fid}-theme`}>
              {(['light', 'dark'] as const).map((t) => (
                <label key={t}>
                  <input
                    type="radio"
                    name="theme"
                    checked={theme === t}
                    onChange={() => onSetTheme(t)}
                  />
                  {t === 'light' ? 'Hell' : 'Dunkel'}
                </label>
              ))}
            </div>
          </div>
        </section>

        {/* ---- Updates ---- */}
        <section className="setting-card" aria-labelledby="set-updates">
          <h2 className="setting-card__title" id="set-updates">
            Updates
          </h2>
          {updates?.mode !== 'none' && (
            <SwitchSetting
              title="Automatisch nach Updates suchen"
              hint={
                updates?.mode === 'manual'
                  ? 'Fragt bei GitHub nach neuen Versionen. Installieren musst du sie bei dieser Version selbst.'
                  : 'Fragt bei GitHub nach neuen Versionen, lädt sie im Hintergrund und sagt Bescheid, wenn sie bereit sind.'
              }
              checked={updates?.auto ?? true}
              onChange={(v) => void setAutoUpdates(v)}
            />
          )}
          <div className="setting-row setting-row--between" style={{ marginTop: updates?.mode !== 'none' ? 14 : 0 }}>
            <span
              className={`status-line ${update?.state === 'downloaded' || update?.state === 'none' ? 'status-line--ok' : ''}`}
              style={{ margin: 0 }}
              role="status"
            >
              {updateText(update, updates)}
            </span>
            {update?.state === 'downloaded' ? (
              <button className="btn btn--primary" onClick={() => window.foldwing.updateInstall()}>
                Neu starten und installieren
              </button>
            ) : update?.state === 'manual' || updates?.mode === 'none' || update?.state === 'disabled' ? (
              releasesUrl && (
                <button className="btn" onClick={() => window.foldwing.openExternal(releasesUrl)}>
                  Versionen auf GitHub
                </button>
              )
            ) : (
              <button
                className="btn"
                onClick={() => void window.foldwing.updateCheck()}
                disabled={update?.state === 'checking'}
              >
                {update?.state === 'checking' ? 'Sucht …' : 'Jetzt suchen'}
              </button>
            )}
          </div>
        </section>

        {/* ---- Über ---- */}
        <section className="setting-card" aria-labelledby="set-about">
          <h2 className="setting-card__title" id="set-about">
            Über {APP_NAME}
          </h2>
          <p className="setting-card__desc">
            Version {about?.version ?? '…'}, freie Software unter der {about?.license ?? 'MIT'}-Lizenz.{' '}
            {about && (
              <button className="textlink" onClick={() => window.foldwing.openExternal(about.repoUrl)}>
                Quellcode auf GitHub
              </button>
            )}
          </p>
          <h3 className="field__label" style={{ margin: '4px 0 0' }}>
            Was ins Netz geht
          </h3>
          <dl className="about-list">
            <dt>Internet-Links</dt>
            <dd>
              Solange du etwas über {relayHost} teilst, baut {APP_NAME} einen Cloudflare-Tunnel auf
              und meldet deinen Rechner beim Relay an. Die Dateien bleiben bei dir; der Relay reicht
              sie nur durch und speichert nichts.
            </dd>
            <dt>Updates</dt>
            <dd>
              {APP_NAME} fragt bei GitHub nach neuen Versionen. Das kannst du oben unter „Updates“
              abschalten.
            </dd>
            <dt>Virenscan</dt>
            <dd>
              {IS_WIN
                ? 'Uploads prüft Windows Defender auf deinem Rechner. Je nach Windows-Einstellung schickt Defender verdächtige Proben an Microsoft.'
                : 'Uploads prüft ClamAV auf deinem Rechner, falls es installiert ist. Dabei geht nichts raus.'}
            </dd>
            <dt>Sonst</dt>
            <dd>Nichts: keine Konten, keine Telemetrie.</dd>
          </dl>
        </section>
      </div>
    </div>
  )
}
