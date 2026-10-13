**XQB-BPbox / Web 选手端 / 信令 Worker：WTN TURN 审计报告**

审计日期：2026-10-13（Asia/Shanghai）。已完成本地代码修复、构建和回归；没有部署 Worker、网页或安装包，没有修改任何 AppID，也没有调用真实 WTN 领取凭证。真实 WTN 中继、跨网性能和控制台用量均为 **待实测**。

| 必须回答的问题 | 结论及证据边界 |
| --- | --- |
| 当前实际使用的 AppID 是什么？ | 当前仓库部署默认值是 `6ac735fb7305ab038c2e3546`，位于 `remote-bp-signaling/wrangler.jsonc:7`。实际请求读取运行环境的 `env.WTN_APP_ID`。当前线上 Worker 的绑定值尚未取得，不能把仓库值当作线上证明。 |
| 获取 TURN 凭证的流程是否正确？ | 请求方法、路径、JWT 签名和字段、HTTP/业务状态检查基本正确。已修复旧缓存未绑定应用配置、部分无效 TURN 项被静默丢弃、错误诊断缺失等问题。真实 AppKey 是否属于生效 AppID、TURN 是否开通，待实测。 |
| 凭证有没有应用到 WebRTC？ | 有。双方 `TURN_CREDENTIALS → applyTurn → 当前 pc.setConfiguration`；房主初次强制模式等待安装后才发 Offer，后续安装/刷新经 ICE restart 生效。Web 端在 Offer 前安装；强制模式缺少有效凭证时不创建 Answer。 |
| 能否证明数据实际经过 TURN？ | 不能证明生产流量。原有程序已有 selected-pair 统计，但没有提供本次真实 WTN 运行记录。本次真实 Chromium 连接证明的是本机 `host / host` 直连。模拟的 relay 测试只证明判断逻辑。 |
| 强制 TURN 是否可能仍然直连？ | 修复前房主 PC 在开关生效时一直是 `relay`，未发现把该 PC 偷改成 `all` 的代码；不能仅凭 Web 端为 `all` 就断言整个连接直连。但原来没有同步双方策略、也未以实际 relay 路径约束“成功”。修复后双方使用 `relay`，每轮 SDP 确认策略，实际选中双方 relay 才报告成功；直连、凭证缺失、路径无法验证均失败。 |
| 延迟高、图片慢、控制台无用量的原因？ | **待实测**。现有证据不足以归因于错误 AppID 或未走 TURN。自动模式优先直连、Worker 请求所在地域与客户端地域可能不同、实际 UDP/TCP/TLS 路径、图片限速与拥塞均应结合导出数据判断。 |

**AppID 与配置来源**

本次检索了当前工作区源码、隐藏配置、被忽略的环境文件名、可读文本构建配置/产物，以及当前进程、Windows User/Machine 范围内的相关非敏感环境变量。排除依赖、Git 内部数据、测试临时产物和二进制安装包；没有读取用户电脑上已安装程序的内部打包资源，也没有证明所有历史 Git 提交。

- 修改前，两个指定 ID 的命中仅有 `6ac735fb7305ab038c2e3546`，出现在 Worker 配置及部署说明。`6acc325c04af58016706ed10` 在当前检索范围内未命中。生成的 `worker-configuration.d.ts` 也反映前者，但类型声明不决定线上绑定。
- 没有发现实际 `.env` / `.dev.vars` 文件，只有三个 `.env.example`。检查的 AppID、域名、TTL、信令地址和强制模式环境变量，在当前 Process/User/Machine 范围未设置。这不代表云端没有设置。
- [Worker 请求和签名](../remote-bp-signaling/src/turn.mjs#L127) 同时使用 `env.WTN_APP_ID`，签名密钥为 `env.WTN_APP_KEY`。没有从桌面存储或 Web 配置读取另一个 AppID。房主授权使用项目自己的 `TURN_AUTH_SIGNING_KEY`，与 WTN JWT 分开；本机安全存储保存的是项目授权，不是 WTN AppID/AppKey。
- [桌面配置](../XQB-BPbox/src/renderer/src/config/remoteBp.ts#L1) 默认连接 `wss://signal.xqbbp.dpdns.org`；[Web 配置](../XBQ-BPweb/src/config/runtime.ts#L1) 的开发默认值为 `ws://localhost:8787`，生产默认值相同。两端均可由构建时 `VITE_REMOTE_BP_SIGNALING_URL` 改变。开发时不统一该地址，可能连接不同服务；不同 Worker 部署/绑定也可能使用不同 AppID。
- `remote-bp-signaling/src/server.mjs` 本地 Node 服务读取 `options.turnEnvironment ?? process.env`，不会自动读取 `wrangler.jsonc`；普通启动也不会自动加载 `.env`。其旧密码入口禁用，不能把 Node 信令自测成功当作生产 TURN 可用。
- 尝试用 Wrangler 只读查询部署版本时，本机缺少可用 Cloudflare API 登录凭据，未取得线上绑定。新代码在房间握手和凭证结果中返回安全摘要；部署后以双方导出的 `turnAppId` 和 Worker 请求日志确认生效值。`turnAppIdSource=env.WTN_APP_ID` 指最终运行时读取点，不能区分该绑定最初由控制台还是 Wrangler 写入。
- 修复前持久化凭证缓存仅按选手连接与到期时间命中，部署变更 AppID/AppKey/域名/TTL 后可能仍发旧缓存。现已用上述配置的内部摘要隔离缓存；摘要及密钥均不发往客户端、不记日志。旧版无摘要缓存会重新请求。

**官方规范核对**

已阅读官方 [TURN 接入](https://docs.volcengine.com/docs/WebRTCtransportnetwork/UseTURNservicetoimprovetheconnectionrateofP2Pcalls?lang=zh)、[获取 TURN 信息](https://docs.volcengine.com/docs/WebRTCtransportnetwork/GetTURNserviceinformation?lang=zh)、[接口鉴权](https://docs.volcengine.com/docs/WebRTCtransportnetwork/Interfaceauthentication?lang=zh)。

实现使用 `GET https://{domain}/turn/{AppID}`，带大写 `TTL`、可选排查用 `SessionID` 和 `Authorization: Bearer …`。JWT 为 HS256，使用 AppKey 对 base64url 编码的 header/payload 签名；payload 仅含 `version: "1.0"`、`appID`、秒级 `exp`。API JWT 有效期 300 秒；请求 TURN 访问 TTL 默认 14400 秒；项目房主授权为 7 天，三者没有混用。[请求实现](../remote-bp-signaling/src/turn.mjs#L127)

HTTP 非成功、JSON 无效、`code !== 200`、TTL 不合法、无有效 TURN 均失败。HTTP 与业务码分别保存，不记录提供商原始 message/body。401/403/404 提示检查应用/鉴权/开通；业务错误保留原始数字码，不在没有证据时猜测究竟是 JWT 过期、未开通还是 AppKey 错配。请求有 6 秒超时，禁止跟随跳转，避免 Authorization 泄漏。

`ice_servers` 的 TURN/TURNS URL、username、credential 均保留，兼容单 URL 和 URL 数组；按官方建议不采用返回的 STUN 项。无效 TURN 项现在导致明确失败，不再“仅保留一部分成功项”。TTL 以实际返回值计算，从请求开始时间保守计时；本项目接受 60～86400 秒。官方文档的默认 TTL 与最大返回 TTL 描述并不一致，本项目明确请求 14400 秒并记录实际值，不依赖默认值。

**连接行为与确定修复**

1. **双方强制策略不一致**：房间保存 `forceRelay`，在创建、加入、恢复时传递；PEER_READY 和每轮 OFFER/ANSWER 都保留该字段。Web 创建 PC 时继承房间策略，Web 本地强制设置也会经 readiness 通知房主。[Worker](../remote-bp-signaling/src/index.ts#L604)、[房主](../XQB-BPbox/src/renderer/src/services/remoteBp/WebRtcRemoteHostTransport.ts#L617)、[Web](../XBQ-BPweb/src/services/WebRtcRemoteBpConnection.ts#L262)
2. **连接成功缺少中继证明**：强制模式在原有 ICE/DTLS/SCTP/DataChannel 就绪条件外，要求本轮 `getStats()` 选中 `relay / relay`，同时读取 PC 实际配置确认 `relay`。只有候选列表出现 relay、配置写入 relay 或 DataChannel open 都不够。对端不确认策略报 `TURN_POLICY_UNCONFIRMED`；直连报 `TURN_PATH_NOT_RELAY`；就绪后 20 秒无法获得路径证据报 `TURN_PATH_UNVERIFIED`。缺少/撤销/过期凭证明确关闭，不能回退直连。[共享 RTC](../shared/remoteBpRtc.ts#L1325)
3. **选中路径证据与恢复**：优先 `transport.selectedCandidatePairId`；没有 transport 指针时，只允许唯一 succeeded/nominated pair 作为带来源标记的兼容判断；多个指针或候选不猜测。只接受 succeeded pair。每轮重置验证，忽略跨轮异步统计结果；候选对 ID、类型、协议、URL、协商代次的变化写入历史。统计过期或不可用不能维持强制模式的成功状态。[统计采集](../shared/remoteBpRtc.ts#L628)
4. **缓存和重复凭证安装**：服务端缓存绑定配置；客户端不再只凭相同 `expiresAt` 忽略更新。相同到期但不同 URL/凭证会安装；重复缓存响应恢复“凭证就绪”状态；配置成功后才更新内部凭证状态。
5. **失败信息只在部分位置可见**：增加安全 AppID/来源、HTTP/业务码、TTL、provider/cache/none 来源。房间未请求 TURN 时也有配置摘要。上游请求失败同时通知当前双方连接，旧连接 ID 不污染新连接。普通模式仍允许继续 P2P；有效旧凭证的刷新失败保留原连接，直到到期。
6. **文档与实际代码冲突**：修正 `.env.example` 中“可直接添加 TURN”的注释，修正部署文档中“生产固定 all”和只需房主配置的旧说明。

保留了现有房间、BP 消息和图片传输协议。自动模式仍先 STUN/P2P；5 秒未连通后按需取 TURN 并重启 ICE，策略为 `all`。首次 TURN 安装保留原有 3 秒 UDP 优先尝试，随后恢复完整 TCP/TLS 候选；配置更新与 restart 均作用于同一 PC。此策略是否最适合双方网络，待实测，不因控制台无用量就更换地域或 AppID。

图片流仍受现有自适应发送限速控制：初始约 128 KiB/s，默认上限 512 KiB/s，拥塞时降低，并与控制消息共享 SCTP 带宽。慢传输不等于没走 TURN；本次未在没有跨网吞吐数据时更改限速算法。

**导出证据的含义**

| 阶段 | 字段/检查 | 不能据此宣称的内容 |
| --- | --- | --- |
| 凭证获取成功 | `turnRequests[].result=ok`、`httpStatus=200`、`providerCode=200`、实际 TTL | 尚不能证明已收集或选中 relay |
| 已安装到 PC | `turnConfigured=true`、`iceTransportPolicy` | 尚不能证明中继承载流量 |
| relay 候选收集 | `candidates.localRelay`、`candidates.remoteRelay`（连接生命周期累计） | 尚不能证明此候选被使用 |
| 实际经过 TURN | `selectedPair` 的 localType 或 remoteType 为 relay，`turnUsage=relay` | 还需流量增量证明测试数据在该路径上传输 |
| 强制模式验证成功 | 双方 `forceRelay=true`、实际 policy=relay、本轮双方候选均 relay、`relayVerified=true` | 模拟统计不是实际 WTN 网络证据 |
| 当前没有经过 TURN | 完整选中路径已知且双方都不是 relay，`turnUsage=direct` | 未选中或统计缺失时必须标 unknown |

诊断 schema 升为 3。保留每个连接最近 300 条事件、300 次流量采样、50 次凭证请求、50 条路径变化，最多 16 个连接。`trafficSamples` 包含时间、协商代次、pairId、RTT、字节累计及增量；切换 pair 或计数倒退时增量为 null，不造负速率。统计使用 candidate-pair 字节，含传输开销，不应直接等同图片文件大小或账单字节。`pairHistory` 包含本地/远端 protocol、relayProtocol 和可用的无凭证 server URL；浏览器未提供的字段保持 null。`restartCount` 是本端发起次数，远端发起的重启也可从 negotiationId 和事件看到。

BPbox 网络诊断面板与 Web “导出网络诊断”使用同一共享采集器。Web 加入页也补充了导出入口，首次连接失败时无需进入 BP 页面即可导出；失败后不要刷新页面，以免丢失内存中的日志。连接销毁会清除 relayVerified，历史路径和采样仍保留。日志不含 AppKey、Bearer Token、TURN username/credential、SDP、原始 candidate 或选手地址。只允许安全 ICE 服务器端点、有限字段及数字状态；Worker 的凭证响应本身必须包含临时凭证供 PC 使用，不应当作日志公开。

**已执行验证**

| 检查 | 结果 | 证明范围 |
| --- | --- | --- |
| BPbox `npm run test:webrtc` | 通过 | 假时钟/PC：房间策略继承与重建、强制缺凭证、直连拒绝、只有候选不能证明、未知路径超时、双方 relay 成功、restart 重新验证、相同到期更新、凭证脱敏、正常自动模式和刷新 |
| Worker `npm run test:turn` | 通过 | 真实 workerd/DO + 模拟 WTN：JWT HMAC、路径 AppID 与 JWT 一致、配置变更缓存失效、HTTP/业务码、TTL、无效 ICE、权限/撤销/限流/持久化。全部使用合成密钥和 `.test` 上游 |
| Worker `npm test` / `npm run test:local` | 通过 | Worker/Node 房间、重连、踢人、心跳；强制策略在房间恢复与信令转发中保留 |
| BPbox `npm run test:remote-network` | 通过 | 真实 Electron Chromium，本机 WebRTC 图片完整性、传输期间操作往返、ICE restart 后继续传输、诊断显示和导出 |
| BPbox `npm run test:remote-images` | 通过 | 图片压缩/透明度处理回归 |
| BPbox / Web `npm run build` | 通过 | TypeScript 与生产构建；没有生成或发布新安装包 |
| Worker `npm run typecheck`；`git diff --check` | 通过 | 类型和改动格式 |

本机 Chromium 最终双方选中 `host / host`、UDP，来源 `transport`；房主发送 541636 B、接收 12368 B，对端相反，最终 RTT 约 0～1 ms。图片内容经过接收端校验，传输期间操作往返约 1 ms。**这是本机直连结果，不是 WTN 性能数字。** 产物：[诊断 JSON](evidence/wtn-turn-audit-2026-10-13/diagnostics.json)、[界面截图](evidence/wtn-turn-audit-2026-10-13/diagnostics.png)。

**真实网络验收步骤（全部待实测）**

先同步更新测试 Worker、BPbox 和 Web 端，确认双方连接同一信令服务。旧版信令会丢弃策略字段，因此与新端混用时强制测试会明确失败。准备两台不同网络的设备（例如家庭宽带和手机热点），记录各端应用版本、网络类型、测试起止时间及图片总大小。保留控制台 AppID 筛选值和相同时间范围。

1. **普通模式**：关闭房间后取消“强制 TURN 测试”，建新房并让 Web 加入；先空闲 5 秒，再传一张未缓存图片。两端导出，按同一 roomId/connectionId 核对 `turnAppId`、实际 `all`、selectedPair 来源/类型以及字节增长。直连时应显示 direct；本来无需请求 TURN 时 `turn=not-requested` 是正常结果，不能要求控制台出现中继用量。
2. **强制 TURN**：在桌面 Ctrl+Shift+T 完成房主授权；建房前勾选强制选项，Web 不需要另设构建变量。双方均应为 `relay`，请求成功并有有效 TTL，最终本轮候选为 `relay / relay`、`relayVerified=true`。如果候选存在但没有选中，记录失败而非成功。可在 Chrome `chrome://webrtc-internals` / Edge `edge://webrtc-internals` 对照同一 PC 的 transport 指针；不外发原始含凭证转储。
3. **负向缺凭证**：在隔离的测试环境移除 WTN AppKey，或使用未授权的新房间，保留强制开关；应出现 `TURN_NOT_CONFIGURED` / `TURN_NOT_AUTHORIZED` / `TURN_REQUIRED`，不建立 BP 数据连接。也可连接后撤销房主授权验证立即停止。不要为了此测试删除生产密钥。另在测试网络阻断返回 TURN 端口，验证无可用 relay 时有界失败，不回退 direct。
4. **TURN 图片传输**：强制连接成功后空闲采样 5 秒，记录基线，再传输多张新图片或修改图片 hash 以避开缓存；立即分别导出。确认传输时间段内 pairId 与 relay 类型保持一致，房主 bytesSent/选手 bytesReceived 持续增长，记录 RTT、发送速率和 `transfers` 状态（发送端 submitted 不等于接收端 verified）。按相同文件大小、限速上限和网络重复普通/强制测试；URL、relayProtocol 缺失写未提供。比较实际 TLS/TCP/UDP、RTT 和限速后再讨论优化。
5. **断线重连与 ICE restart**：先断网约 5 秒恢复，检查短暂抖动不无谓重启；再断网约 20 秒恢复，观察 ICE restart 事件/新 negotiationId。之后刷新 Web 页面以重建 PC。每次恢复都核对双方 policy=relay、重新验证后的 relay/relay 和图片字节增长。长时间会话还需跨一个真实返回 TTL 验证提前刷新、重新安装及 restart；失败时不能凭旧的 relayVerified 或旧流量样本判为成功。
6. **确认账号/AppID 与控制台**：以新导出及 Worker 日志中的 AppID 为准，进入对应应用和准确时间范围核对用量。若已有双方 selected relay + 持续实际字节增长而控制台仍无记录，将 AppID、测试时间、SessionID/连接标识、无凭证服务端点及统计摘要交给 WTN 支持核查计量范围/展示问题。现阶段没有证据指定某个计费延迟或某个 AppID 是正确替代值。

**修改文件**

- 连接与诊断：`shared/remoteBpRtc.ts`、`shared/remoteBpDiagnostics.ts`。
- 双端适配与显示：`XQB-BPbox/src/renderer/src/services/remoteBp/WebRtcRemoteHostTransport.ts`、`XQB-BPbox/src/renderer/src/components/remoteBp/RemoteBpNetworkDiagnostics.tsx`、`XBQ-BPweb/src/services/WebRtcRemoteBpConnection.ts`、`XBQ-BPweb/src/pages/JoinPage.tsx`。
- 信令与提供商：`remote-bp-signaling/src/index.ts`、`server.mjs`、`turn.mjs`、`turn.d.mts`。
- 回归：`XQB-BPbox/scripts/webrtc-self-check.cjs`、`remote-network-browser-check.tsx`，`remote-bp-signaling/test/turn-self-check.mjs`、`signaling-worker-self-check.mjs`、`signaling-self-check.mjs`。
- 配置说明：双方 `.env.example`、`docs/TURN_SETUP.md` 及本报告。`wrangler.jsonc` 的 AppID、域名、TTL 均未修改。
