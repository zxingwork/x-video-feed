import crypto from "crypto";
import express from "express";
import session from "express-session";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const isProd = process.env.NODE_ENV === "production";
const publicBaseUrl =
  process.env.RENDER_EXTERNAL_URL ||
  process.env.PUBLIC_BASE_URL ||
  `http://localhost:${process.env.PORT || 3000}`;

const {
  X_CLIENT_ID,
  X_CLIENT_SECRET,
  PORT = 3000,
  SESSION_SECRET = "dev-only-change-me",
} = process.env;

const X_CALLBACK_URL =
  process.env.X_CALLBACK_URL || `${publicBaseUrl.replace(/\/$/, "")}/api/auth/callback`;

if (isProd) {
  app.set("trust proxy", 1);
}

const SCOPES = ["tweet.read", "users.read", "like.read", "offline.access"].join(" ");
const AUTH_URL = "https://twitter.com/i/oauth2/authorize";
const TOKEN_URL = "https://api.twitter.com/2/oauth2/token";
const API_BASE = "https://api.x.com/2";

if (!X_CLIENT_ID || !X_CLIENT_SECRET) {
  console.warn(
    "\n⚠  未配置 X_CLIENT_ID / X_CLIENT_SECRET。\n" +
      "   复制 .env.example 为 .env 并填入 X 开发者应用凭证后再运行。\n"
  );
}

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: isProd,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  })
);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function base64Url(buffer) {
  return buffer.toString("base64url");
}

function createPkce() {
  const verifier = base64Url(crypto.randomBytes(32));
  const challenge = base64Url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function requireConfig(req, res, next) {
  if (!X_CLIENT_ID || !X_CLIENT_SECRET) {
    return res.status(500).json({
      error: "服务器未配置 X API 凭证。请设置 .env 中的 X_CLIENT_ID 与 X_CLIENT_SECRET。",
    });
  }
  next();
}

async function exchangeToken(body) {
  const auth = Buffer.from(`${X_CLIENT_ID}:${X_CLIENT_SECRET}`).toString("base64");
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${auth}`,
    },
    body: new URLSearchParams(body),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error_description || data.error || "Token 请求失败");
  }
  return data;
}

async function ensureAccessToken(req) {
  const auth = req.session.xAuth;
  if (!auth?.accessToken) {
    throw new Error("未登录");
  }

  if (!auth.expiresAt || Date.now() < auth.expiresAt - 60_000) {
    return auth.accessToken;
  }

  if (!auth.refreshToken) {
    throw new Error("登录已过期，请重新登录");
  }

  const token = await exchangeToken({
    grant_type: "refresh_token",
    refresh_token: auth.refreshToken,
    client_id: X_CLIENT_ID,
  });

  req.session.xAuth = {
    ...auth,
    accessToken: token.access_token,
    refreshToken: token.refresh_token || auth.refreshToken,
    expiresAt: Date.now() + (token.expires_in || 7200) * 1000,
  };

  return req.session.xAuth.accessToken;
}

async function xGet(req, url) {
  const token = await ensureAccessToken(req);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await response.json();
  if (!response.ok) {
    const msg = data?.detail || data?.title || data?.errors?.[0]?.message || response.statusText;
    throw new Error(msg);
  }
  return data;
}

function pickBestVideoUrl(media) {
  const variants = (media.variants || []).filter((v) => v.content_type === "video/mp4" && v.url);
  if (!variants.length) return null;
  variants.sort((a, b) => (b.bit_rate || 0) - (a.bit_rate || 0));
  return variants[0].url;
}

function extractVideoPosts(payload) {
  const tweets = payload.data || [];
  const mediaList = payload.includes?.media || [];
  const users = payload.includes?.users || [];
  const mediaMap = new Map(mediaList.map((m) => [m.media_key, m]));
  const userMap = new Map(users.map((u) => [u.id, u]));

  const videos = [];

  for (const tweet of tweets) {
    const keys = tweet.attachments?.media_keys || [];
    for (const key of keys) {
      const media = mediaMap.get(key);
      if (!media || (media.type !== "video" && media.type !== "animated_gif")) continue;

      const author = userMap.get(tweet.author_id);
      videos.push({
        tweetId: tweet.id,
        text: tweet.text || "",
        createdAt: tweet.created_at,
        author: author
          ? {
              id: author.id,
              username: author.username,
              name: author.name,
              profileImage: author.profile_image_url,
            }
          : null,
        previewUrl: media.preview_image_url || null,
        videoUrl: pickBestVideoUrl(media),
        mediaType: media.type,
        durationMs: media.duration_ms || null,
        metrics: tweet.public_metrics || null,
      });
    }
  }

  return videos;
}

const TIMELINE_PARAMS = new URLSearchParams({
  max_results: "100",
  "tweet.fields": "created_at,author_id,attachments,public_metrics,text",
  expansions: "attachments.media_keys,author_id",
  "media.fields": "type,preview_image_url,variants,duration_ms,public_metrics",
  "user.fields": "username,name,profile_image_url",
  exclude: "retweets,replies",
});

async function fetchVideoFeed(req, source) {
  const userId = req.session.xAuth.userId;
  let pathPart;

  if (source === "likes") {
    pathPart = `users/${userId}/liked_tweets`;
  } else {
    pathPart = `users/${userId}/timelines/reverse_chronological`;
  }

  const allVideos = [];
  let paginationToken;

  for (let page = 0; page < 3; page += 1) {
    const params = new URLSearchParams(TIMELINE_PARAMS);
    if (paginationToken) params.set("pagination_token", paginationToken);

    const payload = await xGet(req, `${API_BASE}/${pathPart}?${params}`);
    allVideos.push(...extractVideoPosts(payload));

    paginationToken = payload.meta?.next_token;
    if (!paginationToken) break;
  }

  return allVideos;
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/config", (req, res) => {
  res.json({
    configured: Boolean(X_CLIENT_ID && X_CLIENT_SECRET),
    callbackUrl: X_CALLBACK_URL,
    publicBaseUrl,
  });
});

app.get("/api/auth/login", requireConfig, (req, res) => {
  const state = base64Url(crypto.randomBytes(16));
  const { verifier, challenge } = createPkce();

  req.session.oauth = { state, verifier };

  const params = new URLSearchParams({
    response_type: "code",
    client_id: X_CLIENT_ID,
    redirect_uri: X_CALLBACK_URL,
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  res.redirect(`${AUTH_URL}?${params}`);
});

app.get("/api/auth/callback", requireConfig, async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.redirect(`/?auth_error=${encodeURIComponent(String(error))}`);
  }

  if (!code || !state || state !== req.session.oauth?.state) {
    return res.redirect("/?auth_error=invalid_state");
  }

  try {
    const token = await exchangeToken({
      grant_type: "authorization_code",
      code: String(code),
      redirect_uri: X_CALLBACK_URL,
      code_verifier: req.session.oauth.verifier,
      client_id: X_CLIENT_ID,
    });

    req.session.xAuth = {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: Date.now() + (token.expires_in || 7200) * 1000,
      userId: null,
      user: null,
    };

    const me = await xGet(req, `${API_BASE}/users/me?user.fields=username,name,profile_image_url`);
    req.session.xAuth.userId = me.data.id;
    req.session.xAuth.user = me.data;
    delete req.session.oauth;

    res.redirect("/");
  } catch (err) {
    res.redirect(`/?auth_error=${encodeURIComponent(err.message)}`);
  }
});

app.get("/api/auth/me", (req, res) => {
  if (!req.session.xAuth?.accessToken) {
    return res.json({ loggedIn: false });
  }
  res.json({
    loggedIn: true,
    user: req.session.xAuth.user,
  });
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.get("/api/videos", async (req, res) => {
  try {
    if (!req.session.xAuth?.accessToken) {
      return res.status(401).json({ error: "请先登录 X 账户" });
    }

    const source = req.query.source === "likes" ? "likes" : "home";
    const videos = await fetchVideoFeed(req, source);

    res.json({
      source,
      count: videos.length,
      videos,
      disclaimer:
        source === "home"
          ? "首页时间线为「关注账号的最近帖子」（时间倒序），不是 X App 里的算法「为你推荐」流。"
          : "此处显示你点赞过的含视频帖子。",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`X Video Feed → ${publicBaseUrl}`);
  console.log(`Callback URL（须在 X 开发者后台登记）→ ${X_CALLBACK_URL}`);
});
