/**
 * Cloudflare Worker: restricted fetch proxy for Instagram / Threads / X.
 *
 * The public page (index.html/app.js) needs the raw HTML of an Instagram or
 * Threads post (or the JSON from Twitter's syndication API) to pull the
 * original-quality media URL out. None of these send CORS headers that
 * allow an arbitrary site to read them directly, so this worker fetches
 * them server-side and hands the response back with permissive CORS
 * headers.
 *
 * It intentionally is NOT a general-purpose open proxy:
 *  - only GET is allowed
 *  - only exact-match hostnames in ALLOWED_TARGET_HOSTS may be targeted
 *  - only requests whose Origin/Referer match ALLOWED_ORIGINS are served
 *
 * Deploy with Wrangler (see worker/README.md), then paste the resulting
 * `*.workers.dev` URL into WORKER_PROXY_URL at the top of app.js.
 */

const ALLOWED_TARGET_HOSTS = new Set([
  "instagram.com",
  "www.instagram.com",
  "threads.net",
  "www.threads.net",
  "threads.com",
  "www.threads.com",
  "cdn.syndication.twimg.com",
]);

// Add your GitHub Pages origin(s) here. Leave the array empty to allow any
// caller (fine for a low-traffic personal tool, but anyone could then use
// your worker as a free Instagram/Threads proxy).
const ALLOWED_ORIGINS = [
  "https://svtcarat1004.github.io",
];

const UPSTREAM_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function isOriginAllowed(origin) {
  if (ALLOWED_ORIGINS.length === 0) return true;
  return !!origin && ALLOWED_ORIGINS.includes(origin);
}

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin") || "";
    const headers = corsHeaders(origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    if (request.method !== "GET") {
      return json({ error: "Method not allowed" }, 405, headers);
    }

    if (!isOriginAllowed(origin)) {
      return json({ error: "Origin not allowed" }, 403, headers);
    }

    const requestUrl = new URL(request.url);
    const target = requestUrl.searchParams.get("url");
    if (!target) {
      return json({ error: "Missing 'url' query parameter" }, 400, headers);
    }

    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch {
      return json({ error: "Invalid target URL" }, 400, headers);
    }

    if (targetUrl.protocol !== "https:" || !ALLOWED_TARGET_HOSTS.has(targetUrl.hostname)) {
      return json({ error: "Target host not allowed" }, 403, headers);
    }

    try {
      const upstream = await fetch(targetUrl.toString(), {
        headers: {
          "User-Agent": UPSTREAM_USER_AGENT,
          "Accept-Language": "en-US,en;q=0.9",
          "Accept": "text/html,application/xhtml+xml",
        },
        redirect: "follow",
        cf: { cacheTtl: 0 },
      });

      const html = await upstream.text();
      return new Response(html, {
        status: upstream.status,
        headers: {
          ...headers,
          "Content-Type": "text/html; charset=utf-8",
        },
      });
    } catch (err) {
      return json({ error: "Upstream fetch failed", detail: String(err) }, 502, headers);
    }
  },
};

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}
