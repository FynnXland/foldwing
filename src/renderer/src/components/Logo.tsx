interface Props {
  size?: number
}

/**
 * Die Marke: ein Papierflieger im Low-Poly-Stil auf blauer Kachel. Drei flache
 * Facetten (weiße Tragfläche, hellblaue Gegenseite, dunkelblauer Kiel), damit er
 * auch klein als Flieger erkennbar bleibt. Gleiche Form wie scripts/make-icon.mjs.
 */
export function Logo({ size = 28 }: Props): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <rect width="120" height="120" rx="26" fill="#2563eb" />
      <path d="M106 18 L8 56 L42 70 L64 77 Z" fill="#ffffff" />
      <path d="M106 18 L64 77 L58 110 Z" fill="#c3d6ff" />
      <path d="M42 70 L64 77 L58 110 Z" fill="#1a3d9c" />
    </svg>
  )
}
