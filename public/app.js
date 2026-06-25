const authArea = document.getElementById("auth-area");
const setupAlert = document.getElementById("setup-alert");
const errorAlert = document.getElementById("error-alert");
const feedSection = document.getElementById("feed-section");
const loginSection = document.getElementById("login-section");
const loginBtn = document.getElementById("login-btn");
const refreshBtn = document.getElementById("refresh-btn");
const videoGrid = document.getElementById("video-grid");
const emptyState = document.getElementById("empty-state");
const feedMeta = document.getElementById("feed-meta");
const callbackHint = document.getElementById("callback-hint");
const tabs = document.querySelectorAll(".tab");
const modal = document.getElementById("player-modal");
const modalVideo = document.getElementById("modal-video");
const modalTitle = document.getElementById("modal-title");
const modalClose = document.getElementById("modal-close");
const modalFallback = document.getElementById("modal-fallback");
const modalTweetLink = document.getElementById("modal-tweet-link");
const embedContainer = document.getElementById("embed-container");

let currentSource = "home";
let cachedVideos = [];

function showError(message) {
  if (!message) {
    errorAlert.hidden = true;
    errorAlert.textContent = "";
    return;
  }
  errorAlert.hidden = false;
  errorAlert.textContent = message;
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatDuration(ms) {
  if (!ms) return "";
  const sec = Math.round(ms / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function renderAuth(user) {
  if (!user) {
    authArea.innerHTML = "";
    return;
  }

  authArea.innerHTML = `
    <img src="${escapeHtml(user.profile_image_url)}" alt="" />
    <div>
      <div class="name">${escapeHtml(user.name)}</div>
      <div class="meta">@${escapeHtml(user.username)}</div>
    </div>
    <button id="logout-btn" class="btn btn-ghost" type="button">退出</button>
  `;

  document.getElementById("logout-btn").addEventListener("click", async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    location.reload();
  });
}

function renderVideos(videos, disclaimer) {
  cachedVideos = videos;
  videoGrid.innerHTML = "";

  if (!videos.length) {
    emptyState.hidden = false;
    feedMeta.textContent = disclaimer || "";
    return;
  }

  emptyState.hidden = true;
  feedMeta.textContent = `共 ${videos.length} 个视频 · ${disclaimer || ""}`;

  for (const item of videos) {
    const card = document.createElement("article");
    card.className = "card";

    const authorLine = item.author
      ? `<div class="author">
          <img src="${escapeHtml(item.author.profileImage)}" alt="" />
          <span>@${escapeHtml(item.author.username)}</span>
        </div>`
      : "";

    const duration = formatDuration(item.durationMs);

    card.innerHTML = `
      <div class="thumb-wrap" data-id="${item.tweetId}">
        <img src="${escapeHtml(item.previewUrl || "")}" alt="视频预览" loading="lazy" />
        <div class="play-badge">▶</div>
      </div>
      <div class="card-body">
        ${authorLine}
        <p class="tweet-text">${escapeHtml(item.text)}</p>
        <div class="meta">${duration ? `时长 ${duration} · ` : ""}${item.createdAt ? new Date(item.createdAt).toLocaleString() : ""}</div>
        <div class="card-actions">
          <button class="btn btn-primary play-btn" data-id="${item.tweetId}" type="button">播放</button>
          <a class="btn btn-ghost" href="https://x.com/i/status/${item.tweetId}" target="_blank" rel="noreferrer">原帖</a>
        </div>
      </div>
    `;

    videoGrid.appendChild(card);
  }

  videoGrid.querySelectorAll(".play-btn, .thumb-wrap").forEach((el) => {
    el.addEventListener("click", () => {
      const id = el.dataset.id;
      const video = cachedVideos.find((v) => v.tweetId === id);
      if (video) openPlayer(video);
    });
  });
}

async function loadWidgets() {
  if (window.twttr?.widgets) return window.twttr;
  await new Promise((resolve, reject) => {
    const check = () => {
      if (window.twttr?.widgets) resolve(window.twttr);
      else setTimeout(check, 100);
    };
    setTimeout(() => reject(new Error("widgets 加载超时")), 8000);
    check();
  });
  return window.twttr;
}

async function openPlayer(item) {
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  modalTitle.textContent = item.author ? `@${item.author.username}` : "播放视频";
  embedContainer.innerHTML = "";
  modalFallback.hidden = true;
  modalVideo.pause();
  modalVideo.removeAttribute("src");
  modalVideo.load();

  modalTweetLink.href = `https://x.com/i/status/${item.tweetId}`;

  if (item.videoUrl) {
    modalVideo.src = item.videoUrl;
    modalVideo.hidden = false;
    modalVideo.play().catch(() => {
      modalFallback.hidden = false;
    });
  } else {
    modalVideo.hidden = true;
    modalFallback.hidden = false;
  }

  try {
    const twttr = await loadWidgets();
    await twttr.widgets.createTweet(item.tweetId, embedContainer, {
      theme: "dark",
      align: "center",
      dnt: true,
      conversation: "none",
    });
  } catch {
    modalFallback.hidden = false;
  }
}

function closeModal() {
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
  modalVideo.pause();
  modalVideo.removeAttribute("src");
  embedContainer.innerHTML = "";
}

modalClose.addEventListener("click", closeModal);
modal.addEventListener("click", (e) => {
  if (e.target === modal) closeModal();
});

async function fetchVideos() {
  showError("");
  feedMeta.textContent = "加载中…";
  videoGrid.innerHTML = "";

  const res = await fetch(`/api/videos?source=${currentSource}`);
  const data = await res.json();

  if (!res.ok) {
    showError(data.error || "加载失败");
    feedMeta.textContent = "";
    return;
  }

  renderVideos(data.videos, data.disclaimer);
}

async function init() {
  const params = new URLSearchParams(location.search);
  const authError = params.get("auth_error");
  if (authError) {
    showError(`登录失败：${authError}`);
    history.replaceState({}, "", "/");
  }

  const configRes = await fetch("/api/config");
  const config = await configRes.json();

  if (!config.configured) {
    setupAlert.hidden = false;
    loginBtn.disabled = true;
  } else if (config.callbackUrl) {
    callbackHint.textContent = config.callbackUrl;
  }

  loginBtn.addEventListener("click", () => {
    location.href = "/api/auth/login";
  });

  refreshBtn.addEventListener("click", fetchVideos);

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      currentSource = tab.dataset.source;
      fetchVideos();
    });
  });

  const meRes = await fetch("/api/auth/me");
  const me = await meRes.json();

  if (me.loggedIn) {
    loginSection.hidden = true;
    feedSection.hidden = false;
    renderAuth(me.user);
    await fetchVideos();
  }
}

init();
