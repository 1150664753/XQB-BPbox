// WTN signing stays server-side. Never log provider responses, JWTs or ICE credentials.
const encoder = new TextEncoder();
export const AUTH_SECONDS = 7 * 24 * 60 * 60;
// These are separate lifetimes: host authorization, API JWT, and relay access.
export const TURN_ACCESS_SECONDS = 14400;
const WTN_API_TOKEN_SECONDS = 300;
const API_DOMAINS = ["wtn.volcvideo.com", "wtn-lf.volcvideo.com", "wtn-va.volcvideos.com", "wtn-fr.volcvideos.com", "wtn-sg.volcvideos.com"];
// Explicit allowlist: never attach provider bodies, JWTs or credentials to errors/logs.
export function turnDiagnostic(env, error) {
  const d = error?.turnDiagnostic ?? {};
  return {
    appId: typeof env.WTN_APP_ID === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(env.WTN_APP_ID) ? env.WTN_APP_ID : null,
    appIdSource: 'env.WTN_APP_ID',
    apiDomain: API_DOMAINS.includes(env.WTN_API_DOMAIN ?? 'wtn.volcvideo.com') ? (env.WTN_API_DOMAIN ?? 'wtn.volcvideo.com') : null,
    httpStatus: Number.isInteger(d.httpStatus) ? d.httpStatus : null,
    providerCode: Number.isSafeInteger(d.providerCode) ? d.providerCode : null,
    ttl: Number.isSafeInteger(d.ttl) ? d.ttl : null,
    source: d.source === 'cache' ? 'cache' : d.source === 'provider' ? 'provider' : 'none',
  };
}
export const turnErrors = {
  TURN_AUTH_NOT_CONFIGURED: "TURN未授权；若无法连接请联系QQ 2727755165",
  TURN_PASSWORD_INVALID: "授权密码错误",
  TURN_TOKEN_INVALID: "房主授权令牌无效或已撤销，请重新授权",
  TURN_AUTH_EXPIRED: "房主授权已过期，请重新输入密码",
  TURN_NOT_AUTHORIZED: "此房间未获 TURN 授权",
  TURN_NOT_CONFIGURED: "WTN AppID 或 AppKey 未配置",
  TURN_PROVIDER_DENIED: "WTN 拒绝请求：请检查 AppID、AppKey、鉴权及 TURN 服务是否已开通",
  TURN_PROVIDER_HTTP: "WTN HTTP 请求失败",
  TURN_PROVIDER_CODE: "WTN 返回业务错误；请检查 TURN 服务开通状态",
  TURN_PROVIDER_INVALID: "WTN 返回的 TTL 或 ICE 数据无效",
  TURN_UNAVAILABLE: "TURN 网络请求失败或超时",
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
  const started = Date.now();
  try {
    const result = await fetchTurnCredentials(env, grant, peerKey, fetcher);
    console.info('[WTN TURN]', { result: 'ok', ...result.turnDiagnostic,
      elapsedMs: Date.now() - started, expiresAt: result.expiresAt,
      requestedTtl: result.requestedTtl, actualTtl: result.ttl, ttlReason: result.ttlReason,
      apiDomain: result.apiDomain, servers: result.iceServers.flatMap(server => server.urls),
      protocols: [...new Set(result.iceServers.flatMap(server => server.urls.map(url => /^turns:/i.test(url) ? 'tls' : /transport=tcp/i.test(url) ? 'tcp' : 'udp')))] });
    return result;
  } catch (error) {
    const code = Object.hasOwn(turnErrors, error?.message) ? error.message : 'TURN_UNAVAILABLE';
    error.turnDiagnostic = turnDiagnostic(env, error);
    console.warn('[WTN TURN]', { result: 'error', code, ...error.turnDiagnostic, elapsedMs: Date.now() - started });
    throw error;
  }
}
async function fetchTurnCredentials(env, grant, peerKey, fetcher) {
  if (!await turnPermission(env, grant)) throw new Error("TURN_NOT_AUTHORIZED");
  if (!env.WTN_APP_KEY || !env.WTN_APP_ID) throw new Error("TURN_NOT_CONFIGURED");
  const now = Date.now();
  const cached = grant.cache[peerKey];
  // Durable Object caches survive deploys. Bind them to the full effective provider configuration.
  const configDigest = await digest(JSON.stringify([env.WTN_APP_ID, env.WTN_APP_KEY,
    env.WTN_API_DOMAIN ?? 'wtn.volcvideo.com', env.WTN_TURN_TTL_SECONDS ?? TURN_ACCESS_SECONDS]));
  if (cached && cached.configDigest === configDigest && cached.expiresAt - now > 90_000) {
    const { configDigest: _, ...credentials } = cached;
    return { ...credentials, turnDiagnostic: { ...cached.turnDiagnostic, source: 'cache' } };
  }
  if (!await env.TURN_AUTH.get(env.TURN_AUTH.idFromName(`rate:provider:${grant.sub}`)).rate(20, 60_000)) throw new Error("TURN_RATE_LIMITED");
  grant.requestTimes = (grant.requestTimes ?? []).filter(t => now - t < 60_000);
  if (grant.requestTimes.length >= 4) throw new Error("TURN_RATE_LIMITED");
  grant.requestTimes.push(now);
  const requestedTtl = Number(env.WTN_TURN_TTL_SECONDS ?? TURN_ACCESS_SECONDS);
  if (!Number.isInteger(requestedTtl) || requestedTtl < 60 || requestedTtl > 86400) throw new Error("TURN_PROVIDER_INVALID");
  const ttl = Math.min(requestedTtl, Math.floor((grant.expiresAt - now) / 1000));
  if (ttl < 60) throw new Error("TURN_AUTH_EXPIRED");
  const domain = env.WTN_API_DOMAIN ?? "wtn.volcvideo.com";
  if (!API_DOMAINS.includes(domain) || !turnDiagnostic(env).appId) throw new Error("TURN_PROVIDER_INVALID");
  const token = await signToken(env.WTN_APP_KEY, { version: "1.0", appID: env.WTN_APP_ID, exp: Math.floor(now / 1000) + WTN_API_TOKEN_SECONDS });
  const url = new URL(`https://${domain}/turn/${encodeURIComponent(env.WTN_APP_ID)}`);
  url.searchParams.set("TTL", String(ttl));
  url.searchParams.set("SessionID", peerKey);
  const diagnostic = { ...turnDiagnostic(env), source: 'provider' };
  const invalid = code => Object.assign(new Error(code), { turnDiagnostic: diagnostic });
  let response;
  try {
    // Workers supports manual/follow; manual ensures a redirect never leaks Authorization.
    response = await fetcher(url, { method: "GET", headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(6_000), redirect: "manual" });
  } catch { throw invalid("TURN_UNAVAILABLE"); }
  diagnostic.httpStatus = response.status;
  let data;
  try {
    const text = await response.text();
    if (text.length > 64 * 1024) throw new Error();
    data = JSON.parse(text);
  } catch {
    if (response.ok) throw invalid("TURN_PROVIDER_INVALID");
  }
  diagnostic.providerCode = Number.isSafeInteger(data?.code) ? data.code : null;
  diagnostic.ttl = Number.isSafeInteger(data?.ttl) ? data.ttl : null;
  if (!response.ok) throw invalid([401, 403, 404].includes(response.status) ? "TURN_PROVIDER_DENIED" : "TURN_PROVIDER_HTTP");
  if (data?.code !== 200) {
    console.warn('[WTN TURN]', { result: 'provider-error', code: Number.isSafeInteger(data?.code) ? data.code : null });
    throw invalid("TURN_PROVIDER_CODE");
  }
  // The provider may clamp or ignore TTL. Retain its actual lifetime, never invent 4h.
  if (!Number.isInteger(data.ttl) || data.ttl < 60 || data.ttl > 86400) {
    console.warn('[WTN TURN]', { result: 'invalid-ttl', requestedTtl: ttl,
      actualTtl: Number.isSafeInteger(data.ttl) ? data.ttl : null, reason: 'TTL_OUT_OF_RANGE' });
    throw invalid("TURN_PROVIDER_INVALID");
  }
  if (!Array.isArray(data.ice_servers) || data.ice_servers.length > 8)
    throw invalid("TURN_PROVIDER_INVALID");
  const iceServers = [];
  for (const item of data.ice_servers) {
    if (!item) throw invalid("TURN_PROVIDER_INVALID");
    const entries = Array.isArray(item.urls) ? item.urls : [item.urls];
    // The provider also returns STUN. Ignore only STUN, never silently drop a malformed TURN entry.
    const urls = entries.filter(url => typeof url !== 'string' || !/^stuns?:/i.test(url));
    if (!urls.length) continue;
    if (urls.length > 8 || urls.some(url => typeof url !== 'string' ||
      !/^turns?:[a-z0-9.\-\[\]:]+(?:\?transport=(?:udp|tcp))?$/i.test(url) || url.length > 512) ||
      typeof item.username !== "string" || typeof item.credential !== "string" ||
      !item.username || !item.credential || item.username.length > 2048 || item.credential.length > 2048)
      throw invalid("TURN_PROVIDER_INVALID");
    iceServers.push({ urls, username: item.username, credential: item.credential });
  }
  if (!iceServers.length) throw invalid("TURN_PROVIDER_INVALID");
  if (!await turnPermission(env, grant)) throw invalid("TURN_NOT_AUTHORIZED");
  const ttlReason = data.ttl !== ttl ? 'PROVIDER_TTL_MISMATCH_REASON_NOT_SUPPLIED' :
    ttl !== requestedTtl ? 'HOST_AUTH_EXPIRING' : requestedTtl !== TURN_ACCESS_SECONDS ? 'CONFIG_OVERRIDE' : null;
  const result = { iceServers, expiresAt: now + data.ttl * 1000, requestedTtl: ttl,
    configuredTtl: requestedTtl, ttl: data.ttl, ttlReason, apiDomain: domain, turnDiagnostic: diagnostic };
  if (ttlReason) console.warn('[WTN TURN]', { result: 'ttl-adjusted', requestedTtl: ttl,
    configuredTtl: requestedTtl, actualTtl: data.ttl, reason: ttlReason });
  for (const [id, value] of Object.entries(grant.cache)) if (value.expiresAt <= now) delete grant.cache[id];
  while (Object.keys(grant.cache).length >= 2) delete grant.cache[Object.keys(grant.cache)[0]];
  grant.cache[peerKey] = { ...result, configDigest };
  return result;
}
