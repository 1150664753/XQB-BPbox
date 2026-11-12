# 樱花穿透远程 BP 与网络设置

BPbox 提供 WebRTC（STUN/TURN）与樱花穿透（WebSocket）两种模式。默认仍是 WebRTC，原有 TURN 密码授权、权限和回退策略保留。统一使用 **Ctrl + Shift + T** 打开“远程 BP 网络设置”。主界面只展示模式、房间、选手状态和邀请操作。

## 房主操作

1. 更新 BPbox，并将本次 `XBQ-BPweb` 的构建发布到原 Cloudflare Pages 选手网站。房主不需要本地托管网页，选手不需要安装客户端。
2. 房主自行安装并运行外部 [SakuraFrp 客户端](https://doc.natfrp.com/frpc/usage.html)。BPbox 不下载、不启动、不管理该客户端，也不接收 Token 或隧道 ID。
3. 在外部客户端创建 **TCP** 隧道，映射到 `127.0.0.1:18787`。若修改本地端口，需要与 BPbox 设置一致。
4. 为该 HTTP/WebSocket 服务启用 **自动 HTTPS**，绑定域名和浏览器信任的证书，然后重启隧道。推荐使用樱花的子域绑定与证书功能。仅开启自动 HTTPS 得到自签名证书仍不能满足 WSS；不要忽略证书错误。公网地址使用客户端显示的实际域名及端口，公网端口可以与本地端口不同。
5. 在 BPbox 按 **Ctrl + Shift + T**，顶部选择“樱花穿透”，填写本地端口和公网地址，例如 `https://分配的子域名:公网端口`，保存配置。
6. 点击“启动本地服务”和“验证公网 WSS”。服务只监听回环地址，启动本地服务本身不会创建 BP 房间或允许选手加入。
7. 在“远程 BP”卡片点击“启动樱花房间”，再点击“复制邀请”。选手通过完整链接进入原网页，选择先手/后手、填写名称后加入。不支持仅输入六位房间号发现樱花房间。
8. 比赛期间保持 BPbox 和外部樱花客户端运行。结束后关闭 BP 房间；外部客户端由房主自行停止。

切换到 WebRTC 后，同一设置窗口显示原有 TURN 授权密码、状态、有效期和退出授权操作。已有房间时，模式及网络配置锁定，并提示先关闭房间；不会自动断开选手或更改 BP 进度。关闭房间后切换模式会清理旧网络资源。

配置保存于 Electron 用户数据目录 `sakura/network.json`，仅包含模式、公网地址和本地端口。重启会恢复设置，但不会自动启动服务。没有 SakuraFrp Token、第三方可执行文件路径或进程管理配置。

## 外部 HTTPS/WSS 配置参考

本地服务是明文 HTTP/WebSocket；自动 HTTPS 在 frpc 接收端终止 TLS，再连接本机服务。Cloudflare Pages 只提供网页文件，浏览器直接向樱花公网地址发起 WSS，不经过 Pages 中转。

- [自动 HTTPS 工作方式与配置](https://doc.natfrp.com/frpc/auto-https.html)
- [子域绑定及 SSL 证书](https://doc.natfrp.com/bestpractice/domain-bind.html)：将子域绑定到已启用自动 HTTPS 的隧道，重启后等待客户端加载有效证书。
- [Web 应用穿透和节点要求](https://doc.natfrp.com/app/http.html)：选择允许该用途的节点。如启用服务商访问认证，还需确保浏览器 WebSocket 能通过该认证。

TCP 隧道不天然提供浏览器可用的 WSS。BPbox 对填写的公网地址正常校验证书、禁止重定向，并通过当前服务的随机探测凭证验证目标服务。验证失败会显示错误，不会以监听端口成功代替公网成功。

## 连接、资源和安全

- 业务继续使用原 `RemoteBpHost`、dispatcher、serializer 和 SELECT / DESELECT / CONFIRM / BAN / PICK 协议。房主负责轮次、席位、actionId 去重和 revision 校验。
- WebSocket `/bp` 传输操作与状态，独立 `/assets` 传输资源。资源有小分片、背压和节流，控制消息优先；复用 Manifest、SHA-256 校验和网页 IndexedDB 缓存，按需获取图片。
- HTTP 只提供无敏感信息的 `/health`，不提供本地文件访问。监听固定为 `127.0.0.1`；端口可配置为 1024–65535。
- 生产 Origin 只允许 `https://bp.xqbbp.dpdns.org`，与共享选手入口一致。迁移网站域名需更新 `shared/sakuraBp.ts` 并重新发布两端。
- 邀请含 256 位随机房间凭证，放在 URL fragment 中；网页读取后清除地址栏 fragment，凭证不会进入网站请求查询参数或 Referrer。首次加入后另发席位恢复凭证。仅知道房间号或名称不能接管席位。
- 连接有 Origin、路径、房间/席位鉴权、64 KiB 输入上限、频率限制和未认证超时。`sakura-ws/1` 传输版本和 `1.2.1` 业务版本均检查，不匹配则拒绝。
- 15 秒心跳、45 秒失联阈值，网页自动退避重连，恢复席位并请求完整权威状态。断线保留席位，需要释放时房主可踢出选手。
- 同一浏览器标签页刷新可从 sessionStorage 恢复邀请/席位。禁用该存储时，当前页仍可重连，刷新后可能需要重新打开邀请并由房主释放旧席位。
- 关闭房间清理所有控制/资源连接、定时器和本地服务。主窗口刷新、崩溃和软件退出也会停止本地服务，外部客户端不受 BPbox 控制。

状态分别显示本地监听、公网 WSS 和两名选手连接。公网验证每 20 秒更新，仅代表房主通过所填公网地址完成验证，仍需异地选手实测。外部隧道暂时断开时，本地房间保留，选手自动重连。

## 主要改动文件

| 模块 | 文件 |
| --- | --- |
| 统一设置、简化主卡片 | `TurnAuthorizationDialog.tsx`、`SakuraSettings.tsx`、`RemoteBpPanel.tsx`、`remote-bp.css` |
| 设置与房间切换协调 | `services/remoteBp/networkSettings.ts`、`SelectableRemoteHostTransport.ts`、`createRemoteHostTransport.ts` |
| 本地服务、持久化、公网验证 | `main/remoteBp/SakuraManager.ts`、`SakuraRoomServer.ts` |
| 桌面传输与 IPC | `SakuraRemoteHostTransport.ts`、`main/ipc/sakura.ts`、`preload/index.ts`、`shared/sakura.ts` |
| 邀请和网页适配 | `shared/sakuraBp.ts`、`XBQ-BPweb/src/services/SakuraRemoteBpConnection.ts`、`sakuraInvitation.ts`、网页连接工厂与加入页面 |

## 验证与限制

- `npm run test:sakura`：真实回环 WebSocket，两名选手、完整两轮 BAN/PICK 测试流程、预选/取消/确认、操作去重/revision、图片校验缓存、心跳超时、重连席位、伪造席位拒绝、踢出、关闭和切换限制。另在真实 Electron 下检查统一窗口、持久化与进程重启恢复、主窗口 IPC 权限、服务启停、刷新清理及公网状态失败/恢复。
- Electron 集成测试的公网探测使用明确的回环路由替身，不连接 SakuraFrp；测试中的 WebRTC 卡片使用房间替身，实际 WebRTC 逻辑另由原有回归测试覆盖。
- `npm run test:turn-desktop`：原 TURN 安全存储、授权密码、退出授权与离线撤销重试回归。
- `npm run build:unpack` 后 `npm run test:sakura-packaged`：加载实际 Windows ASAR，检查真实 Ctrl+Shift+T、统一窗口、preload/主进程 IPC、打包依赖和本地服务启停。这不是安装器安装测试。

没有实际 SakuraFrp 隧道或异地选手，**未验证真实公网 WSS、两名异地选手完整实战、长时间公网稳定性以及 macOS/Linux 打包运行**。本次没有部署线上网页或发布安装包。上线前需发布新网页并按上述步骤完成真实环境验收。
