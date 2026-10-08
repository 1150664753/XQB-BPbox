import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

export interface StoredTurnAuth {
  hostId: string
  token: string | null
  expiresAt: number | null
  pendingRevocation: boolean
}
interface Encryption {
  isEncryptionAvailable: () => boolean
  encryptString: (value: string) => Buffer
  decryptString: (value: Buffer) => string
}
// No plaintext fallback. Electron safeStorage uses Windows DPAPI on the target platform.
export class TurnAuthStore {
  constructor(
    private path: string,
    private encryption: Encryption
  ) {}
  read(): StoredTurnAuth {
    if (!existsSync(this.path))
      return { hostId: randomUUID(), token: null, expiresAt: null, pendingRevocation: false }
    if (!this.encryption.isEncryptionAvailable())
      throw new Error('系统安全存储不可用，无法读取 TURN 授权')
    try {
      const value = JSON.parse(
        this.encryption.decryptString(readFileSync(this.path))
      ) as StoredTurnAuth
      if (
        !/^[0-9a-f-]{36}$/.test(value.hostId) ||
        (value.token !== null && typeof value.token !== 'string') ||
        (value.expiresAt !== null && !Number.isFinite(value.expiresAt)) ||
        typeof value.pendingRevocation !== 'boolean'
      )
        throw new Error()
      return value
    } catch {
      throw new Error('TURN 授权存储损坏或无法解密，请重新授权')
    }
  }
  write(value: StoredTurnAuth): void {
    if (!this.encryption.isEncryptionAvailable())
      throw new Error('系统安全存储不可用，无法保存 TURN 授权')
    writeFileSync(`${this.path}.tmp`, this.encryption.encryptString(JSON.stringify(value)), {
      mode: 0o600
    })
    renameSync(`${this.path}.tmp`, this.path)
  }
}
