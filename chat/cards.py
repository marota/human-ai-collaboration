"""What a proposed card looks like, what makes it valid, and how it is written.

The chat does not write to the map. It writes a *proposal*: the YAML an entity
would have in eu-hai-collab-map, carried in a GitHub issue for a maintainer to
turn into a pull request. So the shape that matters here is the upstream one —
`description`, `provenance.added_by`, `focus_areas` — not the compact keys the
generator emits for the page (`desc`, `prov.by`, `focus`).

The field table below is the single description of that shape, and it travels
to the browser as JSON: the form the contributor edits is rendered from it, the
answers come back against it, and validation runs on the server against the
same table. A field added here appears in the form without touching the UI.

Field names are dotted paths into the YAML (`location.city`), which keeps the
table flat and the form a flat list of inputs.
"""
from __future__ import annotations

import datetime as _dt
import re
from dataclasses import dataclass, field as _field
from typing import Any, Iterable

from hai_data import LAYERS, fold

# Upstream `domains` vocabulary. These are the keys of SECTOR in
# scripts/build-map-data.py — the generator has to know every value the YAML can
# carry, which makes it the authority in this repository; the map's own payload
# only keeps the sector codes it derives from them. Kept in step by
# tests/chat/test_cards.py, which compares the two lists.
DOMAINS = (
    "energy", "power_grid", "nuclear", "aviation", "rail", "transport",
    "maritime", "telecom", "water", "gas", "healthcare", "manufacturing",
    "defense", "critical_infrastructure",
)

# Per-layer `kind` enums, from the JSON Schemas upstream. `type` (teams) and
# `status` come from the payload's own TAXO, so they are read from the corpus
# rather than repeated here.
KINDS = {
    "project": ("horizon_europe", "horizon_2020", "eu_other", "national_grant",
                "industrial_consortium", "internal", "other"),
    "commons": ("dataset", "benchmark", "model", "software", "community"),
    "framework": ("regulation", "standard", "guideline", "policy", "code_of_conduct"),
}
TEAM_TYPES = ("research_lab", "industrial_rd", "applied_project",
              "infrastructure", "network")
STATUSES = ("active", "concluded", "planned")
CONFIDENCES = ("high", "medium", "low")
ROLES = ("coordinator", "partner", "third_party", "observer", "member", "operator", "funder")
LEGAL = ("in_force", "proposed", "draft", "superseded")

SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]*[a-z0-9]$")
YEAR_RE = re.compile(r"^\d{4}(-\d{2})?$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
URL_RE = re.compile(r"^https?://[^\s]+$", re.I)


@dataclass(frozen=True)
class Field:
    """One input in the proposal form.

    `kind` is what the browser renders: text, long (textarea), url, select,
    multi (checkbox set), number, year, date, orgs (repeating org/role/country
    rows) or ids (a list of existing card ids).
    """

    path: str
    kind: str
    label_en: str
    label_fr: str
    required: bool = False
    vocab: tuple[str, ...] = ()
    help_en: str = ""
    help_fr: str = ""
    # Fields the contributor rarely needs are rendered under a "more" fold, so
    # the form stays short enough to actually finish in one sitting.
    secondary: bool = False

    def as_json(self, lang: str) -> dict[str, Any]:
        return {
            "path": self.path,
            "kind": self.kind,
            "label": self.label_fr if lang == "fr" else self.label_en,
            "required": self.required,
            "vocab": list(self.vocab),
            "help": (self.help_fr if lang == "fr" else self.help_en) or "",
            "secondary": self.secondary,
        }


def _common_head(layer: str) -> list[Field]:
    return [
        Field("id", "text", "Slug", "Identifiant", required=True,
              help_en="Lowercase and hyphenated, usually <institution>-<group>-<focus>. "
                      "Becomes the file name upstream.",
              help_fr="En minuscules avec des tirets, en général <institution>-<équipe>-<sujet>. "
                      "Devient le nom du fichier en amont."),
        Field("name", "text", "Name", "Nom", required=True),
    ]


def _common_tail(layer: str, statuses: tuple[str, ...]) -> list[Field]:
    desc_help_en = ("Two paragraphs at most, for a fellow researcher who has not heard of "
                    "this group. Lead with what they actually do; no marketing language.")
    desc_help_fr = ("Deux paragraphes au maximum, pour un collègue chercheur qui ne connaît "
                    "pas cette équipe. Commencez par ce qu'elle fait réellement, sans "
                    "langage promotionnel.")
    return [
        Field("status", "select", "Status", "Statut", required=True, vocab=statuses),
        Field("tier", "select", "Scope", "Périmètre", vocab=("core", "ecosystem"),
              help_en="core = decision-making in critical systems. ecosystem = the enabling "
                      "context (national programmes, compute, networks, broad references).",
              help_fr="core = décision dans les systèmes critiques. ecosystem = le contexte "
                      "qui le rend possible (programmes nationaux, calcul, réseaux, cadres "
                      "généraux).",
              secondary=True),
        Field("focus_areas", "multi", "Focus areas", "Axes", required=(layer == "team")),
        Field("domains", "multi", "Domains", "Domaines", required=(layer == "team"),
              vocab=DOMAINS),
        Field("description", "long", "Description", "Description", required=True,
              help_en=desc_help_en, help_fr=desc_help_fr),
        Field("description_fr", "long", "French description", "Description française",
              help_en="Optional. Goes to data/i18n/descriptions.fr.yml upstream, not into "
                      "the card itself.",
              help_fr="Facultatif. Va dans data/i18n/descriptions.fr.yml en amont, pas dans "
                      "la fiche elle-même.",
              secondary=True),
        Field("provenance.source", "text", "Source", "Source", required=True,
              help_en="Where this comes from — a URL, or 'personal knowledge'.",
              help_fr="D'où vient l'information — une URL, ou « connaissance directe »."),
        Field("provenance.confidence", "select", "Confidence", "Confiance", required=True,
              vocab=CONFIDENCES,
              help_en="How sure the facts above are. low is a fine answer, and it is "
                      "recorded on the card.",
              help_fr="À quel point les faits ci-dessus sont sûrs. « faible » est une "
                      "réponse acceptable, et elle est inscrite sur la fiche."),
        Field("provenance.added_by", "text", "Added by", "Ajouté par", required=True,
              help_en="Your GitHub handle or name — it stays on the card.",
              help_fr="Votre pseudo GitHub ou votre nom — il reste sur la fiche."),
    ]


_LOCATION = [
    Field("location.country", "text", "Country", "Pays", required=True,
          help_en="ISO 3166-1 alpha-2, e.g. FR.", help_fr="ISO 3166-1 alpha-2, ex. FR."),
    Field("location.city", "text", "City", "Ville", required=True),
    Field("location.lat", "number", "Latitude", "Latitude", required=True,
          help_en="Filled in from a city the map already covers when there is one.",
          help_fr="Repris d'une ville déjà présente sur la carte quand il en existe une."),
    Field("location.lon", "number", "Longitude", "Longitude", required=True),
]


def _spec(layer: str) -> list[Field]:
    if layer == "team":
        return [
            *_common_head(layer),
            Field("type", "select", "Type", "Type", required=True, vocab=TEAM_TYPES),
            *_LOCATION,
            Field("affiliation.org", "text", "Organisation", "Organisation", required=True),
            Field("affiliation.url", "url", "Organisation URL", "URL de l'organisation",
                  required=True),
            Field("affiliation.parent", "text", "Parent organisation",
                  "Organisation de rattachement", secondary=True),
            Field("links.homepage", "url", "Homepage", "Page d'accueil", required=True),
            Field("project_ids", "ids", "Projects", "Projets",
                  help_en="Ids of projects on the map this team sits in.",
                  help_fr="Identifiants des projets de la carte auxquels l'équipe participe."),
            Field("timeline.start", "year", "Started", "Début", secondary=True,
                  help_en="YYYY or YYYY-MM. Drives the period slider.",
                  help_fr="AAAA ou AAAA-MM. Alimente le curseur de période."),
            *_common_tail(layer, STATUSES),
        ]
    if layer == "project":
        return [
            *_common_head(layer),
            Field("kind", "select", "Kind", "Nature", vocab=KINDS["project"]),
            Field("homepage", "url", "Homepage", "Page d'accueil", required=True),
            Field("timeline.start", "year", "Start", "Début", required=True,
                  help_en="YYYY or YYYY-MM.", help_fr="AAAA ou AAAA-MM."),
            Field("timeline.end", "year", "End", "Fin",
                  help_en="Leave empty while it is running.",
                  help_fr="Laissez vide tant qu'il est en cours."),
            Field("consortium", "orgs", "Consortium", "Consortium",
                  help_en="One row per partner. The coordinator first.",
                  help_fr="Une ligne par partenaire. Le coordinateur en premier."),
            Field("funding.source", "text", "Funding source", "Financeur", secondary=True),
            Field("funding.programme", "text", "Programme", "Programme", secondary=True),
            Field("funding.amount", "number", "Amount (EUR)", "Montant (EUR)", secondary=True),
            *[Field(f.path, f.kind, f.label_en, f.label_fr, required=False,
                    vocab=f.vocab, help_en=f.help_en, help_fr=f.help_fr, secondary=True)
              for f in _LOCATION],
            *_common_tail(layer, STATUSES),
        ]
    if layer == "commons":
        return [
            *_common_head(layer),
            Field("kind", "select", "Kind", "Nature", required=True, vocab=KINDS["commons"]),
            Field("license", "text", "Licence", "Licence", required=True,
                  help_en="SPDX identifier where there is one, e.g. CC-BY-4.0, MIT.",
                  help_fr="Identifiant SPDX quand il en existe un, ex. CC-BY-4.0, MIT."),
            Field("links.homepage", "url", "Homepage", "Page d'accueil", required=True),
            Field("repository_url", "url", "Repository", "Dépôt"),
            Field("maintainer.org", "text", "Maintainer", "Mainteneur"),
            Field("maintainer.url", "url", "Maintainer URL", "URL du mainteneur",
                  secondary=True),
            Field("size_indicator", "text", "Size", "Taille", secondary=True,
                  help_en="Free text — rows, hours, parameters, members.",
                  help_fr="Texte libre — lignes, heures, paramètres, membres."),
            *_common_tail(layer, STATUSES),
        ]
    if layer == "framework":
        return [
            *_common_head(layer),
            Field("kind", "select", "Kind", "Nature", required=True, vocab=KINDS["framework"]),
            Field("jurisdiction", "text", "Jurisdiction", "Juridiction", required=True,
                  help_en="EU, international, global, or a country code.",
                  help_fr="EU, international, global, ou un code pays."),
            Field("issuing_body.org", "text", "Issuing body", "Organisme émetteur",
                  required=True),
            Field("issuing_body.url", "url", "Issuing body URL", "URL de l'organisme",
                  required=True),
            Field("links.homepage", "url", "Homepage", "Page d'accueil", required=True),
            Field("legal_status", "select", "Legal status", "Statut juridique", vocab=LEGAL),
            Field("adoption_date", "year", "Adopted", "Adoption", secondary=True),
            *_common_tail(layer, STATUSES),
        ]
    raise ValueError(f"unknown layer: {layer}")


def spec(layer: str, corpus: Any = None, lang: str = "en") -> list[dict[str, Any]]:
    """The field table for a layer, as the browser receives it.

    The focus-area vocabulary comes from the payload's own TAXO so the form can
    never offer a code the map cannot label.
    """
    focus_vocab: tuple[str, ...] = ()
    if corpus is not None:
        focus_vocab = tuple((corpus.taxo.get("focus") or {}).keys())
    out = []
    for f in _spec(layer):
        if f.path == "focus_areas" and focus_vocab:
            f = Field(f.path, f.kind, f.label_en, f.label_fr, f.required, focus_vocab,
                      f.help_en, f.help_fr, f.secondary)
        out.append(f.as_json(lang))
    return out


# --- dotted paths -----------------------------------------------------------

def get_path(obj: dict[str, Any], path: str) -> Any:
    cur: Any = obj
    for part in path.split("."):
        if not isinstance(cur, dict):
            return None
        cur = cur.get(part)
    return cur


def set_path(obj: dict[str, Any], path: str, value: Any) -> None:
    parts = path.split(".")
    cur = obj
    for part in parts[:-1]:
        nxt = cur.get(part)
        if not isinstance(nxt, dict):
            nxt = {}
            cur[part] = nxt
        cur = nxt
    cur[parts[-1]] = value


def _blank(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, str):
        return value.strip() == ""
    if isinstance(value, (list, tuple, dict)):
        return len(value) == 0
    return False


# --- validation -------------------------------------------------------------

@dataclass
class Report:
    errors: list[dict[str, str]] = _field(default_factory=list)
    warnings: list[dict[str, str]] = _field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors

    def as_json(self) -> dict[str, Any]:
        return {"ok": self.ok, "errors": self.errors, "warnings": self.warnings}


_MSG = {
    "required": ("is required", "est obligatoire"),
    "slug": ("must be lowercase letters, digits and hyphens",
             "doit être en minuscules, chiffres et tirets"),
    "taken": ("is already a card on the map", "correspond déjà à une fiche de la carte"),
    "vocab": ("is not in the controlled vocabulary", "n'est pas dans le vocabulaire contrôlé"),
    "url": ("must start with http:// or https://", "doit commencer par http:// ou https://"),
    "year": ("must be YYYY or YYYY-MM", "doit être au format AAAA ou AAAA-MM"),
    "country": ("must be a two-letter country code, e.g. FR",
                "doit être un code pays à deux lettres, ex. FR"),
    "lat": ("must be between -90 and 90", "doit être entre -90 et 90"),
    "lon": ("must be between -180 and 180", "doit être entre -180 et 180"),
    "short": ("needs at least 20 characters", "doit faire au moins 20 caractères"),
    "unknown_id": ("names a card that is not on the map",
                   "désigne une fiche absente de la carte"),
    "role": ("has a role outside " + "/".join(ROLES),
             "a un rôle hors " + "/".join(ROLES)),
}


def validate(layer: str, card: dict[str, Any], corpus: Any,
             mode: str = "add", lang: str = "en") -> Report:
    """Check a proposal the way upstream CI would, before anyone reads it.

    The point is not to gatekeep: every message names a field and says what to
    do, so the contributor can fix it in the form while they are still here.
    """
    i = 1 if lang == "fr" else 0
    rep = Report()

    def fail(path: str, key: str, extra: str = "") -> None:
        rep.errors.append({"path": path, "message": (_MSG[key][i] + extra)})

    def warn(path: str, message: str) -> None:
        rep.warnings.append({"path": path, "message": message})

    fields = {f.path: f for f in _spec(layer)}
    focus_vocab = set((corpus.taxo.get("focus") or {}).keys()) if corpus else set()

    for path, f in fields.items():
        value = get_path(card, path)
        if f.required and _blank(value):
            # A correction only carries the fields it changes, so absence is
            # only a problem when a whole card is being proposed.
            if mode == "add":
                fail(path, "required")
            continue
        if _blank(value):
            continue
        if f.kind == "url" and not URL_RE.match(str(value)):
            fail(path, "url")
        if f.kind == "year" and not YEAR_RE.match(str(value)):
            fail(path, "year")
        if f.kind == "select" and f.vocab and str(value) not in f.vocab:
            fail(path, "vocab", f" ({', '.join(f.vocab)})")
        if f.kind == "multi":
            vocab = focus_vocab if path == "focus_areas" else set(f.vocab)
            bad = [v for v in (value or []) if v not in vocab]
            if bad:
                fail(path, "vocab", f": {', '.join(bad)}")
        if f.kind == "ids":
            unknown = [v for v in (value or []) if v not in corpus.by_id]
            if unknown:
                fail(path, "unknown_id", f": {', '.join(unknown)}")
        if f.kind == "orgs":
            for row in value or []:
                if not isinstance(row, dict) or _blank(row.get("org")):
                    fail(path, "required")
                    break
                if row.get("role") and row["role"] not in ROLES:
                    fail(path, "role")
                    break

    slug = card.get("id")
    if slug and not SLUG_RE.match(str(slug)):
        fail("id", "slug")
    elif slug and mode == "add" and corpus and slug in corpus.by_id:
        fail("id", "taken")

    desc = card.get("description")
    if desc and len(str(desc).strip()) < 20:
        fail("description", "short")

    country = get_path(card, "location.country")
    if country and not re.match(r"^[A-Z]{2}$", str(country)):
        fail("location.country", "country")

    for path, key, lo, hi in (("location.lat", "lat", -90, 90),
                              ("location.lon", "lon", -180, 180)):
        v = get_path(card, path)
        if v is None or v == "":
            continue
        try:
            if not lo <= float(v) <= hi:
                fail(path, key)
        except (TypeError, ValueError):
            fail(path, key)

    added_on = get_path(card, "provenance.added_on")
    if added_on and not DATE_RE.match(str(added_on)):
        rep.errors.append({"path": "provenance.added_on",
                           "message": "must be YYYY-MM-DD" if i == 0 else
                                      "doit être au format AAAA-MM-JJ"})

    # Warnings: things a maintainer will ask about, surfaced while the
    # contributor can still answer them.
    if mode == "add" and corpus and card.get("name"):
        near = _near_duplicates(card["name"], corpus)
        if near:
            names = ", ".join(f"{e['name']} (#{e['id']})" for e in near[:3])
            warn("name", (f"Des fiches proches existent déjà : {names}" if i else
                          f"Similar cards already exist: {names}"))
    if get_path(card, "provenance.confidence") == "low":
        warn("provenance.confidence",
             "Une confiance faible est acceptée ; dites en commentaire ce qui reste à vérifier."
             if i else
             "Low confidence is accepted; say in the comment what still needs checking.")
    if card.get("description") and str(card["description"]).strip().count("\n\n") > 2:
        warn("description", "Plus de deux paragraphes." if i else "More than two paragraphs.")
    return rep


def _near_duplicates(name: str, corpus: Any) -> list[dict[str, Any]]:
    """Cards whose name shares most of its distinctive words with a proposal.

    Deliberately strict. A loose rule fires on every lab with "grid" in its
    name, and a warning that always fires is one nobody reads.
    """
    want = {t for t in re.findall(r"[a-z0-9]+", fold(name)) if len(t) > 3}
    if not want:
        return []
    out = []
    for e in corpus.entities:
        have = {t for t in re.findall(r"[a-z0-9]+", fold(e["name"])) if len(t) > 3}
        if not have:
            continue
        shared = want & have
        smaller = min(len(want), len(have))
        if len(shared) >= smaller * 0.6 and (len(shared) >= 2 or smaller == 1):
            out.append(e)
    return out


# --- defaults ---------------------------------------------------------------

def slugify(name: str, taken: Iterable[str] = ()) -> str:
    """A stable slug for a name, not colliding with the corpus."""
    base = re.sub(r"[^a-z0-9]+", "-", fold(name)).strip("-")
    base = re.sub(r"-{2,}", "-", base)[:48].strip("-") or "entity"
    taken = set(taken)
    if base not in taken:
        return base
    n = 2
    while f"{base}-{n}" in taken:
        n += 1
    return f"{base}-{n}"


def tidy(card: dict[str, Any]) -> dict[str, Any]:
    """Clean up what a constrained model repeats.

    A grammar can bound an array's length but not its contents, so a draft can
    still arrive with the same focus area six times. The form would render six
    checkboxes' worth of nothing and the YAML would carry it upstream. Order is
    kept: the first mention is usually the considered one.
    """
    out: dict[str, Any] = {}
    for key, value in card.items():
        if isinstance(value, dict):
            out[key] = tidy(value)
        elif isinstance(value, list):
            seen: list[Any] = []
            for item in value:
                if isinstance(item, dict):
                    item = tidy(item)
                    if item and item not in seen:
                        seen.append(item)
                elif item not in ("", None) and item not in seen:
                    seen.append(item.strip() if isinstance(item, str) else item)
            out[key] = seen
        elif isinstance(value, str):
            out[key] = value.strip()
        else:
            out[key] = value
    return out


def fill_defaults(layer: str, card: dict[str, Any], corpus: Any,
                  reference: dict[str, Any] | None = None) -> dict[str, Any]:
    """Everything the proposal can know without asking.

    A local model is good at prose and bad at coordinates. So the slug, today's
    date, the reference URL and the city's latitude are computed here, and the
    form shows them as filled-in facts the contributor can correct rather than
    as blanks they have to research.
    """
    card = dict(card)
    if not card.get("id") and card.get("name"):
        card["id"] = slugify(card["name"], corpus.by_id if corpus else ())
    card.setdefault("status", "active")

    set_path(card, "provenance.added_on", _dt.date.today().isoformat())
    if reference and reference.get("url") and _blank(get_path(card, "provenance.source")):
        set_path(card, "provenance.source", reference["url"])
    if _blank(get_path(card, "provenance.confidence")):
        # The reference was fetched and corroborates the name, or it did not.
        set_path(card, "provenance.confidence",
                 "medium" if (reference or {}).get("confirms") else "low")

    homepage_path = "homepage" if layer == "project" else "links.homepage"
    if reference and reference.get("url") and _blank(get_path(card, homepage_path)):
        set_path(card, homepage_path, reference["url"])

    city = get_path(card, "location.city")
    country = get_path(card, "location.country")
    if city and country and corpus is not None:
        known = corpus.cities().get((fold(city), str(country).upper()))
        if known:
            if _blank(get_path(card, "location.lat")):
                set_path(card, "location.lat", known[0])
            if _blank(get_path(card, "location.lon")):
                set_path(card, "location.lon", known[1])
    return card


def current_values(layer: str, entity: dict[str, Any]) -> dict[str, Any]:
    """An entity on the map, read back in upstream field names.

    The page's payload is a lossy projection of the YAML — enough to show a
    card, not enough to rebuild the file. What it does carry is exactly what a
    reader can see and therefore what they can tell us is wrong, so a
    correction starts from these values and says so.
    """
    out: dict[str, Any] = {"id": entity.get("id"), "name": entity.get("name")}
    for key, path in (("status", "status"), ("tier", "tier"), ("desc", "description"),
                      ("desc_fr", "description_fr"), ("focus", "focus_areas"),
                      ("city", "location.city"), ("country", "location.country"),
                      ("lat", "location.lat"), ("lon", "location.lon")):
        value = entity.get(key)
        if not _blank(value):
            set_path(out, path, value)
    if entity.get("url"):
        set_path(out, "homepage" if layer == "project" else "links.homepage", entity["url"])
    if layer != "team" and entity.get("kind") in sum((list(v) for v in KINDS.values()), []):
        out["kind"] = entity["kind"]
    tl = entity.get("timeline") or {}
    for key in ("start", "end"):
        if tl.get(key):
            set_path(out, f"timeline.{key}", tl[key])
    for src, dst in (("affiliation", "affiliation"), ("issuer", "issuing_body"),
                     ("maintainer", "maintainer")):
        org = entity.get(src) or {}
        if isinstance(org, dict) and org.get("org"):
            set_path(out, f"{dst}.org", org["org"])
            if org.get("url"):
                set_path(out, f"{dst}.url", org["url"])
    if entity.get("consortium"):
        out["consortium"] = [
            {k: m[k] for k in ("org", "role", "country") if m.get(k)}
            for m in entity["consortium"]
        ]
    prov = entity.get("prov") or {}
    for key, path in (("by", "provenance.added_by"), ("on", "provenance.added_on"),
                      ("src", "provenance.source"), ("conf", "provenance.confidence")):
        if prov.get(key):
            set_path(out, path, prov[key])
    return out


def diff(before: dict[str, Any], after: dict[str, Any], layer: str) -> list[dict[str, Any]]:
    """The fields a correction actually changes, in form order."""
    rows = []
    for f in _spec(layer):
        was, now = get_path(before, f.path), get_path(after, f.path)
        if _blank(now) or was == now:
            continue
        rows.append({"path": f.path, "before": was, "after": now})
    return rows


# --- YAML -------------------------------------------------------------------

# A scalar that can be written without quotes: starts with a letter or digit,
# and contains nothing YAML reads as structure. `: ` is the one that bites —
# "Lab: the sequel" unquoted is a nested mapping, and the file stops parsing.
_PLAIN_RE = re.compile(r"^[A-Za-z0-9][\w .,;+&/()'’–—-]*$")

# Upstream key order, so a generated file reads like a hand-written one and a
# diff against the template stays short. The last three are the keys of a
# consortium or contact row, where `org` first is what makes the list readable.
_ORDER = ("id", "name", "type", "kind", "status", "tier", "jurisdiction", "license",
          "legal_status", "adoption_date", "location", "affiliation", "issuing_body",
          "maintainer", "operator", "access_model", "repository_url", "size_indicator",
          "homepage", "focus_areas", "domains", "infrastructure", "project_ids",
          "framework_ids", "commons_ids", "infrastructure_ids", "related_initiative_ids",
          "related_project_ids", "consortium", "demonstrators", "deliverables", "contact",
          "links", "funding", "timeline", "description", "provenance",
          # Keys of the nested mappings, in the order the upstream templates
          # write them: a consortium row reads org/role/country, a location
          # reads country/city/lat/lon.
          "org", "role", "country", "city", "lat", "lon", "campus_id")


def _scalar(value: Any) -> str:
    if value is None:
        return "~"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return repr(value)
    text = str(value)
    if text == "":
        return '""'
    if _PLAIN_RE.match(text) and not text.endswith(":") and "  " not in text:
        return text
    return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _emit(value: Any, indent: int, out: list[str]) -> None:
    pad = " " * indent
    if isinstance(value, dict):
        for key in sorted(value, key=lambda k: (_ORDER.index(k) if k in _ORDER else 99, k)):
            item = value[key]
            if isinstance(item, dict) and item:
                out.append(f"{pad}{key}:")
                _emit(item, indent + 2, out)
            elif isinstance(item, list):
                if not item:
                    out.append(f"{pad}{key}: []")
                else:
                    out.append(f"{pad}{key}:")
                    _emit(item, indent + 2, out)
            elif isinstance(item, str) and ("\n" in item or len(item) > 110):
                out.append(f"{pad}{key}: |")
                for line in item.strip().splitlines():
                    out.append(f"{pad}  {line.rstrip()}" if line.strip() else "")
            else:
                out.append(f"{pad}{key}: {_scalar(item)}")
    elif isinstance(value, list):
        for item in value:
            if isinstance(item, dict):
                inner: list[str] = []
                _emit(item, indent + 2, inner)
                first, *rest = inner
                out.append(f"{pad}- {first.strip()}")
                out.extend(rest)
            else:
                out.append(f"{pad}- {_scalar(item)}")
    else:
        out.append(f"{pad}{_scalar(value)}")


def to_yaml(card: dict[str, Any], layer: str) -> str:
    """The card as the YAML file it would become upstream.

    Hand-written rather than via PyYAML: the shapes are known and shallow, the
    key order is the template's, and the chat server stays dependency-free —
    the same bargain the rest of this repository makes.
    """
    body = {k: v for k, v in card.items() if not _blank(v) and k != "description_fr"}
    lines: list[str] = []
    _emit(body, 0, lines)
    return "\n".join(lines).rstrip() + "\n"
