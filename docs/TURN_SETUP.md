# WTN TURN 与隐藏房主授权

实现位置：现有 Cloudflare 信令 Worker + Durable Objects，Electron 主进程安全存储，双方共用的 WebRTC 连接层。没有新增独立服务器或账号系统。

## 你现在需要配置什么

先在火山引擎 WTN 控制台确认应用 `6ac735fb7305ab038c2e3546` 的 AppKey，并联系 WTN 技术支持为该应用开通 TURN。仅创建应用不等于开通 TURN。无需把任何密钥发送到聊天里。

Cloudflare Worker **Secrets**（三个都不要写进源码、Vite 环境变量或客户端）：

| 名称 | 用途 |
| --- | --- |
| `WTN_APP_KEY` | 该 WTN 应用的 AppKey，只用于 Worker 签名 WTN 请求 |
| `TURN_ACCESS_PASSWORD` | 你自行设置并告知获准房主的密码；客户端不进行本地比对 |
| `TURN_AUTH_SIGNING_KEY` | 独立随机签名密钥，至少 32 字符；建议 32 随机字节的 Base64；不要复用 AppKey 或密码 |

已在 `remote-bp-signaling/wrangler.jsonc` 写入的**非敏感变量**：

| 名称 | 当前值 |
| --- | --- |
| `WTN_APP_ID` | `6ac735fb7305ab038c2e3546` |
| `WTN_API_DOMAIN` | `wtn.volcvideo.com` |
| `WTN_TURN_TTL_SECONDS` | `3600` |

Worker 绑定：保留 `BP_ROOMS → BpRoom`，新增 `TURN_AUTH → TurnAuthority`；迁移 `v2-turn-auth` 创建 SQLite Durable Object。不要删除旧 `v1` 迁移，也不要清空现有房间存储。

## Wrangler 配置与部署

PowerShell，从项目目录执行：

```powershell
Set-Location C:\project\XQB-BP\remote-bp-signaling
npm ci
npx wrangler login
npx wrangler secret put WTN_APP_KEY
npx wrangler secret put TURN_ACCESS_PASSWORD
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))" | npx wrangler secret put TURN_AUTH_SIGNING_KEY
npm run typecheck
npm test
npm run test:turn
npm run deploy
```

前两个 `secret put` 命令分别等待你交互输入 AppKey 和授权密码。第三个命令生成随机密钥并直接送入 Wrangler，不把密钥写入仓库。若是首次创建 Worker，Wrangler 可能提示创建同名 Worker，按提示完成即可。非敏感变量由已修改的 Wrangler 配置随部署上传，无需 `secret put`。

域名仍为 `signal.xqbbp.dpdns.org`，需属于同一 Cloudflare 账号可管理的 Zone。保留原来的自定义域及 WebSocket 配置，不需要新服务器。部署后检查：

```powershell
Invoke-RestMethod https://signal.xqbbp.dpdns.org/health
```

`/health` 只验证信令服务，不代表 TURN 已开通。授权成功也不代表 WTN TURN 已可用；实际领取凭证时才访问 WTN。未配置 AppKey 时会返回 `TURN_NOT_CONFIGURED`。

## 更新 BPbox 和选手端

先部署 Worker，再部署网页，最后安装新版 BPbox，两端应一起升级。

```powershell
Set-Location C:\project\XQB-BP\XBQ-BPweb
npm ci
npm run build
..\remote-bp-signaling\node_modules\.bin\wrangler.cmd deploy

Set-Location C:\project\XQB-BP\XQB-BPbox
npm ci
npm run test:remote-bp
npm run test:webrtc
npm run test:turn-desktop
npm run build:win
```

Web 使用现有 `XBQ-BPweb/wrangler.jsonc` 的静态资源部署，保留当前 `bp.xqbbp.dpdns.org` 域名映射。安装 electron-builder 输出的新版 Windows 安装包；`npm run build` 仅生成 `out`，不会发布安装包。这里没有执行线上部署，也没有运行带 GitHub 发布动作的 `release:win`。

BPbox 主控窗口按 **Ctrl+Shift+T**，输入密码并验证。成功后授权有效 7 天，正常退出、重启仍保留；创建房间或恢复房主信令后自动绑定授权，也可为已创建房间授权。弹窗不出现在普通 BP 设置页。选手无需密码，加入房间后使用其已验证会话。生产构建的 `iceTransportPolicy` 固定为 `all`。

## 协议与权限边界

- `POST /turn/authorize`：HTTPS 密码验证，签发 audience 为 `xqb-bp-turn-host` 的 HS256 令牌，包含安装身份 `sub`、唯一 `jti`、签发与到期时间。
- `POST /turn/status`、`POST /turn/revoke`：Authorization Bearer，只校验本项目房主授权令牌；不会把 WTN AppKey 或 WTN JWT 传给客户端。
- 房主通过现有 WSS 发送 `TURN_AUTHORIZE`。服务端要求当前 socket 已经是该房间真实 HOST；创建房间获得的身份或既有 resumeToken 恢复机制仍是房主身份依据。选手自称 `HOST`、提供房间码或 `turnEnabled` 均不生效。
- `TURN_REQUEST` 通过已认证 WebSocket 领取，只允许对应选手 sessionId + connectionId。房主可为当前选手申请，选手可用自己的会话申请；服务端将同一组临时 ICE 同时送给双方，先送选手再送房主。没有按房间码开放的 HTTP 凭证接口。
- 授权、撤销、绑定房间、限流均使用 Durable Object 存储；Worker 重启不会遗忘撤销。每次请求（包括缓存命中）检查当前授权；上游返回后及发送前再次检查授权和当前双方会话。
- 限流：密码每 IP 每分钟 5 次、全局每分钟 100 次；状态/撤销每 IP 每分钟 60 次；房间授权/凭证请求合计每分钟 20 次；上游调用每房间每分钟 4 次、每个授权身份每分钟 20 次。每个授权最多绑定 64 个房间，关闭房间会解除绑定。客户端重复请求优先使用未临近到期的缓存。
- 桌面令牌仅通过 Electron `safeStorage` 加密写入 userData 下 `turn-authorization.bin`（Windows 为系统加密）；没有明文回退，不保存密码。令牌仅在内存中交给该信令域名的房主连接。IPC 限制为主窗口主 frame。不要把 userData 当作可跨机器复制的授权文件。
- **退出授权**成功后，项目令牌和该令牌绑定的房间立即停止领取凭证。已经发出的 WTN 凭证无法由本项目追溯撤销，仍按原 TTL 到期；客户端收到撤销通知会清除 TURN 配置并尝试恢复 P2P。服务端权限在通知前已经撤销。
- 离线退出会先加密保存“待撤销”标记并停用本机 TURN，明确提示服务器撤销尚未确认；联网后每 30 秒或查询状态时重试。无法声称离线时已通知服务器。其他仍在线的会话在服务器确认撤销前可能仍可领取。
- 改密码影响后续验证；要立即作废全部旧令牌可轮换 `TURN_AUTH_SIGNING_KEY` 并重新部署。已发出的 WTN 临时凭证依然按 TTL 到期。

## 连接、刷新和诊断

首次协商保留现有 STUN/P2P。授权房间在连接失败、ICE 重启时按需获取 TURN；已有凭证到期前 90 秒触发更新和 ICE restart。更新通过 `setConfiguration` 合并原有 STUN 与服务器返回的 TURN，保留原 DataChannel、状态 revision 和资源分片逻辑。无权限、超时、配置缺失和无效上游返回均保留 P2P 并提供诊断。

两端均过滤公共 `VITE_REMOTE_BP_ICE_SERVERS` 中的 TURN；请不要再把付费 TURN 用户名或 credential 放入 Vite 环境变量。只有服务端认证后下发的凭证能加入连接配置。

Ctrl+Shift+T 弹窗的“连接诊断”显示 ICE 状态、选中 candidate pair 类型、是否 relay、领取状态/到期时间和原因。两端控制台 `[Remote BP RTC]` 也提供这些信息，不输出密码、令牌、TURN 用户名/credential、完整 SDP 或完整 candidate。

## 仅开发测试的强制 relay

必须先完成 Worker Secrets 和 WTN TURN 开通。在两个独立 PowerShell 窗口启动：

```powershell
# 窗口一：BPbox
Set-Location C:\project\XQB-BP\XQB-BPbox
$env:VITE_REMOTE_BP_SIGNALING_URL = 'wss://signal.xqbbp.dpdns.org'
$env:VITE_REMOTE_BP_TEST_FORCE_RELAY = '1'
npm run dev

# 窗口二：网页
Set-Location C:\project\XQB-BP\XBQ-BPweb
$env:VITE_REMOTE_BP_SIGNALING_URL = 'wss://signal.xqbbp.dpdns.org'
$env:VITE_REMOTE_BP_TEST_FORCE_RELAY = '1'
npm run dev
```

在桌面端授权，再创建房间；用 Chrome 打开 Vite 显示的选手页面加入。此开关只在 `import.meta.env.DEV` 为真且已获得临时凭证时改为 `relay`，没有权限不会绕过服务端检查。生产构建即使残留该变量也仍为 `all`。测试后在两个窗口移除该变量或关闭终端。

成功标准必须同时满足：两端临时凭证为 ready、选中 pair 至少一端为 relay、DataChannel 为 open、BP 状态同步和角色图片传输成功。只收到凭证或只显示“已授权”不算 TURN 连通成功。

Chrome 中先打开 `chrome://webrtc-internals`，再加入房间。在对应 RTCPeerConnection 找到 `transport.selectedCandidatePairId`，定位这个 candidate-pair 的 localCandidateId/remoteCandidateId；检查对应 candidate 的 `candidateType` 是否为 `relay`。确认 pair 为 succeeded/nominated，并检查 `data-channel` 的 `state=open`、messagesSent/messagesReceived 和 bytes 计数增长。普通模式下选中 host/srflx 而没有 relay 是正常的直连优先结果。不要公开包含 SDP、地址或凭证的原始调试转储。

本地全链路开发可用 `wrangler dev` 与 `.dev.vars`（已加入 gitignore）。桌面开发模式另外设置 `XQB_TURN_AUTH_URL=http://127.0.0.1:8787`，两端信令设置 `ws://127.0.0.1:8787`；只有本机开发例外允许 HTTP，生产固定 HTTPS。旧 `npm start` 的 Node 信令保留 P2P，不提供持久化授权服务，请用 Wrangler 测试新授权功能。

## 本次测试结果与限制

2026-10-08，本地检查：

| 检查 | 结果 |
| --- | --- |
| Worker `npm run typecheck` | 通过 |
| Worker `wrangler deploy --dry-run` | 本地打包与绑定检查通过，未部署 |
| Worker `npm test`、`npm run test:local` | 原有房间/身份/信令/恢复/踢人回归通过 |
| Worker `npm run test:turn` | HS256、7 天有效期、错密码、伪造/过期/撤销令牌、选手身份隔离、真实 workerd + SQLite DO 持久化、并发撤销、限流、缺少 AppKey、上游错误/TTL/ICE 校验通过；WTN 上游全部 Mock |
| BPbox `npm run test:remote-bp` | dispatcher、serializer、资源、host 端到端通过 |
| BPbox `npm run test:webrtc` | ICE 队列/重连回归、临时 TURN 安装/刷新/过期、强制 relay 配置门控、日志脱敏通过；PeerConnection 为 Mock |
| BPbox `npm run test:turn-desktop` | 真实 Electron/Windows 加密存储、进程重启、实际主进程 IPC + Mock HTTPS、隐藏弹窗、密码清空、域名限制、离线撤销重试通过 |
| BPbox 与网页 `npm run build` | 类型检查及构建通过 |

目前没有真实 AppKey、授权密码或签名 Secret，没有部署线上 Worker，也没有声称真实 WTN relay DataChannel 已成功。待你配置后，仍需按上面的强制 relay 流程验证真实 UDP/TCP TURN、跨网络联通，以及持续超过一个 TTL 的刷新。Mock 测试不能替代这些网络测试。未开通 TURN 或缺少 AppKey 时，P2P、普通 BP、房间与信令仍可使用，但无法验证真实中继及其凭证轮换。

Windows 受限沙箱可能阻止 workerd SQLite 或 Electron 子进程，测试需要允许本地进程运行。测试仅用合成密钥、`.test` 域名的 Mock 响应，绝不会消耗 WTN 流量。`test:turn-desktop` 的截图输出在 `XQB-BPbox/.tmp/turn-desktop-test/authorization-dialog.png`，测试目录和脚本已从安装包排除。

## 主要修改文件

- `remote-bp-signaling/src/turn.mjs`、`turn.d.mts`：WTN JWT/接口、响应校验、缓存与上游限流。
- `remote-bp-signaling/src/turnAuth.ts`：HTTPS 授权接口、Durable Object 授权/撤销/限流。
- `remote-bp-signaling/src/index.ts`、`wrangler.jsonc`：房间身份绑定、双方凭证分发、新 DO 迁移和变量。
- `XQB-BPbox/src/main/ipc/turnAuth.ts`、`src/main/remoteBp/turnAuthStore.ts`、`src/shared/turnAuth.ts`：HTTPS 验证、令牌加密持久化与撤销重试。
- `XQB-BPbox/src/main/index.ts`、`windows.ts`、`src/preload/index.ts`、`types.ts`：快捷键、主窗口权限与窄 IPC 桥。
- `XQB-BPbox/src/renderer/src/components/remoteBp/TurnAuthorizationDialog.tsx`、`App.tsx`、`styles/remote-bp.css`：隐藏弹窗与诊断。
- `shared/remoteBpRtc.ts`、桌面 `WebRtcRemoteHostTransport.ts`、网页 `WebRtcRemoteBpConnection.ts` 及双方工厂/配置：STUN 过滤、授权绑定、按需 TURN、刷新、relay 测试与脱敏诊断。
- `remote-bp-signaling/test/turn-self-check.mjs`、`XQB-BPbox/scripts/turn-desktop-*.cjs`、`webrtc-self-check.cjs`：新增 Mock 与真实本地运行时测试。
- `.gitignore`、`electron-builder.yml`、双方 package scripts、本说明：密钥/测试产物排除、运行命令和部署说明。

实现依据：[获取 TURN 信息](https://docs.volcengine.com/docs/WebRTCtransportnetwork/GetTURNserviceinformation?lang=zh)、[接口鉴权](https://docs.volcengine.com/docs/WebRTCtransportnetwork/Interfaceauthentication?lang=zh)、[接口域名](https://docs.volcengine.com/docs/WebRTCtransportnetwork/Requestdomainname?lang=zh)、[WebRTC 接入](https://docs.volcengine.com/docs/WebRTCtransportnetwork/UseTURNservicetoimprovetheconnectionrateofP2Pcalls?lang=zh)。请求使用大写 `TTL`，响应检查 `code=200`、实际 `ttl` 和 `ice_servers`；JWT payload 仅为 `version`、`appID`、`exp`。
