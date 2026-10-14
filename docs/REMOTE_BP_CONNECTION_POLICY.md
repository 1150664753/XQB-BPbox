# 远程 BP：P2P 优先，5 秒 TURN 兜底

更新日期：2026-10-14。需要同时更新 BPbox、网页和信令 Worker；本次仅上传代码，不代表线上 Worker/网页或安装包已发布。旧信令不转发新的连接策略字段时，客户端会报告版本不兼容。

## 连接行为

- 新连接的双方 PeerConnection 只配置 STUN，使用 `iceTransportPolicy: all`。即使房主已授权，也不预先请求或安装 TURN。
- 房主从创建该选手的 WebRTC 会话开始计时 5 秒，以控制 DataChannel 打开为成功标准，不能仅凭 ICE connected 取消兜底。
- 5 秒仍未成功且房主授权有效时，房主经现有 `TURN_REQUEST` 领取临时凭证。信令先下发给选手，再返回房主；选手暂存凭证，直到收到房主的 TURN Offer 才安装。双方使用 `iceTransportPolicy: relay` 并重新协商 ICE。
- 优先使用接口原有 UDP URL，3 秒仍未就绪或 ICE 明确失败时加入接口原有 TCP/TLS URL；只有 TCP URL 时直接使用。成功后不因备用计时器或网络质量改变连接路径。
- 无授权时不会请求 TURN，5 秒到点不会关闭连接。首次凭证失败继续 P2P，10 秒、20 秒后最多再重试两次；房间关闭、P2P 成功或授权撤销会阻止迟到请求安装凭证。
- 成功后的 P2P/TURN 模式固定；P2P 的 ICE restart 不会申请 TURN，TURN 的恢复不会回退直连。选手信令重连创建新 PC 时携带已选模式。TURN 授权撤销或凭证到期无法续期时明确失败。
- 保留原有 15 秒断线宽限、每次恢复最多两次 ICE restart、120 秒总恢复期限。这个期限与 5 秒兜底不同；未授权不会在 5 秒时被踢出。
- TURN 凭证正常续期仍保持 TURN 模式。AppID `6ac735fb7305ab038c2e3546`、WTN 请求方式与 14400 秒 TTL 没有修改。

连接层仍由房主唯一发 Offer，保留 connectionId、negotiationId、候选缓存/去重、会话身份和错误处理。信令新增校验并转发 `connectionMode` / `resumeMode`，删除房间级 `forceRelay` 设置；只有房主能够发起凭证请求，服务端仍验证授权和选手身份。

## 删除与保留

已删除网络诊断面板、隐藏授权弹窗内的连接诊断、两端 JSON 导出、持续 getStats 采样、RTT/吞吐/丢包统计、操作/图片耗时采集、诊断历史、强制 TURN UI/构建开关及 RTT 自适应限速代码。

保留 Ctrl+Shift+T 隐藏授权、连接状态显示、WebSocket/DataChannel 心跳、ICE/DataChannel 事件、基本控制台错误日志和凭证到期检测。701 仅记录发现服务器失败，不据此关闭健康连接。

当前路径显示 P2P、TURN UDP、TURN TCP；浏览器缺少 relayProtocol 时显示“TURN（协议未知）”。路径查询仅在连接/ICE 事件发生时进行，并作有限重试，不读取 RTT、吞吐或历史计数，不定时轮询网络质量。TCP 已配置为备用不等于实际走 TCP。

BP 操作、revision/actionId 校验、状态增量、图片二进制分片和旧 JSON 兼容、SHA-256、缓存以及接收/校验回执协议不变。资源仍有串行发送队列、控制消息优先窗口、最多 128KiB 缓冲门限、512KiB/s 提交上限及 30 秒无进展超时；这些是正常传输流控，不采集网络质量。

## 验证

自动检查覆盖：精确 5 秒边界、ICE 已连通但 DC 未打开、无授权、延迟授权、请求失败重试、迟到凭证与成功/关闭/撤销竞态、双方 relay 策略、UDP/TCP 备用、P2P 成功后的固定模式、恢复与候选队列，以及旧 direct pair 不抢先终止 TURN TCP 备用。

真实本地 Chromium 测试覆盖 P2P、并发两张 300KiB 资源、SHA-256 和 received/verified 回执、图片发送期间控制消息、同 PC ICE restart、资源通道关闭后 JSON 兼容、持久缓存与预选图片异步顺序。它不是真实 WTN 跨网测试。

运行入口：BPbox 的 `test:webrtc`、`test:remote-bp`、`test:voice-timeline`、`test:remote-network`、`test:turn-desktop`；Worker 的 `test`、`test:local`、`test:turn`；三个项目的类型/构建检查。TURN 测试只用模拟上游和合成密钥。

本次以上功能测试均通过；桌面和网页生产构建、Worker 类型检查与 `wrangler deploy --dry-run` 通过。额外 ESLint 扫描未通过：现有规则要求 CJS 测试脚本使用 TypeScript 返回类型与 ES module 导入，另有原有授权弹窗 effect、未用参数等问题；本次没有调整全仓库 lint 配置，也不将该扫描记为通过。

## 下一次实测

1. 同网两端新建连接：5 秒内控制通道打开，应显示 P2P；确认没有 TURN_REQUEST。传图和预选/确选正常。
2. 无授权，在无法直连的网络等候超过 5 秒：继续尝试 P2P，不能申请 TURN；可最终进入原有连接超时，而不是 5 秒主动断开。
3. 房主隐藏授权后，在无法直连的校园网/热点组合加入：5 秒后申请凭证并重新协商，成功后双方应显示 TURN UDP 或 TURN TCP；图片校验、BP 同步正常。
4. 在受控测试网络阻断 TURN UDP，检查 TCP 备用。可使用浏览器 WebRTC 内部页面核对当前 selectedCandidatePairId 和双方 relay；软件已无诊断导出。
5. 在凭证请求期间让 P2P 成功、关闭房间或撤销授权，检查不会被迟到凭证切换模式。两名选手的独立计时不互相影响。
6. 分别在 P2P 和 TURN 成功后短断网/恢复信令，核对恢复模式不改变。完成一局并保存结果，确认预选历史与语音时间轴仍存在。

真实跨网 TURN UDP/TCP 路由、长时间凭证续期及运营商网络表现仍待实测。软件不再持续记录网络质量，也不据此自动调度路径。
