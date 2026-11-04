import { readFileSync } from 'fs'
import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Produktname für index.html (Titel, Ladeanzeige) aus derselben Konstante wie die
// Oberfläche, damit er bei einer Umbenennung nur in src/renderer/src/brand.ts steht.
const APP_NAME =
  /APP_NAME = '([^']+)'/.exec(readFileSync(resolve('src/renderer/src/brand.ts'), 'utf8'))?.[1] ?? 'App'
const appName = {
  name: 'app-name',
  transformIndexHtml: (html: string): string => html.replaceAll('%APP_NAME%', APP_NAME)
}

// Abhängigkeiten aus package.json bleiben in Main und Preload extern
// (build.externalizeDeps, seit electron-vite 5 Standard).
export default defineConfig({
  main: {
    build: {
      rolldownOptions: {
        input: { index: resolve('src/main/index.ts') }
      }
    }
  },
  preload: {
    build: {
      rolldownOptions: {
        input: { index: resolve('src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    build: {
      rolldownOptions: {
        input: { index: resolve('src/renderer/index.html') }
      }
    },
    plugins: [react(), appName]
  }
})
