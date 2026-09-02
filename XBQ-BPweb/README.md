# XBQ-BPweb

`XBQ-BPweb` 是 XQB-BPBox 的远程 BP 选手网页端。先手和后手通过信令服务器加入房间，随后使用 WebRTC DataChannel 直接向 BPbox 提交 Action，并只以 BPbox 返回的权威 `RemoteBpState` 刷新页面。

## 当前能力

- 输入房间码并选择先手或后手，身份由信令服务器确认。
- `WebRtcRemoteBpConnection` 与 `MockRemoteBpConnection` 共用同一上层接口。
- 支持 Action、状态同步、revision/actionId、连接状态、Ping/Pong 和基础 ICE restart 配合。
- 对 BP State、Action Result、Error、Asset Manifest、资源分片和信令消息做运行时结构与大小校验。
- 通过 WebRTC DataChannel 接收角色头像小图和全身立绘，并在生成浏览器 URL 前校验大小、MIME 与 SHA-256。

## 运行

```bash
npm install
npm run dev
```

默认使用真实 WebRTC。复制 `.env.example` 可配置 Transport、信令地址与 STUN/TURN：

```text
VITE_REMOTE_BP_TRANSPORT=webrtc
VITE_REMOTE_BP_SIGNALING_URL=ws://localhost:8787
VITE_REMOTE_BP_ICE_SERVERS=[{"urls":["stun:stun.l.google.com:19302"]}]
```

如需独立体验 UI，把 Transport 改为 `mock`。

## 检查与构建

```bash
npm run typecheck
npm run build
npm run preview
```

完整启动、双端联调与后续 TODO 见 [本阶段开发记录](../docs/REMOTE_BP_WEBRTC_STAGE.md)。
