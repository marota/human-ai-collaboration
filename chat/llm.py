"""The local model, reached over Ollama's HTTP API with the standard library.

Two models, because the two jobs are different. The conversation wants to come
back fast and is forgiving of a smaller model: it answers from a retrieval
bundle that already contains the facts. Drafting a card is the opposite — one
call, structured output, every field read by a human afterwards — so it is
worth a bigger model and a slower wait. Both default to tags already pulled on
this machine and both are overridable by environment variable.

Nothing here leaves the machine: Ollama listens on localhost and no other host
is ever contacted.
"""
from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from typing import Any, Iterator

URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
CHAT_MODEL = os.environ.get("HAI_CHAT_MODEL", "gemma4-a4b-qat-32k:latest")
DRAFT_MODEL = os.environ.get("HAI_DRAFT_MODEL", "qwen3.8:27b")

# The catalogue alone is some 7 000 tokens, and it is in every request so the
# model can never invent an id. Ollama's own default of 2 048 would truncate it
# silently, which looks like a model that cannot read.
NUM_CTX = int(os.environ.get("HAI_CHAT_NUM_CTX", "32768"))
# Keep both resident between turns: on 64 GB there is room, and the first token
# after a cold load costs more than the whole answer.
KEEP_ALIVE = os.environ.get("HAI_CHAT_KEEP_ALIVE", "30m")
# A ceiling on the answer, in tokens. Not an optimisation: a local model handed
# a 450-entity catalogue and an open question will cheerfully enumerate it for
# ten minutes, and a chat that never stops talking is a chat nobody waits for.
# Two or three paragraphs fit in 600; a card draft needs room for a description
# in two languages.
NUM_PREDICT = int(os.environ.get("HAI_CHAT_NUM_PREDICT", "600"))
DRAFT_PREDICT = int(os.environ.get("HAI_DRAFT_NUM_PREDICT", "3200"))

_THINK_RE = re.compile(r"<think>.*?</think>\s*", re.S | re.I)

# Most of the tags on this machine are reasoning models, and Ollama returns
# their reasoning in a `thinking` field of its own rather than in `content`. Left
# on, a one-line question is answered with several thousand tokens of notes the
# reader never sees — which is what a chat that "hangs" actually is — and the
# visible answer can be cut off by the token ceiling before it starts. So
# thinking is off by default. A tag that does not support the switch rejects it,
# and the call is retried without it.
THINK = os.environ.get("HAI_CHAT_THINK") == "1"


class OllamaError(RuntimeError):
    pass


def _post(path: str, body: dict[str, Any], timeout: float):
    """POST to Ollama, dropping `think` if this tag has no such setting."""
    try:
        return _post_once(path, body, timeout)
    except OllamaError as e:
        if "think" in str(e).lower() and "think" in body:
            body = {k: v for k, v in body.items() if k != "think"}
            return _post_once(path, body, timeout)
        raise


def _post_once(path: str, body: dict[str, Any], timeout: float):
    req = urllib.request.Request(
        f"{URL}{path}",
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        return urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as e:  # Ollama puts a readable reason in the body
        detail = e.read().decode("utf-8", "replace")[:400]
        raise OllamaError(f"Ollama answered {e.code}: {detail}") from None
    except OSError as e:
        raise OllamaError(f"Ollama is not reachable at {URL} ({e})") from None


def health() -> dict[str, Any]:
    """Whether Ollama is up and the two configured tags are pulled."""
    out: dict[str, Any] = {"url": URL, "chat_model": CHAT_MODEL,
                           "draft_model": DRAFT_MODEL, "reachable": False,
                           "models": [], "missing": []}
    try:
        with urllib.request.urlopen(f"{URL}/api/tags", timeout=4) as r:
            tags = json.load(r)
    except Exception as e:  # noqa: BLE001 — any failure means "not available"
        out["error"] = str(e)
        return out
    names = sorted(m.get("name", "") for m in tags.get("models", []))
    out["reachable"] = True
    out["models"] = names

    def present(want: str) -> bool:
        return any(n == want or n.startswith(want.split(":")[0] + ":") for n in names)

    out["missing"] = [m for m in (CHAT_MODEL, DRAFT_MODEL) if not present(m)]
    out["ok"] = not out["missing"]
    return out


def stream_chat(messages: list[dict[str, str]], *, model: str | None = None,
                temperature: float = 0.2, timeout: float = 180) -> Iterator[str]:
    """Yield the reply as it is generated.

    Ollama streams NDJSON, one object per token-ish chunk. A thinking model also
    streams a `thinking` field; it is dropped — the reader asked a question, not
    for the model's notes.
    """
    body = {
        "model": model or CHAT_MODEL,
        "messages": messages,
        "stream": True,
        "keep_alive": KEEP_ALIVE,
        "think": THINK,
        "options": {"temperature": temperature, "num_ctx": NUM_CTX,
                    "num_predict": NUM_PREDICT},
    }
    with _post("/api/chat", body, timeout) as r:
        for raw in r:
            line = raw.decode("utf-8", "replace").strip()
            if not line:
                continue
            try:
                chunk = json.loads(line)
            except json.JSONDecodeError:
                continue
            if chunk.get("error"):
                raise OllamaError(str(chunk["error"]))
            piece = (chunk.get("message") or {}).get("content") or ""
            if piece:
                yield piece
            if chunk.get("done"):
                return


def complete(messages: list[dict[str, str]], *, model: str | None = None,
             schema: dict[str, Any] | None = None, temperature: float = 0.1,
             timeout: float = 600) -> str:
    """One non-streaming answer, optionally constrained to a JSON schema.

    Constrained decoding is why the drafting step is reliable at all: the model
    cannot answer with prose, a code fence or a field that does not exist, so
    there is no parser to outwit and no retry loop.
    """
    body: dict[str, Any] = {
        "model": model or DRAFT_MODEL,
        "messages": messages,
        "stream": False,
        "keep_alive": KEEP_ALIVE,
        "think": THINK,
        "options": {"temperature": temperature, "num_ctx": NUM_CTX,
                    "num_predict": DRAFT_PREDICT},
    }
    if schema is not None:
        body["format"] = schema
    with _post("/api/chat", body, timeout) as r:
        payload = json.load(r)
    if payload.get("error"):
        raise OllamaError(str(payload["error"]))
    text = (payload.get("message") or {}).get("content") or ""
    return _THINK_RE.sub("", text).strip()


def complete_json(messages: list[dict[str, str]], *, schema: dict[str, Any],
                  model: str | None = None, timeout: float = 600) -> dict[str, Any]:
    """`complete` with the answer parsed.

    A constrained model still occasionally wraps the object in a fence, so the
    outermost braces are taken when a direct parse fails.
    """
    text = complete(messages, model=model, schema=schema, timeout=timeout)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        if start >= 0 and end > start:
            try:
                return json.loads(text[start:end + 1])
            except json.JSONDecodeError:
                pass
    # Constrained decoding cannot emit invalid JSON, so a parse failure means
    # the answer was cut off by the token ceiling. Say so: the fix is
    # HAI_DRAFT_NUM_PREDICT, not a different model.
    raise OllamaError(
        f"the draft was cut off after {len(text)} characters — raise "
        f"HAI_DRAFT_NUM_PREDICT (now {DRAFT_PREDICT}) or ask for a shorter "
        f"description. Partial answer: {text[:160]}…")


def warm(model: str) -> None:
    """Load a model without asking it anything, so the first turn is not slow."""
    try:
        _post("/api/chat", {"model": model, "messages": [], "keep_alive": KEEP_ALIVE},
              timeout=600).close()
    except OllamaError:
        pass
