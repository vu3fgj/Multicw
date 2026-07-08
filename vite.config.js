import { defineConfig } from 'vite'
import fs from 'fs'
import path from 'path'

const corsHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'cross-origin',
}

// Domain gate patch: the pre-built bundle only loads models on deepcw/e04 hostnames.
// Replace the check so it always returns true.
const DOMAIN_GATE_ORIGINAL = 'function Rs(){const t=globalThis.location.hostname;return t.includes("deepcw")||t.includes("e04")}'
const DOMAIN_GATE_PATCHED  = 'function Rs(){return true}'

const MAIN_BUNDLE = 'index-tGNLfWKa.js'

function servePatched(filePath, res, extraHeaders = {}) {
  const content = fs.readFileSync(filePath, 'utf8')
  const patched = content.includes(DOMAIN_GATE_ORIGINAL)
    ? content.replace(DOMAIN_GATE_ORIGINAL, DOMAIN_GATE_PATCHED)
    : content
  Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v))
  Object.entries(extraHeaders).forEach(([k, v]) => res.setHeader(k, v))
  res.setHeader('Content-Type', 'application/javascript')
  res.end(patched)
}

export default defineConfig({
  plugins: [
    {
      name: 'coop-coep-and-model-serving',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          // COOP/COEP on every response for SharedArrayBuffer support
          Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v))

          const urlPath = req.url?.split('?')[0] ?? ''

          // Patch the main bundle to remove the domain gate
          if (urlPath.endsWith(MAIN_BUNDLE)) {
            const candidates = [
              path.resolve('./public/assets', MAIN_BUNDLE),
              path.resolve('./assets', MAIN_BUNDLE),
            ]
            for (const f of candidates) {
              if (fs.existsSync(f)) {
                servePatched(f, res)
                return
              }
            }
          }

          // Serve model binary files: /models/<hash> → models/<hash>[.html]
          if (urlPath.startsWith('/models/')) {
            const hash = decodeURIComponent(urlPath.slice('/models/'.length))
            const candidates = [
              path.resolve('./public/models', hash),
              path.resolve('./models', hash),
              path.resolve('./models', hash + '.html'),
            ]
            for (const f of candidates) {
              if (fs.existsSync(f)) {
                res.setHeader('Content-Type', 'application/octet-stream')
                Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v))
                fs.createReadStream(f).pipe(res)
                return
              }
            }
            // Fallback: serve standard model for any unknown model hash
            const fallback = path.resolve('./models/model_en.cwm')
            if (fs.existsSync(fallback)) {
              res.setHeader('Content-Type', 'application/octet-stream')
              Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v))
              fs.createReadStream(fallback).pipe(res)
              return
            }
          }

          next()
        })
      },
      configurePreviewServer(server) {
        server.middlewares.use((req, res, next) => {
          Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v))
          next()
        })
      },
    },
  ],
  server: {
    headers: corsHeaders,
    fs: { allow: ['.'] },
  },
  preview: {
    headers: corsHeaders,
  },
})
