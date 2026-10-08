# XBQ-BPweb

`XBQ-BPweb` 是 XQB-BPBox 的远程 BP 选手网页端。先手和后手通过信令服务器加入房间，随后使用 WebRTC DataChannel 直接向 BPbox 提交 Action，并只以 BPbox 返回的权威 `RemoteBpState` 刷新页面。

选手入口：[https://bp.xqbbp.dpdns.org/room](https://bp.xqbbp.dpdns.org/room)。输入房主提供的 6 位房间号即可加入；`https://bp.xqbbp.dpdns.org/room/<房间号>` 可预填房间号。

## 当前能力

- 输入房间码并选择先手或后手，身份由信令服务器确认。
- `WebRtcRemoteBpConnection` 与 `MockRemoteBpConnection` 共用同一上层接口。
- 支持 Action、状态同步、revision/actionId、连接状态和 Ping/Pong；当前源码的连接层支持 Candidate 缓存、就绪握手、有次数上限的 ICE Restart 与信令恢复。
- 对 BP State、Action Result、Error、Asset Manifest、资源分片和信令消息做运行时结构与大小校验。
- 通过 WebRTC DataChannel 接收角色头像、全身立绘和光锥小图，并在生成浏览器 URL 前校验大小、MIME 与 SHA-256。

## 运行

使用 Node.js 22.12 或更高版本可同时满足网页与信令工程的运行要求。请保留完整仓库中的 `shared/` 目录，网页会引用其中的连接层实现。

```bash
cd XBQ-BPweb
npm install
npm run dev
```

默认使用真实 WebRTC。复制 `.env.example` 可配置 Transport、信令地址与 STUN/TURN：

```text
VITE_REMOTE_BP_TRANSPORT=webrtc
VITE_REMOTE_BP_SIGNALING_URL=wss://signal.xqbbp.dpdns.org
VITE_REMOTE_BP_ICE_SERVERS=[{"urls":["stun:stun.l.google.com:19302"]}]
```

未设置环境变量时，生产构建默认连接公网 WSS，本地开发默认连接 `ws://localhost:8787`。上面的示例及 `.env.example` 显式指定公网 WSS，复制到 `.env.local` 后会覆盖开发默认值；本地联调需把该项改为 `ws://localhost:8787` 并重启开发服务。不要在源码中写入部署环境专用的临时地址。如需独立体验 UI，把 Transport 改为 `mock`。

## 检查与构建

```bash
npm run typecheck
npm run build
npm run preview
```

## Cloudflare Workers Static Assets 部署

Cloudflare 项目使用以下构建与部署设置：

```text
Root directory: XBQ-BPweb
Build command: npm run build
Deploy command: npx wrangler deploy
Static assets: ./dist
SPA fallback: enabled
```

Wrangler 发布 Vite 生成的 `dist` 目录；SPA fallback 由 `wrangler.jsonc` 配置，因此 `/room/ABCDEF` 等客户端路由可直接访问或刷新。

公网选手域名为 `bp.xqbbp.dpdns.org`。当前 `wrangler.jsonc` 配置了静态资源和 SPA fallback，但没有声明该自定义域名；发布到新环境时，还需在 Cloudflare 中绑定域名。

当前源码的信令扩展需要 BPbox、网页和信令服务配套更新。完整联调见[项目指南](../PROJECT_GUIDE.md#远程-bp-本地联调)，连接状态、超时与兼容要求见[连接层说明](../docs/REMOTE_BP_CONNECTION_RELIABILITY.md)。
