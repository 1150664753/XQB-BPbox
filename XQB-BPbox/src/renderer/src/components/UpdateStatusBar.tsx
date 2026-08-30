import { useCallback, useEffect, useState } from 'react'

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

  useEffect(() => {
    let disposed = false

    window.bpAPI.updater
      .getState()
      .then((nextState) => {
        if (!disposed) {
          setState(nextState)
        }
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setLocalError(error instanceof Error ? error.message : String(error))
        }
      })

    const unsubscribe = window.bpAPI.updater.onState((nextState) => {
      setState(nextState)
      setLocalError('')
      if (nextState.status !== 'downloaded') {
        setDeferred(false)
      }
    })

    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])

  const runStateAction = useCallback(async (action: () => Promise<UpdateState>): Promise<void> => {
    setActionPending(true)
    setLocalError('')
    try {
      setState(await action())
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error))
    } finally {
      setActionPending(false)
    }
  }, [])

  const install = useCallback(async (): Promise<void> => {
    setActionPending(true)
    setLocalError('')
    try {
      const accepted = await window.bpAPI.updater.installUpdate()
      if (!accepted) {
        setLocalError('更新尚未下载完成')
        setActionPending(false)
      }
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error))
      setActionPending(false)
    }
  }, [])

  const busy = actionPending || state.status === 'checking' || state.status === 'downloading'
  const checkDisabled =
    busy ||
    state.status === 'disabled' ||
    state.status === 'available' ||
    state.status === 'downloaded'
  const message = localError ? `更新失败：${localError}` : statusText(state, deferred)

  return (
    <footer className="status-bar update-status-bar" aria-live="polite">
      <span>程序版本：v{state.currentVersion || '—'}</span>
      <button
        type="button"
        disabled={checkDisabled}
        onClick={() => void runStateAction(window.bpAPI.updater.checkForUpdates)}
      >
        {state.status === 'checking' ? '正在检查…' : '检查更新'}
      </button>
      {state.status === 'available' ? (
        <button
          type="button"
          disabled={actionPending}
          onClick={() => void runStateAction(window.bpAPI.updater.downloadUpdate)}
        >
          下载 v{state.availableVersion}
        </button>
      ) : null}
      {state.status === 'downloaded' ? (
        <div className="update-actions">
          <button type="button" disabled={actionPending} onClick={() => void install()}>
            立即重启更新
          </button>
          {!deferred ? (
            <button type="button" disabled={actionPending} onClick={() => setDeferred(true)}>
              稍后
            </button>
          ) : null}
        </div>
      ) : null}
      <span className={`message-line ${state.status === 'error' || localError ? 'error' : ''}`}>
        {message}
      </span>
    </footer>
  )
}

export default UpdateStatusBar
