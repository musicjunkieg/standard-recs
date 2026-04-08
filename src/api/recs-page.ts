/**
 * Recommendations page — served at /recs/:did
 *
 * Three states:
 *   1. User found, has recs → stacked cards
 *   2. User found, no recs → "syncing" message with meta-refresh
 *   3. User not found → 404 with link to enroll
 */

type Rec = {
  uri: string;
  score: number;
  title: string;
  description: string | null;
  url: string | null;
  site: string | null;
};

type RecsPageData =
  | { state: "found"; handle: string; did: string; recs: Rec[] }
  | { state: "not_found" };

export function recsPage(data: RecsPageData): string {
  const head = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>standard-recs</title>${data.state === "found" && data.recs.length === 0 ? '\n  <meta http-equiv="refresh" content="30">' : ""}
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
      padding: 2rem 1.5rem;
    }

    .container {
      max-width: 420px;
      width: 100%;
    }

    h1 {
      font-family: 'Newsreader', serif;
      font-size: 1.75rem;
      font-weight: 600;
      letter-spacing: -0.02em;
      margin-bottom: 0.25rem;
    }

    .subtitle {
      font-family: 'Newsreader', serif;
      font-style: italic;
      color: #7a6f66;
      font-size: 1.05rem;
      margin-bottom: 1.5rem;
      line-height: 1.4;
    }

    .card {
      display: block;
      background: #fff;
      border: 1px solid #ede8e3;
      border-radius: 10px;
      padding: 1rem 1.15rem;
      margin-bottom: 0.75rem;
      text-decoration: none;
      color: inherit;
      transition: border-color 0.15s, box-shadow 0.15s;
    }

    .card:hover {
      border-color: #b8a898;
      box-shadow: 0 2px 8px rgba(42, 37, 34, 0.06);
    }

    .card-title {
      font-family: 'Newsreader', serif;
      font-size: 1.05rem;
      font-weight: 600;
      margin-bottom: 0.3rem;
    }

    .card-desc {
      font-size: 0.85rem;
      color: #7a6f66;
      line-height: 1.4;
      margin-bottom: 0.5rem;
    }

    .card-meta {
      display: flex;
      justify-content: space-between;
      font-size: 0.78rem;
      color: #b8a898;
    }

    .empty {
      text-align: center;
      padding: 3rem 1rem;
    }

    .empty p {
      font-size: 0.95rem;
      color: #7a6f66;
      line-height: 1.5;
    }

    .nav {
      margin-top: 2rem;
      font-size: 0.85rem;
      color: #b8a898;
    }

    .nav a {
      color: #7a6f66;
    }

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
  <div class="container">`;

  const footer = `
    <div class="nav">
      <a href="/recs">Look up another user</a> · <a href="/">Enroll</a>
    </div>
  </div>

  <footer>
    Powered by <a href="https://standard.site">Standard.site</a>
    &middot; <a href="https://atproto.com">AT Protocol</a>
  </footer>
</body>
</html>`;

  if (data.state === "not_found") {
    return `${head}
    <h1>User not found</h1>
    <p class="subtitle">This person hasn't enrolled yet.</p>
    <p style="font-size:0.9rem;color:#7a6f66;">
      Want recommendations? <a href="/" style="color:#7a6f66;font-weight:500;">Sign up with your Bluesky handle</a>.
    </p>
${footer}`;
  }

  const { handle, recs } = data;

  if (recs.length === 0) {
    return `${head}
    <h1>Recs for @${esc(handle)}</h1>
    <div class="empty">
      <p>We're syncing your likes — check back shortly.</p>
      <p style="margin-top:0.5rem;font-size:0.8rem;color:#b8a898;">This page refreshes automatically.</p>
    </div>
${footer}`;
  }

  const cards = recs
    .map((r) => {
      const score = Math.round(r.score * 100);
      const site = r.site?.replace(/^https?:\/\//, "").replace(/\/$/, "") ?? "";
      const href = r.url ? ` href="${esc(r.url)}" target="_blank" rel="noopener"` : "";
      return `    <a class="card"${href}>
      <div class="card-title">${esc(r.title)}</div>${r.description ? `\n      <div class="card-desc">${esc(r.description)}</div>` : ""}
      <div class="card-meta">
        <span>${esc(site)}</span>
        <span>${score}% match</span>
      </div>
    </a>`;
    })
    .join("\n");

  return `${head}
    <h1>Recs for @${esc(handle)}</h1>
    <p class="subtitle">Standard.site writing picked for your taste.</p>
${cards}
${footer}`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
