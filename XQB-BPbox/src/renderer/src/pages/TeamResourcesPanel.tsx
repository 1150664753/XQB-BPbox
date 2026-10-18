import { useCallback, useEffect, useRef, useState } from 'react'
import { canPublishField, isDocumentResourceType } from '../../../shared/teamSync'
import type {
  ConflictChoice,
  ResourceDifference,
  ResourceRow,
  SyncDirection,
  SyncSnapshot,
  SyncProgress,
  TeamProfile,
  TeamRepository
} from '../../../shared/teamSync'
import '../styles/team-resources.css'

const statusLabels = {
  added: '新增',
  modified: '修改',
  deleted: '删除',
  conflict: '冲突',
  missing: '本地缺失 / 可恢复',
  unchanged: '无变化'
}
const emptyRepository: TeamRepository = { owner: '', repo: '', branch: 'main', clientId: '' }
const remoteLabels = {
  ready: '索引已就绪',
  empty: '空仓库，待初始化',
  uninitialized: '仓库待初始化',
  index_missing: '远程索引缺失',
  index_invalid: '索引格式损坏',
  network_error: '网络连接异常',
  permission_denied: '授权或权限不足',
  repository_unavailable: '仓库不存在或无权访问',
  branch_unavailable: '分支不存在或无权读取',
  rate_limited: 'GitHub 请求限流',
  remote_error: '远程检查失败'
}
const stageLabels: Record<SyncProgress['stage'], string> = {
  scanning: '扫描与比较',
  checking: '准备上传文件',
  validating: '校验初始化文件',
  uploading: '上传文件',
  committing: '创建提交',
  downloading: '下载文件',
  applying: '应用资源',
  completed: '完成',
  failed: '失败',
  cancelled: '已取消'
}
function defaultFields(
  row: ResourceRow,
  direction: SyncDirection,
  choice?: ConflictChoice
): string[] {
  const publish = direction === 'upload' && (!choice || choice === 'local')
  return (row.fields ?? [])
    .filter(
      (f) =>
        f.state !== 'excluded' &&
        (!publish || canPublishField(f)) &&
        f[publish ? 'upload' : 'download'] !== 'unchanged'
    )
    .map((f) => f.field)
}
function errorText(error: unknown): string {
  return error instanceof Error
    ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, '')
    : String(error)
}
function valueText(value: unknown): string {
  return value == null
    ? '—'
    : typeof value === 'object'
      ? JSON.stringify(value, null, 2)
      : String(value)
}
function differenceText(d: ResourceDifference, direction: SyncDirection): string {
  const from = direction === 'upload' ? d.remote : d.local
  const to = direction === 'upload' ? d.local : d.remote
  return `${d.label}${from == null ? '新增' : to == null ? '删除' : d.kind === 'file' ? '替换' : '修改'}`
}

function ResourceImage({
  token,
  id,
  side,
  field,
  alt
}: {
  token: string
  id: string
  side: 'local' | 'remote'
  field?: string
  alt: string
}): React.JSX.Element {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState('')
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let active = true
    let started = false
    const observer = new IntersectionObserver((entries) => {
      if (started || !entries.some((e) => e.isIntersecting)) return
      started = true
      window.bpAPI.teamSync
        .preview(token, id, side, field)
        .then((result) => {
          if (active) setUrl(result)
        })
        .catch((e) => {
          if (active) setError(errorText(e))
        })
    })
    if (host.current) observer.observe(host.current)
    return () => {
      active = false
      observer.disconnect()
    }
  }, [token, id, side, field])
  return (
    <div className="team-resource-image" ref={host} title={error || alt}>
      {url ? <img src={url} alt={alt} /> : <span>{error ? '预览不可用' : '无预览'}</span>}
    </div>
  )
}

function ResourceDetails({
  row,
  snapshot,
  direction,
  choice,
  onChoice,
  selectedFields,
  onField,
  paths,
  onPath,
  onImport,
  disabled
}: {
  row: ResourceRow
  snapshot: SyncSnapshot
  direction: SyncDirection
  choice?: ConflictChoice
  onChoice: (choice: ConflictChoice) => void
  selectedFields: string[]
  onField: (field: string, checked: boolean) => void
  paths: Record<string, string>
  onPath: (field: string, path: string) => void
  onImport: (field: string, path: string) => void
  disabled: boolean
}): React.JSX.Element {
  const images = row.differences.filter((d) => d.kind === 'file')
  const properties = row.differences.filter((d) => d.kind === 'property')
  return (
    <div className="team-resource-details">
      <div className="team-version-meta">
        <span>ID：{row.id}</span>
        <span>远程版本：{row.remote?.version ?? '未发布'}</span>
      </div>
      {row.fields && (
        <fieldset className="team-file-selection">
          <legend>选择本次同步的配置与文件</legend>
          <p>
            只处理勾选项。视频始终排除；缺失项可跳过。配置、结果文件的内容与其引用的素材分别选择。
          </p>
          {row.fields.map((f) => (
            <div className="team-file-option" key={f.field}>
              <label>
                <input
                  type="checkbox"
                  aria-label={`同步 ${f.label}`}
                  checked={selectedFields.includes(f.field)}
                  disabled={
                    disabled ||
                    f.state === 'excluded' ||
                    (direction === 'upload' &&
                      (!choice || choice === 'local') &&
                      !canPublishField(f))
                  }
                  onChange={(e) => onField(f.field, e.target.checked)}
                />
                <strong>{f.label}</strong> ·{' '}
                {f.state === 'excluded' ? '不参与同步' : statusLabels[f[direction]]}
              </label>
              <code>
                本地：{f.localPath ?? '未配置 / 不可共享'} → 远程：
                {f.remotePath ?? f.localPath ?? '未发布'}
              </code>
              {direction === 'download' && f.download === 'missing' ? (
                <small className="team-recovery-hint">
                  仅恢复所选缺失项，按原目录及文件名保存。
                </small>
              ) : f.message ? (
                <small className={f.state === 'excluded' ? '' : 'team-error'}>{f.message}</small>
              ) : null}
              {(f.needsTarget || f.state === 'external') && (
                <div className="team-file-target">
                  <input
                    aria-label={`${f.label}目标路径`}
                    placeholder="assets/原资源分类/原文件名.png"
                    value={paths[f.field] ?? f.targetPath ?? ''}
                    disabled={disabled}
                    onChange={(e) => onPath(f.field, e.target.value)}
                  />
                  {f.state === 'external' && (
                    <button
                      disabled={disabled || !paths[f.field]}
                      onClick={() => onImport(f.field, paths[f.field])}
                    >
                      安全导入到本地分类目录
                    </button>
                  )}
                  {f.needsTarget && (
                    <small>旧索引没有原文件名，请确认分类目标；旧 blobs 会保留。</small>
                  )}
                </div>
              )}
            </div>
          ))}
        </fieldset>
      )}
      {row[direction] === 'conflict' && (
        <fieldset className="team-conflict-choices">
          <legend>双方都已修改，请选择处理方式</legend>
          {(
            [
              [
                'local',
                '保留本地',
                direction === 'upload' ? '用已预览的本地版本发布' : '保留本地修改，之后可发布'
              ],
              ['remote', '采用远程', '采用远程对象；远程已删除时删除本地对象'],
              ['copy', '另存副本', '保留本地副本，并在原对象采用远程版本']
            ] as const
          ).map(([value, label, hint]) => (
            <label key={value}>
              <input
                type="radio"
                name={`conflict-${row.id}`}
                checked={choice === value}
                onChange={() => onChoice(value)}
              />
              <span>
                <strong>{label}</strong>
                <small>{hint}</small>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {images.length > 0 && (
        <div className="team-image-comparisons">
          {images.map((d) => (
            <section key={d.field}>
              <h4>{differenceText(d, direction)}</h4>
              <div className="team-image-pair">
                <figure>
                  <figcaption>本地{direction === 'upload' ? ' · 新值' : ' · 旧值'}</figcaption>
                  {d.local ? (
                    <ResourceImage
                      token={snapshot.token}
                      id={row.id}
                      side="local"
                      field={d.field}
                      alt={`本地 ${d.label}`}
                    />
                  ) : (
                    <p>无此文件</p>
                  )}
                </figure>
                <figure>
                  <figcaption>远程{direction === 'upload' ? ' · 旧值' : ' · 新值'}</figcaption>
                  {d.remote ? (
                    <ResourceImage
                      token={snapshot.token}
                      id={row.id}
                      side="remote"
                      field={d.field}
                      alt={`远程 ${d.label}`}
                    />
                  ) : (
                    <p>无此文件</p>
                  )}
                </figure>
              </div>
              <small></small>
              <div className="team-file-hashes">
                <code>本地 SHA-256：{row.local?.files[d.field]?.sha256 ?? '—'}</code>
                <code>远程 SHA-256：{row.remote?.files[d.field]?.sha256 ?? '—'}</code>
              </div>
            </section>
          ))}
        </div>
      )}
      {properties.length > 0 && (
        <table className="team-property-diff">
          <thead>
            <tr>
              <th>属性</th>
              <th>本地{direction === 'upload' ? ' · 新值' : ' · 旧值'}</th>
              <th>远程{direction === 'upload' ? ' · 旧值' : ' · 新值'}</th>
              <th>变化</th>
            </tr>
          </thead>
          <tbody>
            {properties.map((d) => (
              <tr key={d.field}>
                <th>{d.label}</th>
                <td>
                  <pre>{valueText(d.local)}</pre>
                </td>
                <td>
                  <pre>{valueText(d.remote)}</pre>
                </td>
                <td>{differenceText(d, direction)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {row.differences.length === 0 && <p>本地与远程内容一致。</p>}
      {(row.remote?.dependencies.length ?? 0) > 0 && (
        <p>
          必要依赖：
          {row
            .remote!.dependencies.map((id) => snapshot.rows.find((r) => r.id === id)?.name ?? id)
            .join('、')}
          。缺失依赖将一起下载；已有依赖如存在差异，需要一并选择。
        </p>
      )}
      {row.problems.map((problem) => (
        <p className="team-error" key={problem}>
          {problem}
        </p>
      ))}
    </div>
  )
}

export default function TeamResourcesPanel(): React.JSX.Element {
  const [profiles, setProfiles] = useState<TeamProfile[]>([])
  const [profileId, setProfileId] = useState('')
  const [repository, setRepository] = useState<TeamRepository>(emptyRepository)
  const [authorized, setAuthorized] = useState(false)
  const [snapshot, setSnapshot] = useState<SyncSnapshot | null>(null)
  const [direction, setDirection] = useState<SyncDirection>('upload')
  const [search, setSearch] = useState('')
  const [type, setType] = useState('')
  const [onlyChanges, setOnlyChanges] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [choices, setChoices] = useState<Record<string, ConflictChoice>>({})
  const [fieldChoices, setFieldChoices] = useState<Record<string, string[]>>({})
  const [targetPaths, setTargetPaths] = useState<Record<string, Record<string, string>>>({})
  const [busy, setBusy] = useState('')
  const [progress, setProgress] = useState<SyncProgress | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [page, setPage] = useState(0)
  const [device, setDevice] = useState<{ userCode: string; expiresAt: number } | null>(null)
  const [configOpen, setConfigOpen] = useState(false)
  const [initializeOpen, setInitializeOpen] = useState(false)
  const [acknowledgeRisk, setAcknowledgeRisk] = useState(false)
  const activeProfile = useRef('')
  const operation = useRef(false)

  const refresh = useCallback(async (id: string) => {
    const result = await window.bpAPI.teamSync.inspect(id)
    if (activeProfile.current !== id) return
    setSnapshot(result)
    setInitializeOpen(false)
    setAcknowledgeRisk(false)
    setSelected(new Set())
    setExpanded(new Set())
    setChoices({})
    setFieldChoices({})
    setTargetPaths({})
    setPage(0)
  }, [])
  const run = useCallback(async (label: string, fn: () => Promise<void>) => {
    if (operation.current) return
    operation.current = true
    setBusy(label)
    setProgress(null)
    setCancelling(false)
    setError('')
    setMessage('')
    try {
      await fn()
    } catch (e) {
      setError(errorText(e))
    } finally {
      operation.current = false
      setBusy('')
      setCancelling(false)
    }
  }, [])
  useEffect(
    () =>
      window.bpAPI.teamSync.onProgress((next) => {
        if (next.profileId === activeProfile.current) setProgress(next)
      }),
    []
  )
  useEffect(() => {
    let active = true
    window.bpAPI.teamSync
      .settings()
      .then((settings) => {
        if (!active) return
        setProfiles(settings.profiles)
        setRepository(settings.repository)
        setAuthorized(settings.authorized)
        setConfigOpen(!settings.repository.owner)
        const id = settings.profiles[0]?.id ?? ''
        activeProfile.current = id
        setProfileId(id)
        if (id) void run('正在读取资源索引…', () => refresh(id))
      })
      .catch((e) => {
        if (active) setError(errorText(e))
      })
    return () => {
      active = false
      activeProfile.current = ''
    }
  }, [refresh, run])
  useEffect(() => {
    if (!device) return
    let active = true,
      polling = false
    const timer = window.setInterval(async () => {
      if (polling) return
      if (Date.now() > device.expiresAt) {
        setDevice(null)
        setError('GitHub 设备授权已过期，请重试')
        return
      }
      polling = true
      try {
        const status = await window.bpAPI.teamSync.pollAuthorization()
        if (active && status === 'authorized') {
          setDevice(null)
          setAuthorized(true)
          setMessage('GitHub 授权成功，可以刷新远程索引')
        }
      } catch (e) {
        if (active) {
          setDevice(null)
          setError(errorText(e))
        }
      } finally {
        polling = false
      }
    }, 5000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [device])

  const profile = profiles.find((p) => p.id === profileId)
  const rows = snapshot?.rows ?? []
  const filtered = rows.filter(
    (row) =>
      (!type || row.type === type) &&
      row.name.toLowerCase().includes(search.toLowerCase()) &&
      (!onlyChanges || row[direction] !== 'unchanged')
  )
  const pageCount = Math.max(1, Math.ceil(filtered.length / 30))
  const visible = filtered.slice(
    Math.min(page, pageCount - 1) * 30,
    (Math.min(page, pageCount - 1) + 1) * 30
  )
  const actionable = (row: ResourceRow): boolean =>
    row[direction] !== 'unchanged' &&
    (isDocumentResourceType(row.type) ||
      Boolean(profile?.collections.some((c) => c.type === row.type)))
  const unavailable = Boolean(busy || !snapshot || snapshot.offline || snapshot.pending)
  const changeCounts = {
    upload: rows.filter((row) => row.upload !== 'unchanged').length,
    download: rows.filter((row) => row.download !== 'unchanged').length
  }
  const selectable = filtered.filter(actionable)
  const selectedInFilter = selectable.filter((row) => selected.has(row.id)).length
  const restoreSelection =
    direction === 'download' &&
    selected.size > 0 &&
    rows.filter((row) => selected.has(row.id)).every((row) => row.download === 'missing')
  const syncState = busy
    ? { tone: 'working', label: busy }
    : error
      ? { tone: 'error', label: '需要处理' }
      : snapshot?.offline
        ? { tone: 'warning', label: remoteLabels[snapshot.remoteState?.status ?? 'remote_error'] }
        : snapshot?.pending
          ? { tone: 'warning', label: '下载待应用' }
          : !snapshot
            ? { tone: 'idle', label: '等待检查' }
            : changeCounts.upload || changeCounts.download
              ? { tone: 'ready', label: '差异已就绪' }
              : { tone: 'ready', label: '资源已同步' }
  const submit = async (ids: string[]): Promise<void> => {
    if (!snapshot) return
    const unresolved = ids.filter((id) => {
      const row = rows.find((r) => r.id === id)!
      const fields = fieldChoices[id] ?? defaultFields(row, direction, choices[id])
      return (
        !choices[id] &&
        (row.fields
          ? row.fields.some((f) => fields.includes(f.field) && f[direction] === 'conflict')
          : row[direction] === 'conflict')
      )
    })
    if (unresolved.length) {
      setExpanded((current) => new Set([...current, ...unresolved]))
      setError('请在详情中选择每个冲突的处理方式')
      return
    }
    await run(
      direction === 'upload' ? '正在发布所选资源…' : '正在下载并校验所选资源…',
      async () => {
        const result = await window.bpAPI.teamSync.sync({
          profileId,
          token: snapshot.token,
          direction,
          selections: ids.map((id) => {
            const row = rows.find((r) => r.id === id)!
            return {
              id,
              resolution: choices[id],
              ...(row.fields
                ? {
                    fields: fieldChoices[id] ?? defaultFields(row, direction, choices[id]),
                    paths: targetPaths[id]
                  }
                : {})
            }
          })
        })
        setMessage(
          `${result.message}${result.commit ? ` · 提交 ${result.commit.slice(0, 8)}` : ''}`
        )
        setBusy('同步完成，正在刷新资源差异…')
        await refresh(profileId)
      }
    )
  }
  const toggle = (id: string): void =>
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  return (
    <div className="team-resources">
      <header className="team-header bp-display-toolbar">
        <div className="team-title bp-toolbar-intro">
          <span>资源同步</span>
          <h1>团队资源</h1>
          <small></small>
        </div>
        <div className="team-header-actions">
          <button
            aria-expanded={configOpen}
            aria-controls="team-repository"
            onClick={() => setConfigOpen((v) => !v)}
          >
            仓库与授权
          </button>
          <button
            disabled={Boolean(busy || !profileId)}
            onClick={() => void run('正在读取资源索引…', () => refresh(profileId))}
          >
            刷新差异
          </button>
        </div>
        <div className="team-profile-bar">
          <label className="team-profile-selector">
            Profile{' '}
            <select
              aria-label="Profile"
              value={profileId}
              disabled={Boolean(busy)}
              onChange={(e) => {
                const id = e.target.value
                activeProfile.current = id
                setProfileId(id)
                setSnapshot(null)
                setType('')
                void run('正在读取资源索引…', () => refresh(id))
              }}
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <div className="team-repository-context">
            <span>仓库</span>
            <strong title={repository.owner ? `${repository.owner}/${repository.repo}` : undefined}>
              {repository.owner ? `${repository.owner}/${repository.repo}` : '尚未配置仓库'}
            </strong>
            {repository.owner && (
              <span className="team-branch" title={`分支：${repository.branch}`}>
                {repository.branch}
              </span>
            )}
          </div>
          {profile?.localProfileId && (
            <small>
              本地 {profile.localProfileId} → 远程 {profile.id}
            </small>
          )}
        </div>
      </header>
      {configOpen && (
        <form
          id="team-repository"
          className="team-repository bp-session-card"
          onSubmit={(e) => {
            e.preventDefault()
            void run('正在保存仓库设置…', async () => {
              await window.bpAPI.teamSync.configure(repository)
              const settings = await window.bpAPI.teamSync.settings()
              setAuthorized(settings.authorized)
              setDevice(null)
              await refresh(profileId)
              setMessage('仓库设置已保存')
            })
          }}
        >
          <header className="bp-card-header">
            <h2>GitHub 仓库与个人授权</h2>
            <span className={`team-status ${authorized ? 'added' : 'unchanged'}`}>
              {authorized ? '本机已授权' : '未授权'}
            </span>
          </header>
          <div className="team-repository-fields">
            {(
              [
                ['owner', '仓库所有者', '团队或用户名'],
                ['repo', '私有仓库名', 'team-profiles'],
                ['branch', '分支', 'main'],
                ['clientId', 'OAuth App Client ID', '启用了 Device Flow 的 Client ID']
              ] as const
            ).map(([key, label, placeholder]) => (
              <label className="bp-card-field" key={key}>
                {label}
                <input
                  value={repository[key]}
                  placeholder={placeholder}
                  disabled={Boolean(busy || device)}
                  required
                  onChange={(e) => setRepository({ ...repository, [key]: e.target.value })}
                />
              </label>
            ))}
          </div>
          <details className="team-config-help">
            <summary>仓库配置与权限说明</summary>
            <p>
              填写仓库网址中的所有者和仓库名，已有仓库请选择现有分支；全新空仓库可手动初始化。管理员创建
              OAuth App 并启用 Device Flow，填写公开的 Client ID。每位成员使用有仓库权限的 GitHub
              账号授权；读取需要 Contents 读取权限，发布还需要写入权限。
            </p>
          </details>
          <div className="team-actions">
            <button type="submit" disabled={Boolean(busy || device)}>
              保存设置
            </button>
            <button
              type="button"
              className="primary"
              disabled={Boolean(busy || device)}
              onClick={() =>
                void run('正在请求 GitHub 设备授权…', async () => {
                  await window.bpAPI.teamSync.configure(repository)
                  setDevice(await window.bpAPI.teamSync.authorize())
                })
              }
            >
              {authorized ? '重新授权' : '使用 GitHub 授权'}
            </button>
            {authorized && (
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() =>
                  void run('正在退出授权…', async () => {
                    await window.bpAPI.teamSync.logout()
                    setAuthorized(false)
                    setDevice(null)
                    await refresh(profileId)
                  })
                }
              >
                退出本机授权
              </button>
            )}
            <span>{authorized ? '已授权' : '未授权'}</span>
          </div>
          {device && (
            <div className="team-notice team-device-notice">
              在已打开的 GitHub 授权页输入{' '}
              <strong className="team-device-code">{device.userCode}</strong>
              <button
                type="button"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(device.userCode)
                    .catch((e) => setError(errorText(e)))
                }
              >
                复制验证码
              </button>
              ，完成后自动连接。
              <button
                type="button"
                onClick={() =>
                  void run('正在取消授权…', async () => {
                    await window.bpAPI.teamSync.logout()
                    setDevice(null)
                    setAuthorized(false)
                  })
                }
              >
                取消授权
              </button>
            </div>
          )}
        </form>
      )}
      <section className="team-sync-summary" aria-label="同步状态摘要">
        <div className="team-sync-state" aria-live="polite">
          <span className="team-summary-label">当前同步状态</span>
          <strong className={`team-sync-indicator ${syncState.tone}`}>{syncState.label}</strong>
          <small>
            {snapshot?.head ? `索引 ${snapshot.head.slice(0, 8)}` : '刷新差异以检查资源索引'}
          </small>
        </div>
        <div className="team-sync-count">
          <span>本地变更</span>
          <strong>{snapshot ? changeCounts.upload : '—'}</strong>
          <small>待发布</small>
        </div>
        <div className="team-sync-count">
          <span>远程更新</span>
          <strong>{snapshot ? changeCounts.download : '—'}</strong>
          <small>{snapshot?.offline ? '上次索引' : '待获取'}</small>
        </div>
      </section>
      {progress && (
        <section className={`team-upload-progress ${progress.stage}`} aria-label="同步进度">
          <div className="team-progress-heading">
            <strong>{stageLabels[progress.stage]}</strong>
            <span>{progress.message === stageLabels[progress.stage] ? '' : progress.message}</span>
            {busy && progress.cancellable && (
              <button
                disabled={cancelling}
                onClick={() => {
                  setCancelling(true)
                  void window.bpAPI.teamSync
                    .cancel(profileId, progress.operationId)
                    .then((accepted) => {
                      if (!accepted) {
                        setCancelling(false)
                        setMessage('正在确认提交结果，请等待当前阶段完成')
                      }
                    })
                    .catch((error) => {
                      setCancelling(false)
                      setError(errorText(error))
                    })
                }}
              >
                {cancelling ? '正在取消…' : '取消同步'}
              </button>
            )}
          </div>
          <progress
            aria-label="文件同步进度"
            max={Math.max(1, progress.total)}
            value={
              progress.stage === 'completed'
                ? Math.max(1, progress.total)
                : progress.total
                  ? progress.completed
                  : undefined
            }
          />
          <div className="team-progress-counts">
            <span>总文件 {progress.total || (progress.stage === 'scanning' ? '统计中' : 0)}</span>
            <span>已完成 {progress.completed}</span>
            <span>跳过 {progress.skipped}</span>
            <span>失败 {progress.failed}</span>
            <small>当前阶段进度，已完成包含跳过的文件</small>
            {progress.elapsedSeconds !== undefined && (
              <span>已用时 {progress.elapsedSeconds} 秒</span>
            )}
            {Boolean(progress.total) && (
              <span>{Math.floor((progress.completed / progress.total) * 100)}%</span>
            )}
          </div>
          {progress.activity && (
            <div className="team-progress-file" role="status">
              {progress.activity}
              {progress.waitingSeconds ? ` · 已等待 ${progress.waitingSeconds} 秒` : ''}
            </div>
          )}
          {progress.currentFile && (
            <div className="team-progress-file" title={progress.currentFile}>
              当前文件：{progress.currentFile}
            </div>
          )}
        </section>
      )}
      <div className="team-messages" aria-live="polite">
        {message && <p className="team-success">{message}</p>}
        {error && (
          <p className="team-error" role="alert">
            {error}
          </p>
        )}
        {snapshot?.offline && (
          <div className="team-notice">
            <p>
              {snapshot.warning} 当前显示本地资源与上次索引，远程状态确认前暂停资源对比和同步，本地
              BP 可继续使用。
            </p>
            {snapshot.remoteState && (
              <p>
                索引位置：<code>{snapshot.remoteState.indexPath}</code>
              </p>
            )}
            {snapshot.remoteState?.canInitialize && (
              <>
                <button
                  disabled={Boolean(busy || snapshot.pending)}
                  onClick={() => setInitializeOpen(true)}
                >
                  初始化远程索引
                </button>
                {initializeOpen && (
                  <section className="team-initialize-confirm" aria-label="确认初始化远程索引">
                    <p>
                      将从当前 Profile 的 {rows.filter((row) => row.local).length}{' '}
                      个本地对象生成索引并发布可共享资源，沿用原目录与文件名。视频、缺失文件、外部路径和过大文件按现有规则跳过；属性不可共享时停止初始化。
                    </p>
                    <p>
                      仓库已有 {snapshot.remoteState.existingFiles ?? 0}{' '}
                      个文件。初始化只新增文件或复用相同内容；同路径内容不同会停止，已有文件不会被删除或覆盖。
                    </p>
                    {snapshot.remoteState.conflictRisk && (
                      <>
                        <p className="team-error">
                          仓库已有资源但索引缺失，存在数据冲突风险。请先备份并核对；仅存在于远程的文件会保留，但不会自动纳入新索引。
                        </p>
                        <p>
                          <code>{snapshot.remoteState.resourceFiles?.join('、')}</code>
                        </p>
                        <label>
                          <input
                            type="checkbox"
                            checked={acknowledgeRisk}
                            disabled={Boolean(busy)}
                            onChange={(e) => setAcknowledgeRisk(e.target.checked)}
                          />
                          我已核对已有资源并确认上述风险
                        </label>
                      </>
                    )}
                    <button
                      className="primary"
                      disabled={Boolean(
                        busy ||
                        snapshot.pending ||
                        (snapshot.remoteState.conflictRisk && !acknowledgeRisk)
                      )}
                      onClick={() =>
                        void run('正在初始化远程索引…', async () => {
                          try {
                            const result = await window.bpAPI.teamSync.initialize({
                              profileId,
                              token: snapshot.token,
                              acknowledgeConflictRisk: acknowledgeRisk
                            })
                            setMessage(result.message)
                          } finally {
                            await refresh(profileId)
                          }
                        })
                      }
                    >
                      确认初始化并发布本地资源
                    </button>
                    <button disabled={Boolean(busy)} onClick={() => setInitializeOpen(false)}>
                      取消
                    </button>
                  </section>
                )}
              </>
            )}
          </div>
        )}
      </div>
      {snapshot?.busyReason && (
        <p className="team-notice">{snapshot.busyReason}。可以下载并暂存，应用会延后。</p>
      )}
      {Boolean(snapshot?.pending) && (
        <div className="team-pending">
          <span>{snapshot!.pending} 个对象已下载校验，等待应用。未选中对象保持原样。</span>
          <button
            className="primary"
            disabled={Boolean(busy)}
            onClick={() =>
              void run('正在应用暂存资源…', async () => {
                const result = await window.bpAPI.teamSync.applyPending(profileId)
                setMessage(result.message)
                await refresh(profileId)
              })
            }
          >
            应用待处理下载
          </button>
          <button
            disabled={Boolean(busy)}
            onClick={() =>
              void run('正在取消暂存应用…', async () => {
                await window.bpAPI.teamSync.discardPending(profileId)
                await refresh(profileId)
                setMessage('已取消待应用下载，本地资源未被覆盖')
              })
            }
          >
            取消待应用下载
          </button>
        </div>
      )}
      <section className="team-resource-panel bp-session-card" aria-label="团队资源同步列表">
        <div className="team-resource-panel-header">
          <div className="team-tabs" role="tablist" aria-label="同步方向">
            {(
              [
                ['upload', '发布本地修改'],
                ['download', '获取远程更新']
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                role="tab"
                id={`team-tab-${value}`}
                aria-controls="team-resource-results"
                aria-selected={direction === value}
                tabIndex={direction === value ? 0 : -1}
                onKeyDown={(event) => {
                  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
                  event.preventDefault()
                  const tabs =
                    event.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>(
                      '[role="tab"]'
                    )
                  const next =
                    event.key === 'Home'
                      ? tabs[0]
                      : event.key === 'End'
                        ? tabs[1]
                        : tabs[direction === 'upload' ? 1 : 0]
                  next.focus()
                  next.click()
                }}
                className={direction === value ? 'active' : ''}
                onClick={() => {
                  setDirection(value)
                  setSelected(new Set())
                  setChoices({})
                  setFieldChoices({})
                  setTargetPaths({})
                  setPage(0)
                }}
              >
                {label}
                <span>{snapshot ? changeCounts[value] : '—'}</span>
              </button>
            ))}
          </div>
          <span className="team-sync-hint">按所选资源同步 · 视频不参与</span>
        </div>
        <div id="team-resource-results" role="tabpanel" aria-labelledby={`team-tab-${direction}`}>
          <div className="team-filters">
            <input
              type="search"
              aria-label="搜索资源名称"
              placeholder="搜索资源名称"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
                setPage(0)
              }}
            />
            <select
              aria-label="资源类型"
              value={type}
              onChange={(e) => {
                setType(e.target.value)
                setPage(0)
              }}
            >
              <option value="">全部资源类型</option>
              {[...new Map(rows.map((r) => [r.type, r.typeLabel])).entries()].map(
                ([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                )
              )}
            </select>
            <label className="team-changes-filter">
              <input
                type="checkbox"
                checked={onlyChanges}
                onChange={(e) => {
                  setOnlyChanges(e.target.checked)
                  setPage(0)
                }}
              />
              仅显示变化资源
            </label>
            <button
              className="primary team-batch-action"
              disabled={unavailable || selected.size === 0}
              onClick={() => void submit([...selected])}
            >
              {direction === 'upload' ? '批量发布' : restoreSelection ? '批量恢复' : '批量下载'}
              {selected.size ? `（${selected.size}）` : ''}
            </button>
          </div>
          <div className="team-list" aria-busy={Boolean(busy)}>
            <div className="team-list-heading">
              <label>
                <input
                  type="checkbox"
                  aria-label="选择全部筛选结果中的可同步资源"
                  title="选中当前筛选条件下所有页的可同步资源"
                  disabled={unavailable || selectable.length === 0}
                  checked={selectable.length > 0 && selectedInFilter === selectable.length}
                  ref={(input) => {
                    if (input)
                      input.indeterminate =
                        selectedInFilter > 0 && selectedInFilter < selectable.length
                  }}
                  onChange={(e) => {
                    const checked = e.target.checked
                    setSelected((current) => {
                      const next = new Set(current)
                      selectable.forEach((r) => {
                        if (checked) next.add(r.id)
                        else next.delete(r.id)
                      })
                      return next
                    })
                  }}
                />
                全选筛选结果
              </label>
              <span>
                共 {filtered.length} 个资源
                <span className={selected.size ? 'team-selection-count' : ''}>
                  {' '}
                  · 已选 {selected.size} 个
                </span>
              </span>
              <span className="team-list-actions-label">状态与操作</span>
            </div>
            {visible.map((row) => (
              <article
                className={`team-resource${selected.has(row.id) ? ' selected' : ''}${expanded.has(row.id) ? ' expanded' : ''}`}
                key={row.id}
              >
                <div className="team-resource-row">
                  <input
                    type="checkbox"
                    aria-label={`选择 ${row.name}`}
                    checked={selected.has(row.id)}
                    disabled={unavailable || !actionable(row)}
                    onChange={() => toggle(row.id)}
                  />
                  <ResourceImage
                    key={`${snapshot!.token}-${row.id}`}
                    token={snapshot!.token}
                    id={row.id}
                    side={row.local ? 'local' : 'remote'}
                    alt={row.name}
                  />
                  <div className="team-resource-info">
                    <strong title={row.name}>{row.name}</strong>
                    <small>{row.typeLabel}</small>
                  </div>
                  <div className="team-resource-summary">
                    <div className="team-difference-tags">
                      {row.differences.length ? (
                        row.differences.slice(0, 3).map((d) => (
                          <span className="team-difference-tag" key={d.field}>
                            {direction === 'download' &&
                            row.fields?.some((f) => f.field === d.field && f.download === 'missing')
                              ? `${d.label}待恢复`
                              : differenceText(d, direction)}
                          </span>
                        ))
                      ) : (
                        <span className="team-no-difference">内容一致</span>
                      )}
                      {row.differences.length > 3 && (
                        <span className="team-difference-total">
                          共 {row.differences.length} 项变化
                        </span>
                      )}
                    </div>
                    {row.problems.length > 0 && (
                      <small className="team-error">{row.problems[0]}</small>
                    )}
                  </div>
                  <div className="team-resource-actions">
                    <span className={`team-status ${row[direction]}`}>
                      {statusLabels[row[direction]]}
                    </span>
                    <button
                      aria-expanded={expanded.has(row.id)}
                      aria-controls={`team-details-${row.id}`}
                      onClick={() =>
                        setExpanded((current) => {
                          const next = new Set(current)
                          if (next.has(row.id)) next.delete(row.id)
                          else next.add(row.id)
                          return next
                        })
                      }
                    >
                      {expanded.has(row.id) ? '收起' : '详情'}
                    </button>
                    <button
                      className="primary"
                      disabled={unavailable || !actionable(row)}
                      onClick={() => void submit([row.id])}
                    >
                      {direction === 'upload'
                        ? '上传'
                        : row.download === 'missing'
                          ? '恢复'
                          : '下载'}
                    </button>
                  </div>
                </div>
                {expanded.has(row.id) && (
                  <div id={`team-details-${row.id}`}>
                    <ResourceDetails
                      row={row}
                      snapshot={snapshot!}
                      direction={direction}
                      choice={choices[row.id]}
                      onChoice={(choice) =>
                        setChoices((current) => ({ ...current, [row.id]: choice }))
                      }
                      selectedFields={
                        fieldChoices[row.id] ?? defaultFields(row, direction, choices[row.id])
                      }
                      onField={(field, checked) =>
                        setFieldChoices((current) => {
                          const fields = new Set(
                            current[row.id] ?? defaultFields(row, direction, choices[row.id])
                          )
                          if (checked) fields.add(field)
                          else fields.delete(field)
                          return { ...current, [row.id]: [...fields] }
                        })
                      }
                      paths={targetPaths[row.id] ?? {}}
                      onPath={(field, path) =>
                        setTargetPaths((current) => ({
                          ...current,
                          [row.id]: { ...current[row.id], [field]: path }
                        }))
                      }
                      onImport={(field, target) =>
                        void run('正在安全复制所选外部资源…', async () => {
                          await window.bpAPI.teamSync.importResource(
                            profileId,
                            snapshot!.token,
                            row.id,
                            field,
                            target
                          )
                          await refresh(profileId)
                          setMessage('已导入到本地分类目录，原文件保持不变；可重新勾选发布')
                        })
                      }
                      disabled={unavailable}
                    />
                  </div>
                )}
              </article>
            ))}
            {visible.length === 0 && (
              <div className="team-empty">
                {busy
                  ? '正在检查资源…'
                  : !snapshot
                    ? '选择 Profile 并刷新资源索引'
                    : onlyChanges
                      ? '没有符合条件的变化资源'
                      : '没有符合条件的资源'}
              </div>
            )}
          </div>
          <footer className="team-footer">
            <span>
              {filtered.length} 个资源 · 已选 {selected.size} 个
              {snapshot?.head ? ` · 索引 ${snapshot.head.slice(0, 8)}` : ''}
            </span>
            <button disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
              上一页
            </button>
            <span>
              {Math.min(page + 1, pageCount)} / {pageCount}
            </span>
            <button disabled={page + 1 >= pageCount} onClick={() => setPage((p) => p + 1)}>
              下一页
            </button>
          </footer>
        </div>
      </section>
      <p className="team-page-note">
        保留 assets、config 与 results 原路径 · 角色库和资源编号表随选中对象合并
      </p>
    </div>
  )
}
