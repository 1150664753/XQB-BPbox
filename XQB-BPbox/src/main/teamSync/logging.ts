import { app } from 'electron'
import { appendFileSync, mkdirSync, renameSync, statSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { redactDiagnostic } from './diagnostics'

export function teamSyncLogPath(): string {
  return join(app.getPath('logs'), 'team-sync.log')
}
export function logTeamSync(entry: object): void {
  const line = JSON.stringify({ time: new Date().toISOString(), ...entry }, (_key, value) =>
    typeof value === 'string' ? redactDiagnostic(value) : value
  )
  console.info('[TeamSync]', line)
  try {
    const path = teamSyncLogPath()
    mkdirSync(dirname(path), { recursive: true })
    if (existsSync(path) && statSync(path).size > 2 * 1024 * 1024)
      renameSync(path, `${path}.previous`)
    appendFileSync(path, line + '\n', 'utf8')
  } catch {
    // Console remains available if diagnostic storage is unavailable.
    console.warn('[TeamSync] 无法写入诊断日志')
  }
}
