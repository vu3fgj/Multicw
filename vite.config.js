import { defineConfig } from 'vite'
import fs from 'fs'
import path from 'path'

const corsHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'cross-origin',
}

const MAIN_BUNDLE = 'index-tGNLfWKa.js'
const INFERENCE_WORKER = 'inferenceWorker-Dy9Yeymx.js'

// Patch 1: Domain gate — allow any host
const DOMAIN_GATE_ORIGINAL = 'function Rs(){const t=globalThis.location.hostname;return t.includes("deepcw")||t.includes("e04")}'
const DOMAIN_GATE_PATCHED  = 'function Rs(){return true}'

// Patch 2: Disable cw_detect model load (we don't have it; it blocks multi-mode init)
const PB_ORIGINAL = 'async function pb(t="wasm"){if(!Rs())return;const e="cw_detect"'
const PB_PATCHED  = 'async function pb(t="wasm"){return;if(!Rs())return;const e="cw_detect"'

// Patch 3: Rebrand
const BRAND_PATCHES = [
  ['k$="DeepCW"',                            'k$="VU22DX MULTI Decoders"'],
  ['"Add DeepCW to your Home Screen"',       '"Add VU22DX MULTI Decoders to your Home Screen"'],
  ['"Install DeepCW"',                       '"Install VU22DX MULTI Decoders"'],
  ['children:"DeepCW"',                      'children:"VU22DX MULTI Decoders"'],
  ['Copyright \u00A9 2026 e04',              'Copyright \u00A9 2026 VU22DX'],
]

// Patch 4: Remove visible icon/logo and GitHub links
const UI_PATCHES = [
  [
    '(Pe=x.jsx("img",{src:"/icon.svg",alt:"","aria-hidden":"true",width:28,height:28,style:{display:"block",flexShrink:0,borderRadius:7}}),t[25]=Pe)',
    '(Pe=null,t[25]=Pe)',
  ],
  [
    'Zn=x.jsx(Ar,{component:"a",href:P$,target:"_blank",rel:"noreferrer",variant:"subtle",color:"gray",size:"xs",children:"Project Page"})',
    'Zn=null',
  ],
  [
    'x.jsx(At,{component:"a",size:"xs",c:"dimmed",href:"https://github.com/e04/",style:{lineHeight:1,whiteSpace:"nowrap"},children:"Copyright \u00A9 2026 VU22DX"})',
    'x.jsx(At,{size:"xs",c:"dimmed",style:{lineHeight:1,whiteSpace:"nowrap"},children:"Copyright \u00A9 2026 VU22DX"})',
  ],
]

// Patch 5: Quality/model settings and multi-mode model variant
//
// Model files we have:
//   model_en.cwm      (563926 bytes) = en_tiny    hash ee47e1... — broadband 400-1200Hz
//   model_en_high.cwm (523990 bytes) = en_narrow_tiny hash 87f4f8... — narrow 712-887Hz ONLY
//
// IMPORTANT: en_narrow model covers only a 175Hz window (712-887Hz). Multi-mode decodes
// signals at arbitrary frequencies — using the narrow model means no decodes unless every
// signal happens to be in that exact 175Hz band. Fix: patch multi-mode to use "standard"
// variant (broadband en_tiny/en_small). The Yn() per-channel audio slicer (Ut()) already
// extracts the correct frequency window per track, so the standard model works correctly.
//
// Missing: en_small (051307) — no higher-accuracy model available; falls back to model_en.cwm.
//
// Quality slider: low="tiny"/6s  mid="small"/12s  high="small"/18s
const PERF_PATCHES = [
  // Refresh rate: 100ms for snappier display
  ['gy=200,', 'gy=100,'],
  // Default quality: "small" (HIGH) — best available model + long window
  ['"decoder.modelSize","tiny",lW', '"decoder.modelSize","small",lW'],
  // Quality presets: low=tiny/6s, mid=small/12s, high=small/18s
  // Original: low=tiny/6s, mid=tiny/12s, high=small/12s
  ['accuracy:"mid",accuracyLabel:"MID",modelSize:"tiny",windowSeconds:12',
   'accuracy:"mid",accuracyLabel:"MID",modelSize:"small",windowSeconds:12'],
  ['accuracy:"high",accuracyLabel:"HIGH",modelSize:"small",windowSeconds:12',
   'accuracy:"high",accuracyLabel:"HIGH",modelSize:"small",windowSeconds:18'],
  // Fix multi-mode: use standard (broadband) model instead of narrow (712-887Hz only)
  // Multi-mode's Yn() function already handles per-channel frequency windowing via Ut()
  ['modelSize:a,englishModelVariant:"narrow"', 'modelSize:a,englishModelVariant:"standard"'],
]

function applyPatches(content) {
  let out = content
    .replace(DOMAIN_GATE_ORIGINAL, DOMAIN_GATE_PATCHED)
    .replace(PB_ORIGINAL, PB_PATCHED)
  for (const [orig, patched] of BRAND_PATCHES) {
    out = out.split(orig).join(patched)
  }
  for (const [orig, patched] of UI_PATCHES) {
    out = out.split(orig).join(patched)
  }
  for (const [orig, patched] of PERF_PATCHES) {
    out = out.split(orig).join(patched)
  }
  return out
}

function servePatched(filePath, res, extraHeaders = {}) {
  const content = fs.readFileSync(filePath, 'utf8')
  Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v))
  Object.entries(extraHeaders).forEach(([k, v]) => res.setHeader(k, v))
  res.setHeader('Content-Type', 'application/javascript')
  res.end(applyPatches(content))
}

// Patch 6: Tone separation for multi-mode (pile-up)
//
// The inferenceWorker detects CW signals by scanning the spectrogram for peaks.
// In a pile-up, multiple stations transmit simultaneously on very close frequencies
// (often within 50-200Hz of each other). The peak-splitting algorithm uses two
// parameters to decide when to split a broad spectral peak into two separate tones:
//
//   Gr = splitProminence: how prominent the valley between two peaks must be.
//        Lower = split more aggressively = better for closely-spaced signals.
//        Original 0.15 → 0.08
//
//   Qr = splitValleyRatio: how deep the valley must be relative to the lower peak.
//        Lower = allow shallower valleys = catches near-identical-frequency callers.
//        Original 0.75 → 0.60
//
// These values were tuned so that:
//   - Two CW tones ~50Hz apart (4 bins at 12.5Hz resolution) get split correctly
//   - Single tones with minor spectral ripple don't produce ghost channels
const INFERENCE_WORKER_PATCHES = [
  ['Gr=.15,Qr=.75', 'Gr=.08,Qr=.60'],
]

function applyWorkerPatches(content) {
  let out = content
  for (const [orig, patched] of INFERENCE_WORKER_PATCHES) {
    out = out.split(orig).join(patched)
  }
  return out
}

// Model hash → local file mapping
// Hashes taken from the bundle's Xa constant:
//   en.tiny        = ee47e1... → model_en.cwm       (broadband standard, 400-1200Hz)
//   en.small       = 051307... → model_en.cwm        (no small variant; same weights)
//   en_narrow.tiny = 87f4f8... → model_en.cwm        (use standard; narrow model is 712-887Hz only)
//   en_narrow.small= 894fe3... → model_en.cwm        (use standard; narrow model is 712-887Hz only)
//   cw_detect      = 2794af... → (disabled; pb() returns early)
//
// Multi-mode is patched to use "standard" variant so it correctly uses en_tiny/en_small
// hashes (ee47e1/051307) rather than narrow hashes. Both point to model_en.cwm.
const MODEL_HASH_MAP = {
  'ee47e1c50b12354e2d6737e5b082428e9669fe22c68c208da74f1877c6763d7b': 'model_en.cwm',
  '051307efd5ab1b129948077404d70879d239ac4ec19dc4899fe6d464707d3ffe': 'model_en.cwm',
  '87f4f8a3164f727b5681a012b73dfa369d5177789aebafb4d8f37121fff836b0': 'model_en.cwm',
  '894fe3acc4d459b0283747f5dc8e9ea1b2e3912d0e8075a244d8b95d841290be': 'model_en.cwm',
}

export default defineConfig({
  plugins: [
    {
      name: 'coop-coep-and-model-serving',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v))

          const urlPath = req.url?.split('?')[0] ?? ''

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

          if (urlPath.endsWith(INFERENCE_WORKER)) {
            const candidates = [
              path.resolve('./public/assets', INFERENCE_WORKER),
              path.resolve('./assets', INFERENCE_WORKER),
            ]
            for (const f of candidates) {
              if (fs.existsSync(f)) {
                const content = fs.readFileSync(f, 'utf8')
                Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v))
                res.setHeader('Content-Type', 'application/javascript')
                res.end(applyWorkerPatches(content))
                return
              }
            }
          }

          if (urlPath.startsWith('/models/')) {
            const hash = decodeURIComponent(urlPath.slice('/models/'.length))

            // First: try exact file match in public/models or models/
            const exactCandidates = [
              path.resolve('./public/models', hash),
              path.resolve('./models', hash),
              path.resolve('./models', hash + '.html'),
            ]
            for (const f of exactCandidates) {
              if (fs.existsSync(f)) {
                const size = fs.statSync(f).size
                res.setHeader('Content-Type', 'application/octet-stream')
                res.setHeader('Content-Length', size)
                Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v))
                fs.createReadStream(f).pipe(res)
                return
              }
            }

            // Second: use hash map to serve the correct model file
            const mappedFile = MODEL_HASH_MAP[hash]
            if (mappedFile) {
              const modelPath = path.resolve('./models', mappedFile)
              if (fs.existsSync(modelPath)) {
                const size = fs.statSync(modelPath).size
                res.setHeader('Content-Type', 'application/octet-stream')
                res.setHeader('Content-Length', size)
                Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v))
                fs.createReadStream(modelPath).pipe(res)
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
