/**
 * Enrollment page — served at /
 *
 * Uses typeahead.waow.tech for handle autocomplete.
 */

import type { Variant } from "../variants.js";
import {
  atmosphereMarkup,
  baseLayout,
  designTokens,
  esc,
  fontsHead,
  footerMarkup,
  mastheadMarkup,
  themeBootScript,
  themeToggleScript,
} from "./shared-styles.js";

export function enrollPage(variant: Variant): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(variant.copy.title)}</title>
${fontsHead()}
${themeBootScript()}
  <style>
${designTokens(variant)}
${baseLayout()}

    /* ─── enrollment-specific ─────────────────────────────────── */
    .enroll-body {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 2rem 0 3rem;
    }
  </style>
</head>
<body data-variant="${variant.key}">
${atmosphereMarkup()}

  <main>
${mastheadMarkup(variant, {
  title: esc(variant.copy.title),
  tagline: esc(variant.copy.tagline),
  eyebrow: `${variant.key.toUpperCase()} // ENROLL`,
})}

    <div class="enroll-body">
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

      <p class="note">
        We'll ask permission to read your likes from the last 30 days and
        match you with long-form writing published on Standard.site. Your
        recommendations page will be public.
      </p>
    </div>
  </main>

${footerMarkup(variant)}

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
      input.closest('.input-shell').style.borderColor = 'var(--variant-brand)';
    } else if (urlError === 'auth_failed') {
      input.placeholder = 'Authorization failed. Try again...';
      input.closest('.input-shell').style.borderColor = 'var(--variant-brand)';
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
      sugBox.textContent = '';
      actors.forEach((a, i) => {
        const el = document.createElement('div');
        el.className = 'suggestion' + (i === selectedIdx ? ' selected' : '');
        el.dataset.idx = i;

        const img = document.createElement('img');
        img.src = a.avatar || '';
        img.alt = '';
        el.appendChild(img);

        const info = document.createElement('div');
        info.className = 'info';

        const dn = document.createElement('div');
        dn.className = 'displayname';
        dn.textContent = a.displayName || a.handle;
        info.appendChild(dn);

        const hd = document.createElement('div');
        hd.className = 'handle';
        hd.textContent = '@' + a.handle;
        info.appendChild(hd);

        el.appendChild(info);
        el.addEventListener('click', () => enroll(actors[i]));
        sugBox.appendChild(el);
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
  </script>

${themeToggleScript()}
</body>
</html>`;
}
