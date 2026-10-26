"""Confirming the reference behind a proposal.

An addition is only worth reviewing if something public says it exists. So the
flow asks the contributor for the page that documents the entity, fetches it
once, and reports what it found: the title, whether the name they gave actually
appears there, and the text the drafter will read. The contributor sees that
verdict before the card is drafted — a 404 or a page about something else is
better caught in the conversation than in a pull request three weeks later.

The fetch is the one outward request this feature makes, and it goes exactly
where the contributor pointed it. Only globally routable addresses are allowed:
a chat box that will fetch any URL for you must not be a way to read the network
the server sits on. Since the published map reaches this server from the
internet, that is checked where it cannot be talked around — on the socket,
after the connection is made, for every hop of every redirect — rather than only
on the name the contributor typed.
"""
from __future__ import annotations

import datetime as _dt
import gzip
import html
import http.client
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
        if _refused(ip):
            raise ReferenceError(_inside(parts.hostname, ip))
    return parts.hostname


def _refused(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """Whether a reference may not be fetched from this address.

    An allow-list — globally routable or nothing — because the block-list it
    replaces (`is_private`, `is_loopback`, …) let 100.64.0.0/10 through, and
    that is where Tailscale numbers every machine on a tailnet. Exposed to the
    internet, the server would have read the curator's own tailnet, by name,
    for anyone who asked.
    """
    if ip.version == 6 and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return not ip.is_global or ip.is_multicast


def _inside(host: str, ip: Any) -> str:
    return (f"{host} resolves inside this network ({ip}); references have to be "
            "publicly reachable for a maintainer to check them too.")


def _checked_create_connection(address: Any, *args: Any, **kwargs: Any) -> socket.socket:
    """Connect, then refuse if the far end is not a public address.

    Checking the name before fetching is not enough on its own: the name can
    resolve differently a second time (DNS rebinding), and a public page can
    redirect to a private one. Checking the socket's peer covers both, and it
    happens before TLS, so nothing is sent to an address that was refused.
    """
    sock = socket.create_connection(address, *args, **kwargs)
    if not ALLOW_PRIVATE:
        peer = ipaddress.ip_address(sock.getpeername()[0])
        if _refused(peer):
            sock.close()
            raise ReferenceError(_inside(str(address[0]), peer))
    return sock


class _CheckedHTTPConnection(http.client.HTTPConnection):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._create_connection = _checked_create_connection


class _CheckedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._create_connection = _checked_create_connection


class _CheckedHTTPHandler(urllib.request.HTTPHandler):
    def http_open(self, req: urllib.request.Request) -> Any:
        return self.do_open(_CheckedHTTPConnection, req)


class _CheckedHTTPSHandler(urllib.request.HTTPSHandler):
    def https_open(self, req: urllib.request.Request) -> Any:
        return self.do_open(_CheckedHTTPSConnection, req, context=self._context)


class _CheckedRedirects(urllib.request.HTTPRedirectHandler):
    """Follow a redirect only to the web, and say so early when it points inward.

    urllib follows a redirect to ftp:// as readily as to https://, and an FTP
    connection would not go through the checked socket above.
    """

    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any,
                         newurl: str) -> Any:
        _check_host(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _opener() -> urllib.request.OpenerDirector:
    # No proxy from the environment: behind one, the socket's peer would be the
    # proxy, and the check above would be checking the wrong machine. An empty
    # ProxyHandler registers nothing, and stops build_opener adding the one
    # that reads http_proxy.
    return urllib.request.build_opener(
        urllib.request.ProxyHandler({}), _CheckedHTTPHandler, _CheckedHTTPSHandler,
        _CheckedRedirects)


_OPENER = _opener()


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
        with _OPENER.open(req, timeout=TIMEOUT) as r:
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
