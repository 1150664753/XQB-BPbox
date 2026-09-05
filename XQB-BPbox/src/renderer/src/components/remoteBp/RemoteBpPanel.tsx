import { useEffect, useState } from 'react'

import {
  DEFAULT_REMOTE_SIDE_MAPPING,
  type RemoteBpHost,
  type RemoteBpRoomState
} from '../../../../shared/remoteBp'

async function writeClipboardText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // Electron/Windows may reject the Clipboard API in some renderer contexts.
    }
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()

  const copied = document.execCommand('copy')
  textarea.remove()

  if (!copied) {
    throw new Error('无法写入剪贴板')
  }
}

function createMockRoomId(): string {
  return `MOCK${Math.random().toString(36).slice(2, 8).toUpperCase()}`
}

const playerStateLabel: Record<RemoteBpRoomState['firstPlayer']['connectionState'], string> = {
  empty: '未连接',
  connecting: '连接中',
  connected: '已连接',
  reconnecting: '重连中',
  disconnected: '未连接'
}

const signalingStateLabel: Record<RemoteBpRoomState['connectionState'], string> = {
  offline: '未连接',
  connecting: '连接中',
  connected: '已连接',
  reconnecting: '重连中',
  disconnected: '已断开',
  failed: '连接失败',
  'mock-active': 'Mock 已连接'
}

const lifecycleLabel: Record<RemoteBpRoomState['lifecycle'], string> = {
  idle: '未创建',
  starting: '创建中',
  active: '已启动',
  stopping: '关闭中',
  error: '发生错误'
}

export default function RemoteBpPanel({ host }: { host: RemoteBpHost }): React.JSX.Element {
  const [room, setRoom] = useState<RemoteBpRoomState>(() => host.getRoomState())
  const [copyFeedback, setCopyFeedback] = useState<{
    roomId: string | null
    state: 'idle' | 'copied' | 'error'
  }>({ roomId: null, state: 'idle' })
  const copyState = copyFeedback.roomId === room.roomId ? copyFeedback.state : 'idle'

  useEffect(() => host.subscribe(setRoom), [host])

  useEffect(() => {
    if (copyState === 'idle') return

    const timeoutId = window.setTimeout(
      () => setCopyFeedback({ roomId: room.roomId, state: 'idle' }),
      1800
    )
    return () => window.clearTimeout(timeoutId)
  }, [copyState, room.roomId])

  const copyRoomCode = async (): Promise<void> => {
    if (!room.roomId) return

    try {
      await writeClipboardText(room.roomId)
      setCopyFeedback({ roomId: room.roomId, state: 'copied' })
    } catch {
      setCopyFeedback({ roomId: room.roomId, state: 'error' })
    }
  }

  const isActive = room.lifecycle === 'active'
  const isBusy = room.lifecycle === 'starting' || room.lifecycle === 'stopping'

  const playerRow = (side: 'first' | 'second'): React.JSX.Element => {
    const player = side === 'first' ? room.firstPlayer : room.secondPlayer
    const occupied = player.peerId !== null
    return (
      <div className="remote-bp-player-row">
        <strong>{side === 'first' ? '先手' : '后手'}</strong>
        <span className={`remote-bp-player-state is-${player.connectionState}`}>
          <i aria-hidden="true" />
          {playerStateLabel[player.connectionState]}
        </span>
        <button
          type="button"
          className="remote-bp-kick-button"
          disabled={!isActive || !occupied || isBusy}
          onClick={() => void host.kickPlayer(side)}
          title={`踢出${side === 'first' ? '先手' : '后手'}`}
          aria-label={`踢出${side === 'first' ? '先手' : '后手'}`}
        >
          ×
        </button>
      </div>
    )
  }

  return (
    <section className="bp-session-card remote-bp-card">
      <header className="bp-card-header remote-bp-header">
        <h2>远程 BP</h2>
        <span className={`remote-bp-lifecycle is-${room.lifecycle}`}>
          {lifecycleLabel[room.lifecycle]}
        </span>
      </header>

      <div className="remote-bp-room-code-row">
        <span>房间</span>
        <strong>{room.roomId ?? '未创建'}</strong>
        <div className="remote-bp-room-actions">
          {room.roomId ? (
            <button
              type="button"
              className="remote-bp-copy-button"
              onClick={() => void copyRoomCode()}
              title={`复制房间码 ${room.roomId}`}
            >
              {copyState === 'copied' ? '已复制' : copyState === 'error' ? '复制失败' : '复制'}
            </button>
          ) : null}
        </div>
      </div>

      <div className="remote-bp-metrics">
        <span>Revision</span>
        <strong>{room.lastPublishedRevision ?? '—'}</strong>
        <span>资源</span>
        <strong>{room.assetCount}</strong>
        <span>信令</span>
        <strong>{signalingStateLabel[room.connectionState]}</strong>
      </div>

      <div className="remote-bp-players">
        {playerRow('first')}
        {playerRow('second')}
      </div>

      {room.error ? <small className="remote-bp-error">{room.error}</small> : null}
      <small className="remote-bp-lifetime">房间寿命：由房主控制</small>
      <div className="bp-card-actions">
        <button
          type="button"
          className="primary"
          disabled={isActive || isBusy}
          onClick={() =>
            void host.startRoom({
              ...(room.transport === 'mock' ? { roomId: createMockRoomId() } : {}),
              mapping: DEFAULT_REMOTE_SIDE_MAPPING
            })
          }
        >
          {room.transport === 'mock' ? '开启 Mock 房间' : '创建远程 BP'}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={!isActive || isBusy}
          onClick={() => void host.stopRoom()}
        >
          关闭房间
        </button>
      </div>
    </section>
  )
}
