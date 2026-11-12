import {
  parseSakuraInvitation,
  type SakuraInvitation,
} from "../../../shared/sakuraBp";

export interface SakuraEntry {
  invitation: SakuraInvitation | null;
  error: string | null;
}
let entry: SakuraEntry | undefined;
export function getSakuraEntry(): SakuraEntry {
  if (entry) return entry;
  entry = { invitation: null, error: null };
  const hash = window.location.hash;
  const room = window.location.pathname
    .match(/^\/room\/([A-Z0-9]{6,12})\/?$/i)?.[1]
    ?.toUpperCase();
  try {
    if (hash.startsWith("#sakura=")) {
      // Remove secrets before React mounts or any join/network request is started.
      window.history.replaceState(null, "", window.location.pathname);
      if (hash.length > 4096) throw new Error("樱花邀请过长");
      entry.invitation = parseSakuraInvitation(
        JSON.parse(decodeURIComponent(hash.slice(8))),
      );
      if (entry.invitation.roomId !== room)
        throw new Error("邀请链接的房间信息不一致");
      try {
        sessionStorage.setItem(
          `xqb:sakura:invite:${room}`,
          JSON.stringify(entry.invitation),
        );
      } catch {
        /* Memory-only fallback. */
      }
    } else if (room) {
      let saved: string | null = null;
      try {
        saved = sessionStorage.getItem(`xqb:sakura:invite:${room}`);
      } catch {
        /* Optional storage. */
      }
      if (saved) entry.invitation = parseSakuraInvitation(JSON.parse(saved));
    }
  } catch {
    entry = {
      invitation: null,
      error: "樱花邀请无效或版本不兼容，请向房主获取新链接",
    };
  }
  return entry;
}
