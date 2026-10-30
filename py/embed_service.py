"""A local OpenAI-compatible embeddings endpoint for Letta's archival memory.

Nightshift serves chat models but no /v1/embeddings, and Letta (MemGPT) needs
embeddings to store and search archival memory. This serves BAAI/bge-small-en-v1.5
(384 dimensions, ~130 MB) with Hugging Face transformers, on 127.0.0.1:8094.
Embeddings are retrieval plumbing, not model context, so they are not counted
as input tokens for any framework.

    .venv-py/bin/python py/embed_service.py
"""

import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import torch
from transformers import AutoModel, AutoTokenizer

NAME = "BAAI/bge-small-en-v1.5"
tok = AutoTokenizer.from_pretrained(NAME)
model = AutoModel.from_pretrained(NAME).eval()


def embed(texts: list[str]) -> list[list[float]]:
    with torch.no_grad():
        batch = tok(texts, padding=True, truncation=True, max_length=512, return_tensors="pt")
        cls = model(**batch).last_hidden_state[:, 0]  # bge uses the CLS vector
        return torch.nn.functional.normalize(cls, p=2, dim=1).tolist()


class Service(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))))
        inp = req.get("input", [])
        texts = [inp] if isinstance(inp, str) else [str(x) for x in inp]
        vecs = embed(texts) if texts else []
        n = sum(len(tok(t)["input_ids"]) for t in texts)
        body = json.dumps({
            "object": "list", "model": NAME,
            "data": [{"object": "embedding", "index": i, "embedding": v} for i, v in enumerate(vecs)],
            "usage": {"prompt_tokens": n, "total_tokens": n},
        }).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    print(f"embeddings ({NAME}) on 127.0.0.1:8094", file=sys.stderr)
    ThreadingHTTPServer(("127.0.0.1", 8094), Service).serve_forever()
