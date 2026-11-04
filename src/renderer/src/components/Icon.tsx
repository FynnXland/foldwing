interface Props {
  name: IconName
  size?: number
  className?: string
}

export type IconName =
  | 'sun'
  | 'moon'
  | 'upload'
  | 'settings'
  | 'image'
  | 'video'
  | 'file'
  | 'archive'
  | 'trash'
  | 'plus'
  | 'save'
  | 'edit'
  | 'link'
  | 'external'
  | 'copy'
  | 'search'
  | 'check'
  | 'x'
  | 'download'
  | 'server'
  | 'file-text'
  | 'table'
  | 'music'
  | 'eye'
  | 'eye-off'
  | 'clock'
  | 'alert'

// Icons, die als Fläche (gefüllt) statt als Linie gezeichnet werden.
const FILLED = new Set<IconName>(['settings'])

// Schlichte Linien-Icons (currentColor), eigene Pfade; ersetzen die früheren Emojis.
const PATHS: Record<IconName, string> = {
  sun: 'M12 3v2M12 19v2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M3 12h2M19 12h2M5.6 18.4l1.4-1.4M17 7l1.4-1.4|circle:12,12,4',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  upload: 'M12 15V3M8 7l4-4 4 4M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4',
  // Vollflächiges Zahnrad (Material-Stil) – klar erkennbar, mit ausgestanzter Nabe.
  settings:
    'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z',
  image: 'M3 5h18v14H3z|circle:8.5,10,1.5|M21 16l-5-5-9 8',
  video: 'M15 8l6-3v14l-6-3M3 6h12v12H3z',
  file: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6',
  archive: 'M3 5h18v4H3zM5 9v10h14V9M10 13h4',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  plus: 'M12 5v14M5 12h14',
  save: 'M5 3h11l3 3v15H5zM8 3v5h7M8 21v-7h8v7',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 5l4 4',
  link: 'M9 12h6M10 8H8a4 4 0 0 0 0 8h2M14 8h2a4 4 0 0 1 0 8h-2',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.3-4.3',
  check: 'M4 12l5 5L20 6',
  x: 'M6 6l12 12M18 6L6 18',
  download: 'M12 3v13M8 12l4 4 4-4M4 19v1a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-1',
  server: 'M3 4h18v7H3zM3 13h18v7H3zM7 7.5h.01M7 16.5h.01',
  'file-text': 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M9 13h6M9 17h6',
  table: 'M3 5h18v14H3zM3 10h18M9 5v14',
  music: 'M9 18V6l11-2v12|circle:6,18,3|circle:17,16,3',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z|circle:12,12,3',
  'eye-off':
    'M10.7 5.1A9.8 9.8 0 0 1 12 5c6.4 0 10 7 10 7a13.6 13.6 0 0 1-2 2.9M6.6 6.6A13.5 13.5 0 0 0 2 12s3.6 7 10 7a9.6 9.6 0 0 0 3.4-.6|M9.9 9.9a3 3 0 0 0 4.2 4.2|M3 3l18 18',
  clock: 'circle:12,12,9|M12 7v5l3 2',
  alert: 'M12 3.5l9.5 16.5h-19z|M12 10v4.5M12 17.5h.01'
}

export function Icon({ name, size = 18, className }: Props): JSX.Element {
  const parts = PATHS[name].split('|')
  const filled = FILLED.has(name)
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      fillRule="evenodd"
      className={className}
      aria-hidden
    >
      {parts.map((p, i) => {
        if (p.startsWith('circle:')) {
          const [cx, cy, r] = p.slice(7).split(',')
          return <circle key={i} cx={cx} cy={cy} r={r} />
        }
        return <path key={i} d={p} />
      })}
    </svg>
  )
}
