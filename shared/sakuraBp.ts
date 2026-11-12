/** Sakura transport handshake; BP payloads retain their existing protocol version. */
export const SAKURA_WIRE_VERSION = "sakura-ws/1";
export const SAKURA_DEFAULT_PORT = 18787;
export const SAKURA_PLAYER_URL = "https://bp.xqbbp.dpdns.org/room";
export const SAKURA_HEARTBEAT_MS = 15_000;
export const SAKURA_TIMEOUT_MS = 45_000;

export interface SakuraInvitation {
  version: typeof SAKURA_WIRE_VERSION;
  endpoint: string;
  roomId: string;
  credential: string;
}

export function normalizeSakuraEndpoint(input: string): string {
  const text = input.trim();
  const url = new URL(text.includes("://") ? text : `wss://${text}`);
  if (url.protocol === "https:") url.protocol = "wss:";
  if (
    url.protocol !== "wss:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "公网地址必须是有效的 HTTPS/WSS 地址，不能包含凭证或查询参数",
    );
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.includes(":") ||
    /^\d+(\.\d+){3}$/.test(host) ||
    !host.includes(".")
  )
    throw new Error("请使用带有效证书的公网域名");
  if (url.pathname !== "/" && url.pathname !== "/bp")
    throw new Error("公网地址路径只能为空或 /bp");
  url.pathname = "/bp";
  return url.toString();
}

export function parseSakuraInvitation(value: unknown): SakuraInvitation {
  if (!value || typeof value !== "object") throw new Error("樱花邀请无效");
  const v = value as Record<string, unknown>;
  if (v.version !== SAKURA_WIRE_VERSION)
    throw new Error("樱花邀请版本不兼容，请更新客户端");
  if (
    typeof v.endpoint !== "string" ||
    v.endpoint.length > 512 ||
    typeof v.roomId !== "string" ||
    !/^[A-Z0-9]{6,12}$/.test(v.roomId) ||
    typeof v.credential !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(v.credential)
  )
    throw new Error("樱花邀请无效");
  return {
    version: SAKURA_WIRE_VERSION,
    endpoint: normalizeSakuraEndpoint(v.endpoint),
    roomId: v.roomId,
    credential: v.credential,
  };
}

export function createSakuraInvitationLink(
  invitation: SakuraInvitation,
): string {
  const value = parseSakuraInvitation(invitation);
  // Fragments are not sent to the website, its access logs or Referer recipients.
  return `${SAKURA_PLAYER_URL}/${value.roomId}#sakura=${encodeURIComponent(JSON.stringify(value))}`;
}
