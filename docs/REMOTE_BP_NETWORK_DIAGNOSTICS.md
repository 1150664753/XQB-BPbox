# 远程 BP 网络排查与验证（2026-10-11）

本次在当前 1.2.5 工作区基础上检查并修改连接、资源传输和诊断。应用版本和 BP 业务协议版本不变；没有在本次任务中部署公网服务。结论来自代码审查、受控回归和真实 Chromium 本机连接，不能替代家庭网络、校园网、热点及真实 WTN 的实测。

## 已定位的问题

| 代码证据 | 影响及处理 |
| --- | --- |
| 图片与 BP 消息共用有序 DataChannel | 图片排队和重传可能拖慢操作。增加可选的独立图片通道；仍共享同一个 SCTP 传输，所以同时做联合背压、速率控制及操作期间短暂停图。 |
| 现有分片已经是 11,520 字节，并非旧文档中的 128 KiB | 保留小分片，常规消息含 Base64 和 JSON 后低于约 16 KiB；此次重点处理队列、带宽和缓存，不再单纯缩短分片。 |
| 同一 PeerConnection 的恢复回调会 reset 图片接收器 | ICE Restart 后丢掉 Manifest/未完成分片。只在真正更换连接时清理，异步校验结果用会话代次隔离。 |
| 选手连接成功后直接标记 p2p；候选收集完成事件被忽略 | UI 无法反映实际 relay，远端也收不到收集结束标记。改用 getStats 选中路径；发送协议原本就接受的空 candidate，按轮次缓存、去重和应用。 |
| WebSocket 收件串行队列会 await 异步 RTC 协商 | 等待 TURN 响应的协商可能阻塞同一收件链。RTC 自行串行处理 SDP/候选，WebSocket 收件链保持可处理凭证与心跳。 |
| 强制模式只在开发环境切换，缺少凭证仍可能使用 all | 增加正式界面开关。强制模式从 PC 创建起就是 relay，等待授权及凭证后发 Offer；缺失凭证明确 TURN_REQUIRED。 |
| ICE 连通后，后续统一以 DataChannel 超时失败 | 拆分 SDP、ICE、DTLS、SCTP、DataChannel 错误，执行有上限的恢复。20 秒阶段时限、45 秒协商时限、120 秒总时限未延长。 |
| 固定 90 秒刷新窗口不适合短 TTL；闲置凭证过期也重启直连 | 窗口随 TTL 调整，使用中继/强制模式才主动刷新；健康直连不受闲置凭证过期影响。 |
| 只有内存缓存；重复 Manifest 重建 URL；新会话较低 revision 被拒绝 | 增加 IndexedDB；持久命中重新计算 SHA-256。相同内容保留 URL，新 PC 重置 Manifest 代次，恢复中断请求，房主合并同一资源的在途重复请求。 |

WTN 控制台没有记录的原因仍不能仅靠代码下定论：默认先直连，只有需要恢复时才领取中继凭证；成功直连可以完全没有 TURN 请求。领取到凭证也不证明实际使用了中继。应分别检查凭证结果、选中 pair 的 relay 类型、DataChannel open 和字节增长。

## 连接和诊断

- 每秒采集一次 `getStats()`，优先使用 `transport.selectedCandidatePairId`；缺失时只接受唯一 succeeded/nominated pair，不猜测多个候选中哪一个在用。
- 显示两端 host/srflx/prflx/relay、candidate 协议及实际可得的 relayProtocol（UDP/TCP/TLS）、RTT、路径收发字节和差分速率。远端 relayProtocol 经常不可得，显示“未提供”，不能根据凭证 URL 反推。
- “凭证支持协议”只说明服务器提供了哪些地址，不等于已使用的协议。`protocol=udp` 与 `relayProtocol=tls` 可以同时出现：它们描述不同链路。
- 记录 signalingState、iceGatheringState、iceConnectionState、connectionState、DTLS、SCTP、控制/图片 DC 状态；首次到达 SDP/ICE/DTLS/SCTP/DC 的耗时均以创建该 PC 为零点。导出事件含时间、协商代次和状态，可重建后续各轮过程。
- 候选计数区分生成、发送（含重放/结束标记）、接收（去重后）、应用、重复、拒绝和本轮双方结束标记，因此生成与发送不一定相等。
- transient disconnected 保留 15 秒宽限；failed 或阶段超时触发受控 ICE Restart。单次持续恢复最多 2 次、总计 120 秒；成功后重置恢复预算，诊断保留本端累计重启请求数。房主唯一发 Offer，避免双方冲突。
- TURN 凭证通过服务端认证下发。普通模式 PC 起初只有 STUN，在恢复时安装临时 TURN 后再创建 restart Offer。强制模式可先创建 relay-only PC，但必须等异步授权和有效凭证后才发出首次 Offer。
- 刷新提前量为安装时剩余 TTL 的 1/3，最多 90 秒；保持原 PC 和 DataChannel 重新协商。无权限或刷新失败不无限重连。
- 错误例子：`SDP_SIGNALING_TIMEOUT`、`SDP_NEGOTIATION_FAILED`、`ICE_TIMEOUT`、`ICE_FAILED`、`DTLS_TIMEOUT`、`DTLS_FAILED`、`SCTP_TIMEOUT`、`DATA_CHANNEL_TIMEOUT`、`TURN_REQUEST_TIMEOUT`、`TURN_PROVIDER_INVALID`、`ASSET_SEND_FAILED`。

诊断保留最近 16 个连接，每连接最多 300 条事件；导出包含房间/连接/选手会话 ID，不包含 IP、SDP、完整 candidate、ICE URL、AppKey、JWT、授权 Token 或 TURN 用户名/密码。服务端 `[WTN TURN]` 只记录安全错误码、HTTP/业务数字状态、缓存/上游来源、耗时、到期时间和协议种类。

## 数据传输与兼容

新的选手在原控制通道打开后，创建 `xqb-remote-bp-assets-v1` 图片通道。新房主接受；旧房主关闭未知通道，继续走原 `xqb-remote-bp`。新房主不会主动向旧选手开额外通道。每个资源从 ASSET_START 到 COMPLETE 固定在同一条通道上，避免中途新通道打开造成跨流乱序。通道中断后丢弃该资源的半成品，最多自动重试两次。

BP 消息直接进入控制通道，不排在应用层图片发送队列后；ACTION_REQUEST/回执/状态同步给图片发送留出短暂停顿。两个通道共享 SCTP 拥塞，不能保证丢包网络下完全消除延迟。图片发送联合检查两条通道的 bufferedAmount：通常 32 KiB，高 RTT 降为 8 KiB（单条小消息可能使缓冲暂时超过阈值）。15 秒没有缓冲排空进展就中止资源发送。

房间创建前可设置图片发送上限，默认每选手 512 KiB/s；按实际 JSON 字节节流，RTT 超过 250/500/1000 ms 时进一步限制到 128/64/32 KiB/s。图片通道实测速率来自浏览器 data-channel 统计；兼容通道无法区分 BP 与图片字节，缺失时显示“—”。路径速率包含传输开销，资源进度按原始内容字节累计。“已提交”不代表选手已收到并完成哈希校验。

持久缓存和内存缓存分别限制 256 项、128 MiB，按写入顺序淘汰旧资源；IndexedDB 不可用或配额不足时退回内存。缓存按 assetId/hash 查询，使用前还匹配完整 Manifest 元数据，磁盘命中重新验 SHA-256。保留原有 MIME/大小/分片序号/总数/最终哈希验证、资源白名单与 BP 操作权限/revision 校验。

## 三类网络实测步骤

1. 两端使用包含本次修改的版本。先用默认模式，在家庭网络、校园网、热点各建立房间，展开 BPbox 远程连接区域的“网络诊断”。
2. 记录选中路径和协议；载入图片时连续切换角色并确认，观察 RTT、缓冲、实际速率和错误。刷新选手页再次加载，确认已缓存资源不重复发送。每次用“导出诊断日志”保存 JSON，并在文件名注明网络与普通/强制模式。
3. 关闭房间，在建房前勾选“强制 TURN 测试”，完成现有房主授权后重新建房。成功标准：凭证 ready、pair 至少一端 relay、DC open、传图/操作时 bytes 增长、状态与图片正确。无授权时应明确失败，不应出现“直连成功”。
4. 测试临时断网少于 15 秒、超过 15 秒及网络切换，核对恢复代次/重启次数、完整资源及操作状态。保持连接超过一次真实 TTL，验证凭证更新与协商后仍能操作。
5. 在服务端日志区分无请求、授权失败、WTN HTTP/业务错误、成功领取和缓存命中，再与 pair/bytes 对照。WTN 控制台具体账单/请求可见性需以实际账号、产品和统计范围核实，不能用“没有记录”直接认定未中继。
6. 测试结束关闭房间、取消强制开关。若使用 `VITE_REMOTE_BP_TEST_FORCE_RELAY=1` 构建，测试后移除变量并重新构建。

## 修改文件与验证

| 文件 | 作用 |
| --- | --- |
| `shared/remoteBpRtc.ts`、`shared/remoteBpDiagnostics.ts` | 生命周期、候选、刷新、分层诊断、getStats、可选通道及脱敏导出 |
| `XQB-BPbox/src/renderer/src/services/remoteBp/WebRtcRemoteHostTransport.ts`、`createRemoteHostTransport.ts` | 异步凭证时序、发送队列/节流/背压、配置 |
| `XQB-BPbox/src/shared/remoteBp/host.ts`、`transport.ts` | 在途资源合并、旧任务隔离及设置接口 |
| `XQB-BPbox/src/renderer/src/components/remoteBp/RemoteBpNetworkDiagnostics.tsx`、`RemoteBpPanel.tsx`、`styles/remote-bp.css` | 可展开网络诊断、日志导出、测试开关 |
| `XBQ-BPweb/src/services/WebRtcRemoteBpConnection.ts`、`createRemoteBpConnection.ts`、`types/connection.ts` | 实际路径、资源通道接收、同 PC 恢复、新连接隔离 |
| `XBQ-BPweb/src/services/assets/{AssetCache,MemoryAssetCache,IndexedDbAssetCache,RemoteAssetManager}.ts`、`src/App.tsx` | 持久校验缓存、Manifest 复用及重试 |
| `remote-bp-signaling/src/turn.mjs` | WTN 凭证领取的安全诊断日志 |
| `XQB-BPbox/scripts/webrtc-self-check.cjs`、`remote-network-{self-check.cjs,browser-check.tsx}`、`package.json` | 受控时序测试、真实 Chromium/IndexedDB/界面测试 |

已完成的检查：

- BPbox、选手 Web：`npm run build`（含类型检查）。
- BPbox：`npm run test:remote-bp`，覆盖业务权限、序列化、资源校验、房主流程和延迟操作/确认。
- BPbox：`npm run test:webrtc`，覆盖候选乱序/去重/结束标记、信令恢复、各层超时、重启限额、统计脱敏、凭证刷新及异步授权、图片流固定与中断。
- BPbox：`npm run test:remote-network`，实际 Electron/Chromium 双 PC 回环、192 KiB 分片完整性、图片传输中控制消息先到、ICE Restart 后继续接收、原通道兼容回退、真实 IndexedDB 重新打开/损坏内容拒绝、Manifest 会话切换、窄屏诊断截图和 JSON 导出。测试产物在 `.tmp/remote-network-test/`。
- 信令服务：`npm run test:turn`，真实本地 workerd/Durable Object，WTN 上游 Mock；验证身份、授权/撤销、持久化、缓存、限流、凭证格式和 TTL。

本机回环不能证明公网 RTT、吞吐、真实 WTN UDP/TCP/TLS 可达性或控制台计费情况。本次未进行付费上游请求，也未声称上述外网验证完成。

实现依据：[W3C WebRTC 统计定义](https://www.w3.org/TR/webrtc-stats/)、[W3C WebRTC API](https://www.w3.org/TR/webrtc/)、[火山引擎获取 TURN 信息](https://docs.volcengine.com/docs/WebRTCtransportnetwork/GetTURNserviceinformation?lang=zh)。
