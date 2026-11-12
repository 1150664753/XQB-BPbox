import { useEffect, useState } from 'react'
import type { SakuraStatus } from '../../../../shared/sakura'
import { networkSettings, useNetworkSettings } from '../../services/remoteBp/networkSettings'

const serviceLabels = {
  stopped: '未启动',
  starting: '启动中',
  listening: '监听中（仅本机）',
  failed: '启动失败'
}
const publicLabels = {
  unchecked: '未验证',
  checking: '验证中',
  verified: 'WSS 验证通过',
  failed: '连接失败'
}

export default function SakuraSettings(): React.JSX.Element {
  const network = useNetworkSettings()
  const [publicUrl, setPublicUrl] = useState(network.settings.publicUrl)
  const [localPort, setLocalPort] = useState(String(network.settings.localPort))
  const [status, setStatus] = useState<SakuraStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    const unsubscribe = window.bpAPI.sakura.onStatus((value) => {
      if (live) setStatus(value)
    })
    void window.bpAPI.sakura
      .status()
      .then((value) => {
        if (live) setStatus(value)
      })
      .catch(() => {
        if (live) setError('无法读取本地服务状态')
      })
    return () => {
      live = false
      unsubscribe()
    }
  }, [])
  const locked = network.busy || network.roomOpen || busy
  const dirty =
    publicUrl !== network.settings.publicUrl || localPort !== String(network.settings.localPort)
  const run = async (action: () => Promise<SakuraStatus>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setStatus(await action())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '本地服务操作失败')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="sakura-settings network-settings-card" aria-label="樱花穿透设置">
      <label>
        本地 BP 服务端口
        <input
          aria-label="本地 BP 服务端口"
          type="number"
          min={1024}
          max={65535}
          value={localPort}
          disabled={locked}
          onChange={(event) => setLocalPort(event.target.value)}
        />
      </label>
      <label>
        樱花公网连接地址
        <input
          aria-label="樱花公网连接地址"
          placeholder="https://bp.example.com:12345"
          value={publicUrl}
          disabled={locked}
          maxLength={512}
          onChange={(event) => setPublicUrl(event.target.value)}
        />
      </label>
      <small>支持域名与端口，连接时使用 WSS。必须有与域名匹配的有效证书。</small>
      <button
        type="button"
        disabled={locked || !dirty}
        onClick={() => {
          setError(null)
          void networkSettings.configure({
            ...network.settings,
            publicUrl,
            localPort: Number(localPort)
          })
        }}
      >
        保存网络配置
      </button>
      {dirty && <small>先保存配置再启动。保存会停止尚未创建房间的本地服务。</small>}
      <div className="network-status" role="status">
        <p>
          本地服务：<strong>{status ? serviceLabels[status.service] : '读取中'}</strong>
        </p>
        <p>监听地址：127.0.0.1:{network.settings.localPort}</p>
        <p>
          公网连接：<strong>{status ? publicLabels[status.publicConnection] : '未验证'}</strong>
        </p>
        {status?.checkedAt && (
          <small>最近验证：{new Date(status.checkedAt).toLocaleTimeString()}</small>
        )}
        {(error || status?.error) && <p className="remote-bp-error">{error || status?.error}</p>}
      </div>
      <div className="network-settings-actions">
        <button
          type="button"
          className="primary"
          disabled={locked || dirty || status?.service === 'listening'}
          onClick={() => void run(() => window.bpAPI.sakura.startService())}
        >
          启动本地服务
        </button>
        <button
          type="button"
          disabled={locked || !status || status.service === 'stopped'}
          onClick={() => void run(() => window.bpAPI.sakura.stopService())}
        >
          停止本地服务
        </button>
        <button
          type="button"
          disabled={
            busy ||
            network.busy ||
            dirty ||
            status?.service !== 'listening' ||
            !network.settings.publicUrl
          }
          onClick={() => void run(() => window.bpAPI.sakura.verify())}
        >
          验证公网 WSS
        </button>
      </div>
      <div className="network-help">
        <strong>外部 SakuraFrp 客户端配置</strong>
        <ol>
          <li>
            自行安装并启动官方客户端，创建 TCP 隧道，目标设为 127.0.0.1:{network.settings.localPort}
            。
          </li>
          <li>
            为该隧道启用自动 HTTPS，绑定可用域名并配置有效证书；公网端口必须填写隧道实际端口。
          </li>
          <li>在这里启动本地服务并验证 WSS，再到远程 BP 卡片创建房间、复制完整邀请链接。</li>
        </ol>
        <small>
          BPbox 不管理客户端或 Token；外部客户端需要在比赛期间持续运行。选手仍访问原有网站。
        </small>
      </div>
    </section>
  )
}
