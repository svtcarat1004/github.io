# Instagram/Threads proxy worker

A small Cloudflare Worker that fetches Instagram/Threads post pages
server-side and returns the HTML with CORS headers, so `app.js` doesn't have
to depend on flaky public CORS proxies (corsproxy.io, allorigins.win, ...)
for those two platforms. X/Twitter never needs this — its syndication API is
already CORS-open.

It only proxies `instagram.com` / `threads.net` / `threads.com` GET requests,
and (optionally) only from your own site's origin — see `ALLOWED_ORIGINS` in
`proxy-worker.js`.

## Deploy (one-time, ~5 minutes, free)

1. Install Wrangler (Cloudflare's CLI), if you don't have it:
   ```bash
   npm install -g wrangler
   ```
2. Log in (opens a browser to authorize with your Cloudflare account —
   create a free account at https://dash.cloudflare.com/sign-up if needed):
   ```bash
   wrangler login
   ```
3. From this `worker/` directory, deploy:
   ```bash
   cd worker
   wrangler deploy
   ```
4. Wrangler prints your worker's URL, something like:
   ```
   https://social-downloader-proxy.<your-subdomain>.workers.dev
   ```

## Wire it up

1. Open `proxy-worker.js` and set `ALLOWED_ORIGINS` to your GitHub Pages URL
   (e.g. `https://svtcarat1004.github.io`), then re-run `wrangler deploy`.
2. Open `app.js` (repo root) and set `WORKER_PROXY_URL` (near the top) to the
   `*.workers.dev` URL from step 4 above.
3. Commit and push. Instagram/Threads links will now go through your own
   worker first, falling back to the public proxy chain only if the worker
   is unreachable.

## Updating later

Edit `proxy-worker.js`, then run `wrangler deploy` again from `worker/` — it
redeploys to the same URL, no changes needed on the `app.js` side.
