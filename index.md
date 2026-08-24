---
layout: home
title: Home
---

AI is moving from tools into decision systems that shape critical infrastructure —
transport, energy, healthcare, telecoms, industry, defence. The question is no
longer whether these systems can augment expert judgement. Over the past decade
I've established that they can.

The open question is whether we are ready to deploy them reliably and trust them
confidently. As of now, we are not.

This site collects the work behind that claim.

---

## The series

A ten-part series on how humans and AI actually make joint decisions in critical
operations — what erodes expert judgement, what makes a partnership designable,
and what would have to be measured for oversight to be more than a compliance box.

<!-- TODO: si tu préfères une liste manuelle ordonnée, remplacer ce bloc par des liens explicites -->
{% assign parts = site.series | sort: "part" %}
<ol>
{% for p in parts %}
  <li><a href="{{ p.url | relative_url }}">{{ p.title }}</a>
  {% if p.subtitle %}— <em>{{ p.subtitle }}</em>{% endif %}</li>
{% endfor %}
</ol>

[Read the series in order →]({{ '/series/' | relative_url }})

## Explainer video

A synthesis of the series, and a perspective on what a large European AI facility
for human–AI collaboration in critical systems could look like.

[Watch →]({{ '/video/' | relative_url }})

## Projects

Working code and evaluation protocols behind the arguments.

[See the projects →]({{ '/projects/' | relative_url }})

## References

The literature this work builds on — cognitive systems engineering, human factors,
regulatory frameworks and open evaluation environments.

[Browse the references →]({{ '/references/' | relative_url }})

---

*A permanent, citable version of the series is archived on Zenodo:*
<!-- TODO: coller le DOI une fois le dépôt Zenodo publié -->
`DOI: 10.5281/zenodo.XXXXXXX`
