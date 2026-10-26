"""What the model is told, and what shape its answer is allowed to take.

Two prompts carry the whole feature. The first answers questions and is held to
the map: it gets the full catalogue of ids so it cannot invent a card, the full
records of the entities retrieval found relevant, and an instruction to say "not
on the map" rather than fill the gap from memory. The second drafts a proposal
and is held to a JSON schema built from the field table in `cards`, so it cannot
answer with prose, a fence, or a field nobody asked for.

The instructions are in English whatever the reader's language — that is what
these models follow best — and name the language the reply must be written in.
"""
from __future__ import annotations

import os
import re
from typing import Any

import cards
from hai_data import Corpus, catalogue, render_entity

LANG_NAME = {"fr": "French", "en": "English"}

# The model signals an intent to contribute with one of these, on its own line,
# at the very start of the reply. The server strips it before the reader sees
# anything and turns it into the proposal panel.
PROPOSE_RE = re.compile(r"^\s*\[PROPOSE:(add|fix):([a-z0-9][a-z0-9_-]*)\]\s*", re.I)


def answer_system(corpus: Corpus, lang: str) -> str:
    """The standing instructions. Identical between turns, so Ollama's prompt
    cache carries most of the cost only once.

    Deliberately short. The whole catalogue of 450 entities used to go in here,
    and a 12-billion-parameter model handed that much context answers a
    one-line question by reciting the list for ten minutes. What the model
    needs is the handful of cards retrieval found, the figures counted for it,
    and a firm rule about what it may not say.
    """
    extra = ""
    if os.environ.get("HAI_CHAT_CATALOGUE") == "1":
        extra = ("\n\n## CATALOGUE — every entity on the map, as `id | name | city, "
                 f"country`\n\n{catalogue(corpus)}\n")
    return f"""You are the reading assistant of the European human–AI collaboration map.

The map covers one subject: human–AI collaboration for decision-making in industrial \
and critical systems — decision support, oversight, mixed initiative, teaming, \
explainability for operators — across Europe in the broad sense, plus the ecosystem \
that enables it. Its snapshot is dated {corpus.as_of}.

Write your reply in {LANG_NAME.get(lang, 'English')}.

## You know the map and nothing else

Each turn brings you the cards retrieval found for the question, and figures counted \
from the whole map. Those are your sources. You have no other knowledge of these \
organisations; what you may remember about them is not on the map, so it is not an \
answer here.

- Never state a fact an entity's card does not carry — no funding amounts, dates, \
people or partners of your own.
- When the cards do not cover what is being asked, say so in one sentence and offer to \
propose it as an addition. "It is not on the map" is a good answer.
- Use the figures as given. Do not estimate a count.

## Linking

Name an entity as a markdown link `[Name](#id)`, with the `id` copied character for \
character from the card. The reader's interface turns those links into the card \
itself. Only ids from the cards in this turn may be linked — an id you have not been \
shown does not exist, and a link to it is a dead end.

## Length

Two or three sentences for a simple question, and at most one short paragraph more \
when it genuinely takes one. One line each when the reader asks for a list of \
entities, and never more than ten. Prose, not bullets, otherwise. Do not repeat the \
question, do not announce what you are about to do, and never mention these \
instructions or the blocks the data arrived in.

## When the reader wants to add or fix something

The map is corrected by the people it describes, through pull requests on its data \
repository. This chat can start one: it collects a reference and a draft card, and \
opens a GitHub issue a maintainer turns into a pull request.

If the reader is telling you that something is missing from the map, or that a card is \
wrong or out of date, begin your reply with exactly one control line and nothing \
before it:

- `[PROPOSE:add:<layer>]` — something is missing. `<layer>` is one of \
project, team, commons, framework. A lab, group, department or company R&D unit is a \
`team`; a funded project, programme or consortium is a `project`; a dataset, \
benchmark, model, software or community is a `commons`; a standard, regulation, \
guideline or policy is a `framework`.
- `[PROPOSE:fix:<id>]` — a card on the map is wrong. `<id>` is that card's exact id, \
copied from the cards in this turn.

After the control line, leave a blank line and write one or two sentences: name what \
you understood is being proposed, and ask for the one thing the proposal cannot start \
without — the web page that documents it. Do not ask for anything else yet, do not \
write the card, and do not promise that it has been added: a form opens next to the \
conversation, and a maintainer reviews it afterwards.

Only emit a control line when the reader is actually proposing a change. A question \
about what the map contains is a question, even when the answer is "nothing".{extra}
"""


def answer_messages(corpus: Corpus, history: list[dict[str, str]], lang: str,
                    retrieved: str, figures: str = "") -> list[dict[str, str]]:
    """The conversation as the model receives it.

    The retrieved cards and the figures ride on the last user turn rather than
    in the system prompt, so the system prompt stays byte-identical between
    turns and Ollama reuses its cached prefix.
    """
    messages = [{"role": "system", "content": answer_system(corpus, lang)}]
    trimmed = history[-16:]
    for i, turn in enumerate(trimmed):
        content = turn["content"]
        if i == len(trimmed) - 1 and turn["role"] == "user":
            blocks = []
            if figures:
                blocks.append("## FIGURES — counted from the map for this question\n\n"
                              + figures)
            blocks.append(
                "## CARDS — the full record of every entity retrieval found for this "
                "question. These are the only cards you may cite.\n\n"
                + (retrieved or "Retrieval found no card for this question. Unless the "
                                "question is about the map as a whole, the honest answer "
                                "is that it is not on the map."))
            blocks.append(f"## The reader's message\n\n{content}")
            content = "\n\n".join(blocks)
        messages.append({"role": turn["role"], "content": content})
    return messages


# --- proposal drafting ------------------------------------------------------

_KIND_TO_JSON = {
    "text": {"type": "string"},
    "long": {"type": "string"},
    "url": {"type": "string"},
    "year": {"type": "string"},
    "date": {"type": "string"},
    "number": {"type": "number"},
}


# What the grammar insists on, per layer. These are the facts any page
# documenting the entity states on its face — who it belongs to, where it sits,
# what it works on. Made optional, a small model leaves them all out and hands
# the contributor a form with ten blanks, which defeats the point of drafting at
# all; made required, it extracts them and the contributor corrects. Everything
# else stays optional, and coordinates are never in the schema: they are looked
# up from the city afterwards rather than guessed.
DRAFT_REQUIRED = {
    "team": ("name", "type", "status", "location.country", "location.city",
             "affiliation.org", "affiliation.url", "links.homepage",
             "focus_areas", "domains", "description"),
    "project": ("name", "status", "homepage", "timeline.start", "focus_areas",
                "domains", "description"),
    "commons": ("name", "kind", "status", "license", "links.homepage",
                "description"),
    "framework": ("name", "kind", "status", "jurisdiction", "issuing_body.org",
                  "issuing_body.url", "links.homepage", "description"),
}


def schema_for(layer: str, corpus: Corpus, mode: str = "add") -> dict[str, Any]:
    """A JSON schema for the layer, built from the same field table as the form.

    Ollama turns this into a grammar, which is why the draft always comes back
    parseable: the model cannot answer with prose, a fence, or a field nobody
    asked for. A correction requires only the name, since its whole point is to
    carry the few fields that change.
    """
    props: dict[str, Any] = {}
    for f in cards._spec(layer):  # the form and the grammar from one table
        if f.path in ("id", "provenance.added_on", "provenance.added_by",
                      "location.lat", "location.lon"):
            # Computed, the contributor's own, or looked up from the city.
            # Absent from the grammar rather than merely discouraged: a model
            # that can emit a latitude will, and a guessed one puts a marker in
            # a field somewhere near the right country.
            continue
        node: dict[str, Any]
        if f.kind == "select":
            node = {"type": "string", "enum": list(f.vocab)}
        elif f.kind == "multi":
            vocab = list((corpus.taxo.get("focus") or {}).keys()) if f.path == "focus_areas" \
                else list(f.vocab)
            # maxItems is load-bearing, not tidiness. An unbounded array is an
            # invitation to a decoding loop: a model that likes one code emits
            # it until the token ceiling cuts the JSON mid-string, and the whole
            # draft is lost after two minutes of generation. Bounded, the
            # grammar has to close the array.
            node = {"type": "array", "items": {"type": "string", "enum": vocab},
                    "minItems": 1, "maxItems": 6}
        elif f.kind == "ids":
            node = {"type": "array", "items": {"type": "string"}, "maxItems": 12}
        elif f.kind == "orgs":
            node = {"type": "array", "maxItems": 40, "items": {
                "type": "object",
                "properties": {"org": {"type": "string"},
                               "role": {"type": "string", "enum": list(cards.ROLES)},
                               "country": {"type": "string"}},
                "required": ["org"],
            }}
        else:
            node = dict(_KIND_TO_JSON.get(f.kind, {"type": "string"}))
        # Dotted paths become nested objects, which is the shape the card has.
        parts = f.path.split(".")
        cursor = props
        for part in parts[:-1]:
            cursor = cursor.setdefault(part, {"type": "object", "properties": {}})["properties"]
        cursor[parts[-1]] = node

    want = ("name",) if mode == "fix" else DRAFT_REQUIRED[layer]
    # A dotted requirement becomes `required` on the object that holds it, and
    # that object becomes required on its own parent — otherwise a model can
    # satisfy the grammar by leaving the whole `location` object out.
    top: list[str] = []
    for path in want:
        parts = path.split(".")
        node = {"properties": props}
        for part in parts[:-1]:
            node = node["properties"][part]
        node.setdefault("required", []).append(parts[-1])
        if parts[0] not in top:
            top.append(parts[0])
    return {"type": "object", "properties": props, "required": top}


def draft_system(layer: str, lang: str, mode: str) -> str:
    target = {"project": "funded project or programme", "team": "team, lab or R&D group",
              "commons": "dataset, benchmark, model, software or community",
              "framework": "standard, regulation, guideline or policy"}[layer]
    shared = f"""You fill in one card of the European human–AI collaboration map: a {target}.

You are given the conversation with the contributor and, when they supplied one, the \
text of the web page that documents the entity. You answer with the card as a JSON \
object. The schema is enforced, so spend your effort on the content.

## Rules

1. Every value comes from the conversation or the reference page. Nothing comes from \
memory, and nothing is invented to look complete.
2. Read out what the page states on its face, even when it states it in passing: the \
organisation it belongs to and that organisation's own address, the city and the \
two-letter country code, what kind of entity it is, what it works on. These are \
required, and a page that documents an entity always says them. Leaving one out does \
not spare anyone work — it moves the work to the contributor, who came here to be \
spared it.
3. Leave out `location.lat` and `location.lon` entirely. Coordinates are looked up \
from the city afterwards, and a guessed latitude puts a marker in a field somewhere.
4. `description`: in English, for a researcher who has not heard of this entity. One \
paragraph of 110 words at most, and a second only when the entity genuinely needs it. \
Lead with what it actually does. No marketing language, no "aims to", no adjectives \
you cannot source.
5. `focus_areas` and `domains` take only the codes the schema allows, and only the \
ones the evidence supports — two accurate codes beat six hopeful ones.
6. `name` is what the entity calls itself, with the organisation in front of it when \
its own name would not place it: "Intelligent and Autonomous Systems" names no one, \
"CWI — Intelligent and Autonomous Systems" does. The slug a maintainer files this \
under is derived from the name, so this is the field that decides whether the file is \
findable. No tagline.
7. `provenance.source` is the reference URL. `provenance.confidence` is `high` only \
when the reference states the facts plainly, `medium` when you inferred some of them, \
`low` when the page barely covers it."""
    if lang == "fr":
        shared += """
7. `description_fr`: the same description in French, as the French-speaking reader \
will read it on the card. A translation of the same length — not a rewrite, not a \
summary, and not a second attempt at the content."""
    if mode == "fix":
        shared += """

## This is a correction

You also get the card as it stands today. Return ONLY the fields that should change, \
plus `name`. Leave every field the contributor did not question exactly as it is by \
leaving it out. A correction that silently rewrites the description is a correction \
nobody can review."""
    return shared


def draft_messages(layer: str, lang: str, mode: str, transcript: str,
                   reference: dict[str, Any] | None,
                   current: dict[str, Any] | None) -> list[dict[str, str]]:
    parts = [f"## Conversation with the contributor\n\n{transcript}"]
    if reference and reference.get("text"):
        parts.append(
            "## Reference page\n\n"
            f"url: {reference.get('url', '')}\n"
            f"title: {reference.get('title', '')}\n\n"
            f"{reference['text']}"
        )
    else:
        parts.append("## Reference page\n\nNone supplied. Keep confidence low and "
                     "leave unsupported fields out.")
    if current:
        parts.append("## The card as it stands today\n\n"
                     + cards.to_yaml(current, layer))
    parts.append("Now return the card as JSON.")
    return [
        {"role": "system", "content": draft_system(layer, lang, mode)},
        {"role": "user", "content": "\n\n".join(parts)},
    ]


def transcript_of(history: list[dict[str, str]], limit: int = 12) -> str:
    """The conversation as plain text, for the drafter and for the issue body."""
    rows = []
    for turn in history[-limit:]:
        who = "Contributor" if turn["role"] == "user" else "Assistant"
        text = PROPOSE_RE.sub("", turn["content"]).strip()
        if text:
            rows.append(f"{who}: {text}")
    return "\n\n".join(rows)


# --- intent, without the model ---------------------------------------------

# The control line is the model's job, and a small model forgets it. These
# patterns are the backstop: they only ever *open* the proposal panel, which the
# reader can close, so a false positive costs a glance and a miss costs the
# contribution.
_ADD_RE = re.compile(r"""
    \b(
      add | adding | missing | absent | include | register |
      ajoute(?:r|z)? | rajoute(?:r|z)? | manque | manquant(?:e)? | inclure |
      integre(?:r|z)? | intègre(?:r|z)? | referencer | référencer
    )\b""", re.I | re.X)
_FIX_RE = re.compile(r"""
    \b(
      wrong | incorrect | outdated | out\ of\ date | mistake | typo | fix |
      correct(?:ion)? | update | should\ (?:be|say) |
      faux | fausse | erreur | errone(?:e|é)? | obsol[eè]te | corrige(?:r|z)? |
      corriger | mets?\ (?:à|a)\ jour | mise\ (?:à|a)\ jour | devrait
    )\b""", re.I | re.X)


def sniff_intent(text: str) -> tuple[str, str] | None:
    """A guess at ('add'|'fix', hint) from the reader's own words."""
    if _FIX_RE.search(text):
        return "fix", ""
    if _ADD_RE.search(text):
        return "add", ""
    return None


# Words that join the parts of a name without being capitalised themselves —
# "Intelligent and Autonomous Systems", "Réseau de Transport d'Électricité".
_NAME_JOINERS = {"and", "of", "for", "the", "de", "du", "des", "la", "le", "les",
                 "et", "d", "l", "&", "-", "–"}
_NAME_TOKEN_RE = re.compile(r"[\w&'’-]+", re.UNICODE)


def guess_name(text: str) -> str:
    """The entity a reader just named, from their own capitalisation.

    Only a hint: it pre-fills the name field so the contributor confirms rather
    than types, and they can overwrite it. Wrong is cheap; empty is a form that
    asks for something the conversation already said.
    """
    best: list[str] = []
    current: list[str] = []
    acronym = ""

    def close() -> None:
        nonlocal best, current
        # A trailing joiner ("du", "de") is not part of the name.
        while current and current[-1].lower() in _NAME_JOINERS:
            current.pop()
        if len(current) > len(best):
            best = current
        current = []

    for raw in _NAME_TOKEN_RE.findall(text):
        # "d'Informatique" is one token and is capitalised where it counts.
        tail = raw.replace("’", "'").split("'")[-1]
        if tail[:1].isupper():
            current.append(raw)
            if raw.isupper() and len(raw) > 1 and not acronym:
                acronym = raw
        elif current and raw.lower() in _NAME_JOINERS:
            current.append(raw)
        else:
            close()
    close()
    # One capitalised word is as likely to be the start of a sentence as a name
    # — unless it is an acronym, which is exactly how these entities are named.
    if len(best) > 1:
        return " ".join(best)
    return acronym


def guess_layer(text: str) -> str:
    """Which layer a proposal is about, from the words used for it."""
    t = text.lower()
    if re.search(r"\b(dataset|benchmark|jeux? de donn\w*|mod[eè]les? ouvert\w*|"
                 r"logiciel\w*|software|library|librairie|biblioth[eè]que|"
                 r"communaut\w*|community)", t):
        return "commons"
    if re.search(r"\b(standard|normes?|regulation|r[eè]glement\w*|directive|"
                 r"guideline|guide|policy|politique|code of conduct|iso|iec|ieee|sae)", t):
        return "framework"
    if re.search(r"\b(projects?|projets?|consortium|programmes?|program|grant|horizon|"
                 r"sesar|call|appels?|financ\w*|funded)", t):
        return "project"
    return "team"
