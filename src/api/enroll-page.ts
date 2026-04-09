/**
 * Enrollment page — served at /
 *
 * Uses typeahead.waow.tech for handle autocomplete.
 */

export const enrollPage = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>standard-recs</title>
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

    .note {
      font-size: 0.85rem;
      color: #7a6f66;
      line-height: 1.5;
      margin-bottom: 1.5rem;
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
    <h1>standard-recs</h1>
    <p class="subtitle">
      Discover Standard.site writing<br>
      based on what you like on Bluesky.
    </p>

    <div class="search-wrap">
      <input
        type="text"
        id="handle-input"
        placeholder="Start typing your handle..."
        autocomplete="off"
        spellcheck="false"
      />
      <div class="spinner" id="spinner"></div>
      <div class="suggestions" id="suggestions"></div>
    </div>

    <p class="note">
      We'll ask permission to read your likes from the last 30 days and
      match you with long-form writing published on Standard.site. Your recommendations
      page will be public.
    </p>

  </div>

  <footer>
    Powered by <a href="https://standard.site">Standard.site</a>
    &middot; <a href="https://atproto.com">AT Protocol</a>
    &middot; Typeahead by <a href="https://typeahead.waow.tech">waow.tech</a>
  </footer>

  <script>
    const TYPEAHEAD = 'https://typeahead.waow.tech';
    const input = document.getElementById('handle-input');
    const sugBox = document.getElementById('suggestions');
    const spinner = document.getElementById('spinner');

    let debounce = null;
    let selectedIdx = -1;
    let actors = [];

    // Show error from OAuth redirect
    const urlError = new URLSearchParams(window.location.search).get('error');
    if (urlError === 'resolve_failed') {
      input.placeholder = 'Could not resolve that handle. Try again...';
      input.style.borderColor = '#dfc4c4';
    } else if (urlError === 'auth_failed') {
      input.placeholder = 'Authorization failed. Try again...';
      input.style.borderColor = '#dfc4c4';
    }

    input.addEventListener('input', () => {
      clearTimeout(debounce);
      const q = input.value.trim();
      if (q.length < 2) { hideSuggestions(); return; }
      debounce = setTimeout(() => search(q), 200);
    });

    input.addEventListener('keydown', (e) => {
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
        enroll(actors[selectedIdx]);
      }
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('.search-wrap')) hideSuggestions();
    });

    async function search(q) {
      spinner.classList.add('active');
      try {
        const res = await fetch(
          TYPEAHEAD + '/xrpc/app.bsky.actor.searchActorsTypeahead'
          + '?q=' + encodeURIComponent(q) + '&limit=6',
          { headers: { 'X-Client': 'standard-recs' } }
        );
        const data = await res.json();
        actors = data.actors || [];
        selectedIdx = -1;
        renderSuggestions();
        sugBox.classList.add('active');
      } catch (err) {
        console.error(err);
      } finally {
        spinner.classList.remove('active');
      }
    }

    function renderSuggestions() {
      sugBox.innerHTML = actors.map((a, i) =>
        '<div class="suggestion' + (i === selectedIdx ? ' selected' : '')
        + '" data-idx="' + i + '">'
        + '<img src="' + (a.avatar || '') + '" alt="" />'
        + '<div class="info">'
        + '<div class="displayname">' + esc(a.displayName || a.handle) + '</div>'
        + '<div class="handle">@' + esc(a.handle) + '</div>'
        + '</div></div>'
      ).join('');

      sugBox.querySelectorAll('.suggestion').forEach(el => {
        el.addEventListener('click', () => enroll(actors[+el.dataset.idx]));
      });
    }

    function hideSuggestions() {
      sugBox.classList.remove('active');
      actors = [];
      selectedIdx = -1;
    }

    async function enroll(actor) {
      hideSuggestions();
      input.value = '@' + actor.handle;
      input.disabled = true;
      spinner.classList.add('active');
      window.location.href = '/enroll?handle=' + encodeURIComponent(actor.handle);
    }

    function esc(s) {
      const d = document.createElement('div');
      d.textContent = s || '';
      return d.innerHTML;
    }
  </script>
</body>
</html>`;
