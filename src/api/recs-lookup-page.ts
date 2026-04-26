/**
 * Recs lookup page — served at /recs
 *
 * Typeahead search for a Bluesky handle.
 * On selection, navigates to /recs/by-handle/:handle for server-side DID resolution.
 */

import type { Variant } from "../variants.js";
import {
  atmosphereMarkup,
  baseLayout,
  designTokens,
  esc,
  fontsHead,
  footerMarkup,
  keepVariantScript,
  mastheadMarkup,
  themeBootScript,
  themeToggleScript,
} from "./shared-styles.js";

export function recsLookupPage(variant: Variant): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(variant.copy.title)} — Find recommendations</title>
${fontsHead()}
${themeBootScript()}
  <style>
${designTokens(variant)}
${baseLayout()}

    /* ─── lookup-specific ────────────────────────────────────── */
    .lookup-body {
      display: flex;
      flex-direction: column;
      align-items: var(--hero-items-align);
      padding: 1.5rem 0 3rem;
      max-width: 38rem;
      width: 100%;
      margin: 0 auto;
    }
  </style>
</head>
<body data-variant="${variant.key}">
${atmosphereMarkup()}

  <main>
${mastheadMarkup(variant, {
  title: esc(variant.copy.title),
  tagline: "Look up recommendations for any enrolled Bluesky user.",
  eyebrow: `${variant.key.toUpperCase()} // LOOKUP`,
})}

    <div class="lookup-body">
      <div class="search-wrap">
        <div class="input-shell">
          <input
            type="text"
            id="handle-input"
            placeholder="${esc(variant.copy.placeholder)}"
            autocomplete="off"
            spellcheck="false"
          />
          <div class="spinner" id="spinner"></div>
        </div>
        <div class="suggestions" id="suggestions"></div>
      </div>

      <p class="nav">
        No account yet? <a href="/">Enroll here &rarr;</a>
      </p>
    </div>
  </main>

${footerMarkup(variant)}

  <script>
    var TYPEAHEAD = 'https://typeahead.waow.tech';
    var input = document.getElementById('handle-input');
    var sugBox = document.getElementById('suggestions');
    var spinner = document.getElementById('spinner');

    var debounceTimer = null;
    var selectedIdx = -1;
    var actors = [];

    input.addEventListener('input', function() {
      clearTimeout(debounceTimer);
      var q = input.value.trim();
      if (q.length < 2) { hideSuggestions(); return; }
      debounceTimer = setTimeout(function() { search(q); }, 200);
    });

    input.addEventListener('keydown', function(e) {
      if (!sugBox.classList.contains('active')) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        selectedIdx = Math.min(selectedIdx + 1, actors.length - 1);
        renderSuggestions();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        selectedIdx = Math.max(selectedIdx - 1, 0);
        renderSuggestions();
      } else if (e.key === 'Enter' && selectedIdx >= 0) {
        e.preventDefault();
        goToRecs(actors[selectedIdx]);
      }
    });

    document.addEventListener('click', function(e) {
      if (!e.target.closest('.search-wrap')) hideSuggestions();
    });

    function search(q) {
      spinner.classList.add('active');
      fetch(
        TYPEAHEAD + '/xrpc/app.bsky.actor.searchActorsTypeahead'
        + '?q=' + encodeURIComponent(q) + '&limit=6',
        { headers: { 'X-Client': 'standard-recs' } }
      )
      .then(function(res) { return res.json(); })
      .then(function(data) {
        actors = data.actors || [];
        selectedIdx = -1;
        renderSuggestions();
        sugBox.classList.add('active');
      })
      .catch(function(err) { console.error(err); })
      .finally(function() { spinner.classList.remove('active'); });
    }

    function renderSuggestions() {
      sugBox.textContent = '';
      actors.forEach(function(a, i) {
        var el = document.createElement('div');
        el.className = 'suggestion' + (i === selectedIdx ? ' selected' : '');
        el.dataset.idx = i;

        var img = document.createElement('img');
        img.src = a.avatar || '';
        img.alt = '';
        el.appendChild(img);

        var info = document.createElement('div');
        info.className = 'info';

        var dn = document.createElement('div');
        dn.className = 'displayname';
        dn.textContent = a.displayName || a.handle;
        info.appendChild(dn);

        var hd = document.createElement('div');
        hd.className = 'handle';
        hd.textContent = '@' + a.handle;
        info.appendChild(hd);

        el.appendChild(info);
        el.addEventListener('click', function() { goToRecs(actors[i]); });
        sugBox.appendChild(el);
      });
    }

    function hideSuggestions() {
      sugBox.classList.remove('active');
      actors = [];
      selectedIdx = -1;
    }

    function goToRecs(actor) {
      hideSuggestions();
      input.value = '@' + actor.handle;
      spinner.classList.add('active');
      window.location.href = '/recs/by-handle/' + encodeURIComponent(actor.handle);
    }
  </script>

${themeToggleScript()}
${keepVariantScript()}
</body>
</html>`;
}
