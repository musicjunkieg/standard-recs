/**
 * Shared design system for all three sites.
 *
 * One neo-brutalist editorial skeleton rendered across standard/
 * nonstandard/substandard. Each variant picks up the same layout,
 * typography, and components, but `designTokens` emits a different
 * set of "mood dial" CSS custom properties that tilt the skeleton
 * toward polished / chaotic / faded.
 *
 * Composition order inside a page's template literal:
 *   <head>
 *     fontsHead()
 *     themeBootScript()      — sets data-theme before first paint
 *     <style>
 *       designTokens(variant)
 *       baseLayout()
 *       + any page-specific styles
 *     </style>
 *   </head>
 *   <body data-variant="...">
 *     atmosphereMarkup()
 *     <main>
 *       mastheadMarkup(variant, { title, tagline, eyebrow })
 *       ...page content...
 *     </main>
 *     footerMarkup(variant)
 *     ...page-specific scripts...
 *     themeToggleScript()
 *   </body>
 */

import type { Variant } from "../variants.js";

export function fontsHead(): string {
  return `  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,500..900;1,9..144,500..900&family=IBM+Plex+Mono:wght@400;500&family=Inter:wght@400;500;600&display=swap" rel="stylesheet" />`;
}

export function themeBootScript(): string {
  // Runs before CSS paint. Reads localStorage + system preference,
  // sets data-theme on <html>. Keeps effective theme on the <html>
  // element so CSS can target it without waiting for body.
  return `  <script>
    (function(){
      try {
        var stored = localStorage.getItem('theme');
        var mode = stored === 'light' || stored === 'dark' ? stored : 'system';
        var effective = mode === 'system'
          ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
          : mode;
        document.documentElement.setAttribute('data-theme', effective);
        document.documentElement.setAttribute('data-theme-mode', mode);
      } catch(e) {
        document.documentElement.setAttribute('data-theme', 'light');
        document.documentElement.setAttribute('data-theme-mode', 'system');
      }
    })();
  </script>`;
}

export function designTokens(variant: Variant): string {
  const mood = moodDials(variant.key);
  return `    :root {
      --variant-brand: ${variant.brand.hex};
      --variant-blob-1: ${variant.brand.blobs[0]};
      --variant-blob-2: ${variant.brand.blobs[1]};
      --variant-blob-3: ${variant.brand.blobs[2]};
      --variant-blob-4: ${variant.brand.blobs[3]};

      /* variant mood dials */
      --tilt: ${mood.tilt};
      --border-weight: ${mood.borderWeight};
      --border-style: ${mood.borderStyle};
      --grain-opacity: ${mood.grainOpacity};
      --card-offset: ${mood.cardOffset};
      --hero-items-align: ${mood.heroItemsAlign};
      --hero-text-align: ${mood.heroTextAlign};
      --title-shift: ${mood.titleShift};
      --tagline-shift: ${mood.taglineShift};
      --tagline-strike: ${mood.taglineStrike};
      --atmosphere-tilt: ${mood.atmosphereTilt};
      --atmosphere-scale: ${mood.atmosphereScale};
      --ink-shift: ${mood.inkShift};
      --accent-block-opacity-light: ${mood.blockOpacityLight};
      --accent-block-opacity-dark: ${mood.blockOpacityDark};
    }

    /* ─── light (default) ─────────────────────────────────────────── */
    :root, :root[data-theme="light"] {
      --paper:         #efe7d9;
      --paper-raised:  #fbf6ec;
      --ink-base:      #0f0b08;
      --ink-soft-base: #3a332c;
      --ink-muted:     #6b6056;
      --rule:          #0f0b08;
      --accent-text:   #0f0b08;
      --grain-blend:   multiply;
      --accent-block-opacity: var(--accent-block-opacity-light);
      --shadow-rule:   rgba(15, 11, 8, 0.18);
    }

    /* ─── dark (auto via system) ──────────────────────────────────── */
    @media (prefers-color-scheme: dark) {
      :root:not([data-theme="light"]) {
        --paper:         #0c0905;
        --paper-raised:  #181310;
        --ink-base:      #f4ecdd;
        --ink-soft-base: #cfc3ae;
        --ink-muted:     #8f8474;
        --rule:          #f4ecdd;
        --accent-text:   #0c0905;
        --grain-blend:   screen;
        --accent-block-opacity: var(--accent-block-opacity-dark);
        --shadow-rule:   rgba(244, 236, 221, 0.14);
      }
    }

    /* ─── dark (explicit override) ────────────────────────────────── */
    :root[data-theme="dark"] {
      --paper:         #0c0905;
      --paper-raised:  #181310;
      --ink-base:      #f4ecdd;
      --ink-soft-base: #cfc3ae;
      --ink-muted:     #8f8474;
      --rule:          #f4ecdd;
      --accent-text:   #0c0905;
      --grain-blend:   screen;
      --accent-block-opacity: var(--accent-block-opacity-dark);
      --shadow-rule:   rgba(244, 236, 221, 0.14);
    }

    /* Substandard dials down body ink one step; the skeleton reads
       --ink everywhere, so remapping here propagates. */
    :root {
      --ink:      var(--ink-base);
      --ink-soft: var(--ink-soft-base);
    }
    ${variant.key === "substandard" ? `:root { --ink: var(--ink-soft-base); --ink-soft: var(--ink-muted); }` : ""}

    /* Faded variant accent for ghost-shadows + washes */
    :root {
      --variant-brand-faded: color-mix(in srgb, var(--variant-brand) 55%, var(--paper));
      --accent-subtle:       color-mix(in srgb, var(--variant-brand) 18%, var(--paper));
    }`;
}

type Mood = {
  tilt: string;
  borderWeight: string;
  borderStyle: string;
  grainOpacity: string;
  cardOffset: string;
  heroItemsAlign: string;
  heroTextAlign: string;
  titleShift: string;
  taglineShift: string;
  taglineStrike: string;
  atmosphereTilt: string;
  atmosphereScale: string;
  inkShift: string;
  blockOpacityLight: string;
  blockOpacityDark: string;
};

function moodDials(key: Variant["key"]): Mood {
  switch (key) {
    case "standard":
      return {
        tilt: "0deg",
        borderWeight: "2px",
        borderStyle: "solid",
        grainOpacity: "0.06",
        cardOffset: "0px",
        heroItemsAlign: "center",
        heroTextAlign: "center",
        titleShift: "0px",
        taglineShift: "0px",
        taglineStrike: "none",
        atmosphereTilt: "-2deg",
        atmosphereScale: "1",
        inkShift: "0",
        blockOpacityLight: "0.22",
        blockOpacityDark: "0.30",
      };
    case "nonstandard":
      return {
        tilt: "1.5deg",
        borderWeight: "2px",
        borderStyle: "solid",
        grainOpacity: "0.09",
        cardOffset: "0px",
        heroItemsAlign: "flex-start",
        heroTextAlign: "left",
        titleShift: "-8px",
        taglineShift: "12px",
        taglineStrike: "none",
        atmosphereTilt: "-6deg",
        atmosphereScale: "1.15",
        inkShift: "0",
        blockOpacityLight: "0.28",
        blockOpacityDark: "0.36",
      };
    case "substandard":
      return {
        tilt: "-0.75deg",
        borderWeight: "2px",
        borderStyle: "dashed",
        grainOpacity: "0.14",
        cardOffset: "5px",
        heroItemsAlign: "center",
        heroTextAlign: "center",
        titleShift: "0px",
        taglineShift: "0px",
        taglineStrike: "line-through",
        atmosphereTilt: "3deg",
        atmosphereScale: "0.95",
        inkShift: "1",
        blockOpacityLight: "0.16",
        blockOpacityDark: "0.22",
      };
  }
}

export function baseLayout(): string {
  return `    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    html { height: 100%; }

    body {
      font-family: 'Inter', system-ui, sans-serif;
      font-size: 17px;
      line-height: 1.55;
      background: var(--paper);
      color: var(--ink);
      min-height: 100dvh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 0 1.75rem;
      position: relative;
      overflow-x: hidden;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }

    ::selection {
      background: var(--variant-brand);
      color: var(--accent-text);
    }

    a { color: inherit; }

    button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; }

    /* ─── atmosphere: single accent block bleeding behind the masthead ── */
    .atmosphere {
      position: fixed;
      inset: 0;
      pointer-events: none;
      overflow: hidden;
      z-index: 0;
    }

    .accent-block {
      position: absolute;
      top: -12vh;
      left: 58%;
      width: 72vw;
      height: 58vh;
      max-height: 640px;
      background: var(--variant-brand);
      opacity: var(--accent-block-opacity);
      transform: rotate(var(--atmosphere-tilt)) scale(var(--atmosphere-scale));
      transform-origin: top left;
      will-change: transform;
    }

    .accent-block--secondary {
      position: absolute;
      bottom: -14vh;
      left: -10vw;
      width: 46vw;
      height: 36vh;
      max-height: 420px;
      background: var(--variant-blob-2);
      opacity: calc(var(--accent-block-opacity) * 0.55);
      transform: rotate(calc(var(--atmosphere-tilt) * -1.2));
      transform-origin: bottom left;
    }

    /* paper grain */
    body::after {
      content: '';
      position: fixed;
      inset: 0;
      background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.92' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.7'/%3E%3C/svg%3E");
      opacity: var(--grain-opacity);
      mix-blend-mode: var(--grain-blend);
      pointer-events: none;
      z-index: 60;
    }

    main {
      position: relative;
      z-index: 10;
      width: 100%;
      max-width: 64rem;
      flex: 1;
      display: flex;
      flex-direction: column;
      padding: 3.5rem 0 2rem;
    }

    /* ─── masthead ───────────────────────────────────────────────── */
    .masthead {
      display: flex;
      flex-direction: column;
      align-items: var(--hero-items-align);
      text-align: var(--hero-text-align);
      gap: 1.25rem;
      margin-bottom: 3.5rem;
      opacity: 0;
      animation: reveal 220ms 40ms cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
    }

    .eyebrow {
      font-family: 'IBM Plex Mono', ui-monospace, monospace;
      font-size: 0.78rem;
      font-weight: 500;
      letter-spacing: 0.22em;
      text-transform: uppercase;
      color: var(--ink-muted);
      display: inline-flex;
      align-items: center;
      gap: 0.75rem;
      transform: rotate(calc(var(--tilt) * -0.4));
    }

    .eyebrow::before,
    .eyebrow::after {
      content: '';
      width: 1.6rem;
      height: 2px;
      background: var(--variant-brand);
    }

    .title-row {
      display: flex;
      align-items: center;
      gap: 0.9rem;
      transform: translateX(var(--title-shift));
    }

    .variant-mark {
      width: 18px;
      height: 18px;
      background: var(--variant-brand);
      flex-shrink: 0;
      margin-top: 0.6rem;
      align-self: flex-start;
    }

    .title {
      font-family: 'Fraunces', 'Times New Roman', serif;
      font-variation-settings: "opsz" 144, "SOFT" 30, "WONK" 1;
      font-weight: 700;
      font-size: clamp(2.75rem, 8vw, 5.5rem);
      letter-spacing: -0.035em;
      line-height: 0.92;
      color: var(--ink-base);
    }

    .rule {
      width: 4.5rem;
      height: 3px;
      background: var(--variant-brand);
      transform: rotate(calc(var(--tilt) * 0.3));
    }

    .tagline {
      font-family: 'Fraunces', serif;
      font-style: italic;
      font-variation-settings: "opsz" 48, "SOFT" 60;
      font-size: clamp(1.05rem, 2.2vw, 1.45rem);
      color: var(--ink-soft);
      max-width: 34rem;
      line-height: 1.35;
      transform: translateX(var(--tagline-shift));
      text-decoration: var(--tagline-strike);
      text-decoration-color: var(--variant-brand);
      text-decoration-thickness: 1.5px;
    }

    /* ─── input ──────────────────────────────────────────────────── */
    .search-wrap {
      width: 100%;
      max-width: 38rem;
      position: relative;
      margin: 0 auto 2.25rem;
      opacity: 0;
      animation: reveal 220ms 140ms cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
    }

    .search-wrap--left {
      margin: 0 0 2.25rem;
    }

    .input-shell {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      background: var(--paper-raised);
      border: var(--border-weight) solid var(--ink);
      padding: 1rem 1.1rem;
      transition: outline-color 120ms ease, transform 120ms ease;
    }

    .input-shell:focus-within {
      outline: 3px solid var(--variant-brand);
      outline-offset: 3px;
    }

    .input-shell input[type="text"] {
      flex: 1;
      min-width: 0;
      background: transparent;
      border: 0;
      outline: 0;
      font-family: 'Fraunces', serif;
      font-variation-settings: "opsz" 48;
      font-size: 1.2rem;
      color: var(--ink);
    }

    .input-shell input[type="text"]::placeholder {
      color: var(--ink-muted);
      font-style: italic;
    }

    .input-shell input[type="text"]:disabled { opacity: 0.6; }

    .spinner {
      display: none;
      width: 16px;
      height: 16px;
      border: 2px solid var(--ink-muted);
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
      flex-shrink: 0;
    }

    .spinner.active { display: block; }

    @keyframes spin { to { transform: rotate(360deg); } }

    .suggestions {
      position: absolute;
      top: calc(100% + 6px);
      left: 0;
      right: 0;
      background: var(--paper-raised);
      border: var(--border-weight) solid var(--ink);
      display: none;
      z-index: 30;
      box-shadow: 6px 6px 0 var(--variant-brand);
    }

    .suggestions.active { display: block; }

    .suggestion {
      display: flex;
      align-items: center;
      gap: 0.85rem;
      padding: 0.75rem 1rem;
      cursor: pointer;
      text-align: left;
      border-bottom: 1px solid var(--shadow-rule);
    }
    .suggestion:last-child { border-bottom: 0; }

    .suggestion:hover, .suggestion.selected {
      background: var(--accent-subtle);
    }

    .suggestion img {
      width: 36px;
      height: 36px;
      border-radius: 0;
      object-fit: cover;
      background: var(--accent-subtle);
      flex-shrink: 0;
      border: 1px solid var(--ink);
    }

    .suggestion .info { min-width: 0; }

    .suggestion .displayname {
      font-family: 'Fraunces', serif;
      font-variation-settings: "opsz" 24;
      font-weight: 600;
      font-size: 1rem;
      color: var(--ink);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .suggestion .handle {
      font-family: 'IBM Plex Mono', monospace;
      font-size: 0.78rem;
      color: var(--ink-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      letter-spacing: 0.01em;
    }

    .note {
      font-family: 'Inter', sans-serif;
      font-size: 0.92rem;
      color: var(--ink-muted);
      line-height: 1.6;
      max-width: 32rem;
      margin: 0 auto;
      opacity: 0;
      animation: reveal 220ms 220ms cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
      border-left: 2px solid var(--variant-brand);
      padding-left: 0.9rem;
    }

    .note--left { margin: 0; }

    .nav {
      font-family: 'IBM Plex Mono', monospace;
      font-size: 0.8rem;
      color: var(--ink-muted);
      letter-spacing: 0.02em;
    }
    .nav a {
      color: var(--ink);
      text-decoration: underline;
      text-decoration-color: var(--variant-brand);
      text-decoration-thickness: 2px;
      text-underline-offset: 3px;
    }

    /* ─── footer ─────────────────────────────────────────────────── */
    footer {
      position: relative;
      z-index: 10;
      width: 100%;
      max-width: 64rem;
      margin: auto auto 0;
      padding: 1.75rem 0 2rem;
      border-top: 2px solid var(--ink);
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 1rem;
      font-family: 'IBM Plex Mono', monospace;
      font-size: 0.72rem;
      color: var(--ink-muted);
      letter-spacing: 0.06em;
      text-transform: uppercase;
      opacity: 0;
      animation: reveal 220ms 300ms cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
    }

    footer .cluster { display: inline-flex; align-items: center; gap: 0.9rem; flex-wrap: wrap; }
    footer .sep { opacity: 0.5; }
    footer a { color: var(--ink-soft); text-decoration: none; border-bottom: 1px solid var(--shadow-rule); }
    footer a:hover { color: var(--ink); border-bottom-color: var(--variant-brand); }
    footer .mark {
      display: inline-block;
      width: 10px; height: 10px;
      background: var(--variant-brand);
      margin-right: 0.5rem;
      vertical-align: -1px;
    }

    .theme-toggle {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 36px;
      height: 36px;
      border: 2px solid var(--ink);
      background: var(--paper-raised);
      color: var(--ink);
      flex-shrink: 0;
      transition: background-color 100ms ease;
    }
    .theme-toggle:hover { background: var(--accent-subtle); }
    .theme-toggle:focus-visible { outline: 3px solid var(--variant-brand); outline-offset: 2px; }
    .theme-toggle svg { width: 16px; height: 16px; display: block; }
    .theme-toggle .icon-light,
    .theme-toggle .icon-dark,
    .theme-toggle .icon-system { display: none; }

    :root[data-theme-mode="system"] .theme-toggle .icon-system { display: block; }
    :root[data-theme-mode="light"] .theme-toggle .icon-light { display: block; }
    :root[data-theme-mode="dark"] .theme-toggle .icon-dark { display: block; }

    /* ─── keyframes ──────────────────────────────────────────────── */
    @keyframes reveal {
      from { opacity: 0; transform: translateY(10px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.01ms !important;
      }
      .masthead, .search-wrap, .note, footer, .grid, .empty-card { opacity: 1 !important; }
    }

    @media (max-width: 640px) {
      body { padding: 0 1rem; }
      main { padding-top: 2.25rem; }
      .masthead { margin-bottom: 2.5rem; gap: 1rem; }
      footer { font-size: 0.68rem; }
    }`;
}

export function atmosphereMarkup(): string {
  return `  <div class="atmosphere" aria-hidden="true">
    <div class="accent-block"></div>
    <div class="accent-block accent-block--secondary"></div>
  </div>`;
}

export function mastheadMarkup(
  variant: Variant,
  opts: { title: string; tagline?: string; eyebrow?: string }
): string {
  const eyebrow = opts.eyebrow ?? `${variant.key.toUpperCase()} // REC ENGINE`;
  const tagline = opts.tagline
    ? `    <p class="tagline">${opts.tagline}</p>`
    : "";
  return `  <header class="masthead">
    <span class="eyebrow">${esc(eyebrow)}</span>
    <div class="title-row">
      <span class="variant-mark" aria-hidden="true"></span>
      <h1 class="title">${opts.title}</h1>
    </div>
    <div class="rule" aria-hidden="true"></div>
${tagline}
  </header>`;
}

export function footerMarkup(variant: Variant): string {
  return `  <footer>
    <span class="cluster">
      <span><span class="mark" aria-hidden="true"></span><a href="https://standard.site">${esc(variant.copy.footer)}</a></span>
      <span class="sep">//</span>
      <a href="https://atproto.com">AT Protocol</a>
      <span class="sep">//</span>
      <span>By <a href="https://aturi.to/chaosgreml.in">Bryan Guffey</a></span>
    </span>
    <span class="cluster">
      <a href="https://github.com/musicjunkieg/standard-recs">Source</a>
      <button class="theme-toggle" id="theme-toggle" aria-label="Toggle theme" type="button">
        <svg class="icon-light" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M4.22 4.22l2.12 2.12M17.66 17.66l2.12 2.12M2 12h3M19 12h3M4.22 19.78l2.12-2.12M17.66 6.34l2.12-2.12"/></svg>
        <svg class="icon-dark" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>
        <svg class="icon-system" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><rect x="3" y="4" width="18" height="13"/><path d="M8 20h8M12 17v3"/></svg>
      </button>
    </span>
  </footer>`;
}

export function themeToggleScript(): string {
  return `  <script>
    (function(){
      var btn = document.getElementById('theme-toggle');
      if (!btn) return;
      var root = document.documentElement;
      var order = ['system', 'light', 'dark'];
      var mq = matchMedia('(prefers-color-scheme: dark)');

      function applyMode(mode) {
        var effective = mode === 'system'
          ? (mq.matches ? 'dark' : 'light')
          : mode;
        root.setAttribute('data-theme', effective);
        root.setAttribute('data-theme-mode', mode);
        if (mode === 'system') {
          try { localStorage.removeItem('theme'); } catch(e) {}
        } else {
          try { localStorage.setItem('theme', mode); } catch(e) {}
        }
      }

      btn.addEventListener('click', function() {
        var current = root.getAttribute('data-theme-mode') || 'system';
        var next = order[(order.indexOf(current) + 1) % order.length];
        applyMode(next);
      });

      mq.addEventListener('change', function() {
        if ((root.getAttribute('data-theme-mode') || 'system') === 'system') {
          applyMode('system');
        }
      });
    })();
  </script>`;
}

/**
 * Rewrites internal anchor `href`s to carry the current `_variant`
 * query param if one is present. Pure dev convenience: in production
 * the param is absent so this is a no-op. Without it, the variant
 * override is lost as soon as you click any internal link.
 *
 * Targets every same-origin anchor automatically — no markup changes
 * required at the call site.
 */
export function keepVariantScript(): string {
  return `  <script>
    (function(){
      var params = new URLSearchParams(location.search);
      var v = params.get('_variant');
      if (!v) return;
      var anchors = document.querySelectorAll('a[href]');
      anchors.forEach(function(a) {
        var href = a.getAttribute('href');
        if (!href) return;
        // Skip external links, anchors, mailto:, tel:, etc.
        if (/^[a-z]+:|^\\/\\//i.test(href) || href.charAt(0) === '#') return;
        var url = new URL(href, location.href);
        if (url.origin !== location.origin) return;
        if (!url.searchParams.has('_variant')) {
          url.searchParams.set('_variant', v);
        }
        a.setAttribute('href', url.pathname + url.search + url.hash);
      });
    })();
  </script>`;
}

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
