import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import type { UpdateState } from '../../../shared/updater'

const initialState: UpdateState = {
  status: 'idle',
  currentVersion: ''
}

function statusText(state: UpdateState, deferred: boolean): string {
  if (deferred && state.status === 'downloaded') {
    return `v${state.availableVersion ?? ''} 已下载，将在退出软件后安装`
  }

  return state.message ?? '可手动检查程序更新'
}

function UpdateStatusBar(): React.JSX.Element {
  const [state, setState] = useState<UpdateState>(initialState)
  const [actionPending, setActionPending] = useState(false)
  const [deferred, setDeferred] = useState(false)
  const [localError, setLocalError] = useState('')
  const [visible, setVisible] = useState(false)
  const dismissedRef = useRef(false)

  const applyState = useCallback((nextState: UpdateState): void => {
    setState(nextState)
    setLocalError('')

    if (nextState.status !== 'downloaded') {
      setDeferred(false)
    }

    if (
      nextState.status === 'idle' ||
      nextState.status === 'disabled' ||
      nextState.status === 'up-to-date'
    ) {
      setVisible(false)
      return
    }

    if (!dismissedRef.current) {
      setVisible(true)
    }
  }, [])

  useEffect(() => {
    let disposed = false

    window.bpAPI.updater
      .getState()
      .then((nextState) => {
        if (!disposed) {
          applyState(nextState)
        }
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setLocalError(error instanceof Error ? error.message : String(error))
          setVisible(true)
        }
      })

    const unsubscribe = window.bpAPI.updater.onState((nextState) => {
      applyState(nextState)
    })

    return () => {
      disposed = true
      unsubscribe()
    }
  }, [applyState])

  const runStateAction = useCallback(
    async (action: () => Promise<UpdateState>): Promise<void> => {
      setActionPending(true)
      setLocalError('')
      try {
        applyState(await action())
      } catch (error) {
        setLocalError(error instanceof Error ? error.message : String(error))
      } finally {
        setActionPending(false)
      }
    },
    [applyState]
  )

  const openOrCheck = useCallback(async (): Promise<void> => {
    dismissedRef.current = false
    setVisible(true)

    if (state.status === 'idle' || state.status === 'up-to-date' || state.status === 'error') {
      await runStateAction(window.bpAPI.updater.checkForUpdates)
    }
  }, [runStateAction, state.status])

  const close = useCallback((): void => {
    dismissedRef.current = true
    setVisible(false)
  }, [])

  const deferInstall = useCallback((): void => {
    setDeferred(true)
    close()
  }, [close])

  const install = useCallback(async (): Promise<void> => {
    setActionPending(true)
    setLocalError('')
    try {
      const accepted = await window.bpAPI.updater.installUpdate()
      if (!accepted) {
        setLocalError('更新尚未下载完成')
        setActionPending(false)
      } else {
        setVisible(false)
      }
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error))
      setActionPending(false)
    }
  }, [])

  const busy = actionPending || state.status === 'checking' || state.status === 'downloading'
  const message = localError ? `更新失败：${localError}` : statusText(state, deferred)
  const noticeTone = state.status === 'error' || localError ? 'error' : state.status

  return (
    <>
      <button
        type="button"
        className="update-check-trigger"
        disabled={state.status === 'disabled'}
        title={state.status === 'disabled' ? '开发环境不执行自动更新' : '检查更新'}
        aria-label="检查更新"
        onClick={() => void openOrCheck()}
      >
        <span aria-hidden="true">↻</span>
      </button>
      {visible
        ? createPortal(
            <section
              className={`update-notice update-notice-${noticeTone}`}
              role="status"
              aria-live="polite"
            >
              <header className="update-notice-header">
                <div>
                  <strong>程序更新</strong>
                  <span>当前版本 v{state.currentVersion || '—'}</span>
                </div>
                <button
                  type="button"
                  className="update-notice-close"
                  title="关闭"
                  aria-label="关闭更新提示"
                  onClick={close}
                >
                  ×
                </button>
              </header>
              <div className="update-notice-message">{message}</div>
              {state.status === 'downloading' ? (
                <div className="update-progress-track" aria-hidden="true">
                  <div
                    className="update-progress-value"
                    style={{ width: `${state.progress?.percent ?? 0}%` }}
                  />
                </div>
              ) : null}
              <div className="update-notice-actions">
                {state.status === 'available' ? (
                  <button
                    type="button"
                    className="primary"
                    disabled={actionPending}
                    onClick={() => void runStateAction(window.bpAPI.updater.downloadUpdate)}
                  >
                    下载 v{state.availableVersion}
                  </button>
                ) : null}
                {state.status === 'downloaded' ? (
                  <>
                    <button
                      type="button"
                      className="primary"
                      disabled={actionPending}
                      onClick={() => void install()}
                    >
                      立即重启更新
                    </button>
                    <button type="button" disabled={actionPending} onClick={deferInstall}>
                      稍后
                    </button>
                  </>
                ) : null}
                {state.status === 'error' || localError ? (
                  <button type="button" disabled={busy} onClick={() => void openOrCheck()}>
                    重新检查
                  </button>
                ) : null}
              </div>
            </section>,
            document.body
          )
        : null}
    </>
  )
}

export default UpdateStatusBar
