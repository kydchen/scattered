const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const STATE_TTL_MS = 10 * 60 * 1_000;
const SESSION_VERSION = "v1";
const SESSION_AAD = textBytes("scattered-drive-session-v1");

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },
};

export async function handleRequest(request, env) {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/oauth/start") return startOAuth(request, env);
  if (request.method === "GET" && url.pathname === "/oauth/callback") return finishOAuth(request, env);
  if (request.method === "OPTIONS" && url.pathname === "/token") {
    return corsResponse(request, env, null, 204);
  }
  if (request.method === "POST" && url.pathname === "/token") return issueAccessToken(request, env);
  return response("Not found", 404);
}

async function startOAuth(request, env) {
  requireConfig(env);
  const url = new URL(request.url);
  const returnTo = allowedReturnUrl(url.searchParams.get("return_to"), env);
  if (!returnTo) return response("Invalid return URL", 400);
  const state = await signState({
    returnTo,
    nonce: crypto.randomUUID(),
    expiresAt: Date.now() + STATE_TTL_MS,
  }, env.SESSION_SECRET);
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: callbackUrl(request, env),
    response_type: "code",
    scope: DRIVE_SCOPE,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return redirect(`${GOOGLE_AUTH_URL}?${params}`);
}

async function finishOAuth(request, env) {
  requireConfig(env);
  const url = new URL(request.url);
  let state;
  try {
    state = await verifyState(url.searchParams.get("state"), env.SESSION_SECRET);
  } catch {
    return response("Invalid authorization state", 400);
  }
  const returnTo = allowedReturnUrl(state.returnTo, env);
  if (!returnTo) return response("Invalid return URL", 400);
  if (url.searchParams.get("error")) return authRedirect(returnTo, null, "denied");
  const code = url.searchParams.get("code");
  if (!code) return authRedirect(returnTo, null, "missing_code");

  try {
    const token = await googleTokenRequest({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      code,
      redirect_uri: callbackUrl(request, env),
      grant_type: "authorization_code",
    });
    if (typeof token.refresh_token !== "string" || !token.refresh_token) {
      return authRedirect(returnTo, null, "missing_refresh_token");
    }
    const session = await sealSession({ refreshToken: token.refresh_token, issuedAt: Date.now() }, env.SESSION_SECRET);
    return authRedirect(returnTo, session, null);
  } catch {
    return authRedirect(returnTo, null, "exchange_failed");
  }
}

async function issueAccessToken(request, env) {
  requireConfig(env);
  const origin = allowedOrigin(request, env);
  if (!origin) return response("Forbidden", 403);
  let session;
  try {
    session = await openSession(bearerToken(request), env.SESSION_SECRET);
  } catch {
    return corsJson(origin, { error: "authorization_expired" }, 401);
  }
  try {
    const token = await googleTokenRequest({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: session.refreshToken,
      grant_type: "refresh_token",
    });
    if (typeof token.access_token !== "string" || !token.access_token) throw new Error("Missing access token");
    const nextRefreshToken = typeof token.refresh_token === "string" && token.refresh_token
      ? token.refresh_token
      : session.refreshToken;
    const nextSession = nextRefreshToken === session.refreshToken
      ? null
      : await sealSession({ refreshToken: nextRefreshToken, issuedAt: Date.now() }, env.SESSION_SECRET);
    return corsJson(origin, {
      accessToken: token.access_token,
      expiresIn: Math.max(30, Number(token.expires_in) || 3_600),
      ...(nextSession ? { session: nextSession } : {}),
    });
  } catch (error) {
    const status = error?.status === 400 || error?.status === 401 ? 401 : 502;
    return corsJson(origin, { error: status === 401 ? "authorization_expired" : "token_unavailable" }, status);
  }
}

async function googleTokenRequest(fields) {
  const result = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
  let payload = {};
  try { payload = await result.json(); } catch {}
  if (!result.ok) {
    const error = new Error("Google token request failed");
    error.status = result.status;
    throw error;
  }
  return payload;
}

export async function sealSession(value, secret) {
  const key = await aesKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: SESSION_AAD },
    key,
    textBytes(JSON.stringify(value)),
  ));
  return `${SESSION_VERSION}.${base64url(concat(iv, encrypted))}`;
}

export async function openSession(token, secret) {
  if (typeof token !== "string" || token.length > 8_192 || !token.startsWith(`${SESSION_VERSION}.`)) {
    throw new Error("Invalid session");
  }
  const bytes = fromBase64url(token.slice(SESSION_VERSION.length + 1));
  if (bytes.length < 29) throw new Error("Invalid session");
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: SESSION_AAD },
    await aesKey(secret),
    bytes.slice(12),
  );
  const value = JSON.parse(new TextDecoder().decode(decrypted));
  if (!value || typeof value.refreshToken !== "string" || !value.refreshToken) throw new Error("Invalid session");
  return value;
}

export async function signState(value, secret) {
  const payload = base64url(textBytes(JSON.stringify(value)));
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), textBytes(payload)));
  return `${payload}.${base64url(signature)}`;
}

export async function verifyState(token, secret, now = Date.now()) {
  if (typeof token !== "string" || token.length > 8_192) throw new Error("Invalid state");
  const [payload, encodedSignature, extra] = token.split(".");
  if (!payload || !encodedSignature || extra !== undefined) throw new Error("Invalid state");
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    fromBase64url(encodedSignature),
    textBytes(payload),
  );
  if (!valid) throw new Error("Invalid state");
  const value = JSON.parse(new TextDecoder().decode(fromBase64url(payload)));
  if (!value || typeof value.returnTo !== "string" || !Number.isFinite(value.expiresAt) || value.expiresAt < now) {
    throw new Error("Expired state");
  }
  return value;
}

function authRedirect(returnTo, session, error) {
  const url = new URL(returnTo);
  const fragment = new URLSearchParams();
  if (session) fragment.set("scattered-drive-session", session);
  if (error) fragment.set("scattered-drive-error", error);
  url.hash = fragment.toString();
  return redirect(url.toString());
}

function callbackUrl(request, env) {
  return env.OAUTH_REDIRECT_URL || `${new URL(request.url).origin}/oauth/callback`;
}

function allowedReturnUrl(candidate, env) {
  try {
    const value = new URL(candidate);
    value.hash = "";
    value.search = "";
    const normalized = value.toString();
    return configuredAppUrls(env).includes(normalized) ? normalized : null;
  } catch {
    return null;
  }
}

function allowedOrigin(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return null;
  return configuredAppUrls(env).some((value) => new URL(value).origin === origin) ? origin : null;
}

function configuredAppUrls(env) {
  return String(env.APP_URLS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .flatMap((value) => {
      try {
        const url = new URL(value);
        url.hash = "";
        url.search = "";
        return [url.toString()];
      } catch {
        return [];
      }
    });
}

function bearerToken(request) {
  const authorization = request.headers.get("Authorization") || "";
  if (!authorization.startsWith("Bearer ")) throw new Error("Missing authorization");
  return authorization.slice(7);
}

function corsResponse(request, env, body, status) {
  const origin = allowedOrigin(request, env);
  if (!origin) return response("Forbidden", 403);
  return new Response(body, {
    status,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
      "Cache-Control": "no-store",
    },
  });
}

function corsJson(origin, value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": origin,
      Vary: "Origin",
      "Cache-Control": "no-store",
    },
  });
}

function redirect(location) {
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function response(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function requireConfig(env) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.SESSION_SECRET || !configuredAppUrls(env).length) {
    throw new Error("Drive sync is not configured");
  }
}

async function aesKey(secret) {
  return crypto.subtle.importKey("raw", await deriveKey(secret, "session"), "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", await deriveKey(secret, "state"), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function deriveKey(secret, purpose) {
  if (typeof secret !== "string" || secret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
  return crypto.subtle.digest("SHA-256", textBytes(`scattered:${purpose}:v1:${secret}`));
}

function textBytes(value) {
  return new TextEncoder().encode(value);
}

function concat(...groups) {
  const result = new Uint8Array(groups.reduce((total, item) => total + item.length, 0));
  let offset = 0;
  groups.forEach((item) => {
    result.set(item, offset);
    offset += item.length;
  });
  return result;
}

function base64url(bytes) {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64url(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid encoding");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
