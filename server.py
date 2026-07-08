import http.server
import socketserver

PORT = 8000

class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # These headers unlock multithreaded WebAssembly (SharedArrayBuffer)
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        super().end_headers()

# Force Python to recognize WebAssembly files properly
Handler.extensions_map['.wasm'] = 'application/wasm'

with socketserver.TCPServer(("", PORT), Handler) as httpd:
    print(f"SDR Decoder Server running on http://localhost:{PORT}")
    print("Cross-Origin Isolation enabled. WASM MIME types configured.")
    httpd.serve_forever()