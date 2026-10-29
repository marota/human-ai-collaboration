#!/usr/bin/env python3
"""Generate assets/map/hai-data.js from the curated YAML of eu-hai-collab-map.

The map's six YAML layers (teams, projects, clusters, frameworks, commons,
infrastructure), edges.yml and organisations.yml are the source of truth. They
live in the companion repository:

    https://github.com/marota/eu-hai-collab-map

This script reads them directly and emits the JS payload the map page loads,
keeping every field the cards can show — focus areas, consortium, funding,
timelines, licences, issuing bodies, infrastructure metadata, provenance —
rather than the fourteen-field, 300-character-truncated flattening the legacy
`sync_html_map.py` produced for the standalone HTML map.

Usage (from the repo root):

    python3 scripts/build-map-data.py --source ../eu-hai-collab-map

The source path may also come from $EU_HAI_MAP_REPO; failing both, a handful of
usual checkout locations are probed.

Notes
-----
- Entities without lat/lon (international standards — ISO, IEC, IEEE, SAE — and
  one non-European commons) are kept, with `geo: false`. They carry no marker;
  the page lists them separately so they stay searchable and readable.
- The infrastructure layer has no markers of its own, by design: an entry that
  mirrors a team of the same id enriches that team's card, and the rest are
  rendered as team markers. Either way the infrastructure metadata travels with
  the entity, so cards can show operator, access model and capacity.
- Marker colour and the domain filters are derived exactly as the legacy script
  derived them, so regenerating does not move or recolour anything.
- A project or a cluster is linked to a team card either at unit level (the
  unit itself takes part) or at organisation level (its organisation takes
  part through a unit with no card). The map draws one line per organisation:
  when several cards of the same organisation (data/organisations.yml) are
  linked to the same project, all but one carry `via`, the card whose line
  they share.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

try:
    import yaml
except ModuleNotFoundError:  # pragma: no cover - dependency hint
    sys.exit("PyYAML is required: python3 -m pip install pyyaml")

REPO = Path(__file__).resolve().parent.parent
DEFAULT_OUT = REPO / "assets" / "map" / "hai-data.js"

CANDIDATE_SOURCES = [
    REPO.parent / "eu-hai-collab-map",
    REPO.parent / "Map_Human_AI_Collaboration",
    Path.home() / "Documents" / "Claude" / "Projects" / "Map_Human_AI_Collaboration",
]

# --- legacy derivations, kept byte-identical so markers do not move ----------

# YAML domain -> short sector code used for marker colour and domain filters
SECTOR = {
    "energy": "energy", "power_grid": "energy", "nuclear": "nuclear",
    "aviation": "aviation", "rail": "rail", "transport": "transport",
    "maritime": "maritime", "telecom": "telecom", "water": "utility",
    "gas": "utility", "healthcare": "health", "manufacturing": "manufacturing",
    "defense": "defense", "critical_infrastructure": "multi",
}
# YAML focus_area -> "research focus" code. Deliberately lossy: it exists only
# to drive the filter checkboxes. The card reads `focus` (the raw list) instead.
APPROACH = {
    "human_factors": "hf", "human_computer_partnerships": "hf",
    "explainability": "xai", "trust_calibration": "xai", "oversight": "xai",
    "uncertainty_communication": "xai", "mixed_initiative": "multi",
    "shared_situational_awareness": "multi", "cobots": "manufacturing",
    # digital_twins is intentionally NOT mapped to 'simulation': the
    # compute/cluster/simulation codes are infrastructure categories and must
    # come only from the infrastructure layer, never from focus_areas.
    "reinforcement_learning_ops": "multi",
    "process_industry": "manufacturing", "power_grid": "energy",
    "energy_markets": "energy", "transport_ops": "transport",
    "healthcare_ops": "health", "defense": "defense",
}
INFRA_KIND = {
    "compute_cluster": "compute", "cloud_platform": "cluster",
    "governance_body": "cluster", "testbed": "simulation", "hosting": "compute",
}

# --- vocabulary labels shipped to the page (EN / FR) -------------------------

TAXO = {
    "focus": {
        "decision_support": ("Decision support", "Aide à la décision"),
        "mixed_initiative": ("Mixed initiative", "Initiative partagée"),
        "oversight": ("Human oversight", "Supervision humaine"),
        "explainability": ("Explainability", "Explicabilité"),
        "uncertainty_communication": ("Uncertainty communication", "Communication de l'incertitude"),
        "trust_calibration": ("Trust calibration", "Calibration de la confiance"),
        "shared_situational_awareness": ("Shared situational awareness", "Conscience de situation partagée"),
        "human_factors": ("Human factors", "Facteurs humains"),
        "human_computer_partnerships": ("Human–computer partnerships", "Partenariats humain–machine"),
        "cobots": ("Cobots", "Cobots"),
        "digital_twins": ("Digital twins", "Jumeaux numériques"),
        "reinforcement_learning_ops": ("RL for operations", "Apprentissage par renforcement en conduite"),
        "process_industry": ("Process industry", "Industrie de procédés"),
        "power_grid": ("Power grid", "Réseau électrique"),
        "energy_markets": ("Energy markets", "Marchés de l'énergie"),
        "manufacturing": ("Manufacturing", "Manufacturing"),
        "transport_ops": ("Transport operations", "Conduite transport"),
        "healthcare_ops": ("Healthcare operations", "Opérations hospitalières"),
        "defense": ("Defence", "Défense"),
    },
    "type": {  # teams
        "research_lab": ("Research lab", "Laboratoire de recherche"),
        "industrial_rd": ("Industrial R&D", "R&D industrielle"),
        "applied_project": ("Applied project", "Projet appliqué"),
        "infrastructure": ("Infrastructure", "Infrastructure"),
        "network": ("Network", "Réseau"),
    },
    "kind": {  # projects, clusters, frameworks, commons, infrastructure — one flat table
        "horizon_europe": ("Horizon Europe", "Horizon Europe"),
        "horizon_2020": ("Horizon 2020", "Horizon 2020"),
        "eu_other": ("Other EU programme", "Autre programme européen"),
        "national_grant": ("National programme", "Programme national"),
        "industrial_consortium": ("Industrial consortium", "Consortium industriel"),
        "internal": ("Internal programme", "Programme interne"),
        "other": ("Other", "Autre"),
        "regulation": ("Regulation", "Réglementation"),
        "standard": ("Standard", "Norme"),
        "guideline": ("Guideline", "Guide méthodologique"),
        "policy": ("Policy", "Politique publique"),
        "code_of_conduct": ("Code of conduct", "Code de conduite"),
        "dataset": ("Dataset", "Jeu de données"),
        "benchmark": ("Benchmark", "Benchmark"),
        "model": ("Model", "Modèle"),
        "software": ("Software", "Logiciel"),
        "community": ("Community", "Communauté"),
        "association": ("Association", "Association"),
        "network": ("Network", "Réseau"),
        "project_cluster": ("Project cluster", "Cluster de projets"),
        "compute_cluster": ("Compute cluster", "Calculateur"),
        "cloud_platform": ("Cloud platform", "Plateforme cloud"),
        "hosting": ("Hosting", "Hébergement"),
        "testbed": ("Testbed", "Banc d'essai"),
        "governance_body": ("Governance body", "Instance de gouvernance"),
    },
    "status": {
        "active": ("Active", "En cours"),
        "concluded": ("Concluded", "Terminé"),
        "planned": ("Planned", "Prévu"),
    },
    "tier": {
        "core": ("Core", "Cœur"),
        "ecosystem": ("Ecosystem", "Écosystème"),
    },
    "access": {
        "open": ("Open access", "Accès ouvert"),
        "gated": ("On request", "Accès sur demande"),
        "closed": ("Closed", "Fermé"),
    },
    "legal": {
        "in_force": ("In force", "En vigueur"),
        "proposed": ("Proposed", "Proposé"),
        "draft": ("Draft", "Projet"),
        "repealed": ("Repealed", "Abrogé"),
    },
    "role": {
        "coordinator": ("Coordinator", "Coordinateur"),
        "partner": ("Partner", "Partenaire"),
        "third_party": ("Linked third party", "Tiers lié"),
        "observer": ("Observer", "Observateur"),
        "founder": ("Founder", "Fondateur"),
        "member": ("Member", "Membre"),
        "operator": ("Operator", "Opérateur"),
        "funder": ("Funder", "Financeur"),
    },
    "jurisdiction": {
        "EU": ("European Union", "Union européenne"),
        "international": ("International", "International"),
        # No "global": it was never in the vocabulary the framework schema
        # documents (a country code, EU, or international), and the data
        # repository now enforces that from its controlled vocabulary, so no
        # entity can carry it. A label here would be unreachable.
    },
    "confidence": {
        "high": ("high", "élevée"),
        "medium": ("medium", "moyenne"),
        "low": ("low", "faible"),
    },
}

LANGS = ("fr", "en")


# --- helpers ----------------------------------------------------------------


def norm_text(s) -> str:
    """Collapse wrapped lines, keep paragraph breaks, drop nothing."""
    s = (s or "").strip()
    if not s:
        return ""
    paras = [re.sub(r"\s+", " ", p).strip() for p in re.split(r"\n\s*\n", s)]
    return "\n\n".join(p for p in paras if p)


def clean(v):
    """Drop empty strings / lists / dicts / None, recursively."""
    if isinstance(v, dict):
        out = {k: clean(x) for k, x in v.items()}
        out = {k: x for k, x in out.items() if x not in (None, "", [], {})}
        return out
    if isinstance(v, list):
        out = [clean(x) for x in v]
        return [x for x in out if x not in (None, "", [], {})]
    if isinstance(v, str):
        return v.strip()
    return v


def load_layer(root: Path, layer: str) -> list[dict]:
    out = []
    for f in sorted((root / "data" / layer).glob("*.yml")):
        if f.name.startswith("_"):
            continue
        d = yaml.safe_load(f.read_text(encoding="utf-8"))
        if isinstance(d, dict) and d.get("id"):
            out.append(d)
    return out


def load_organisations(root: Path) -> dict[str, dict]:
    """Team id -> its organisation {id, name, url}, from data/organisations.yml.

    A card that is not listed there is its own organisation.
    """
    f = root / "data" / "organisations.yml"
    out: dict[str, dict] = {}
    if not f.exists():
        return out
    for o in yaml.safe_load(f.read_text(encoding="utf-8")) or []:
        org = clean({"id": o.get("id"), "name": o.get("name"), "url": o.get("url")})
        for tid in o.get("teams") or []:
            out[tid] = org
    return out


def load_descriptions(root: Path) -> dict:
    out = {lang: {} for lang in LANGS}
    for lang in LANGS:
        f = root / "data" / "i18n" / f"descriptions.{lang}.yml"
        if f.exists():
            data = yaml.safe_load(f.read_text(encoding="utf-8")) or {}
            out[lang] = {k: norm_text(v) for k, v in data.items() if v}
    return out


def loc(d: dict) -> dict:
    return d.get("location") or {}


def homepage(d: dict) -> str:
    return (
        d.get("homepage")
        or (d.get("links") or {}).get("homepage")
        or (d.get("operator") or {}).get("url")
        or (d.get("issuing_body") or {}).get("url")
        or (d.get("maintainer") or {}).get("url")
        or ""
    )


def sectors(d: dict) -> list[str]:
    return [s for s in (SECTOR.get(x) for x in (d.get("domains") or [])) if s]


def approaches(d: dict) -> list[str]:
    return [a for a in (APPROACH.get(x) for x in (d.get("focus_areas") or [])) if a]


def domain_list(sec, app, lead) -> list[str]:
    seen: list[str] = []
    for x in ([lead] if lead else []) + sec + app:
        if x and x not in seen:
            seen.append(x)
    return seen or ["multi"]


def primary(sec, lead, fallback: str = "multi") -> str:
    """The lead domain: edge colours read it. With no lead and no sector, the
    entity's own first domain (a research axis) rather than the catch-all, so its
    lines wear the colour of its marker."""
    if lead:
        return lead
    for x in sec:
        if x != "multi":
            return x
    return sec[0] if sec else fallback


# The dating pass recorded, in provenance.source, how solid each start year is:
#   "timeline.start (high|medium|low): <evidence>"
# A later review appends its own note; the last one is the current judgement.
# A note admitting the sub-unit's own date was not found means the year belongs
# to the host institution, not to the work the entry describes — the map must be
# able to say so rather than drawing it as a firm date.
DATE_NOTE = re.compile(r"timeline\.start \((high|medium|low)\): (.*?)(?= \| | · timeline\.start |$)", re.S)
# "X founded 1949; the HMT department's date not found" — the year is the host's,
# and says nothing about when the work described actually began. Distinct from
# "Estimate: MAHALO started 2020", which *is* an estimate of this entry's start.
HOST_YEAR = re.compile(r"date not (?:found|published)|not found\b|own (?:date|start)[^.;|]*unknown"
                       r"|no start date was found|not given on|no founding year|no source dates"
                       r"|no (?:creation |founding )?date (?:was )?found|no (?:start )?date of its own", re.I)


def date_quality(d: dict) -> dict:
    src = (d.get("provenance") or {}).get("source") or ""
    notes = list(DATE_NOTE.finditer(src))
    if not notes:
        return {}
    m = notes[-1]
    conf, note = m.group(1), m.group(2).strip()
    out = {"dateConf": conf}
    if conf in ("medium", "low") and HOST_YEAR.search(note):
        out["dateHost"] = True          # the year is the host institution's
    return out


def timeline_of(d: dict) -> dict:
    tl = d.get("timeline") or {}
    out = {
        "start": str(tl["start"]) if tl.get("start") else "",
        "end": str(tl["end"]) if tl.get("end") else "",
        "milestones": [
            {"date": str(m.get("date") or ""), "label": (m.get("label") or "").strip()}
            for m in (tl.get("milestones") or [])
            if (m or {}).get("label")
        ],
    }
    return clean(out)


def when_of(tl: dict) -> str:
    """The compact 'start–end' string the marker tooltip and print sheet use."""
    start, end = tl.get("start", ""), tl.get("end", "")
    if not start and not end:
        return ""
    return f"{start}–{end}" if end else f"{start}–"


def prov_of(d: dict) -> dict:
    p = d.get("provenance") or {}
    return clean({
        "by": p.get("added_by"), "on": str(p.get("added_on") or ""),
        "upd": str(p.get("last_updated") or ""),
        "src": p.get("source"), "conf": p.get("confidence"),
    })


def links_of(d: dict) -> dict:
    l = d.get("links") or {}
    return clean({
        "papers": [p for p in (l.get("papers") or []) if p],
        "linkedin": l.get("linkedin"), "twitter": l.get("twitter"),
        "docs": l.get("docs"), "official": l.get("official_text"),
    })


def base_entry(d: dict, descs: dict, lead: str | None = None) -> dict:
    l = loc(d)
    sec, app = sectors(d), approaches(d)
    doms = domain_list(sec, app, lead)
    lat, lon = l.get("lat"), l.get("lon")
    e = {
        "id": d["id"], "name": d.get("name", ""),
        "city": l.get("city") or "", "country": l.get("country") or "",
        "lat": lat, "lon": lon,
        "domain": primary(sec, lead, doms[0]), "domains": doms,
        "url": homepage(d),
        "desc": norm_text(d.get("description")),
        "focus": list(d.get("focus_areas") or []),
        "status": d.get("status") or "",
        "tier": d.get("tier") or "",
        "prov": prov_of(d),
    }
    if lat is None or lon is None:
        e["geo"] = False
    for lang in LANGS:
        txt = descs.get(lang, {}).get(d["id"])
        if txt:
            e[f"desc_{lang}"] = txt
    tl = timeline_of(d)
    if tl:
        e["timeline"] = tl
        e.update(date_quality(d))
    lk = links_of(d)
    if lk:
        e["links"] = lk
    return e


def build(root: Path):
    descs = load_descriptions(root)
    teams = load_layer(root, "teams")
    projects = load_layer(root, "projects")
    infra = load_layer(root, "infrastructure")
    frameworks = load_layer(root, "frameworks")
    commons = load_layer(root, "commons")
    clusters = load_layer(root, "clusters")
    org_of = load_organisations(root)

    # ---- teams (+ infrastructure, which has no markers of its own) ----
    TEAMS = []
    for d in teams:
        e = base_entry(d, descs)
        e["type"] = d.get("type") or ""
        aff = clean({
            "org": (d.get("affiliation") or {}).get("org"),
            "parent": (d.get("affiliation") or {}).get("parent"),
            "url": (d.get("affiliation") or {}).get("url"),
        })
        if aff:
            e["affiliation"] = aff
        if d["id"] in org_of:
            e["organisation"] = org_of[d["id"]]
        if d.get("infrastructure"):
            e["facilities"] = list(d["infrastructure"])
        TEAMS.append(e)
    by_team = {e["id"]: e for e in TEAMS}

    def infra_block(d: dict) -> dict:
        return clean({
            "kind": d.get("kind"),
            "operator": clean({
                "org": (d.get("operator") or {}).get("org"),
                "url": (d.get("operator") or {}).get("url"),
            }),
            "access": d.get("access_model"),
            "capacity": d.get("capacity_indicator"),
            "hosts": list(d.get("related_initiative_ids") or []),
        })

    for d in infra:
        lead = INFRA_KIND.get(d.get("kind"), "simulation")
        block = infra_block(d)
        if d["id"] in by_team:
            # Same entity as a team: enrich its card, keep one marker.
            t = by_team[d["id"]]
            if lead not in t["domains"]:
                t["domains"].append(lead)
            t["infra"] = block
            if not t.get("desc") and norm_text(d.get("description")):
                t["desc"] = norm_text(d.get("description"))
            continue
        e = base_entry(d, descs, lead=lead)
        e["type"] = "infrastructure"
        e["infra"] = block
        TEAMS.append(e)
        by_team[e["id"]] = e

    team_ids = set(by_team)

    # ---- projects ----
    PROJECTS = []
    for d in projects:
        e = base_entry(d, descs)
        e["kind"] = d.get("kind") or ""
        e["when"] = when_of(e.get("timeline") or {})
        fn = d.get("funding") or {}
        e["budget"] = fn.get("grant") or fn.get("source") or ""  # legacy meta line
        funding = clean({
            "source": fn.get("source"), "call": fn.get("call"),
            "grant": fn.get("grant"), "eur": fn.get("budget_eur"), "url": fn.get("url"),
        })
        if funding:
            e["funding"] = funding
        cons = []
        for c in d.get("consortium") or []:
            if not (c or {}).get("org"):
                continue
            cons.append(clean({
                "org": c.get("org"), "role": c.get("role"),
                "country": c.get("country"), "ref": c.get("initiative_id"),
            }))
        if cons:
            e["consortium"] = cons
        demos = [clean({"label": x.get("label"), "url": x.get("url")})
                 for x in (d.get("demonstrators") or []) if (x or {}).get("label")]
        if demos:
            e["demos"] = demos
        delivs = [clean({"title": x.get("title"), "url": x.get("url"), "date": str(x.get("date") or "")})
                  for x in (d.get("deliverables") or []) if (x or {}).get("title")]
        if delivs:
            e["delivs"] = delivs
        PROJECTS.append(e)
    project_ids = {e["id"] for e in PROJECTS}

    # ---- clusters: associations, networks, clusters of projects ----
    CLUSTERS = []
    for d in clusters:
        e = base_entry(d, descs)
        e["kind"] = d.get("kind") or ""
        e["size"] = d.get("size_indicator") or ""
        members = [clean({"org": m.get("org"), "role": m.get("role"),
                          "country": m.get("country"), "ref": m.get("initiative_id")})
                   for m in d.get("members") or [] if (m or {}).get("org")]
        if members:
            e["members"] = members
        CLUSTERS.append(e)
    cluster_ids = {e["id"] for e in CLUSTERS}
    anchors_tp = team_ids | project_ids | cluster_ids

    # ---- commons ----
    COMMONS = []
    for d in commons:
        e = base_entry(d, descs)
        e["kind"] = d.get("kind") or "software"
        e["subSection"] = e["kind"]          # legacy alias
        e["license"] = d.get("license") or ""
        maint = clean({
            "org": (d.get("maintainer") or {}).get("org"),
            "url": (d.get("maintainer") or {}).get("url"),
        })
        if maint:
            e["maintainer"] = maint
        e["repo"] = d.get("repository_url") or ""
        e["size"] = d.get("size_indicator") or ""
        e["createdBy"] = [x for x in (d.get("related_initiative_ids") or []) if x in anchors_tp]
        e["usedBy"] = [x for x in (d.get("related_project_ids") or []) if x in anchors_tp]
        COMMONS.append(e)
    commons_ids = {e["id"] for e in COMMONS}
    anchors = anchors_tp | commons_ids

    # reverse index: framework / commons usage declared on teams and projects
    used_by: dict[str, set] = {}
    for d in teams + projects + clusters:
        for fid in (d.get("framework_ids") or []) + (d.get("commons_ids") or []):
            used_by.setdefault(fid, set()).add(d["id"])

    # ---- frameworks ----
    FRAMEWORKS = []
    for d in frameworks:
        e = base_entry(d, descs)
        e["kind"] = d.get("kind") or "guideline"
        e["subSection"] = e["kind"]          # legacy alias
        e["jurisdiction"] = d.get("jurisdiction") or ""
        issuer = clean({
            "org": (d.get("issuing_body") or {}).get("org"),
            "url": (d.get("issuing_body") or {}).get("url"),
        })
        if issuer:
            e["issuer"] = issuer
        e["legal"] = d.get("legal_status") or ""
        e["adopted"] = str(d.get("adoption_date") or "")
        if d.get("applies_to"):
            e["appliesTo"] = list(d["applies_to"])
        if d.get("references"):
            e["refs"] = list(d["references"])
        e["createdBy"] = []
        e["usedBy"] = sorted(x for x in used_by.get(d["id"], set()) if x in anchors)
        FRAMEWORKS.append(e)

    for e in COMMONS:
        extra = sorted(x for x in used_by.get(e["id"], set())
                       if x in anchors and x not in e["usedBy"])
        e["usedBy"] = e["usedBy"] + extra

    # ---- infrastructure back-references: which teams host which facility ----
    for e in TEAMS:
        for host in (e.get("infra") or {}).get("hosts", []):
            if host in by_team and host != e["id"]:
                by_team[host].setdefault("facilities", [])
                if e["name"] not in by_team[host]["facilities"]:
                    by_team[host]["facilities"].append(e["name"])

    # ---- edges: project or cluster -> team, at unit or organisation level ----
    # A project may also end on a cluster: an association that is itself a
    # partner, such as the Flatland Association in AI4REALNET.
    EDGES = []
    raw = yaml.safe_load((root / "data" / "edges.yml").read_text(encoding="utf-8")) or []
    sources = {"project": project_ids, "cluster": cluster_ids}
    ends = {"project": team_ids | cluster_ids, "cluster": team_ids}
    # How firmly the source's own partner list names a card: its coordinator
    # (0), any other row (1), not at all (2).
    named: dict[str, dict[str, int]] = {}
    for e in PROJECTS:
        for c in e.get("consortium", []):
            if c.get("ref"):
                rank = 0 if c.get("role") == "coordinator" else 1
                named.setdefault(e["id"], {})[c["ref"]] = min(
                    rank, named.get(e["id"], {}).get(c["ref"], rank))
    for e in CLUSTERS:
        for m in e.get("members", []):
            if m.get("ref"):
                named.setdefault(e["id"], {}).setdefault(m["ref"], 1)
    groups: dict[tuple, list[dict]] = {}
    for ed in raw:
        if not isinstance(ed, dict):
            continue
        kind = next((k for k in sources if ed.get(k)), None)
        if not kind or ed[kind] not in sources[kind] or ed.get("team") not in ends[kind]:
            continue
        src, tid = ed[kind], ed["team"]
        out = {kind: src, "team": tid}
        if ed.get("level") == "organisation":
            out["org"] = True
        EDGES.append(out)
        org = (org_of.get(tid) or {}).get("id") or tid
        groups.setdefault((kind, src, org), []).append(out)
    # One line per organisation: a unit that takes part itself keeps it before
    # a card standing in for its organisation, then the card the partner list
    # names (its coordinator first), then file order. The others share it.
    for (kind, src, _), same in groups.items():
        if len(same) < 2:
            continue
        order = sorted(range(len(same)), key=lambda i: (
            bool(same[i].get("org")), named.get(src, {}).get(same[i]["team"], 2), i))
        for i in order[1:]:
            same[i]["via"] = same[order[0]]["team"]

    # ---- consortium and member refs that resolve to a real card ----
    for e in PROJECTS + CLUSTERS:
        for c in e.get("consortium", []) + e.get("members", []):
            if c.get("ref") and c["ref"] not in anchors:
                c.pop("ref", None)

    layers = {"PROJECTS": PROJECTS, "CLUSTERS": CLUSTERS, "COMMONS": COMMONS,
              "TEAMS": TEAMS, "FRAMEWORKS": FRAMEWORKS, "EDGES": EDGES}
    return {k: [clean(o) if k != "EDGES" else o for o in v] for k, v in layers.items()}


def taxo_payload() -> dict:
    return {
        group: {key: {"en": en, "fr": fr} for key, (en, fr) in table.items()}
        for group, table in TAXO.items()
    }


def js_array(items: list[dict]) -> str:
    return "\n".join("  " + json.dumps(o, ensure_ascii=False) + "," for o in items)


def data_as_of(data: dict) -> str:
    """The most recent provenance touch across every entity — a freshness date
    derived entirely from the data, not from wall-clock generation time. Using
    `date.today()` here would put a changing timestamp in a generated file and
    break the "no-op regeneration produces an empty diff" invariant; this only
    moves when an entity's own last_updated/added_on actually does.
    """
    dates: list[str] = []
    for layer in ("PROJECTS", "CLUSTERS", "COMMONS", "TEAMS", "FRAMEWORKS"):
        for o in data.get(layer, []):
            prov = o.get("prov") or {}
            dates += [d for d in (prov.get("upd"), prov.get("on")) if d]
    return max(dates) if dates else ""


def render(data: dict, source: Path) -> str:
    head = (
        "// GENERATED FILE — do not edit by hand.\n"
        "// Built by scripts/build-map-data.py from the YAML layers of\n"
        "// https://github.com/marota/eu-hai-collab-map (data/ is the source of truth).\n"
        "// Regenerate with:  python3 scripts/build-map-data.py --source <path-to-that-repo>\n"
        "// Code MIT · data CC BY 4.0.\n\n"
    )
    body = "".join(
        f"const {name} = [\n{js_array(data.get(name, []))}\n];\n\n"
        for name in ("PROJECTS", "CLUSTERS", "COMMONS", "TEAMS", "FRAMEWORKS", "EDGES")
    )
    taxo = "const TAXO = " + json.dumps(taxo_payload(), ensure_ascii=False, indent=1) + ";\n\n"
    as_of = "const AS_OF = " + json.dumps(data_as_of(data)) + ";\n\n"
    tail = "window.HAI_DATA = { PROJECTS, CLUSTERS, COMMONS, TEAMS, FRAMEWORKS, EDGES, TAXO, AS_OF };\n"
    return head + body + taxo + as_of + tail


def resolve_source(arg: str | None) -> Path:
    for cand in ([Path(arg).expanduser()] if arg else []) + \
                ([Path(os.environ["EU_HAI_MAP_REPO"]).expanduser()]
                 if os.environ.get("EU_HAI_MAP_REPO") else []) + \
                CANDIDATE_SOURCES:
        if (cand / "data" / "edges.yml").exists():
            return cand.resolve()
    sys.exit(
        "Could not find the eu-hai-collab-map checkout.\n"
        "Pass --source <path>, set $EU_HAI_MAP_REPO, or clone it next to this repo:\n"
        "  git clone https://github.com/marota/eu-hai-collab-map.git ../eu-hai-collab-map"
    )


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--source", help="path to the eu-hai-collab-map checkout")
    ap.add_argument("--out", default=str(DEFAULT_OUT), help="output JS file")
    args = ap.parse_args()

    root = resolve_source(args.source)
    data = build(root)
    out = Path(args.out)
    out.write_text(render(data, root), encoding="utf-8")

    geoless = [o["id"] for k in ("PROJECTS", "CLUSTERS", "COMMONS", "TEAMS", "FRAMEWORKS")
               for o in data[k] if o.get("geo") is False]
    longest = max((len(o.get("desc_en") or o.get("desc") or "")
                   for k in ("PROJECTS", "CLUSTERS", "COMMONS", "TEAMS", "FRAMEWORKS")
                   for o in data[k]), default=0)
    print(f"source  {root}")
    print(f"out     {out.relative_to(REPO) if out.is_relative_to(REPO) else out}"
          f"  ({out.stat().st_size / 1024:.0f} kB)")
    for name in ("PROJECTS", "CLUSTERS", "TEAMS", "COMMONS", "FRAMEWORKS", "EDGES"):
        print(f"  {name.lower():<11} {len(data[name])}")
    shared = sum(1 for e in data["EDGES"] if e.get("via"))
    print(f"  one line per organisation: {shared} links share another card's line")
    print(f"  no lat/lon  {len(geoless)}  ({', '.join(geoless)})")
    print(f"  longest description  {longest} chars (was capped at 300)")
    print(f"  as of  {data_as_of(data)}  (most recent provenance touch — caps the period filter)")


if __name__ == "__main__":
    main()
