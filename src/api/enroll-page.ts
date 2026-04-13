/**
 * Enrollment page — served at /
 *
 * Uses typeahead.waow.tech for handle autocomplete.
 */

import type { Variant } from "../variants.js";

export function enrollPage(variant: Variant): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${variant.copy.title}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Crimson+Pro:ital,wght@0,400;0,500;0,600;1,400;1,500&family=Inter:wght@400;500&display=swap" rel="stylesheet" />
  <style>
    :root {
      --variant-brand: ${variant.brand.hex};
      --variant-blob-1: ${variant.brand.blobs[0]};
      --variant-blob-2: ${variant.brand.blobs[1]};
      --variant-blob-3: ${variant.brand.blobs[2]};
      --variant-blob-4: ${variant.brand.blobs[3]};
      --paper: #f7f3eb;
      --ink: #3d342d;
      --ink-soft: #4a443f;
      --ink-muted: #6b635d;
    }

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    html { height: 100%; }

    body {
      font-family: 'Inter', sans-serif;
      background: var(--paper);
      color: var(--ink);
      min-height: 100dvh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: space-between;
      padding: 0 1.5rem;
      position: relative;
      overflow: hidden;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }

    ::selection { background: color-mix(in srgb, var(--variant-brand) 35%, transparent); color: var(--ink); }

    /* atmospheric layer — diffuse blobs + floating glass shapes */
    .atmosphere {
      position: fixed;
      inset: 0;
      pointer-events: none;
      overflow: hidden;
      z-index: 0;
    }

    .blob {
      position: absolute;
      border-radius: 50%;
      filter: blur(80px);
      opacity: 0;
      will-change: opacity, transform;
      animation: blob-in 1.8s ease-out forwards, blob-drift 22s ease-in-out infinite;
    }

    .blob--amber {
      width: 500px; height: 400px;
      background: radial-gradient(circle, var(--variant-blob-1) 0%, transparent 70%);
      top: 20%; left: 10%;
      animation-delay: 0s, 1.8s;
    }
    .blob--blue {
      width: 600px; height: 450px;
      background: radial-gradient(circle, var(--variant-blob-2) 0%, transparent 70%);
      top: 15%; right: 5%;
      animation-delay: 0.15s, 1.95s;
      animation-duration: 1.8s, 26s;
    }
    .blob--violet {
      width: 400px; height: 300px;
      background: radial-gradient(circle, var(--variant-blob-3) 0%, transparent 70%);
      bottom: 20%; left: 40%;
      animation-delay: 0.3s, 2.1s;
      animation-duration: 1.8s, 24s;
    }
    .blob--center {
      width: 700px; height: 300px;
      background: radial-gradient(circle, var(--variant-blob-4) 0%, transparent 70%);
      top: 50%; left: 50%;
      margin-top: -150px;
      margin-left: -350px;
      animation-delay: 0.45s, 2.25s;
      animation-duration: 1.8s, 28s;
    }

    @keyframes blob-in { to { opacity: 0.5; } }

    @keyframes blob-drift {
      0%, 100% { transform: translate(0, 0) scale(1); }
      50%      { transform: translate(22px, -16px) scale(1.04); }
    }

    /* floating frosted-glass shapes — varied sizes, shapes, tints */
    .glass-shape {
      position: absolute;
      background: rgba(255, 255, 255, 0.2);
      backdrop-filter: blur(14px) saturate(140%);
      -webkit-backdrop-filter: blur(14px) saturate(140%);
      border: 1px solid rgba(255, 255, 255, 0.58);
      box-shadow:
        0 8px 32px 0 rgba(61, 52, 45, 0.07),
        inset 0 1px 0 rgba(255, 255, 255, 0.42);
      border-radius: 22px;
      opacity: 0;
      animation:
        glass-in 1.2s 0.55s cubic-bezier(0.2, 0.8, 0.2, 1) forwards,
        glass-bob 14s ease-in-out infinite;
    }

    /* color tints */
    .glass-shape--amber {
      background: rgba(230, 180, 100, 0.26);
      border-color: rgba(230, 180, 100, 0.55);
    }
    .glass-shape--blue {
      background: rgba(147, 197, 253, 0.26);
      border-color: rgba(147, 197, 253, 0.6);
    }
    .glass-shape--sage {
      background: rgba(168, 189, 163, 0.26);
      border-color: rgba(168, 189, 163, 0.55);
    }
    .glass-shape--rose {
      background: rgba(217, 137, 108, 0.24);
      border-color: rgba(217, 137, 108, 0.55);
    }
    .glass-shape--violet {
      background: rgba(167, 139, 250, 0.24);
      border-color: rgba(167, 139, 250, 0.55);
    }

    /* organic blob outlines */
    .glass-shape--blob-a { border-radius: 64% 36% 52% 48% / 58% 42% 58% 42%; }
    .glass-shape--blob-b { border-radius: 42% 58% 66% 34% / 54% 48% 52% 46%; }
    .glass-shape--blob-c { border-radius: 60% 40% 40% 60% / 70% 30% 70% 30%; }
    .glass-shape--blob-d { border-radius: 38% 62% 48% 52% / 62% 34% 66% 38%; }
    .glass-shape--circle { border-radius: 50%; }
    .glass-shape--pill   { border-radius: 9999px; }

    /* individual placements */
    .glass-shape--1  { width: 104px; height: 136px; top: 30%;    left: 18%;  --rot: 10deg;   }
    .glass-shape--2  { width: 64px;  height: 80px;  top: 58%;    left: 14%;  --rot: -20deg;  animation-delay: 0.7s, 0s;  }
    .glass-shape--3  { width: 128px; height: 94px;  top: 26%;    right: 27%; --rot: 15deg;   animation-delay: 0.65s, 0s; }
    .glass-shape--4  { width: 82px;  height: 116px; top: 36%;    right: 18%; --rot: 5deg;    animation-delay: 0.8s, 0s;  }
    .glass-shape--5  { width: 92px;  height: 92px;  bottom: 30%; right: 24%; --rot: -10deg;  animation-delay: 0.75s, 0s; }
    .glass-shape--6  { width: 60px;  height: 76px;  top: 20%;    left: 12%;  --rot: -8deg;   animation-delay: 0.6s, 0s;  }
    .glass-shape--7  { width: 156px; height: 108px; bottom: 22%; left: 20%;  --rot: 12deg;   animation-delay: 0.9s, 0s;  }
    .glass-shape--8  { width: 44px;  height: 44px;  top: 42%;    left: 32%;  --rot: 0deg;    animation-delay: 0.95s, 0s; }
    .glass-shape--9  { width: 78px;  height: 78px;  top: 54%;    right: 34%; --rot: -18deg;  animation-delay: 1s, 0s;    }
    .glass-shape--10 { width: 34px;  height: 48px;  top: 18%;    right: 38%; --rot: 22deg;   animation-delay: 1.05s, 0s; }
    .glass-shape--11 { width: 120px; height: 80px;  bottom: 14%; right: 10%; --rot: 8deg;    animation-delay: 1.1s, 0s;  }
    .glass-shape--12 { width: 54px;  height: 70px;  top: 48%;    left: 40%;  --rot: 28deg;   animation-delay: 0.5s, 0s;  }

    @keyframes glass-in {
      from { opacity: 0; transform: rotate(var(--rot, 0deg)) translateY(10px) scale(0.95); }
      to   { opacity: 1; transform: rotate(var(--rot, 0deg)) translateY(0) scale(1); }
    }

    @keyframes glass-bob {
      0%, 100% { transform: rotate(var(--rot, 0deg)) translateY(0); }
      50%      { transform: rotate(calc(var(--rot, 0deg) + 1.2deg)) translateY(-6px); }
    }

    /* paper grain overlay */
    body::after {
      content: '';
      position: fixed;
      inset: 0;
      background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.55'/%3E%3C/svg%3E");
      opacity: 0.05;
      mix-blend-mode: multiply;
      pointer-events: none;
      z-index: 50;
    }

    main {
      position: relative;
      z-index: 10;
      flex: 1;
      width: 100%;
      max-width: 56rem;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding-top: 5rem;
      text-align: center;
    }

    h1 {
      font-family: 'Crimson Pro', serif;
      font-size: clamp(3rem, 9vw, 5rem);
      font-weight: 500;
      letter-spacing: -0.02em;
      line-height: 1;
      color: var(--ink);
      margin-bottom: 1rem;
      opacity: 0;
      animation: rise 0.9s 0.2s cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
    }

    .subtitle {
      font-family: 'Crimson Pro', serif;
      font-style: italic;
      font-size: clamp(1.1rem, 2.4vw, 1.5rem);
      color: var(--ink-soft);
      line-height: 1.4;
      margin-bottom: 4rem;
      opacity: 0;
      animation: rise 0.9s 0.35s cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
    }

    .search-wrap {
      width: 100%;
      max-width: 42rem;
      position: relative;
      z-index: 25;
      margin-bottom: 3rem;
      opacity: 0;
      animation: rise 0.9s 0.5s cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
    }

    .glass-input {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      background: rgba(255, 255, 255, 0.32);
      backdrop-filter: blur(20px) saturate(140%);
      -webkit-backdrop-filter: blur(20px) saturate(140%);
      border: 1.5px solid rgba(255, 255, 255, 0.65);
      border-radius: 9999px;
      padding: 1.25rem 2rem;
      box-shadow:
        0 4px 24px rgba(61, 52, 45, 0.05),
        inset 0 0 12px rgba(255, 255, 255, 0.3);
      transition: border-color 0.2s ease, box-shadow 0.25s ease, background 0.2s ease;
    }

    .glass-input:hover { background: rgba(255, 255, 255, 0.4); }

    .glass-input:focus-within {
      border-color: rgba(255, 255, 255, 0.9);
      background: rgba(255, 255, 255, 0.42);
      box-shadow:
        0 6px 28px rgba(61, 52, 45, 0.08),
        inset 0 0 12px rgba(255, 255, 255, 0.4),
        0 0 0 4px color-mix(in srgb, var(--variant-brand) 18%, transparent);
    }

    input[type="text"] {
      flex: 1;
      min-width: 0;
      width: 100%;
      background: transparent;
      border: none;
      outline: none;
      font-family: 'Crimson Pro', serif;
      font-size: 1.25rem;
      color: var(--ink);
    }

    input[type="text"]::placeholder {
      color: rgba(107, 99, 93, 0.55);
      font-style: italic;
    }

    input[type="text"]:disabled { opacity: 0.6; }

    .spinner {
      display: none;
      width: 18px;
      height: 18px;
      border: 2px solid rgba(107, 99, 93, 0.3);
      border-top-color: var(--ink-muted);
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
      flex-shrink: 0;
    }

    .spinner.active { display: block; }

    @keyframes spin { to { transform: rotate(360deg); } }

    .suggestions {
      position: absolute;
      top: calc(100% + 12px);
      left: 0;
      right: 0;
      background: rgba(251, 247, 239, 0.96);
      backdrop-filter: blur(28px) saturate(150%);
      -webkit-backdrop-filter: blur(28px) saturate(150%);
      border: 1px solid rgba(255, 255, 255, 0.85);
      border-radius: 24px;
      overflow: hidden;
      display: none;
      z-index: 30;
      box-shadow:
        0 24px 56px -12px rgba(61, 52, 45, 0.22),
        0 4px 12px rgba(61, 52, 45, 0.06);
    }

    .suggestions.active { display: block; }

    .suggestion {
      display: flex;
      align-items: center;
      gap: 0.85rem;
      padding: 0.85rem 1.25rem;
      cursor: pointer;
      transition: background 0.12s ease;
      text-align: left;
    }

    .suggestion:hover, .suggestion.selected {
      background: rgba(255, 255, 255, 0.6);
    }

    .suggestion + .suggestion {
      border-top: 1px solid rgba(255, 255, 255, 0.55);
    }

    .suggestion img {
      width: 38px;
      height: 38px;
      border-radius: 50%;
      object-fit: cover;
      background: rgba(107, 99, 93, 0.12);
      flex-shrink: 0;
    }

    .suggestion .info { min-width: 0; }

    .suggestion .displayname {
      font-family: 'Crimson Pro', serif;
      font-weight: 500;
      font-size: 1rem;
      color: var(--ink);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .suggestion .handle {
      font-family: 'Inter', sans-serif;
      font-size: 0.8rem;
      color: var(--ink-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .note {
      font-family: 'Inter', sans-serif;
      font-size: 0.875rem;
      color: var(--ink-muted);
      line-height: 1.625;
      max-width: 32rem;
      margin: 0 auto;
      opacity: 0;
      animation: rise 0.9s 0.65s cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
    }

    @keyframes rise {
      from { opacity: 0; transform: translateY(14px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    footer {
      position: relative;
      z-index: 10;
      width: 100%;
      padding: 1rem 0 2rem;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 1rem;
      font-family: 'Inter', sans-serif;
      font-size: 0.75rem;
      color: var(--ink-muted);
      opacity: 0;
      animation: rise 0.9s 0.85s cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
    }

    footer .gh {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
    }

    footer svg {
      width: 16px;
      height: 16px;
      flex-shrink: 0;
    }

    footer a {
      color: var(--ink-muted);
      text-decoration: none;
      transition: color 0.15s ease;
    }
    footer a:hover { color: var(--ink); }

    footer .sep { color: rgba(107, 99, 93, 0.35); }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
      }
      h1, .subtitle, .search-wrap, .note, footer { opacity: 1 !important; }
      .blob { opacity: 0.5 !important; }
      .glass-shape { opacity: 1 !important; transform: rotate(var(--rot, 0deg)); }
    }
  </style>
</head>
<body>
  <div class="atmosphere" aria-hidden="true">
    <div class="blob blob--amber"></div>
    <div class="blob blob--blue"></div>
    <div class="blob blob--violet"></div>
    <div class="blob blob--center"></div>

    <div class="glass-shape glass-shape--1"></div>
    <div class="glass-shape glass-shape--amber glass-shape--2"></div>
    <div class="glass-shape glass-shape--blob-a glass-shape--3"></div>
    <div class="glass-shape glass-shape--blue glass-shape--4"></div>
    <div class="glass-shape glass-shape--blob-b glass-shape--5"></div>
    <div class="glass-shape glass-shape--sage glass-shape--6"></div>
    <div class="glass-shape glass-shape--rose glass-shape--blob-c glass-shape--7"></div>
    <div class="glass-shape glass-shape--circle glass-shape--8"></div>
    <div class="glass-shape glass-shape--violet glass-shape--blob-d glass-shape--9"></div>
    <div class="glass-shape glass-shape--10"></div>
    <div class="glass-shape glass-shape--blob-b glass-shape--11"></div>
    <div class="glass-shape glass-shape--amber glass-shape--pill glass-shape--12"></div>
  </div>

  <main>
    <h1>${variant.copy.title}</h1>
    <p class="subtitle">
      ${variant.copy.tagline}
    </p>

    <div class="search-wrap">
      <div class="glass-input">
        <input
          type="text"
          id="handle-input"
          placeholder="${variant.copy.placeholder}"
          autocomplete="off"
          spellcheck="false"
        />
        <div class="spinner" id="spinner"></div>
      </div>
      <div class="suggestions" id="suggestions"></div>
    </div>

    <p class="note">
      We'll ask permission to read your likes from the last 30 days and
      match you with long-form writing published on Standard.site. Your recommendations
      page will be public.
    </p>
  </main>

  <footer>
    <span class="gh">
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor">
        <path fill-rule="evenodd" clip-rule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"/>
      </svg>
      <a href="https://standard.site">${variant.copy.footer}</a>
    </span>
    <span class="sep">&middot;</span>
    <a href="https://atproto.com">AT Protocol</a>
    <span class="sep">&middot;</span>
    <a href="https://typeahead.waow.tech">Typeahead by waow.tech</a>
    <span class="sep">&middot;</span>
    <span>Created by <a href="https://aturi.to/chaosgreml.in">Bryan Guffey</a></span>
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
}
