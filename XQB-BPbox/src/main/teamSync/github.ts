import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { TeamRepository, SyncProgress, RemoteIndexState } from '../../shared/teamSync'
import { MAX_INDEX_BYTES } from './model'
import { redactDiagnostic, type GitHubDiagnostic, type GitHubLogger } from './diagnostics'
import { abortable } from './operation'

export class GitHubError extends Error {
  constructor(
    public status: number,
    message: string,
    public kind: RemoteIndexState['status'] = 'remote_error',
    public remoteMessage = ''
  ) {
    super(message)
  }
}
export interface RemoteHead {
  sha: string
  tree: string
  writable?: boolean
  empty?: boolean
}
export interface RemoteStore {
  head(options?: RemoteOperation): Promise<RemoteHead>
  inventory(head: RemoteHead, options?: RemoteOperation): Promise<string[]>
  read(
    path: string,
    commit: string,
    limit: number,
    options?: RemoteOperation
  ): Promise<Buffer | null>
  commit(
    parent: RemoteHead,
    files: Map<string, Buffer | null>,
    message: string,
    options?: RemoteOperation
  ): Promise<string>
}
export interface RemoteOperation {
  /** Initialization may add files or reuse identical bytes, never replace/delete. */
  createOnly?: boolean
  signal?: AbortSignal
  operationId?: string
  onProgress?: (progress: Partial<SyncProgress>) => void
  filePath?: string
  fileSize?: number
  total?: number
  completed?: number
  skipped?: number
}
type TreeEntry = { path: string; type: string; sha: string }

export class GitHubStore implements RemoteStore {
  private cache = new Map<string, { etag: string; data: Buffer }>()
  // Immutable Git objects may be reused only within a single authenticated operation.
  // ETags alone still require a round trip for every missing resource.
  private operationObjects = new Map<string, Map<string, Buffer>>()
  // Keep successful objects after a failed/cancelled publication for an in-process retry.
  private uploadedBlobs = new Set<string>()
  constructor(
    private repository: TeamRepository,
    private token: () => string,
    private requestFetch: (input: string, init?: RequestInit) => Promise<Response> = fetch,
    private logger: GitHubLogger = (entry) =>
      console.info('[TeamSync:GitHub]', JSON.stringify(entry)),
    private requestTimeoutMs = 60000
  ) {}
  private get base(): string {
    return `/repos/${encodeURIComponent(this.repository.owner)}/${encodeURIComponent(this.repository.repo)}`
  }
  private async request(
    path: string,
    method = 'GET',
    body?: unknown,
    limit = MAX_INDEX_BYTES,
    raw = false,
    options: RemoteOperation = {}
  ): Promise<Buffer> {
    options.signal?.throwIfAborted()
    let objects: Map<string, Buffer> | undefined
    if (
      options.operationId &&
      method === 'GET' &&
      path.startsWith(`${this.base}/git/`) &&
      /\/git\/(?:commits|trees)\//.test(path)
    ) {
      objects = this.operationObjects.get(options.operationId)
      if (!objects) {
        if (this.operationObjects.size >= 2)
          this.operationObjects.delete(this.operationObjects.keys().next().value!)
        objects = new Map()
        this.operationObjects.set(options.operationId, objects)
      }
      const cached = objects.get(path)
      if (cached && cached.length <= limit) return cached
    }
    try {
      const data = await this.fetchRequest(path, method, body, limit, raw, options)
      if (objects && data.length <= MAX_INDEX_BYTES) {
        while (
          objects.size &&
          ([...objects.values()].reduce((sum, b) => sum + b.length, 0) + data.length >
            32 * 1024 * 1024 ||
            objects.size >= 128)
        )
          objects.delete(objects.keys().next().value!)
        objects.set(path, data)
      }
      return data
    } finally {
      options.onProgress?.({ activity: '' })
    }
  }
  private async fetchRequest(
    path: string,
    method = 'GET',
    body?: unknown,
    limit = MAX_INDEX_BYTES,
    raw = false,
    options: RemoteOperation = {}
  ): Promise<Buffer> {
    const cached = method === 'GET' ? this.cache.get(path) : undefined
    const target = `https://api.github.com${path}`
    for (let attempt = 0; attempt < 3; attempt++) {
      options.signal?.throwIfAborted()
      const action =
        method === 'GET' ? (raw ? '读取远程文件' : '读取远程目录或索引') : '提交远程数据'
      const activity = `${action}，第 ${attempt + 1}/${['PATCH', 'PUT'].includes(method) ? 1 : 3} 次请求，单次超时 ${Math.ceil(this.requestTimeoutMs / 1000)} 秒`
      options.onProgress?.({ activity })
      const signal = AbortSignal.any([
        AbortSignal.timeout(this.requestTimeoutMs),
        ...(options.signal ? [options.signal] : [])
      ])
      let response: Response
      let token = ''
      const log = (entry: Partial<GitHubDiagnostic>): void => {
        const diagnostic: GitHubDiagnostic = {
          target,
          method,
          branch: this.repository.branch,
          attempt: attempt + 1,
          status: null,
          kind: 'http',
          tokenPresent: Boolean(token),
          message: '',
          operationId: options.operationId,
          filePath: options.filePath,
          fileSize: options.fileSize,
          total: options.total,
          completed: options.completed,
          skipped: options.skipped,
          ...entry
        }
        for (const key of Object.keys(diagnostic)) {
          if (typeof diagnostic[key] === 'string')
            diagnostic[key] = redactDiagnostic(diagnostic[key], token)
        }
        try {
          this.logger(diagnostic)
        } catch {
          /* Logging must never change sync behavior. */
        }
      }
      try {
        token = this.token().trim()
        if (!token) throw new GitHubError(401, '请先使用自己的 GitHub 账号授权')
        response = await abortable(
          this.requestFetch(target, {
            method,
            redirect: 'error',
            signal,
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28',
              'User-Agent': 'XQB-BPbox-TeamSync',
              'Content-Type': 'application/json',
              ...(cached?.etag ? { 'If-None-Match': cached.etag } : {})
            },
            body: body === undefined ? undefined : JSON.stringify(body)
          }),
          signal
        )
      } catch (error) {
        options.signal?.throwIfAborted()
        if (error instanceof GitHubError) {
          log({ kind: 'authorization', message: error.message })
          throw error
        }
        const timeout = ['TimeoutError', 'AbortError'].includes((error as Error).name)
        log({ kind: timeout ? 'timeout' : 'network', message: (error as Error).message })
        if (attempt === 2 || method === 'PATCH' || method === 'PUT')
          throw new GitHubError(
            0,
            `GitHub ${timeout ? '请求超时' : '网络请求失败'}（未收到 HTTP 响应）：${redactDiagnostic(target, token)}；请检查网络、代理或 TLS 连接，本地资源保持不变`,
            'network_error'
          )
        options.onProgress?.({ activity: '网络请求失败，正在等待重试' })
        await delay(500 * 2 ** attempt, undefined, { signal: options.signal })
        continue
      }
      const details = {
        status: response.status,
        requestId: response.headers.get('x-github-request-id') ?? undefined,
        oauthScopes: response.headers.get('x-oauth-scopes') ?? undefined,
        acceptedScopes: response.headers.get('x-accepted-oauth-scopes') ?? undefined,
        rateLimitRemaining: response.headers.get('x-ratelimit-remaining') ?? undefined,
        ssoRequired: response.headers.get('x-github-sso')?.startsWith('required') ?? false
      }
      if (response.status === 304 && cached) {
        log(details)
        return cached.data
      }
      if (!response.ok) {
        let message = ''
        try {
          const data = await this.responseBytes(response, 64 * 1024, signal)
          const error = JSON.parse(data.toString()) as { message?: unknown }
          if (typeof error.message === 'string') message = redactDiagnostic(error.message, token)
        } catch {
          options.signal?.throwIfAborted()
          message = 'GitHub 错误响应无法读取或不是 JSON'
        }
        log({ ...details, message })
        const limited =
          response.status === 429 ||
          (response.status === 403 &&
            (response.headers.get('x-ratelimit-remaining') === '0' ||
              response.headers.has('retry-after') ||
              /rate limit|abuse detection/i.test(message)))
        const retry = Number(response.headers.get('retry-after') ?? (limited ? 60 : 2 ** attempt))
        if (
          (limited || response.status >= 500) &&
          attempt < 2 &&
          retry <= 10 &&
          method !== 'PATCH' &&
          method !== 'PUT'
        ) {
          options.onProgress?.({ activity: `GitHub 暂时不可用，${Math.max(1, retry)} 秒后重试` })
          await delay(Math.max(1, retry) * 1000, undefined, { signal: options.signal })
          continue
        }
        const reason = limited
          ? 'GitHub 请求达到限额，请稍后重试'
          : response.status === 401
            ? 'GitHub 授权已失效，请重新授权'
            : response.status === 403
              ? 'GitHub 拒绝访问，请检查仓库 Contents 权限、组织 SSO 和分支保护'
              : response.status === 404
                ? path === this.base
                  ? '无法访问配置的私有仓库，请核对 Owner/Repository 和当前授权账号的仓库权限；GitHub 也会对无权访问的私有仓库返回 404'
                  : path.includes('/git/ref/heads/')
                    ? `无法读取分支 ${this.repository.branch}，请核对分支名及 Contents 读取权限；这不能说明仓库缺少 README`
                    : '无法读取远程文件或 Git 对象，请检查路径、提交及私有仓库读取权限'
                : [409, 422].includes(response.status)
                  ? '远程分支已变化或受保护，请刷新差异后重新发布'
                  : response.status >= 500
                    ? 'GitHub 服务暂时不可用，请稍后重试'
                    : 'GitHub 请求失败'
        throw new GitHubError(
          response.status,
          redactDiagnostic(
            `${reason}（HTTP ${response.status}）\n${method} ${target}${message ? `\nGitHub: ${message}` : ''}${details.requestId ? `\nRequest ID: ${details.requestId}` : ''}`,
            token
          ),
          limited
            ? 'rate_limited'
            : [401, 403].includes(response.status)
              ? 'permission_denied'
              : response.status === 404 && path === this.base
                ? 'repository_unavailable'
                : 'remote_error',
          message
        )
      }
      let data: Buffer
      try {
        data = await this.responseBytes(response, limit, signal, (size) =>
          options.onProgress?.({ activity: `${action}，已接收 ${(size / 1024).toFixed(0)} KiB` })
        )
      } catch {
        options.signal?.throwIfAborted()
        const message = `GitHub ${signal.aborted ? '响应读取超时' : '响应读取失败或超过允许大小'}（HTTP ${response.status}）：${redactDiagnostic(target, token)}`
        log({ ...details, kind: 'response', message })
        throw new GitHubError(response.status, message)
      }
      let sha: string | undefined
      if (path.endsWith('/git/blobs') && method === 'POST') {
        try {
          sha = JSON.parse(data.toString()).sha
        } catch {
          /* json() reports malformed responses. */
        }
      }
      log({ ...details, ...(sha ? { sha } : {}) })
      if (method === 'GET' && data.length <= MAX_INDEX_BYTES && response.headers.get('etag')) {
        if (this.cache.size >= 32) this.cache.delete(this.cache.keys().next().value!)
        this.cache.set(path, { etag: response.headers.get('etag')!, data })
      }
      return data
    }
    throw new Error('GitHub 请求重试失败')
  }
  private async responseBytes(
    response: Response,
    limit: number,
    signal: AbortSignal,
    onBytes?: (size: number) => void
  ): Promise<Buffer> {
    const reader = response.body?.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    let reportedAt = 0
    if (reader) {
      try {
        while (true) {
          const { value, done } = await abortable(reader.read(), signal)
          if (done) break
          size += value.byteLength
          if (size > limit) throw new Error('GitHub 响应超过允许大小')
          chunks.push(value)
          if (Date.now() - reportedAt >= 250) {
            onBytes?.(size)
            reportedAt = Date.now()
          }
        }
      } catch (error) {
        void reader.cancel().catch(() => undefined)
        throw error
      } finally {
        reader.releaseLock()
      }
    }
    return Buffer.concat(chunks)
  }
  private async json<T>(
    path: string,
    method = 'GET',
    body?: unknown,
    options?: RemoteOperation
  ): Promise<T> {
    const result = await this.request(path, method, body, MAX_INDEX_BYTES, false, options)
    try {
      return JSON.parse(result.toString()) as T
    } catch {
      throw new Error(`GitHub 返回无效 JSON：${method} https://api.github.com${path}`)
    }
  }
  async head(options?: RemoteOperation): Promise<RemoteHead> {
    const repo = await this.json<{
      private: boolean
      archived?: boolean
      permissions?: { push?: boolean }
    }>(this.base, 'GET', undefined, options)
    if (!repo.private) throw new Error('团队资源只允许同步到 GitHub 私有仓库')
    const writable = repo.permissions?.push === true && !repo.archived
    let ref: { object: { sha: string } }
    try {
      ref = await this.json<{ object: { sha: string } }>(
        `${this.base}/git/ref/heads/${encodeURIComponent(this.repository.branch)}`,
        'GET',
        undefined,
        options
      )
    } catch (error) {
      if (!(error instanceof GitHubError) || ![404, 409].includes(error.status)) throw error
      // A missing branch (or a hidden private ref) is not evidence of an empty repository.
      try {
        await this.json(`${this.base}/commits?per_page=1`, 'GET', undefined, options)
      } catch (probe) {
        if (
          probe instanceof GitHubError &&
          probe.status === 409 &&
          /Git Repository is empty/i.test(probe.remoteMessage)
        )
          return { sha: '', tree: '', writable, empty: true }
        throw probe
      }
      throw new GitHubError(error.status, error.message, 'branch_unavailable')
    }
    const commit = await this.json<{ tree: { sha: string } }>(
      `${this.base}/git/commits/${ref.object.sha}`,
      'GET',
      undefined,
      options
    )
    return { sha: ref.object.sha, tree: commit.tree.sha, writable }
  }
  async inventory(head: RemoteHead, options?: RemoteOperation): Promise<string[]> {
    if (head.empty) return []
    const value = await this.json<{ tree: TreeEntry[]; truncated: boolean }>(
      `${this.base}/git/trees/${encodeURIComponent(head.tree)}?recursive=1`,
      'GET',
      undefined,
      options
    )
    if (
      value.truncated !== false ||
      !Array.isArray(value.tree) ||
      value.tree.some(
        (e) =>
          typeof e.path !== 'string' ||
          !['blob', 'tree', 'commit'].includes(e.type) ||
          typeof e.sha !== 'string'
      )
    )
      throw new Error('GitHub 文件树不完整，无法安全检查已有资源，请稍后重试')
    return value.tree.filter((e) => e.type !== 'tree').map((e) => e.path)
  }
  async read(
    path: string,
    commit: string,
    limit: number,
    options?: RemoteOperation
  ): Promise<Buffer | null> {
    if (!commit) return null // Only a confirmed empty RemoteHead uses this sentinel.
    // One complete tree at this exact commit proves absence for every candidate.
    // Truncated trees fall back to complete subtrees; permission errors never mean absence.
    if (options?.operationId && (await this.absentFromTree(path, commit, options, true)))
      return null
    try {
      return await this.request(
        `${this.base}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(commit)}`,
        'GET',
        undefined,
        limit,
        true,
        options
      )
    } catch (error) {
      if (!(error instanceof GitHubError) || error.status !== 404) throw error
      // A Contents 404 may hide lost access. Only an authenticated, complete tree
      // at the SAME commit can establish absence; never turn an API failure into an empty index.
      if (await this.absentFromTree(path, commit, options)) return null
      throw error
    }
  }
  private async absentFromTree(
    path: string,
    commit: string,
    options?: RemoteOperation,
    recursive = false
  ): Promise<boolean> {
    const value = await this.json<{ tree: { sha: string } }>(
      `${this.base}/git/commits/${encodeURIComponent(commit)}`,
      'GET',
      undefined,
      options
    )
    let sha = value.tree.sha
    if (recursive) {
      const tree = await this.readTree(sha, true, options)
      if (!tree.truncated) {
        if (tree.tree.some((e) => path.startsWith(`${e.path}/`) && e.type !== 'tree'))
          throw new Error(`远程父路径不是目录：${path}`)
        return !tree.tree.some((e) => e.path === path)
      }
    }
    const parts = path.split('/')
    for (const [index, part] of parts.entries()) {
      const tree = await this.json<{
        truncated: boolean
        tree: { path: string; type: string; sha: string }[]
      }>(`${this.base}/git/trees/${encodeURIComponent(sha)}`, 'GET', undefined, options)
      if (
        tree.truncated !== false ||
        !Array.isArray(tree.tree) ||
        tree.tree.some(
          (entry) =>
            typeof entry.path !== 'string' ||
            typeof entry.type !== 'string' ||
            typeof entry.sha !== 'string'
        )
      )
        throw new Error('GitHub 文件树不完整，无法确认文件是否缺失；已保留本地索引')
      const entry = tree.tree.find((entry) => entry.path === part)
      if (!entry) return true
      if (index === parts.length - 1 || entry.type !== 'tree') return false
      sha = entry.sha
    }
    return false
  }
  private async readTree(
    sha: string,
    recursive = false,
    options?: RemoteOperation
  ): Promise<{ tree: TreeEntry[]; truncated: boolean }> {
    const value = await this.json<{ tree: TreeEntry[]; truncated: boolean }>(
      `${this.base}/git/trees/${encodeURIComponent(sha)}${recursive ? '?recursive=1' : ''}`,
      'GET',
      undefined,
      options
    )
    if (
      !Array.isArray(value.tree) ||
      typeof value.truncated !== 'boolean' ||
      value.tree.some(
        (e) => typeof e.path !== 'string' || typeof e.sha !== 'string' || typeof e.type !== 'string'
      )
    )
      throw new Error('GitHub 文件树无效，无法核对上传文件')
    return value
  }
  private async fileTree(
    root: string,
    paths: string[],
    options: RemoteOperation
  ): Promise<Map<string, string>> {
    const all = await this.readTree(root, true, options)
    for (const path of paths) {
      if (
        all.tree.some(
          (e) =>
            (e.path === path && e.type !== 'blob') ||
            (path.startsWith(`${e.path}/`) && e.type !== 'tree')
        )
      )
        throw new Error(`远程文件或目录路径冲突：${path}`)
    }
    const files = new Map(all.tree.filter((e) => e.type === 'blob').map((e) => [e.path, e.sha]))
    if (!all.truncated) return files
    // Large recursive trees can be truncated. Resolve candidate paths via complete subtrees.
    const trees = new Map<string, TreeEntry[]>()
    for (const path of paths) {
      let sha = root
      const parts = path.split('/')
      for (const [index, part] of parts.entries()) {
        if (!trees.has(sha)) {
          const next = await this.readTree(sha, false, options)
          if (next.truncated) throw new Error('GitHub 子目录不完整，无法核对上传文件')
          trees.set(sha, next.tree)
        }
        const entry = trees.get(sha)!.find((e) => e.path === part)
        if (!entry) break
        if (index === parts.length - 1) {
          if (entry.type !== 'blob') throw new Error(`远程路径不是文件：${path}`)
          files.set(path, entry.sha)
        } else if (entry.type !== 'tree') throw new Error(`远程父路径不是目录：${path}`)
        else sha = entry.sha
      }
    }
    return files
  }
  async commit(
    parent: RemoteHead,
    files: Map<string, Buffer | null>,
    message: string,
    options: RemoteOperation = {}
  ): Promise<string> {
    if (parent.empty) {
      if (!options.createOnly) throw new Error('空仓库需要先手动初始化远程索引')
      const current = await this.head(options)
      if (!current.empty || !current.writable) throw new Error('仓库状态或写入权限已变化，请刷新')
      // GitHub's Git Data API cannot create a ref in an empty repository. Bootstrap
      // a unique metadata note with Contents create (no sha), never a partial manifest.
      const note = `.bpbox/initializations/${randomUUID()}.md`
      const result = await this.json<{
        commit: { sha: string; tree: { sha: string }; parents: unknown[] }
      }>(
        `${this.base}/contents/${note}`,
        'PUT',
        {
          message: 'BPbox: prepare remote index initialization',
          branch: this.repository.branch,
          content: Buffer.from(
            'BPbox sync metadata. Keep .bpbox/ when removing ordinary resources.\n'
          ).toString('base64')
        },
        options
      )
      this.cache.clear()
      if (!Array.isArray(result.commit.parents) || result.commit.parents.length)
        throw new Error('初始化期间仓库已新增提交，请刷新并重新核对已有资源；尚未发布索引')
      parent = { sha: result.commit.sha, tree: result.commit.tree.sha, writable: true }
      if (!parent.sha || !parent.tree) throw new Error('GitHub 未返回初始化提交，请刷新仓库后重试')
    }
    const progress = { total: files.size, completed: 0, skipped: 0, failed: 0 }
    options.onProgress?.({
      ...progress,
      stage: 'scanning',
      currentFile: '',
      message: '核对远程文件内容',
      cancellable: true
    })
    const existing = await this.fileTree(parent.tree, [...files.keys()], options)
    if (options.createOnly) {
      for (const [path, data] of files) {
        if (data === null) throw new Error(`初始化禁止删除远程文件：${path}`)
        const sha = createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex')
        if (existing.has(path) && existing.get(path) !== sha)
          throw new Error(`初始化存在数据冲突，拒绝覆盖远程文件：${path}；请先备份并人工核对`)
      }
    }
    const known = new Set([...existing.values(), ...this.uploadedBlobs])
    const tree: { path: string; mode: string; type: string; sha: string | null }[] = []
    for (const [path, data] of files) {
      options.signal?.throwIfAborted()
      options.onProgress?.({
        ...progress,
        stage: 'uploading',
        currentFile: path,
        message: data === null ? '准备删除记录' : '上传文件',
        cancellable: true
      })
      try {
        const sha =
          data === null
            ? null
            : createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex')
        if ((existing.get(path) ?? null) === sha) {
          progress.skipped++
        } else {
          if (data !== null && sha !== null) {
            if (known.has(sha)) progress.skipped++
            else {
              const blob = await this.json<{ sha: string }>(
                `${this.base}/git/blobs`,
                'POST',
                {
                  content: data.toString('base64'),
                  encoding: 'base64'
                },
                { ...options, ...progress, filePath: path, fileSize: data.length }
              )
              if (blob.sha !== sha) throw new Error('GitHub 返回的 Blob SHA 与本地内容不一致')
              known.add(sha)
              if (this.uploadedBlobs.size >= 20000)
                this.uploadedBlobs.delete(this.uploadedBlobs.values().next().value!)
              this.uploadedBlobs.add(sha)
            }
          }
          tree.push({ path, mode: '100644', type: 'blob', sha })
        }
        progress.completed++
        options.onProgress?.({ ...progress })
      } catch (error) {
        options.signal?.throwIfAborted()
        progress.failed++
        options.onProgress?.({ ...progress })
        throw new Error(
          `上传文件失败：${path}（${data?.length ?? 0} 字节）\n${(error as Error).message}`
        )
      }
    }
    options.signal?.throwIfAborted()
    if (!tree.length) return parent.sha
    options.onProgress?.({
      stage: 'committing',
      currentFile: '',
      message: '创建 Tree',
      cancellable: true
    })
    const createdTree = await this.json<{ sha: string }>(
      `${this.base}/git/trees`,
      'POST',
      {
        base_tree: parent.tree,
        tree
      },
      options
    )
    if (!createdTree.sha) throw new Error('GitHub 未返回 Tree SHA')
    options.onProgress?.({ message: '创建 Commit' })
    const commit = await this.json<{ sha: string }>(
      `${this.base}/git/commits`,
      'POST',
      {
        message,
        tree: createdTree.sha,
        parents: [parent.sha]
      },
      options
    )
    if (!commit.sha) throw new Error('GitHub 未返回 Commit SHA')
    options.signal?.throwIfAborted()
    // Once the ref mutation starts, finish verification even if cancellation is requested.
    options.onProgress?.({ message: '更新并确认分支引用', cancellable: false })
    const finalizing = { ...options, signal: undefined }
    try {
      await this.json(
        `${this.base}/git/refs/heads/${encodeURIComponent(this.repository.branch)}`,
        'PATCH',
        { sha: commit.sha, force: false },
        finalizing
      )
    } catch (error) {
      // A timeout may occur after GitHub accepted the update. Never retry a ref mutation blindly.
      const current = await this.head(finalizing).catch(() => null)
      if (current?.sha !== commit.sha) throw error
    }
    this.cache.clear()
    this.uploadedBlobs.clear()
    return commit.sha
  }
}
