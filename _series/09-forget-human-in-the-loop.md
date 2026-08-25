---
part: "09"
title: "Forget \"human in the loop\""
subtitle: "How do you actually make joint decisions with AI"
summary: "Rasmussen's Decision Ladder and Lundberg's Joint Control Framework give diagnostic blueprints for situated decisions — you can't build a seamless human-AI partnership if you treat the joint decision like a black box."
anchors: "Rasmussen; Lundberg"
date: 2026-07-27
phase: "Lessons & perspectives"
image: /assets/img/series/09-decision-ladder-joint-control.png
image_alt: >-
  Two frameworks side by side. The Decision Ladder breaks a single agent's
  decision into five rungs: information, interpretation, judgment, decision,
  action. The Joint Control Framework plots perception, decision and action
  points for the human operator and the computer across the levels why, what and
  how, over time.
image_caption: >-
  Two frameworks to understand and divide the decision between humans and AI —
  the Decision Ladder (Rasmussen et al.) and the Joint Control Framework
  (Lundberg et al.).
---

Most teams stop at putting a human somewhere in the AI workflow. But effective collaboration requires scrutinising how decisions are actually made in the real world — treating the partnership as a unified whole, and making interactions visible to expose risks, bottlenecks, and cognitive mismatches.

To build better partnerships, we have to trace how the science of decision-making has evolved.

Back in the 1980s, Rasmussen's Decision Ladder — born from analysing operators in nuclear power plants — broke complex decisions down into distinct cognitive rungs, from raw signal up to interpretation, judgment, and action. It showed that experts don't climb every rung sequentially; they take intuitive shortcuts based on deep experience. And it proved that to design effective support tools, you first have to make the human's real-world reasoning visible.

More recently, the Joint Control Framework (Jonas Lundberg et al.) extended that ladder from a single operator to multi-agent teams of humans and AI — currently being applied in the AI4REALNET project. It treats the partnership as a whole, mapping perception, decision, and action across both agents over time and across the levels of *why*, *what*, and *how*. It makes the seams of collaboration visible, helping teams pinpoint silent bottlenecks, control mismatches, and areas where responsibility blurs between human and machine.

These frameworks make the decision process tangible. They give us the diagnostic blueprints needed to improve situated decisions and design stronger collaborative workflows. This is the through-line of the whole series: you can't build a seamless human-AI partnership if you treat the joint decision like a black box.

## References

- **Rasmussen, J.** (1976). *Outlines of a Hybrid Model of the Process Plant Operator.* In Sheridan, T. B. & Johannsen, G. (Eds.), *Monitoring Behaviour and Supervisory Control*, Plenum — and **Rasmussen, J., Pejtersen, A. M., & Goodstein, L. P.** (1994). *[Cognitive Systems Engineering](https://www.wiley.com/en-us/Cognitive+Systems+Engineering-p-9780471011989)*, Wiley.
- **Lundberg, J., & Johansson, B. J. E.** (2021). *A framework for describing interaction between human operators and autonomous, automated, and manual control systems.* [Cognition, Technology & Work, 23(3), 381–401](https://link.springer.com/article/10.1007/s10111-020-00637-w).

---

*Part {{ page.part }} of [a ten-part series]({{ '/series/' | relative_url }}) on human--AI joint decision-making in critical systems.*
