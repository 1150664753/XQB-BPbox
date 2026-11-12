import { app, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { join } from 'node:path'
import { isMainWebContents } from '../windows'
import { SakuraManager } from '../remoteBp/SakuraManager'
import type { SakuraConfig } from '../../shared/sakura'
import type { RemoteHostOutgoingMessage } from '../../shared/remoteBp/transport'

export function registerSakuraIpc(): void {
  let owner: WebContents | null = null
  const manager = new SakuraManager(
    join(app.getPath('userData'), 'sakura'),
    (status) => {
      if (owner && !owner.isDestroyed()) owner.send('sakura:status', status)
    },
    (event) => {
      if (owner && !owner.isDestroyed()) owner.send('sakura:event', event)
    }
  )
  function authorize(event: IpcMainInvokeEvent): void {
    if (!isMainWebContents(event.sender) || event.senderFrame !== event.sender.mainFrame)
      throw new Error('仅主窗口可管理樱花连接')
    if (owner !== event.sender) {
      owner = event.sender
      owner.once('destroyed', () => {
        owner = null
        void manager.stop()
      })
      owner.on('render-process-gone', () => {
        void manager.stop()
      })
      owner.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace) void manager.stop()
      })
    }
  }
  function handle(channel: string, callback: (...args: never[]) => unknown): void {
    ipcMain.handle(`sakura:${channel}`, (event, ...args) => {
      authorize(event)
      return callback(...(args as never[]))
    })
  }
  handle('settings', () => manager.settings())
  handle('configure', (config: SakuraConfig) => manager.configure(config))
  handle('start-service', () => manager.startService())
  handle('stop-service', () => manager.stopService())
  handle('status', () => manager.status())
  handle('start', () => manager.start())
  handle('stop', () => manager.stop())
  handle('verify', () => manager.verify())
  handle('send', (roomId: string, peerId: string | null, message: RemoteHostOutgoingMessage) => {
    const room = manager.getRoom(roomId)
    return peerId ? room.send(peerId, message) : room.broadcast(message)
  })
  handle('kick', (roomId: string, side: 'first' | 'second') => manager.getRoom(roomId).kick(side))
  let quitting = false
  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    void manager.stop().finally(() => app.quit())
  })
}
