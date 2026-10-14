# WTN TURN 与隐藏房主授权

实现位置：现有 Cloudflare 信令 Worker + Durable Objects，Electron 主进程安全存储，双方共用的 WebRTC 连接层。没有新增独立服务器或账号系统。

## 你现在需要配置什么

仓库 `wrangler.jsonc` 的默认 AppID 为 `6ac735fb7305ab038c2e3546`。先在 Cloudflare Worker 配置中核对实际 `WTN_APP_ID` 绑定，再在对应 WTN 应用核对 AppKey 和 TURN 开通状态；不要仅凭仓库默认值替换线上 AppID。仅创建应用不等于开通 TURN。无需把任何密钥发送到聊天里。

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

BPbox 主控窗口按 **Ctrl+Shift+T**，输入密码并验证。成功后授权有效 7 天，正常退出、重启仍保留；创建房间或恢复房主信令后自动绑定授权，也可为已创建房间授权。弹窗不出现在普通 BP 设置页。选手无需密码，加入房间后使用其已验证会话。首次连接只使用 STUN/P2P；5 秒内控制通道未打开且房主已授权时，才申请 TURN 并让双方使用 `relay`。

## 协议与权限边界

- `POST /turn/authorize`：HTTPS 密码验证，签发 audience 为 `xqb-bp-turn-host` 的 HS256 令牌，包含安装身份 `sub`、唯一 `jti`、签发与到期时间。
- `POST /turn/status`、`POST /turn/revoke`：Authorization Bearer，只校验本项目房主授权令牌；不会把 WTN AppKey 或 WTN JWT 传给客户端。
- 房主通过现有 WSS 发送 `TURN_AUTHORIZE`。服务端要求当前 socket 已经是该房间真实 HOST；创建房间获得的身份或既有 resumeToken 恢复机制仍是房主身份依据。选手自称 `HOST`、提供房间码或 `turnEnabled` 均不生效。
- `TURN_REQUEST` 通过已认证 WebSocket 领取，只允许对应选手 sessionId + connectionId。仅房主可为当前选手申请，选手不能自行申请；服务端将同一组临时 ICE 同时送给双方，先送选手再送房主。没有按房间码开放的 HTTP 凭证接口。
- 授权、撤销、绑定房间、限流均使用 Durable Object 存储；Worker 重启不会遗忘撤销。每次请求（包括缓存命中）检查当前授权；上游返回后及发送前再次检查授权和当前双方会话。
- 限流：密码每 IP 每分钟 5 次、全局每分钟 100 次；状态/撤销每 IP 每分钟 60 次；房间授权/凭证请求合计每分钟 20 次；上游调用每房间每分钟 4 次、每个授权身份每分钟 20 次。每个授权最多绑定 64 个房间，关闭房间会解除绑定。客户端重复请求优先使用未临近到期的缓存。
- 桌面令牌仅通过 Electron `safeStorage` 加密写入 userData 下 `turn-authorization.bin`（Windows 为系统加密）；没有明文回退，不保存密码。令牌仅在内存中交给该信令域名的房主连接。IPC 限制为主窗口主 frame。不要把 userData 当作可跨机器复制的授权文件。
- **退出授权**成功后，项目令牌和该令牌绑定的房间立即停止领取凭证。已经发出的 WTN 凭证无法由本项目追溯撤销，仍按原 TTL 到期；客户端收到撤销通知会清除 TURN 配置；正在使用 TURN 的连接明确失败，不自动改为 P2P，已有 P2P 连接不受影响。服务端权限在通知前已经撤销。
- 离线退出会先加密保存“待撤销”标记并停用本机 TURN，明确提示服务器撤销尚未确认；联网后每 30 秒或查询状态时重试。无法声称离线时已通知服务器。其他仍在线的会话在服务器确认撤销前可能仍可领取。
- 改密码影响后续验证；要立即作废全部旧令牌可轮换 `TURN_AUTH_SIGNING_KEY` 并重新部署。已发出的 WTN 临时凭证依然按 TTL 到期。

## 连接、刷新和验证

当前行为以 [P2P 优先与 5 秒 TURN 兜底](REMOTE_BP_CONNECTION_POLICY.md) 为准。网络监测、导出和强制 TURN 开关已删除；隐藏授权入口保留。

房主授权有效期为 7 天，WTN 接口鉴权 JWT 为 300 秒，TURN 凭证请求 TTL 为 14400 秒，三者互相独立。授权临近到期时按现有机制缩短请求 TTL；客户端以服务端 expiresAt 为准。正常续期保持 TURN 模式，失败时保留尚未过期的凭证，过期或撤销后明确失败。

两端过滤公共 VITE_REMOTE_BP_ICE_SERVERS 中的 TURN；不要把付费 TURN username 或 credential 放进构建环境。只有房主授权后，经服务端校验的临时凭证可以用于超时兜底。

必须一起更新 Worker、BPbox 和网页。可用 wrangler dev 与 .dev.vars（已忽略）做本地开发；桌面开发模式设置 XQB_TURN_AUTH_URL=http://127.0.0.1:8787，信令配置为 ws://127.0.0.1:8787。生产授权仍限制 HTTPS。旧 Node 信令不提供持久化授权服务，授权功能请使用 Worker。

测试入口和真实跨网复现步骤见连接策略文档。模拟 TURN 上游不能证明真实 WTN 中继已成功；不要把凭证返回成功或 TCP 已配置当作实际中继/传输协议的证据。
