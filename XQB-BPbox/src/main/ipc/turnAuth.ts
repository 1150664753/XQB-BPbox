import { app, BrowserWindow, ipcMain, safeStorage } from 'electron'
import { join } from 'node:path'
import { isMainWebContents } from '../windows'
import { TurnAuthStore, type StoredTurnAuth } from '../remoteBp/turnAuthStore'
import type { TurnAuthStatus } from '../../shared/turnAuth'

export function registerTurnAuthIpc(): void {
  const base = new URL(
    !app.isPackaged && process.env.XQB_TURN_AUTH_URL
      ? process.env.XQB_TURN_AUTH_URL
      : 'https://signal.xqbbp.dpdns.org'
  )
  if (
    base.protocol !== 'https:' &&
    (app.isPackaged || !['localhost', '127.0.0.1'].includes(base.hostname))
  )
    throw new Error('TURN 授权接口必须使用 HTTPS')
  const encryption = {
    isEncryptionAvailable: () =>
      safeStorage.isEncryptionAvailable() &&
      (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
    encryptString: (text: string) => safeStorage.encryptString(text),
    decryptString: (buffer: Buffer) => safeStorage.decryptString(buffer)
  }
  const store = new TurnAuthStore(
    join(app.getPath('userData'), 'turn-authorization.bin'),
    encryption
  )
  let stored: StoredTurnAuth | null = null
  let loadError: string | null = null
  try {
    stored = store.read()
  } catch (error) {
    loadError = (error as Error).message
  }
  let chain: Promise<unknown> = Promise.resolve()
  const notify = (): void => {
    for (const window of BrowserWindow.getAllWindows())
      if (isMainWebContents(window.webContents)) window.webContents.send('turn-auth:changed')
  }
  const status = (message: string | null = null): TurnAuthStatus => ({
    authorized: Boolean(
      stored?.token && !stored.pendingRevocation && (stored.expiresAt ?? 0) > Date.now()
    ),
    expiresAt: stored?.expiresAt ?? null,
    pendingRevocation: stored?.pendingRevocation ?? false,
    message:
      message ??
      loadError ??
      (stored?.token && (stored.expiresAt ?? 0) <= Date.now() ? '授权已过期，请重新输入密码' : null)
  })
  const request = async (path: string, body?: object): Promise<Record<string, unknown>> => {
    let response: Response
    try {
      response = await fetch(new URL(path, base), {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(8_000),
        headers: {
          'Content-Type': 'application/json',
          ...(body ? {} : { Authorization: `Bearer ${stored?.token ?? ''}` })
        },
        ...(body ? { body: JSON.stringify(body) } : {})
      })
    } catch {
      throw new Error('授权服务网络异常，请检查网络后重试')
    }
    let data: Record<string, unknown>
    try {
      data = (await response.json()) as Record<string, unknown>
    } catch {
      throw new Error('授权服务返回无效响应')
    }
    if (!response.ok) {
      const code = data.error
      if (code === 'TURN_AUTH_EXPIRED' || code === 'TURN_TOKEN_INVALID') {
        if (stored) {
          stored.token = null
          stored.pendingRevocation = false
          store.write(stored)
          notify()
        }
      }
      const messages: Record<string, string> = {
        TURN_PASSWORD_INVALID: '授权密码错误',
        TURN_AUTH_EXPIRED: '授权已过期，请重新输入密码',
        TURN_TOKEN_INVALID: '授权已撤销或令牌无效，请重新授权',
        TURN_RATE_LIMITED: '验证过于频繁，请稍后重试',
        TURN_AUTH_NOT_CONFIGURED: 'Worker 尚未配置授权密码或签名密钥'
      }
      throw new Error(messages[String(code)] ?? `授权服务暂不可用（HTTP ${response.status}）`)
    }
    return data
  }
  const revoke = async (): Promise<TurnAuthStatus> => {
    if (!stored?.token) return status()
    stored.pendingRevocation = true
    store.write(stored)
    notify()
    try {
      await request('/turn/revoke')
      stored.token = null
      stored.expiresAt = null
      stored.pendingRevocation = false
      store.write(stored)
      notify()
      return status('授权已撤销。已签发的 WTN 凭证仍按原 TTL 到期失效。')
    } catch (error) {
      return status(
        `本机已停用 TURN，服务器撤销尚未确认；恢复网络后自动重试。${(error as Error).message}`
      )
    }
  }
  const handlers = {
    status: async (): Promise<TurnAuthStatus> => {
      if (stored?.pendingRevocation) return revoke()
      if (!status().authorized) return status()
      try {
        const data = await request('/turn/status')
        return status(
          data.providerConfigured ? null : '已授权，但 Worker 尚未配置 WTN AppKey；当前仅 P2P 可用'
        )
      } catch (error) {
        return status((error as Error).message)
      }
    },
    authorize: async (password: unknown): Promise<TurnAuthStatus> => {
      if (typeof password !== 'string' || !password || password.length > 256)
        return status('请输入有效密码')
      if (!encryption.isEncryptionAvailable()) return status('系统安全存储不可用，无法保存授权')
      if (stored?.pendingRevocation) {
        await revoke()
        if (stored.pendingRevocation) return status('请先完成服务器授权撤销')
      }
      if (!stored)
        stored = {
          hostId: crypto.randomUUID(),
          token: null,
          expiresAt: null,
          pendingRevocation: false
        }
      try {
        const data = await request('/turn/authorize', { hostId: stored.hostId, password })
        if (
          typeof data.token !== 'string' ||
          data.token.length > 2048 ||
          !Number.isFinite(data.expiresAt) ||
          Number(data.expiresAt) <= Date.now()
        )
          throw new Error('授权服务返回无效令牌')
        stored = {
          ...stored,
          token: data.token,
          expiresAt: Number(data.expiresAt),
          pendingRevocation: false
        }
        store.write(stored)
        loadError = null
        notify()
        return status('授权成功，有效期 7 天')
      } catch (error) {
        return status((error as Error).message)
      }
    },
    revoke,
    binding: async (signalingUrl: unknown): Promise<string | null> => {
      if (typeof signalingUrl !== 'string') return null
      const url = new URL(signalingUrl)
      const expected = base.protocol === 'https:' ? 'wss:' : 'ws:'
      if (
        url.protocol !== expected ||
        url.host !== base.host ||
        url.username ||
        url.password ||
        !status().authorized
      )
        return null
      return stored?.token ?? null
    }
  }
  for (const [name, handler] of Object.entries(handlers))
    ipcMain.handle(`turn-auth:${name}`, (event, arg: unknown) => {
      if (!isMainWebContents(event.sender) || event.senderFrame !== event.sender.mainFrame)
        throw new Error('无权访问房主授权')
      const next = chain.catch(() => undefined).then<unknown>(() => handler(arg))
      chain = next
      return next
    })
  const retry = setInterval(() => {
    if (stored?.pendingRevocation) chain = chain.catch(() => undefined).then(revoke)
  }, 30_000)
  retry.unref()
}
