# The map's chat column

A chat beside the [ecosystem map](../assets/map/eu-hai-map.html) that answers
from the map's own data, and turns "this is missing" or "this is wrong" into a
reviewable GitHub issue — a draft card the contributor corrects on the spot,
while they are still here to answer.

The model runs on this machine, through [Ollama](https://ollama.com). Nothing
is sent anywhere else except the reference page the contributor asks us to read,
and the issue they explicitly choose to open. The published map reaches it
through a tunnel — see [Publishing it](#publishing-it).

The design and the reasoning behind it are §18 of
[`docs/map-interface-spec.md`](../docs/map-interface-spec.md). This file is how
to run it.

## Running it

```bash
python3 chat/server.py
```

Then open the URL it prints:

```
http://127.0.0.1:8765/assets/map/eu-hai-map.html?chat=1
```

The server serves the map as well as the API, so that one command is the whole
setup. There is nothing to install: it is the Python standard library, `ollama`
for the model, and `gh` for the issue. It serves `assets/map/` and nothing else
from the repository, and that only to this machine.

`?chat=1` opens the column on arrival. Without it the map shows a Chat pill and
nothing else: no chat, and no network request of any kind, until the pill is
pressed.

### Already running Jekyll?

Keep your dev server and point the chat at this one:

```
http://127.0.0.1:4000/assets/map/eu-hai-map.html?chat=1&chatapi=http://127.0.0.1:8765
```

Only a loopback address is taken, and only from a page on this machine.

## What it needs

| | |
|---|---|
| **Ollama** | listening on `http://127.0.0.1:11434`, with the two tags below pulled |
| **`gh`** | installed and `gh auth login`'d, with `repo` scope, to open the issue |
| **Python** | 3.11 or newer. No packages. |

Check both at a glance:

```bash
curl -s localhost:8765/api/health | python3 -m json.tool
```

The chat column shows the same thing as a dot next to its title, and says which
command to run when something is missing.

## The two models

```bash
ollama pull gemma4-a4b-qat-32k    # the conversation — or any tag you prefer
ollama pull qwen3.8:27b           # the one that drafts a card
```

The conversation wants to come back in a few seconds and is answering from a
retrieval bundle that already holds the facts, so a smaller or sparser model is
the right trade — on this machine the mixture-of-experts tag answers a grounded
question in about nine seconds against twenty for the dense 12B, at the same
quality. Drafting a card is one call, structured, and read by a human afterwards —
worth a bigger model and a slower wait. On a 64 GB M-series machine both stay
resident between turns.

**Reasoning models work, with reasoning off** — which is the default here. Left
on, Ollama returns it in a field of its own: a one-line question costs several
thousand unseen tokens, the visible answer can be cut off before it starts, and
the chat looks like it has hung. Set `HAI_CHAT_THINK=1` if you want to
experiment.

## Settings

All optional; the defaults are what this machine runs.

| Variable | Default | What it does |
|---|---|---|
| `HAI_CHAT_PORT` | `8765` | port |
| `HAI_CHAT_HOST` | `127.0.0.1` | interface. Leave it alone: this server can open issues as you. To publish it, put the tunnel in front instead. |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | where Ollama listens |
| `HAI_CHAT_MODEL` | `gemma4-a4b-qat-32k:latest` | the conversation |
| `HAI_DRAFT_MODEL` | `qwen3.8:27b` | drafting a card |
| `HAI_CHAT_NUM_CTX` | `32768` | context window |
| `HAI_CHAT_NUM_PREDICT` | `600` | ceiling on an answer. Without one a local model will enumerate the corpus. |
| `HAI_DRAFT_NUM_PREDICT` | `3200` | ceiling on a draft. Raise it if a draft comes back cut off. |
| `HAI_CHAT_THINK` | off | let a reasoning model reason |
| `HAI_CHAT_CATALOGUE` | off | put all 450 ids in the system prompt. Costs ~7 000 tokens a turn; only worth it with a large model. |
| `HAI_CHAT_REPO` | `marota/human-ai-collaboration` | where issues are opened |
| `HAI_CHAT_DATA_REPO` | `marota/eu-hai-collab-map` | named in the issue as where the YAML goes |
| `HAI_CHAT_LABELS` | — | comma-separated; labels that do not exist are skipped |
| `HAI_CHAT_DRY_RUN` | off | run the whole flow and post nothing |
| `HAI_CHAT_KEEP_ALIVE` | `30m` | how long Ollama keeps a model loaded |
| `HAI_CHAT_ORIGINS` | `https://marota.github.io` | comma-separated; the published origins a visitor's browser may call from |
| `HAI_CHAT_ISSUES_PER_DAY` | `20` | issues all visitors together may open in a day |
| `HAI_CHAT_PUBLIC_CHATS` | `2` | visitor conversations answered at once; past that, "busy" |
| `HAI_CHAT_PUBLIC_LABEL` | `via-public-chat` | added to a visitor's issue, when the repository has the label |

`--warm` loads both models before serving, so the first turn is not the slow one.

## Publishing it

The map on GitHub Pages has the same pill, and its chat calls
`https://mac.tail9919aa.ts.net:8443` — this machine, through
[Tailscale Funnel](https://tailscale.com/kb/1223/funnel). The server stays on
loopback; Funnel is what faces the internet.

```bash
python3 chat/server.py                                   # as above, on 127.0.0.1:8765
tailscale funnel --bg --https=8443 http://127.0.0.1:8765
tailscale funnel status                                  # should list :8443, "Funnel on"
```

Port 8443 keeps this apart from anything already served on 443. The first
`tailscale funnel` on a tailnet asks an admin to allow Funnel for the node,
with a link; that is a one-time switch in the Tailscale admin console.

Then check from outside that a visitor gets the API and nothing else:

```bash
curl -s https://mac.tail9919aa.ts.net:8443/api/health | python3 -m json.tool   # trimmed
curl -s -o /dev/null -w '%{http_code}\n' https://mac.tail9919aa.ts.net:8443/assets/map/eu-hai-map.html  # 404
```

To stop publishing: `tailscale funnel --https=8443 off`. The published map then
says the chat is unavailable, and keeps working.

### Keeping it running

```bash
chat/service.sh install     # start it at login, and again whenever it stops
chat/service.sh update      # after a merge: move it to the latest main, restart
chat/service.sh status      # what runs, from which commit, whether it answers
chat/service.sh uninstall
```

`install` registers a launchd agent (`com.marota.hai-chat`) that runs the
server from a worktree of its own, `~/Dev/human-ai-collaboration-live`,
detached at `origin/main` — never from the checkout you work in. The published
map draws main's `hai-data.js`, and the chat must answer from that same file,
not from whatever branch or half-regenerated payload the working checkout holds.
So a merge reaches the published chat when `update` runs, and not before.

launchd restarts the server within seconds if it stops, and starts it at login;
with macOS automatic login on, a reboot brings the published chat back
unattended. The other two pieces come back on their own: Ollama.app opens at
login, and Funnel's configuration persists in `tailscaled`. The log is
`~/Library/Logs/hai-chat.log`.

**What a visitor can and cannot do** is §18.6 of the spec, and
`tests/chat/test_public.py` holds it: no file from the repository, ceilings per
address and per day, a cap on concurrent generations, references fetched only
from the public internet, and issues that say a visitor opened them and cannot
mention anyone. Every request through the tunnel is logged with its address.
If the chat is abused, stopping Funnel is the switch.

## What it will and will not do

It answers from `assets/map/hai-data.js` — the same payload the page draws —
plus figures counted in Python. It links a card as `[Name](#id)` and the column
turns that into the card itself; an id that is not real is rendered as plain
text rather than a dead link. Asked about something that is not on the map, it
says so.

It cannot change the map. A proposal ends as a GitHub issue, opened by an
explicit click on a body the contributor has read, carrying the YAML, the
reference and its verdict, the before/after of a correction, and the review bar
from the data repository's `CONTRIBUTING.md`. Turning that into a pull request
is a maintainer's decision, as it was before.

It refuses to fetch a reference whose host resolves inside this machine or the
local network. A box that will fetch any URL for you must not become a way to
read the network the server sits on.

## The flow, in five steps

1. Someone says something is missing or wrong. The model opens a proposal.
2. It asks for the page that documents it. The server fetches that page once and
   reports whether it loaded and whether the name actually appears on it.
3. The drafting model fills in a card, constrained to a JSON schema generated
   from the same field table that renders the form.
4. The contributor corrects it in place — required fields first, vocabularies as
   checkboxes, the YAML visible, every edit re-checked by the server.
5. They read the issue body, and click once.

## Tests

```bash
python3 -m unittest discover -s tests -p 'test_*.py' -t .   # the server side
npx playwright test tests/interface/chat.spec.js            # the column
```

Neither needs a model running: the Python tests work on the committed payload,
and the browser tests drive the column against a stubbed server. That is
deliberate — what is worth pinning is the contract between the page, the server
and the data, not the prose a particular tag happens to produce today.
