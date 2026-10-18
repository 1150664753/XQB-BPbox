import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
  constants
} from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { randomUUID } from 'node:crypto'
import { relativeResourcePath, ResourcePathPlan } from './resourcePaths'

export function backupResourceConfig(root: string, path: string, backupRoot: string): void {
  if (!existsSync(path)) return
  const target = join(backupRoot, relativeResourcePath(root, path))
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(path, target, constants.COPYFILE_EXCL)
}
export function pathBackupDirectory(root: string): string {
  return join(
    root,
    '.resource-path-backups',
    `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
  )
}
export function writeResourceJsonAtomic(path: string, value: unknown): void {
  const temp = `${path}.${randomUUID()}.tmp`
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  renameSync(temp, path)
}
export function migrateResourcePaths(root: string, legacyRoots: string[], apply = false): object {
  const plan = new ResourcePathPlan(root, legacyRoots)
  const files = [
    'config/app/characters.json',
    'config/app/light-cones.json',
    'config/app/character-resource-table.json'
  ]
  for (const directory of ['config/display', 'config/bp', 'config/audio', 'results/bp']) {
    if (existsSync(join(root, directory)))
      for (const entry of readdirSync(join(root, directory), { withFileTypes: true }))
        if (entry.isFile() && entry.name.endsWith('.json')) files.push(`${directory}/${entry.name}`)
  }
  const updates: { path: string; original: string; value: unknown }[] = []
  for (const file of files) {
    const path = join(root, file)
    if (!existsSync(path)) continue
    const original = readFileSync(path, 'utf8')
    let value: unknown
    try {
      value = JSON.parse(original)
    } catch {
      plan.issues.push({ field: file, value: file, reason: '配置不是有效 JSON，保留原文件' })
      continue
    }
    const converted = plan.document(value, undefined, false, file)
    if (JSON.stringify(value) !== JSON.stringify(converted))
      updates.push({ path, original, value: converted })
  }
  // Referenced legacy configurations are copied verbatim first, then their own
  // resource fields are converted with the same rules and backed up before writing.
  const imported = new Set<string>()
  for (const copy of plan.copies.values()) {
    const file = relative(root, copy.target).replace(/\\/g, '/')
    if (!file.startsWith('config/bp/') || !file.endsWith('.json') || imported.has(file)) continue
    imported.add(file)
    const original = readFileSync(copy.source, 'utf8')
    let value: unknown
    try {
      value = JSON.parse(original)
    } catch {
      plan.issues.push({
        field: file,
        value: file,
        reason: '旧配置不是有效 JSON，复制后保持原内容'
      })
      continue
    }
    const converted = plan.document(value, undefined, false, file)
    if (JSON.stringify(value) !== JSON.stringify(converted))
      updates.push({ path: copy.target, original, value: converted })
  }
  const backup = apply ? pathBackupDirectory(root) : null
  const report = {
    root,
    legacyRoots,
    applied: apply,
    backupDirectory: backup,
    scannedFiles: [
      ...new Set([...files.filter((file) => existsSync(join(root, file))), ...imported])
    ],
    changedFiles: updates.map((update) => relative(root, update.path).replace(/\\/g, '/')),
    importedConfigurations: [...imported],
    copies: [...plan.copies.values()],
    copiedBytes: [...plan.copies.values()].reduce((sum, item) => sum + item.size, 0),
    issues: plan.issues
  }
  if (backup) {
    mkdirSync(backup, { recursive: true })
    // Back up every changing document before any copies or configuration writes.
    for (const update of updates) {
      if (!existsSync(update.path)) continue // New legacy copy is backed up after copying below.
      if (readFileSync(update.path, 'utf8') !== update.original)
        throw new Error(`配置已变化，停止转换：${update.path}`)
      backupResourceConfig(root, update.path, backup)
    }
    writeResourceJsonAtomic(join(backup, 'report.json'), { ...report, applied: false })
    plan.applyCopies()
    for (const update of updates) {
      if (readFileSync(update.path, 'utf8') !== update.original)
        throw new Error(`配置已变化，停止转换：${update.path}`)
      if (imported.has(relative(root, update.path).replace(/\\/g, '/')))
        backupResourceConfig(root, update.path, backup)
      writeResourceJsonAtomic(update.path, update.value)
    }
    writeResourceJsonAtomic(join(backup, 'report.json'), report)
  }
  return report
}
