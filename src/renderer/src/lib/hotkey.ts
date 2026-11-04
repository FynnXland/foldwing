/**
 * Tastenkombination per Drücken aufnehmen statt eintippen (wie in anderen Programmen
 * üblich). Reine, DOM-freie Logik – wandelt ein Tastatur-Ereignis in einen
 * Electron-Accelerator-String um ("Control+Shift+S", "PrintScreen", …).
 */
export interface HotkeyKeyInput {
  key: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

export type HotkeyCaptureResult =
  | { kind: 'cancel' } // Esc allein -> Aufnahme abbrechen
  | { kind: 'pending' } // nur ein Modifikator gedrückt -> weiter warten
  | { kind: 'rejected'; reason: string } // einzelne Taste ohne Zusatztaste, die riskant wäre
  | { kind: 'accelerator'; value: string }

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'OS', 'AltGraph'])

// Tasten, die auch ganz ohne Zusatztaste (Strg/Alt/Umschalt) sinnvoll & sicher sind.
const STANDALONE_OK = new Set(['PrintScreen', 'Pause', 'ContextMenu'])
const F_KEY = /^F([1-9]|1[0-9]|2[0-4])$/ // F1..F24

function isStandaloneSafe(main: string): boolean {
  return STANDALONE_OK.has(main) || F_KEY.test(main)
}

const NAMED_KEYS: Record<string, string> = {
  ' ': 'Space',
  Escape: 'Esc',
  Enter: 'Return',
  Backspace: 'Backspace',
  Tab: 'Tab',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  PrintScreen: 'PrintScreen',
  Pause: 'Pause',
  ContextMenu: 'Menu'
}

function mainKeyName(key: string): string | null {
  if (key in NAMED_KEYS) return NAMED_KEYS[key]
  if (F_KEY.test(key)) return key
  if (key.length === 1) return key.toUpperCase() // Buchstaben, Ziffern, Satzzeichen
  return null // unbekannte/nicht abbildbare Taste -> ignorieren, weiter warten
}

export function captureHotkey(e: HotkeyKeyInput): HotkeyCaptureResult {
  if (MODIFIER_KEYS.has(e.key)) return { kind: 'pending' }

  const hasModifier = e.ctrlKey || e.altKey || e.shiftKey || e.metaKey

  // Escape ganz allein (ohne Zusatztaste) ist die universelle Abbrechen-Geste.
  if (e.key === 'Escape' && !hasModifier) return { kind: 'cancel' }

  const main = mainKeyName(e.key)
  if (main === null) return { kind: 'pending' } // z. B. IME/unbekannt -> weiter warten

  if (!hasModifier && !isStandaloneSafe(main)) {
    return {
      kind: 'rejected',
      reason: 'Nimm Strg, Alt oder Umschalt dazu. Allein gehen nur Druck, Pause und die F-Tasten.'
    }
  }

  const mods: string[] = []
  if (e.ctrlKey) mods.push('Control')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  if (e.metaKey) mods.push('Super')

  return { kind: 'accelerator', value: [...mods, main].join('+') }
}

const KEY_LABELS: Record<string, string> = {
  control: 'Strg',
  ctrl: 'Strg',
  commandorcontrol: 'Strg',
  cmdorctrl: 'Strg',
  shift: 'Umschalt',
  alt: 'Alt',
  option: 'Alt',
  altgr: 'AltGr',
  printscreen: 'Druck',
  return: 'Enter',
  enter: 'Enter',
  space: 'Leertaste',
  esc: 'Esc',
  escape: 'Esc',
  delete: 'Entf',
  insert: 'Einfg',
  home: 'Pos1',
  end: 'Ende',
  pageup: 'Bild auf',
  pagedown: 'Bild ab',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  backspace: 'Rücktaste',
  tab: 'Tab',
  pause: 'Pause',
  menu: 'Menü'
}

/**
 * Electron-Accelerator lesbar auf Deutsch („Control+Shift+S“ -> „Strg+Umschalt+S“).
 * Gegenstück zu hotkeyLabel() in src/main/sharing-policy.ts (Tooltip im Infobereich).
 */
export function hotkeyLabel(accelerator: string, platform: string): string {
  return accelerator
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const k = part.toLowerCase()
      if (k === 'super' || k === 'meta' || k === 'cmd' || k === 'command') return platform === 'win32' ? 'Win' : 'Super'
      return KEY_LABELS[k] ?? part
    })
    .join('+')
}
