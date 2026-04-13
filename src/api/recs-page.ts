/**
 * Recommendations page — served at /recs/:did
 *
 * Three states:
 *   1. User found, has recs → grid of glass cards
 *   2. User found, no recs → "syncing" message with meta-refresh
 *   3. User not found → 404 with link to enroll
 */

import type { Variant } from "../variants.js";

type Rec = {
  uri: string;
  score: number;
  title: string;
  description: string | null;
  url: string | null;
  site: string | null;
};

export type RecsPageData =
  | { state: "found"; handle: string; did: string; recs: Rec[]; variant: Variant }
  | { state: "not_found"; variant: Variant }
  | { state: "placeholder"; variant: Variant };

export function recsPage(data: RecsPageData): string {
  const metaRefresh =
    data.state === "found" && data.recs.length === 0
      ? '\n  <meta http-equiv="refresh" content="30">'
      : "";

  const head = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${data.variant.copy.title}</title>${metaRefresh}
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Crimson+Pro:ital,wght@0,400;0,500;0,600;1,400;1,500&family=Inter:wght@400;500&display=swap" rel="stylesheet" />
  <style>
    :root {
      --variant-brand: ${data.variant.brand.hex};
      --variant-blob-1: ${data.variant.brand.blobs[0]};
      --variant-blob-2: ${data.variant.brand.blobs[1]};
      --variant-blob-3: ${data.variant.brand.blobs[2]};
      --variant-blob-4: ${data.variant.brand.blobs[3]};
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
      padding: 0 1.5rem;
      position: relative;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }

    ::selection { background: #fef3c7; color: var(--ink); }

    /* Atmosphere — fixed so it stays put while the grid scrolls */
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
      filter: blur(90px);
      opacity: 0;
      will-change: opacity, transform;
      animation: blob-in 1.8s ease-out forwards, blob-drift 26s ease-in-out infinite;
    }

    .blob--amber {
      width: 520px; height: 400px;
      background: radial-gradient(circle, var(--variant-blob-1) 0%, transparent 70%);
      top: -6%; left: -8%;
      animation-delay: 0s, 1.8s;
    }
    .blob--blue {
      width: 600px; height: 440px;
      background: radial-gradient(circle, var(--variant-blob-2) 0%, transparent 70%);
      top: -10%; right: -6%;
      animation-delay: 0.15s, 1.95s;
      animation-duration: 1.8s, 30s;
    }
    .blob--violet {
      width: 420px; height: 320px;
      background: radial-gradient(circle, var(--variant-blob-3) 0%, transparent 70%);
      bottom: -4%; left: 18%;
      animation-delay: 0.3s, 2.1s;
      animation-duration: 1.8s, 28s;
    }
    .blob--rose {
      width: 480px; height: 340px;
      background: radial-gradient(circle, var(--variant-blob-4) 0%, transparent 70%);
      bottom: 8%; right: -6%;
      animation-delay: 0.45s, 2.25s;
      animation-duration: 1.8s, 32s;
    }

    @keyframes blob-in { to { opacity: 0.42; } }

    @keyframes blob-drift {
      0%, 100% { transform: translate(0, 0) scale(1); }
      50%      { transform: translate(22px, -16px) scale(1.04); }
    }

    /* Paper grain */
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
      width: 100%;
      max-width: 1120px;
      padding: 4.5rem 0 2rem;
      display: flex;
      flex-direction: column;
      align-items: center;
    }

    header.hero {
      text-align: center;
      margin-bottom: 3rem;
      opacity: 0;
      animation: rise 0.9s 0.1s cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
    }

    h1 {
      font-family: 'Crimson Pro', serif;
      font-size: clamp(2.25rem, 5.5vw, 3.5rem);
      font-weight: 500;
      letter-spacing: -0.02em;
      line-height: 1.05;
      color: var(--ink);
      margin-bottom: 0.6rem;
    }

    h1 .handle {
      font-style: italic;
      color: var(--ink-soft);
    }

    .subtitle {
      font-family: 'Crimson Pro', serif;
      font-style: italic;
      font-size: clamp(1.05rem, 2.2vw, 1.3rem);
      color: var(--ink-muted);
      line-height: 1.4;
    }

    .grid {
      width: 100%;
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 1.25rem;
      opacity: 0;
      animation: rise 0.9s 0.25s cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
    }

    .card {
      position: relative;
      display: flex;
      flex-direction: column;
      padding: 1.65rem 1.75rem 1.4rem;
      background: rgba(255, 255, 255, 0.55);
      backdrop-filter: blur(18px) saturate(140%);
      -webkit-backdrop-filter: blur(18px) saturate(140%);
      border: 1px solid rgba(255, 255, 255, 0.75);
      border-radius: 22px;
      box-shadow:
        0 8px 32px 0 rgba(61, 52, 45, 0.06),
        inset 0 1px 0 rgba(255, 255, 255, 0.6);
      text-decoration: none;
      color: inherit;
      overflow: hidden;
      transition:
        transform 0.25s ease,
        box-shadow 0.3s ease,
        border-color 0.25s ease,
        background 0.25s ease;
    }

    .card::before {
      content: '';
      position: absolute;
      inset: 0;
      border-radius: inherit;
      background: radial-gradient(circle at top right, rgba(230, 180, 100, 0.16) 0%, transparent 60%);
      opacity: 0;
      transition: opacity 0.3s ease;
      pointer-events: none;
    }

    .card:hover {
      transform: translateY(-3px);
      background: rgba(255, 255, 255, 0.68);
      border-color: rgba(255, 255, 255, 0.92);
      box-shadow:
        0 20px 52px -10px rgba(61, 52, 45, 0.14),
        inset 0 1px 0 rgba(255, 255, 255, 0.7);
    }
    .card:hover::before { opacity: 1; }

    .card-rank {
      font-family: 'Crimson Pro', serif;
      font-style: italic;
      font-size: 0.85rem;
      color: var(--ink-muted);
      letter-spacing: 0.02em;
      margin-bottom: 0.55rem;
    }

    .card-title {
      font-family: 'Crimson Pro', serif;
      font-size: 1.4rem;
      font-weight: 500;
      line-height: 1.2;
      letter-spacing: -0.01em;
      color: var(--ink);
      margin-bottom: 0.65rem;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .card-desc {
      font-family: 'Inter', sans-serif;
      font-size: 0.9rem;
      color: var(--ink-muted);
      line-height: 1.55;
      margin-bottom: 1.3rem;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
      flex: 1;
    }

    .card-meta {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 0.75rem;
      font-family: 'Inter', sans-serif;
      font-size: 0.78rem;
      padding-top: 0.9rem;
      border-top: 1px solid rgba(107, 99, 93, 0.15);
    }

    .card-site {
      color: var(--ink-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
    }

    .card-score {
      display: inline-flex;
      align-items: center;
      color: var(--ink-soft);
      font-weight: 500;
      background: rgba(230, 180, 100, 0.24);
      border: 1px solid rgba(230, 180, 100, 0.55);
      padding: 0.22rem 0.6rem;
      border-radius: 9999px;
      flex-shrink: 0;
    }

    .empty-card {
      width: 100%;
      max-width: 32rem;
      padding: 3rem 2rem;
      text-align: center;
      background: rgba(255, 255, 255, 0.55);
      backdrop-filter: blur(18px) saturate(140%);
      -webkit-backdrop-filter: blur(18px) saturate(140%);
      border: 1px solid rgba(255, 255, 255, 0.75);
      border-radius: 22px;
      box-shadow:
        0 8px 32px 0 rgba(61, 52, 45, 0.06),
        inset 0 1px 0 rgba(255, 255, 255, 0.6);
      opacity: 0;
      animation: rise 0.9s 0.25s cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
    }

    .empty-card p {
      font-family: 'Inter', sans-serif;
      font-size: 0.95rem;
      color: var(--ink-muted);
      line-height: 1.6;
    }

    .empty-card p + p {
      margin-top: 0.75rem;
      font-size: 0.82rem;
      color: rgba(107, 99, 93, 0.7);
    }

    .empty-card a {
      color: var(--ink-soft);
      font-weight: 500;
      border-bottom: 1px solid rgba(107, 99, 93, 0.4);
      text-decoration: none;
      transition: color 0.15s ease, border-color 0.15s ease;
    }
    .empty-card a:hover {
      color: var(--ink);
      border-bottom-color: var(--ink-soft);
    }

    footer {
      position: relative;
      z-index: 10;
      width: 100%;
      padding: 1.5rem 0 2.5rem;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-wrap: wrap;
      gap: 1rem;
      font-family: 'Inter', sans-serif;
      font-size: 0.75rem;
      color: var(--ink-muted);
      opacity: 0;
      animation: rise 0.9s 0.5s cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
    }

    footer .gh { display: inline-flex; align-items: center; gap: 0.5rem; }
    footer svg { width: 16px; height: 16px; flex-shrink: 0; }
    footer a {
      color: var(--ink-muted);
      text-decoration: none;
      transition: color 0.15s ease;
    }
    footer a:hover { color: var(--ink); }
    footer .sep { color: rgba(107, 99, 93, 0.35); }

    @keyframes rise {
      from { opacity: 0; transform: translateY(14px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
      }
      .blob { opacity: 0.42 !important; }
      header.hero, .grid, .empty-card, footer { opacity: 1 !important; }
    }

    @media (max-width: 640px) {
      main { padding-top: 3rem; }
      .card { padding: 1.35rem 1.45rem 1.2rem; }
      .card-title { font-size: 1.25rem; }
    }
  </style>
</head>
<body>
  <div class="atmosphere" aria-hidden="true">
    <div class="blob blob--amber"></div>
    <div class="blob blob--blue"></div>
    <div class="blob blob--violet"></div>
    <div class="blob blob--rose"></div>
  </div>

  <main>`;

  const footer = `
    <footer>
      <span class="gh">
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor">
          <path fill-rule="evenodd" clip-rule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"/>
        </svg>
        <a href="https://standard.site">${data.variant.copy.footer}</a>
      </span>
      <span class="sep">&middot;</span>
      <a href="https://atproto.com">AT Protocol</a>
      <span class="sep">&middot;</span>
      <span>Created by <a href="https://aturi.to/chaosgreml.in">Bryan Guffey</a></span>
    </footer>
</body>
</html>`;

  const close = `
  </main>${footer}`;

  if (data.state === "not_found") {
    return `${head}
    <header class="hero">
      <h1>User not found</h1>
      <p class="subtitle">This person hasn't enrolled yet.</p>
    </header>
    <div class="empty-card">
      <p>Want recommendations of your own? <a href="/">Sign up with your Bluesky handle</a>.</p>
    </div>${close}`;
  }

  if (data.state === "placeholder") {
    return `${head}
    <header class="hero">
      <h1>${data.variant.copy.title}</h1>
      <p class="subtitle">${data.variant.copy.tagline}</p>
    </header>
    <div class="empty-card">
      <p>Recommendations for this variant aren't available yet.</p>
      <p>Check back soon — we're still working on it.</p>
    </div>${close}`;
  }

  const { handle, recs } = data;

  if (recs.length === 0) {
    return `${head}
    <header class="hero">
      <h1>${data.variant.copy.recsHeading(esc(handle))}</h1>
      <p class="subtitle">${data.variant.copy.tagline}</p>
    </header>
    <div class="empty-card">
      <p>We're syncing your likes — check back shortly.</p>
      <p>This page refreshes automatically.</p>
    </div>${close}`;
  }

  const cards = recs
    .map((r, i) => {
      const score = Math.round(r.score * 100);
      const site = r.site?.replace(/^https?:\/\//, "").replace(/\/$/, "") ?? "";
      const href = r.url ? ` href="${esc(r.url)}" target="_blank" rel="noopener"` : "";
      const rank = `№ ${i + 1}`;
      const desc = r.description
        ? `\n      <div class="card-desc">${esc(r.description)}</div>`
        : "";
      return `    <a class="card"${href}>
      <div class="card-rank">${rank}</div>
      <div class="card-title">${esc(r.title)}</div>${desc}
      <div class="card-meta">
        <span class="card-site">${esc(site)}</span>
        <span class="card-score">${score}% match</span>
      </div>
    </a>`;
    })
    .join("\n");

  return `${head}
    <header class="hero">
      <h1>${data.variant.copy.recsHeading(esc(handle))}</h1>
      <p class="subtitle">${data.variant.copy.tagline}</p>
    </header>
    <div class="grid">
${cards}
    </div>${close}`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
