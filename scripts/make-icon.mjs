// Erzeugt das App-Icon (build/icon.ico + build/icon.png, auch Quelle des
// Infobereich-Symbols) aus dem Papierflieger-Logo. Wird vor dem Paketieren
// ausgeführt, damit die App das richtige Symbol trägt.
//
// Das Logo: ein Papierflieger im Low-Poly-Stil auf blauer Kachel, drei flache
// Facetten (weiße Tragfläche, hellblaue Gegenseite, dunkelblauer Kiel). Dieselbe
// Form steht in src/main/brand.ts und src/renderer/src/components/Logo.tsx;
// docs/media/make_media.mjs liest das SVG unten (const SVG) für docs/media/logo.svg.
import { Resvg } from '@resvg/resvg-js'
import pngToIco from 'png-to-ico'
import { mkdirSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const buildDir = join(root, 'build')
mkdirSync(buildDir, { recursive: true })

// Sichtbarer Name auf dem Startbild, wie APP_NAME in src/main/brand.ts.
const PRODUCT = 'Foldwing'

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="120" height="120">
  <rect width="120" height="120" rx="26" fill="#2563eb"/>
  <path d="M106 18 L8 56 L42 70 L64 77 Z" fill="#ffffff"/>
  <path d="M106 18 L64 77 L58 110 Z" fill="#c3d6ff"/>
  <path d="M42 70 L64 77 L58 110 Z" fill="#1a3d9c"/>
</svg>`

function renderPng(size) {
  const resvg = new Resvg(SVG, { fitTo: { mode: 'width', value: size } })
  return resvg.render().asPng()
}

// Mehrere Größen für ein sauberes Windows-Icon.
const sizes = [256, 128, 64, 48, 32, 24, 16]
const pngs = sizes.map(renderPng)

const ico = await pngToIco(pngs)
writeFileSync(join(buildDir, 'icon.ico'), ico)
writeFileSync(join(buildDir, 'icon.png'), renderPng(512))

// Startbild der Portable-Exe: Sie entpackt sich bei jedem Start erst ein paar
// Sekunden lang (rund 95 MB) – ohne Bild sähe man in der Zeit gar nichts.
// electron-builder will dafür eine BMP (portable.splashImage in package.json).
const SPLASH_W = 360
const SPLASH_H = 200
const SPLASH_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SPLASH_W} ${SPLASH_H}" width="${SPLASH_W}" height="${SPLASH_H}">
  <rect width="${SPLASH_W}" height="${SPLASH_H}" fill="#f6f8fa"/>
  <rect x="0.5" y="0.5" width="${SPLASH_W - 1}" height="${SPLASH_H - 1}" fill="none" stroke="#d8dee6"/>
  <g transform="translate(${SPLASH_W / 2 - 32} 44) scale(0.5333)">${SVG.replace(/<\/?svg[^>]*>/g, '')}</g>
  <text x="${SPLASH_W / 2}" y="146" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="20" font-weight="600" fill="#151a20">${PRODUCT}</text>
  <text x="${SPLASH_W / 2}" y="172" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="13" fill="#5d6875">startet…</text>
</svg>`

/** RGBA-Pixel als 24-Bit-BMP (unten beginnend, Zeilen auf 4 Byte aufgefüllt, Alpha über Weiß). */
function toBmp(width, height, rgba) {
  const rowSize = Math.ceil((width * 3) / 4) * 4
  const size = 54 + rowSize * height
  const buf = Buffer.alloc(size)
  buf.write('BM', 0, 'ascii')
  buf.writeUInt32LE(size, 2)
  buf.writeUInt32LE(54, 10)
  buf.writeUInt32LE(40, 14)
  buf.writeInt32LE(width, 18)
  buf.writeInt32LE(height, 22)
  buf.writeUInt16LE(1, 26)
  buf.writeUInt16LE(24, 28)
  buf.writeUInt32LE(rowSize * height, 34)
  for (let y = 0; y < height; y++) {
    const row = 54 + (height - 1 - y) * rowSize
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const a = rgba[i + 3] / 255
      const mix = (c) => Math.round(c * a + 255 * (1 - a))
      buf[row + x * 3] = mix(rgba[i + 2])
      buf[row + x * 3 + 1] = mix(rgba[i + 1])
      buf[row + x * 3 + 2] = mix(rgba[i])
    }
  }
  return buf
}

const splash = new Resvg(SPLASH_SVG, { font: { loadSystemFonts: true } }).render()
writeFileSync(join(buildDir, 'portable-splash.bmp'), toBmp(splash.width, splash.height, splash.pixels))

console.log(`[${PRODUCT}] build/icon.ico, build/icon.png und build/portable-splash.bmp erzeugt.`)
