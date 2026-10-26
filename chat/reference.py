"""Confirming the reference behind a proposal.

An addition is only worth reviewing if something public says it exists. So the
flow asks the contributor for the page that documents the entity, fetches it
once, and reports what it found: the title, whether the name they gave actually
appears there, and the text the drafter will read. The contributor sees that
verdict before the card is drafted — a 404 or a page about something else is
better caught in the conversation than in a pull request three weeks later.

The fetch is the one outward request this feature makes, and it goes exactly
where the contributor pointed it. Hosts that resolve inside the machine or the
local network are refused: a chat box that will fetch any URL for you must not
be a way to read the network the server sits on.
"""
from __future__ import annotations

import datetime as _dt
import gzip
import html
import ipaddress
import os
import re
import socket
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from hai_data import fold

MAX_BYTES = 1_500_000
# What the drafter reads. Beyond a few thousand words a page is navigation and
# footers, and the local model's context is better spent on the conversation.
MAX_TEXT = 8_000
TIMEOUT = 15
ALLOW_PRIVATE = os.environ.get("HAI_CHAT_ALLOW_PRIVATE") == "1"

UA = "eu-hai-map-chat/1.0 (+https://github.com/marota/human-ai-collaboration)"

_SCRIPT_RE = re.compile(r"<(script|style|noscript|svg|template)\b.*?</\1>", re.S | re.I)
_TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.S | re.I)
_META_DESC_RE = re.compile(
    r"""<meta[^>]+(?:name|property)\s*=\s*["'](?:description|og:description)["'][^>]*>""",
    re.I)
_CONTENT_RE = re.compile(r"""content\s*=\s*["'](.*?)["']""", re.S | re.I)
_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"[ \t\r\f\v]+")
_BLANK_RE = re.compile(r"\n{3,}")
_BLOCK_RE = re.compile(r"</(p|div|section|article|h[1-6]|li|tr|br)\s*>|<br\s*/?>", re.I)


class ReferenceError(RuntimeError):
    pass


def _check_host(url: str) -> str:
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in ("http", "https"):
        raise ReferenceError("Only http:// and https:// references can be checked.")
    if not parts.hostname:
        raise ReferenceError("That URL has no host.")
    if ALLOW_PRIVATE:
        return parts.hostname
    try:
        infos = socket.getaddrinfo(parts.hostname, None)
    except OSError:
        raise ReferenceError(f"The host {parts.hostname} does not resolve.") from None
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved
                or ip.is_multicast or ip.is_unspecified):
            raise ReferenceError(
                f"{parts.hostname} resolves inside this network ({ip}); references have "
                "to be publicly reachable for a maintainer to check them too.")
    return parts.hostname


def _text_of(body: str) -> tuple[str, str]:
    """(title, readable text) from an HTML document."""
    title = ""
    m = _TITLE_RE.search(body)
    if m:
        title = html.unescape(_TAG_RE.sub("", m.group(1))).strip()

    lead = ""
    m = _META_DESC_RE.search(body)
    if m:
        c = _CONTENT_RE.search(m.group(0))
        if c:
            lead = html.unescape(c.group(1)).strip()

    stripped = _SCRIPT_RE.sub(" ", body)
    stripped = _BLOCK_RE.sub("\n", stripped)
    text = html.unescape(_TAG_RE.sub(" ", stripped))
    text = _WS_RE.sub(" ", text)
    text = "\n".join(line.strip() for line in text.splitlines())
    text = _BLANK_RE.sub("\n\n", text).strip()
    if lead and fold(lead)[:60] not in fold(text):
        text = lead + "\n\n" + text
    return title, text


def _confirms(name: str, haystack: str) -> bool:
    """Whether the page is plausibly about the entity the contributor named.

    Loose on purpose: an acronym, a shortened name or a French page title should
    all count. It answers "is this the right page?", not "does this prove it".
    """
    want = [t for t in re.findall(r"[a-z0-9]+", fold(name)) if len(t) > 2]
    if not want:
        return False
    hay = fold(haystack)
    if fold(name) in hay:
        return True
    hits = sum(1 for t in want if t in hay)
    return hits >= max(1, round(len(want) * 0.6))


def fetch(url: str, name: str = "") -> dict[str, Any]:
    """Fetch a reference and report what it says.

    Never raises for a bad page — a reference that does not resolve is an answer
    the contributor needs, not a crash. Only a refused host raises, because that
    one is a request the server declines to make.
    """
    url = url.strip()
    _check_host(url)
    out: dict[str, Any] = {"url": url, "fetched_at": _dt.datetime.now().isoformat(timespec="seconds"),
                           "ok": False, "confirms": False, "title": "", "text": "",
                           "status": None, "final_url": url}
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
        "Accept-Encoding": "gzip",
        "Accept-Language": "en,fr;q=0.8",
    })
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            out["status"] = r.status
            out["final_url"] = r.geturl()
            ctype = (r.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            raw = r.read(MAX_BYTES + 1)
            if r.headers.get("Content-Encoding") == "gzip":
                try:
                    raw = gzip.decompress(raw)
                except (OSError, EOFError):
                    pass
            charset = r.headers.get_content_charset() or "utf-8"
    except urllib.error.HTTPError as e:
        out["status"] = e.code
        out["error"] = f"The page answered {e.code}."
        return out
    except (urllib.error.URLError, OSError, ValueError) as e:
        out["error"] = f"The page could not be fetched ({getattr(e, 'reason', e)})."
        return out

    if len(raw) > MAX_BYTES:
        out["error"] = "That page is too large to read."
        return out
    if ctype and not (ctype.startswith("text/") or ctype in
                      ("application/xhtml+xml", "application/xml")):
        out["error"] = f"That link is a {ctype} file, not a page to read."
        return out

    body = raw.decode(charset, "replace")
    title, text = _text_of(body) if "html" in (ctype or "html") else ("", body)
    out["ok"] = True
    out["title"] = title[:300]
    out["text"] = text[:MAX_TEXT]
    out["truncated"] = len(text) > MAX_TEXT
    out["confirms"] = _confirms(name, f"{title}\n{text}") if name else bool(text)
    return out


def summary(ref: dict[str, Any], name: str, lang: str) -> str:
    """One line the contributor reads before anything is drafted."""
    fr = lang == "fr"
    if not ref.get("ok"):
        return (f"La référence n'a pas pu être lue : {ref.get('error', 'erreur inconnue')}"
                if fr else
                f"The reference could not be read: {ref.get('error', 'unknown error')}")
    title = ref.get("title") or ref.get("final_url")
    if ref.get("confirms"):
        return (f"Référence lue — « {title} ». Elle mentionne bien {name}."
                if fr else
                f"Reference read — “{title}”. It does mention {name}.")
    return (f"Référence lue — « {title} » — mais le nom « {name} » n'y apparaît pas. "
            "Vérifiez le lien, ou gardez-le et ajustez le nom."
            if fr else
            f"Reference read — “{title}” — but the name “{name}” does not appear on it. "
            "Check the link, or keep it and adjust the name.")
