from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import sys
import threading
import time


ROOT = Path(__file__).resolve().parent
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 4173
LOG_PATH = Path(os.environ.get("DEBUG_LOG", "/tmp/ipad-scapple-pointer-events.jsonl"))
LOG_LOCK = threading.Lock()


class DebugHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_POST(self):
        if self.path.split("?", 1)[0] != "/__debug":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > 1_000_000:
            self.send_error(413)
            return
        try:
            payload = json.loads(self.rfile.read(length))
            events = payload if isinstance(payload, list) else [payload]
            events = [event for event in events[:500] if isinstance(event, dict)]
        except (json.JSONDecodeError, UnicodeDecodeError):
            self.send_error(400)
            return

        received_at = int(time.time() * 1000)
        lines = []
        for event in events:
            event["receivedAt"] = received_at
            lines.append(json.dumps(event, ensure_ascii=False, separators=(",", ":")))
        with LOG_LOCK:
            LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
            with LOG_PATH.open("a", encoding="utf-8") as log:
                log.write("\n".join(lines) + "\n")

        for event in events:
            if event.get("kind") != "pointer" or event.get("event") != "pointermove":
                print(json.dumps(event, ensure_ascii=False, separators=(",", ":")), flush=True)
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()


if __name__ == "__main__":
    handler = partial(DebugHandler, directory=ROOT)
    server = ThreadingHTTPServer(("", PORT), handler)
    print(f"Pointer debug server: http://0.0.0.0:{PORT}/?debug=1", flush=True)
    print(f"Event log: {LOG_PATH}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
