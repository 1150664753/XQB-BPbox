import { DurableObject } from "cloudflare:workers";
import { AUTH_SECONDS, checkPassword, digest, signToken, verifyToken, turnErrors, type TurnClaims, type TurnEnvironment } from "./turn.mjs";
import type { BpRoom } from "./index";

export interface AuthorityEnvironment extends TurnEnvironment {
  TURN_AUTH: DurableObjectNamespace<TurnAuthority>;
  BP_ROOMS: DurableObjectNamespace<BpRoom>;
}
interface SavedAuthorization { claims: TurnClaims; keyHash: string; rooms: string[]; revoked?: boolean }
const response = (body: object, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

// RPC methods are only available through the Worker binding, never a public HTTP route.
export class TurnAuthority extends DurableObject<AuthorityEnvironment> {
  async rate(limit: number, windowMs: number): Promise<boolean> {
    return this.ctx.storage.transaction(async storage => {
      const now = Date.now();
      const times = (await storage.get<number[]>("requests") ?? []).filter(t => now - t < windowMs);
      if (times.length >= limit) return false;
      times.push(now);
      await storage.put("requests", times);
      await storage.put("requestsExpireAt", now + windowMs);
      await storage.setAlarm(now + windowMs);
      return true;
    });
  }
  async issue(password: unknown, hostId: string): Promise<{ token: string; expiresAt: number }> {
    await checkPassword(this.env, password);
    const iat = Math.floor(Date.now() / 1000);
    const claims: TurnClaims = { sub: hostId, jti: crypto.randomUUID(), iat, exp: iat + AUTH_SECONDS, aud: "xqb-bp-turn-host" };
    const token = await signToken(this.env.TURN_AUTH_SIGNING_KEY!, claims);
    // A reauthorization replaces the previous token; its old rooms stop receiving credentials.
    await this.ctx.storage.put<SavedAuthorization>("authorization", { claims, keyHash: await digest(this.env.TURN_AUTH_SIGNING_KEY!), rooms: [] });
    await this.ctx.storage.setAlarm(claims.exp * 1000);
    return { token, expiresAt: claims.exp * 1000 };
  }
  async valid(claims: TurnClaims): Promise<boolean> {
    const record = await this.ctx.storage.get<SavedAuthorization>("authorization");
    return Boolean(record && !record.revoked && this.env.TURN_AUTH_SIGNING_KEY &&
      record.claims.sub === claims.sub && record.claims.jti === claims.jti && record.claims.exp === claims.exp &&
      claims.exp * 1000 > Date.now() && record.keyHash === await digest(this.env.TURN_AUTH_SIGNING_KEY));
  }
  async bind(claims: TurnClaims, roomCode: string): Promise<boolean> {
    if (!await this.valid(claims)) return false;
    return this.ctx.storage.transaction(async storage => {
      const record = await storage.get<SavedAuthorization>("authorization");
      if (!record || record.revoked || record.claims.jti !== claims.jti || record.claims.exp * 1000 <= Date.now()) return false;
      if (!record.rooms.includes(roomCode)) {
        if (record.rooms.length >= 64) throw new Error("TURN_ROOM_LIMIT");
        record.rooms.push(roomCode);
        await storage.put("authorization", record);
      }
      return true;
    });
  }
  async unbind(jti: string, roomCode: string): Promise<void> {
    await this.ctx.storage.transaction(async storage => {
      const record = await storage.get<SavedAuthorization>("authorization");
      if (!record || record.claims.jti !== jti) return;
      record.rooms = record.rooms.filter(room => room !== roomCode);
      await storage.put("authorization", record);
    });
  }
  async revoke(claims: TurnClaims): Promise<void> {
    const record = await this.ctx.storage.transaction(async storage => {
      const value = await storage.get<SavedAuthorization>("authorization");
      if (!value || value.claims.jti !== claims.jti) return null;
      value.revoked = true;
      await storage.put("authorization", value);
      return value;
    });
    if (!record) return;
    // Durable revocation is effective before notification; every credential request rechecks it.
    await Promise.allSettled(record.rooms.map(room => this.env.BP_ROOMS.get(this.env.BP_ROOMS.idFromName(room)).revokeTurn(claims.jti)));
  }
  async alarm(): Promise<void> {
    const record = await this.ctx.storage.get<SavedAuthorization>("authorization");
    if (record && record.claims.exp * 1000 <= Date.now()) await this.revoke(record.claims);
    await this.ctx.storage.transaction(async storage => {
      const current = await storage.get<SavedAuthorization>("authorization");
      // An issue/rate RPC may have run while revocation notifications were awaited.
      if (current && current.claims.exp * 1000 <= Date.now()) await storage.delete("authorization");
      if ((await storage.get<number>("requestsExpireAt") ?? Infinity) <= Date.now()) {
        await storage.delete(["requests", "requestsExpireAt"]);
      }
    });
  }
}

export async function handleTurnHttp(request: Request, env: AuthorityEnvironment): Promise<Response> {
  const url = new URL(request.url);
  if (!["/turn/authorize", "/turn/status", "/turn/revoke"].includes(url.pathname)) return response({ error: "NOT_FOUND" }, 404);
  if (request.method !== "POST") return response({ error: "METHOD_NOT_ALLOWED" }, 405);
  if (url.protocol !== "https:" && !["127.0.0.1", "localhost"].includes(url.hostname)) return response({ error: "HTTPS_REQUIRED" }, 400);
  try {
    // Cloudflare supplies CF-Connecting-IP. Never accept a client-provided host/role as identity.
    const ip = request.headers.get("CF-Connecting-IP") ?? "local";
    const rateId = await digest(`${url.pathname}:${ip}`);
    const limiter = env.TURN_AUTH.get(env.TURN_AUTH.idFromName(`rate:${rateId}`));
    if (!await limiter.rate(url.pathname === "/turn/authorize" ? 5 : 60, 60_000)) throw new Error("TURN_RATE_LIMITED");
    if (url.pathname === "/turn/authorize") {
      // Global budget also bounds attacks spread across many IP addresses.
      if (!await env.TURN_AUTH.get(env.TURN_AUTH.idFromName("rate:password-global")).rate(100, 60_000)) throw new Error("TURN_RATE_LIMITED");
      if (Number(request.headers.get("content-length")) > 4096) return response({ error: "BODY_TOO_LARGE" }, 413);
      const raw = await request.text();
      if (raw.length > 4096) return response({ error: "BODY_TOO_LARGE" }, 413);
      const body = JSON.parse(raw) as Record<string, unknown>;
      if (typeof body.hostId !== "string" || !/^[0-9a-f-]{36}$/.test(body.hostId)) return response({ error: "INVALID_HOST_ID" }, 400);
      const authority = env.TURN_AUTH.get(env.TURN_AUTH.idFromName(body.hostId));
      return response(await authority.issue(body.password, body.hostId));
    }
    const token = request.headers.get("Authorization")?.replace(/^Bearer /, "");
    const claims = await verifyToken(env, token, url.pathname === "/turn/revoke");
    const authority = env.TURN_AUTH.get(env.TURN_AUTH.idFromName(claims.sub));
    if (url.pathname === "/turn/revoke") {
      await authority.revoke(claims);
      return response({ revoked: true });
    }
    if (!await authority.valid(claims)) throw new Error("TURN_TOKEN_INVALID");
    return response({ authorized: true, expiresAt: claims.exp * 1000, providerConfigured: Boolean(env.WTN_APP_KEY && env.WTN_APP_ID) });
  } catch (error) {
    const rawCode = error instanceof Error ? error.message : "";
    // RPC errors can include a prefix. Only return an allowlisted code, never the thrown text.
    const code = Object.keys(turnErrors).find(key => rawCode === key || rawCode.endsWith(`: ${key}`)) ?? "TURN_UNAVAILABLE";
    return response({ error: code, message: turnErrors[code] }, code === "TURN_RATE_LIMITED" ? 429 : code.includes("CONFIGURED") ? 503 : ["TURN_PASSWORD_INVALID", "TURN_AUTH_EXPIRED", "TURN_TOKEN_INVALID"].includes(code) ? 401 : 503);
  }
}
