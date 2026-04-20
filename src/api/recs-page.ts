/**
 * Recommendations page — served at /recs/:did
 *
 * Three states:
 *   1. User found, has recs → grid of neo-brutalist cards
 *   2. User found, no recs → "syncing" message with meta-refresh
 *   3. User not found → 404 with link to enroll
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

  const pageStyles = `
    /* ─── recs-specific ──────────────────────────────────────── */
    main { max-width: 76rem; }

    .grid {
      width: 100%;
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 1.5rem;
      opacity: 0;
      animation: reveal 260ms 180ms cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
    }

    .card {
      position: relative;
      display: flex;
      flex-direction: column;
      padding: 1.5rem 1.5rem 1.3rem;
      background: var(--paper-raised);
      border: var(--border-weight) var(--border-style) var(--variant-brand);
      text-decoration: none;
      color: inherit;
      transition: transform 140ms ease, box-shadow 140ms ease;
      box-shadow: var(--card-offset) var(--card-offset) 0 var(--variant-brand-faded);
    }

    .card:nth-child(odd)  { --i: -1; }
    .card:nth-child(even) { --i:  1; }
    .card { transform: rotate(calc(var(--tilt) * var(--i, 1) * 0.3)); }

    .card:hover {
      transform: rotate(calc(var(--tilt) * var(--i, 1) * 0.3)) translate(-2px, -2px);
      box-shadow: calc(var(--card-offset) + 4px) calc(var(--card-offset) + 4px) 0 var(--variant-brand);
    }

    .card:focus-visible {
      outline: 3px solid var(--variant-brand);
      outline-offset: 3px;
    }

    .card-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 1rem;
      margin-bottom: 1.1rem;
      padding-bottom: 0.85rem;
      border-bottom: 1px solid var(--shadow-rule);
    }

    .card-rank {
      font-family: 'Fraunces', serif;
      font-variation-settings: "opsz" 144, "WONK" 1;
      font-weight: 900;
      font-size: 2.2rem;
      line-height: 0.9;
      letter-spacing: -0.04em;
      color: var(--variant-brand);
    }

    .card-score {
      font-family: 'IBM Plex Mono', monospace;
      font-size: 0.72rem;
      font-weight: 500;
      letter-spacing: 0.08em;
      color: var(--accent-text);
      background: var(--variant-brand);
      padding: 0.3rem 0.55rem;
      white-space: nowrap;
      flex-shrink: 0;
    }

    .card-title {
      font-family: 'Fraunces', serif;
      font-variation-settings: "opsz" 48, "SOFT" 20;
      font-weight: 600;
      font-size: 1.45rem;
      line-height: 1.15;
      letter-spacing: -0.015em;
      color: var(--ink-base);
      margin-bottom: 0.65rem;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .card-desc {
      font-family: 'Inter', sans-serif;
      font-size: 0.92rem;
      color: var(--ink-soft);
      line-height: 1.55;
      margin-bottom: 1.1rem;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
      flex: 1;
    }

    .card-foot {
      font-family: 'IBM Plex Mono', monospace;
      font-size: 0.72rem;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--ink-muted);
      padding-top: 0.8rem;
      border-top: 1px solid var(--shadow-rule);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .card-foot::before {
      content: '→ ';
      color: var(--variant-brand);
    }

    .empty-card {
      width: 100%;
      max-width: 36rem;
      margin: 0 auto;
      padding: 2.5rem 2rem;
      background: var(--paper-raised);
      border: var(--border-weight) var(--border-style) var(--ink);
      box-shadow: 6px 6px 0 var(--variant-brand);
      opacity: 0;
      animation: reveal 220ms 140ms cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
      text-align: center;
    }

    .empty-card p {
      font-family: 'Fraunces', serif;
      font-variation-settings: "opsz" 24;
      font-size: 1.1rem;
      color: var(--ink);
      line-height: 1.5;
    }

    .empty-card p + p {
      margin-top: 0.85rem;
      font-family: 'IBM Plex Mono', monospace;
      font-size: 0.8rem;
      font-style: normal;
      color: var(--ink-muted);
      letter-spacing: 0.03em;
      text-transform: uppercase;
    }

    .empty-card a {
      color: var(--ink);
      text-decoration: underline;
      text-decoration-color: var(--variant-brand);
      text-decoration-thickness: 2px;
      text-underline-offset: 3px;
      font-weight: 500;
    }
    .empty-card a:hover {
      text-decoration-thickness: 3px;
      background: var(--accent-subtle);
    }

    @media (max-width: 640px) {
      .card { padding: 1.25rem 1.25rem 1.1rem; }
      .card-rank { font-size: 1.8rem; }
      .card-title { font-size: 1.2rem; }
    }
  `;

  const head = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(data.variant.copy.title)}</title>${metaRefresh}
${fontsHead()}
${themeBootScript()}
  <style>
${designTokens(data.variant)}
${baseLayout()}
${pageStyles}
  </style>
</head>
<body data-variant="${data.variant.key}">
${atmosphereMarkup()}

  <main>`;

  const close = `
  </main>

${footerMarkup(data.variant)}

${themeToggleScript()}
</body>
</html>`;

  if (data.state === "not_found") {
    return `${head}
${mastheadMarkup(data.variant, {
  title: "Not found",
  tagline: "This person hasn't enrolled yet.",
  eyebrow: `${data.variant.key.toUpperCase()} // 404`,
})}
    <div class="empty-card">
      <p>Want recommendations of your own?</p>
      <p><a href="/">Sign up with your Bluesky handle &rarr;</a></p>
    </div>${close}`;
  }

  if (data.state === "placeholder") {
    return `${head}
${mastheadMarkup(data.variant, {
  title: esc(data.variant.copy.title),
  tagline: esc(data.variant.copy.tagline),
  eyebrow: `${data.variant.key.toUpperCase()} // DRAFT`,
})}
    <div class="empty-card">
      <p>Recommendations for this variant aren't available yet.</p>
      <p>Check back soon — still working on it.</p>
    </div>${close}`;
  }

  const { handle, recs } = data;

  if (recs.length === 0) {
    return `${head}
${mastheadMarkup(data.variant, {
  title: data.variant.copy.recsHeading(esc(handle)),
  tagline: esc(data.variant.copy.tagline),
  eyebrow: `${data.variant.key.toUpperCase()} // SYNCING`,
})}
    <div class="empty-card">
      <p>Syncing your likes — check back shortly.</p>
      <p>This page refreshes automatically.</p>
    </div>${close}`;
  }

  const cards = recs
    .map((r, i) => {
      const score = Math.round(r.score * 100);
      const site = r.site?.replace(/^https?:\/\//, "").replace(/\/$/, "") ?? "";
      const href = r.url ? ` href="${esc(r.url)}" target="_blank" rel="noopener"` : "";
      const rank = String(i + 1).padStart(2, "0");
      const desc = r.description
        ? `\n      <div class="card-desc">${esc(r.description)}</div>`
        : "";
      return `    <a class="card"${href}>
      <div class="card-head">
        <span class="card-rank">${rank}</span>
        <span class="card-score">${score}% MATCH</span>
      </div>
      <div class="card-title">${esc(r.title)}</div>${desc}
      <div class="card-foot">${esc(site)}</div>
    </a>`;
    })
    .join("\n");

  return `${head}
${mastheadMarkup(data.variant, {
  title: data.variant.copy.recsHeading(esc(handle)),
  tagline: esc(data.variant.copy.tagline),
  eyebrow: `${data.variant.key.toUpperCase()} // ${recs.length} PICKS`,
})}
    <div class="grid">
${cards}
    </div>${close}`;
}
