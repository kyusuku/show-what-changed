import http.server
import sys

class Page(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.end_headers()
        self.wfile.write(b'<h1>Python source</h1><button onclick="this.textContent=\'Selected\'">Select item</button>')

http.server.HTTPServer(('127.0.0.1', int(sys.argv[1])), Page).serve_forever()
