import { useEffect, useRef, useState } from 'react'
import type { TurnAuthStatus } from '../../../../shared/turnAuth'
import '../../styles/remote-bp.css'
import { getRtcDiagnostics } from '../../../../../../shared/remoteBpRtc'

export default function TurnAuthorizationDialog(): React.JSX.Element | null {
  const dialog = useRef<HTMLDialogElement>(null)
  const [open, setOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [connections, setConnections] = useState(getRtcDiagnostics)
  const [status, setStatus] = useState<TurnAuthStatus>({
    authorized: false,
    expiresAt: null,
    pendingRevocation: false,
    message: null
  })
  const run = async (action: () => Promise<TurnAuthStatus>): Promise<void> => {
    setBusy(true)
    try {
      setStatus(await action())
    } catch {
      setStatus((current) => ({ ...current, message: '无法访问授权服务或安全存储，请稍后重试' }))
    } finally {
      setPassword('')
      setBusy(false)
    }
  }
  useEffect(() => window.bpAPI.turnAuth.onOpen(() => setOpen(true)), [])
  useEffect(() => {
    if (!open) return
    dialog.current?.showModal()
    void run(() => window.bpAPI.turnAuth.status())
    const timer = window.setInterval(() => {
      setConnections(getRtcDiagnostics())
      setStatus((current) =>
        current.authorized && (current.expiresAt ?? 0) <= Date.now()
          ? { ...current, authorized: false, message: '授权已过期，请重新输入密码' }
          : current
      )
    }, 1_000)
    return () => window.clearInterval(timer)
  }, [open])
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
      <form
        onSubmit={(event) => {
          event.preventDefault()
          const value = password
          setPassword('')
          void run(() => window.bpAPI.turnAuth.authorize(value))
        }}
      >
        <header>
          <h2 id="turn-auth-title">TURN 授权</h2>
          <button type="button" aria-label="关闭" disabled={busy} onClick={close}>
            ×
          </button>
        </header>
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
        <p className="turn-auth-hint">
        </p>
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
        {connections.length > 0 && (
          <details>
            <summary>连接诊断</summary>
            {connections.map((connection, index) => (
              <p key={connection.connectionId} className="turn-auth-hint">
                连接 {index + 1}：ICE {connection.iceState} ·{' '}
                {connection.pair ?? '尚未选中 candidate pair'} · relay{' '}
                {connection.relay ? '是' : '否'}
                <br />
                凭证：{connection.turn}{' '}
                {connection.expiresAt
                  ? `· 到期 ${new Date(connection.expiresAt).toLocaleTimeString()}`
                  : ''}
                <br />
                {connection.reason ?? '无错误'}
              </p>
            ))}
          </details>
        )}
      </form>
    </dialog>
  )
}
