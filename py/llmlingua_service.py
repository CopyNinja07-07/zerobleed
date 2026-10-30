"""LLMLingua-2 (Pan et al., 2024) prompt compression as a benchmark framework,
using Microsoft's official `llmlingua` package and the published
llmlingua-2-xlm-roberta-large-meetingbank model, running locally.

    python -m venv .venv-py && .venv-py/bin/pip install llmlingua
    .venv-py/bin/python py/llmlingua_service.py

Serves POST http://127.0.0.1:8096/compress {"text": "...", "rate": 0.33}
-> {"text": compressed, "origin_tokens": n, "compressed_tokens": m, "ms": t}.
The benchmark's `llmlingua` framework compresses the shared-history working
set with it, then runs the same shared-history turns on the compressed text.
"""

import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import torch
from llmlingua import PromptCompressor

DEVICE = "mps" if torch.backends.mps.is_available() else "cpu"
compressor = PromptCompressor(
    model_name="microsoft/llmlingua-2-xlm-roberta-large-meetingbank",
    use_llmlingua2=True,
    device_map=DEVICE,
)
LOCK = __import__("threading").Lock()  # one compression at a time on this Mac


class Service(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))))
        started = time.time()
        try:
            # Records are one per line, so each line is a chunk; ids, numbers and JSON punctuation are kept.
            with LOCK:
                r = compressor.compress_prompt(
                    req["text"],
                    rate=float(req.get("rate", 0.33)),
                    force_tokens=["\n", ":", ",", "{", "}", '"', "-"],
                    chunk_end_tokens=["\n"],
                    drop_consecutive=True,
                )
            out = {"text": r["compressed_prompt"], "origin_tokens": r["origin_tokens"], "compressed_tokens": r["compressed_tokens"], "ms": int((time.time() - started) * 1000)}
        except Exception as e:
            out = {"error": f"{type(e).__name__}: {e}"[:300]}
        body = json.dumps(out).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    print(f"LLMLingua-2 service on :8096 ({DEVICE})", file=sys.stderr)
    ThreadingHTTPServer(("127.0.0.1", 8096), Service).serve_forever()
