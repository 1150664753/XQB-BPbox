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
          创建房间前设置。默认优先直连；强制测试需要有效 TURN 授权，失败时不会回退直连。
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
                  {item.pair ? (item.relay ? 'TURN 中继' : '直连') : '路径未确认'} · {item.phase}
                </span>
              </header>
              <dl>
                <dt>候选路径</dt>
                <dd>{item.pair ?? '尚未选中'}</dd>
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
                <dt>实际发送 / 接收</dt>
                <dd>
                  {bytes(item.sendBytesPerSecond)}/s · {bytes(item.receiveBytesPerSecond)}/s
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
                <dt>图片实测速率</dt>
                <dd>
                  {bytes(item.assetBytesPerSecond)}/s；当前上限 {bytes(item.assetRateLimit)}/s
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
        速率来自浏览器网络统计；资源进度表示已提交发送，不代表选手已完成校验。导出日志不含地址、SDP
        或凭证。
      </small>
    </details>
  )
}
