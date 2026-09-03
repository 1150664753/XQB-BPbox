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
    </span>
  );
}
