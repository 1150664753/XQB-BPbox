# Remote BP Host

XQB-BPbox 的远程 BP 已接入真实信令与 WebRTC DataChannel，同时保留 Mock Transport 供自检和离线开发。

## 权威边界

本地操作与远程操作继续共用 `BpActionDispatcher`。网页只发送带 `actionId` 和 `expectedRevision` 的 Action；BPbox 校验身份、轮次、步骤、目标、revision 与重复请求，再调用现有 BP Core 兼容执行器。网页收到的 `RemoteBpState` 是 BPbox 内部状态的精简投影，不是第二份权威状态。

远程业务身份统一为：

- `first` / `FIRST`：先手。
- `second` / `SECOND`：后手。
- `HOST`：BPbox 房主，只存在于信令层。

桌面内部既有 `star / rail` 继续保留，且只通过 `src/shared/remoteBp/sideMapper.ts` 与 `first / second` 映射。默认 `first -> star`、`second -> rail`，开房前可以交换。

## 结构

- `src/shared/remoteBp/dispatcher.ts`：统一动作校验与 revision/actionId。
- `src/shared/remoteBp/serializer.ts`：生成精简、可传输的 `RemoteBpState`。
- `src/shared/remoteBp/host.ts`：房间生命周期、Peer 状态和权威状态广播。
- `src/shared/remoteBp/transport.ts`：Mock/WebRTC 共用的 Host Transport 接口。
- `src/shared/remoteBp/validation.ts`：DataChannel 入站 Action、状态请求、资源请求与 Ping 的运行时校验。
- `src/renderer/src/services/remoteBp/WebRtcRemoteHostTransport.ts`：BPbox 信令客户端、每名选手独立的 `RTCPeerConnection` 与 DataChannel。
- `src/main/remoteBp/RemoteAssetProvider.ts`：角色头像小图/全身立绘及光锥小图的 Manifest、增量 SHA-256 缓存与 assetId 白名单；Host 按 128 KiB 分片经 DataChannel 发送并执行背压控制。

当前远程协议版本为 `1.2.1`。网页的预选只更新 BPbox 高亮和直播待选位灰化预览，只有 `CONFIRM` 才形成正式操作；保护/租借在双方分别确认后才推进。网页提交的队伍或选手名称仅用于界面展示，不改变先手/后手权限映射。

远程房间不再因空闲 TTL 销毁。DataChannel 与信令 WebSocket 分别使用独立轻量心跳，心跳不经过 Dispatcher，不改变 revision。信令短断时 Host 使用房间恢复凭证指数退避重连；如果原 DataChannel 仍健康则直接复用。房主可分别踢出先手/后手；踢出和房间关闭都会发布明确终止原因，Web 不会自动重连。直播延迟正在等待 BPbox 额外点击时，权威状态显式发布 `WAIT`。

信令服务器和网页端说明见 [本阶段开发记录](../docs/REMOTE_BP_WEBRTC_STAGE.md)。

## 配置

复制 `.env.example` 后可配置：

```text
VITE_REMOTE_BP_HOST_TRANSPORT=webrtc
VITE_REMOTE_BP_SIGNALING_URL=wss://signal.xqbbp.dpdns.org
VITE_REMOTE_BP_ICE_SERVERS=[{"urls":["stun:stun.l.google.com:19302"]}]
```

BPbox 的开发与生产构建默认都连接公网 WSS，避免本地房间码与公网网页不属于同一信令服务。本地信令联调时，可在 `.env.local` 中显式设置 `VITE_REMOTE_BP_SIGNALING_URL=ws://localhost:8787`。把 Transport 改为 `mock` 可继续运行原有自检通道。TURN 服务器可以按标准 `RTCIceServer` 结构加入同一个 JSON 数组，不需要修改业务代码。

## 检查

```bash
npm run typecheck
npm run test:remote-bp
```

自检覆盖 Dispatcher、Serializer、网络消息运行时校验、Asset Provider 与 Mock Host 端到端链路。
