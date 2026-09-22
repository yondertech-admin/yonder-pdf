// Builds the headless CLI + MCP server (design §15 #18): plain Node ESM in
// out/cli, everything bundled except Node built-ins and pdfjs-dist (resolved
// at runtime so the packaged app can ship it unpacked next to the CLI).
import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string }

export default defineConfig({
  resolve: { alias: { '@core': resolve('src/core'), '@node': resolve('src/node'), '@shared': resolve('src/shared') } },
  define: { __YONDER_VERSION__: JSON.stringify(pkg.version) },
  ssr: { noExternal: true, target: 'node' },
  build: {
    outDir: 'out/cli',
    emptyOutDir: true,
    target: 'node22',
    ssr: true,
    minify: false,
    sourcemap: false,
    lib: {
      entry: { index: resolve('src/cli/index.ts'), mcp: resolve('src/mcp/index.ts') },
      formats: ['es'],
      fileName: (_format, name) => `${name}.mjs`
    },
    rollupOptions: { external: [/^node:/, /^pdfjs-dist/] }
  }
})
