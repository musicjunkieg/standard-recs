/**
 * Variant registry — one entry per branded subdomain.
 *
 * A variant bundles hostname, brand colors (driving the CSS custom
 * properties the page templates emit), per-variant page copy, and
 * the ranking strategy used by generateUserRecommendations.
 *
 * Adding a fourth variant later is one new entry here plus (if it
 * needs a novel ranking strategy) one new arm in RankingStrategy
 * and one new branch in generateUserRecommendations. No other file
 * needs to know.
 */

export type RankingStrategy =
  | { kind: "topN" }
  | { kind: "mmr" }
  | { kind: "placeholder" };

// MMR's lambda and candidate pool size are intentionally NOT on the
// mmr arm. Lambda is tuned post-deploy via the MMR_LAMBDA env var
// (see wrangler.toml + workflow.ts parseMmrLambda); the candidate pool
// is pinned to 50 by Vectorize's per-query cap with returnMetadata="all"
// (see src/recommend/index.ts CANDIDATE_POOL). If per-variant knobs
// ever become necessary, add them back here AND update the recommend
// flow to consume them with env fallback.

export type Variant = {
  key: "standard" | "nonstandard" | "substandard";
  hostname: string;
  brand: {
    /** Primary accent color used for focus rings, match-score chips, etc. */
    hex: string;
    /** Four blob colors for the atmospheric background. Order: main,
     *  cool-contrast, accent, warm-contrast. */
    blobs: [string, string, string, string];
  };
  copy: {
    title: string;
    tagline: string;
    placeholder: string;
    recsHeading: (handle: string) => string;
    footer: string;
  };
  ranking: RankingStrategy;
};

export const VARIANTS: Record<Variant["key"], Variant> = {
  standard: {
    key: "standard",
    hostname: "standardrecs.site",
    brand: {
      hex: "#d99566",
      blobs: ["#d99566", "#7e9eba", "#a78bfa", "#d8a18b"],
    },
    copy: {
      title: "standard-recs",
      tagline: "Discover Standard.site writing based on what you like on Bluesky.",
      placeholder: "Start typing your handle…",
      recsHeading: (handle) => `Recs for @${handle}`,
      footer: "Powered by Standard.site",
    },
    ranking: { kind: "topN" },
  },
  nonstandard: {
    key: "nonstandard",
    hostname: "nonstandardrecs.site",
    brand: {
      hex: "#7e9eba",
      blobs: ["#7e9eba", "#a78bfa", "#9fb59a", "#b8a8d4"],
    },
    copy: {
      title: "nonstandard-recs",
      tagline: "You'd never pick this. Trust us.",
      placeholder: "Start typing your handle…",
      recsHeading: (handle) => `Adjacent picks for @${handle}`,
      footer: "An experiment by standard-recs",
    },
    ranking: { kind: "mmr" },
  },
  substandard: {
    key: "substandard",
    hostname: "substandardrecs.site",
    brand: {
      hex: "#a8b87c",
      blobs: ["#a8b87c", "#c9a87c", "#8a9a7a", "#b5a060"],
    },
    copy: {
      title: "substandard-recs",
      tagline: "You'll hate these.",
      placeholder: "Don't say I didn't warn you…",
      recsHeading: (handle) => `Anti-recs for @${handle}`,
      footer: "An experiment by standard-recs",
    },
    ranking: { kind: "placeholder" },
  },
};

export const HOSTNAME_TO_VARIANT: Record<string, Variant["key"]> = {
  "standardrecs.site": "standard",
  "nonstandardrecs.site": "nonstandard",
  "substandardrecs.site": "substandard",
};

/**
 * Look up a variant by the request's Host header.
 *
 * Unknown hostnames default to `standard` so a misrouted request can
 * never 404 the Worker off the air — dev mode (wrangler dev listens
 * on localhost:8787) falls into this branch and renders the standard
 * variant, which is the safest default.
 */
export function variantFromHost(host: string | undefined): Variant {
  if (host) {
    const key = HOSTNAME_TO_VARIANT[host];
    if (key) return VARIANTS[key];
  }
  return VARIANTS.standard;
}
