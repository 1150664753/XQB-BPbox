# 远程 BP 网络优化与验证（2026-10-12）

在现有 1.2.5 工作区上增量修改，保留开始任务前已有的 TURN 警告展示修改。BP 规则、操作消息、Manifest、SHA-256、分片 JSON 格式和房间恢复协议不变。本次未部署公网服务。

## 连接与线路

- 自动模式保留首次 P2P 协商，5 秒未连通时按需申请 TURN，不再必须等到 45 秒。强制 TURN 保留 `iceTransportPolicy: relay`。
- 只使用供应商实际返回的服务器。首次有 UDP 地址时先尝试 UDP，3 秒仍未连通或 ICE 明确失败时加入 TCP/TLS 并受控重启；只有 TCP 的响应直接使用 TCP。UDP 建连成功后恢复完整备用配置，不为此重启连接。
- 保留 15 秒短暂掉线宽限、最多两次 ICE restart、120 秒总恢复期限，保持同一个 PeerConnection 和 DataChannel。701 本身不会触发重启。
- 701 按服务器、协议、数字错误码和浏览器原因分类聚合，每组 30 秒最多输出一次，保留次数及首次/最近时间。原因区分 DNS、超时、不可达、鉴权及浏览器未提供具体原因；不输出不受控的原始错误文本。
- 统一请求域名仍为官方推荐的 `wtn.volcvideo.com`，区域域名仍可通过 `WTN_API_DOMAIN` 配置。调用发生在 Worker，全球就近接入不等于靠近双方玩家。记录 API 域名、返回 TURN 服务器和实际选中的路径，供后续比较；没有硬编码中继 IP，也没有未经跨网验证直接切到某地域。

自动 ICE 选择不保证数学意义上的最低 RTT。已有健康直连不会仅因 RTT 偏高而反复切换到 TURN。

## 资源与操作

- BP 控制消息直接发送，图片队列独立；图片遇到待发送控制数据或近期操作时让出发送机会。原独立资源 DataChannel 及旧端共享通道回退均保留，每次传输固定在开始时选择的通道。
- 现有原始分片为 11,520 字节，连同 Base64/JSON 约 16 KiB，继续保持。没有改分片协议。
- 原策略按绝对 RTT 将图片速率限制为 128/64/32 KiB/s；新策略从 128 KiB/s 起步，网络稳定时每秒增加 16 KiB/s，受用户配置上限约束（默认每选手 512 KiB/s）。RTT 相对本路径基线明显升高或缓冲堆积时按 0.7 倍降速，最低 16 KiB/s。路径变化后重置 RTT 基线。
- 不提供无限发送。速率按实际序列化字节计算，独立通道高水位 16 KiB，兼容通道先排空再发下一片；最多再提交一个小分片。监听 `bufferedamountlow` 和关闭事件，同时保留短轮询兜底。
- 只有未排出的资源缓冲连续 30 秒无进展才判定发送超时；等待正常 BP 操作或节流不作为网络超时。接收端按最近一个有效分片计时，30 秒无数据则丢弃半成品并进入既有重试流程。
- 发送超时 `ASSET_SEND_TIMEOUT`、网络断开 `ASSET_NETWORK_INTERRUPTED`、正常关闭/已被替换会话取消 `ASSET_CANCELLED`、接收超时 `ASSET_RECEIVE_TIMEOUT` 和各校验错误分别记录。房间关闭取消不再写成 `ASSET_SEND_FAILED`。

## 凭证生命周期

| 对象 | 有效期及行为 |
| --- | --- |
| 项目房主授权 | 原有 7 天，保持独立权限及撤销检查 |
| 调用 WTN API 的 JWT | 每次生成，有效期 300 秒，不是 TURN 访问 TTL |
| TURN 访问凭证请求 | 默认及部署配置改为 `TTL=14400` 秒；支持显式服务端配置 |
| 客户端到期显示 | 从服务端请求开始时间加实际响应 `ttl` 计算，网络请求耗时不会延长凭证 |

实际 TTL 不同于请求时记录请求值、实际值、配置值及原因：授权即将到期、配置覆盖，或“供应商未说明不一致原因”。合法的非 4 小时返回照实显示；非法 TTL 拒绝安装并记录数值。没有把 `expiresAt` 强行改成 4 小时。

中继连接在剩余有效期的 1/3（上限 90 秒）窗口内刷新。刷新拿到新凭证后才 ICE restart；供应商超时/拒绝且旧凭证尚有效时，保留当前连接并有限频率重试。短 TTL 的重试间隔取 30 秒与刷新窗口的较小值。正常刷新保留房间、BP revision、通道和正在接收的图片。授权被撤销或实际到期仍执行原有清除/恢复机制。

## 诊断与安全

- 保留最近 16 个连接、每连接 300 条事件，新增最近 50 个真实候选对、32 组聚合 ICE 错误、64 个资源传输记录及 100 个操作往返样本。
- 候选对用浏览器实际 pair/local/remote ID 标识，记录类型、协议及中继协议；同类型换服务器也记录路径变化。不导出选手 IP 或完整 candidate/SDP。
- 实际吞吐量使用 `getStats()` 字节差值。浏览器未提供 DataChannel 真正丢包率时明确为 `null/unavailable`，不能把 RTP 丢包或 STUN 检查误当成资源丢包。`sendDiscardRatio` 单独表示本地发送丢弃。
- 操作响应从选手发送 `ACTION_REQUEST` 到收到相同 `actionId` 的 `ACTION_RESULT`，用本机单调时钟测量，不依赖两端时间同步。网页底部增加“导出网络诊断”，可导出操作与接收验证结果。
- 资源记录进度、耗时及结束原因。`submitted` 表示发送端提交，`verified` 只在接收方完成 SHA-256 后出现，二者不混淆。
- 只导出经格式白名单过滤的无用户名/密码服务器地址和安全枚举；不导出 TURN username/password、Token、JWT、AppKey 或原始供应商响应。

## 修改文件

| 文件 | 本次修改 |
| --- | --- |
| `shared/remoteBpRtc.ts` | UDP/TCP 策略、提前中继、续期、701、路径与传输诊断 |
| `shared/remoteBpDiagnostics.ts` | 有界诊断数据、地址过滤及 schema v2 |
| `shared/remoteBpFlowControl.ts` | 自适应有界发送速率 |
| `XQB-BPbox/src/renderer/src/services/remoteBp/WebRtcRemoteHostTransport.ts` | 图片背压、控制优先、失败分类、重复凭证不重启 |
| `XQB-BPbox/src/renderer/src/components/remoteBp/RemoteBpNetworkDiagnostics.tsx` | 展示协议、TTL、原因和进度 |
| `XBQ-BPweb/src/services/WebRtcRemoteBpConnection.ts` | 操作往返、接收校验结果和取消诊断 |
| `XBQ-BPweb/src/services/assets/IncomingAssetTransfers.ts` | 接收无进展超时清理 |
| `XBQ-BPweb/src/pages/BpPage.tsx` | 选手端诊断导出 |
| `remote-bp-signaling/src/turn.mjs`、`turn.d.mts`、`wrangler.jsonc` | 14400 秒、实际 TTL、接入域名及返回服务器元数据 |
| `remote-bp-signaling/test/turn-self-check.mjs` | JWT/TTL 区分、实际 TTL 不一致、地域配置回归 |
| `XQB-BPbox/scripts/webrtc-self-check.cjs` | UDP 回退、抖动、续期失败、背压、超时及脱敏回归 |
| `XQB-BPbox/scripts/remote-network-browser-check.tsx` | Chromium 双向操作往返与资源完成诊断验证 |
| `docs/TURN_SETUP.md`、`REMOTE_BP_NETWORK_DIAGNOSTICS.md`、本文 | 配置、历史说明和验证记录 |

## 验证与范围

已运行并通过：桌面端与网页端 `npm run build`（包含类型检查）；信令 `npm run typecheck`、`npm test`、`npm run test:local`、`npm run test:turn`；桌面端 `test:webrtc`、`test:remote-bp`、`test:remote-images`、`test:remote-network`。

Chromium 实际双 PeerConnection 本机连接中，192 KiB 资源通过 SHA-256 校验；传输期间操作往返约 1 ms，重启 ICE 后图片继续完成，关闭可选资源通道后旧 JSON 控制通道回退成功。测试配置上限 64 KiB/s，每次资源传输约 4.4 秒（含 Base64/JSON 及调度）。诊断页面通过窄屏溢出检查及截图复核。本机结果不能代表公网性能。

WTN 凭证请求、权限、缓存和续期边界由真实 Worker/DO 模拟上游验证；UDP/TCP 配置、短暂抖动和刷新失败由假时钟/PeerConnection 回归验证。本次没有对两端真实异地网络进行新的火山 TURN 实测，不能声称实际线上 TTL 已变成 4 小时或 RTT 已降低。需要部署更新后的信令、桌面和网页版本，线上签发才会使用新配置；已经发出的凭证按旧到期时间失效。

现有约 363–658 ms 的公网 RTT 可能涉及地域、运营商绕路、NAT/防火墙、拥塞及 TURN 节点选择。上述代码减少排队和建连等待，不能消除物理距离或运营商路径。应在比赛双方实际网络上比较自动/强制 TURN，结合导出的 API 域名、返回服务器、真实 relayProtocol 和候选对选择地域；不以页面显示“已授权”代替中继成功证明。

依据：[火山引擎 TURN 信息接口](https://docs.volcengine.com/docs/WebRTCtransportnetwork/GetTURNserviceinformation?lang=zh)、[接口请求域名](https://docs.volcengine.com/docs/WebRTCtransportnetwork/Requestdomainname?lang=zh)、[接口鉴权](https://docs.volcengine.com/docs/WebRTCtransportnetwork/Interfaceauthentication?lang=zh)、[W3C WebRTC 统计](https://www.w3.org/TR/webrtc-stats/)。
