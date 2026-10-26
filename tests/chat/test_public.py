"""The published chat: what a visitor can reach on the curator's machine, and what not.

Spec §18.6. Since the map was published with its chat, chat/server.py answers
requests from the internet, through a tunnel that connects from loopback. These
tests hold the line that makes that safe, at the three places it is drawn:

- the server tells a visitor from the curator, fails closed when it cannot,
  and serves a visitor the API and nothing else — never a file;
- a reference is fetched only from a globally routable address, checked on the
  socket so that neither a redirect nor a second DNS answer can talk it inward;
- an issue a visitor opened says so, and their words in it cannot ping anyone.

None of it needs the network, the model or `gh`: the server is started on an
ephemeral port in this process, and the socket checks run against a listener
on loopback, which is exactly the address they exist to refuse.
"""
from __future__ import annotations

import email.message
import http.client
import ipaddress
import socket
import threading
import unittest
from functools import partial
from http.server import ThreadingHTTPServer

CHAT = None
SERVER = None


def setUpModule() -> None:
    global CHAT, SERVER
    from tests._harness import load_chat
    CHAT = load_chat()
    import server
    SERVER = server


def handler(headers: dict[str, str] | None, client: str = "127.0.0.1"):
    """A request handler with these headers, without a socket behind it."""
    h = SERVER.Handler.__new__(SERVER.Handler)
    h.client_address = (client, 50000)
    if headers is not None:
        msg = email.message.Message()
        for k, v in headers.items():
            msg[k] = v
        h.headers = msg
    return h


class TellsAVisitorFromTheCurator(unittest.TestCase):
    def test_a_browser_on_this_machine_is_the_curator(self):
        self.assertFalse(handler({"Host": "127.0.0.1:8765"})._is_public())
        self.assertFalse(handler({"Host": "localhost:8765"})._is_public())

    def test_a_request_through_the_tunnel_is_a_visitor(self):
        self.assertTrue(handler({"Host": "mac.example.ts.net:8443",
                                 "X-Forwarded-For": "203.0.113.7"})._is_public())

    def test_a_proxy_header_is_enough_even_with_a_loopback_host(self):
        # A tunnel may rewrite Host to the address it connects to. The forwarding
        # header it adds still says where the request came from.
        for header in ("X-Forwarded-For", "X-Forwarded-Host", "Forwarded",
                       "Tailscale-Funnel-Request"):
            with self.subTest(header):
                self.assertTrue(handler({"Host": "127.0.0.1:8765", header: "x"})._is_public())

    def test_a_foreign_host_is_enough_without_any_proxy_header(self):
        self.assertTrue(handler({"Host": "evil.example"})._is_public())

    def test_no_headers_at_all_is_a_visitor(self):
        # Fails closed: a request the server cannot classify gets the visitor's
        # treatment, never the curator's.
        self.assertTrue(handler(None)._is_public())

    def test_a_visitor_is_counted_by_the_address_the_tunnel_wrote(self):
        # The last X-Forwarded-For entry is the tunnel's; anything before it the
        # visitor wrote, and rotating it must not buy a fresh allowance.
        self.assertEqual(handler({"X-Forwarded-For": "9.9.9.9, 203.0.113.7"})._visitor(),
                         "203.0.113.7")
        self.assertEqual(handler({}, client="127.0.0.1")._visitor(), "127.0.0.1")


class ServesAVisitorNoFile(unittest.TestCase):
    def test_the_curator_gets_the_map_and_only_the_map(self):
        local = handler({"Host": "127.0.0.1:8765"})
        self.assertTrue(local._static_ok("/assets/map/eu-hai-map.html"))
        self.assertTrue(local._static_ok("/assets/map/hai-data.js"))
        for path in ("/.git/config", "/Claude.pdf", "/chat/server.py", "/",
                     "/assets/map/", "/assets/map/../../.git/config",
                     "/assets/map/%2e%2e/%2e%2e/.git/config", "/assets/map/.DS_Store",
                     "/assets/mapx/eu-hai-map.html"):
            with self.subTest(path):
                self.assertFalse(local._static_ok(path))

    def test_a_visitor_gets_no_file_at_all(self):
        visitor = handler({"Host": "mac.example.ts.net", "X-Forwarded-For": "203.0.113.7"})
        self.assertFalse(visitor._static_ok("/assets/map/eu-hai-map.html"))


class CeilingsOnWhatVisitorsCanAsk(unittest.TestCase):
    def test_a_visitor_over_the_ceiling_is_told_how_long_to_wait(self):
        limits = SERVER.Limits()
        n, window = limits.PER_VISITOR["/api/chat"]
        for _ in range(n):
            self.assertEqual(limits.take("/api/chat", "a"), 0)
        wait = limits.take("/api/chat", "a")
        self.assertGreater(wait, 0)
        self.assertLessEqual(wait, window + 1)

    def test_one_visitor_does_not_spend_anothers_allowance(self):
        limits = SERVER.Limits()
        n, _ = limits.PER_VISITOR["/api/chat"]
        for _ in range(n + 3):
            limits.take("/api/chat", "a")
        self.assertEqual(limits.take("/api/chat", "b"), 0)

    def test_issues_are_bounded_across_every_visitor_too(self):
        limits = SERVER.Limits()
        per, _ = limits.PER_VISITOR["issue-opened"]
        across, _ = limits.ACROSS["issue-opened"]
        opened = 0
        for visitor in range(across * 2):
            for _ in range(per):
                if limits.take("issue-opened", f"v{visitor}") == 0:
                    opened += 1
        self.assertEqual(opened, across)

    def test_a_refused_request_is_not_counted(self):
        limits = SERVER.Limits()
        n, _ = limits.PER_VISITOR["/api/draft"]
        for _ in range(n):
            limits.take("/api/draft", "a")
        for _ in range(5):
            limits.take("/api/draft", "a")
        self.assertEqual(len(limits._hits[("a", "/api/draft")]), n)

    def test_a_full_gate_is_busy_rather_than_a_queue(self):
        gate = threading.BoundedSemaphore(1)
        with SERVER._slot(gate):
            with self.assertRaises(SERVER._Busy):
                with SERVER._slot(gate):
                    pass
        with SERVER._slot(gate):    # released again
            pass


class OverARealSocket(unittest.TestCase):
    """The same rules, through http.server's own request handling."""

    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(
            ("127.0.0.1", 0), partial(SERVER.Handler, directory=str(SERVER.REPO_ROOT)))
        cls.httpd.daemon_threads = True
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def ask(self, method, path, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.request(method, path, headers=headers or {})
        res = conn.getresponse()
        res.read()
        conn.close()
        return res

    def visitor(self, ip, **extra):
        return {"Host": "mac.example.ts.net:8443", "X-Forwarded-For": ip, **extra}

    def test_the_map_is_served_to_this_machine(self):
        self.assertEqual(self.ask("GET", "/assets/map/eu-hai-map.html").status, 200)

    def test_nothing_else_in_the_repository_is(self):
        for path in ("/.git/config", "/chat/server.py", "/README.md"):
            for method in ("GET", "HEAD"):
                with self.subTest(path=path, method=method):
                    self.assertEqual(self.ask(method, path).status, 404)

    def test_a_visitor_is_not_served_the_map_either(self):
        res = self.ask("GET", "/assets/map/eu-hai-map.html", self.visitor("198.51.100.20"))
        self.assertEqual(res.status, 404)

    def test_only_the_published_map_may_call_from_another_origin(self):
        def allowed(origin, headers):
            res = self.ask("OPTIONS", "/api/chat", {**headers, "Origin": origin})
            return res.getheader("Access-Control-Allow-Origin")

        through = self.visitor("198.51.100.21")
        self.assertEqual(allowed("https://marota.github.io", through), "https://marota.github.io")
        self.assertIsNone(allowed("https://evil.example", through))
        # A loopback origin arriving through the tunnel is not the curator.
        self.assertIsNone(allowed("http://127.0.0.1:8765", through))
        # And the curator's own pages are not answered for the published origin.
        self.assertIsNone(allowed("https://marota.github.io", {"Host": "127.0.0.1:8765"}))

    def test_over_the_ceiling_a_visitor_gets_429_and_the_connection_closes(self):
        n, _ = SERVER.LIMITS.PER_VISITOR["/api/spec"]
        headers = self.visitor("198.51.100.22")
        for _ in range(n):
            self.assertEqual(self.ask("GET", "/api/spec?layer=team", headers).status, 200)
        res = self.ask("GET", "/api/spec?layer=team", headers)
        self.assertEqual(res.status, 429)
        self.assertTrue(int(res.getheader("Retry-After")) > 0)
        self.assertEqual(res.getheader("Connection"), "close")
        # The curator is never limited.
        self.assertEqual(self.ask("GET", "/api/spec?layer=team").status, 200)


class FetchesAReferenceOnlyFromThePublicInternet(unittest.TestCase):
    def test_only_globally_routable_addresses_are_allowed(self):
        refused = ["100.64.0.1", "100.125.130.35",       # a Tailscale tailnet
                   "127.0.0.1", "::1", "::ffff:127.0.0.1",  # this machine
                   "10.1.2.3", "172.16.0.1", "192.168.1.1",  # a local network
                   "169.254.169.254",                         # cloud metadata
                   "0.0.0.0", "224.0.0.1", "192.0.2.10"]      # unspecified, multicast, docs
        for ip in refused:
            with self.subTest(ip):
                self.assertTrue(CHAT.reference._refused(ipaddress.ip_address(ip)))
        for ip in ("8.8.8.8", "93.184.215.14", "2606:4700::1111"):
            with self.subTest(ip):
                self.assertFalse(CHAT.reference._refused(ipaddress.ip_address(ip)))

    def test_a_tailnet_address_is_refused_by_name_as_well(self):
        # What the block-list this replaced let through: `is_private` is False
        # for 100.64.0.0/10.
        with self.assertRaises(CHAT.reference.ReferenceError):
            CHAT.reference._check_host("http://100.100.100.100/")

    def test_the_socket_is_checked_after_it_connects(self):
        # A name can resolve to one address when checked and another when
        # fetched. The connection's own peer is what is held to the rule.
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        try:
            with self.assertRaises(CHAT.reference.ReferenceError):
                CHAT.reference._checked_create_connection(listener.getsockname(), timeout=5)
        finally:
            listener.close()

    def test_a_redirect_inward_or_off_the_web_is_refused(self):
        redirects = CHAT.reference._CheckedRedirects()
        for target in ("http://127.0.0.1:8484/", "http://100.100.100.100/", "ftp://example.org/x"):
            with self.subTest(target):
                with self.assertRaises(CHAT.reference.ReferenceError):
                    redirects.redirect_request(None, None, 302, "Found", {}, target)

    def test_no_proxy_from_the_environment_stands_between(self):
        # Behind a proxy the socket's peer would be the proxy, and the check
        # would be checking the wrong machine. With one configured, a default
        # opener routes through it — the control — and ours does not.
        import os
        from unittest import mock
        urlreq = CHAT.reference.urllib.request
        proxied = lambda opener: any(isinstance(h, urlreq.ProxyHandler) for h in opener.handlers)
        with mock.patch.dict(os.environ, {"http_proxy": "http://proxy.example:3128",
                                          "https_proxy": "http://proxy.example:3128"}):
            self.assertTrue(proxied(urlreq.build_opener()))
            self.assertFalse(proxied(CHAT.reference._opener()))

    def test_every_connection_the_opener_makes_is_a_checked_one(self):
        handlers = {type(h) for h in CHAT.reference._OPENER.handlers}
        self.assertIn(CHAT.reference._CheckedHTTPHandler, handlers)
        self.assertIn(CHAT.reference._CheckedHTTPSHandler, handlers)
        self.assertNotIn(CHAT.reference.urllib.request.HTTPHandler, handlers)
        self.assertNotIn(CHAT.reference.urllib.request.HTTPSHandler, handlers)
        self.assertIs(CHAT.reference._CheckedHTTPConnection("example.org")._create_connection,
                      CHAT.reference._checked_create_connection)
        self.assertIsInstance(CHAT.reference._CheckedHTTPSConnection("example.org"),
                              http.client.HTTPSConnection)


def card():
    return {"id": "example-grid-lab", "name": "Example @someone Lab", "type": "research_lab",
            "location": {"country": "NL", "city": "Delft"}, "focus_areas": ["decision_support"],
            "description": "A lab."}


class AVisitorsIssueSaysSoAndPingsNobody(unittest.TestCase):
    def body(self, public, transcript="ask @marota about owner/repo#12"):
        return CHAT.issues.body_for(
            "fix", "team", card(), reference={"url": "https://example.org", "title": "Hi @bob",
                                             "confirms": True, "status": 200},
            report={"ok": True, "errors": [], "warnings": []},
            changed=[{"path": "name", "before": "Example Lab", "after": "Example @someone Lab"}],
            transcript=transcript, lang="en", as_of="2026-10-26", public=public)

    def test_a_mention_or_an_issue_reference_is_made_inert(self):
        self.assertEqual(CHAT.issues.defang("@marota owner/repo#12"),
                         "@​marota owner/repo#​12")
        self.assertEqual(CHAT.issues.defang("plain words, #tag, 3 @ 4"), "plain words, #tag, 3 @ 4")

    def test_the_issue_says_a_visitor_opened_it(self):
        body = self.body(public=True)
        self.assertIn("published map's chat, by a visitor who is not identified", body)
        self.assertIn("reviewed on screen by the visitor", body)

    def test_nothing_a_visitor_wrote_can_ping_outside_a_code_block(self):
        body = self.body(public=True)
        prose = body.split("```yaml")[0]
        self.assertNotRegex(prose, r"@[A-Za-z0-9]")
        self.assertIn("@​someone", prose)
        self.assertIn("@​bob", prose)

    def test_the_conversation_is_kept_whole_in_a_code_block(self):
        body = self.body(public=True, transcript="a ```` fence and @marota")
        conversation = body.split("<summary>The conversation this came from</summary>")[1]
        self.assertIn("`````text\na ```` fence and @marota\n`````", conversation)

    def test_the_curators_own_issue_is_unchanged(self):
        body = self.body(public=False)
        self.assertIn("proposed through the map's chat.", body)
        self.assertIn("ask @marota about owner/repo#12", body)
        self.assertNotIn("​", body)


if __name__ == "__main__":
    unittest.main()
