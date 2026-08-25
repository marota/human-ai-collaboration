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

## 3. Les pages projets

Les quatre pages de `projects/` sont écrites :

| Page | Dépôt | Statut |
|---|---|---|
| `co-study4grid.md` | [Co-Study4Grid](https://github.com/marota/Co-Study4Grid) | public, MPL-2.0 |
| `ambient-ai-scribe.md` | `OperatorAudioScribe` | privé — la page **est** le livrable public |
| `personal-agent-harness.md` | montage local (scripts + config) | non versionné |
| `index.md` | — | sommaire : projets perso / collectifs / challenges |

Le parti pris : elles décrivent **ce qui est mesuré et comment**, pas le code.
Sur un poste d'évaluateur, la méthode compte plus que l'implémentation — et pour
un dépôt privé, c'est la seule chose publiable.

Deux sections méritent d'être maintenues à jour en priorité :

- **`Ambient AI Scribe` → Data governance.** Des enregistrements d'opérateurs sont
  des données personnelles. La page décrit les garde-fous *architecturaux* (tout
  en local, entrées privées jamais versionnées, sortie de mesure agrégée par
  défaut) plutôt qu'une intention.
- **Les résultats négatifs**, partout. Le « peut-on diviser le WER par 2 ? → non »
  et la combinaison qui a *empiré* le WER valent plus, pour la crédibilité d'un
  évaluateur, que les chiffres favorables.

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
├── _layouts/                   # thème maison : default, home, page, post, series
├── _includes/                  # head, header, footer, series-list, lead-figure
├── _series/
│   ├── 01..09-<titre>.md        # les neuf posts publiés, nettoyés
│   └── 10-titre-a-remplacer.md  # gabarit : titre entre [ ] = « In preparation »
├── projects/
│   ├── index.md
│   ├── co-study4grid.md
│   ├── personal-agent-harness.md
│   └── ambient-ai-scribe.md
├── map.md                      # carte de l'écosystème européen
└── assets/
    ├── css/main.css            # toute l'apparence du site
    ├── map/eu-hai-map.html     # carte autonome (Leaflet, données inlinées)
    └── img/                    # favicon, illustrations série et projets
```

---

## Apparence

Le site n'utilise pas de thème externe : les gabarits sont dans `_layouts/` et
`_includes/`, et **toute l'apparence tient dans `assets/css/main.css`**. Pas de
SCSS, pas de build, pas de dépendance réseau — la police est une pile système à
empattements, donc pas de Google Fonts et pas de requête tierce.

Les couleurs sont des variables CSS déclarées en haut du fichier (`:root`), avec
un jeu équivalent pour le mode sombre (`prefers-color-scheme: dark`). Changer
l'accent du site = changer `--accent` / `--accent-deep` aux deux endroits.

Deux conventions utiles dans les gabarits :

- **Front matter d'une page** : `eyebrow` (surtitre), `deck` (chapô sous le
  titre), `status` (badge, pages projets), `prose_class: prose--wide` pour une
  colonne de texte plus large.
- **Série** : tant que le `title:` d'un post commence par `[`, il est considéré
  comme non écrit — il apparaît en « In preparation », sans lien. Remplacer le
  titre suffit à l'activer partout (accueil, sommaire, navigation précédent /
  suivant).

La navigation principale se règle dans `_config.yml`, clé `nav:` — l'ordre de la
liste est l'ordre affiché.

Les emplacements à compléter sont marqués `[A COMPLETER]` et `TODO`.
Pour tous les repérer : `grep -rn "A COMPLETER\|TODO" .`
