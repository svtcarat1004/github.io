(() => {
  "use strict";

  const form = document.getElementById("download-form");
  const input = document.getElementById("url-input");
  const pasteBtn = document.getElementById("paste-btn");
  const submitBtn = document.getElementById("submit-btn");
  const btnLabel = submitBtn.querySelector(".btn-label");
  const spinner = submitBtn.querySelector(".spinner");
  const errorBox = document.getElementById("error-box");
  const result = document.getElementById("result");
  const resultPlatform = document.getElementById("result-platform");
  const resultCaption = document.getElementById("result-caption");
  const mediaGrid = document.getElementById("media-grid");
  const badges = document.querySelectorAll(".badge");

  // Deploy worker/proxy-worker.js (see worker/README.md) and paste its
  // *.workers.dev URL here for reliable Instagram/Threads fetching. Leave
  // empty ("") to skip straight to the public proxy fallback chain below.
  const WORKER_PROXY_URL = "";

  // Fallback chain for Instagram/Threads (their CDNs / pages don't allow
  // direct cross-origin fetches from arbitrary sites). These public proxies
  // are best-effort and can be rate-limited or blocked at any time — the
  // worker above is the reliable option. Twitter's syndication API is
  // CORS-open and never needs any of this.
  const CORS_PROXIES = [
    ...(WORKER_PROXY_URL ? [(u) => `${WORKER_PROXY_URL}?url=${encodeURIComponent(u)}`] : []),
    (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
    (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    (u) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
    (u) => `https://thingproxy.freeboard.io/fetch/${u}`,
  ];

  function setLoading(isLoading) {
    submitBtn.disabled = isLoading;
    spinner.hidden = !isLoading;
    btnLabel.textContent = isLoading ? "가져오는 중..." : "가져오기";
  }

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
  }

  function clearError() {
    errorBox.hidden = true;
    errorBox.textContent = "";
  }

  function highlightBadge(platform) {
    badges.forEach((b) => b.classList.toggle("active", b.dataset.platform === platform));
  }

  function detectPlatform(rawUrl) {
    let host;
    try {
      host = new URL(rawUrl).hostname.replace(/^www\./, "");
    } catch {
      return null;
    }
    if (["twitter.com", "x.com", "mobile.twitter.com"].includes(host)) return "twitter";
    if (host === "instagram.com") return "instagram";
    if (host === "threads.net" || host === "threads.com") return "threads";
    return null;
  }

  function decodeJsonString(raw) {
    try {
      return JSON.parse(`"${raw}"`);
    } catch {
      return raw;
    }
  }

  async function fetchViaProxy(targetUrl) {
    let lastErr;
    for (const build of CORS_PROXIES) {
      try {
        const res = await fetch(build(targetUrl));
        if (!res.ok) continue;
        const text = await res.text();
        if (text && text.length > 200) return text;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error("페이지를 가져오지 못했습니다.");
  }

  // ---------- Twitter / X ----------

  function extractTweetId(url) {
    const m = url.match(/status(?:es)?\/(\d+)/);
    if (!m) throw new Error("트윗 링크에서 게시물 ID를 찾을 수 없습니다.");
    return m[1];
  }

  function tweetToken(id) {
    return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
  }

  function forceOrigQuality(imgUrl) {
    const base = imgUrl.split("?")[0];
    return `${base}?format=jpg&name=orig`;
  }

  async function resolveTwitter(url) {
    const id = extractTweetId(url);
    const token = tweetToken(id);
    // cdn.syndication.twimg.com only sends
    // Access-Control-Allow-Origin: https://platform.twitter.com, so a direct
    // browser fetch from any other origin is blocked by CORS. Route through
    // the same proxy chain used for Instagram/Threads.
    const text = await fetchViaProxy(
      `https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${token}`
    );
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("트윗 정보를 가져오지 못했습니다. 비공개 계정이거나 삭제된 게시물일 수 있어요.");
    }
    if (data.__typename === "TweetTombstone") {
      throw new Error("이 트윗은 비공개이거나 삭제되어 가져올 수 없습니다.");
    }

    const items = [];

    if (Array.isArray(data.photos)) {
      for (const p of data.photos) {
        items.push({ type: "image", url: forceOrigQuality(p.url), thumb: p.url });
      }
    }

    if (data.video && Array.isArray(data.video.variants)) {
      const variants = data.video.variants
        .filter((v) => (v.type || v.content_type) === "video/mp4")
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      if (variants.length) {
        const best = variants[0];
        items.push({
          type: "video",
          url: best.src || best.url,
          thumb: data.video.poster || data.video.poster_url,
        });
      }
    }

    if (Array.isArray(data.mediaDetails)) {
      for (const m of data.mediaDetails) {
        if (m.type === "photo" && !items.some((i) => i.type === "image")) {
          items.push({ type: "image", url: forceOrigQuality(m.media_url_https), thumb: m.media_url_https });
        } else if ((m.type === "video" || m.type === "animated_gif") && !items.some((i) => i.type === "video")) {
          const variants = (m.video_info?.variants || [])
            .filter((v) => v.content_type === "video/mp4")
            .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
          if (variants.length) {
            items.push({ type: "video", url: variants[0].url, thumb: m.media_url_https });
          }
        }
      }
    }

    if (!items.length) {
      throw new Error("이 트윗에서 사진이나 동영상을 찾지 못했습니다.");
    }

    return {
      platform: "X (Twitter)",
      caption: data.text || "",
      items,
    };
  }

  // ---------- Instagram ----------

  function extractInstagramShortcode(url) {
    const m = url.match(/\/(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
    if (!m) throw new Error("인스타그램 게시물 링크가 아닌 것 같아요.");
    return { type: m[1] === "reels" ? "reel" : m[1], shortcode: m[2] };
  }

  function extractMediaFromJsonBlob(html) {
    const images = [];
    const videos = [];

    const imgRe = /"candidates":\[\{"width":\d+,"height":\d+,"url":"((?:[^"\\]|\\.)*)"/g;
    let m;
    while ((m = imgRe.exec(html))) {
      images.push(decodeJsonString(m[1]));
    }

    const vidRe = /"video_versions":\[\{"type":\d+,"width":\d+,"height":\d+,"url":"((?:[^"\\]|\\.)*)"/g;
    while ((m = vidRe.exec(html))) {
      videos.push(decodeJsonString(m[1]));
    }

    if (!images.length && !videos.length) {
      const ogVideo = html.match(/<meta property="og:video(?::secure_url)?" content="([^"]+)"/);
      const ogImage = html.match(/<meta property="og:image" content="([^"]+)"/);
      if (ogVideo) videos.push(ogVideo[1].replace(/&amp;/g, "&"));
      else if (ogImage) images.push(ogImage[1].replace(/&amp;/g, "&"));
    }

    return { images: [...new Set(images)], videos: [...new Set(videos)] };
  }

  function extractCaption(html) {
    const m = html.match(/<meta property="og:title" content="([^"]+)"/);
    return m ? m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&") : "";
  }

  async function resolveInstagram(url) {
    const { type, shortcode } = extractInstagramShortcode(url);
    const embedUrl = `https://www.instagram.com/${type}/${shortcode}/embed/captioned/`;

    let html = await fetchViaProxy(embedUrl);
    let { images, videos } = extractMediaFromJsonBlob(html);

    if (!images.length && !videos.length) {
      html = await fetchViaProxy(`https://www.instagram.com/${type}/${shortcode}/`);
      ({ images, videos } = extractMediaFromJsonBlob(html));
    }

    if (!images.length && !videos.length) {
      throw new Error(
        "미디어를 찾지 못했습니다. 비공개 계정이거나 로그인이 필요한 게시물일 수 있어요."
      );
    }

    const items = [
      ...videos.map((u) => ({ type: "video", url: u, thumb: images[0] })),
      ...(videos.length ? [] : images.map((u) => ({ type: "image", url: u, thumb: u }))),
    ];

    return {
      platform: "Instagram",
      caption: extractCaption(html),
      items,
    };
  }

  // ---------- Threads ----------

  function normalizeThreadsUrl(url) {
    return url.replace("threads.com", "threads.net");
  }

  async function resolveThreads(url) {
    if (!/\/post\/|\/t\//.test(url)) {
      throw new Error("스레드 게시물 링크가 아닌 것 같아요.");
    }
    const html = await fetchViaProxy(normalizeThreadsUrl(url));
    const { images, videos } = extractMediaFromJsonBlob(html);

    if (!images.length && !videos.length) {
      throw new Error(
        "미디어를 찾지 못했습니다. 비공개 계정이거나 로그인이 필요한 게시물일 수 있어요."
      );
    }

    const items = [
      ...videos.map((u) => ({ type: "video", url: u, thumb: images[0] })),
      ...(videos.length ? [] : images.map((u) => ({ type: "image", url: u, thumb: u }))),
    ];

    return {
      platform: "Threads",
      caption: extractCaption(html),
      items,
    };
  }

  // ---------- rendering ----------

  function extFor(type, url) {
    if (type === "video") return "mp4";
    const m = url.match(/\.(jpg|jpeg|png|webp)(?:\?|$)/i);
    return m ? m[1].toLowerCase() : "jpg";
  }

  async function downloadMedia(url, filename, btn) {
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = "저장 중...";
    try {
      const res = await fetch(url, { mode: "cors" });
      if (!res.ok) throw new Error("fetch failed");
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
    } catch {
      // CORS-restricted CDN (common for Instagram/Threads): fall back to
      // opening the direct media URL so the user can save it manually.
      window.open(url, "_blank", "noopener");
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }

  function renderResult(data) {
    resultPlatform.textContent = data.platform;
    resultCaption.textContent = data.caption || "";
    mediaGrid.innerHTML = "";

    data.items.forEach((item, i) => {
      const card = document.createElement("div");
      card.className = "media-item";

      const preview = document.createElement(item.type === "video" ? "video" : "img");
      preview.className = "preview";
      if (item.type === "video") {
        preview.src = item.url;
        preview.controls = true;
        preview.poster = item.thumb || "";
      } else {
        preview.src = item.thumb || item.url;
        preview.loading = "lazy";
        preview.alt = "media preview";
      }
      card.appendChild(preview);

      const meta = document.createElement("div");
      meta.className = "meta";

      const kind = document.createElement("div");
      kind.className = "kind";
      kind.textContent = item.type === "video" ? `동영상 ${i + 1}` : `사진 ${i + 1}`;
      meta.appendChild(kind);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "dl-btn";
      btn.textContent = "원본 화질로 저장";
      const filename = `${data.platform.replace(/[^a-zA-Z0-9]/g, "")}_${Date.now()}_${i + 1}.${extFor(item.type, item.url)}`;
      btn.addEventListener("click", () => downloadMedia(item.url, filename, btn));
      meta.appendChild(btn);

      card.appendChild(meta);
      mediaGrid.appendChild(card);
    });

    result.hidden = false;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    clearError();
    result.hidden = true;

    const url = input.value.trim();
    if (!url) return;

    const platform = detectPlatform(url);
    highlightBadge(platform);

    if (!platform) {
      showError("X(트위터), 인스타그램, 스레드 링크만 지원합니다.");
      return;
    }

    setLoading(true);
    try {
      let data;
      if (platform === "twitter") data = await resolveTwitter(url);
      else if (platform === "instagram") data = await resolveInstagram(url);
      else data = await resolveThreads(url);

      renderResult(data);
    } catch (err) {
      showError(err.message || "알 수 없는 오류가 발생했습니다.");
    } finally {
      setLoading(false);
    }
  }

  pasteBtn.addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        input.value = text.trim();
        input.focus();
      }
    } catch {
      showError("클립보드 접근 권한이 없습니다. 직접 붙여넣어 주세요.");
    }
  });

  input.addEventListener("input", () => {
    highlightBadge(detectPlatform(input.value.trim()));
  });

  form.addEventListener("submit", handleSubmit);
})();
