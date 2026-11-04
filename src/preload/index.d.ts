import type { FoldwingApi } from './index'

declare global {
  interface Window {
    foldwing: FoldwingApi
  }
}

export {}
