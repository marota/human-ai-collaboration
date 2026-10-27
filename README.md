# Human–AI Joint Decision-Making in Critical Systems

*Design and evaluation criteria for AI decision support where errors are physical and irreversible.*

**[marota.github.io/human-ai-collaboration](https://marota.github.io/human-ai-collaboration/)** · by [Antoine Marot](https://marota.github.io/human-ai-collaboration/about/)

AI is moving from tools into decision systems that shape critical infrastructure:
transport, energy, healthcare, telecoms, industry and defence. This site asks how
humans and AI actually make decisions together in those systems, and what would
have to be measured before a deployment can be called safe. It brings together a
thirteen-part series, an explainer video, the projects and evaluation protocols
behind the arguments, a collaborative map of the European ecosystem, and an
annotated reference base.

This repository holds the site's source. Everything below lives either here or at
the links given.

## What is on the site

| | |
|---|---|
| [**The series**](https://marota.github.io/human-ai-collaboration/series/) | Thirteen posts in three sections on human–AI joint decision-making in critical operations: what erodes expert judgement, what the cognitive systems engineering literature already knows, and what it would take to build. |
| [**Explainer video**](https://marota.github.io/human-ai-collaboration/video/) | A synthesis of the series, and a perspective on how Europe could build shared capability to design, stress-test and certify human–AI collaboration before it reaches a control room. |
| [**Projects**](https://marota.github.io/human-ai-collaboration/projects/) | The code, evaluation protocols and open challenges behind the arguments: what is measured, how, and where the method stops being valid. |
| [**Ecosystem map**](https://marota.github.io/human-ai-collaboration/map/) | An interactive map, in English and French, of the European teams, projects, commons and frameworks working on human–AI collaboration in critical systems. It is collaborative: anyone can propose an addition or a correction. |
| [**References**](https://marota.github.io/human-ai-collaboration/references/) | An annotated bibliography, grouped by what each work is useful for: cognitive systems engineering, human factors, regulation, open evaluation environments. |
| [**About**](https://marota.github.io/human-ai-collaboration/about/) | The author, and the people this work was built with. |

## The series

**I. Observations that raise doubts**

1. [From augmentation to cognitive surrender](https://marota.github.io/human-ai-collaboration/series/01-from-augmentation-to-cognitive-surrender/)
2. [When new learners lean on AI to build their skills](https://marota.github.io/human-ai-collaboration/series/02-when-new-learners-lean-on-ai/)
3. [When AI tells us what we want to hear](https://marota.github.io/human-ai-collaboration/series/03-when-ai-tells-us-what-we-want-to-hear/)
4. [Do we still need to make decisions in the age of AI?](https://marota.github.io/human-ai-collaboration/series/04-do-we-still-need-to-make-decisions/)

**II. Lessons & perspectives**

5. [New perspectives for overcoming AI ironies](https://marota.github.io/human-ai-collaboration/series/05-new-perspectives-for-overcoming-ai-ironies/)
6. [Foundation: from techno-centric AI to Human-AI partnerships](https://marota.github.io/human-ai-collaboration/series/06-foundation-techno-centric-to-partnerships/)
7. [Partnerships under Human-Centered AI](https://marota.github.io/human-ai-collaboration/series/07-partnerships-under-human-centered-ai/)
8. [Explainable AI is not enough for effective Human-AI partnerships](https://marota.github.io/human-ai-collaboration/series/08-explainable-ai-is-not-enough/)
9. [Forget "human in the loop"](https://marota.github.io/human-ai-collaboration/series/09-forget-human-in-the-loop/)
10. [Human-AI collaboration needs a Mission Control](https://marota.github.io/human-ai-collaboration/series/10-human-ai-needs-a-mission-control/)

**III. Building for the future**

11. [Two disciplines are emerging around AI. Neither is about the model.](https://marota.github.io/human-ai-collaboration/series/11-two-emerging-disciplines/)
12. [Europe's Mission Control is already staffed. Meet three of its crews.](https://marota.github.io/human-ai-collaboration/series/12-europes-mission-control-is-already-staffed/)
13. The European ecosystem map — *in preparation*

## Where the resources are

| Resource | Where |
|---|---|
| The series | [`_series/`](_series/), one Markdown file per part. The sections are in [`_data/series_sections.yml`](_data/series_sections.yml), the series page in [`series.md`](series.md). |
| Explainer video | [On YouTube](https://www.youtube.com/watch?v=s8pMBovlHKo). Its page is [`video.md`](video.md). |
| Projects | [`projects/`](projects/), one page per project. [Co-Study4Grid](https://github.com/marota/Co-Study4Grid) is open source (MPL-2.0). The Ambient AI Scribe's code is private, so its page is the public deliverable. |
| Ecosystem map | [`map.md`](map.md) is the page around it. The map itself is [`assets/map/eu-hai-map.html`](assets/map/eu-hai-map.html), a single self-contained page. Its data, [`assets/map/hai-data.js`](assets/map/hai-data.js), is generated from the YAML of a separate repository, `eu-hai-collab-map`, which is private for now. |
| The map's chat | [`assets/map/hai-chat.js`](assets/map/hai-chat.js) runs in the page. Its server, which answers with a local model on the maintainer's machine, is in [`chat/`](chat/); see [`chat/README.md`](chat/README.md). |
| How the map works | [`docs/map-interface-spec.md`](docs/map-interface-spec.md) covers the data model, the visual language, filtering, the chat, and the invariants a change must keep. |
| References | [`references.md`](references.md) |
| About | [`about.md`](about.md) · [ORCID 0000-0003-1753-5493](https://orcid.org/0000-0003-1753-5493) |

## Contributing to the map

The map is meant to be completed and corrected by the people it describes. To
propose a team, a project, a commons or a framework, or to correct a card, you can
use either of two routes:

- **The chat.** Press **Chat** on the [map](https://marota.github.io/human-ai-collaboration/map/). It checks your source,
  drafts the card with you, and opens a GitHub issue that you read before sending.
- **The issue form.** Use it when the chat is unavailable, or if you would rather
  write it yourself. It is available
  [in English](https://github.com/marota/human-ai-collaboration/issues/new?template=map-entry.yml)
  and [en français](https://github.com/marota/human-ai-collaboration/issues/new?template=map-entry-fr.yml),
  and asks for the minimum first, then for what helps.

Every proposal is reviewed in the open before it reaches the map. The map's page
explains [how a proposal becomes an entry](https://marota.github.io/human-ai-collaboration/map/#a-collaborative-map). For
anything else about the site, such as a broken link or a reference to fix, open an
[issue](https://github.com/marota/human-ai-collaboration/issues/new/choose).

## Citing and licence

To cite the series, use [`CITATION.cff`](CITATION.cff), which GitHub shows as
*Cite this repository*. The content is licensed under [CC BY 4.0](LICENSE).

## Working on the site

The site is plain Jekyll with a home-made theme: the templates are in
`_layouts/` and `_includes/`, and the whole look is in
`assets/css/main.css`. There is no Sass and no web font (the type is a system
font stack); the colour tokens for light and dark mode sit at the top of that file.
Every push to `main` publishes the site through GitHub Actions (the *Publish
site* workflow).

```bash
bundle install
bundle exec jekyll serve      # http://localhost:4000/human-ai-collaboration/
```

- **Navigation.** The `nav:` list in `_config.yml` sets the menu, in display order.
- **A post of the series** is a file in `_series/`. Its `phase` places it in
  a section. While its `title:` starts with `[`, the post counts as
  unwritten: it is listed as *In preparation*, without a link.
- **Page front matter.** `eyebrow` is the kicker, `deck` the standfirst,
  `status` the badge on project pages, and `prose_class: prose--wide` gives a
  wider column.
- **Publishing without the Projects section.** Go to Actions → *Publish site* →
  *Run workflow* and untick `include_projects`. Locally, run
  `bundle exec jekyll serve --config _config.yml,_config.without-projects.yml`.
  The Projects pages are then not built at all, and the workflow fails if a link
  to `/projects/` survives. `_config.without-projects.yml` redeclares
  `exclude` in full, so an entry added to `exclude` in `_config.yml` must be
  added there too.
- **The map's data** is generated and never edited by hand.
  `python3 scripts/build-map-data.py --source ../eu-hai-collab-map` rebuilds
  `assets/map/hai-data.js` from the data repository, or from `$EU_HAI_MAP_REPO`.
  Read the [interface specification](docs/map-interface-spec.md) before changing
  the map or its generator.
- **The map's chat** runs on the maintainer's machine. After a merge,
  `chat/service.sh update` moves it to the new `main` and restarts it; see
  [`chat/README.md`](chat/README.md).
- **Tests.** `npm test` runs the map in a real browser and checks its
  generator, its payload, its chat and the issue form; see
  [`tests/README.md`](tests/README.md).
- **Placeholders** still to fill are marked `[A COMPLETER]` or `TODO`. To list
  them, run `grep -rn "A COMPLETER\|TODO" .`
