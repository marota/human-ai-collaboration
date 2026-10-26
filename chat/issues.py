"""Turning a finished proposal into a GitHub issue.

The chat never writes to the map. What it produces is an issue: the YAML the
entity would have, the reference it rests on, what the contributor was asked
and answered, and a checklist against the review bar in the data repository's
CONTRIBUTING.md. A maintainer reads it and turns it into a pull request, or
closes it. That is the whole authority model, and it is why the chat can be
left running for someone else to use.

Posting goes through the `gh` CLI rather than a token of our own: it is already
authenticated on this machine, it keeps credentials out of this repository, and
`gh issue create` fails loudly when it cannot post.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from typing import Any

import cards
from hai_data import LAYER_DIR

# Where the issues land. The map's interface lives here, so this is where the
# maintainer looks; the YAML itself belongs to the data repository, which the
# body names in full so nobody has to remember which file to touch.
REPO = os.environ.get("HAI_CHAT_REPO", "marota/human-ai-collaboration")
DATA_REPO = os.environ.get("HAI_CHAT_DATA_REPO", "marota/eu-hai-collab-map")
LABELS = tuple(l.strip() for l in os.environ.get("HAI_CHAT_LABELS", "").split(",") if l.strip())
DRY_RUN = os.environ.get("HAI_CHAT_DRY_RUN") == "1"


class IssueError(RuntimeError):
    pass


def _gh(*args: str, stdin: str | None = None, check: bool = True) -> str:
    exe = shutil.which("gh")
    if not exe:
        raise IssueError("The GitHub CLI (gh) is not installed, so no issue can be opened. "
                         "Install it and run `gh auth login`.")
    proc = subprocess.run([exe, *args], input=stdin, capture_output=True, text=True,
                          timeout=60)
    if check and proc.returncode != 0:
        detail = (proc.stderr or proc.stdout).strip().splitlines()
        raise IssueError(detail[-1] if detail else f"gh {' '.join(args)} failed")
    return proc.stdout.strip()


def available_labels() -> set[str]:
    try:
        raw = _gh("label", "list", "--repo", REPO, "--limit", "100", "--json", "name")
        return {row["name"] for row in json.loads(raw or "[]")}
    except (IssueError, json.JSONDecodeError, KeyError):
        return set()


def title_for(mode: str, layer: str, card: dict[str, Any],
              changed: list[dict[str, Any]] | None = None) -> str:
    name = card.get("name") or card.get("id") or "?"
    if mode == "add":
        return f"Map data: add {name} ({layer})"
    fields = ", ".join(row["path"] for row in (changed or [])[:3]) or "a field"
    more = "…" if changed and len(changed) > 3 else ""
    return f"Map data: fix {fields}{more} on {name}"


def _value(v: Any) -> str:
    if v is None or v == "":
        return "—"
    if isinstance(v, list):
        return ", ".join(str(x) if not isinstance(x, dict) else
                         str(x.get("org", x)) for x in v) or "—"
    return str(v).replace("|", "\\|").replace("\n", " ")


def body_for(mode: str, layer: str, card: dict[str, Any], *,
             reference: dict[str, Any] | None, report: dict[str, Any] | None,
             changed: list[dict[str, Any]] | None, transcript: str,
             lang: str, as_of: str) -> str:
    path = f"{LAYER_DIR[layer]}/{card.get('id', '<slug>')}.yml"
    rows: list[str] = []

    if mode == "add":
        rows.append(f"A new **{layer}** card, proposed through the map's chat. It would "
                    f"become `{path}` in [{DATA_REPO}](https://github.com/{DATA_REPO}).")
    else:
        rows.append(f"A correction to **{card.get('name')}** (`{card.get('id')}`), proposed "
                    f"through the map's chat. The file is `{path}` in "
                    f"[{DATA_REPO}](https://github.com/{DATA_REPO}).")

    ref = reference or {}
    rows += ["", "### Reference", ""]
    if ref.get("url"):
        verdict = ("the page names the entity" if ref.get("confirms")
                   else "**the page does not name the entity** — worth a second look")
        rows.append(f"- {ref['url']}")
        if ref.get("title"):
            rows.append(f"- Title: {ref['title']}")
        rows.append(f"- Fetched {ref.get('fetched_at', '?')}, "
                    f"HTTP {ref.get('status', '?')} — {verdict}.")
        if ref.get("error"):
            rows.append(f"- Fetch note: {ref['error']}")
    else:
        rows.append("- **None supplied.** The claim rests on the conversation alone.")

    if mode == "fix" and changed:
        rows += ["", "### What changes", "", "| Field | On the map | Proposed |",
                 "|---|---|---|"]
        for row in changed:
            rows.append(f"| `{row['path']}` | {_value(row.get('before'))} | "
                        f"{_value(row.get('after'))} |")
        rows.append("")
        rows.append(f"The map's snapshot is dated {as_of}; a field that changed upstream "
                    "since then may already be fixed.")

    rows += ["", "### Proposed YAML", "",
             "```yaml", cards.to_yaml(card, layer).rstrip(), "```"]

    if card.get("description_fr"):
        rows += ["", "The French description belongs in "
                 f"`data/i18n/descriptions.fr.yml` upstream, keyed on "
                 f"`{card.get('id', '<slug>')}`:", "",
                 "```yaml",
                 f"{card.get('id', '<slug>')}: |",
                 *[f"  {line}" for line in str(card["description_fr"]).strip().splitlines()],
                 "```"]

    rep = report or {}
    rows += ["", "### Checks", ""]
    rows.append("- Schema fields and controlled vocabulary: "
                + ("pass" if rep.get("ok") else "**fail**"))
    for err in rep.get("errors") or []:
        rows.append(f"  - `{err['path']}` — {err['message']}")
    for warn in rep.get("warnings") or []:
        rows.append(f"- Note: {warn['message']}")
    rows += ["",
             "Review bar, from the data repository's CONTRIBUTING.md:", "",
             "- [ ] **Scope fit** — European, industrial or critical decision-making, "
             "human–AI collaboration rather than full automation.",
             "- [ ] **Verifiability** — a public source for every non-trivial claim.",
             "- [ ] **Taxonomy** — `focus_areas` and `domains` from `data/taxonomy.yml`.",
             "- [ ] **Coordinates** — the latitude and longitude point at the right place."]

    if transcript:
        rows += ["", "<details><summary>The conversation this came from</summary>", "",
                 transcript.strip(), "", "</details>"]

    rows += ["", "---", "",
             f"Drafted by the map's local chat ({'French' if lang == 'fr' else 'English'}) "
             f"against the snapshot dated {as_of}, and reviewed on screen by the "
             "contributor before it was opened. Nothing has been changed on the map."]
    return "\n".join(rows)


def create(title: str, body: str, *, labels: tuple[str, ...] = LABELS) -> dict[str, Any]:
    """Open the issue, and say where it went."""
    if DRY_RUN:
        return {"url": f"https://github.com/{REPO}/issues/dry-run", "dry_run": True,
                "repo": REPO, "title": title}
    args = ["issue", "create", "--repo", REPO, "--title", title, "--body-file", "-"]
    keep = available_labels()
    for label in labels:
        if label in keep:
            args += ["--label", label]
    out = _gh(*args, stdin=body)
    url = next((line for line in out.splitlines() if line.startswith("http")), out)
    return {"url": url.strip(), "repo": REPO, "title": title, "dry_run": False}


def health() -> dict[str, Any]:
    """Whether an issue could be opened right now."""
    out: dict[str, Any] = {"repo": REPO, "data_repo": DATA_REPO, "dry_run": DRY_RUN,
                           "ok": False}
    if DRY_RUN:
        out["ok"] = True
        out["account"] = "dry run — nothing is posted"
        return out
    if not shutil.which("gh"):
        out["error"] = "gh is not installed"
        return out
    try:
        raw = _gh("api", f"repos/{REPO}", "--jq",
                  "{login: .owner.login, issues: .has_issues}")
        info = json.loads(raw or "{}")
        out["ok"] = bool(info.get("issues"))
        out["account"] = _gh("api", "user", "--jq", ".login")
        if not out["ok"]:
            out["error"] = f"issues are disabled on {REPO}"
    except (IssueError, json.JSONDecodeError) as e:
        out["error"] = str(e)
    return out
