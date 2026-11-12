import { useEffect, useRef, useState } from 'react'
import type { TurnAuthStatus } from '../../../../shared/turnAuth'
import '../../styles/remote-bp.css'
import SakuraSettings from './SakuraSettings'
import { networkSettings, useNetworkSettings } from '../../services/remoteBp/networkSettings'

export default function TurnAuthorizationDialog(): React.JSX.Element | null {
  const network = useNetworkSettings()
  const dialog = useRef<HTMLDialogElement>(null)
  const statusGeneration = useRef(0)
  const [open, setOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<TurnAuthStatus>({
    authorized: false,
    expiresAt: null,
    pendingRevocation: false,
    message: null
  })
  const run = async (action: () => Promise<TurnAuthStatus>): Promise<void> => {
    const generation = ++statusGeneration.current
    setBusy(true)
    try {
      const next = await action()
      if (generation === statusGeneration.current) setStatus(next)
    } catch {
      setStatus((current) => ({ ...current, message: '无法访问授权服务或安全存储，请稍后重试' }))
    } finally {
      setPassword('')
      setBusy(false)
    }
  }
  useEffect(() => {
    void networkSettings.initialize()
    return window.bpAPI.turnAuth.onOpen(() => setOpen(true))
  }, [])
  useEffect(() => {
    if (!open) return
    dialog.current?.showModal()
    void networkSettings.initialize()
  }, [open])
  useEffect(() => {
    if (!open || !network.ready || network.settings.mode !== 'webrtc') return
    let live = true
    const generation = ++statusGeneration.current
    void window.bpAPI.turnAuth.status().then(
      (next) => {
        if (live && generation === statusGeneration.current) setStatus(next)
      },
      () => {
        if (live && generation === statusGeneration.current)
          setStatus((current) => ({ ...current, message: '无法读取 TURN 授权状态，请稍后重试' }))
      }
    )
    return () => {
      live = false
    }
  }, [open, network.ready, network.settings.mode])
  useEffect(() => {
    if (!open || !status.authorized || !status.expiresAt) return
    const timer = window.setTimeout(
      () => {
        setStatus((current) =>
          current.authorized && (current.expiresAt ?? 0) <= Date.now()
            ? { ...current, authorized: false, message: '授权已过期，请重新输入密码' }
            : current
        )
      },
      Math.max(0, status.expiresAt - Date.now())
    )
    return () => window.clearTimeout(timer)
  }, [open, status.authorized, status.expiresAt])
  if (!open) return null
  const close = (): void => {
    if (!busy) {
      dialog.current?.close()
      setOpen(false)
      setPassword('')
    }
  }
  return (
    <dialog
      ref={dialog}
      className="turn-auth-dialog"
      aria-labelledby="turn-auth-title"
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
    >
      <header>
        <h2 id="turn-auth-title">远程 BP 网络设置</h2>
        <button type="button" aria-label="关闭" disabled={busy} onClick={close}>
          ×
        </button>
      </header>
      <label className="remote-bp-mode">
        连接模式
        <select
          aria-label="连接模式"
          value={network.settings.mode}
          disabled={!network.ready || network.busy || busy || network.roomOpen}
          onChange={(event) => {
            setPassword('')
            void networkSettings.configure({
              ...network.settings,
              mode: event.target.value as 'webrtc' | 'sakura'
            })
          }}
        >
          <option value="webrtc">WebRTC（STUN/TURN）</option>
          <option value="sakura">内网穿透（SakuraFrp）</option>
        </select>
      </label>
      {network.roomOpen && (
        <p role="status" className="network-help">
          请先关闭当前远程房间，再切换模式或修改网络配置。BP 进度不受影响。
        </p>
      )}
      {network.error && (
        <p role="alert" className="remote-bp-error">
          {network.error}
        </p>
      )}
      {!network.ready ? (
        <p>正在读取网络配置…</p>
      ) : network.settings.mode === 'sakura' ? (
        <SakuraSettings key={`${network.settings.publicUrl}:${network.settings.localPort}`} />
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            const value = password
            setPassword('')
            void run(() => window.bpAPI.turnAuth.authorize(value))
          }}
        >
          <p className="network-help">
            优先尝试 P2P 直连；连接失败且获得 TURN 授权时，可使用中继。
          </p>
          <p>
            状态：
            <strong>
              {status.pendingRevocation
                ? '本机已停用 · 等待服务器撤销'
                : status.authorized
                  ? '已授权'
                  : '未授权'}
            </strong>
          </p>
          <p>有效期：{status.expiresAt ? new Date(status.expiresAt).toLocaleString() : '—'}</p>
          <label htmlFor="turn-password">授权密码</label>
          <input
            id="turn-password"
            type="password"
            autoFocus
            autoComplete="off"
            maxLength={256}
            value={password}
            disabled={busy}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="输入 TURN 授权密码"
          />
          {status.message && (
            <p role="status" className="turn-auth-message">
              {status.message}
            </p>
          )}
          <footer>
            <button type="submit" className="primary" disabled={busy || !password}>
              {busy ? '处理中…' : '验证并授权'}
            </button>
            <button
              type="button"
              disabled={
                busy || (!status.authorized && !status.pendingRevocation && !status.expiresAt)
              }
              onClick={() => void run(() => window.bpAPI.turnAuth.revoke())}
            >
              退出授权
            </button>
            <button type="button" disabled={busy} onClick={close}>
              关闭
            </button>
          </footer>
        </form>
      )}
    </dialog>
  )
}
