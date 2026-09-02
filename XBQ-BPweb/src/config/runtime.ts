export type RemoteBpTransportMode = "mock" | "webrtc";

const DEFAULT_SIGNALING_URL = import.meta.env.DEV
  ? "ws://localhost:8787"
  : "wss://signal.xqbbp.dpdns.org";
const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302"] },
];

function parseIceServers(raw: string | undefined): RTCIceServer[] {
  if (!raw) return DEFAULT_ICE_SERVERS;
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || value.length > 8) return DEFAULT_ICE_SERVERS;
    const parsed = value.filter((entry): entry is RTCIceServer => {
      if (typeof entry !== "object" || entry === null) return false;
      const urls = Reflect.get(entry, "urls");
      const urlList = typeof urls === "string" ? [urls] : urls;
      return (
        Array.isArray(urlList) &&
        urlList.length > 0 &&
        urlList.length <= 8 &&
        urlList.every(
          (url) => typeof url === "string" && /^stuns?:|^turns?:/.test(url),
        )
      );
    });
    return parsed.length > 0 ? parsed : DEFAULT_ICE_SERVERS;
  } catch {
    return DEFAULT_ICE_SERVERS;
  }
}

export const runtimeConfig = {
  transport: (import.meta.env.VITE_REMOTE_BP_TRANSPORT ??
    "webrtc") as RemoteBpTransportMode,
  signalingUrl:
    import.meta.env.VITE_REMOTE_BP_SIGNALING_URL ?? DEFAULT_SIGNALING_URL,
  iceServers: parseIceServers(import.meta.env.VITE_REMOTE_BP_ICE_SERVERS),
} as const;
