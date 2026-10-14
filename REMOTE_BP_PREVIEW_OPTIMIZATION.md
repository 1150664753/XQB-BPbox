# 远程 BP 预选、图片传输与断线诊断优化

> 历史审计记录。网络监测和强制 TURN 设置已于 2026-10-14 移除；当前连接行为及验收以 [P2P 优先与 5 秒 TURN 兜底](docs/REMOTE_BP_CONNECTION_POLICY.md) 为准。

日期：2026-10-14。范围：现有 WebRTC / DataChannel 传输与两端适配器；不改变 TURN AppID `6ac735fb7305ab038c2e3546`、14400 秒凭证、权限与 BP revision/actionId 校验。

## 实际日志与结论边界

检查文件 `remote-bp-network-2026-10-14T01-03-34-097Z.json`，SHA-256：`61dbb2ea9970cf58bfe5139ae110e7f371452ba9c92491f32be7ed9f24a1bcf5`。文件只有房主一侧的一条连接记录。

- 连接生命周期 46,098ms；选中 `relay / relay` UDP；28 个 RTT 样本平均 478.7ms，范围 415–488ms。
- 四张图片均取得对端 `verified` 回执。原始数据合计 1,209,498B，DataChannel 应用消息合计 1,644,263B，Base64/封装增加约 35.9%。这里不包含底层 SCTP/DTLS/UDP 的开销。
- 发送提交累计 9,984ms；等待累计 9,937ms，其中 pacing 7,568ms。pacing 占提交时间约 75.8%，占四次“开始至对端校验回执”的累计 11,910ms 约 63.5%。控制缓冲采样峰值 93,553B。
- 关闭顺序：DataChannel `closing` → `error` → 应用销毁 PeerConnection。通道关闭前 ICE、DTLS、SCTP 都显示 connected，没有 ICE restart。旧代码还把 closing 临时解释成 connecting，造成误导。
- 关闭前约 4.4 秒出现 701；其中一条服务器地址与所选 TURN 地址相同。不能把所有错误都说成未选中节点，也不能据此认定当前 relay 数据通路故障。旧日志没有保留 RTCError/SCTP 原因码，且缺少网页端日志，**实际断线诱因待实测**。
- 没有足够的旧日志把 SELECT 的慢精确分摊至网络、房主、状态回传或图片。下面区分已确认代码问题与性能预期。

## SELECT 与 CONFIRM 链路

两者均走网页 `RemoteBpSessionStore` → `WebRtcRemoteBpConnection.sendAction` → 独立控制通道 → 房主 `RemoteBpHost.handleRemoteAction` → `BpActionDispatcher` → `ConsolePage` executor → ACTION_RESULT → 状态回传。

SELECT 请求仅包含目标种类/id、revision、stepIndex、actionId 等小型 JSON；CONFIRM 的 targets 为空。请求中没有图片。网页本来就会立即更新本地预选意图，图片通过 `useAssetUrl` / `RemoteAssetManager` 异步请求；没有等待 SHA-256/解码才接受 BP 状态的逻辑。

确认的额外负担：

1. SELECT/DESELECT 的 executor 在更新 ref/React 状态之后，还等待 `sendStateToDisplay` IPC 回执才返回 dispatcher。现改为同步更新权威预选后异步通知展示窗口，失败有错误提示。图片加载仍独立；CONFIRM 的执行、动作去重和版本校验保持原逻辑。
2. 每次 STATE_UPDATE 都重复携带完整角色/光锥目录。新增协商后的增量消息，改变的顶层字段与角色行单独传输；相同内容仅 updatedAt 改变时不重复发送。初始化、目录结构变化不适合增量时、显式重同步仍可发送完整状态。
3. 网页原来的清单处理逐项等待全目录磁盘缓存检查，但 UI 可以在检查结束前发起网络请求。改成按需读取缓存：同一 assetId/hash 的并发请求复用一次读取，读取完成后再决定下载；清单/连接代次变化会丢弃旧回调。收到合法网络资源后，迟到的磁盘回调也不会重建已有 URL。
4. 图片元素按 assetId/URL 区分，旧图片不会在新选择中继续显示。现有“单个在途操作、合并后续预选为最新意图”的机制保留，确选仍等待 ACTION_RESULT 和相应 revision 的状态。

## 传输及兼容性

- 控制通道与可靠、有序的资源通道已经分开，但仍共享 SCTP 拥塞控制。继续让控制消息绕过图片发送队列；资源等待控制缓冲清空，保留短暂控制优先窗口。
- 网页在现有 STATE_REQUEST 的可选 capabilities 中声明 `state-delta-v1` / `asset-binary-v1`。旧房主忽略额外字段；新房主只有收到能力声明后才使用扩展。新旧混用仍走原来的完整状态和 Base64 JSON。
- 状态增量使用独立 sequence/base（不能只依赖 BP revision，因为选手连接状态可能不增加 revision）。网页重建后仍经过原有完整状态校验。基线不符时只请求一次完整状态，避免请求风暴；重建连接后清空基线。
- 新图片分片仅在独立资源通道上采用 ArrayBuffer，帧不超过 16KiB。长度、transferId、assetId、index/total、清单描述、总大小和 SHA-256 校验继续保留。旧资源通道和控制通道兼容路径继续接受 JSON。一个资源从 START 到 COMPLETE 固定在同一通道，不跨通道混排。
- pacing 初始探测速率从 128KiB/s 改为 256KiB/s；稳定时每秒增加至少 32KiB/s 或当前值的 25%，始终受用户上限约束。持续 RTT 膨胀/积压仍触发乘性回退，缓冲门限仍最高 128KiB（一次发送可额外增加一个小分片）。没有取消背压、限速、可靠性或完整性检查。
- submitted 仍只表示本地提交；received 表示完整数据到达，verified 表示接收端哈希成功。房主的 verified 依赖对端回执。

## 新增诊断（JSON schemaVersion 5）

| 字段 | 用途与边界 |
| --- | --- |
| `actionTimings` | actionId/kind 关联 SELECT、DESELECT、CONFIRM；queueMs 为发送前等待，requestBytes/sendBufferedBytes 为请求大小与发送前缓冲 |
| `hostProcessingMs` | 房主 dispatcher 处理时间，包含其队列等待；通过可选 ACTION_RESULT 字段回传 |
| `responseMs` | 网页发送至收到 ACTION_RESULT；不是图片传输时间 |
| `networkAndQueueMs` | responseMs 减 hostProcessingMs；包含往返网络及浏览器/通道排队，**不是精确单向延迟，也不是纯网络 RTT** |
| `stateReturnedMs / stateApplyMs / uiCommitMs` | 均从发送起累计，分别表示匹配 revision 的状态到达、store 确认应用、React layout effect 提交；相邻阶段相减可分析等待，不把累计值相加。UI commit 不等于物理屏幕绘制 |
| `previews` | 每次预选视图的 assetId、uiMs、imageLoadMs、cached、loading/loaded/failed/superseded/no-image；有点击时从点击累计，否则从组件提交起计。图片完成与预选状态分开 |
| `controlMessages` | 实际发出消息类型、编码字节数与发送后缓冲，观察 STATE_DELTA_V1 是否取代重复大消息 |
| `transfers.encoding / wireBytes / waitMs / payloadBytesPerSecond` | 区分 binary-v1 与 base64-json，比较负载/线上字节和 pacing、buffer、control、queue 等待 |
| `closures` | 销毁前 ICE/PC/DTLS/SCTP/channel 状态、缓冲、错误 detail 与 SCTP 原因码；记录退出/踢人/信令离开/连接替换。`remote-or-transport-close` 保留不确定性，不能当成对端用户主动关闭的证明 |

关闭中的 DataChannel 不再触发虚假的 connecting 阶段；保留随后 error/close 证据，并对一直停留 closing 的情况设置 10 秒超时。701 保留原有服务器、影响类别及 selectedServer 信息，不因错误码本身销毁正常连接。没有记录 Bearer Token、AppKey、TURN username/credential、SDP 或浏览器原始错误 message。

## 验证与结果

- BPbox、网页 `npm run build`（含 TypeScript 检查）。
- `npm run test:remote-bp`：dispatcher/serializer/host、延迟回执、预选合并、ACK/状态顺序、revision/确选锁、拒绝、切步、重连、超时与 stateApply 时机。
- `npm run test:webrtc`：强制 relay、UDP/TCP 回退、701、ICE restart、关闭前证据/凭证脱敏；新增状态增量和二进制协议校验、新旧适配器兼容、错误基线恢复、重放/重复分片/尺寸错误/损坏哈希拒绝。
- 300 角色夹具中，经实际适配器编码的完整状态消息 65,772B，预选增量消息 545B（约减少 99.2%）。实际目录和动作不同，大小会不同。
- 500ms RTT、每条链路 128KiB/s 的合成模型同时运行两个发送端：300KiB 图片二进制/兼容 JSON 的本地提交耗时约 1,916 / 2,760ms；控制消息可在期间发送，资源缓冲保持有界。**这是模型提交时间，不是 WTN 的接收或显示时间。**
- `npm run test:remote-network`：真实 Chromium 双端本地 WebRTC；300KiB 图片二进制应用消息合计 310,072B（约 0.94% 封装开销）；并发两资源、对端 SHA-256 和回执、操作消息穿插、同 PC ICE restart 续传、资源通道关闭后的 JSON 回退均验证。
- 浏览器 UI 测试：图片未到时名称先显示；B 预选之后迟到的 A 图片不覆盖 B；返回已缓存角色不新增网络请求；验证独立 UI/图片指标。缓存覆盖 IndexedDB 重载、哈希变化、损坏数据、重复清单与连接代次重置。
- 测试过程中曾在构建并发运行时出现一次持久缓存检查失败，随后单独运行完整浏览器测试通过；没有放宽生产缓存校验。真实设备磁盘/浏览器缓存的表现仍应随下述实测记录。

本次没有重新执行跨校园网/热点的真实 WTN 性能试验。480ms 左右的选中路径 RTT、TURN 节点路由和 46 秒断线的最终诱因仍待实测；不承诺代码修改能降低物理网络 RTT，也不能据此确认火山引擎后台统计/计费状态。

## 下一次双端实测

1. 同时更新 BPbox 和网页，正常模式、强制 TURN 模式各跑一轮。两端导出 JSON，确认 `statsStatus=current`、实际 selected pair、UDP/TCP/relayProtocol；强制模式须双方 relay 验证成功。
2. 网络稳定后单击未缓存角色，观察名称/预选先变化，再观察大图；记录 SELECT 的 `queueMs / hostProcessingMs / responseMs / stateReturnedMs / stateApplyMs / uiCommitMs` 和 `previews.imageLoadMs`。正式 CONFIRM 单独对照；图片缺失不能使确选/预选丢失版本约束。
3. 连续快速选择 A→B→C，再返回 A/C。检查最终权威状态为 C（或最后一次合法意图）；已缓存相同 hash 不新增资源传输，迟到图片不改变当前选择。
4. 两名选手同时传输 240–350KiB 图片并预选/确选，比较 `controlMessages` 是否使用小增量、控制缓冲峰值、资源 wireBytes/encoding、pacing 占比、verified 吞吐和应用响应。不要拿 submitted 作为用户已看到图片的时间。
5. 保持连接至少 3–5 分钟，跨过原来的约 46 秒故障点；记录任何 closing/error 前后的 `closures`、701、selected pair 和流量变化。分别主动离开、房主踢人，检查事件来源可区分。若再次异常关闭，必须同时收集网页端 JSON。
6. 短暂断网后恢复，观察 ICE restart 和完整重建两种情况；确认 relay 策略、能力协商和状态基线恢复，缓存仍可复用，未完成资源可重试。

主要修改位置：`shared/remoteBpWire.ts`、`remoteBpFlowControl.ts`、`remoteBpRtc.ts`、`remoteBpDiagnostics.ts`；BPbox 的 `WebRtcRemoteHostTransport.ts`、`ConsolePage.tsx`、`shared/remoteBp/{host,types,validation}.ts`；网页的 `WebRtcRemoteBpConnection.ts`、`RemoteBpConnection.ts`、`IncomingAssetTransfers.ts`、`RemoteAssetManager.ts`、`RemoteBpSessionStore.ts`、`SelectionPanel.tsx`、`BpPage.tsx` 与消息类型；对应自检脚本和 npm 测试入口。

## 补充修复：BP 结果／语音时间轴缺少预选历史

`ConsolePage.tsx` 的 `publishPreviewTarget` 原来仅在 `bpMode === 'live'` 时写入 `previewRecords`，而新建 BP 默认使用手动回放模式。手动模式下远程 SELECT 可以更新选择和网络状态，但没有保存预选记录，导致 BP 结果及语音时间轴都没有历史候选。已用原代码执行实际 remote executor 回调复现此缺陷。该限制在网络优化前的 `a9601d1` 中已经存在；上次优化的验证遗漏了结果持久化链路。尚未取得用户此次缺失历史的 BP 结果文件，不能据此断言当时一定处于手动模式。

现在将历史记录与展示模式分开：手动、直播模式均记录已接受的 BAN/PICK 预选，展示窗口是否显示实时预选仍由直播模式决定。记录在通知展示窗口前同步写入，不等待图片或 IPC 回执；重复 SELECT 去重、取消/确选结束记录、额外点击阻塞及已结束步骤的限制保留。没有改动网络协议、TURN 配置或正式确选校验。

`test:voice-timeline` 增加 10 个场景（总计 27 个），执行生产代码的 SELECT/DESELECT/CONFIRM、结果构造/JSON 序列化/归一化/重新载入和时间轴候选卡片渲染，覆盖两种模式、连续 A→B→A、重复预选、角色/光锥、未返回及失败的展示 IPC。原代码在手动模式首次 SELECT 的历史断言处失败，修复后全部通过；`test:remote-bp` 和 BPbox 完整构建（含 TypeScript 检查）也通过。

复测时请使用更新后的 BPbox，新建 BP 后在网页依次预选 A、B、A，确选并保存结果；检查结果 JSON 的 `previewRecords` 和对应步骤的语音时间轴候选卡片。手动、直播模式各测一次。已经保存且没有 `previewRecords` 的旧结果无法仅凭最终确选还原真实预选历史；网络诊断 `previews` 与保存的 BP 历史是不同数据。
