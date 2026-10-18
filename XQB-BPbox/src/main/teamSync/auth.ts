import { app, net, safeStorage, shell } from 'electron'
import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

interface DeviceCode {
  clientId: string
  code: string
  expiresAt: number
  interval: number
  nextPoll: number
}
let device: DeviceCode | undefined
function tokenPath(): string {
  return join(app.getPath('userData'), 'team-github-auth.bin')
}
/** Only the main process may consume token; expose problem/presence to diagnostics. */
export function githubAuthorization(clientId: string): { token: string; problem?: string } {
  if (!safeStorage.isEncryptionAvailable())
    return { token: '', problem: '系统安全凭据存储不可用，无法读取 GitHub 授权' }
  if (!existsSync(tokenPath())) return { token: '', problem: '本机未保存 GitHub 授权，请先授权' }
  try {
    const value = JSON.parse(safeStorage.decryptString(readFileSync(tokenPath())))
    if (value.clientId !== clientId)
      return {
        token: '',
        problem: '已保存授权与当前 OAuth App Client ID 不匹配，请使用当前配置重新授权'
      }
    if (typeof value.token !== 'string' || !value.token.trim())
      return { token: '', problem: '本机 GitHub 授权内容无效，请重新授权' }
    return { token: value.token.trim() }
  } catch {
    return { token: '', problem: '无法解密或读取本机 GitHub 授权，请重新授权' }
  }
}
export function githubToken(clientId: string): string {
  return githubAuthorization(clientId).token
}
export function logoutGitHub(): void {
  device = undefined
  if (existsSync(tokenPath())) unlinkSync(tokenPath())
}
async function oauth(
  path: string,
  fields: Record<string, string>
): Promise<Record<string, unknown>> {
  let response: Response
  try {
    response = await net.fetch(`https://github.com/login/${path}`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString()
    })
  } catch {
    throw new Error('GitHub 授权请求失败，请检查网络后重试')
  }
  if (!response.ok) throw new Error(`GitHub 授权请求失败（${response.status}）`)
  return response.json()
}
export async function authorizeGitHub(
  clientId: string
): Promise<{ userCode: string; verificationUri: string; expiresAt: number }> {
  if (!/^[a-zA-Z0-9_.-]{6,100}$/.test(clientId))
    throw new Error('请先填写启用了 Device Flow 的 GitHub OAuth App Client ID')
  if (
    !safeStorage.isEncryptionAvailable() ||
    safeStorage.getSelectedStorageBackend?.() === 'basic_text'
  )
    throw new Error('系统安全凭据存储不可用，无法保存 GitHub 授权')
  const value = await oauth('device/code', { client_id: clientId, scope: 'repo' })
  if (
    typeof value.device_code !== 'string' ||
    typeof value.user_code !== 'string' ||
    !Number.isFinite(value.expires_in)
  )
    throw new Error('设备授权未启用或 Client ID 不正确，请检查 GitHub OAuth App 设置')
  device = {
    clientId,
    code: value.device_code,
    expiresAt: Date.now() + Number(value.expires_in) * 1000,
    interval: Math.max(5, Number(value.interval) || 5) * 1000,
    nextPoll: 0
  }
  const verificationUri = 'https://github.com/login/device'
  await shell.openExternal(verificationUri)
  return { userCode: value.user_code, verificationUri, expiresAt: device.expiresAt }
}
export async function pollGitHub(clientId: string): Promise<'pending' | 'authorized'> {
  const current = device
  if (!current || current.clientId !== clientId || Date.now() >= current.expiresAt) {
    device = undefined
    throw new Error('设备授权已过期，请重新授权')
  }
  if (Date.now() < current.nextPoll) return 'pending'
  current.nextPoll = Date.now() + current.interval
  const value = await oauth('oauth/access_token', {
    client_id: clientId,
    device_code: current.code,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
  })
  if (device !== current) throw new Error('设备授权已取消')
  if (value.error === 'authorization_pending') return 'pending'
  if (value.error === 'slow_down') {
    current.interval += 5000
    current.nextPoll = Date.now() + current.interval
    return 'pending'
  }
  if (typeof value.access_token !== 'string') {
    device = undefined
    throw new Error('GitHub 授权被拒绝或已过期，请重新授权')
  }
  if (typeof value.scope === 'string' && !value.scope.split(/[,\s]+/).includes('repo')) {
    device = undefined
    throw new Error(
      'GitHub 授权未授予 repo scope，无法访问私有资源仓库；请重新授权并允许 repo 权限'
    )
  }
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(
    tokenPath(),
    safeStorage.encryptString(JSON.stringify({ clientId, token: value.access_token }))
  )
  device = undefined
  return 'authorized'
}
