import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { CaptureOverlay } from './components/CaptureOverlay'
import { CaptureActions } from './components/CaptureActions'
import './styles.css'
import { APP_NAME } from './brand'

// Fenstertitel aus der Namenskonstante (auch für die Screenshot-Fenster).
document.title = APP_NAME

// Dasselbe Renderer-Bundle bedient drei Fenster; die Rolle steckt im URL-Hash.
const hash = window.location.hash.replace(/^#/, '')
const root = ReactDOM.createRoot(document.getElementById('root')!)

// Theme SOFORT setzen (vor dem ersten Zeichnen) – aus localStorage, sonst aus der
// robusten Config. So malt schon das erste Bild im richtigen Theme (kein weißer
// Blitz für Dunkel-Nutzer, kein Umspringen). localStorage verloren -> Config-Fallback.
let theme: string | null = null
try {
  theme = localStorage.getItem('foldwing.theme')
} catch {
  /* localStorage gesperrt */
}
if (theme !== 'dark' && theme !== 'light') {
  try {
    theme = window.foldwing.getUiPrefs().theme
  } catch {
    theme = 'light'
  }
}
document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light'

// Capture-Fenster brauchen einen transparenten Hintergrund (Overlay/Leiste schweben).
if (hash === 'capture' || hash === 'capture-actions') {
  document.documentElement.style.background = 'transparent'
  document.body.style.background = 'transparent'
  // Die Ladeanzeige aus index.html gehört nur ins Hauptfenster.
  document.getElementById('root')?.replaceChildren()
}

if (hash === 'capture') {
  root.render(<CaptureOverlay />)
} else if (hash === 'capture-actions') {
  root.render(<CaptureActions />)
} else {
  // Erst die Ladeanzeige aus index.html einmal zeichnen lassen, dann React:
  // requestAnimationFrame läuft vor dem nächsten Bild, setTimeout danach. Kostet
  // ein Bild (~16 ms), dafür sieht man garantiert sofort etwas.
  requestAnimationFrame(() =>
    setTimeout(() =>
      root.render(
        <React.StrictMode>
          <App />
        </React.StrictMode>
      )
    )
  )
}
