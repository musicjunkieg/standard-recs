/**
 * Recs lookup page — served at /recs
 *
 * Typeahead search for a Bluesky handle.
 * On selection, navigates to /recs/by-handle/:handle for server-side DID resolution.
 */

import type { Variant } from "../variants.js";

export function recsLookupPage(variant: Variant): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${variant.copy.title} — Find recommendations</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,600;1,6..72,400&family=DM+Sans:wght@400;500&display=swap" rel="stylesheet" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; }

    body {
      font-family: 'DM Sans', sans-serif;
      background: #faf8f5;
      color: #2a2522;
      min-height: 100dvh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 1.5rem;
    }

    .container {
      max-width: 420px;
      width: 100%;
    }

    h1 {
      font-family: 'Newsreader', serif;
      font-size: 2rem;
      font-weight: 600;
      letter-spacing: -0.02em;
      margin-bottom: 0.25rem;
    }

    .subtitle {
      font-family: 'Newsreader', serif;
      font-style: italic;
      color: #7a6f66;
      font-size: 1.05rem;
      margin-bottom: 2rem;
      line-height: 1.4;
    }

    .search-wrap {
      position: relative;
      margin-bottom: 1.5rem;
    }

    input[type="text"] {
      width: 100%;
      padding: 0.85rem 1rem;
      font-size: 1rem;
      font-family: 'DM Sans', sans-serif;
      border: 2px solid #ddd5cc;
      border-radius: 10px;
      background: #fff;
      color: #2a2522;
      outline: none;
      transition: border-color 0.15s;
    }

    input[type="text"]:focus {
      border-color: #b8a898;
    }

    input[type="text"]::placeholder {
      color: #b8a898;
    }

    .suggestions {
      position: absolute;
      top: calc(100% + 4px);
      left: 0;
      right: 0;
      background: #fff;
      border: 2px solid #ddd5cc;
      border-radius: 10px;
      overflow: hidden;
      display: none;
      z-index: 10;
      box-shadow: 0 8px 24px rgba(42, 37, 34, 0.08);
    }

    .suggestions.active { display: block; }

    .suggestion {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.7rem 1rem;
      cursor: pointer;
      transition: background 0.1s;
    }

    .suggestion:hover, .suggestion.selected {
      background: #f5f0eb;
    }

    .suggestion + .suggestion {
      border-top: 1px solid #ede8e3;
    }

    .suggestion img {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      object-fit: cover;
      background: #ede8e3;
      flex-shrink: 0;
    }

    .suggestion .info {
      min-width: 0;
    }

    .suggestion .displayname {
      font-weight: 500;
      font-size: 0.9rem;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .suggestion .handle {
      font-size: 0.8rem;
      color: #7a6f66;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .spinner {
      display: none;
      width: 18px;
      height: 18px;
      border: 2px solid #ddd5cc;
      border-top-color: #7a6f66;
      border-radius: 50%;
      animation: spin 0.6s linear infinite;
      position: absolute;
      right: 14px;
      top: 50%;
      transform: translateY(-50%);
    }

    .spinner.active { display: block; }

    @keyframes spin { to { transform: translateY(-50%) rotate(360deg); } }

    .nav {
      font-size: 0.85rem;
      color: #b8a898;
    }

    .nav a { color: #7a6f66; }

    footer {
      margin-top: 3rem;
      font-size: 0.75rem;
      color: #b8a898;
      text-align: center;
    }

    footer a { color: #7a6f66; }
  </style>
</head>
<body>
  <div class="container">
    <h1>${variant.copy.title}</h1>
    <p class="subtitle">
      Look up recommendations for<br>
      any enrolled Bluesky user.
    </p>

    <div class="search-wrap">
      <input
        type="text"
        id="handle-input"
        placeholder="${variant.copy.placeholder}"
        autocomplete="off"
        spellcheck="false"
      />
      <div class="spinner" id="spinner"></div>
      <div class="suggestions" id="suggestions"></div>
    </div>

    <p class="nav">
      Don't have an account? <a href="/">Enroll here</a>
    </p>
  </div>

  <footer>
    ${variant.copy.footer}
    &middot; <a href="https://atproto.com">AT Protocol</a>
  </footer>

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
      // Build suggestions using safe DOM methods
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
</body>
</html>`;
}

