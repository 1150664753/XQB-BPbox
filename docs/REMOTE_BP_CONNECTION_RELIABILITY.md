# Remote BP 连接层修复

本次只调整 WebRTC / WebSocket 信令层。BP Action、先后手权限、状态同步、Manifest、资源分片和背压处理继续使用原有业务实现。

## 修复的问题

- 两端此前并发执行异步信令处理；清空 Candidate 数组后逐个添加时，新 Candidate 可能插队，一个异常还会中断剩余队列。
- PeerConnection 尚未创建时，Candidate 会报错；网页创建 PeerConnection 时还会直接清空已有缓存。
- ICE Restart 期间旧 remoteDescription 仍存在，不能仅靠其非空判断新 Candidate 是否可以添加。
- 房主恢复信令时重复的 PEER_JOINED 会重建尚在协商的连接。旧连接的 ICE / DataChannel 回调和未完成的 SDP 操作也缺少完整隔离。
- 网页在 ICE failed 时直接重连信令并关闭 PeerConnection，房主却同时在原连接上发起 ICE Restart，两个恢复流程互相打断。
- 原网页将整个连接限制在 20 秒内，没有分别判断 ICE、DTLS 和 DataChannel。房主的 Restart 没有次数上限。
- WebSocket 握手 error 监听器在 open 后仍保留，后续 error 可能先清空 socket，导致 close 事件无法安排重连。加入和恢复确认也缺少独立超时。

## 生命周期和信令

`shared/remoteBpRtc.ts` 是从两端传输类抽出的共用连接生命周期。原有传输类仍负责房间、BP 消息编码解析、资源传输和对上层的事件通知。

网页收到 ROOM_JOINED 后创建 PeerConnection、安装监听，再发送 PEER_READY。房主登记 PEER_JOINED，等待 PEER_READY 后才创建并发送 Offer。同一会话、同一 connectionId 的重复通知复用已有连接。

信令新增 PEER_READY 和 ICE_RESTART_REQUEST，并携带 connectionId、negotiationId。服务器根据已验证的 WebSocket 身份填写 fromSessionId / targetSessionId / roomId，禁止客户端伪造来源，并拒绝向已更换选手的旧槽位会话转发消息。Node 与 Cloudflare 实现一致；Cloudflare 的同一 socket 消息按顺序处理。

内部状态统一为 idle / signaling / ice-checking / connecting / connected / reconnecting / failed / closed。上层原有 UI 状态接口继续使用 connecting / reconnecting 等状态，不改变业务接口。

每个连接内部串行执行 Offer、Answer、Candidate 和 Restart。异步操作结束后检查连接是否仍有效，销毁连接后旧事件不能发送信令或操作新连接。

## Candidate 缓存

- 房间或 Peer 未初始化时有短期入站缓存；就绪后交给对应连接。
- 每个连接按 negotiationId 缓存 Candidate。只有该轮 setRemoteDescription 成功后，才逐个 await addIceCandidate。
- 用 Candidate 内容、mid、m-line、ufrag 和轮次去重；单个失败记录诊断并继续添加后续 Candidate。
- 即使 remoteDescription 非空，新一轮 Candidate 也必须等新一轮 SDP。ufrag 不匹配、旧 connectionId、旧轮次和过期消息被丢弃。
- 入站队列最多 256 条，保留 120 秒。每轮出站只保留一个 SDP 和最多 256 个 Candidate，保留 120 秒；换轮次或销毁连接立即清理旧数据。
- 本地 Candidate 即使在 setLocalDescription 完成前产生，也会先排队，确保发送顺序为 SDP → Candidate。
- 信令中断时保留当前协商；PEER_READY / HOST_RECONNECTED 触发当前轮次重发。服务端不保存房间历史 SDP。允许恢复后跳过中间错过的 Offer 轮次。

## 恢复和超时

| 场景 | 策略 |
| --- | --- |
| WebSocket 握手、JOIN / RESUME 确认 | 每次默认 10 秒 |
| 信令心跳 | 每 20 秒发送；超过 60 秒未收到消息，下次心跳检查关闭并重连 |
| ICE / SDP 一轮尚未就绪 | 45 秒后尝试 ICE Restart |
| ICE / PeerConnection disconnected | 保留原连接，给予 15 秒恢复期 |
| ICE / PeerConnection failed | 请求 ICE Restart |
| ICE 已连通，但 DTLS / DataChannel 尚未就绪 | 单独等待 20 秒 |
| 初次建连或一次持续恢复过程 | 120 秒总时限，不因重复消息重置 |
| Restart 次数 | 每个 PeerConnection 最多 2 次，由房主发 Offer |
| PeerConnection / DataChannel 明确关闭 | 终止该连接；若选手信令正重连，让有限时长的重新加入流程继续 |

Restart 使用原 PeerConnection 的 createOffer({ iceRestart: true })。尚有未完成的本地 Offer 时先 rollback，再开始新轮次。网页只发 ICE_RESTART_REQUEST，由房主统一协商，避免 Offer 冲突。双方同时出现多个失败事件只触发一次正在进行的 Restart。

选手 WebSocket 断开仍按原房间逻辑重新加入已有房间。服务端释放旧选手会话后，旧 DataChannel 的关闭不会取消新的 JOIN。房主 WebSocket 则继续使用已有 resumeToken 恢复房间；健康的 DataChannel 不因房主信令短断而重建。

## 日志

`[Remote BP RTC]` 日志包含 roomId、peerId、connectionId、negotiationId，以及五项状态：signalingState、iceGatheringState、iceConnectionState、connectionState、dataChannelState。

记录连接创建/销毁、SDP 创建/接收/设置/发送、Candidate 产生/缓存/发送/接收/添加成功或失败、host / srflx / relay 与 UDP / TCP、DataChannel 事件、Restart 开始/成功/失败。日志不输出完整 SDP、TURN 密码或房主 resumeToken。

## ICE 配置与发布

沿用已有配置入口：

- `XQB-BPbox/src/renderer/src/config/remoteBp.ts`
- `XBQ-BPweb/src/config/runtime.ts`

默认 Google STUN 保留。两端均通过 VITE_REMOTE_BP_ICE_SERVERS 注入 RTCIceServer 数组，支持多个 urls、username 和 credential，无需修改 WebRTC 实现：

```json
[
  { "urls": "stun:stun.l.google.com:19302" },
  { "urls": "turns:turn.example.com:443?transport=tcp", "username": "example-user", "credential": "example-credential" }
]
```

示例 TURN 地址和凭证需要替换为实际服务。STUN 和 Restart 不能绕过不允许直连的 NAT / 防火墙；这类网络仍需要可达的 TURN 中继。

信令服务、网页和 BPbox 必须配套更新：旧服务不认识 PEER_READY / ICE_RESTART_REQUEST，旧客户端也不提供协商标识。本次未部署公网服务。构建需要保留仓库根目录的 shared 目录，Vite 已显式允许读取该目录。

## 验证

本次修改文件：

- `shared/remoteBpRtc.ts`
- `XQB-BPbox/src/renderer/src/services/remoteBp/WebRtcRemoteHostTransport.ts`
- `XBQ-BPweb/src/services/WebRtcRemoteBpConnection.ts`
- `remote-bp-signaling/src/index.ts`
- `remote-bp-signaling/src/server.mjs`
- `XQB-BPbox/electron.vite.config.ts`
- `XQB-BPbox/tsconfig.web.json`
- `XBQ-BPweb/vite.config.ts`
- `XQB-BPbox/package.json`
- `XQB-BPbox/scripts/webrtc-self-check.cjs`
- `remote-bp-signaling/test/signaling-self-check.mjs`
- `remote-bp-signaling/test/signaling-worker-self-check.mjs`
- `XQB-BPbox/REMOTE_BP_GUIDE.md`
- `docs/REMOTE_BP_CONNECTION_RELIABILITY.md`

验证命令：

- `XQB-BPbox`: npm run build、npm run test:remote-bp、npm run test:webrtc。
- `XBQ-BPweb`: npm run build（包含 TypeScript 检查）。
- `remote-bp-signaling`: npm run typecheck、npm run test:local、npm test。

WebRTC 自检使用可控的 PeerConnection、WebSocket 和时钟，覆盖提前 Candidate、串行排空、异常容错、重复协商、旧连接隔离、信令断开与轮次跳跃、长期稳定后的断网宽限期、Restart 上限及总超时。信令测试使用真实 WebSocket 和本地 Wrangler runtime。实际家庭网络、热点、校园网的成功率仍需配套版本部署后跨设备复测。
