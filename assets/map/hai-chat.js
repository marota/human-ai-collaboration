/* The map's chat column — loaded only when a reader asks for it.
 *
 * eu-hai-map.html is a reading surface: it loads three local files and asks the
 * network for nothing. This file is the exception, and it is deliberately a
 * separate one. It arrives only when the page is opened with `?chat=1`, which
 * is only useful with the local server in `chat/` running, so every reader of
 * the published map still gets the page the specification describes.
 *
 * Everything the chat needs from the map comes through window.HAI_CHAT_HOST,
 * set by that opt-in: the entity index, the language, esc(), the toast, and the
 * card opener. Everything it needs from the model and from GitHub goes through
 * the local server. Nothing here writes to the map — a proposal ends as a
 * GitHub issue a maintainer reviews.
 *
 * Code MIT, like the rest of the interface.
 */
'use strict';
(function () {
  const HOST = window.HAI_CHAT_HOST;
  if (!HOST) return;
  const { esc, byId, openEntity, toast } = HOST;
  const lang = () => HOST.lang();

  // ---------- words ----------
  // Both languages, like the rest of the interface. The model answers in the
  // reader's language; this is the furniture around it.
  const WORDS = {
    fr: {
      pill: 'Chat', title: 'Chat', close: 'Masquer le chat',
      placeholder: 'Posez une question sur la carte, ou signalez un manque…',
      send: 'Envoyer', stop: 'Arrêter', enter: 'Entrée pour envoyer',
      thinking: 'Le modèle rédige…', clear: 'Effacer',
      intro: 'Je réponds à partir des fiches de la carte, et de rien d’autre.',
      introAsk: 'Par exemple :',
      ex1: 'Qui travaille sur la conduite de réseau électrique en France ?',
      ex2: 'Quelles équipes sont dans le consortium AI4REALNET ?',
      ex3: 'Que contient la carte sur l’aviation ?',
      introAdd: 'Vous pouvez aussi signaler un manque ou une erreur : je prépare une '
        + 'fiche à relire, et j’ouvre une issue GitHub qu’un mainteneur valide.',
      sources: 'Fiches consultées',
      offline: 'Le serveur de chat local ne répond pas.',
      offlineHow: 'Lancez-le depuis le dépôt, puis rechargez :',
      offlineModel: 'Ollama ne répond pas à l’adresse configurée.',
      offlineModelPull: 'Modèle absent — tirez-le avec :',
      ready: 'prêt', model: 'modèle',
      // proposal
      propAdd: 'Proposer un ajout', propFix: 'Proposer une correction',
      stepRef: '1 · La référence', stepDraft: '2 · La fiche', stepIssue: '3 · L’issue',
      refAsk: 'La page qui documente cette entité — site officiel, page de projet, '
        + 'fiche CORDIS. Elle reste sur la fiche comme source.',
      refName: 'Nom de l’entité', refUrl: 'URL de la référence',
      refCheck: 'Vérifier la référence', refChecking: 'Lecture de la page…',
      refSkip: 'Continuer sans référence',
      layerAsk: 'Quelle couche ?',
      layer: { project: 'Projet / programme', team: 'Équipe', commons: 'Commun',
        framework: 'Cadre' },
      draftGo: 'Rédiger la fiche', draftWait: 'Rédaction de la fiche par le modèle local — '
        + 'comptez une à deux minutes.',
      draftRetry: 'Rédiger à nouveau',
      formIntro: 'Relisez et complétez. Rien n’est ajouté à la carte : ce texte part '
        + 'dans une issue GitHub.',
      missing: n => n === 1 ? 'Un champ obligatoire reste à remplir'
        : `${n} champs obligatoires restent à remplir`,
      okToPost: 'La proposition passe les contrôles.',
      more: 'Champs complémentaires', yaml: 'Voir le YAML', changes: 'Ce qui change',
      onMap: 'Sur la carte', proposed: 'Proposé',
      preview: 'Prévisualiser l’issue', posting: 'Ouverture de l’issue…',
      post: 'Ouvrir l’issue sur GitHub', posted: 'Issue ouverte',
      postedNote: 'Un mainteneur la relira avant qu’elle devienne une pull request '
        + 'sur le dépôt de données.',
      cancel: 'Abandonner', back: 'Retour',
      noGh: 'GitHub n’est pas joignable : ',
      required: 'obligatoire', dryRun: 'mode essai — rien n’est publié',
      yes: 'Oui', no: 'Non', add: 'Ajouter', remove: 'Retirer',
      role: 'Rôle', org: 'Organisation', country: 'Pays',
      sendFirst: 'Dites-moi d’abord ce qui manque, en une phrase.',
    },
    en: {
      pill: 'Chat', title: 'Chat', close: 'Hide the chat',
      placeholder: 'Ask about the map, or report something missing…',
      send: 'Send', stop: 'Stop', enter: 'Enter to send',
      thinking: 'The model is writing…', clear: 'Clear',
      intro: 'I answer from the cards on this map, and from nothing else.',
      introAsk: 'For instance:',
      ex1: 'Who works on power-grid operations in France?',
      ex2: 'Which teams are in the AI4REALNET consortium?',
      ex3: 'What does the map hold on aviation?',
      introAdd: 'You can also report something missing or wrong: I draft a card for '
        + 'you to check, and open a GitHub issue for a maintainer to review.',
      sources: 'Cards consulted',
      offline: 'The local chat server is not answering.',
      offlineHow: 'Start it from the repository, then reload:',
      offlineModel: 'Ollama is not answering at the configured address.',
      offlineModelPull: 'Model not pulled — get it with:',
      ready: 'ready', model: 'model',
      propAdd: 'Propose an addition', propFix: 'Propose a correction',
      stepRef: '1 · The reference', stepDraft: '2 · The card', stepIssue: '3 · The issue',
      refAsk: 'The page that documents this entity — official site, project page, '
        + 'CORDIS record. It stays on the card as its source.',
      refName: 'Name of the entity', refUrl: 'Reference URL',
      refCheck: 'Check the reference', refChecking: 'Reading the page…',
      refSkip: 'Carry on without a reference',
      layerAsk: 'Which layer?',
      layer: { project: 'Project / programme', team: 'Team', commons: 'Commons',
        framework: 'Framework' },
      draftGo: 'Draft the card', draftWait: 'The local model is drafting the card — '
        + 'give it a minute or two.',
      draftRetry: 'Draft it again',
      formIntro: 'Read it over and fill in the gaps. Nothing is added to the map: this '
        + 'text goes into a GitHub issue.',
      missing: n => n === 1 ? 'One required field is still empty'
        : `${n} required fields are still empty`,
      okToPost: 'The proposal passes its checks.',
      more: 'Further fields', yaml: 'Show the YAML', changes: 'What changes',
      onMap: 'On the map', proposed: 'Proposed',
      preview: 'Preview the issue', posting: 'Opening the issue…',
      post: 'Open the issue on GitHub', posted: 'Issue opened',
      postedNote: 'A maintainer reviews it before it becomes a pull request on the '
        + 'data repository.',
      cancel: 'Give up', back: 'Back',
      noGh: 'GitHub is not reachable: ',
      required: 'required', dryRun: 'dry run — nothing is posted',
      yes: 'Yes', no: 'No', add: 'Add', remove: 'Remove',
      role: 'Role', org: 'Organisation', country: 'Country',
      sendFirst: 'Tell me first what is missing, in a sentence.',
    },
  };
  const w = (k) => {
    const v = (WORDS[lang()] || WORDS.en)[k];
    return v == null ? (WORDS.en[k] ?? k) : v;
  };

  // ---------- where the server is ----------
  const PARAMS = new URLSearchParams(location.search);
  // Same origin when the chat server also serves the page, which is the
  // documented way to run it. The override is for a Jekyll dev server on
  // another port — still this machine, and the server only accepts loopback.
  const BASES = (() => {
    const given = PARAMS.get('chatapi');
    if (given) return [given.replace(/\/+$/, '')];
    const here = location.origin && location.origin !== 'null' ? [''] : [];
    return here.concat(['http://127.0.0.1:8765']);
  })();
  let BASE = BASES[0];

  const api = (path, opts) => fetch(BASE + path, opts);

  const S = {
    log: [],          // {role, text, ids?}
    streaming: false,
    ac: null,
    health: null,
    prop: null,       // the live proposal, see startProposal()
  };

  const LOG_KEY = 'hai-map-chat-log';

  // ---------- styles ----------
  // Injected rather than shipped in the page's <style>: the page keeps one
  // stylesheet describing the reading surface, and this one arrives with the
  // column it styles. The names and the variables are the page's own.
  const CSS = `
  #chat{display:none;flex-direction:column;height:100vh;overflow:hidden;background:var(--surface);
    border-left:1px solid var(--rule);min-width:0}
  body.chat-open #chat{display:flex}
  body.chat-open #app{grid-template-columns:312px 1fr 380px}
  body.sb-hidden.chat-open #app{grid-template-columns:1fr 380px}
  body.chat-open .ctl-tr{max-width:calc(100vw - 312px - 380px - 28px)}
  body.sb-hidden.chat-open .ctl-tr{max-width:calc(100vw - 380px - 28px)}
  /* Both open: one column, split in half — the feed above, the chat below.
     They answer the same question from two directions ("what is in view" and
     "what about it"), so taking the feed away to make room for the chat threw
     out the thing the chat is talking about. The right column becomes two grid
     rows; the sidebar and the stage span both. */
  body.chat-open.feed-open #app{grid-template-rows:1fr 1fr}
  body.chat-open.feed-open #sidebar,
  body.chat-open.feed-open #stage{grid-row:1 / -1}
  body.chat-open.feed-open #feed,
  body.chat-open.feed-open #chat{grid-column:-2 / -1;height:auto;min-height:0}
  body.chat-open.feed-open #feed{grid-row:1}
  body.chat-open.feed-open #chat{grid-row:2;border-top:1px solid var(--rule)}
  body.chat-open.feed-open .ctl-tr{max-width:calc(100vw - 312px - 380px - 28px)}
  body.sb-hidden.chat-open.feed-open .ctl-tr{max-width:calc(100vw - 380px - 28px)}
  .ch-head{flex:none;display:flex;align-items:center;gap:8px;padding:12px 14px 10px;
    border-bottom:1px solid var(--rule)}
  .ch-title{flex:1;font-size:10.5px;font-weight:600;text-transform:uppercase;
    letter-spacing:.11em;color:var(--ink-faint)}
  .ch-title em{font-style:normal;text-transform:none;letter-spacing:normal;margin-left:6px;
    color:var(--ink-faint);font-size:10.5px}
  .ch-dot{display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:5px;
    background:var(--ink-faint);vertical-align:1px}
  .ch-dot.on{background:#10b981}
  .ch-dot.off{background:#dc2626}
  .ch-log{flex:1;overflow-y:auto;overscroll-behavior:contain;padding:12px 14px 18px}
  .ch-msg{margin:0 0 14px}
  .ch-msg.me{text-align:right}
  .ch-msg.me p{display:inline-block;text-align:left;background:var(--accent-wash);
    border:1px solid var(--rule);border-radius:10px 10px 2px 10px;padding:7px 10px;margin:0;
    max-width:88%;font-size:13px;line-height:1.5}
  .ch-msg.bot{font-size:13.5px;line-height:1.62;color:var(--ink)}
  .ch-msg.bot p{margin:0 0 8px}
  .ch-msg.bot ul{margin:0 0 8px;padding-left:18px}
  .ch-msg.bot li{margin:0 0 3px}
  .ch-msg.bot code{font-family:var(--mono);font-size:11.5px;background:var(--surface-alt);
    padding:1px 4px;border-radius:4px}
  .ch-msg.bot a{color:var(--accent);text-decoration:underline;text-underline-offset:2px}
  .ch-msg.bot a:hover{color:var(--accent-deep)}
  .ch-msg.sys{font-size:12px;line-height:1.55;color:var(--ink-soft);background:var(--surface-alt);
    border:1px solid var(--rule);border-radius:9px;padding:9px 11px}
  .ch-msg.sys code{font-family:var(--mono);font-size:11px;display:block;margin-top:5px;
    padding:6px 8px;background:var(--surface);border:1px solid var(--rule);border-radius:6px;
    overflow-x:auto;white-space:pre}
  .ch-cursor{display:inline-block;width:6px;height:13px;background:var(--ink-faint);
    animation:ch-blink 1s steps(2) infinite;vertical-align:-2px}
  @keyframes ch-blink{50%{opacity:0}}
  .ch-src{margin:0 0 12px}
  .ch-src-h{font-size:9.5px;font-weight:600;text-transform:uppercase;letter-spacing:.1em;
    color:var(--ink-faint);margin-bottom:5px}
  .ch-chip{display:inline-block;font-size:11px;line-height:1.3;padding:3px 7px;margin:0 4px 4px 0;
    border:1px solid var(--rule);border-radius:999px;background:var(--surface-alt);
    color:var(--ink-soft);cursor:pointer;max-width:100%;overflow:hidden;text-overflow:ellipsis;
    white-space:nowrap}
  .ch-chip:hover{border-color:var(--accent);color:var(--accent)}
  .ch-foot{flex:none;border-top:1px solid var(--rule);padding:10px 12px 12px}
  .ch-input{width:100%;resize:none;font:inherit;font-size:13px;line-height:1.5;padding:8px 9px;
    border:1px solid var(--rule-strong);border-radius:8px;background:var(--paper);color:var(--ink)}
  .ch-input:focus{outline:none;border-color:var(--accent)}
  .ch-input:disabled{opacity:.6}
  .ch-row{display:flex;align-items:center;gap:8px;margin-top:7px}
  .ch-hint{flex:1;font-size:10.5px;color:var(--ink-faint)}
  .ch-btn{font:inherit;font-size:11.5px;padding:5px 11px;border:1px solid var(--rule-strong);
    border-radius:7px;background:var(--surface);color:var(--ink);cursor:pointer}
  .ch-btn:hover{border-color:var(--accent);color:var(--accent)}
  .ch-btn[disabled]{opacity:.45;cursor:default;border-color:var(--rule)}
  .ch-btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
  .ch-btn.primary:hover{background:var(--accent-deep);border-color:var(--accent-deep);color:#fff}
  .ch-btn.quiet{border-color:transparent;color:var(--ink-faint);padding:5px 6px}
  .ch-btn.quiet:hover{color:var(--accent)}
  .ch-ex{display:block;width:100%;text-align:left;font:inherit;font-size:12px;line-height:1.45;
    color:var(--ink-soft);background:none;border:0;border-left:2px solid var(--rule);
    padding:2px 0 2px 9px;margin:0 0 6px;cursor:pointer}
  .ch-ex:hover{color:var(--accent);border-left-color:var(--accent)}
  /* the proposal card */
  .ch-prop{border:1px solid var(--rule-strong);border-radius:10px;background:var(--paper);
    padding:11px 12px 12px;margin:0 0 14px;box-shadow:var(--shadow-sm)}
  .ch-prop-h{display:flex;align-items:baseline;gap:7px;margin-bottom:8px}
  .ch-prop-t{flex:1;font-family:var(--serif);font-size:13.5px;font-weight:600;line-height:1.3}
  .ch-prop-s{font-size:9.5px;font-weight:600;text-transform:uppercase;letter-spacing:.09em;
    color:var(--accent)}
  .ch-prop p{font-size:12px;line-height:1.55;color:var(--ink-soft);margin:0 0 9px}
  .ch-fields{display:grid;gap:9px}
  .ch-f{display:grid;gap:3px}
  .ch-f > label{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;
    color:var(--ink-faint)}
  .ch-f > label span{color:var(--accent);text-transform:none;letter-spacing:normal;
    font-weight:400;margin-left:4px}
  .ch-f input,.ch-f select,.ch-f textarea{font:inherit;font-size:12.5px;padding:5px 7px;
    border:1px solid var(--rule-strong);border-radius:6px;background:var(--surface);
    color:var(--ink);width:100%}
  .ch-f textarea{resize:vertical;min-height:62px;line-height:1.5}
  .ch-f input:focus,.ch-f select:focus,.ch-f textarea:focus{outline:none;border-color:var(--accent)}
  .ch-f.bad input,.ch-f.bad select,.ch-f.bad textarea{border-color:#dc2626}
  .ch-f .ch-err{font-size:10.5px;color:#dc2626;line-height:1.4}
  .ch-f .ch-help{font-size:10.5px;color:var(--ink-faint);line-height:1.4}
  .ch-multi{display:flex;flex-wrap:wrap;gap:4px 10px;padding:2px 0}
  .ch-multi label{display:inline-flex;align-items:center;gap:4px;font-size:11.5px;
    color:var(--ink-soft);cursor:pointer}
  .ch-multi input{width:auto;accent-color:var(--accent)}
  .ch-rows{display:grid;gap:5px}
  .ch-orgrow{display:grid;grid-template-columns:1fr 84px 46px 22px;gap:4px;align-items:center}
  .ch-orgrow button{font:inherit;font-size:13px;line-height:1;color:var(--ink-faint);
    background:none;border:0;cursor:pointer;padding:2px}
  .ch-orgrow button:hover{color:#dc2626}
  .ch-fold{margin:10px 0 0;border-top:1px solid var(--rule);padding-top:8px}
  .ch-fold > summary{font-size:10.5px;color:var(--ink-faint);cursor:pointer;list-style:none}
  .ch-fold > summary::-webkit-details-marker{display:none}
  .ch-fold > summary::before{content:'▸ ';color:var(--accent)}
  .ch-fold[open] > summary::before{content:'▾ '}
  .ch-fold pre{font-family:var(--mono);font-size:10.5px;line-height:1.5;margin:7px 0 0;
    padding:8px;background:var(--surface-alt);border:1px solid var(--rule);border-radius:6px;
    overflow-x:auto;white-space:pre;max-height:260px}
  .ch-state{font-size:11.5px;line-height:1.5;margin:9px 0 0;padding:7px 9px;border-radius:7px}
  .ch-state.ok{background:rgba(16,185,129,.1);color:var(--ink)}
  .ch-state.warn{background:var(--accent-wash);color:var(--ink)}
  .ch-state.bad{background:rgba(220,38,38,.09);color:var(--ink)}
  .ch-state ul{margin:4px 0 0;padding-left:16px}
  .ch-acts{display:flex;flex-wrap:wrap;align-items:center;gap:7px;margin-top:11px}
  .ch-diff{width:100%;border-collapse:collapse;font-size:11px;margin:0 0 9px}
  .ch-diff th{text-align:left;font-size:9.5px;text-transform:uppercase;letter-spacing:.08em;
    color:var(--ink-faint);font-weight:600;padding:0 6px 3px 0;border-bottom:1px solid var(--rule)}
  .ch-diff td{padding:4px 6px 4px 0;border-bottom:1px solid var(--rule);vertical-align:top;
    line-height:1.45;color:var(--ink-soft)}
  .ch-diff td.now{color:var(--ink)}
  .ch-diff code{font-family:var(--mono);font-size:10px}
  .ch-spin{display:inline-block;width:9px;height:9px;border:2px solid var(--rule-strong);
    border-top-color:var(--accent);border-radius:50%;animation:ch-spin .8s linear infinite;
    margin-right:6px;vertical-align:-1px}
  @keyframes ch-spin{to{transform:rotate(360deg)}}
  @media (prefers-reduced-motion:reduce){.ch-spin,.ch-cursor{animation:none}}
  @media (max-width:840px){
    #chat{position:fixed;top:0;right:0;bottom:0;width:min(94vw,380px);z-index:91;
      box-shadow:var(--shadow-lg)}
    body.chat-open #app,body.sb-hidden.chat-open #app{grid-template-columns:1fr}
    body.chat-open .ctl-tr,body.sb-hidden.chat-open .ctl-tr{max-width:calc(100vw - 28px)}
    /* Below 840px both are fixed drawers over the map, so the halves are
       top and bottom of the drawer rather than grid rows. */
    body.chat-open.feed-open #feed{bottom:50%}
    body.chat-open.feed-open #chat{top:50%}
  }
  @media print{#chat{display:none !important}}
  `;

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  // ---------- markup ----------
  const pill = document.createElement('button');
  pill.className = 'pill';
  pill.id = 'chat-pill';
  pill.setAttribute('aria-pressed', 'false');
  pill.innerHTML = `<span>${esc(w('pill'))}</span>`;
  // Straight after the Feed pill, whose place in the column it takes: same
  // group, same reading order, and the tab order stays links → my map → feed →
  // chat → language → help.
  const feedPill = document.getElementById('feed-pill');
  if (feedPill) feedPill.insertAdjacentElement('afterend', pill);
  else (document.querySelector('.ctl-group') || document.body).appendChild(pill);

  const panel = document.createElement('aside');
  panel.id = 'chat';
  panel.setAttribute('aria-label', w('title'));
  panel.dataset.screenLabel = w('title');
  panel.innerHTML = `
    <div class="ch-head">
      <span class="ch-title">${esc(w('title'))}<em id="ch-state"></em></span>
      <button class="ch-btn quiet" id="ch-clear" type="button">${esc(w('clear'))}</button>
      <button class="dt-close" id="ch-close" type="button" aria-label="${esc(w('close'))}">×</button>
    </div>
    <div class="ch-log" id="ch-log"></div>
    <div class="ch-foot">
      <textarea class="ch-input" id="ch-input" rows="3"
        placeholder="${esc(w('placeholder'))}"></textarea>
      <div class="ch-row">
        <span class="ch-hint" id="ch-hint">${esc(w('enter'))}</span>
        <button class="ch-btn primary" id="ch-send" type="button">${esc(w('send'))}</button>
      </div>
    </div>`;
  document.getElementById('app').appendChild(panel);

  const logEl = panel.querySelector('#ch-log');
  const inputEl = panel.querySelector('#ch-input');
  const sendEl = panel.querySelector('#ch-send');
  const hintEl = panel.querySelector('#ch-hint');
  const stateEl = panel.querySelector('#ch-state');

  // ---------- a very small markdown ----------
  // The model answers in markdown. Only what it actually uses is rendered, and
  // every fragment goes through the page's esc() before any tag is added back:
  // invariant 9 holds here too. A card link survives only if its id is real —
  // an id the model invented renders as plain text rather than a dead link.
  function inline(text) {
    let s = esc(text);
    s = s.replace(/`([^`]+)`/g, (m, code) => `<code>${code}</code>`);
    s = s.replace(/\*\*([^*]+)\*\*/g, (m, b) => `<strong>${b}</strong>`);
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, (m, pre, i) => `${pre}<em>${i}</em>`);
    // [label](#id) — only for a card that exists.
    s = s.replace(/\[([^\]]+)\]\(#([a-z0-9][a-z0-9-]*)\)/g, (m, label, id) =>
      byId[id] ? `<a href="#${id}" data-card="${id}">${label}</a>` : label);
    // [label](https://…) — nothing else is turned into a link.
    s = s.replace(/\[([^\]]+)\]\((https?:&#x2F;&#x2F;[^)\s]+|https?:\/\/[^)\s]+)\)/g,
      (m, label, href) => `<a href="${href}" target="_blank" rel="noreferrer">${label}</a>`);
    return s;
  }

  function markdown(text) {
    const blocks = String(text || '').split(/\n{2,}/);
    return blocks.map((block) => {
      const lines = block.split('\n').filter((l) => l.trim() !== '');
      if (!lines.length) return '';
      if (lines.every((l) => /^\s*[-*•]\s+/.test(l))) {
        return `<ul>${lines.map((l) =>
          `<li>${inline(l.replace(/^\s*[-*•]\s+/, ''))}</li>`).join('')}</ul>`;
      }
      return `<p>${lines.map(inline).join('<br>')}</p>`;
    }).join('');
  }

  // ---------- rendering the log ----------
  function scrollDown() {
    logEl.scrollTop = logEl.scrollHeight;
  }

  function intro() {
    const ex = ['ex1', 'ex2', 'ex3'].map((k) =>
      `<button class="ch-ex" type="button" data-ask="${esc(w(k))}">${esc(w(k))}</button>`).join('');
    return `<div class="ch-msg bot"><p>${esc(w('intro'))}</p>
      <p style="color:var(--ink-faint);font-size:12px">${esc(w('introAsk'))}</p>${ex}
      <p style="color:var(--ink-faint);font-size:12px">${esc(w('introAdd'))}</p></div>`;
  }

  function sources(ids) {
    const chips = ids.filter((id) => byId[id]).map((id) =>
      `<button class="ch-chip" type="button" data-card="${esc(id)}"
        >${esc(byId[id].d.name)}</button>`).join('');
    if (!chips) return '';
    return `<div class="ch-src"><div class="ch-src-h">${esc(w('sources'))}</div>${chips}</div>`;
  }

  function render() {
    const parts = S.log.length ? [] : [intro()];
    S.log.forEach((m) => {
      if (m.role === 'user') {
        parts.push(`<div class="ch-msg me"><p>${esc(m.text)}</p></div>`);
      } else if (m.role === 'system') {
        parts.push(`<div class="ch-msg sys">${m.html}</div>`);
      } else {
        parts.push((m.ids && m.ids.length ? sources(m.ids) : '')
          + `<div class="ch-msg bot">${markdown(m.text)}`
          + (m.live ? '<span class="ch-cursor"></span>' : '') + '</div>');
      }
    });
    logEl.innerHTML = parts.join('');
    if (S.prop) logEl.appendChild(proposalCard());
    scrollDown();
  }

  // ---------- conversation ----------
  function save() {
    try {
      localStorage.setItem(LOG_KEY, JSON.stringify(S.log.slice(-24)));
    } catch (e) { /* private mode: the conversation stays in memory */ }
  }

  function restore() {
    try {
      const raw = localStorage.getItem(LOG_KEY);
      if (raw) {
        const rows = JSON.parse(raw);
        if (Array.isArray(rows)) {
          S.log = rows.filter((m) => m && typeof m.text === 'string'
            && (m.role === 'user' || m.role === 'assistant'));
        }
      }
    } catch (e) { S.log = []; }
  }

  function busy(on, hint) {
    S.streaming = on;
    inputEl.disabled = on;
    sendEl.textContent = on ? w('stop') : w('send');
    sendEl.classList.toggle('primary', !on);
    hintEl.textContent = hint || (on ? w('thinking') : w('enter'));
  }

  async function send(text) {
    const question = (text == null ? inputEl.value : text).trim();
    if (!question || S.streaming) return;
    inputEl.value = '';
    S.log.push({ role: 'user', text: question });
    // The turns to send are taken before the empty reply is pushed: a trailing
    // assistant message with no content is noise at best, and some models read
    // it as a prefill to continue.
    const outgoing = history();
    const reply = { role: 'assistant', text: '', ids: [], live: true };
    S.log.push(reply);
    render();
    busy(true);

    const ac = new AbortController();
    S.ac = ac;
    try {
      const res = await api('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lang: lang(), messages: outgoing }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        lines.forEach((line) => {
          if (!line.trim()) return;
          let ev;
          try { ev = JSON.parse(line); } catch (e) { return; }
          if (ev.t === 'retrieved') reply.ids = ev.ids || [];
          else if (ev.t === 'delta') reply.text += ev.text;
          else if (ev.t === 'propose') startProposal(ev);
          else if (ev.t === 'error') reply.text += '\n\n⚠ ' + ev.message;
          render();
        });
      }
    } catch (e) {
      if (e.name !== 'AbortError') {
        reply.text = reply.text || '';
        S.log.push({ role: 'system', html: offlineHtml(e) });
      }
    } finally {
      reply.live = false;
      S.ac = null;
      busy(false);
      render();
      save();
    }
  }

  function offlineHtml(err) {
    return `<strong>${esc(w('offline'))}</strong><br>${esc(w('offlineHow'))}
      <code>python3 chat/server.py</code>
      <span style="color:var(--ink-faint)">${esc(String(err && err.message || err))}</span>`;
  }

  // ---------- the proposal ----------
  const LAYERS = ['project', 'team', 'commons', 'framework'];

  function startProposal(ev) {
    const mode = ev.mode === 'fix' ? 'fix' : 'add';
    const target = ev.target || '';
    const entity = byId[target];
    S.prop = {
      mode,
      step: 'reference',
      target: entity ? target : '',
      layer: entity ? entity.kind : (LAYERS.includes(target) ? target : 'team'),
      name: entity ? entity.d.name : (ev.name || ''),
      url: '',
      reference: null,
      refNote: '',
      card: null,
      fields: null,
      report: null,
      changed: [],
      yaml: '',
      issue: null,
      error: '',
      pending: '',
    };
  }

  function stopProposal() {
    S.prop = null;
    render();
  }

  /** The proposal, as one card in the conversation. Rebuilt on every change —
   *  the form is small, and a single render path keeps the state honest. */
  function proposalCard() {
    const p = S.prop;
    const box = document.createElement('div');
    box.className = 'ch-prop';
    const steps = { reference: 'stepRef', draft: 'stepDraft', edit: 'stepDraft',
      issue: 'stepIssue', done: 'stepIssue' };
    box.innerHTML = `<div class="ch-prop-h">
        <span class="ch-prop-t">${esc(p.mode === 'fix'
          ? w('propFix') + (p.name ? ' — ' + p.name : '')
          : w('propAdd') + (p.name ? ' — ' + p.name : ''))}</span>
        <span class="ch-prop-s">${esc(w(steps[p.step] || 'stepRef'))}</span>
      </div>`;
    if (p.step === 'reference') box.appendChild(referenceStep());
    else if (p.step === 'draft') box.appendChild(draftingStep());
    else if (p.step === 'edit') box.appendChild(formStep());
    else if (p.step === 'issue') box.appendChild(previewStep());
    else if (p.step === 'done') box.appendChild(doneStep());
    return box;
  }

  function el(html) {
    const d = document.createElement('div');
    d.innerHTML = html;
    return d;
  }

  function referenceStep() {
    const p = S.prop;
    const layerPick = p.mode === 'add' ? `
      <div class="ch-f"><label>${esc(w('layerAsk'))}</label>
        <select data-prop="layer">${LAYERS.map((k) =>
          `<option value="${k}"${k === p.layer ? ' selected' : ''}
            >${esc(w('layer')[k])}</option>`).join('')}</select></div>` : '';
    const d = el(`<p>${esc(w('refAsk'))}</p>
      <div class="ch-fields">
        ${layerPick}
        <div class="ch-f"><label>${esc(w('refName'))}</label>
          <input type="text" data-prop="name" value="${esc(p.name)}"></div>
        <div class="ch-f"><label>${esc(w('refUrl'))}</label>
          <input type="url" data-prop="url" value="${esc(p.url)}"
            placeholder="https://…"></div>
      </div>
      ${p.refNote ? `<div class="ch-state ${p.reference && p.reference.confirms
        ? 'ok' : 'warn'}">${esc(p.refNote)}</div>` : ''}
      ${p.error ? `<div class="ch-state bad">${esc(p.error)}</div>` : ''}
      <div class="ch-acts">
        <button class="ch-btn" type="button" data-act="check"
          ${p.pending ? 'disabled' : ''}>${esc(p.pending === 'reference'
            ? w('refChecking') : w('refCheck'))}</button>
        <button class="ch-btn primary" type="button" data-act="draft"
          ${p.pending ? 'disabled' : ''}>${esc(w('draftGo'))}</button>
        <button class="ch-btn quiet" type="button" data-act="cancel">${esc(w('cancel'))}</button>
      </div>`);
    return d;
  }

  function draftingStep() {
    return el(`<p><span class="ch-spin"></span>${esc(w('draftWait'))}</p>
      <div class="ch-acts">
        <button class="ch-btn quiet" type="button" data-act="cancel">${esc(w('cancel'))}</button>
      </div>`);
  }

  // -- the editable card ----------------------------------------------

  function labelFor(path, code) {
    const taxo = HOST.taxo || {};
    const group = path === 'focus_areas' ? 'focus'
      : path === 'type' ? 'type'
        : path === 'kind' ? 'kind'
          : path === 'status' ? 'status'
            : path === 'tier' ? 'tier' : null;
    const entry = group && taxo[group] && taxo[group][code];
    if (entry) return entry[lang()] || entry.en || code;
    return String(code).replace(/_/g, ' ');
  }

  function getPath(obj, path) {
    return path.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
  }

  function setPath(obj, path, value) {
    const parts = path.split('.');
    let cur = obj;
    parts.slice(0, -1).forEach((k) => {
      if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {};
      cur = cur[k];
    });
    if (value === '' || value == null
      || (Array.isArray(value) && !value.length)) delete cur[parts.at(-1)];
    else cur[parts.at(-1)] = value;
  }

  function fieldHtml(f, value, error) {
    const id = 'chf-' + f.path.replace(/\./g, '-');
    const req = f.required ? `<span>${esc(w('required'))}</span>` : '';
    let control;
    if (f.kind === 'long') {
      control = `<textarea id="${id}" data-field="${esc(f.path)}"
        >${esc(value == null ? '' : value)}</textarea>`;
    } else if (f.kind === 'select') {
      control = `<select id="${id}" data-field="${esc(f.path)}"><option value=""></option>`
        + f.vocab.map((v) => `<option value="${esc(v)}"${v === value ? ' selected' : ''}
            >${esc(labelFor(f.path, v))}</option>`).join('') + '</select>';
    } else if (f.kind === 'multi') {
      const on = new Set(Array.isArray(value) ? value : []);
      control = `<div class="ch-multi" data-field="${esc(f.path)}">` + f.vocab.map((v) =>
        `<label><input type="checkbox" value="${esc(v)}"${on.has(v) ? ' checked' : ''}
          >${esc(labelFor(f.path, v))}</label>`).join('') + '</div>';
    } else if (f.kind === 'ids') {
      const names = (Array.isArray(value) ? value : []).map((v) =>
        byId[v] ? byId[v].d.name : v).join(', ');
      control = `<input type="text" id="${id}" data-field="${esc(f.path)}" data-ids="1"
        value="${esc((Array.isArray(value) ? value : []).join(', '))}"
        placeholder="id, id">${names ? `<div class="ch-help">${esc(names)}</div>` : ''}`;
    } else if (f.kind === 'orgs') {
      const rows = (Array.isArray(value) ? value : []);
      control = `<div class="ch-rows" data-field="${esc(f.path)}" data-orgs="1">`
        + rows.concat([{}]).map((row, i) => `<div class="ch-orgrow">
            <input type="text" data-k="org" value="${esc(row.org || '')}"
              placeholder="${esc(w('org'))}">
            <input type="text" data-k="role" value="${esc(row.role || '')}"
              placeholder="${esc(w('role'))}" list="chf-roles">
            <input type="text" data-k="country" value="${esc(row.country || '')}"
              placeholder="${esc(w('country'))}" maxlength="2">
            <button type="button" data-drop="${i}" aria-label="${esc(w('remove'))}"
              >${i < rows.length ? '×' : ''}</button></div>`).join('') + '</div>';
    } else {
      const type = f.kind === 'url' ? 'url' : f.kind === 'number' ? 'number' : 'text';
      control = `<input type="${type}" id="${id}" data-field="${esc(f.path)}"
        ${f.kind === 'number' ? 'step="any"' : ''}
        value="${esc(value == null ? '' : value)}">`;
    }
    return `<div class="ch-f${error ? ' bad' : ''}">
      <label for="${id}">${esc(f.label)}${req}</label>
      ${control}
      ${error ? `<div class="ch-err">${esc(error)}</div>` : ''}
      ${f.help && !error ? `<div class="ch-help">${esc(f.help)}</div>` : ''}</div>`;
  }

  function formStep() {
    const p = S.prop;
    const errors = {};
    ((p.report && p.report.errors) || []).forEach((e) => { errors[e.path] = e.message; });
    const missing = ((p.report && p.report.errors) || [])
      .filter((e) => /obligatoire|required/.test(e.message)).length;
    const main = p.fields.filter((f) => !f.secondary);
    const extra = p.fields.filter((f) => f.secondary);
    const draw = (f) => fieldHtml(f, getPath(p.card, f.path), errors[f.path]);

    const diffTable = p.changed && p.changed.length ? `
      <div class="ch-src-h">${esc(w('changes'))}</div>
      <table class="ch-diff"><thead><tr><th></th><th>${esc(w('onMap'))}</th>
        <th>${esc(w('proposed'))}</th></tr></thead><tbody>
        ${p.changed.map((row) => `<tr><td><code>${esc(row.path)}</code></td>
          <td>${esc(fmt(row.before))}</td>
          <td class="now">${esc(fmt(row.after))}</td></tr>`).join('')}
      </tbody></table>` : '';

    const warnings = ((p.report && p.report.warnings) || []);
    const d = el(`<p>${esc(w('formIntro'))}</p>
      ${diffTable}
      <div class="ch-fields">${main.map(draw).join('')}</div>
      <datalist id="chf-roles">${['coordinator', 'partner', 'member', 'operator', 'funder']
        .map((r) => `<option value="${r}">`).join('')}</datalist>
      ${extra.length ? `<details class="ch-fold"><summary>${esc(w('more'))}</summary>
        <div class="ch-fields" style="margin-top:8px">${extra.map(draw).join('')}</div>
      </details>` : ''}
      <details class="ch-fold"><summary>${esc(w('yaml'))}</summary>
        <pre>${esc(p.yaml || '')}</pre></details>
      <div class="ch-state ${missing || Object.keys(errors).length ? 'warn' : 'ok'}">
        ${esc(missing ? w('missing')(missing)
          : Object.keys(errors).length ? Object.values(errors)[0] : w('okToPost'))}
        ${warnings.length ? `<ul>${warnings.map((x) =>
          `<li>${esc(x.message)}</li>`).join('')}</ul>` : ''}
      </div>
      ${p.error ? `<div class="ch-state bad">${esc(p.error)}</div>` : ''}
      <div class="ch-acts">
        <button class="ch-btn primary" type="button" data-act="preview"
          ${Object.keys(errors).length || p.pending ? 'disabled' : ''}
          >${esc(w('preview'))}</button>
        <button class="ch-btn" type="button" data-act="draft"
          ${p.pending ? 'disabled' : ''}>${esc(w('draftRetry'))}</button>
        <button class="ch-btn quiet" type="button" data-act="cancel">${esc(w('cancel'))}</button>
      </div>`);
    return d;
  }

  function fmt(v) {
    if (v == null || v === '') return '—';
    if (Array.isArray(v)) {
      return v.map((x) => (x && typeof x === 'object' ? (x.org || JSON.stringify(x)) : x))
        .join(', ') || '—';
    }
    if (typeof v === 'object') return Object.values(v).join(' · ');
    return String(v);
  }

  function previewStep() {
    const p = S.prop;
    return el(`<p>${esc(p.issueTitle || '')}</p>
      <details class="ch-fold" open><summary>${esc(w('preview'))}</summary>
        <pre>${esc(p.issueBody || '')}</pre></details>
      ${p.error ? `<div class="ch-state bad">${esc(p.error)}</div>` : ''}
      <div class="ch-acts">
        <button class="ch-btn primary" type="button" data-act="post"
          ${p.pending ? 'disabled' : ''}>${esc(p.pending === 'issue'
            ? w('posting') : w('post'))}</button>
        <button class="ch-btn" type="button" data-act="edit">${esc(w('back'))}</button>
        <button class="ch-btn quiet" type="button" data-act="cancel">${esc(w('cancel'))}</button>
      </div>`);
  }

  function doneStep() {
    const p = S.prop;
    const url = p.issue && p.issue.url;
    return el(`<div class="ch-state ok"><strong>${esc(w('posted'))}</strong><br>
      ${url ? `<a href="${esc(url)}" target="_blank" rel="noreferrer"
        style="color:var(--accent)">${esc(url)}</a><br>` : ''}
      ${esc(w('postedNote'))}
      ${p.issue && p.issue.dry_run ? `<br><em>${esc(w('dryRun'))}</em>` : ''}</div>
      <div class="ch-acts">
        <button class="ch-btn quiet" type="button" data-act="cancel">${esc(w('close'))}</button>
      </div>`);
  }

  // -- the proposal's own requests ------------------------------------

  async function post(path, body) {
    const res = await api(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  }

  /** The conversation as the server wants it: the turns that have something in
   *  them. An aborted reply leaves an empty assistant message behind, and
   *  sending that back would ask the model to continue nothing. */
  function history() {
    return S.log
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.text.trim())
      .slice(-16).map((m) => ({ role: m.role, content: m.text }));
  }

  async function checkReference() {
    const p = S.prop;
    if (!p.url) { p.error = w('refUrl'); render(); return; }
    p.pending = 'reference';
    p.error = '';
    render();
    try {
      const out = await post('/api/reference', { url: p.url, name: p.name, lang: lang() });
      p.reference = out.reference;
      p.refNote = out.summary;
    } catch (e) {
      p.error = String(e.message || e);
    } finally {
      p.pending = '';
      render();
    }
  }

  async function draft() {
    const p = S.prop;
    p.pending = 'draft';
    p.error = '';
    p.step = 'draft';
    render();
    try {
      const out = await post('/api/draft', {
        mode: p.mode, lang: lang(), messages: history(),
        target: p.mode === 'fix' ? p.target : p.layer,
        name: p.name, reference_url: p.url || '',
      });
      p.layer = out.layer;
      p.card = out.card || {};
      p.fields = out.fields || [];
      p.report = out.report;
      p.changed = out.changed || [];
      p.yaml = out.yaml || '';
      if (out.reference) p.reference = out.reference;
      p.name = p.card.name || p.name;
      p.step = 'edit';
    } catch (e) {
      p.error = String(e.message || e);
      p.step = p.card ? 'edit' : 'reference';
    } finally {
      p.pending = '';
      render();
    }
  }

  let revalidate = null;
  function validateSoon() {
    clearTimeout(revalidate);
    revalidate = setTimeout(async () => {
      const p = S.prop;
      if (!p || p.step !== 'edit') return;
      try {
        const out = await post('/api/validate', {
          layer: p.layer, mode: p.mode, card: p.card, lang: lang(),
          target: p.mode === 'fix' ? p.target : '',
        });
        p.report = out.report;
        p.yaml = out.yaml;
        p.changed = out.changed || [];
        render();
      } catch (e) { /* the form keeps working; the server has the last word */ }
    }, 450);
  }

  async function previewIssue() {
    const p = S.prop;
    p.pending = 'preview';
    p.error = '';
    render();
    try {
      const out = await post('/api/issue', {
        preview: true, mode: p.mode, layer: p.layer, card: p.card,
        target: p.mode === 'fix' ? p.target : '', lang: lang(),
        reference: p.reference, transcript: history()
          .map((m) => (m.role === 'user' ? 'Contributor: ' : 'Assistant: ') + m.content)
          .join('\n\n'),
      });
      p.issueTitle = out.title;
      p.issueBody = out.body;
      p.step = 'issue';
    } catch (e) {
      p.error = String(e.message || e);
    } finally {
      p.pending = '';
      render();
    }
  }

  async function openIssue() {
    const p = S.prop;
    p.pending = 'issue';
    p.error = '';
    render();
    try {
      p.issue = await post('/api/issue', {
        mode: p.mode, layer: p.layer, card: p.card,
        target: p.mode === 'fix' ? p.target : '', lang: lang(),
        title: p.issueTitle, reference: p.reference,
        transcript: history()
          .map((m) => (m.role === 'user' ? 'Contributor: ' : 'Assistant: ') + m.content)
          .join('\n\n'),
      });
      p.step = 'done';
      toast(w('posted') + ' — ' + (p.issue.url || ''));
    } catch (e) {
      p.error = String(e.message || e);
    } finally {
      p.pending = '';
      render();
    }
  }

  // ---------- events ----------
  logEl.addEventListener('click', (e) => {
    const card = e.target.closest('[data-card]');
    if (card) {
      e.preventDefault();
      openEntity(card.dataset.card);
      return;
    }
    const ask = e.target.closest('[data-ask]');
    if (ask) { send(ask.dataset.ask); return; }
    const act = e.target.closest('[data-act]');
    if (!act || !S.prop) return;
    const what = act.dataset.act;
    if (what === 'cancel') stopProposal();
    else if (what === 'check') checkReference();
    else if (what === 'draft') draft();
    else if (what === 'preview') previewIssue();
    else if (what === 'post') openIssue();
    else if (what === 'edit') { S.prop.step = 'edit'; render(); }
    const drop = e.target.closest('[data-drop]');
    if (drop && S.prop && S.prop.card) {
      const host = drop.closest('[data-orgs]');
      const list = getPath(S.prop.card, host.dataset.field) || [];
      list.splice(Number(drop.dataset.drop), 1);
      setPath(S.prop.card, host.dataset.field, list.slice());
      validateSoon();
      render();
    }
  });

  // One listener for the whole form: the fields are generated, so reading them
  // back by their declared path keeps the two sides in step by construction.
  logEl.addEventListener('input', (e) => {
    const p = S.prop;
    if (!p) return;
    const propField = e.target.closest('[data-prop]');
    if (propField) {
      p[propField.dataset.prop] = propField.value.trim();
      if (propField.dataset.prop === 'layer') render();
      return;
    }
    if (!p.card) return;
    const orgs = e.target.closest('[data-orgs]');
    if (orgs) {
      const rows = [...orgs.querySelectorAll('.ch-orgrow')].map((row) => {
        const out = {};
        row.querySelectorAll('input').forEach((i) => {
          if (i.value.trim()) out[i.dataset.k] = i.dataset.k === 'country'
            ? i.value.trim().toUpperCase() : i.value.trim();
        });
        return out;
      }).filter((row) => row.org);
      setPath(p.card, orgs.dataset.field, rows);
      validateSoon();
      return;
    }
    const multi = e.target.closest('[data-field].ch-multi');
    if (multi) {
      setPath(p.card, multi.dataset.field,
        [...multi.querySelectorAll('input:checked')].map((i) => i.value));
      validateSoon();
      return;
    }
    const field = e.target.closest('[data-field]');
    if (!field) return;
    let value = field.value;
    if (field.dataset.ids) {
      value = value.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (field.type === 'number') {
      value = value === '' ? '' : Number(value);
    }
    setPath(p.card, field.dataset.field, value);
    validateSoon();
  });

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  sendEl.addEventListener('click', () => {
    if (S.streaming) {
      if (S.ac) S.ac.abort();
    } else send();
  });
  panel.querySelector('#ch-clear').addEventListener('click', () => {
    S.log = [];
    S.prop = null;
    save();
    render();
  });
  panel.querySelector('#ch-close').addEventListener('click', () => setOpen(false));

  // ---------- opening ----------
  function setOpen(on) {
    const body = document.body;
    // The feed is left exactly as the reader had it: with both open the right
    // column is shared, the feed above and the chat below.
    body.classList.toggle('chat-open', on);
    pill.classList.toggle('active', on);
    pill.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (HOST.stageResized) HOST.stageResized();
    if (on) {
      inputEl.focus();
      if (!S.health) probe();
    }
  }
  pill.addEventListener('click', () => setOpen(!document.body.classList.contains('chat-open')));

  async function probe() {
    for (const base of BASES) {
      BASE = base;
      try {
        const res = await api('/api/health');
        if (!res.ok) continue;
        S.health = await res.json();
        break;
      } catch (e) { S.health = null; }
    }
    const h = S.health;
    if (!h) {
      stateEl.innerHTML = '<span class="ch-dot off"></span>'
        + esc(lang() === 'fr' ? 'serveur absent' : 'server down');
      S.log.push({ role: 'system', html: offlineHtml({ message: BASES.join(', ') }) });
      inputEl.disabled = true;
      render();
      return;
    }
    const model = h.model || {};
    const bits = [];
    if (!model.reachable) bits.push(w('offlineModel'));
    else if ((model.missing || []).length) {
      bits.push(w('offlineModelPull') + ' ollama pull ' + model.missing.join(' / '));
    }
    const dot = model.reachable && !(model.missing || []).length ? 'on' : 'off';
    stateEl.innerHTML = `<span class="ch-dot ${dot}"></span>`
      + esc(`${w('model')} ${model.chat_model || '?'}`);
    const gh = h.github || {};
    if (!gh.ok) bits.push(w('noGh') + (gh.error || '?'));
    if (bits.length) {
      S.log.push({ role: 'system', html: bits.map(esc).join('<br>') });
      render();
    }
  }

  // ---------- go ----------
  restore();
  render();
  // The map's language switch re-renders everything it owns; the chat column is
  // not one of those, so it listens for the change and redraws its own words.
  document.querySelectorAll('.lang-switch button').forEach((b) =>
    b.addEventListener('click', () => {
      pill.innerHTML = `<span>${esc(w('pill'))}</span>`;
      inputEl.placeholder = w('placeholder');
      hintEl.textContent = S.streaming ? w('thinking') : w('enter');
      sendEl.textContent = S.streaming ? w('stop') : w('send');
      panel.querySelector('#ch-clear').textContent = w('clear');
      render();
    }));
  setOpen(true);
})();
