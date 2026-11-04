import { spawn, type ChildProcess } from 'child_process'

/**
 * Sichtbare Top-Level-Fenster samt Bildschirm-Rechteck ermitteln – über einen
 * PowerShell-Helfer mit Win32-P/Invoke (kein natives Addon nötig). Er startet erst
 * bei der ersten Abfrage einer Aufnahme (Kaltstart inkl. Add-Type gemessen ~0,4 s,
 * läuft parallel zur Bildschirmaufnahme) und bleibt dann bereit, bis die
 * Leerlauf-Freigabe der Aufnahme (capture.ts) ihn mit disposeWindowHelper beendet.
 * Bereit beantwortet er jede Abfrage in wenigen Millisekunden über stdin/stdout.
 * Läuft rein lokal; es wird nur die Fenster-Geometrie gelesen, kein Bildinhalt.
 *
 * Rückgabe in PHYSISCHEN, globalen Bildschirmkoordinaten (DPI-bewusst) und in
 * Z-REIHENFOLGE (vorderstes Fenster zuerst) – wichtig für die Trefferauswahl.
 * Gefiltert werden minimierte und „cloaked" Fenster (unsichtbare UWP-Hüllen),
 * die sonst falsche Boxen erzeugen.
 */
export interface RawWindow {
  left: number
  top: number
  right: number
  bottom: number
  title: string
  hwnd?: number
}

const PS_SCRIPT = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class FSW {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int c);
  [DllImport("dwmapi.dll", EntryPoint="DwmGetWindowAttribute")] public static extern int DwmGetWindowAttributeInt(IntPtr h, int a, out int v, int c);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
[FSW]::SetProcessDPIAware() | Out-Null

function Get-FSWindows {
  $out = New-Object System.Collections.ArrayList
  $cb = {
    param($h, $l)
    if ([FSW]::IsWindowVisible($h) -and -not [FSW]::IsIconic($h)) {
      $len = [FSW]::GetWindowTextLength($h)
      if ($len -gt 0) {
        # UWP-Geisterfenster: sichtbar laut API, aber vom DWM "cloaked" -> ueberspringen.
        $cloaked = 0
        [FSW]::DwmGetWindowAttributeInt($h, 14, [ref]$cloaked, 4) | Out-Null
        # Durchklickbare Overlays (WS_EX_TRANSPARENT, z. B. Discord/GeForce-Overlay)
        # sind keine sichtbaren Ziele und wuerden als vorderstes Fenster alles verdecken.
        $ex = [FSW]::GetWindowLong($h, -20)
        if ($cloaked -eq 0 -and ($ex -band 0x20) -eq 0) {
          $sb = New-Object System.Text.StringBuilder ($len + 1)
          [FSW]::GetWindowText($h, $sb, $sb.Capacity) | Out-Null
          $r = New-Object FSW+RECT
          $ok = [FSW]::DwmGetWindowAttribute($h, 9, [ref]$r, [System.Runtime.InteropServices.Marshal]::SizeOf($r))
          if ($ok -ne 0) { [FSW]::GetWindowRect($h, [ref]$r) | Out-Null }
          $w = $r.Right - $r.Left; $ht = $r.Bottom - $r.Top
          if ($w -ge 20 -and $ht -ge 20 -and $r.Left -gt -30000) {
            [void]$out.Add([pscustomobject]@{ left=$r.Left; top=$r.Top; right=$r.Right; bottom=$r.Bottom; title=$sb.ToString(); hwnd=$h.ToInt64() })
          }
        }
      }
    }
    return $true
  }
  [FSW]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
  if ($out.Count -eq 0) { return "[]" }
  return (ConvertTo-Json -InputObject $out -Compress)
}

[Console]::Out.WriteLine("FSW_READY")
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line -or $line -eq "EXIT") { break }
  if ($line -eq "ENUM") { [Console]::Out.WriteLine((Get-FSWindows)) }
}
`

let helper: ChildProcess | null = null
let helperReady = false
let stdoutBuf = ''
// Immer nur eine Abfrage gleichzeitig (Aufnahmen laufen ohnehin einzeln).
let waiting: {
  resolve: (wins: RawWindow[]) => void
  timer: NodeJS.Timeout
  exclude?: Set<number>
} | null = null
let queuedEnum = false

function parseWindows(line: string): RawWindow[] {
  try {
    const parsed = JSON.parse(line)
    const arr = Array.isArray(parsed) ? parsed : [parsed]
    return arr.filter(
      (w) => w && typeof w.left === 'number' && typeof w.top === 'number'
    ) as RawWindow[]
  } catch {
    return []
  }
}

function settle(wins: RawWindow[]): void {
  if (!waiting) return
  clearTimeout(waiting.timer)
  const { resolve, exclude } = waiting
  waiting = null
  // Eigene Aufnahme-Fenster (Overlays/Aktionsleiste) per Handle aussortieren –
  // das Foldwing-Hauptfenster bleibt dabei erhalten und ist auswählbar.
  resolve(exclude && exclude.size ? wins.filter((w) => !exclude.has(w.hwnd ?? -1)) : wins)
}

function killHelper(): void {
  helperReady = false
  queuedEnum = false
  stdoutBuf = ''
  if (helper) {
    try {
      helper.stdin?.write('EXIT\n')
    } catch {
      /* Prozess ist schon weg */
    }
    helper.kill()
    helper = null
  }
}

function spawnHelper(): void {
  if (process.platform !== 'win32') return // PowerShell-Helfer gibt es nur auf Windows
  if (helper) return
  let child: ChildProcess
  try {
    child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCRIPT],
      { windowsHide: true }
    )
  } catch {
    return
  }
  helper = child
  helperReady = false
  stdoutBuf = ''

  child.stdout?.on('data', (d) => {
    stdoutBuf += d.toString()
    let nl: number
    while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, nl).trim()
      stdoutBuf = stdoutBuf.slice(nl + 1)
      if (!line) continue
      if (line === 'FSW_READY') {
        helperReady = true
        // Eine Abfrage wartete bereits auf den Start -> jetzt stellen.
        if (queuedEnum) {
          queuedEnum = false
          child.stdin?.write('ENUM\n')
        }
        continue
      }
      settle(parseWindows(line))
    }
  })
  const onGone = (): void => {
    if (helper === child) {
      helper = null
      helperReady = false
      queuedEnum = false
    }
    settle([])
  }
  child.on('error', onGone)
  child.on('exit', onGone)
}

export function disposeWindowHelper(): void {
  settle([])
  killHelper()
}

/** Fensterliste abfragen; startet den Helfer bei Bedarf (Kaltstart). */
export function enumerateWindows(
  timeoutMs = 2000,
  exclude?: Set<number>
): Promise<RawWindow[]> {
  return new Promise((resolve) => {
    // Läuft schon eine Abfrage, hängen wir uns nicht dahinter – leer auflösen.
    if (waiting) return resolve([])
    spawnHelper()
    if (!helper) return resolve([])

    const timer = setTimeout(() => {
      waiting = null
      if (helperReady) {
        // Bereit, antwortet aber nicht -> hängt: beenden, der nächste Aufruf startet frisch.
        killHelper()
      } else {
        // Noch im Kaltstart (z. B. sehr langsamer Rechner): nur diese Abfrage verfällt,
        // der Helfer startet zu Ende und ist für die nächste Aufnahme bereit. Ihn hier
        // abzuschießen hieße, dass er auf so einem Rechner nie fertig wird. Hängt er
        // wirklich, räumt ihn die Leerlauf-Freigabe ab.
        queuedEnum = false
      }
      resolve([])
    }, timeoutMs)
    waiting = { resolve, timer, exclude }

    if (helperReady) helper.stdin?.write('ENUM\n')
    else queuedEnum = true
  })
}
