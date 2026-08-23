from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REGRESSION_ACTIVE = True


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path == "/health":
            self._write_json(200, {"status": "ok"})
            return
        if self.path == "/api/checkout/quote":
            if REGRESSION_ACTIVE:
                self._write_json(500, {"error": "currency code is required"})
            else:
                self._write_json(200, {"currency": "USD", "total": 4200})
            return
        self._write_json(404, {"error": "not found"})

    def log_message(self, format: str, *args: object) -> None:
        return

    def _write_json(self, status_code: int, body: dict[str, object]) -> None:
        encoded = json.dumps(body).encode()
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
