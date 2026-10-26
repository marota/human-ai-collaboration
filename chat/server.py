#!/usr/bin/env python3
"""The map's local chat server.

One process, the standard library, and a model already running on this machine.
It does three things:

1. **Serves the repository**, so the map and the chat live at the same origin
   and `python3 chat/server.py` is the whole setup. Point a browser at
   http://127.0.0.1:8765/assets/map/eu-hai-map.html?chat=1 and the chat column
   appears beside the map.
2. **Answers questions about the map**, grounded in `assets/map/hai-data.js` —
   the same payload the page draws — and in nothing else.
3. **Takes a proposal**: an addition or a correction, with a reference it
   checks, a draft card the contributor edits on the spot, and a GitHub issue
   at the end for a maintainer to review.

It binds to the loopback interface. It can open issues on the repository as
whoever `gh` is logged in as, so it is not something to expose to a network.

    python3 chat/server.py [--port 8765] [--host 127.0.0.1]

Environment: OLLAMA_URL, HAI_CHAT_MODEL, HAI_DRAFT_MODEL, HAI_CHAT_NUM_CTX,
HAI_CHAT_REPO, HAI_CHAT_DATA_REPO, HAI_CHAT_LABELS, HAI_CHAT_DRY_RUN.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
import threading
import traceback
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

import cards  # noqa: E402
import hai_data  # noqa: E402
import issues  # noqa: E402
import llm  # noqa: E402
import prompts  # noqa: E402
import reference as refmod  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_JS = REPO_ROOT / "assets" / "map" / "hai-data.js"

MAX_BODY = 1_000_000
# Only loopback origins may call the API. The common case is same-origin (this
# server serves the page too); the exception is a Jekyll dev server on another
# port, which is still this machine.
_LOCAL_ORIGIN_RE = re.compile(r"^https?://(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?$")


class Corpus:
    """The payload, reloaded when the file on disk changes.

    Regenerating `hai-data.js` mid-session is exactly what happens while
    curating, and a chat still answering from the previous snapshot would be
    worse than a two-second reload.
    """

    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.Lock()
        self._mtime = 0.0
        self._corpus: hai_data.Corpus | None = None

    def get(self) -> hai_data.Corpus:
        with self._lock:
            mtime = self.path.stat().st_mtime
            if self._corpus is None or mtime != self._mtime:
                self._corpus = hai_data.load(self.path)
                self._mtime = mtime
            return self._corpus


CORPUS = Corpus(DATA_JS)


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "hai-map-chat"

    # -- plumbing -------------------------------------------------------

    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
        if self.path.startswith("/api/"):
            sys.stderr.write(f"  {self.command} {self.path} — {fmt % args}\n")

    def _cors(self) -> None:
        origin = self.headers.get("Origin")
        if origin and (_LOCAL_ORIGIN_RE.match(origin) or origin == "null"):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")

    def _json(self, payload: Any, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _fail(self, message: str, status: int = 400) -> None:
        self._json({"error": message}, status)

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            raise ValueError("request too large")
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ValueError("the request body is not JSON") from None
        if not isinstance(body, dict):
            raise ValueError("the request body must be an object")
        return body

    def _stream_start(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Connection", "close")
        self._cors()
        self.end_headers()
        self.close_connection = True

    def _event(self, **payload: Any) -> None:
        self.wfile.write((json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8"))
        self.wfile.flush()

    def end_headers(self) -> None:
        # The page is a reading surface that happens to be served from here;
        # nothing it loads should be cached while it is being worked on.
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    # -- routes ---------------------------------------------------------

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(HTTPStatus.NO_CONTENT)
        self._cors()
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        if self.path.startswith("/api/"):
            route = self.path.split("?")[0]
            if route == "/api/health":
                return self._health()
            if route == "/api/spec":
                return self._spec()
            return self._fail("no such endpoint", 404)
        return super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        route = self.path.split("?")[0]
        try:
            body = self._read_json()
        except ValueError as e:
            return self._fail(str(e))
        try:
            if route == "/api/chat":
                return self._chat(body)
            if route == "/api/reference":
                return self._reference(body)
            if route == "/api/draft":
                return self._draft(body)
            if route == "/api/validate":
                return self._validate(body)
            if route == "/api/issue":
                return self._issue(body)
        except (refmod.ReferenceError, issues.IssueError, llm.OllamaError) as e:
            return self._fail(str(e), 502)
        except Exception:  # noqa: BLE001 — a local tool should say what broke
            traceback.print_exc()
            return self._fail("the chat server hit an unexpected error; see its log", 500)
        return self._fail("no such endpoint", 404)

    # -- handlers -------------------------------------------------------

    def _health(self) -> None:
        corpus = CORPUS.get()
        self._json({
            "ok": True,
            "data": {"as_of": corpus.as_of, "counts": corpus.counts(),
                     "source": str(DATA_JS.relative_to(REPO_ROOT))},
            "model": llm.health(),
            "github": issues.health(),
            "layers": list(hai_data.LAYERS),
        })

    def _spec(self) -> None:
        query = dict(p.split("=", 1) for p in self.path.partition("?")[2].split("&") if "=" in p)
        layer = query.get("layer", "team")
        lang = "fr" if query.get("lang", "en").startswith("fr") else "en"
        if layer not in hai_data.LAYERS:
            return self._fail(f"unknown layer: {layer}")
        corpus = CORPUS.get()
        self._json({"layer": layer, "fields": cards.spec(layer, corpus, lang),
                    "labels": {"focus": corpus.taxo.get("focus") or {}}})

    def _chat(self, body: dict[str, Any]) -> None:
        history = [t for t in body.get("messages") or []
                   if isinstance(t, dict) and t.get("role") in ("user", "assistant")
                   and isinstance(t.get("content"), str)]
        if not history:
            return self._fail("no messages")
        lang = "fr" if str(body.get("lang", "en")).startswith("fr") else "en"
        corpus = CORPUS.get()
        last = history[-1]["content"]

        # Retrieval reads the last turn plus the one before it, so a follow-up
        # ("and in Germany?") still carries its subject.
        query = " ".join(t["content"] for t in history[-2:] if t["role"] == "user")
        retrieved, entities = hai_data.retrieved_block(corpus, query, lang)
        figures = hai_data.figures(corpus, query)

        self._stream_start()
        self._event(t="retrieved", ids=[e["id"] for e in entities])

        # The control line, when the model emits one, is the first thing it
        # writes. The opening is held back until that is settled, so the token
        # is never shown to the reader and never split across two events.
        text = ""
        proposed = False
        head_done = False

        def flush_head() -> None:
            """Release the held-back opening, control line removed."""
            nonlocal text, proposed, head_done
            head_done = True
            m = prompts.PROPOSE_RE.match(text)
            if m:
                proposed = True
                text = text[m.end():]
                self._event(t="propose", mode=m.group(1).lower(), target=m.group(2),
                            name=prompts.guess_name(last))
            if text:
                self._event(t="delta", text=text)

        try:
            for piece in llm.stream_chat(
                    prompts.answer_messages(corpus, history, lang, retrieved,
                                            figures)):
                if not head_done:
                    text += piece
                    if "\n" not in text and len(text) < 48:
                        continue
                    flush_head()
                    continue
                text += piece
                self._event(t="delta", text=piece)
            if not head_done:
                # A reply short enough to fit entirely in the held-back opening
                # still has to be said.
                flush_head()
        except llm.OllamaError as e:
            self._event(t="error", message=str(e))
            return

        # The backstop: a small model that forgot the control line still gets
        # the panel opened, from the reader's own words.
        if not proposed:
            sniff = prompts.sniff_intent(last)
            if sniff:
                mode = sniff[0]
                if mode == "fix":
                    target = next((e["id"] for e in entities
                                   if hai_data.fold(e["name"]) in hai_data.fold(last)
                                   or e["id"] in last), "")
                    if target:
                        self._event(t="propose", mode="fix", target=target, guessed=True)
                else:
                    self._event(t="propose", mode="add",
                                target=prompts.guess_layer(last),
                                name=prompts.guess_name(last), guessed=True)
        self._event(t="done")

    def _reference(self, body: dict[str, Any]) -> None:
        url = str(body.get("url") or "").strip()
        if not url:
            return self._fail("no url")
        name = str(body.get("name") or "")
        lang = "fr" if str(body.get("lang", "en")).startswith("fr") else "en"
        ref = refmod.fetch(url, name)
        self._json({"reference": {k: v for k, v in ref.items() if k != "text"},
                    "summary": refmod.summary(ref, name or url, lang),
                    "chars": len(ref.get("text") or "")})

    def _draft(self, body: dict[str, Any]) -> None:
        corpus = CORPUS.get()
        mode = "fix" if body.get("mode") == "fix" else "add"
        lang = "fr" if str(body.get("lang", "en")).startswith("fr") else "en"
        history = [t for t in body.get("messages") or [] if isinstance(t, dict)]
        transcript = prompts.transcript_of(history)

        target = str(body.get("target") or "")
        entity = corpus.by_id.get(target)
        if mode == "fix" and not entity:
            return self._fail(f"no card with id {target!r} is on the map")
        layer = entity["kind"] if entity else (
            target if target in hai_data.LAYERS else prompts.guess_layer(transcript))

        ref = None
        if body.get("reference_url"):
            ref = refmod.fetch(str(body["reference_url"]),
                               str(body.get("name") or (entity or {}).get("name") or ""))

        current = cards.current_values(layer, entity) if entity else None
        drafted = cards.tidy(llm.complete_json(
            prompts.draft_messages(layer, lang, mode, transcript, ref, current),
            schema=prompts.schema_for(layer, corpus, mode)))

        if mode == "fix":
            # A correction is the card as it stands with the proposed changes
            # laid over it, so the form shows a whole card and the diff stays
            # honest about what moved.
            card = dict(current or {})
            for key, value in drafted.items():
                if isinstance(value, dict) and isinstance(card.get(key), dict):
                    card[key] = {**card[key], **{k: v for k, v in value.items()
                                                 if v not in (None, "", [])}}
                elif value not in (None, "", []):
                    card[key] = value
            card["id"] = entity["id"]
            card["name"] = entity["name"] if not drafted.get("name") else card["name"]
            cards.set_path(card, "provenance.last_updated", dt.date.today().isoformat())
        else:
            card = cards.fill_defaults(layer, drafted, corpus, ref)

        report = cards.validate(layer, card, corpus, mode, lang)
        self._json({
            "mode": mode, "layer": layer, "target": entity["id"] if entity else None,
            "card": card,
            "current": current,
            "changed": cards.diff(current, card, layer) if current else [],
            "fields": cards.spec(layer, corpus, lang),
            "report": report.as_json(),
            "yaml": cards.to_yaml(card, layer),
            "reference": {k: v for k, v in (ref or {}).items() if k != "text"} if ref else None,
        })

    def _validate(self, body: dict[str, Any]) -> None:
        corpus = CORPUS.get()
        layer = str(body.get("layer") or "team")
        if layer not in hai_data.LAYERS:
            return self._fail(f"unknown layer: {layer}")
        mode = "fix" if body.get("mode") == "fix" else "add"
        lang = "fr" if str(body.get("lang", "en")).startswith("fr") else "en"
        card = body.get("card") or {}
        entity = corpus.by_id.get(str(body.get("target") or ""))
        current = cards.current_values(layer, entity) if entity else None
        report = cards.validate(layer, card, corpus, mode, lang)
        self._json({"report": report.as_json(),
                    "yaml": cards.to_yaml(card, layer),
                    "changed": cards.diff(current, card, layer) if current else []})

    def _issue(self, body: dict[str, Any]) -> None:
        corpus = CORPUS.get()
        layer = str(body.get("layer") or "team")
        if layer not in hai_data.LAYERS:
            return self._fail(f"unknown layer: {layer}")
        mode = "fix" if body.get("mode") == "fix" else "add"
        lang = "fr" if str(body.get("lang", "en")).startswith("fr") else "en"
        card = body.get("card") or {}
        if not card.get("name"):
            return self._fail("the proposal has no name")
        entity = corpus.by_id.get(str(body.get("target") or ""))
        current = cards.current_values(layer, entity) if entity else None
        changed = cards.diff(current, card, layer) if current else []
        report = cards.validate(layer, card, corpus, mode, lang).as_json()

        title = str(body.get("title") or "").strip() or \
            issues.title_for(mode, layer, card, changed)
        text = issues.body_for(
            mode, layer, card,
            reference=body.get("reference") or None,
            report=report,
            changed=changed,
            transcript=str(body.get("transcript") or ""),
            lang=lang, as_of=corpus.as_of)

        if body.get("preview"):
            return self._json({"preview": True, "title": title, "body": text,
                               "repo": issues.REPO, "report": report})
        if not report["ok"] and not body.get("force"):
            return self._fail("the proposal does not pass its checks yet", 422)
        result = issues.create(title, text)
        result["report"] = report
        self._json(result)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=int(os.environ.get("HAI_CHAT_PORT", "8765")))
    ap.add_argument("--host", default=os.environ.get("HAI_CHAT_HOST", "127.0.0.1"))
    ap.add_argument("--warm", action="store_true",
                    help="load both models before serving, so the first turn is not slow")
    args = ap.parse_args()

    corpus = CORPUS.get()
    counts = corpus.counts()
    model = llm.health()
    gh = issues.health()

    print(f"Map chat — {counts['team']} teams, {counts['project']} projects, "
          f"{counts['commons']} commons, {counts['framework']} frameworks "
          f"(snapshot {corpus.as_of})")
    if model.get("reachable"):
        state = "ready" if not model["missing"] else f"missing {', '.join(model['missing'])}"
        print(f"  model    {llm.CHAT_MODEL} / {llm.DRAFT_MODEL} — {state}")
    else:
        print(f"  model    unreachable at {llm.URL} — {model.get('error', '')}")
    print(f"  issues   {gh['repo']}"
          + (f" as {gh['account']}" if gh.get("account") else f" — {gh.get('error', '')}"))
    print(f"  open     http://{args.host}:{args.port}/assets/map/eu-hai-map.html?chat=1")

    if args.warm:
        for tag in {llm.CHAT_MODEL, llm.DRAFT_MODEL}:
            print(f"  warming  {tag}")
            llm.warm(tag)

    handler = partial(Handler, directory=str(REPO_ROOT))
    httpd = ThreadingHTTPServer((args.host, args.port), handler)
    httpd.daemon_threads = True
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
