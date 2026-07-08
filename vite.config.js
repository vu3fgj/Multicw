import { defineConfig } from 'vite'
import fs from 'fs'
import path from 'path'

const corsHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'cross-origin',
}

const MAIN_BUNDLE = 'index-tGNLfWKa.js'

// Patch 1: Domain gate — the bundle only loads models on deepcw/e04 hostnames.
const DOMAIN_GATE_ORIGINAL = 'function Rs(){const t=globalThis.location.hostname;return t.includes("deepcw")||t.includes("e04")}'
const DOMAIN_GATE_PATCHED  = 'function Rs(){return true}'

// Patch 2: pb() loads the cw_detect model needed only for auto-frequency-detection.
// When Rs() returns true (our patch), pb() no longer returns early, so it tries to
// fetch the cw_detect model we don't have — blocking multi-mode from initialising.
// Restore the early-return so multi-mode works without the cw_detect model.
const PB_ORIGINAL = 'async function pb(t="wasm"){if(!Rs())return;const e="cw_detect"'
const PB_PATCHED  = 'async function pb(t="wasm"){return;if(!Rs())return;const e="cw_detect"'

function applyPatches(content) {
  return content
    .replace(DOMAIN_GATE_ORIGINAL, DOMAIN_GATE_PATCHED)
    .replace(PB_ORIGINAL, PB_PATCHED)
}

function servePatched(filePath, res, extraHeaders = {}) {
  const content = fs.readFileSync(filePath, 'utf8')
  Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v))
  Object.entries(extraHeaders).forEach(([k, v]) => res.setHeader(k, v))
  res.setHeader('Content-Type', 'application/javascript')
  res.end(applyPatches(content))
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
                const size = fs.statSync(f).size
                res.setHeader('Content-Type', 'application/octet-stream')
                res.setHeader('Content-Length', size)
                Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v))
                fs.createReadStream(f).pipe(res)
                return
              }
            }
            // Fallback: serve standard model only for known narrow model hashes
            // (not for cw_detect or other types which have incompatible binary formats)
            const NARROW_MODEL_HASHES = new Set([
              '87f4f8a3164f727b5681a012b73dfa369d5177789aebafb4d8f37121fff836b0', // en_narrow_tiny
              '894fe3acc4d459b0283747f5dc8e9ea1b2e3912d0e8075a244d8b95d841290be', // en_narrow_small
            ])
            if (NARROW_MODEL_HASHES.has(hash)) {
              const fallback = path.resolve('./models/model_en.cwm')
              if (fs.existsSync(fallback)) {
                const size = fs.statSync(fallback).size
                res.setHeader('Content-Type', 'application/octet-stream')
                res.setHeader('Content-Length', size)
                Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v))
                fs.createReadStream(fallback).pipe(res)
                return
              }
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
