import { useRef, useState } from 'react'
import { Icon } from './Icon'

interface Props {
  onUpload: (files: FileList | File[]) => void
  /** Flach, sobald es Freigaben gibt: die Liste soll oben bleiben. */
  compact?: boolean
}

/**
 * Ablage-Fläche, der Fokus der Teilen-Ansicht. Ein echter Knopf: Klick, Enter
 * oder Leertaste öffnen die Dateiauswahl, Ziehen und Ablegen geht auch.
 */
export function Dropzone({ onUpload, compact = false }: Props): JSX.Element {
  const [over, setOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    setOver(false)
    if (e.dataTransfer.files.length) onUpload(e.dataTransfer.files)
  }

  return (
    <>
      <button
        type="button"
        className={`dropzone ${compact ? 'dropzone--compact' : ''} ${over ? 'dropzone--over' : ''}`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={handleDrop}
      >
        <span className="dropzone__icon" aria-hidden>
          <Icon name="upload" size={compact ? 20 : 24} />
        </span>
        <span>
          <span className="dropzone__title">
            {over ? 'Loslassen zum Teilen' : compact ? 'Weitere Dateien hier ablegen' : 'Dateien hier ablegen'}
          </span>
          <span className="dropzone__hint" style={{ display: 'block' }}>
            oder klicken und auswählen. Mehrere Dateien bekommen einen gemeinsamen Link.
          </span>
        </span>
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length) onUpload(e.target.files)
          e.target.value = ''
        }}
      />
    </>
  )
}
