import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'

/** Vite's dev server injects inline scripts (HMR/react-refresh) and uses a
 *  websocket; relax the CSP for `serve` only. Production keeps the strict
 *  policy in index.html untouched. */
function devCsp(): Plugin {
  let serve = false
  return {
    name: 'yonder-dev-csp',
    configResolved(cfg) {
      serve = cfg.command === 'serve'
    },
    transformIndexHtml(html) {
      if (!serve) return html
      return html
        .replace("script-src 'self';", "script-src 'self' 'unsafe-inline';")
        .replace("connect-src 'self' blob:;", "connect-src 'self' blob: ws://localhost:* http://localhost:*;")
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared'), '@core': resolve('src/core'), '@node': resolve('src/node') } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared'), '@core': resolve('src/core') } }
  },
  renderer: {
    plugins: [react(), devCsp()],
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@shared': resolve('src/shared'),
        '@core': resolve('src/core')
      }
    },
    define: {
      __YONDER_ADS__: JSON.stringify(process.env.YONDER_ADS !== 'off')
    },
    build: {
      target: 'chrome140',
      rollupOptions: {
        output: { manualChunks: { pdfjs: ['pdfjs-dist'], pdflib: ['pdf-lib'] } }
      }
    },
    worker: { format: 'es' }
  }
})
