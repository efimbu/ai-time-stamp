#!/usr/bin/env python3
"""Local disk sink for AI Time Stamp userscript.

OrangeMonkey cannot write files. Run this, then the script POSTs logs here.

  python sink.py
  → http://127.0.0.1:8766
  → tmp/log.jsonl
"""

from __future__ import annotations

import json
import sys
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CONTROL = ROOT / "control"
CONFIG_LIVE = CONTROL / "config.json"
CONFIG_EXAMPLE = CONTROL / "config.example.json"
LOG = ROOT / "tmp" / "log.jsonl"
MAX_BODY = 2_000_000
LOCK = threading.Lock()
CFG: dict = {}
HOST = "127.0.0.1"
PORT = 8766


def load_config() -> dict:
    global CFG, HOST, PORT
    path = CONFIG_LIVE if CONFIG_LIVE.is_file() else CONFIG_EXAMPLE
    if not path.is_file():
        CFG = {"sink": {"host": HOST, "port": PORT}, "sites": []}
        return CFG
    with path.open(encoding="utf-8") as f:
        CFG = json.load(f)
    sink = CFG.get("sink") or {}
    HOST = str(sink.get("host") or HOST)
    PORT = int(sink.get("port") or PORT)
    CFG["_loaded_from"] = str(path)
    return CFG


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def cors(handler: BaseHTTPRequestHandler) -> None:
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type")
    handler.send_header("Cache-Control", "no-store")


def send_json(handler: BaseHTTPRequestHandler, code: int, obj: dict) -> None:
    raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    handler.send_response(code)
    cors(handler)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(raw)))
    handler.end_headers()
    handler.wfile.write(raw)


def records_from_body(obj) -> list[dict]:
    if obj is None:
        return []
    if isinstance(obj, list):
        out: list[dict] = []
        for item in obj:
            out.extend(records_from_body(item))
        return out
    if not isinstance(obj, dict):
        return [{"level": "RAW", "message": str(obj), "ts": utc_now()}]

    logs = obj.get("logs")
    if isinstance(logs, list):
        out = []
        for rec in logs:
            if isinstance(rec, dict):
                row = dict(rec)
                row.setdefault("page", obj.get("page"))
                row.setdefault("scriptVersion", obj.get("scriptVersion"))
                out.append(row)
            else:
                out.append({"level": "RAW", "message": str(rec)})
        return out
    return [obj]


def append_records(rows: list[dict]) -> int:
    if not rows:
        return 0
    LOG.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with LOCK:
        with LOG.open("a", encoding="utf-8") as f:
            for row in rows:
                if "receivedAt" not in row:
                    row["receivedAt"] = utc_now()
                f.write(json.dumps(row, ensure_ascii=False) + "\n")
                n += 1
    return n


def tail_lines(path: Path, n: int) -> list[str]:
    if not path.is_file() or n <= 0:
        return []
    # small log file: read whole; keep last n lines
    text = path.read_text(encoding="utf-8", errors="replace")
    lines = [ln for ln in text.splitlines() if ln.strip()]
    return lines[-n:]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        # userscript pings /health every few seconds — don't flood the console
        path = (self.path or "").split("?", 1)[0]
        if self.command in ("GET", "OPTIONS") and path in ("/", "/health", "/config"):
            return
        sys.stderr.write("[sink] " + (fmt % args) + "\n")

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        cors(self)
        self.end_headers()

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        size = LOG.stat().st_size if LOG.is_file() else 0
        if path in ("/", "/health"):
            send_json(
                self,
                200,
                {
                    "ok": True,
                    "log": str(LOG),
                    "bytes": size,
                    "port": PORT,
                    "config": CFG.get("_loaded_from"),
                },
            )
            return
        if path == "/config":
            public = {k: v for k, v in CFG.items() if not str(k).startswith("_")}
            send_json(self, 200, public)
            return
        if path == "/tail":
            n = 30
            if "?" in self.path:
                for part in self.path.split("?", 1)[1].split("&"):
                    if part.startswith("n="):
                        try:
                            n = max(1, min(200, int(part[2:])))
                        except ValueError:
                            pass
            send_json(
                self,
                200,
                {
                    "ok": True,
                    "log": str(LOG),
                    "bytes": size,
                    "lines": tail_lines(LOG, n),
                },
            )
            return
        send_json(self, 404, {"ok": False, "error": "not found"})

    def do_POST(self) -> None:
        path = self.path.split("?", 1)[0]
        if path != "/log":
            send_json(self, 404, {"ok": False, "error": "not found"})
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            send_json(self, 413, {"ok": False, "error": "too large"})
            return
        raw = self.rfile.read(length) if length else b""
        if not raw:
            send_json(self, 400, {"ok": False, "error": "empty body"})
            return
        try:
            obj = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as e:
            send_json(self, 400, {"ok": False, "error": str(e)})
            return
        n = append_records(records_from_body(obj))
        send_json(self, 200, {"ok": True, "written": n, "log": str(LOG)})


def main() -> None:
    load_config()
    LOG.parent.mkdir(parents=True, exist_ok=True)
    append_records(
        [
            {
                "level": "SINK",
                "message": "sink start",
                "port": PORT,
                "log": str(LOG),
                "config": CFG.get("_loaded_from"),
            }
        ]
    )
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"AI time sink  http://{HOST}:{PORT}")
    print(f"log file      {LOG}")
    print(f"config        {CFG.get('_loaded_from')}")
    print("Ctrl+C to stop")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
        httpd.server_close()


if __name__ == "__main__":
    main()
