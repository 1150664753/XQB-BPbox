# WTN TURN 与隐藏房主授权

实现位置：现有 Cloudflare 信令 Worker + Durable Objects，Electron 主进程安全存储，双方共用的 WebRTC 连接层。没有新增独立服务器或账号系统。

## 你现在需要配置什么

仓库 `wrangler.jsonc` 的默认 AppID 为 `6ac735fb7305ab038c2e3546`。先通过网络诊断的 `turnAppId` 核对实际 Worker 绑定，再在对应 WTN 应用核对 AppKey 和 TURN 开通状态；不要仅凭仓库默认值替换线上 AppID。仅创建应用不等于开通 TURN。无需把任何密钥发送到聊天里。

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
| `WTN_TURN_TTL_SECONDS` | `14400`（4 小时） |

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

BPbox 主控窗口按 **Ctrl+Shift+T**，输入密码并验证。成功后授权有效 7 天，正常退出、重启仍保留；创建房间或恢复房主信令后自动绑定授权，也可为已创建房间授权。弹窗不出现在普通 BP 设置页。选手无需密码，加入房间后使用其已验证会话。默认 `iceTransportPolicy` 为 `all`；创建房间前启用“强制 TURN 测试”后，双方使用 `relay`。

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

普通模式首次协商保留现有 STUN/P2P；5 秒仍未连通时提前按需获取 TURN。首次中继尝试仅使用接口实际返回的 UDP URL，3 秒仍未连通或 ICE 明确失败时加入原始 TCP/TLS URL，并受控 ICE restart；只有 TCP 的响应直接使用 TCP。保留 15 秒短暂掉线宽限、两次重试和 120 秒总恢复期限，不因 701 单独重建连接。

实际使用中继时，在凭证剩余有效期进入刷新窗口后更新（窗口为安装时剩余 TTL 的 1/3，最多 90 秒）。成功拿到新凭证才 ICE restart；请求失败保留仍有效的原连接，通常每 30 秒重试（短 TTL 按刷新窗口限频）。更新通过 `setConfiguration` 保留原 DataChannel、状态 revision 和未完成的资源接收。普通模式无权限、超时、配置缺失和无效上游返回仍允许 P2P；强制模式明确失败，不回退直连。健康直连不因闲置凭证到期而重连。

房主授权为 7 天；请求 WTN API 的 JWT 为 300 秒；TURN 访问凭证请求 TTL 为 14400 秒，三者互相独立。房主授权临近到期时会缩短请求 TTL 并记录 `HOST_AUTH_EXPIRING`。`expiresAt` 始终从请求开始时间加接口实际返回 `ttl` 计算，不从客户端硬编码 4 小时推算。上游返回不同 TTL 时记录请求值、实际值；供应商没有说明原因时明确标记 `PROVIDER_TTL_MISMATCH_REASON_NOT_SUPPLIED`，不猜测原因。

地域接入仍采用官方推荐的 `wtn.volcvideo.com`，支持配置文档列出的区域域名。这里的调用方是 Worker，其就近节点不一定适合双方玩家。诊断记录 API 域名、实际返回的无凭证服务器 URL、被选中的候选对及中继协议，供跨网实测后选择地域；不固定任何未经验证的中继 IP。详见 [2026-10-12 优化及验证记录](REMOTE_BP_NETWORK_OPTIMIZATION.md)。

两端均过滤公共 `VITE_REMOTE_BP_ICE_SERVERS` 中的 TURN；请不要再把付费 TURN 用户名或 credential 放入 Vite 环境变量。只有服务端认证后下发的凭证能加入连接配置。

远程连接区域的“网络诊断”显示实际选中的 candidate pair、RTT、收发字节/速率、发送缓冲、各层状态及凭证结果，并可导出脱敏日志。Ctrl+Shift+T 授权弹窗仍保留简要诊断。详见 [网络诊断与测试说明](REMOTE_BP_NETWORK_DIAGNOSTICS.md)。

## 强制 TURN 测试

正式界面中，在创建房间前展开“网络诊断”并勾选“强制 TURN 测试”，完成桌面端授权后再建房。房间保存策略，Web 端从 ROOM_JOINED 继承；每轮 SDP 也交换策略。房主等凭证安装后才发 Offer，双方在 `getStats()` 确认实际选中 `relay / relay` 后才报告连接成功。无法获得凭证、对端不确认策略、选中直连或无法核实路径时均明确失败。Worker、BPbox、Web 端需一起更新；旧端/旧 Worker 不确认策略会使强制测试失败。结束测试后关闭房间并取消勾选。

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

环境变量是可选的构建配置，开发和生产都生效，默认关闭。没有权限不会绕过服务端检查，也不会悄悄改用直连。测试后移除变量；生产构建不应默认开启强制测试。

成功标准必须同时满足：两端临时凭证为 ready、选中 pair 至少一端为 relay、DataChannel 为 open、BP 状态同步和角色图片传输成功。只收到凭证或只显示“已授权”不算 TURN 连通成功。

Chrome 中先打开 `chrome://webrtc-internals`，再加入房间。在对应 RTCPeerConnection 找到 `transport.selectedCandidatePairId`，定位这个 candidate-pair 的 localCandidateId/remoteCandidateId；强制模式检查双方导出中的 localType、remoteType 都是 `relay`、`relayVerified=true`。确认 pair 为 succeeded，并检查 `data-channel` 的 `state=open` 和 bytes 计数增长。普通模式下选中 host/srflx 而没有 relay 是正常的直连优先结果。不要公开包含 SDP、地址或凭证的原始调试转储。完整验收矩阵见 [WTN TURN 审计报告](WTN_TURN_AUDIT.md)。

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
