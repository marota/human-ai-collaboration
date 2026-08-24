# Mise en ligne — procédure

Trois étapes. Compter une demi-journée pour la 1 et la 2, le reste au fil de l'eau.

---

## 1. Le site (~1 h)

1. Créer un dépôt public sur GitHub. Deux choix de nom :
   - `marota.github.io` → l'URL sera `https://marota.github.io` (laisser `baseurl: ""` dans `_config.yml`)
   - `human-ai-decision` → l'URL sera `https://marota.github.io/human-ai-decision` (mettre `baseurl: "/human-ai-decision"`)
2. Dans `_config.yml`, remplacer `<USERNAME>` et `<REPO>`.
3. Pousser le contenu de ce dossier à la racine du dépôt.
4. Sur GitHub : **Settings → Pages → Source: Deploy from a branch → `main` / `(root)`**.
5. Attendre 1–2 minutes. Le site est en ligne.

Pour prévisualiser en local avant de pousser (facultatif) :
```bash
bundle install
bundle exec jekyll serve      # http://localhost:4000
```

---

## 2. Le DOI Zenodo (~2 h, dont la compilation du PDF)

C'est ce qui rend la série **citable** et la sort du registre réseau social.

1. **Créer un ORCID** si ce n'est pas fait : <https://orcid.org/register>. Cinq minutes.
   Un jury institutionnel le cherchera ; renseigner l'ORCID dans `_config.yml`,
   `CITATION.cff` et `about.md`.
2. **Compiler les dix posts en un seul PDF** : page de titre, résumé d'une page,
   les dix parties dans l'ordre, la bibliographie de `references.md` à la fin.
   Nettoyer au passage : emojis, hashtags, appels à commentaire, et surtout
   **unifier la numérotation** (les posts annoncent « 1/3 » et « 5/6 » —
   incohérence visible sur un document de candidature).
3. Aller sur <https://zenodo.org>, se connecter **avec l'ORCID** (pas avec GitHub :
   ça lie proprement le dépôt à ton identifiant chercheur).
4. **New upload** → type `Publication` → sous-type `Preprint` ou `Report`.
   Titre, auteur + ORCID, licence CC-BY-4.0, mots-clés (voir `CITATION.cff`).
   Ajouter l'URL du site et celle de la vidéo dans les *Related identifiers*.
5. **Publish** → le DOI est frappé immédiatement.
6. Reporter le DOI dans `index.md`, `series.md`, `CITATION.cff` et le CV.

**Astuce versionnage :** Zenodo gère les versions. Si tu ajoutes des parties plus
tard, tu publies une nouvelle version sous le même DOI « concept ».

**Variante à envisager en parallèle :** un dépôt sur [HAL](https://hal.science).
Pour un profil français visant l'écosystème Inria / INESIA, le signal est utile,
et le coût marginal est faible une fois le PDF prêt.

---

## 3. Les pages projets (au fil de l'eau)

`projects/hermes-agent-harness.md` et `projects/ambient-ai-scribe.md` sont des
gabarits structurés pour un lecteur qui évalue des méthodes, pas du code.

Trois niveaux possibles, par ordre de force :
1. **Dépôt public nettoyé** — le plus convaincant.
2. **Dépôt public contenant README, doc et protocoles, code privé** — inhabituel
   mais parfaitement défendable, et ça montre que tu sais séparer ce qui se publie
   de ce qui ne se publie pas.
3. **Page publique décrivant un dépôt privé** — c'est le rôle de ces gabarits.
   Sur un poste d'évaluateur, la méthode compte plus que l'implémentation.

Pour `Ambient AI Scribe`, la section *Data governance* est la plus importante :
des enregistrements d'opérateurs sont des données personnelles, et montrer que tu
as arbitré ces questions vaut autant que la performance technique.

---

## Arborescence

```
.
├── _config.yml                 # remplacer <USERNAME> et <REPO>
├── index.md                    # accueil
├── series.md                   # sommaire de la série
├── video.md                    # vidéo intégrée + contexte
├── references.md               # bibliographie annotée
├── about.md                    # bio courte + liens
├── CITATION.cff                # métadonnées de citation (GitHub l'affiche)
├── Gemfile · .gitignore · LICENSE
├── _series/
│   ├── 01-from-augmentation-to-cognitive-surrender.md   # pré-rempli
│   └── 02..10-titre-a-remplacer.md                      # gabarits
├── projects/
│   ├── index.md
│   ├── hermes-agent-harness.md
│   └── ambient-ai-scribe.md
└── assets/img/
```

Les emplacements à compléter sont marqués `[A COMPLETER]` et `TODO`.
Pour tous les repérer : `grep -rn "A COMPLETER\|TODO" .`
