# Admission criteria for a card — proposal

**Date:** 2026-11-02 · **Status:** applied to the reclassification of 2 November (`revue-2026-10/RECLASSEMENT_TIERS.md`), with the maintainer's decisions of that day, marked **Decision of 2 November** · **State checked on:** `main` (afe47ce), 486 cards; 430 on the map after the archiving

This is the English translation of `CRITERES_ADMISSION.md`, kept in French in the map's data repository, `eu-hai-collab-map`. That repository is private for now, so the files it holds are named here, not linked. The criterion codes are those of the French text: É stands for *écosystème*, the periphery. The P codes (P2, P4.1…) number the open questions of `revue-2026-10/ARBITRAGES_OUVERTS.md`.

**What it builds on.**
- `CONTRIBUTING.md`: "Scope fit", "Verifiability" and "Scope reminders".
- `README.md`: "Scope", with the core and the ecosystem.
- `data/taxonomy.yml`.
- The conventions of the October review: `revue-2026-10/PHASE2_PROJETS.md`, with the decisions of 28 and 29 October.
- `revue-2026-10/ARBITRAGES_OUVERTS.md`.
- The June report, `REVUE_CRITIQUE_ET_ENTITES_MANQUANTES.md`, and `SUIVI_REVUE.md`.

## Why

Today, the bar for entry fits in three words from CONTRIBUTING: scope, verifiability, taxonomy. The rule for doubt is "include + flag". The October review showed what that costs: a good share of the 43 open questions for the maintainer are questions of admission. There are names without a source (P2), cards that are duplicates or in the wrong layer, and operators with no human–AI activity (P4).

This grid gives every entry and every refusal the same kind of justification. The reason is a criterion code, backed by a source. It takes up the rules already written; each criterion says where it comes from, and the additions are marked **New**.

## 1. How the grid decides

Three steps, in order:

1. **Admissibility (R1 to R6).** These are eliminating conditions: if one is missing, the card is refused, with the code of the criterion.
2. **Thematic anchoring.** T1, T2 and T3 together open the core. Failing that, the periphery (`ecosystem`) opens through one of these criteria: É1, É2, A2, or A3 with a justified potential.
3. **Exclusions (X1 to X6).** These are cases that do not pass, even with an apparent anchoring.

**Possible verdicts:**
- admitted, with a proposed tier (`core` or `ecosystem`);
- refused, with a reason code; a card already on the map is then archived (section 3);
- to be decided, with the question put to the maintainer.

Each ticked criterion cites its source. As CONTRIBUTING has it, doubt is flagged and the maintainer decides. **New:** the decision and its reason are recorded in the card's provenance, like the "Review 2026-10" segment.

## 2. Admissibility — all six conditions are required

- **R1 — Public source.** At least one public source names the entity. It can be its website, its organisation's, CORDIS, a registry or an official text. A press article alone gives `medium` confidence. With no source at all, the card does not enter.
  *Origin: "Verifiability" (CONTRIBUTING); "No source, no correction" and the confidence scale of the October review.*
- **R2 — Sourced name.** The card's name is the one a source gives, in the form "Organisation — Unit" when the unit alone tells no one where it is.
  - If no source names the unit, the card is the organisation's.
  - If the organisation already has a card, the unit is attached to it by a `level: organisation` row.

  *Origin: P2 (25 cards had a name that no source gave); rule 6 of the drafting chat; decision of 28 October.*
- **R3 — Europe.** The headquarters or the site of activity is in Europe in the broad sense, in a country on the `countries` list of `taxonomy.yml`. Adding a country goes through a PR on the taxonomy.
  *Existing exception:* a framework or a commons of non-European origin enters when it serves as a reference for the core. Examples are NIST AI RMF, Endsley's model and HCAI (Shneiderman). Today, 17 frameworks have no pin, because they are international or non-European. The only commons in that case, CityLearn, was archived on 2 November.
  **New:** this exception holds only for these two layers, never for a team, a project or a cluster.
  *Origin: README "European geography"; current practice for frameworks.*
- **R4 — No duplicate.** No card already represents the entity: same organisation in `organisations.yml`, same home page, or same project.
  - A second unit of an organisation already present enters only if a source shows a human–AI activity distinct from that of the existing card. Otherwise, a row at organisation level is enough.
  - **New:** an infrastructure card designates a facility: a machine, a simulator, a test bench or a platform. A competence centre or a shared site is not one.

  *Origin: decisions of 28 and 29 October; P4.1, P4.6, P4.7; recommendation P4.2 on mirrors.*
- **R5 — A layer that fits it.** The entity is one of the map's six objects, with a `kind` from `taxonomy.yml`:
  - **team:** a unit or an organisation that carries out the work;
  - **project:** a funded project, with a funder and dates;
  - **infrastructure:** a facility (see R4);
  - **framework:** a standard, a regulation, a guideline, a policy, a code of conduct, or an academic reference model;
  - **commons:** a dataset, a benchmark, a model, open software or a community;
  - **cluster:** an association, a network or a cluster of projects.

  An association goes in the clusters. A project consortium is not a team, nor is a regulator's programme a lab.
  *Origin: README (six layers); decision of 28 October (clusters); June report, A4; P4.3, P4.4, P4.5.*
- **R6 — Real existence.** The entity is active, concluded, or announced with funding: these are the taxonomy's `statuses` (`active`, `concluded`, `planned`). A concluded entity is admitted, since the period filter shows the history of the field. An idea, a call for projects or a project without a grant does not enter.
  *Origin: taxonomy; the site's period filter.*

## 3. Thematic anchoring

### Core (`tier: core`) — T1, T2 and T3, each with its source

- **T1 — Human–AI collaboration.** A source describes work on at least one `focus_area` of the taxonomy: decision support, mixed initiative, oversight, explainability for the operator, uncertainty communication, trust calibration, shared situational awareness, human factors, human–computer partnership, cobots, the digital twin as a decision surface, reinforcement learning with the operator in the loop. Their codes: `decision_support`, `mixed_initiative`, `oversight`, `explainability`, `uncertainty_communication`, `trust_calibration`, `shared_situational_awareness`, `human_factors`, `human_computer_partnerships`, `cobots`, `digital_twins`, `reinforcement_learning_ops`.
  A page that announces "AI" without describing the human's role is not enough.
  **Decision of 2 November:** T1 also covers automation that shares the decision or the action with a human, even when AI is not named. Examples are automated operation that the operator supervises and can take back, or the human factors of an automated control room; Fitts's and Sheridan's models are about this sharing. A mere calculation tool, such as a load flow or a security analysis, is not part of it.
- **T2 — Industrial or critical system.** This work applies to at least one `domain` of the taxonomy: manufacturing, energy, nuclear, power grid, transport, aviation, rail, maritime, healthcare, water, gas, telecoms, defence or critical infrastructure. Their codes: `manufacturing`, `energy`, `nuclear`, `power_grid`, `transport`, `aviation`, `rail`, `maritime`, `healthcare`, `water`, `gas`, `telecom`, `defense`, `critical_infrastructure`.
- **T3 — Human decision.** The AI helps a human or a team to decide or to act, and the human keeps a role, in the loop or in oversight.

*Origin: README "Core"; CONTRIBUTING "Scope reminders".*

**Reading by layer:**
- **Project:** T1 to T3 are read in its objective, the one on CORDIS for a European project.
- **Operator** (grid operator, air navigation service provider, water company…): it needs a human–AI activity of its own, with a source. **New:** being a member of a consortium is not enough for the core; that falls under É1.
- **Framework:** it is in the core when its subject is human decision-making with AI or automation, like Fitts's list, Sheridan's levels or SAE J3016. It is also in the core when one of its provisions is dedicated to that decision in critical systems and imposes it. A general framework, where the human's role is only one part, falls under É2.
  **Decision of 2 November:** the AI Act is in the core, for its Article 14 on human oversight. The people who oversee a high-risk AI system must be able to "remain aware of the possible tendency of automatically relying or over-relying on the output produced by a high-risk AI system (automation bias)" (Art. 14(4)(b)), and to override its output or stop it (Art. 14(4)(d) and (e)). Safety components in the management of critical infrastructure are high-risk (Annex III, point 2). It is the rule that guards critical systems against automation bias. Source: http://publications.europa.eu/resource/celex/32024R1689

### Ecosystem, the periphery (`tier: ecosystem`) — É1, É2, A2 or justified A3

The core brings together the cards that do human–AI collaboration themselves. The periphery brings together those that revolve around it with a looser link: they fund it, host it, group it, frame it or supply its building blocks. As `taxonomy.yml` defines it, these are national AI programmes, compute and AI factories, networks and associations, and the broad reference frameworks.

**Decision of 2 November:** compute and AI factories are in the periphery by definition: supercomputers, computing centres, AI factories and their operators. No source has to show human–AI work computed at their site. The question stays open for national AI programmes.

- **É1 — Sourced link with the core.** The entity itself contributes to a piece of core work: it funds it, hosts it, groups it, computes for it, or takes part in it as a partner. The link is shown by a row in `edges.yml` (consortium or member), by an `infrastructure_ids` link, or by a source that describes the relationship.
  **Clarification of 2 November:** the link runs from the entity to the core work. For a project, counting core teams among its partners is not enough: the project itself must contribute, at level A1, A2, or A3 with a justified potential.
- **É2 — Reference framework for the core.** A regulation, a standard or a reference model frames human decision-making with AI in a critical system, without making it its subject (see "Framework" above): NIST AI RMF, ISO/IEC 42001, IEC 61508, STPA…

An entity that has neither the core's anchoring, nor É1, nor É2, nor A2, nor a justified A3 is refused, whatever its size. CONTRIBUTING says so: "not a directory of every European AI lab".

**Decision of 2 November: a card already on the map in that case is archived.** It leaves the map, because there is little point in showing it there. Its file, its rows, its organisation and its descriptions move to `data/archive/`. It comes back only on a real justification: a source that meets a criterion. The folder's README says how to reopen it.

**The tier remains a maintainer's field**, like `domains` and `focus_areas` (rule of the October review). The grid proposes, the maintainer sets.

### Supporting resources — simulators, test benches, TEFs, software, datasets (**New**)

Many resources serve to test human–AI collaboration without having been made for it: PowSyBl, pandapower, SUMO, a testing and experimentation facility (TEF). They are judged on the human–AI use that a source documents, not on what they would make possible.

**Two conditions hold in every case:**
- the resource models or runs a system from a T2 domain;
- it is open to others: a free licence for a commons, open access for outside testers for an infrastructure or a testing facility.

**Three levels:**
- **A1 — Testing ground.** A source shows human–AI work carried out on the resource: an experiment with operators, an assistant tested on it, a competition where AI advises a human. The resource enters the core, and T1 to T3 are read in that work.
  *Examples on the map:*
  - Grid2Op, with the L2RPN competitions, which study how AI agents can help grid operators;
  - Flatland and BlueSky, AI4REALNET's rail and air traffic environments. The project's CORDIS periodic report says they were upgraded, with Grid2Op, for the human-in-the-loop trials.

  Being the environment of a core project is not enough: a source must show that the human–AI work is carried out there.
- **A2 — Building block.** The resource supports an A1 resource or a core project, with a source (dependency, connector, base), but no human–AI work is documented on the resource itself. It enters the ecosystem through É1, linked to the card it supports.
- **A3 — Potential.** The resource could serve, but no source shows that use.
  - **Justified potential → periphery.** A source gives a concrete argument. For example, AI recommendations meant for operators are tested there, or it is explicitly open to human-in-the-loop trials. The resource enters the ecosystem, and its provenance carries the note "A3 — justified potential" with the source.
  - **Unjustified potential → not yet.** "Could serve" is not a use. The resource will enter when a source shows it.

A calculation tool that helps the operator decide without AI, such as a grid's security analysis, does not meet T1: it shares neither the decision nor the action (see T1). It remains a building block (A2) as soon as a human–AI resource or project relies on it.

## 4. Exclusions — none may apply

- **X1 — Generic AI lab.** It targets no T2 domain and has no É1 link.
  *Origin: CONTRIBUTING.*
- **X2 — Full autonomy.** The system acts with no human role, with neither oversight nor takeover. Conversely, work that studies human oversight of autonomous systems enters, for example a shore control centre for ships or remote operation.
  *Origin: README "not full automation".*
- **X3 — Model performance alone.** The work measures what the AI does (the accuracy of a diagnosis, of a forecast) without studying how a human uses it.
  - **New:** it is this criterion, not the domain, that settles clinical diagnosis. Work on the clinician's decision with AI enters; work on the model alone does not.
  - The tier of the health cards has been open since June.

  *Origin: `healthcare_ops` ("not clinical diagnosis"); SUIVI_REVUE, health tier.*
- **X4 — Commercial offering.** A product page, a consulting service or a brochure, with no research or publication. A company enters through its R&D team, or through its part in a project.
  *New.*
- **X5 — A person, an event or an isolated publication.** A lone researcher (the card is their team), a conference, a workshop, a call, a press article.
  *Existing exception:* a publication that became a reference model enters as a framework, for example Fitts's list, Rasmussen's SRK model, "Ironies of Automation" or Endsley's model.
- **X6 — Outside Europe.** Except for the R3 exception.

## 5. What the grid does not decide

- **The maintainer's fields:** `tier`, `domains` and `focus_areas`.
- **The conventions of form**, which apply after admission; the validator checks some of them. They are described in `PHASE2_PROJETS.md`, "Conventions":
  - the pin, at the site that leads the project or at the team's official address;
  - the dates, sourced and quoted;
  - the city, in its English form;
  - the rows of `edges.yml` and `organisations.yml`;
  - the provenance segment and the confidence.
- **The rules still open under P3:** the `affiliation` convention, the type of operators, etc.
- **The cards already on the map.** All 486 cards were run through the grid on 2 November: see `revue-2026-10/RECLASSEMENT_TIERS.md`.

## 6. The form

To copy into the issue or the PR that proposes a card. A ticked box must carry its source.

```markdown
### Candidate card
- Name, as the source gives it:
- Layer and kind:
- Sources (URL):

### Admissibility — all required
- [ ] R1 Public source: <url>
- [ ] R2 Sourced name: <url> · level: unit / organisation
- [ ] R3 Europe: country <XX> — or non-European reference framework / commons
- [ ] R4 No duplicate: cards checked <ids> · infrastructure = a facility
- [ ] R5 Layer: <layer>, kind <kind>
- [ ] R6 Status: active / concluded / announced and funded

### Anchoring — core (T1 + T2 + T3) or ecosystem (É1 or É2)
- [ ] T1 Human–AI collaboration, or automation that shares the decision: focus_areas <codes> · <url> · "short quote"
- [ ] T2 Critical system: domains <codes> · <url>
- [ ] T3 Human decision: role of the human <…> · <url>
- [ ] É1 Sourced link with a core card: <id> · nature <funds / hosts / groups / computes>
- [ ] É2 Reference framework for the core: <what it frames>
- [ ] Supporting resource: level A1 / A2 / justified A3 / unjustified A3 · human–AI use or argument <url> · card it supports <id>

### Exclusions — tick when checked and the exclusion does not apply
- [ ] X1 Not a generic AI lab
- [ ] X2 A human keeps a role
- [ ] X3 Use by a human is studied, not only the model
- [ ] X4 Not a mere commercial offering
- [ ] X5 Not a person, an event or an isolated publication (except a reference model)
- [ ] X6 In Europe (except the R3 exception)

### Verdict
- [ ] Admitted · proposed tier: core / ecosystem
- [ ] Refused · reason: <code of the missing criterion>
- [ ] To be decided · question:
```

**Reasons for refusal.** The code of the missing criterion is enough to give the reason for a refusal: "R2: no source names this unit", "X3: the project measures the model's accuracy, not its use". The same code is cited to archive an existing card.

## 7. Trial run on the open cases

To check that the grid gives verdicts consistent with the map, here is what it would give on the cases already open. **Nothing is decided:** these cases remain the maintainer's to decide.

**Decision of 2 November:** the out-of-grid cards were archived. Among the cases below, they are ethz-esc, ihu-paris and inserm-ai (P4.2, P4.6), hydrogen-eu (P4.3), gaiax's infrastructure card (P4.5), gasunie, fluxys, lvnl and gasgrid-finland (P4.9), and slovak-tech (P4.10).

- **The P4 cases come down to one criterion:**
  - **R4, duplicate:** cab-framework versus interactiveai-irt-systemx (P4.1), ihu-paris versus inserm-ai (P4.6), enac-simu versus enac-achil (P4.7).
  - **R4, infrastructure without a facility:** the mirrors ethz-esc and ihu-paris (P4.2) would be removed, as the batch recommended.
  - **R5, layer:** gaiax goes in the clusters (P4.5); easa-ai is not a lab (P4.4); ehds, hydrogen-eu and aiod are not projects (P4.3).
- **Operators without a sourced human–AI activity (P4.9).** T1 is missing everywhere, so none enters the core.
  - elia has a row to TwinEU, which the decision of 29 October kept: É1, so ecosystem.
  - gasunie has only one row, to hydrogen-eu. But that row itself has no source (P1.3), and hydrogen-eu is not a project (P4.3). É1 is therefore not established, and the grid would refuse it, unless P1.3 finds a source.
  - fluxys, lvnl and gasgrid-finland have no row: refused.
  - For elia and lvnl, checking their websites by hand (P6.1) may still find an activity that opens the core.
- **slovak-tech (P4.10).** Its only link, TAILOR, is a participation as a linked third party, which ended with no contribution. É1 is therefore fragile, and the grid would refuse it, unless a linked third party counts as a link.
- **hyp-driven (P4.11).** It is an Australian paper from 2023. It enters only through the R3 / X5 exception, if it serves as a reference model; that is for the maintainer to decide.
- **The "borderline" entities of June**, following the angles noted in the report:
  - Since then, BAE Systems and DNV have entered through a team (bae-tempest, dnv-control-room-hf), which is in line with X4.
  - **Lloyd's Register (AL levels) and Bureau Veritas (NI 641):** the guideline enters as a framework (É2, or even T1 to T3), not the company (X4).
  - **Tractebel:** a team enters the core if a source shows its human factors work in control rooms (T1 to T3). Otherwise, X4.
  - **AISI:** T1 is plausible, since it evaluates human oversight. T2 remains to be shown; without a source on a critical system, X1.
  - **REN and IEn:** they are operators, so core if their operator-support tool has a source; otherwise ecosystem through É1, if they have a row; otherwise refused.
  - **PowerGridworld, Safety-Gymnasium, MATSim, PettingZoo:** non-European commons, which enter through R3 only if a core card uses them, with a source.
- **Telecoms (AIOps).** T2 is met. It is T3 and X2 that decide: does the operator stay in the loop, or does the network manage itself? The tier of these cards has been open since June.
- **Supporting resources already on the map.** They are all in `core` today.
  - **PowSyBl.** According to its card, RTE, Coreso, Baltic RCC and TenneT use it for their operation and planning studies, and Grid2Op can run on it through the pypowsybl2grid connector. That is level A2: a building block of Grid2Op and of the operators' tools, but no human–AI work is documented on PowSyBl itself. The grid would therefore propose it for the ecosystem, unless a source shows such work, for example an operator assistant tested on PowSyBl in a project on the map.
  - **pandapower** is at the same level: it is Grid2Op's default calculation engine, and the code of AI4REALNET and AI-EFFECT depends on it.
  - Changing their tier remains a maintainer's decision (section 5).
- **The two proposals that came from the public chat on 1 November:** EnerTEF and EnergyGuard, issues [#45](https://github.com/marota/human-ai-collaboration/issues/45) and [#46](https://github.com/marota/human-ai-collaboration/issues/46) of this repository. The annex gives the two filled-in forms.
  - Both are admissible. They are two Horizon Europe projects from the same call as AI-EFFECT, as the contributor said.
  - No source describes human–AI collaboration: T1 and T3 are missing, so no core.
  - Having core partners does not count (É1, clarification of 2 November). So A2 is needed, or A3 with a justified potential. No source shows either project as a building block of a core resource or project, hence no A2.
  - **EnerTEF: justified but thin A3 → periphery.** Its service catalogue offers operational scheduling for Veolia's district-heating network. This service "recommends supply temperature setpoints, load distribution plans, and operation timelines", with outputs "suitable for direct operator use". AI recommendations meant for operators are therefore tested there, even if the interaction with the operator is not studied. **Decision of 2 November:** admitted in the periphery, with the note "A3 — justified potential". The reply is on the issue; the card, `data/projects/enertef.yml`, was created on 3 November.
  - **EnergyGuard: not yet.** Neither the CORDIS objective, nor the home page, nor the "About us" page gives an argument: no operator, no human in the loop. ICCS's page on the project did not respond on 2 November. **Decision of 2 November:** not yet; the reply is on the issue.
- **The three proposals of 6 November**, posted on GitHub by an outside contributor: Teleoperation ATO, ATO-Cargo and RSSB's human factors team, issues [#58](https://github.com/marota/human-ai-collaboration/issues/58), [#59](https://github.com/marota/human-ai-collaboration/issues/59) and [#60](https://github.com/marota/human-ai-collaboration/issues/60) of this repository. Each came with the grid filled in and sourced.
  - **Teleoperation ATO and ATO-Cargo: core, through the decision of 2 November on T1.** Their sources do not name AI, but the automation shares the action with a human: a remote operator takes over the automated train when a problem occurs, and both projects study that role (job profile, workplace, usability). Teleoperation ATO's status comes from DZSF, which commissioned it: "erfolgreich abgeschlossen" (successfully completed). ATO-Cargo's end date is left empty: the DLR page gives 12/2025, but the one-year trial on the Betuwe Route began on 24 October 2025.
  - **RSSB — Human Factors: core, as a team.** Project T1362 set out seven human factors principles for designing and operating AI in rail (T1 to T3), and an ERA page names the team (R2). RSSB is owned by its members, but its own staff carry out the research: a team, not a cluster. The seven principles get no framework card of their own (X5): they come from one research project, and will enter if they are issued as guidance or taken up as a reference.
  - **Decision of 6 November:** all three are admitted to the core. The replies are on the issues, and the cards `data/projects/teleoperation-ato.yml`, `data/projects/ato-cargo.yml` and `data/teams/rssb-hf.yml` were created the same day.

## 8. After validation

Once the grid is validated, and adjusted if needed, the form can go into the existing tools. Each step is a separate PR:

1. **CONTRIBUTING.md.** The grid replaces "Scope fit", "Scope reminders" and the "include + flag" rule.
2. **Issue form** `.github/ISSUE_TEMPLATE/suggest-initiative.yml`, in the data repository. It would get the T1 to T3 questions and one source per criterion. Its "Type" list needs redoing: it knows only the types of teams, not the six layers.
3. **PR template** `.github/PULL_REQUEST_TEMPLATE.md`, in the data repository: it would get the R, T, É and X boxes.
4. **The site's chat.** When it drafts a card, it would ask for the evidence for T1 to T3 and propose a verdict, which the maintainer confirms.
5. **A pass of the grid over the existing cards.** It is optional, and would start with the P4 cases and the cards with `low` confidence.

## Annex — the two open proposals, run through the form

Sources checked on 2026-11-02: the CORDIS records (XML format) and the websites of both projects. The issues were opened on 1 November by the site's public chat. **Decision of 2 November:** the replies are posted on the issues; the EnerTEF card, `data/projects/enertef.yml`, was created on 3 November.

### EnerTEF — [#45](https://github.com/marota/human-ai-collaboration/issues/45)

```markdown
### Candidate card
- Name, as the source gives it: EnerTEF (CORDIS: "Common European-scale Energy Artificial Intelligence Federated Testing and Experimentation Facility")
- Layer and kind: project, horizon_europe
- Sources: https://cordis.europa.eu/project/id/101172887 ; https://enertef.eu/

### Admissibility — all required
- [x] R1 Public source: CORDIS, grant agreement 101172887
- [x] R2 Sourced name: CORDIS acronym
- [x] R3 Europe: GR — coordinator: National Technical University of Athens (NTUA), Athens
- [x] R4 No duplicate: no card; AI-EFFECT is another project of the same call
- [x] R5 Layer: project, horizon_europe, call HORIZON-CL5-2024-D3-01, topic 11 (AI-EFFECT's)
- [x] R6 Status: active, from 2024-11-01 to 2027-10-31, total cost €6,687,663.75

### Anchoring
- [ ] T1 Human–AI collaboration: no source. The CORDIS objective is about testing trustworthy AI products, a federated testing facility and "AI Living Labs" between energy actors and AI developers. The website has only a service tag, "Optimization & Decision Support".
- [x] T2 Critical system: energy, power_grid · TSO, DSO, EV, BUILD and RES nodes; partners ELES (transmission system operator) and Elektro Gorenjska (distribution system operator)
- [ ] T3 Human decision: no human role described
- [ ] É1 Sourced link with the core: no. CORDIS participants have a core card — INESC TEC (inesc-tec-cpes), RWTH Aachen (rwth-acs), ELES (eles-digi) — but shared partners do not make a link (clarification of 2 November).
- [x] Supporting resource: justified A3, thin · https://enertef.eu/service/operational-scheduling-dhn · a service for the operators of Veolia's district-heating network "recommends supply temperature setpoints, load distribution plans, and operation timelines"

### Exclusions
- [x] X1 · [x] X2 · [ ] X3: the project tests AI products (trustworthiness, compliance), not their use by a human; this is what closes the core · [x] X4 · [x] X5 · [x] X6

### Verdict
- [x] To be decided · question: is the scheduling service for Veolia enough as a justified potential? If so, admitted in ecosystem, with the note "A3 — justified potential".
- Decision of 2 November: yes, admitted in ecosystem with that note (reply on #45).
- Corrections, if it enters: start '2024-11' instead of 2025-08; funding (grant agreement, call) and budget from CORDIS; decision_support, explainability and digital_twins have no source (a maintainer's field), only decision_support rests on the Veolia service.
- Card created on 3 November with these corrections. Of the proposed focus_areas, it keeps decision_support and power_grid; explainability, digital_twins and energy_markets are left to the maintainer.
```

### EnergyGuard — [#46](https://github.com/marota/human-ai-collaboration/issues/46)

```markdown
### Candidate card
- Name, as the source gives it: EnergyGuard (CORDIS); the website says "EnergyGuard TEF"
- Layer and kind: project, horizon_europe
- Sources: https://cordis.europa.eu/project/id/101172705 ; https://energy-guard.eu/

### Admissibility — all required
- [x] R1 Public source: CORDIS, grant agreement 101172705
- [x] R2 Sourced name: CORDIS acronym and website title
- [x] R3 Europe: GR — coordinator: ICCS (DSS laboratory), Athens
- [x] R4 No duplicate: no card
- [x] R5 Layer: project, horizon_europe, call HORIZON-CL5-2024-D3-01, topic 11
- [x] R6 Status: active, from 2025-01-01 to 2027-12-31, total cost €5,752,248.50

### Anchoring
- [ ] T1 Human–AI collaboration: no source. The CORDIS objective is about digital twins as test environments, an acceptance environment, an open database of AI risks, and cybersecurity and trustworthy-AI assessments. The name of the coordinating laboratory, "Decision Support Systems", is not evidence.
- [x] T2 Critical system: energy, power_grid · digital twin of the Portuguese transmission grid, CIEMAT microgrid, hydrogen platforms
- [ ] T3 Human decision: no human role described
- [ ] É1 Sourced link with the core: no. CEA (through CEA LITEN) and LuxProvide are participants, but shared partners do not make a link (clarification of 2 November).
- [ ] Supporting resource: unjustified A3 — neither the CORDIS objective, nor the home page, nor the "About us" page mentions operators or a human in the loop

### Exclusions
- [x] X1 · [x] X2 · [ ] X3: same case as EnerTEF · [x] X4 · [x] X5 · [x] X6

### Verdict
- [x] Refused for now · reason: unjustified A3. It will enter when a source shows a human–AI use, or a recommendation meant for operators tested on the facility, for example in the pilot on the digital twin of the Portuguese transmission grid.
- Decision of 2 November: confirmed (reply on #46).
- To take up then: start '2025-01' and end '2027-12' (the proposal said "2024", with no end); funding and budget from CORDIS.
```
