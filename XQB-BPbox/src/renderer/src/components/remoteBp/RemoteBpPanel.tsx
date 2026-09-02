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
  empty: '等待加入',
  connecting: '连接中',
  connected: '已连接',
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
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle')

  useEffect(() => host.subscribe(setRoom), [host])

  useEffect(() => {
    setCopyState('idle')
  }, [room.roomId])

  useEffect(() => {
    if (copyState === 'idle') return

    const timeoutId = window.setTimeout(() => setCopyState('idle'), 1800)
    return () => window.clearTimeout(timeoutId)
  }, [copyState])

  const copyRoomCode = async (): Promise<void> => {
    if (!room.roomId) return

    try {
      await writeClipboardText(room.roomId)
      setCopyState('copied')
    } catch {
      setCopyState('error')
    }
  }

  const isActive = room.lifecycle === 'active'
  const isBusy = room.lifecycle === 'starting' || room.lifecycle === 'stopping'

  return (
    <section className="bp-session-card remote-bp-card">
      <header>
        <span>远程 BP</span>
        <div className="remote-bp-room-code-row">
          <strong>{room.roomId ?? '未创建房间'}</strong>
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
        <small>
          {isActive
            ? room.transport === 'mock'
              ? 'Mock 已启动'
              : '远程房间已启动'
            : lifecycleLabel[room.lifecycle]}
        </small>
      </header>

      <div className="remote-bp-status-grid">
        <span>先手：{playerStateLabel[room.firstPlayer.connectionState]}</span>
        <span>后手：{playerStateLabel[room.secondPlayer.connectionState]}</span>
        <span>Revision：{room.lastPublishedRevision ?? '—'}</span>
        <span>资源：{room.assetCount}</span>
        <span>信令：{signalingStateLabel[room.connectionState]}</span>
        <span>
          失效时间：{room.expiresAt ? new Date(room.expiresAt).toLocaleTimeString() : '—'}
        </span>
      </div>

      {room.error ? <small className="remote-bp-error">{room.error}</small> : null}
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
        <button type="button" disabled={!isActive || isBusy} onClick={() => void host.stopRoom()}>
          关闭房间
        </button>
      </div>
    </section>
  )
}
