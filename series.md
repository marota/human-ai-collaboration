---
layout: page
title: The series
permalink: /series/
---

Ten posts, written between 2025 and 2026, on human–AI joint decision-making in
critical operations. Each one takes a piece of the cognitive systems engineering
literature and asks what it implies for systems being deployed today.

{% assign parts = site.series | sort: "part" %}
{% for p in parts %}
### {{ p.part }}. [{{ p.title }}]({{ p.url | relative_url }})

{% if p.summary %}{{ p.summary }}{% endif %}
{% if p.anchors %}*Builds on: {{ p.anchors }}*{% endif %}

{% endfor %}

---

## Citing this series

<!-- TODO: remplacer par le DOI Zenodo une fois publié -->
> Marot, A. (2026). *Human–AI Joint Decision-Making in Critical Systems: a ten-part series.*
> Zenodo. DOI: 10.5281/zenodo.XXXXXXX
