"""The map's own payload, read as the chat's only ground truth.

`assets/map/hai-data.js` is generated from the curated YAML of
eu-hai-collab-map and is what the page itself renders. Reading it here — rather
than keeping a second copy of the corpus, or reaching into the data repository —
means the chat can never answer from something the reader cannot see on the map.
When the payload is regenerated, the chat follows in the same commit.

The file is JS by extension only: each layer is a `const NAME = [` followed by
one JSON object per line, with a trailing comma the array closes on. `TAXO` and
`AS_OF` are strict JSON. So a JSON decoder plus a small tolerance for those
commas is the whole parser, and the only dependency is the standard library.
"""
from __future__ import annotations

import json
import math
import re
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

# The four layers the map draws, in the order the sidebar lists them.
LAYERS = ("project", "team", "commons", "framework")

# Layer -> the directory an entity of that layer lives in upstream. The chat
# quotes these paths in the issues it opens, so a maintainer knows which file a
# proposal becomes without looking it up.
LAYER_DIR = {
    "project": "data/projects",
    "team": "data/teams",
    "commons": "data/commons",
    "framework": "data/frameworks",
}

_ARRAYS = {"PROJECTS": "project", "TEAMS": "team", "COMMONS": "commons",
           "FRAMEWORKS": "framework"}

_DECODER = json.JSONDecoder()


def _decode_array(src: str, start: int) -> tuple[list[Any], int]:
    """Decode a `[` ... `]` array that may carry trailing commas.

    `raw_decode` refuses the generator's `{…},\\n]` ending, so the elements are
    taken one at a time and the separators skipped by hand.
    """
    i = src.index("[", start) + 1
    out: list[Any] = []
    while True:
        while src[i] in " \t\r\n,":
            i += 1
        if src[i] == "]":
            return out, i + 1
        value, i = _DECODER.raw_decode(src, i)
        out.append(value)


def _decode_value(src: str, name: str) -> Any:
    """The value of `const <name> = …;`, array or not."""
    marker = f"const {name} = "
    at = src.index(marker) + len(marker)
    if src[at] == "[":
        return _decode_array(src, at)[0]
    return _DECODER.raw_decode(src, at)[0]


# --- normalisation ----------------------------------------------------------

def fold(text: Any) -> str:
    """Lowercase, strip accents, and keep letters and digits only.

    A reader typing "universite cote d'azur" must reach "Université Côte
    d'Azur", and "AI4REALNET" must reach "AI4REALNET"; both fall out of folding
    the two sides the same way.
    """
    s = unicodedata.normalize("NFKD", str(text or ""))
    s = "".join(c for c in s if not unicodedata.combining(c))
    return s.lower()


_TOKEN_RE = re.compile(r"[a-z0-9]+")

# Words that match everything and so rank nothing. Both languages, because the
# reader's question and the corpus can be in either.
_STOPWORDS = frozenset("""
a about all also an and any are as at be been but by can could de des do du
does for from had has have how i if in into is it its la le les of on one only
or our out over she so some such than that the their them then there these they
this those to too un une up use used using was we were what when where which
who why will with would you your
au aux avec ce cet cette comme dans donc elle en est et eux il ils je leur lui
ma mais me meme mes moi mon ne nos notre nous on ou par pas plus pour qu que
quel quels qui quoi sa sans se ses son sont sur ta te tes toi ton tu vos votre
vous y etre avoir fait faire quelle quelles
carte map team teams equipe equipes projet projets project projects
""".split())


def tokens(text: Any) -> list[str]:
    return [t for t in _TOKEN_RE.findall(fold(text)) if t not in _STOPWORDS and len(t) > 1]


# --- the corpus -------------------------------------------------------------

@dataclass
class Corpus:
    """Every entity the map draws, plus the vocabulary and freshness date."""

    entities: list[dict[str, Any]] = field(default_factory=list)
    edges: list[dict[str, Any]] = field(default_factory=list)
    taxo: dict[str, Any] = field(default_factory=dict)
    as_of: str = ""
    source: Path | None = None

    # Built in __post_init__.
    by_id: dict[str, dict[str, Any]] = field(default_factory=dict, repr=False)
    _haystacks: dict[str, list[str]] = field(default_factory=dict, repr=False)
    _idf: dict[str, float] = field(default_factory=dict, repr=False)
    _neighbours: dict[str, set[str]] = field(default_factory=dict, repr=False)

    def __post_init__(self) -> None:
        self.by_id = {e["id"]: e for e in self.entities}
        self._index()

    # -- structure ------------------------------------------------------

    def _index(self) -> None:
        docs = 0
        seen: dict[str, int] = {}
        for e in self.entities:
            toks = tokens(self._haystack_text(e))
            self._haystacks[e["id"]] = toks
            docs += 1
            for t in set(toks):
                seen[t] = seen.get(t, 0) + 1
        # Smoothed IDF: a token in every card ("ai", "research") carries almost
        # no signal, a token in three cards carries a lot.
        self._idf = {t: math.log(1 + docs / n) for t, n in seen.items()}

        # edges.yml says which team sits in which project consortium, as
        # `{project, team}`. The chat wants it as a neighbourhood, both ways:
        # "who is in this project" and "which projects is this team in" are the
        # same question asked from either end.
        for edge in self.edges:
            a, b = edge.get("project"), edge.get("team")
            if a in self.by_id and b in self.by_id:
                self._neighbours.setdefault(a, set()).add(b)
                self._neighbours.setdefault(b, set()).add(a)

    def _haystack_text(self, e: dict[str, Any]) -> str:
        """Everything about an entity a reader might name it by."""
        parts = [e.get("id", ""), e.get("name", ""), e.get("city", ""),
                 e.get("country", ""), e.get("desc", ""), e.get("desc_fr", ""),
                 e.get("desc_en", ""), e.get("kind", ""), e.get("status", ""),
                 " ".join(e.get("focus") or []), " ".join(e.get("domains") or []),
                 e.get("url", "")]
        for member in e.get("consortium") or []:
            parts += [member.get("org", ""), member.get("country", "")]
        for key in ("affiliation", "issuer", "maintainer"):
            org = e.get(key) or {}
            if isinstance(org, dict):
                parts.append(org.get("org", ""))
        infra = e.get("infra") or {}
        if isinstance(infra, dict):
            parts += [infra.get("kind", ""), (infra.get("operator") or {}).get("org", "")]
        return " ".join(str(p) for p in parts if p)

    def neighbours(self, entity_id: str) -> list[dict[str, Any]]:
        return [self.by_id[i] for i in sorted(self._neighbours.get(entity_id, ()))]

    def counts(self) -> dict[str, int]:
        out = {layer: 0 for layer in LAYERS}
        for e in self.entities:
            out[e["kind"]] = out.get(e["kind"], 0) + 1
        out["links"] = len(self.edges)
        return out

    # -- lookup ---------------------------------------------------------

    def find_by_name(self, name: str) -> dict[str, Any] | None:
        """An entity whose id or name is what the reader just typed.

        Exact before loose, so "ETH" cannot shadow "ETH Zürich" when the reader
        meant the latter and typed it in full.
        """
        want = fold(name).strip()
        if not want:
            return None
        if want in self.by_id:
            return self.by_id[want]
        for e in self.entities:
            if fold(e["name"]) == want or fold(e["id"]) == want:
                return e
        hits = [e for e in self.entities
                if want in fold(e["name"]) or fold(e["name"]) in want]
        return hits[0] if len(hits) == 1 else None

    def cities(self) -> dict[tuple[str, str], tuple[float, float]]:
        """City coordinates the corpus already agrees on.

        A proposal for a city the map already covers inherits that city's
        coordinates rather than asking the contributor to look up a latitude —
        and rather than inventing one, which is the failure mode of a model
        asked for numbers it cannot know.
        """
        out: dict[tuple[str, str], tuple[float, float]] = {}
        for e in self.entities:
            lat, lon = e.get("lat"), e.get("lon")
            city, country = e.get("city"), e.get("country")
            if lat is None or lon is None or not city or not country:
                continue
            out.setdefault((fold(city), country.upper()), (float(lat), float(lon)))
        return out

    # -- retrieval ------------------------------------------------------

    def search(self, query: str, limit: int = 10,
               kinds: Iterable[str] | None = None) -> list[tuple[float, dict[str, Any]]]:
        """Rank entities against a question, best first.

        Lexical, not semantic: IDF-weighted overlap, with a strong bonus when
        the query actually names the entity. The corpus is 450 short records in
        two languages, where the words a reader uses are mostly the words the
        cards use; an embedding round-trip per turn would cost a second of the
        local model's time to reorder the same first page.
        """
        want = tokens(query)
        if not want:
            return []
        wanted = set(want)
        folded_query = fold(query)
        allow = set(kinds) if kinds else None

        scored: list[tuple[float, dict[str, Any]]] = []
        for e in self.entities:
            if allow and e["kind"] not in allow:
                continue
            hay = self._haystacks[e["id"]]
            if not hay:
                continue
            seen = set(hay)
            score = sum(self._idf.get(t, 0.0) for t in wanted & seen)
            if score <= 0:
                continue
            # Length normalisation, gently: a long description should not win
            # on surface area alone, but it should not be punished either.
            score /= 1 + math.log(1 + len(hay) / 40)
            name = fold(e["name"])
            if name and name in folded_query:
                score += 8.0
            elif wanted & set(tokens(e["name"])):
                score += 2.0
            if fold(e["id"]) in folded_query:
                score += 8.0
            if e.get("city") and fold(e["city"]) in folded_query:
                score += 1.5
            scored.append((score, e))

        scored.sort(key=lambda pair: (-pair[0], pair[1]["id"]))
        return scored[:limit]


def load(path: str | Path) -> Corpus:
    src = Path(path).read_text(encoding="utf-8")
    entities: list[dict[str, Any]] = []
    for const, layer in _ARRAYS.items():
        for e in _decode_value(src, const):
            e["kind"] = layer
            entities.append(e)
    return Corpus(
        entities=entities,
        edges=_decode_value(src, "EDGES"),
        taxo=_decode_value(src, "TAXO"),
        as_of=_decode_value(src, "AS_OF"),
        source=Path(path),
    )


# --- what the model is shown ------------------------------------------------

def label(corpus: Corpus, group: str, key: str, lang: str) -> str:
    """A taxonomy code in the reader's language, or the code itself."""
    entry = (corpus.taxo.get(group) or {}).get(key)
    if isinstance(entry, dict):
        return entry.get(lang) or entry.get("en") or key
    return key


# The 27 countries the corpus uses, in both the reader's languages, so a
# question that says "in Germany" or "en Allemagne" can be counted rather than
# estimated. Codes the data does not use are left out on purpose: this table
# exists to read questions about this map, not to be a country list.
COUNTRY_NAMES = {
    "AT": ("austria", "autriche"), "BE": ("belgium", "belgique"),
    "CH": ("switzerland", "suisse"), "CY": ("cyprus", "chypre"),
    "CZ": ("czechia czech republic", "tchequie republique tcheque"),
    "DE": ("germany", "allemagne"), "DK": ("denmark", "danemark"),
    "EE": ("estonia", "estonie"), "ES": ("spain", "espagne"),
    "FI": ("finland", "finlande"), "FR": ("france", "france"),
    "GR": ("greece", "grece"), "HR": ("croatia", "croatie"),
    "HU": ("hungary", "hongrie"), "IE": ("ireland", "irlande"),
    "IT": ("italy", "italie"), "LT": ("lithuania", "lituanie"),
    "LU": ("luxembourg", "luxembourg"), "NL": ("netherlands holland", "pays-bas"),
    "NO": ("norway", "norvege"), "PL": ("poland", "pologne"),
    "PT": ("portugal", "portugal"), "RO": ("romania", "roumanie"),
    "SE": ("sweden", "suede"), "SI": ("slovenia", "slovenie"),
    "SK": ("slovakia", "slovaquie"),
    "UK": ("united kingdom britain england scotland wales", "royaume-uni angleterre"),
}

_LAYER_PLURAL = {"project": "projects", "team": "teams", "commons": "commons",
                 "framework": "frameworks"}


def countries_in(text: str) -> list[str]:
    """Country codes a question names, by code or by name in either language.

    Codes are matched on the text as typed, in upper case: folded, the French
    "de" and the Italian "it" are country codes in every other sentence.
    """
    words = set(_TOKEN_RE.findall(fold(text)))
    raw = set(re.findall(r"\b[A-Z]{2}\b", text))
    out = []
    for code, (en, fr) in COUNTRY_NAMES.items():
        names = set(en.split()) | {w for n in fr.split() for w in n.split("-")}
        if code in raw or names & words:
            out.append(code)
    return out


_LAYER_WORDS = (
    ("project", r"projets?|programmes?|consortiums?|project|programme"),
    ("team", r"[ée]quipes?|laboratoires?|labos?|groupes?|teams?|labs?"),
    ("commons", r"communs?|jeux? de donn|datasets?|benchmarks?|logiciels?|commons"),
    ("framework", r"cadres?|normes?|standards?|r[eè]glements?|frameworks?"),
)
# Questions about when things began, which retrieval cannot answer: no card
# contains the word "oldest", so a lexical search returns noise and the model
# concludes the map holds no dates — while the period slider is built on them.
_WHEN_RE = re.compile(
    r"\b(ancien\w*|vieux|vieille|r[ée]cent\w*|premi[eè]re?s?|derni[eè]re?s?|"
    r"ann[ée]e\w*|dates?|dat[ée]\w*|p[ée]riode|depuis|remonte|d[ée]but\w*|"
    r"fond[ée]\w*|cr[ée][ée]\w*|oldest|earliest|newest|latest|recent|first|"
    r"last|year|date[ds]?|founded|started|since|how old)\b", re.I)
# Questions about the entities with no marker, which retrieval cannot answer
# either: "map", "carte", "sans" and "pas" are stopwords, so "which frameworks
# are off the map?" is searched as "off" and returns offshore vessels, and the
# model, held to its cards, replies that the thing "is not on the map". Matched
# on the folded question, so accents do not matter; apostrophes may be curly.
_OFFMAP_RE = re.compile(
    r"off[- ]?(the[- ])?map|(\bnot|n['’]t)\s+(shown\s+|pinned\s+|placed\s+)?(on|in)\s+the\s+map|"
    r"(missing|absent)\s+from\s+the\s+map|\b(placeless|unplaced|unpinned|unlocated)\b|"
    r"\b(no|without(\s+an?)?)\s+(coordinates?|location|position|pin|marker)\b|"
    r"hors[- ](de\s+la\s+)?carte|pas\s+(sur|dans)\s+la\s+carte|absente?s?\s+de\s+la\s+carte|"
    r"invisibles?\s+sur\s+la\s+carte|"
    r"sans\s+(coordonnees|localisation|lieu|position|epingle|marqueur|emplacement)|"
    r"\b(pas|aucune?)\s+(de\s+|d['’]\s*)?(coordonnees|localisation|marqueur|epingle|emplacement)|"
    r"\b(non|pas)\s+(localise|positionne|epingle)e?s?\b")


def _layer_named(text: str) -> str | None:
    folded = fold(text)
    for layer, pattern in _LAYER_WORDS:
        if re.search(pattern, folded, re.I):
            return layer
    return None


def _layers_named(text: str) -> list[str]:
    """Every layer a question names — "frameworks and commons" is two."""
    folded = fold(text)
    return [layer for layer, pattern in _LAYER_WORDS if re.search(pattern, folded, re.I)]


def _start_year(entity: dict[str, Any]) -> int | None:
    start = (entity.get("timeline") or {}).get("start")
    m = re.match(r"(\d{4})", str(start or ""))
    return int(m.group(1)) if m else None


def _when_figures(corpus: Corpus, query: str) -> list[str]:
    """The ends of the timeline, counted rather than searched.

    §10.1: a start year that is only the host institution's founding year is a
    floor, not a start. Those entities are left out of "oldest" and counted
    separately, so the answer cannot turn a university's 1923 into a lab's.
    """
    layer = _layer_named(query)
    pool = [e for e in corpus.entities if layer is None or e["kind"] == layer]
    own = [(y, e) for e in pool if not e.get("dateHost")
           if (y := _start_year(e)) is not None]
    if not own:
        return []
    own.sort(key=lambda pair: (pair[0], pair[1]["id"]))

    def row(pair: tuple[int, dict[str, Any]]) -> str:
        # Written as the link the reply should carry: a model copies the shape
        # it is given, and `Name (#id)` copied verbatim is a dead string where
        # `[Name](#id)` is a card the reader can open.
        year, e = pair
        return f"[{e['name']}](#{e['id']}) — {e['kind']}, {year}"

    what = f"{_LAYER_PLURAL[layer]}" if layer else "entities"
    rows = [f"Earliest {what} by start year: " + "; ".join(row(p) for p in own[:3]) + ".",
            f"Most recent {what}: " + "; ".join(row(p) for p in reversed(own[-3:])) + "."]
    floors = sum(1 for e in pool if e.get("dateHost"))
    undated = sum(1 for e in pool if _start_year(e) is None)
    if floors or undated:
        rows.append(
            f"Left out of those two lines: {floors} {what} whose recorded year is "
            f"their host institution's founding rather than their own, and {undated} "
            "with no start year at all. Say so if the answer turns on it.")
    return rows


def _who(e: dict[str, Any]) -> str:
    for key in ("issuer", "maintainer", "affiliation"):
        org = (e.get(key) or {}).get("org") if isinstance(e.get(key), dict) else None
        if org:
            return org if len(org) <= 64 else org[:63].rstrip() + "…"
    return ""


def _offmap_figures(corpus: Corpus, query: str) -> list[str]:
    """The entities with no marker, listed rather than searched.

    §3.1: an entity with no coordinates keeps its card, its search result and
    its links, and is listed under "Off the map" rather than pinned somewhere it
    is not. Nothing in a card says so in words a reader would type, so they are
    handed over by layer — with an explicit "none" for a layer that has none, so
    "which teams are off the map?" is not answered by guessing — and each with
    whoever issued or maintains it, which is what says why it has no place.
    """
    off = [e for e in corpus.entities if e.get("geo") is False]
    per = {layer: sorted((e for e in off if e["kind"] == layer), key=lambda e: fold(e["name"]))
           for layer in LAYERS}
    detail = ", ".join(f"{len(per[k])} {_LAYER_PLURAL[k]}" for k in LAYERS if per[k])
    rows = [f"Off the map: {len(off)} entities have no coordinates"
            + (f" — {detail}" if detail else "") + ". Each keeps its card, its search "
            "result and its links, and is listed under \"Off the map\" in the sidebar "
            "instead of having a marker. After each name below, who issued or maintains it."]
    # Why, from the data rather than from a sentence written here: a recorded
    # jurisdiction is what says a framework has no one European place.
    juris: dict[str, int] = {}
    for e in off:
        if e.get("jurisdiction"):
            juris[e["jurisdiction"]] = juris.get(e["jurisdiction"], 0) + 1
    if juris:
        rows.append("Why they have no marker, from what their cards record — jurisdiction: "
                    + ", ".join(f"{n} {j}" for j, n in sorted(
                        juris.items(), key=lambda kv: (-kv[1], kv[0])))
                    + ". An international one belongs to no one European place, so the map "
                    "does not pin it; for the rest, the issuer after each name says where "
                    "the work comes from.")

    def row(e: dict[str, Any]) -> str:
        who = _who(e)
        return f"[{e['name']}](#{e['id']})" + (f" — {who}" if who else "")

    for layer in [k for k in LAYERS if k in _layers_named(query)] or \
            [k for k in LAYERS if per[k]]:
        these = per[layer]
        if not these:
            rows.append(f"No {_LAYER_PLURAL[layer]} are off the map: every one has a marker.")
            continue
        more = f"; and {len(these) - 25} more" if len(these) > 25 else ""
        rows.append(f"{_LAYER_PLURAL[layer].capitalize()} off the map ({len(these)}): "
                    + "; ".join(row(e) for e in these[:25]) + more + ".")
    return rows


def figures(corpus: Corpus, query: str) -> str:
    """Counts for the question, computed rather than estimated.

    A model cannot count 450 records it has not been shown, and asking it to
    try is how a chat invents "around 40 teams in Germany". Anything countable
    is counted here and handed over as a fact.
    """
    counts = corpus.counts()
    whole = ", ".join(f"{counts[k]} {_LAYER_PLURAL[k]}" for k in LAYERS)
    rows = [f"Whole map: {whole}, {counts['links']} consortium links "
            f"(snapshot {corpus.as_of})."]

    for code in countries_in(query)[:4]:
        per: dict[str, int] = {}
        for e in corpus.entities:
            if (e.get("country") or "").upper() == code:
                per[e["kind"]] = per.get(e["kind"], 0) + 1
        total = sum(per.values())
        detail = ", ".join(f"{per[k]} {_LAYER_PLURAL[k]}" for k in LAYERS if per.get(k))
        rows.append(f"{COUNTRY_NAMES[code][0].split()[0].title()} ({code}): "
                    f"{total} entities — {detail or 'none'}.")

    wanted = set(tokens(query))
    domains = {d for e in corpus.entities for d in (e.get("domains") or [])}
    for dom in sorted(d for d in domains if d in wanted):
        n = sum(1 for e in corpus.entities if dom in (e.get("domains") or []))
        rows.append(f"Domain {dom}: {n} entities.")

    focus_keys = set((corpus.taxo.get("focus") or {}).keys())
    for key in sorted(k for k in focus_keys if set(k.split("_")) <= wanted):
        n = sum(1 for e in corpus.entities if key in (e.get("focus") or []))
        rows.append(f"Focus {key}: {n} entities.")

    if _WHEN_RE.search(query):
        rows += _when_figures(corpus, query)
    if _OFFMAP_RE.search(fold(query)):
        rows += _offmap_figures(corpus, query)
    return "\n".join(rows)


def catalogue(corpus: Corpus) -> str:
    """Every entity on one line: id, name, layer, place.

    The point is id discipline. A model that has the full list in front of it
    links to cards that exist, says "not on the map" when something is missing,
    and does not propose adding what is already there. Detail comes from
    retrieval; this is the index.
    """
    lines: list[str] = []
    for layer in LAYERS:
        rows = [e for e in corpus.entities if e["kind"] == layer]
        lines.append(f"### {layer} ({len(rows)})")
        for e in sorted(rows, key=lambda x: x["id"]):
            where = ", ".join(p for p in (e.get("city"), e.get("country")) if p) or "no location"
            lines.append(f"{e['id']} | {e['name']} | {where}")
    return "\n".join(lines)


def render_entity(corpus: Corpus, e: dict[str, Any], lang: str = "en") -> str:
    """One retrieved entity, in full, as the model should read it."""
    desc = e.get(f"desc_{lang}") or e.get("desc") or ""
    rows = [f"id: {e['id']}", f"name: {e['name']}", f"layer: {e['kind']}"]
    where = ", ".join(p for p in (e.get("city"), e.get("country")) if p)
    if where:
        rows.append(f"location: {where}")
    elif e.get("geo") is False:
        # In the reader's language: the model copies it into the answer, and a
        # French reply read "hors de la carte (no coordinates)".
        rows.append("location: " + ("hors carte (sans coordonnées)" if lang == "fr"
                                    else "off the map (no coordinates)"))
    for key, heading in (("status", "status"), ("kind", "kind"), ("tier", "tier"),
                         ("when", "period"), ("url", "homepage")):
        if e.get(key) and key != "kind":
            rows.append(f"{heading}: {e[key]}")
    if e.get("focus"):
        rows.append("focus: " + ", ".join(label(corpus, "focus", f, lang) for f in e["focus"]))
    if e.get("domains"):
        rows.append("domains: " + ", ".join(label(corpus, "domain", d, lang) for d in e["domains"]))
    for member_key, heading in (("affiliation", "affiliation"), ("issuer", "issuing body"),
                                ("maintainer", "maintainer")):
        org = e.get(member_key) or {}
        if isinstance(org, dict) and org.get("org"):
            rows.append(f"{heading}: {org['org']}")
    if e.get("consortium"):
        members = ", ".join(
            f"{m.get('org', '?')} ({m.get('role', 'partner')}, {m.get('country', '?')})"
            for m in e["consortium"][:12])
        rows.append(f"consortium: {members}")
    if e.get("funding"):
        f = e["funding"]
        bits = [str(f.get(k)) for k in ("source", "programme", "amount") if f.get(k)]
        if bits:
            rows.append("funding: " + " · ".join(bits))
    links = corpus.neighbours(e["id"])
    if links:
        rows.append("linked cards: " + ", ".join(f"{n['name']} (#{n['id']})" for n in links[:12]))
    prov = e.get("prov") or {}
    if prov:
        rows.append(f"provenance: added by {prov.get('by', '?')} on {prov.get('on', '?')}, "
                    f"source {prov.get('src', '?')}, confidence {prov.get('conf', '?')}")
    if desc:
        rows.append(f"description: {desc}")
    return "\n".join(rows)


def retrieved_block(corpus: Corpus, query: str, lang: str = "en",
                    limit: int = 8) -> tuple[str, list[dict[str, Any]]]:
    """The cards relevant to a question, rendered for the prompt."""
    hits = corpus.search(query, limit=limit)
    if not hits:
        return "", []
    entities = [e for _, e in hits]
    blocks = [render_entity(corpus, e, lang) for e in entities]
    return "\n\n---\n\n".join(blocks), entities
