"""Shared plumbing for the Python-side tests.

`scripts/build-map-data.py` carries a hyphen, so it cannot be imported by name;
it is loaded from its path instead. The tests exercise the committed generator
itself, not a copy, so a change to it cannot pass by being untested.
"""
from __future__ import annotations

import importlib.util
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
GENERATOR = REPO / "scripts" / "build-map-data.py"
DATA_JS = REPO / "assets" / "map" / "hai-data.js"
MAP_HTML = REPO / "assets" / "map" / "eu-hai-map.html"
SPEC = REPO / "docs" / "map-interface-spec.md"


def load_generator():
    """Import scripts/build-map-data.py as a module."""
    spec = importlib.util.spec_from_file_location("build_map_data", GENERATOR)
    mod = importlib.util.module_from_spec(spec)
    sys.modules.setdefault("build_map_data", mod)
    spec.loader.exec_module(mod)
    return mod


CHAT = REPO / "chat"


def load_chat():
    """Import the chat server's modules.

    They import each other by bare name, the way `chat/server.py` arranges by
    putting its own directory on the path. The tests do the same rather than
    making the layout more elaborate than one local process needs.
    """
    import types

    if str(CHAT) not in sys.path:
        sys.path.insert(0, str(CHAT))
    import cards
    import hai_data
    import issues
    import llm
    import prompts
    import reference

    return types.SimpleNamespace(cards=cards, hai_data=hai_data, issues=issues,
                                 llm=llm, prompts=prompts, reference=reference)


def load_payload() -> dict:
    """Parse the committed hai-data.js into Python objects.

    The file is generated JavaScript, not JSON, but every value in it is a JSON
    literal by construction (`js_array` emits `json.dumps` output), so the five
    `const NAME = [...]` arrays and the two objects can be read back exactly.
    Parsing rather than executing keeps these tests free of a JS runtime.
    """
    src = DATA_JS.read_text(encoding="utf-8")
    out = {}
    for name in ("PROJECTS", "COMMONS", "TEAMS", "FRAMEWORKS", "EDGES"):
        out[name] = json.loads(_strip_trailing_commas(_const_value(src, name, "[", "]")))
    out["TAXO"] = json.loads(_strip_trailing_commas(_const_value(src, "TAXO", "{", "}")))
    out["AS_OF"] = json.loads(_const_value(src, "AS_OF", '"', '"', inclusive=True))
    return out


def _strip_trailing_commas(text: str) -> str:
    """The generator emits one entry per line with a trailing comma before the
    closing bracket — valid JavaScript, invalid JSON. Drop those commas without
    touching commas inside strings."""
    out, in_str, esc = [], False, False
    for i, c in enumerate(text):
        if in_str:
            out.append(c)
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
            continue
        if c == '"':
            in_str = True
            out.append(c)
            continue
        if c == ",":
            j = i + 1
            while j < len(text) and text[j] in " \t\r\n":
                j += 1
            if j < len(text) and text[j] in "]}":
                continue          # trailing comma — drop it
        out.append(c)
    return "".join(out)


def _const_value(src: str, name: str, open_c: str, close_c: str, inclusive: bool = False) -> str:
    """Slice `const <name> = <literal>;` out of the generated file by balancing
    brackets, so a bracket inside a description string cannot end the slice early."""
    m = re.search(rf"^const {name} = ", src, re.M)
    if not m:
        raise AssertionError(f"{name} not found in {DATA_JS.name}")
    i = m.end()
    if inclusive:  # a bare string literal
        end = src.index(";", i)
        return src[i:end]
    depth, j, in_str, esc = 0, i, False, False
    while j < len(src):
        c = src[j]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
        elif c == '"':
            in_str = True
        elif c == open_c:
            depth += 1
        elif c == close_c:
            depth -= 1
            if depth == 0:
                return src[i:j + 1]
        j += 1
    raise AssertionError(f"unbalanced {open_c}{close_c} reading {name}")


def map_script() -> str:
    """The map's inline <script> body — the implementation under test for the
    static checks (i18n parity, esc() discipline, no network calls)."""
    html = MAP_HTML.read_text(encoding="utf-8")
    blocks = re.findall(r"<script>(.*?)</script>", html, re.S)
    return max(blocks, key=len)
