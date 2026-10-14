**远程 BP 网络优化与复测记录 — 2026-10-14**

> 历史审计记录。网络监测和强制 TURN 设置已于 2026-10-14 移除；当前连接行为及验收以 [P2P 优先与 5 秒 TURN 兜底](REMOTE_BP_CONNECTION_POLICY.md) 为准。

本轮基于用户提供的真实 TURN 日志定位问题，在现有 PeerConnection、可靠有序 DataChannel 和 JSON 分片协议上修复。AppID `6ac735fb7305ab038c2e3546`、凭证接口、鉴权、14400 秒 TTL、默认请求域名均未修改。本轮本地构建与回归完成；优化后的校园网/热点 WTN 性能及后台统计仍待实测。

**原始证据与根因**

读取的文件为 `remote-bp-network-2026-10-13T12-56-05-791Z.json`，SHA-256：`f728cb16adbd897d6db4f212de69c5ca877a8c7824c42527e94d563c7ed88d0a`。文件包含两条房主侧记录，未包含选手侧记录；未把用户原始日志复制到仓库。

| 证据 | 判断 |
| --- | --- |
| 两条连接最后选中 `relay / relay`，来源 `transport.selectedCandidatePairId`，本地 `relayProtocol=udp`，对端候选 `protocol=udp` | 确实选择了中继。对端 `relayProtocol` 未提供，不能单凭房主日志证明选手到 TURN 也使用 UDP；需要对端导出。 |
| 本地节点分别为 `turn:84.17.44.9:50009?transport=udp`、`turn:84.17.44.51:50009?transport=udp`，均在本次下发的服务器集合中 | 中继路径与下发配置对应；不能由此证明后台已计量计费，也不能凭 IP 猜测机房地域。 |
| RTT 范围分别为 404–499ms、398–558ms；重启次数均为 0 | 这是 ICE 路径 RTT，不是 BP 操作响应时间。未发现实际 ICE 断线。 |
| DataChannel 首次打开 6683ms、5541ms；SDP 分别已耗时 4411ms、1733ms | 建联包含信令/凭证、ICE、DTLS/SCTP 各阶段与数次网络往返，没有证据将全部耗时归因于资源发送。 |
| 304160B、292517B 的提交耗时 76861ms、63973ms；3057B、2985B 小资源分别耗时 10193ms、18645ms | 约 3.9–4.5KiB/s 的提交速度明显低于配置限速，但 submitted 只是排入浏览器，不是接收成功。旧日志缺少等待分项，不能精确分摊全部耗时。 |
| 184/88 个采样中，41/20 个没有选中 pair；记录中有 33/14 次 connecting，期间底层保持 connected/open | 已确认：一次缺失采样就让状态机降为 connecting；Web 端恢复回调再次请求状态。诊断采样问题由此影响业务状态和控制流量。日志未保存原始 stats，无法确认每次缺失是 pair 状态变化、缺字段还是 getStats 异常。 |
| 导出时两条连接 `phase=closed`，最后路径仍为 relay/relay，但 relayVerified=false | 已确认：旧 dispose 清掉布尔值、保留路径，造成历史证据语义不一致；不是“运行期间始终未验证成功”的证据。 |
| 原发送器以缓冲 >16KiB 或 250ms 无下降触发降速 | 已确认代码问题：高 RTT 下正常待发送数据也会被当作拥塞，反复乘 0.7 降到 16KiB/s。 |
| 主窗口默认开启 Electron 后台节流，发送器每帧用 25ms 定时器轮询 | 存在明确风险：最小化时短等待可能变为很长的等待。日志多次出现近整秒停顿，与之相符，但缺少窗口可见性记录，不能确认该次测试中的具体占比。[Electron 文档](https://www.electronjs.org/docs/latest/api/browser-window#new-browserwindowoptions) |

**具体修改**

- [流控](../shared/remoteBpFlowControl.ts)：保留 AIMD 自适应与用户上限；用 RTT 和速率计算 32–128KiB 的有界缓冲窗口；只有持续 RTT 膨胀/队列积压或至少 max(1500ms, 3×RTT) 无进展才退让。仍保留 16KiB/s 下限和 30 秒无进展失败，不把正常 500ms 往返直接当作拥塞。
- [房主发送器](../XQB-BPbox/src/renderer/src/services/remoteBp/WebRtcRemoteHostTransport.ts)：补偿定时器/排空等待造成的调度偏差，最多保留一帧 16KiB 的发送额度；小 START/COMPLETE 不再固定追加 25ms 轮询粒度。两个选手独立队列；控制/心跳继续直接发送、绕过资源队列。兼容旧端共用控制通道时仍最多放一小帧。增加队列、缓冲、控制让行、限速等待的分别计时。
- [主窗口](../XQB-BPbox/src/main/windows.ts)：关闭承载远程 BP 的主窗口后台定时器节流，避免最小化使网络调度变慢。其他权限不变；代价是该窗口在后台仍运行计时器和渲染。
- [共享 RTC](../shared/remoteBpRtc.ts)：优先使用 transport 的实际选中 pair；连接正常且权威 pair 为 in-progress 时允许记录，其余仍要求 succeeded；单一 nominated 仅作兼容回退。不能确定时保留带时效标记的上次证据，不猜路径。短暂缺失不触发重复 connected 回调；强制模式首次仍须真实双方 relay，持续 20 秒无法核实仍失败，真实直连证据仍立即失败，重启仍重新核实。
- `relayVerified` 表示上次实际观测到中继；新增 `relayVerifiedAt` 和 `statsStatus=current/stale/unavailable/closed`。关闭后保留历史证据，界面明确“上次观测”。普通模式任一端 relay 就代表使用 TURN；强制双方模式仍单独核对两端 candidateType 和实际 policy。
- ICE 701 等收集错误保留服务器、代码、计数与原因，另记发生时连接是否健康、是否与当前选中 URL 相同，不再覆盖连接级错误。相同 URL 的某个探测失败也不等于当前路径失效；真实 ICE/DTLS 失败仍触发原恢复流程。701 的含义按 [W3C ICE 错误定义](https://www.w3.org/TR/webrtc/#rtcpeerconnectioniceerrorevent)解释，没有屏蔽报错。
- [接收端](../XBQ-BPweb/src/services/assets/IncomingAssetTransfers.ts)与[Web 连接](../XBQ-BPweb/src/services/WebRtcRemoteBpConnection.ts)：完整收到且尺寸/分片结构验证通过时记 received，SHA-256 成功后才记 verified。通过现有资源通道反向发送可选小回执；房主验证 transferId、已提交状态、总字节数后更新诊断。旧端忽略这些回执；没有回执的连接只显示 submitted，需要接收端日志确认。每资源至多两条成功回执，没有逐块 ACK 或新增重传协议。
- [诊断 schema 4](../shared/remoteBpDiagnostics.ts)与[面板](../XQB-BPbox/src/renderer/src/components/remoteBp/RemoteBpNetworkDiagnostics.tsx)：新增提交/收齐/校验时间、回执来源、有效载荷吞吐、编码后提交字节、等待分项、每秒缓冲/限速/计时器延迟/可见性、应用心跳耗时。保留 ICE RTT 与操作请求到结果的应用耗时；TCP 备用配置与实际 relayProtocol 分开；丢包率缺失仍为 null。新增字段不包含 Token、AppKey、username、credential、SDP 或端点用户地址。

资源仍使用可靠有序 SCTP，分片约 11.25KiB 原始数据，保留 SHA-256、manifest 校验、体积/数量限制、重复分片拒绝、超时、缓存和去重。Base64 约增加 1/3 载荷加 JSON 开销，能解释有效载荷速率小于限速，不能单独解释 77 秒；本次没有为节省这些开销重写二进制协议。SCTP 带宽由多个通道共享，操作在应用队列中优先并不保证拥塞网络中的固定响应上限。

**测试与边界**

| 测试 | 结果/范围 |
| --- | --- |
| `XQB-BPbox: npm run test:webrtc` | 通过。新增合成 500ms RTT、128KiB/s 每链路模型，两名选手并行 300KiB 提交约 3109ms，3KiB <1 秒；验证缓冲上界、控制/心跳越过资源队列、错误回执拒绝、暂缺 stats 不抖动、长期缺失/强制直连失败、UDP 优先/TCP 备用、重启与权限不回归。这是模拟，不是 WTN 实测。 |
| `npm run test:remote-network` | 真实 Chromium 本机 host/host 通过。300KiB、64KiB/s 编码后上限，接收校验约 6.1 秒，有效载荷约 49KiB/s，符合 Base64 开销；操作在资源传输中往返 1ms。两份并发 300KiB 共享该上限、各约 12.5 秒且 hash/回执正确；ICE restart 同 PC 续传、旧单通道兼容、缓存与 UI 导出通过。不是跨网或 TURN 性能证明。 |
| `npm run test:remote-bp` | 通过：权限/状态分发、端到端资源、延迟操作合并、ACK/状态顺序、确认锁、拒绝、重连和超时。 |
| `npm run test:remote-images` | 通过：各类图片压缩与透明度。Electron 在沙箱内异常退出后，沙箱外重跑通过。 |
| 桌面/Web `npm run build` | 通过，包括双方 TypeScript 检查。 |

可复查的本地浏览器产物位于 `XQB-BPbox/.tmp/remote-network-test/diagnostics.json` 和 `diagnostics.png`，测试可重生成。这些文件仅证明本机路径；没有取得新的真实 WTN 凭证或执行线上部署。

**TURN 节点与控制台用量**

仍使用官方 `GET https://{域名}/turn/{AppID}`；[获取 TURN 信息](https://docs.volcengine.com/docs/WebRTCtransportnetwork/GetTURNserviceinformation?lang=zh)要求按客户端地域就近选择域名，同一通信使用同一 AppID，且 TURN 需技术支持开通。现有 Worker 用 `${roomCode}:${sessionId}:${connectionId}` 作为接口 SessionID，可用于工单关联。

[请求域名文档](https://docs.volcengine.com/docs/WebRTCtransportnetwork/Requestdomainname?lang=zh)说明统一域名 `wtn.volcvideo.com` 会就近解析，另有中国大陆廊坊等区域域名。代码是 Cloudflare Worker 代客户端请求，因此**可能**按 Worker 出口所在位置分配资源，不能等同于选手所在地；当前节点的物理地域与跨区路径需服务方确认。没有根据 IP 或 400ms RTT 擅自更换域名/节点。双方 relay 会涉及两端分配的中继路径；这符合强制测试语义，常规使用仍允许 ICE 选更优直连，无法从静态代码证明其中是否存在可避免的运营商绕路。

[WTN 计费说明](https://docs.volcengine.com/docs/WebRTCtransportnetwork/Billinginstructions-5?lang=zh)以发布/订阅上、下行流量说明基础流量，计费项按日计量、自然月结算；该页面没有明确承诺原生 TURN/SCTP DataChannel 流量在某个控制台图表如何展示，也没有给 TURN 图表更新的确定延迟。不能将它推导成“TURN 不计费”或“等一天必然出现”，也不能用其他产品的统计延迟替代 WTN 规则。WebRTC 已经走 relay 与火山后台计量成功是两个独立结论。

向火山引擎工单提供/确认下列信息（不要提供密钥或临时凭证）：

1. 账号/项目、已核实 AppID、TURN 开通状态；测试 UTC `2026-10-13 12:51:23.518` 至约 `12:56:01`（北京时间 20:51–20:56），房间/选手 sessionId/connectionId 构成的 SessionID、接口 HTTP/业务 code、TTL、请求域名。
2. 上述两个 UDP URL、官方响应给出的完整脱敏节点集合、两端选中 pair、relayProtocol、流量计数及增量、图片 verified 回执、客户端城市/运营商/校园网或热点环境，以及 Worker 请求出口区域（若可取得）。请服务方核实节点归属、所在地域、分配策略和是否跨区绕路。
3. 确认 `/turn/{AppID}` 的原生 DataChannel 流量对应哪一统计产品、计费项和图表，是否单独白名单/维度；核查当前所看的 WTN 页面是否仅覆盖发布/订阅媒体流，是否有项目、区域、AppID、时区和日期过滤。
4. 索取该产品图表的正式上报延迟、计量粒度、低于展示单位时的处理方式、该时间段原始计量记录和账单映射。请核查 TURN 分配产生的真实会话是否归属此 AppID；不能让“成功领取凭证”代替此核对。

**上线后复测步骤（待实测）**

1. 同时更新桌面和 Web 客户端；不需要为本轮前端修复重新签发凭证或修改 Worker。关闭旧页面/进程再开房，确认导出 `schemaVersion=4`。记录版本、城市、运营商、Wi-Fi/热点、前台/最小化状态。
2. 自动模式与强制模式各测试校园网↔热点、热点↔热点，两名选手同时加入。双方导出日志；强制模式实际 selected pair 必须双方 relay、policy=relay，本地 relayProtocol 分别核实 UDP/TCP/TLS。记录 milestones，正常短时 stats 暂缺不应让 BP 页面反复重连。
3. 用相同 3KiB 与约 300KiB 图片，先单传再双选手并发；清除相应测试资源缓存或使用不同 hash。对比提交时间、receivedAt、verifiedAt、receiptSource、有效载荷吞吐；记录四类 waitMs、wireBytes、真实字节增量、RTT、操作响应和应用心跳。接收端 hash 未成功不得算传输成功；老端没有回执不能按 submitted 算成功。
4. 图片传输期间持续正常选择/确认，分别前台和最小化桌面；对比操作响应的中位数/高分位与空闲基线，不把本地 1ms 当成目标网络的结果。如果 ICE RTT 本身仍约 450ms，应用操作至少受该网络往返制约；本轮无法承诺降低物理 RTT。
5. 切换网络/短暂断网，验证受控恢复、同 PC 传输延续或新连接重试、SHA-256、策略重新验证。以可控防火墙测试 UDP 不可用时 TCP 备用仍有效；区分 TCP 已配置与被选中。无有效 TURN 的强制模式仍须失败。长期 stats 不可验证和实际直连也应明确失败。
6. 将双方导出与 WTN 工单计量记录按 UTC、AppID、SessionID 对齐。只有服务端统计证据才能结案“控制台无用量”；仅靠客户端中继证据不能结案。
