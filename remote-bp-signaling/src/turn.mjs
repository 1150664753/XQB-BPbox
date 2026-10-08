// WTN signing stays server-side. Never log provider responses, JWTs or ICE credentials.
const encoder = new TextEncoder();
export const AUTH_SECONDS = 7 * 24 * 60 * 60;
export const turnErrors = {
  TURN_AUTH_NOT_CONFIGURED: "TURN未授权；若无法连接请联系QQ 2727755165",
  TURN_PASSWORD_INVALID: "授权密码错误",
  TURN_TOKEN_INVALID: "房主授权令牌无效或已撤销，请重新授权",
  TURN_AUTH_EXPIRED: "房主授权已过期，请重新输入密码",
  TURN_NOT_AUTHORIZED: "此房间未获 TURN 授权；仍可使用 P2P",
  TURN_NOT_CONFIGURED: "WTN AppKey 未配置；仍可使用 P2P",
  TURN_PROVIDER_DENIED: "WTN 拒绝请求：请检查 AppID、AppKey、鉴权及 TURN 服务是否已开通",
  TURN_PROVIDER_HTTP: "WTN HTTP 请求失败；仍在尝试 P2P",
  TURN_PROVIDER_CODE: "WTN 返回业务错误；请检查 TURN 服务开通状态",
  TURN_PROVIDER_INVALID: "WTN 返回的 TTL 或 ICE 数据无效",
  TURN_UNAVAILABLE: "TURN 网络请求失败或超时；仍在尝试 P2P",
  TURN_RATE_LIMITED: "TURN 请求过于频繁，请稍后重试",
  TURN_ROOM_LIMIT: "该授权绑定的房间过多，请关闭旧房间或重新授权",
};
const base64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const encoded = value => base64url(encoder.encode(JSON.stringify(value)));
export const digest = async value => base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
const keyFor = (secret, usages) => crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usages);
export async function signToken(secret, claims) {
  const input = `${encoded({ alg: "HS256", typ: "JWT" })}.${encoded(claims)}`;
  const signature = await crypto.subtle.sign("HMAC", await keyFor(secret, ["sign"]), encoder.encode(input));
  return `${input}.${base64url(new Uint8Array(signature))}`;
}
function authConfigured(env) {
  if (!env.TURN_ACCESS_PASSWORD || !env.TURN_AUTH_SIGNING_KEY || env.TURN_AUTH_SIGNING_KEY.length < 32)
    throw new Error("TURN_AUTH_NOT_CONFIGURED");
}
export async function checkPassword(env, password) {
  authConfigured(env);
  if (typeof password !== "string" || password.length > 256) throw new Error("TURN_PASSWORD_INVALID");
  const a = await digest(env.TURN_ACCESS_PASSWORD), b = await digest(password);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  if (diff) throw new Error("TURN_PASSWORD_INVALID");
}
export async function verifyToken(env, token, allowExpired = false) {
  authConfigured(env);
  try {
    if (typeof token !== "string" || token.length > 2048) throw new Error();
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) throw new Error();
    const decode = p => Uint8Array.from(atob(p.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
    const header = JSON.parse(new TextDecoder().decode(decode(parts[0])));
    if (header.alg !== "HS256" || header.typ !== "JWT") throw new Error();
    if (!await crypto.subtle.verify("HMAC", await keyFor(env.TURN_AUTH_SIGNING_KEY, ["verify"]), decode(parts[2]), encoder.encode(`${parts[0]}.${parts[1]}`))) throw new Error();
    const claims = JSON.parse(new TextDecoder().decode(decode(parts[1])));
    if (claims.aud !== "xqb-bp-turn-host" || typeof claims.sub !== "string" || !/^[0-9a-f-]{36}$/.test(claims.sub) ||
      typeof claims.jti !== "string" || !/^[0-9a-f-]{36}$/.test(claims.jti) || !Number.isSafeInteger(claims.exp) ||
      !Number.isSafeInteger(claims.iat) || claims.exp - claims.iat !== AUTH_SECONDS || claims.iat > Date.now() / 1000 + 30) throw new Error();
    if (!allowExpired && claims.exp * 1000 <= Date.now()) throw new Error("TURN_AUTH_EXPIRED");
    return claims;
  } catch (error) {
    throw new Error(error.message === "TURN_AUTH_EXPIRED" ? error.message : "TURN_TOKEN_INVALID");
  }
}
// Legacy local-server password entry is disabled; the production authority is a Durable Object.
export async function authorizeTurn(_env, accessCode) {
  if (!accessCode) return null;
  throw new Error("TURN_NOT_AUTHORIZED");
}
export async function turnPermission(env, grant) {
  try {
    return Boolean(grant?.sub && grant?.jti && grant.expiresAt > Date.now() && env.TURN_AUTH &&
      await env.TURN_AUTH.get(env.TURN_AUTH.idFromName(grant.sub)).valid(grant));
  } catch { return false; } // Fail closed for TURN while allowing ordinary JOIN/RESUME.
}
export async function issueTurnCredentials(env, grant, peerKey, fetcher = (url, init) => fetch(url, init)) {
  if (!await turnPermission(env, grant)) throw new Error("TURN_NOT_AUTHORIZED");
  if (!env.WTN_APP_KEY || !env.WTN_APP_ID) throw new Error("TURN_NOT_CONFIGURED");
  const now = Date.now();
  const cached = grant.cache[peerKey];
  if (cached && cached.expiresAt - now > 90_000) return cached;
  if (!await env.TURN_AUTH.get(env.TURN_AUTH.idFromName(`rate:provider:${grant.sub}`)).rate(20, 60_000)) throw new Error("TURN_RATE_LIMITED");
  grant.requestTimes = (grant.requestTimes ?? []).filter(t => now - t < 60_000);
  if (grant.requestTimes.length >= 4) throw new Error("TURN_RATE_LIMITED");
  grant.requestTimes.push(now);
  const requestedTtl = Number(env.WTN_TURN_TTL_SECONDS ?? 3600);
  if (!Number.isInteger(requestedTtl) || requestedTtl < 60 || requestedTtl > 86400) throw new Error("TURN_PROVIDER_INVALID");
  const ttl = Math.min(requestedTtl, Math.floor((grant.expiresAt - now) / 1000));
  if (ttl < 60) throw new Error("TURN_AUTH_EXPIRED");
  const domain = env.WTN_API_DOMAIN ?? "wtn.volcvideo.com";
  if (!["wtn.volcvideo.com", "wtn-lf.volcvideo.com", "wtn-va.volcvideos.com", "wtn-fr.volcvideos.com", "wtn-sg.volcvideos.com"].includes(domain)) throw new Error("TURN_PROVIDER_INVALID");
  const token = await signToken(env.WTN_APP_KEY, { version: "1.0", appID: env.WTN_APP_ID, exp: Math.floor(now / 1000) + 300 });
  const url = new URL(`https://${domain}/turn/${encodeURIComponent(env.WTN_APP_ID)}`);
  url.searchParams.set("TTL", String(ttl));
  url.searchParams.set("SessionID", peerKey);
  let response;
  try {
    // Workers supports manual/follow; manual ensures a redirect never leaks Authorization.
    response = await fetcher(url, { method: "GET", headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(6_000), redirect: "manual" });
  } catch { throw new Error("TURN_UNAVAILABLE"); }
  if (!response.ok) throw new Error([401, 403, 404].includes(response.status) ? "TURN_PROVIDER_DENIED" : "TURN_PROVIDER_HTTP");
  let data;
  try {
    const text = await response.text();
    if (text.length > 64 * 1024) throw new Error();
    data = JSON.parse(text);
  } catch { throw new Error("TURN_PROVIDER_INVALID"); }
  if (data?.code !== 200) throw new Error("TURN_PROVIDER_CODE");
  if (!Number.isInteger(data.ttl) || data.ttl < 60 || data.ttl > ttl || !Array.isArray(data.ice_servers) || data.ice_servers.length > 8)
    throw new Error("TURN_PROVIDER_INVALID");
  const iceServers = [];
  for (const item of data.ice_servers) {
    if (!item || typeof item.username !== "string" || typeof item.credential !== "string" ||
      !item.username || !item.credential || item.username.length > 2048 || item.credential.length > 2048) continue;
    const urls = (Array.isArray(item.urls) ? item.urls : [item.urls]).filter(url => typeof url === "string" && /^turns?:[^\s@/#?]+(?:\?transport=(?:udp|tcp))?$/i.test(url) && url.length < 2048);
    if (urls.length && urls.length <= 8) iceServers.push({ urls, username: item.username, credential: item.credential });
  }
  if (!iceServers.length) throw new Error("TURN_PROVIDER_INVALID");
  if (!await turnPermission(env, grant)) throw new Error("TURN_NOT_AUTHORIZED");
  const result = { iceServers, expiresAt: now + data.ttl * 1000 };
  for (const [id, value] of Object.entries(grant.cache)) if (value.expiresAt <= now) delete grant.cache[id];
  while (Object.keys(grant.cache).length >= 2) delete grant.cache[Object.keys(grant.cache)[0]];
  grant.cache[peerKey] = result;
  return result;
}
