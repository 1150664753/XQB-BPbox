import type { ConnectionSnapshot } from "../types/connection";

const stateLabels: Record<ConnectionSnapshot["state"], string> = {
  idle: "未连接",
  connecting: "连接中",
  connected: "已连接",
  reconnecting: "重连中",
  disconnected: "已断开",
  failed: "连接失败",
  kicked: "被踢出",
  "room-closed": "房间已关闭",
};

export function ConnectionBadge({
  connection,
}: {
  connection: ConnectionSnapshot;
}) {
  return (
    <span className={`connection-badge connection-badge--${connection.state}`}>
      <span className="connection-badge__dot" aria-hidden="true" />
      {stateLabels[connection.state]}
      {connection.state === "connected"
        ? " · " +
          {
            mock: "演示",
            p2p: "P2P",
            "turn-udp": "TURN UDP",
            "turn-tcp": "TURN TCP",
            "turn-relay": "TURN（协议未知）",
            unknown: "路径确认中",
          }[connection.transport]
        : ""}
    </span>
  );
}
