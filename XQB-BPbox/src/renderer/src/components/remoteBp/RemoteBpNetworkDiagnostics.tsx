import { useEffect, useState } from 'react'
import {
  exportRtcDiagnostics,
  getRtcDiagnostics,
  type RtcDiagnostics
} from '../../../../../../shared/remoteBpRtc'
import type { RemoteBpHost, RemoteBpRoomState } from '../../../../shared/remoteBp'

function bytes(value: number | null): string {
  if (value === null) return '—'
  return value >= 1024 * 1024
    ? `${(value / 1024 / 1024).toFixed(2)} MiB`
    : value >= 1024
      ? `${(value / 1024).toFixed(1)} KiB`
      : `${Math.round(value)} B`
}
const turnLabels: Record<RtcDiagnostics['turn'], string> = {
  'not-requested': '尚未请求',
  requesting: '获取中',
  ready: '凭证已就绪',
  failed: '获取失败',
  expired: '已过期',
  disabled: '已停用'
}

export default function RemoteBpNetworkDiagnostics({
  host,
  room
}: {
  host: RemoteBpHost
  room: RemoteBpRoomState
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [connections, setConnections] = useState<RtcDiagnostics[]>([])
  const [options, setOptions] = useState(() => host.getNetworkOptions())
  useEffect(() => {
    if (!open) return
    const refresh = (): void =>
      setConnections(
        getRtcDiagnostics(room.roomId)
          .filter((item) => item.role === 'host')
          .slice(-4)
      )
    refresh()
    const timer = window.setInterval(refresh, 1000)
    return () => window.clearInterval(timer)
  }, [open, room.roomId])

  const configure = (next: typeof options): void => {
    host.configureNetwork(next)
    setOptions(host.getNetworkOptions())
  }
  const configurable = room.lifecycle === 'idle' || room.lifecycle === 'error'
  const download = (): void => {
    const blob = new Blob([exportRtcDiagnostics(room.roomId)], { type: 'application/json' })
    const url = URL.createObjectURL(blob),
      link = document.createElement('a')
    link.href = url
    link.download = `remote-bp-network-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <details className="remote-bp-network" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>网络诊断</summary>
      <div className="remote-bp-network-settings">
        <label>
          <input
            type="checkbox"
            checked={options.forceRelay}
            disabled={!configurable}
            onChange={(event) => configure({ ...options, forceRelay: event.target.checked })}
          />
          强制 TURN 测试
        </label>
        <label>
          图片发送上限{' '}
          <select
            value={options.assetRateKiBps}
            disabled={!configurable}
            onChange={(event) =>
              configure({ ...options, assetRateKiBps: Number(event.target.value) })
            }
          >
            {[64, 128, 256, 512, 1024, 2048].map((value) => (
              <option key={value} value={value}>
                {value} KiB/s
              </option>
            ))}
          </select>
        </label>
        <small>
          创建房间前设置。自动模式先尝试直连；中继优先 UDP，TCP 备用。强制 TURN 需要有效授权。
        </small>
        <button type="button" onClick={download}>
          导出诊断日志
        </button>
      </div>
      {connections.length === 0 ? (
        <p>等待选手连接后显示实际网络路径。</p>
      ) : (
        connections.map((item) => {
          const side =
            item.peerId === room.firstPlayer.peerId
              ? '先手'
              : item.peerId === room.secondPlayer.peerId
                ? '后手'
                : '历史连接'
          const candidates = item.candidates
          const progress = item.assets.totalBytes
            ? Math.min(100, (item.assets.queuedBytes / item.assets.totalBytes) * 100)
            : 0
          return (
            <article key={item.connectionId} className="remote-bp-network-peer">
              <header>
                <strong>{side}</strong>
                <span>
                  {item.statsStatus !== 'current' && item.pair ? '上次观测：' : ''}
                  {item.turnUsage === 'relay'
                    ? 'TURN 中继实际被选中'
                    : item.turnUsage === 'direct'
                      ? '当前没有经过 TURN'
                      : '路径未确认'}{' '}
                  · {item.phase}
                </span>
              </header>
              <dl>
                <dt>实际 ICE 策略</dt>
                <dd>
                  {item.iceTransportPolicy} ·{' '}
                  {item.forceRelay
                    ? item.relayVerified &&
                      item.localCandidateType === 'relay' &&
                      item.remoteCandidateType === 'relay'
                      ? '双方 relay 已核实'
                      : '强制中继待核实'
                    : '自动选择路径'}
                </dd>
                <dt>路径统计时效</dt>
                <dd>
                  {item.statsStatus === 'current'
                    ? '当前采样'
                    : item.statsStatus === 'closed'
                      ? '连接已关闭，以下为最后观测'
                      : item.statsStatus === 'stale'
                        ? '采样暂缺，以下为最后观测'
                        : '尚无路径证据'}
                  ；上次中继核实{' '}
                  {item.relayVerifiedAt ? new Date(item.relayVerifiedAt).toLocaleTimeString() : '—'}
                </dd>
                <dt>TURN 配置 / 候选</dt>
                <dd>
                  {item.turnConfigured ? '已安装到连接' : '未安装'} · 本地 relay{' '}
                  {item.candidates.localRelay} / 对端 relay {item.candidates.remoteRelay}
                </dd>
                <dt>生效 AppID / 来源</dt>
                <dd>
                  {item.turnAppId ?? '服务端未提供'} / {item.turnAppIdSource ?? '未知'}
                </dd>
                <dt>TURN 接口结果</dt>
                <dd>
                  {item.turnRequests.at(-1)?.source ?? '尚未请求'} · HTTP{' '}
                  {item.turnRequests.at(-1)?.httpStatus ?? '—'} / code{' '}
                  {item.turnRequests.at(-1)?.providerCode ?? '—'}
                </dd>
                <dt>候选路径</dt>
                <dd>{item.pair ?? '尚未选中'}</dd>
                <dt>选中候选对 / 变化</dt>
                <dd>
                  {item.selectedPair?.id ?? '—'} / {item.pairHistory.length} 次（详见导出）
                </dd>
                <dt>协议</dt>
                <dd>
                  {item.protocol?.toUpperCase() ?? '—'}；本地中继{' '}
                  {item.localRelayProtocol?.toUpperCase() ?? '—'}；对端中继{' '}
                  {item.remoteRelayProtocol?.toUpperCase() ?? '未提供'}
                </dd>
                <dt>RTT / ICE 重启</dt>
                <dd>
                  {item.rttMs === null ? '—' : `${item.rttMs} ms`} / {item.restartCount} 次
                </dd>
                <dt>选中 TURN 节点</dt>
                <dd>
                  {item.selectedPair?.server ?? '浏览器未提供'}；对端{' '}
                  {item.selectedPair?.remoteServer ?? '需对端导出'}
                </dd>
                <dt>TCP 备用配置</dt>
                <dd>
                  {item.tcpFallbackEnabled ? '已加入后续协商（不代表正在使用 TCP）' : '尚未启用'}
                  ；实际协议见上方
                </dd>
                <dt>应用心跳 / 调度延迟</dt>
                <dd>
                  {item.applicationPingMs === null
                    ? '请在选手端导出'
                    : `${item.applicationPingMs} ms`}{' '}
                  / {item.timerLagMs} ms
                </dd>
                <dt>实际发送 / 接收</dt>
                <dd>
                  {bytes(item.sendBytesPerSecond)}/s · {bytes(item.receiveBytesPerSecond)}/s
                </dd>
                <dt>丢包统计</dt>
                <dd>
                  浏览器未提供 DataChannel 丢包率；本地发送丢弃{' '}
                  {item.sendDiscardRatio === null
                    ? '—'
                    : `${(item.sendDiscardRatio * 100).toFixed(2)}%`}
                </dd>
                <dt>操作往返响应</dt>
                <dd>
                  {item.actionResponseMs === null
                    ? '请在选手端导出诊断'
                    : `${item.actionResponseMs} ms`}
                </dd>
                <dt>当前路径累计</dt>
                <dd>
                  发送 {bytes(item.bytesSent)} · 接收 {bytes(item.bytesReceived)}
                </dd>
                <dt>发送缓冲</dt>
                <dd>
                  控制 {bytes(item.bufferedAmount)} · 图片 {bytes(item.assetBufferedAmount)}
                </dd>
                <dt>图片通道</dt>
                <dd>{item.assetChannelState ?? '兼容模式'}（与控制通道共享 SCTP 带宽）</dd>
                <dt>图片通道发送速率</dt>
                <dd>
                  {bytes(item.assetBytesPerSecond)}/s；当前上限 {bytes(item.assetRateLimit)}/s
                </dd>
                <dt>接收确认</dt>
                <dd>
                  {
                    item.transfers.filter((t) => t.direction === 'send' && t.status === 'verified')
                      .length
                  }{' '}
                  项 SHA-256 校验回执（最近 64 项）；submitted 仅为发送队列提交
                </dd>
                <dt>资源提交进度</dt>
                <dd>
                  {item.assets.submitted} / {item.assets.requested} 项；
                  {bytes(item.assets.queuedBytes)} / {bytes(item.assets.totalBytes)}
                  <progress max={100} value={progress} />
                </dd>
                <dt>TURN 凭证</dt>
                <dd>
                  {turnLabels[item.turn]}
                  {item.turnRequestMs !== null ? ` · ${item.turnRequestMs} ms` : ''}
                  {item.expiresAt ? ` · 到期 ${new Date(item.expiresAt).toLocaleTimeString()}` : ''}
                </dd>
                <dt>凭证支持协议</dt>
                <dd>{item.turnProtocols.join(' / ').toUpperCase() || '—'}</dd>
                <dt>凭证 TTL（请求 / 实际）</dt>
                <dd>
                  {item.turnRequestedTtl ?? '—'} / {item.turnActualTtl ?? '—'} 秒
                  {item.turnTtlReason ? ` · ${item.turnTtlReason}` : ''}
                </dd>
                <dt>TURN 接入域名</dt>
                <dd>{item.turnApiDomain ?? '服务端未提供'}</dd>
                <dt>ICE 服务错误</dt>
                <dd>
                  {item.iceServerErrors.length
                    ? item.iceServerErrors
                        .map(
                          (e) =>
                            `${e.server ?? '未知服务器'} · ${e.code} ${e.reason} ×${e.count} · ${e.impact === 'connected-probe-failure' ? '探测失败时连接仍正常' : e.impact === 'connection-unhealthy' ? '连接同时异常' : '收集阶段'}${e.selectedServer ? '（与选中节点同 URL）' : ''}`
                        )
                        .join('；')
                    : '无'}
                </dd>
                <dt>最近资源传输</dt>
                <dd>
                  {item.transfers
                    .slice(-3)
                    .map(
                      (t) =>
                        `${t.status} · ${bytes(t.bytes)}/${bytes(t.totalBytes)} · ${t.durationMs ?? item.updatedAt - t.startedAt} ms · 有效载荷 ${bytes(t.payloadBytesPerSecond)}/s · 等待队列/缓冲/控制/限速 ${Math.round(t.waitMs.queue)}/${Math.round(t.waitMs.buffer)}/${Math.round(t.waitMs.control)}/${Math.round(t.waitMs.pacing)} ms${t.reason ? ` · ${t.reason}` : ''}`
                    )
                    .join('；') || '无'}
                </dd>
                <dt>信令 / 收集</dt>
                <dd>
                  {item.signalingState} / {item.iceGatheringState}
                </dd>
                <dt>ICE / PC</dt>
                <dd>
                  {item.iceState} / {item.connectionState}
                </dd>
                <dt>DTLS / SCTP / DC</dt>
                <dd>
                  {item.dtlsState ?? '未提供'} / {item.sctpState ?? '未提供'} /{' '}
                  {item.dataChannelState ?? '未创建'}
                </dd>
                <dt>ICE 候选计数</dt>
                <dd>
                  生成 {candidates.generated} · 发送 {candidates.sent} · 接收 {candidates.received}{' '}
                  · 应用 {candidates.applied} · 重复 {candidates.duplicates} · 拒绝{' '}
                  {candidates.rejected}
                </dd>
                <dt>收集结束标记</dt>
                <dd>
                  本地 {candidates.localComplete ? '已完成' : '等待'} / 对端{' '}
                  {candidates.remoteComplete ? '已收到' : '等待'}
                </dd>
                <dt>首次到达耗时</dt>
                <dd>
                  {['sdp', 'ice', 'dtls', 'sctp', 'channel']
                    .map(
                      (stage) =>
                        `${stage.toUpperCase()} ${item.milestones[stage] === undefined ? '—' : `${item.milestones[stage]} ms`}`
                    )
                    .join(' · ')}
                </dd>
                <dt>最近错误</dt>
                <dd>{item.errorCode ? `${item.errorCode} · ${item.errorMessage ?? ''}` : '无'}</dd>
              </dl>
            </article>
          )
        })
      )}
      <small>
        资源提交不代表选手已完成校验。导出包含不带凭证的 ICE 服务器地址，不含选手 IP、SDP 或密钥。
      </small>
    </details>
  )
}
