# 远程 BP：先手/后手与 WebRTC 最小闭环开发记录

## 本阶段完成

### 先手 / 后手术语迁移

远程 BP 的业务层、协议层、Mock、UI、日志和自检统一使用 `first / second` 或 `FIRST / SECOND`，界面统一显示“先手 / 后手”。`RemotePlayerSide`、`PlayerSide`、`RemoteSideMapping`、`RemoteBpState.teams`、`selections`、房间 Peer 状态等字段都已迁移。

BPbox 内部既有 `star / rail` 没有被重写。`sideMapper.ts` 是唯一适配边界：默认 `first -> star`、`second -> rail`，也支持开房前交换。远程协议不再暴露旧的颜色或布局身份。

### 核心类型与权威数据流

核心复用点如下：

- `BpActionDispatcher`：本地和远程 Action 的统一校验入口。
- `RemoteBpHost`：房间生命周期、Peer 状态、Action Result 与状态广播。
- `RemoteBpState`：BPbox 权威 Runtime 的精简网络投影。
- `RemoteHostTransport`：`MockRemoteHostTransport` 和 `WebRtcRemoteHostTransport` 的共用接口。
- Web `RemoteBpConnection`：`MockRemoteBpConnection` 和 `WebRtcRemoteBpConnection` 的共用 UI 接口。

真实消息流：

```text
Web 操作
→ WebRtcRemoteBpConnection
→ RTCDataChannel
→ WebRtcRemoteHostTransport
→ RemoteBpHost
→ BpActionDispatcher
→ 现有 BP Core 执行器
→ BPbox 权威 Runtime
→ serializeRemoteBpState
→ RTCDataChannel 广播
→ 两个 Web 页面以新状态覆盖本地视图
```

Web 页面没有乐观写入 BAN/PICK 结果。连接断开时禁止发送 Action；重连成功后主动请求最新状态。

### Signaling Server

`remote-bp-signaling` 根目录同时保留 Node.js + WebSocket 本地开发服务和协议兼容的 Cloudflare 公网实现。公网服务使用 Cloudflare Worker、SQLite-backed `BpRoom` Durable Object 和 WebSocket Hibernation API；一个 `roomId` 固定对应一个 Durable Object，不使用全局变量或 KV 保存房间。两种实现都支持：

- `CREATE_ROOM`、`RESUME_ROOM`、`JOIN_ROOM`、`LEAVE_ROOM`、`KICK_PEER`、`HEARTBEAT`。
- `OFFER`、`ANSWER`、`ICE_CANDIDATE` 中继。
- `ROOM_CREATED`、`ROOM_RESUMED`、`ROOM_JOINED`、`PEER_JOINED`、`PEER_LEFT`、`HOST_DISCONNECTED`、`HOST_RECONNECTED`、`ERROR`。

房间持久保存 `roomCode`、房主 session、房主恢复凭证和 `createdAt`；运行时保留先手、后手槽位。服务器生成 6 位房间码和随机 sessionId；一个选手槽位只能存在一个连接。房主信令异常断开不再销毁房间，而是通知选手等待恢复；房主明确点击“关闭房间”才会发出 `ROOM_CLOSED` 并释放所有连接。选手异常断开会释放对应槽位。

服务提供 `/health`，新房间不再设置固定 TTL 或空闲销毁计时器。本地 Node 服务监听 `0.0.0.0:8787`；公网入口为 `wss://signal.xqbbp.dpdns.org`。公网选手连接通过 `?roomId=ABCDEFG` 定位房间。

### Signaling Client 与 WebRTC

BPbox 的 `WebRtcRemoteHostTransport` 连接信令服务并创建房间。每当先手或后手加入时，它为该选手建立独立 `RTCPeerConnection`，创建有序 DataChannel，生成 Offer，并把服务器确认的 role/session 绑定为 Peer 身份。

Web 的 `WebRtcRemoteBpConnection` 先请求加入房间，拿到服务器确认的 `assignedSide` 和 sessionId 后再响应 Offer、创建 Answer。DataChannel 打开后才把连接状态设为 `connected` 并进入 BP 页面。

支持 `connecting / connected / disconnected / failed / reconnecting / kicked / room-closed`。DataChannel 每 15 秒发送与 BP Action 分离的 `PING/PONG`，信令 WebSocket 每 20 秒发送 `HEARTBEAT/HEARTBEAT_ACK`；两种心跳都不改变 revision，也不触发 BP 状态广播。短暂 ICE 断线保留 10 秒恢复窗口，仅在确认失败后重建；信令断线采用有上限的指数退避自动重连。Web 保留最后一次权威 UI 状态，恢复后重新请求状态。`KICKED` 和 `ROOM_CLOSED` 是终止状态，不会自动重连。

### 连接状态与 WAIT

- BPbox 房间管理卡分别展示先手/后手的连接中、已连接、重连中和未连接状态，并可以用独立的 `×` 踢出某个槽位。Web 的两侧选手区同步显示实际 Peer/DataChannel 状态。
- 直播 BP 因展示页延迟规则需要 BPbox 额外点击时，Host 在 `RemoteBpState` 中明确发布 `waitingForHost: true`、`phase: WAITING` 与 `currentOperation: WAIT`。Web 顶部显示中性配色的 `WAIT`，并清空可操作目标与确认能力，不依赖 disabled 按钮反推。

### actionId / revision

每个 Action 携带：

```text
actionId
actorSide
expectedRevision
stepIndex
action payload
```

`BpActionDispatcher` 串行处理并校验 actionId、revision、当前步骤、当前操作者、动作类型和目标可用性。合法且确实改变状态的操作才增加 revision。revision 冲突返回 `REVISION_CONFLICT`，Host 随后向该 Peer 重新发送最新权威状态。

### Runtime Schema Validation 与大小限制

网络边界不依赖 TypeScript 断言：

- 信令服务器验证所有客户端信令消息、未知类型、SDP、ICE、role、房间码和字符串长度。
- BPbox 验证 DataChannel 的 Action、状态请求、资源请求和 Ping。
- Web 验证 BP State、Action Result、Error、Asset Manifest、资源分片、Pong 与信令服务器消息。
- 信令消息最大 64 KiB；BP DataChannel JSON 最大 512 KiB。
- 非法 JSON、未知 type、缺失字段、错误字段类型和超大 payload 都会被拒绝。

当前使用项目内的显式运行时解析器，避免为三个独立包重复引入 schema 库；解析器返回重新确认过的 DTO。

### 选手端资源传输

- BPbox Manifest 只公开角色 `avatar_small_image`（头像小图）、`full_body_image`（全身立绘）和光锥小图的 assetId、SHA-256、size、MIME 与所属目标 ID，不公开本地路径。
- 角色状态 DTO 只公开姓名、命途、属性、两个图片 assetId；光锥 DTO 只公开姓名、命途和小图 assetId；两者都只附带执行 BP 所必需的 ID 和操作状态。
- Web 按当前页面实际需要请求缓存中缺失的 assetId：角色池优先请求头像，选中后再请求立绘，进入光锥阶段后再请求光锥小图。Host 以 128 KiB 原始分片编码为 Base64，通过 ordered DataChannel 依次发送 `ASSET_START / ASSET_CHUNK / ASSET_COMPLETE`。
- Host 使用 `bufferedAmount` 背压；Web 重组前后校验清单一致性、分片数量/大小、总大小、图片 MIME 和 SHA-256，再创建 Blob URL。
- 单资源上限 64 MiB；未知、路径式、空文件、非白名单格式和超限文件不会进入 Manifest。
- BPbox 按路径、大小和修改时间缓存资源描述及 SHA-256；图片未变化时不再反复读取和哈希全部资源，新增或变化文件使用异步 I/O 增量刷新，并向已连接选手广播新 Manifest。

### 协议 1.1 交互扩展

- 网页加入房间时提交队伍或选手展示名称；BPbox 仅用它替换左右队标签，先手/后手权限映射不变。
- Web 的 `SELECT` / `DESELECT` 会同步成带目标类型的预选。BPbox 控制页同步高亮，直播展示页只在下一个待选位置显示灰化预览，不写入正式 Action，也不加载资源、播放视频、音频或特效。
- `CONFIRM` 才提交正式 BAN/PICK。保护和租借允许双方分别选择各自合法目标并确认，第二位选手完成确认后才形成一次正式操作并推进流程。
- `RemoteBpState` 新增光锥池及结果、`selectionTargets`、`confirmedSides`、分侧可用目标与分侧确认能力。协议版本从 `1.0.0` 提升为 `1.1.0`，资源分片性能优化后补丁版本为 `1.1.1`；本轮增加连接状态、`WAIT`、踢出与房间关闭终止消息后升级为 `1.2.1`。Web 与 BPbox 需要配套更新，信令服务器仍只负责房间和 WebRTC 信令转发。

### STUN / TURN 配置

BPbox 和 Web 都从配置层读取 `iceServers`。开发默认值为：

```json
[{ "urls": ["stun:stun.l.google.com:19302"] }]
```

可通过各自的 `VITE_REMOTE_BP_ICE_SERVERS` 传入标准 `RTCIceServer[]` JSON。TURN 的 URL、username 和 credential 可以放入同一配置；本阶段没有部署 TURN。

## 如何启动

### Signaling Server

```bash
cd remote-bp-signaling
npm install
npm start
```

可参考 `.env.example` 设置 `SIGNALING_HOST` 和 `SIGNALING_PORT`。跨设备联调时，防火墙需要允许所选端口。

公网 Worker 本地检查及部署：

```bash
cd remote-bp-signaling
npm install
npm run typecheck
npm test
npx wrangler deploy
```

Wrangler 将 `signal.xqbbp.dpdns.org` 配置为 `xqb-bp-signaling` Worker 的 Custom Domain，并创建 `BpRoom` Durable Object。DNS、证书和部署前提见该目录的 `README.md`。

### BPbox

```bash
cd XQB-BPbox
npm install
npm run dev
```

BPbox 的开发与生产构建默认都使用 `wss://signal.xqbbp.dpdns.org`。如需本地或跨设备局域网联调，可在 `.env.local` 中把 `VITE_REMOTE_BP_SIGNALING_URL` 显式设为 `ws://localhost:8787` 或局域网地址，例如 `ws://192.168.1.20:8787`。在“开始 BP”页点击“创建远程 BP”，管理卡片会显示房间码、信令状态、先手/后手连接状态和 revision。

### Web

```bash
cd XBQ-BPweb
npm install
npm run dev -- --host 0.0.0.0
```

生产网页 `https://xqbbp.dpdns.org` 默认使用公网 WSS。开发模式默认连接 `ws://localhost:8787`；跨设备本地联调时可在 `.env.local` 中覆盖为选手浏览器可访问的地址。

## 双端联调步骤

1. 启动 Signaling Server，并确认 `http://<server>:8787/health` 返回 `ok: true`。
2. 启动 BPbox，开始一场 BP，点击“创建远程 BP”，记下 6 位房间码。
3. 浏览器 A 输入房间码、展示名称并选择“先手”。加入成功后，BPbox 显示“先手：已连接”。
4. 浏览器 B 输入同一房间码、展示名称并选择“后手”。加入成功后，BPbox 显示“后手：已连接”。
5. 在当前轮到的一方选择角色并确认。检查 BPbox 执行动作、revision 增加、两端页面同步刷新。
6. 等待资源计数完成，确认角色阶段显示头像/立绘、光锥阶段自动切换为光锥池并显示小图，且浏览器拿不到任何 BPbox 本地路径。
7. 尝试让非当前操作者提交，或使用过期 revision；应收到拒绝且 BPbox 状态不被修改。
8. 断开一个浏览器，检查槽位释放和连接状态；重新加入后以 BPbox 最新状态覆盖页面。
9. 静置数十分钟，确认信令心跳与 DataChannel Ping 持续，revision 不增加、选手不离房。
10. 分别踢出先手和后手，确认仅对应窗口显示“已被房主踢出”，旧客户端不重连，新选手可立即补位。
11. 关闭房间，确认两窗口都显示“房间已关闭”且不再重连。

## 验证命令

```bash
cd remote-bp-signaling && npm run test:local
cd remote-bp-signaling && npm run typecheck && npm test
cd XQB-BPbox && npm run typecheck && npm run test:remote-bp
cd XBQ-BPweb && npm run build
```

## 尚未完成

- 生产 TURN 服务与凭据下发。
- 独立二进制资源通道与传输取消；当前为有界 Base64 分片。
- `IndexedDBAssetCache`。
- 更完整的审计日志和监控。
- 公网上线后的 NAT、企业网络与移动网络覆盖测试。
