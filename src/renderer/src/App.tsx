import { useCallback, useEffect, useState } from 'react'
import { uploadBundle, uploadShare } from './lib/upload'
import { BUNDLE_MIME } from './types'
import type { LinksInfo, LinkStatus, ServerInfo, ShareItem } from './types'
import { Header } from './components/Header'
import { ShareView } from './components/ShareView'
import { SettingsView } from './components/SettingsView'
import { TunnelBanner } from './components/TunnelBanner'
import { UpdateBanner } from './components/UpdateBanner'
import { RelayNotice } from './components/RelayNotice'
import type { AppInfo, UpdateStatus } from './types'

type Theme = 'dark' | 'light'
type View = 'shares' | 'settings'

const THEME_KEY = 'foldwing.theme'

/**
 * Fehlertext für die Karte. Fehler aus dem Main-Prozess kommen über IPC mit
 * technischem Vorspann („Error invoking remote method …“), der fällt weg.
 */
function uploadError(err: unknown): string {
  const raw = String((err as Error)?.message ?? err ?? '')
  const text = raw.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '').trim()
  return text || 'Das Teilen hat nicht geklappt. Versuch es noch einmal.'
}

/** Alle blob-URLs eines Eintrags freigeben, auch die der Dateien einer Sammlung. */
function revokePreviews(item: ShareItem): void {
  if (item.previewUrl) URL.revokeObjectURL(item.previewUrl)
  for (const f of item.files ?? []) if (f.previewUrl) URL.revokeObjectURL(f.previewUrl)
}

export default function App(): JSX.Element {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const ls = localStorage.getItem(THEME_KEY)
      if (ls === 'dark' || ls === 'light') return ls
    } catch {
      /* localStorage gesperrt */
    }
    // localStorage verloren (z. B. nach Absturz/Kill) -> aus der robusten Config holen.
    try {
      return window.foldwing.getUiPrefs().theme
    } catch {
      return 'light'
    }
  })
  const [view, setView] = useState<View>('shares')
  const [items, setItems] = useState<ShareItem[]>([])
  const [server, setServer] = useState<ServerInfo | null>(null)
  const [links, setLinks] = useState<LinksInfo | null>(null)
  const [linkStatus, setLinkStatus] = useState<LinkStatus | null>(null)
  const [update, setUpdate] = useState<UpdateStatus | null>(null)
  const [about, setAbout] = useState<AppInfo | null>(null)
  // Hinweis zum ersten Internet-Link mit Esc weggeklickt: Leiste erinnert daran.
  const [noticeHidden, setNoticeHidden] = useState(false)

  useEffect(() => {
    void (async () => setAbout(await window.foldwing.appInfo()))()
  }, [])

  // Update-Status laden + live verfolgen (Hinweis-Leiste „Jetzt installieren").
  useEffect(() => {
    void (async () => setUpdate(await window.foldwing.updateGetStatus()))()
    return window.foldwing.onUpdateStatus(setUpdate)
  }, [])

  // Erstes Bild gezeichnet – nur für die Start-Messung im Main-Prozess.
  useEffect(() => {
    const id = requestAnimationFrame(() => requestAnimationFrame(() => window.foldwing.appReady()))
    return () => cancelAnimationFrame(id)
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem(THEME_KEY, theme)
    } catch {
      /* die Config hält es auch */
    }
    // Zusätzlich robust in der Config sichern (überlebt localStorage-Verlust).
    try {
      window.foldwing.setUiPrefs({ theme })
    } catch {
      /* Bridge (noch) nicht da – localStorage genügt dann */
    }
    // Nativen Fenster-Schaltflächen (Minimieren/Maximieren/Schließen) an die Optik anpassen.
    window.foldwing.setTitleBarOverlay(
      theme === 'dark'
        ? { color: '#151a20', symbolColor: '#eef1f5' }
        : { color: '#ffffff', symbolColor: '#151a20' }
    )
  }, [theme])

  const refreshServer = useCallback(async () => {
    setServer(await window.foldwing.serverInfo())
  }, [])

  // Der Server ruht, solange nichts geteilt ist, und startet bei Bedarf von selbst –
  // Status live übernehmen.
  useEffect(() => window.foldwing.onServerChanged(setServer), [])

  // Beim Start: Serverinfo laden und vorhandene Freigaben als Verlauf einlesen.
  useEffect(() => {
    void refreshServer()
    void (async () => {
      const shares = await window.foldwing.listShares()
      setItems(
        // Älteste zuerst, wie neue Uploads angehängt werden – die Liste zeigt sie
        // umgekehrt, also die neueste oben (sonst stand nach einem Neustart die älteste oben).
        [...shares].sort((a, b) => a.createdAt - b.createdAt).map((s) => ({
          ...s,
          status: 'done' as const,
          progress: 1
        }))
      )
    })()
  }, [refreshServer])

  // Betriebsart der Links + Zustand laden und live verfolgen.
  const refreshLinks = useCallback(async () => {
    const info = await window.foldwing.linksGet()
    setLinks(info)
    setLinkStatus(info.status)
  }, [])
  useEffect(() => {
    void refreshLinks()
    return window.foldwing.onLinkStatus((s) => {
      setLinkStatus(s)
      // Bestätigung oder Moduswechsel kann auch aus einem anderen Weg kommen.
      setLinks((prev) => (prev ? { ...prev, status: s } : prev))
    })
  }, [refreshLinks])

  const handleLinksChanged = useCallback((info: LinksInfo) => {
    setLinks(info)
    setLinkStatus(info.status)
  }, [])

  // Neue Links für alle Freigaben (Betriebsart gewechselt, neue Geräte-ID).
  useEffect(
    () =>
      window.foldwing.onShareUrls((urls) => {
        const byId = new Map(urls.map((u) => [u.id, u.url]))
        setItems((prev) =>
          prev.map((it) => (byId.has(it.id) ? { ...it, url: byId.get(it.id) } : it))
        )
      }),
    []
  )

  const acceptRelay = useCallback(async () => {
    handleLinksChanged(await window.foldwing.linksAcceptRelay())
  }, [handleLinksChanged])

  const relayLanOnly = useCallback(async () => {
    handleLinksChanged(await window.foldwing.linksSet({ mode: 'lan' }))
    await refreshServer()
  }, [handleLinksChanged, refreshServer])

  const patch = useCallback((id: string, p: Partial<ShareItem>) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...p } : it)))
  }, [])

  const handleUpload = useCallback(
    (input: FileList | File[]) => {
      const files = Array.from(input)
      if (files.length === 0) return

      const onFail =
        (localId: string) =>
        (err: unknown): void =>
          patch(localId, {
            status: 'failed',
            error: uploadError(err)
          })

      // Eine Datei: klassische Einzelfreigabe – die Empfänger-Seite zeigt die volle Vorschau.
      if (files.length === 1) {
        const file = files[0]
        const localId = crypto.randomUUID()
        const isMedia = file.type.startsWith('image/') || file.type.startsWith('video/')
        const item: ShareItem = {
          id: localId,
          name: file.name,
          mime: file.type || 'application/octet-stream',
          size: file.size,
          createdAt: Date.now(),
          status: 'uploading',
          progress: 0,
          previewUrl: isMedia ? URL.createObjectURL(file) : undefined
        }
        setItems((prev) => [...prev, item])

        // Lokal in den eingebetteten Server streamen.
        uploadShare(file, (progress) => patch(localId, { progress }))
          .then((share) =>
            setItems((prev) =>
              prev.map((it) =>
                it.id === localId
                  ? {
                      ...it,
                      id: share.id,
                      url: share.url,
                      expiresAt: share.expiresAt,
                      status: 'done',
                      progress: 1
                    }
                  : it
              )
            )
          )
          .catch(onFail(localId))
        return
      }

      // Mehrere Dateien: eine Sammlung, ein Link.
      const localId = crypto.randomUUID()
      const previews = files.map((f) =>
        f.type.startsWith('image/') || f.type.startsWith('video/')
          ? URL.createObjectURL(f)
          : undefined
      )
      const item: ShareItem = {
        id: localId,
        name: `${files.length} Dateien`,
        mime: BUNDLE_MIME,
        size: files.reduce((sum, f) => sum + f.size, 0),
        createdAt: Date.now(),
        status: 'uploading',
        progress: 0,
        files: files.map((f, i) => ({
          name: f.name,
          mime: f.type || 'application/octet-stream',
          size: f.size,
          previewUrl: previews[i]
        }))
      }
      setItems((prev) => [...prev, item])

      uploadBundle(files, (progress) => patch(localId, { progress }))
        .then((share) =>
          setItems((prev) =>
            prev.map((it) =>
              it.id === localId
                ? {
                    ...it,
                    id: share.id,
                    url: share.url,
                    expiresAt: share.expiresAt,
                    size: share.size,
                    status: 'done',
                    progress: 1,
                    // Die blob-URLs der Anzeige behalten, den Rest vom Server übernehmen.
                    files: (share.files ?? []).map((f, i) => ({
                      ...f,
                      previewUrl: previews[i]
                    }))
                  }
                : it
            )
          )
        )
        .catch(onFail(localId))
    },
    [patch]
  )

  const handleDelete = useCallback(async (item: ShareItem) => {
    if (item.status === 'done') await window.foldwing.deleteShare(item.id)
    revokePreviews(item) // Speicher freigeben
    setItems((prev) => prev.filter((it) => it.id !== item.id))
  }, [])

  const handleSetExpiry = useCallback(async (item: ShareItem, expiresAt: number | null) => {
    const r = await window.foldwing.setShareExpiry(item.id, expiresAt)
    if (r.ok) {
      setItems((prev) =>
        prev.map((it) => (it.id === item.id ? { ...it, expiresAt: r.share.expiresAt } : it))
      )
    }
  }, [])

  // Von außen ergänzte Freigaben (z. B. hochgeladener Screenshot) live aufnehmen.
  useEffect(() => {
    const unsub = window.foldwing.onShareAdded((share) =>
      setItems((prev) =>
        prev.some((it) => it.id === share.id)
          ? prev
          : [
              ...prev,
              {
                id: share.id,
                name: share.name,
                mime: share.mime,
                size: share.size,
                createdAt: share.createdAt,
                expiresAt: share.expiresAt,
                status: 'done',
                progress: 1,
                url: share.url,
                files: share.files
              }
            ]
      )
    )
    return unsub
  }, [])

  // Vom Server automatisch entfernte (abgelaufene) Freigaben aus der Liste nehmen.
  useEffect(() => {
    const unsub = window.foldwing.onSharesExpired((ids) =>
      setItems((prev) =>
        prev.filter((it) => {
          const gone = ids.includes(it.id)
          if (gone) revokePreviews(it)
          return !gone
        })
      )
    )
    return unsub
  }, [])

  const toggleTheme = (): void => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))

  return (
    <div className="app">
      <Header theme={theme} onToggleTheme={toggleTheme} view={view} onNavigate={setView} />
      <div className="app__scroll">
        <main className={`app__main ${view === 'settings' ? 'app__main--wide' : ''}`}>
          <UpdateBanner
            status={update}
            releasesUrl={about?.releasesUrl ?? ''}
            onInstall={() => window.foldwing.updateInstall()}
          />
          {/* Im Ruhezustand (nichts geteilt, Server aus) gibt es nichts zu melden. */}
          {linkStatus && linkStatus.mode !== 'lan' && server?.running && (
            <TunnelBanner
              status={linkStatus}
              onOpenSettings={() => setView('settings')}
              noticeHidden={noticeHidden}
              onShowNotice={() => setNoticeHidden(false)}
            />
          )}
          {view === 'settings' ? (
            <SettingsView
              server={server}
              theme={theme}
              onSetTheme={setTheme}
              links={links}
              linkStatus={linkStatus}
              onLinksChanged={handleLinksChanged}
            />
          ) : (
            <ShareView
              items={items}
              server={server}
              links={links}
              linkStatus={linkStatus}
              onOpenSettings={() => setView('settings')}
              onUpload={handleUpload}
              onDelete={handleDelete}
              onSetExpiry={handleSetExpiry}
            />
          )}
        </main>
      </div>
      {/* Vor der ersten Anmeldung beim Relay: kurzer Hinweis, erst „Okay“ meldet an. */}
      {linkStatus?.state === 'waiting' && links && !noticeHidden && (
        <RelayNotice
          rulesUrl={links.relayRulesUrl}
          privacyUrl={links.relayPrivacyUrl}
          onAccept={acceptRelay}
          onLanOnly={relayLanOnly}
          onLater={() => setNoticeHidden(true)}
        />
      )}
    </div>
  )
}
