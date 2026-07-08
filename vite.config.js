import { defineConfig } from 'vite'
import fs from 'fs'
import path from 'path'

const corsHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'cross-origin',
}

export default defineConfig({
  plugins: [
    {
      name: 'coop-coep-and-model-serving',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          // COOP/COEP on every response for SharedArrayBuffer support
          Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v))

          // Serve model binary files: /models/<hash> → models/<hash>[.html]
          if (req.url?.startsWith('/models/')) {
            const hash = decodeURIComponent(req.url.slice('/models/'.length).split('?')[0])
            const candidates = [
              path.resolve('./models', hash),
              path.resolve('./models', hash + '.html'),
              path.resolve('./public/models', hash),
            ]
            for (const f of candidates) {
              if (fs.existsSync(f)) {
                res.setHeader('Content-Type', 'application/octet-stream')
                Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v))
                fs.createReadStream(f).pipe(res)
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
