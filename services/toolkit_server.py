"""Local helper service for the splat toolkit.

The browser app talks to this process for the heavy steps that cannot run in a
web page. It listens on 127.0.0.1 only and keeps everything on this machine.

    GET  /health            -> which tools are available
    POST /sharp?name=<file> -> body: an image file; response: a 3DGS .ply
                               predicted by Apple SHARP (github.com/apple/ml-sharp)

SHARP's model weights are licensed by Apple for non-commercial research use
only (see services/vendor/ml-sharp/LICENSE_MODEL).

New tools are added as a function in TOOLS below.
"""

from __future__ import annotations

import json
import logging
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HOST = "127.0.0.1"
PORT = 3002
# only the local dev app may call the service from a browser
ALLOWED_ORIGINS = {"http://localhost:3000", "http://127.0.0.1:3000"}
MAX_UPLOAD = 200 * 1024 * 1024

LOGGER = logging.getLogger("toolkit")


class Sharp:
    """Apple SHARP: single image -> 3D gaussians. The model is loaded on first use and kept."""

    def __init__(self):
        self.lock = threading.Lock()
        self.predictor = None
        self.device = None

    @staticmethod
    def available() -> bool:
        try:
            import sharp  # noqa: F401
            return True
        except Exception:
            return False

    def load(self):
        if self.predictor is not None:
            return
        import torch
        from sharp.cli.predict import DEFAULT_MODEL_URL
        from sharp.models import PredictorParams, create_predictor

        self.device = "mps" if torch.backends.mps.is_available() else "cpu"
        LOGGER.info("loading SHARP on %s (first run downloads the checkpoint)", self.device)
        state_dict = torch.hub.load_state_dict_from_url(DEFAULT_MODEL_URL, progress=True)
        predictor = create_predictor(PredictorParams())
        predictor.load_state_dict(state_dict)
        predictor.eval()
        predictor.to(self.device)
        self.predictor = predictor

    def run(self, image_bytes: bytes, name: str) -> bytes:
        import torch
        from sharp.cli.predict import predict_image
        from sharp.utils import io
        from sharp.utils.gaussians import save_ply

        suffix = Path(name).suffix.lower() or ".png"
        with self.lock, tempfile.TemporaryDirectory() as tmp:
            self.load()
            image_path = Path(tmp) / f"input{suffix}"
            image_path.write_bytes(image_bytes)
            image, _, f_px = io.load_rgb(image_path)
            height, width = image.shape[:2]
            start = time.time()
            gaussians = predict_image(self.predictor, image, f_px, torch.device(self.device))
            ply_path = Path(tmp) / "output.ply"
            save_ply(gaussians, f_px, (height, width), ply_path)
            LOGGER.info("SHARP: %s (%dx%d) in %.1fs", name, width, height, time.time() - start)
            return ply_path.read_bytes()


SHARP = Sharp()

# tool name -> (availability check, handler(body, query) -> (content type, bytes))
TOOLS = {
    "sharp": (
        Sharp.available,
        lambda body, query: ("application/octet-stream", SHARP.run(body, query.get("name", ["image.png"])[0])),
    ),
}


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        origin = self.headers.get("Origin")
        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Private-Network", "true")

    def _send(self, status: int, content_type: str, body: bytes):
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: int, payload: dict):
        self._send(status, "application/json", json.dumps(payload).encode())

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if urlparse(self.path).path == "/health":
            self._json(200, {"ok": True, "tools": {name: check() for name, (check, _) in TOOLS.items()}})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        origin = self.headers.get("Origin")
        if origin is not None and origin not in ALLOWED_ORIGINS:
            self._json(403, {"error": "origin not allowed"})
            return
        url = urlparse(self.path)
        tool = TOOLS.get(url.path.strip("/"))
        if tool is None:
            self._json(404, {"error": "unknown tool"})
            return
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > MAX_UPLOAD:
            self._json(400, {"error": "missing or oversized body"})
            return
        body = self.rfile.read(length)
        try:
            content_type, result = tool[1](body, parse_qs(url.query))
        except Exception as error:  # report the failure to the app instead of dropping the connection
            LOGGER.exception("tool failed")
            self._json(500, {"error": str(error)})
            return
        self._send(200, content_type, result)

    def log_message(self, format, *args):
        LOGGER.info("%s %s", self.address_string(), format % args)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    LOGGER.info("toolkit service on http://%s:%d", HOST, PORT)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
