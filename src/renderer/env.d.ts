/// <reference types="vite/client" />
import type { YonderAPI } from '../shared/api'

declare global {
  interface Window {
    yonder: YonderAPI
  }
  /** Build-time flag: `YONDER_ADS=off npm run build` produces an ad-free build. */
  const __YONDER_ADS__: boolean
}

declare module '*.png' {
  const src: string
  export default src
}
declare module '*.svg' {
  const src: string
  export default src
}
declare module '*?url' {
  const src: string
  export default src
}
