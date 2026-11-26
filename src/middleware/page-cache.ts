import type { Env } from "../types.ts";

// Whole-page cache for public blog pages. Content rarely changes, so the vast
// majority of requests are served from KV (edge-replicated) with zero D1 reads.
// A single monotonic version key invalidates every cached page at once.

const VERSION_KEY = "__page_version";
const TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days; version bump is the real invalidation

async function currentVersion(env: Env): Promise<number> {
  const raw = await env.PAGES.get(VERSION_KEY);
  const n = raw ? Number(raw) : 0;
  return Number.isSafeInteger(n) && n > 0 ? n : 1;
}

/** Invalidate all cached public pages. Call after any content/config write. */
export async function invalidatePages(env: Env): Promise<void> {
  try {
    const next = await currentVersion(env) + 1;
    await env.PAGES.put(VERSION_KEY, String(next));
  } catch {
    // Cache invalidation must never break a write. Worst case: stale for TTL.
  }
}

function pageKey(version: number, path: string, query: string): string {
  return `v${version}:${path}${query ? `?${query}` : ""}`;
}

/**
 * Wrap a public GET handler with edge page caching.
 * Only caches 200 HTML responses; query strings are part of the cache key.
 * Admin/API routes and non-GET requests must not call this.
 */
export async function cachedPage(
  c: { env: Env; req: { method: string; url: string } },
  render: () => Promise<Response>,
): Promise<Response> {
  if (c.req.method !== "GET") return render();

  const url = new URL(c.req.url);
  let version = 1;
  let key = "";
  try {
    version = await currentVersion(c.env);
    key = pageKey(version, url.pathname, url.searchParams.toString());
    const hit = await c.env.PAGES.get(key);
    if (hit !== null) {
      return new Response(hit, {
        headers: {
          "Content-Type": "text/html; charset=UTF-8",
          "Cache-Control": "public, s-maxage=300, stale-while-revalidate=86400",
          "X-Cache": "HIT",
        },
      });
    }
  } catch {
    // KV unavailable: fall through to a fresh render.
  }

  const response = await render();
  if (response.status === 200) {
    try {
      const body = await response.clone().text();
      await c.env.PAGES.put(key, body, { expirationTtl: TTL_SECONDS });
    } catch {
      // Caching is best-effort.
    }
  }
  return response;
}
