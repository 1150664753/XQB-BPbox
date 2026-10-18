import { createRoot } from 'react-dom/client'
import TeamResourcesPanel from '../src/renderer/src/pages/TeamResourcesPanel'
import '../src/renderer/src/styles/vscode-light.css'
import '../src/renderer/src/styles/light-workbench.css'
import type {
  ResourceRow,
  SyncSnapshot,
  SyncProgress,
  SyncResult,
  TeamSyncAPI,
  TeamResource
} from '../src/shared/teamSync'

const file = { path: 'demo.png', sha256: 'a'.repeat(64), size: 100, extension: '.png' }
const resource = (id: string, name: string, type = 'character'): TeamResource => ({
  id,
  name,
  type,
  version: 3,
  hash: id,
  properties: { name, power: 10 },
  files: { avatar: file },
  dependencies: []
})
const alpha = resource('alpha', '开拓者'),
  beta = resource('beta', '巡游之刃', 'weapon'),
  gamma = resource('gamma', '夜色中的约定', 'card')
const snapshot: SyncSnapshot = {
  token: 'fixture',
  head: '123456789abc',
  offline: false,
  pending: 0,
  busyReason: '展示窗口正在使用资源，请关闭窗口后应用',
  rows: [
    {
      id: alpha.id,
      name: alpha.name,
      type: alpha.type,
      typeLabel: '角色',
      upload: 'conflict',
      download: 'conflict',
      problems: [],
      local: alpha,
      remote: { ...alpha, properties: { name: alpha.name, power: 12 } },
      differences: [
        {
          field: 'avatar',
          label: '头像',
          kind: 'file',
          local: file,
          remote: { ...file, sha256: 'b'.repeat(64) }
        },
        { field: 'power', label: '攻击力', kind: 'property', local: 10, remote: 12 }
      ]
    },
    {
      id: beta.id,
      name: beta.name,
      type: beta.type,
      typeLabel: '武器',
      upload: 'added',
      download: 'unchanged',
      problems: [],
      local: beta,
      differences: [{ field: 'avatar', label: '图标', kind: 'file', local: file, remote: null }]
    },
    {
      id: gamma.id,
      name: gamma.name,
      type: gamma.type,
      typeLabel: '卡牌',
      upload: 'unchanged',
      download: 'added',
      problems: [],
      remote: gamma,
      differences: [{ field: 'avatar', label: '立绘', kind: 'file', local: null, remote: file }]
    }
  ]
}
const calls: unknown[] = []
const imports: unknown[] = []
const listeners = new Set<(progress: SyncProgress) => void>()
let holdNext = false
let pending: { resolve: (result: SyncResult) => void; reject: (error: Error) => void } | undefined
let uploadProgress: SyncProgress
function advanceProgress(update: Partial<SyncProgress>): void {
  uploadProgress = { ...uploadProgress, ...update }
  for (const listener of listeners) listener(uploadProgress)
}
function holdUpload(): void {
  holdNext = true
}
function finishUpload(error?: string): void {
  advanceProgress({
    stage: error ? 'failed' : 'completed',
    failed: error ? 1 : 0,
    completed: error ? 12 : 65,
    message: error ?? '同步完成',
    cancellable: false
  })
  if (error) pending?.reject(new Error(error))
  else pending?.resolve({ pending: false, message: '同步完成', commit: 'commit-success' })
  pending = undefined
}
function enableFields(): void {
  const row = snapshot.rows[1]
  row.fields = [
    {
      field: '$properties',
      label: '属性配置',
      state: 'ready',
      upload: 'added',
      download: 'unchanged'
    },
    {
      field: 'avatar',
      label: '图标',
      state: 'ready',
      localPath: 'assets/icons/weapon.png',
      upload: 'added',
      download: 'unchanged'
    },
    {
      field: 'portrait',
      label: '大图',
      state: 'ready',
      localPath: 'assets/hire/weapon.png',
      upload: 'added',
      download: 'unchanged'
    },
    {
      field: 'missing',
      label: '缺失音频',
      state: 'missing',
      message: '文件缺失，可跳过此项同步其他资源',
      upload: 'unchanged',
      download: 'unchanged'
    },
    {
      field: 'video',
      label: '视频',
      state: 'excluded',
      message: '视频不参与同步',
      upload: 'unchanged',
      download: 'unchanged'
    },
    {
      field: 'external',
      label: '外部音频',
      state: 'external',
      message: '外部文件需要先安全导入',
      upload: 'unchanged',
      download: 'unchanged'
    }
  ]
  snapshot.rows[2].fields = [
    {
      field: '$properties',
      label: '属性配置',
      state: 'ready',
      upload: 'unchanged',
      download: 'added'
    },
    {
      field: 'avatar',
      label: '立绘',
      state: 'empty',
      remotePath: 'bpbox/profiles/demo/blobs/legacy.png',
      needsTarget: true,
      upload: 'unchanged',
      download: 'added'
    }
  ]
}
const api: TeamSyncAPI = {
  settings: async () => ({
    repository: {
      owner: 'BPbox-Team',
      repo: 'team-profiles',
      branch: 'main',
      clientId: 'client-id'
    },
    authorized: true,
    profiles: [
      {
        id: 'demo',
        name: '比赛通用 Profile',
        collections: ['character', 'weapon', 'card'].map((type) => ({
          type,
          label: type,
          store: `config/${type}.json`,
          idField: 'id',
          nameFields: ['name'],
          assetFields: { avatar: '头像' }
        }))
      }
    ]
  }),
  configure: async () => {},
  authorize: async () => ({
    userCode: 'ABCD-EFGH',
    verificationUri: 'https://github.com/login/device',
    expiresAt: Date.now() + 60000
  }),
  pollAuthorization: async () => 'pending',
  logout: async () => {},
  inspect: async () => structuredClone(snapshot),
  initialize: async (request) => {
    initializations.push(request)
    snapshot.offline = false
    snapshot.warning = undefined
    snapshot.remoteState = {
      status: 'ready',
      indexPath: '.bpbox/profiles/demo/manifest.json',
      canInitialize: false
    }
    return { pending: false, message: '远程索引初始化完成' }
  },
  preview: async (_token, id, side) =>
    `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="160" height="180"><rect width="160" height="180" fill="${side === 'local' ? '#dceafa' : '#e4e0f4'}"/><circle cx="80" cy="66" r="28" fill="${side === 'local' ? '#5f88ba' : '#8f78b2'}"/><path d="M30 180 Q30 105 80 105 Q130 105 130 180" fill="${side === 'local' ? '#5f88ba' : '#8f78b2'}"/><text x="80" y="166" fill="white" text-anchor="middle" font-family="sans-serif" font-size="12">${id}</text></svg>`)}`,
  sync: async (request) => {
    calls.push(request)
    if (holdNext) {
      holdNext = false
      return new Promise<SyncResult>((resolve, reject) => {
        pending = { resolve, reject }
        advanceProgress({
          operationId: 'fixture-operation',
          profileId: 'demo',
          direction: request.direction,
          stage: 'uploading',
          total: 65,
          completed: 12,
          skipped: 4,
          failed: 0,
          currentFile: 'assets/characters/small/当前上传文件.png',
          message: '上传文件',
          cancellable: true
        })
      })
    }
    return { pending: false, message: '所选资源已完成同步' }
  },
  onProgress: (callback) => {
    listeners.add(callback)
    return () => {
      listeners.delete(callback)
    }
  },
  cancel: async (profileId, operationId) => {
    if (profileId !== 'demo' || operationId !== 'fixture-operation' || !uploadProgress.cancellable)
      return false
    advanceProgress({ stage: 'cancelled', message: '同步已取消', cancellable: false })
    pending?.reject(new Error('同步已取消'))
    pending = undefined
    return true
  },
  applyPending: async () => ({ pending: false, message: '已应用' }),
  discardPending: async () => {},
  importResource: async (...args) => {
    imports.push(args)
  }
}
function enableRecovery(): void {
  for (const row of snapshot.rows.slice(1)) {
    row.download = 'missing'
    row.upload = 'modified'
    row.fields = [
      {
        field: '$properties',
        label: '属性配置',
        state: 'ready',
        upload: 'modified',
        download: 'unchanged'
      },
      {
        field: 'avatar',
        label: '头像',
        state: 'missing',
        upload: 'deleted',
        download: 'missing',
        localPath: 'assets/characters/small/original.png',
        remotePath: 'assets/characters/small/original.png'
      }
    ]
  }
}
function enablePagination(): void {
  snapshot.rows = Array.from({ length: 65 }, (_, index): ResourceRow => {
    const name = `results/bp/${index < 35 ? '预赛' : '决赛'} 第${index + 1}局.json`
    const document = { ...file, path: name, relativePath: name, extension: '.json' }
    const result = {
      ...resource(`result-${index}`, name, 'result'),
      properties: { configPath: name, content: { name }, pointers: {} },
      files: { document }
    }
    return {
      id: result.id,
      name,
      type: 'result',
      typeLabel: '结果文件',
      upload: 'added',
      download: 'missing',
      problems: [],
      local: result,
      remote: result,
      differences: [
        { field: 'document', label: '结果文件', kind: 'file', local: document, remote: null }
      ],
      fields: [
        {
          field: '$properties',
          label: '属性',
          state: 'ready',
          upload: 'added',
          download: 'missing'
        },
        {
          field: 'document',
          label: '结果文件',
          state: 'ready',
          upload: 'added',
          download: 'missing'
        }
      ]
    }
  })
  snapshot.rows.push(
    {
      ...snapshot.rows[0],
      id: 'unchanged-result',
      name: '已同步结果',
      upload: 'unchanged',
      download: 'unchanged'
    },
    {
      id: 'character-extra',
      name: '分页角色',
      type: 'character',
      typeLabel: '角色',
      upload: 'added',
      download: 'added',
      problems: [],
      differences: [],
      local: alpha,
      remote: alpha
    },
    {
      id: 'unsupported-extra',
      name: '未映射资源',
      type: 'unsupported',
      typeLabel: '未知类型',
      upload: 'added',
      download: 'added',
      problems: [],
      differences: []
    }
  )
}
const initializations: Parameters<TeamSyncAPI['initialize']>[0][] = []
function remoteState(
  status: NonNullable<SyncSnapshot['remoteState']>['status'],
  writable = true
): void {
  snapshot.offline = true
  snapshot.warning = '远程索引尚未就绪，已保留本地资源和上次索引'
  snapshot.remoteState = {
    status,
    indexPath: '.bpbox/profiles/demo/manifest.json',
    canInitialize: writable && ['empty', 'uninitialized', 'index_missing'].includes(status),
    conflictRisk: status === 'index_missing',
    existingFiles: status === 'index_missing' ? 2 : 0,
    resourceFiles:
      status === 'index_missing' ? ['assets/characters/已有资源.png', 'config/characters.json'] : []
  }
}
Object.assign(window, {
  bpAPI: { teamSync: api },
  teamSyncTest: {
    calls,
    initializations,
    remoteState,
    imports,
    enableFields,
    enableRecovery,
    enablePagination,
    holdUpload,
    advanceProgress,
    finishUpload
  }
})
createRoot(document.getElementById('root')!).render(
  <div className="console-shell">
    <aside className="activity-bar" />
    <aside className="side-panel">
      <div className="product-title">XQB-BPBox</div>
      <div className="side-note">
        <strong>团队资源</strong>
        <span>发布本地修改</span>
        <span>获取远程更新</span>
      </div>
    </aside>
    <main className="workbench">
      <TeamResourcesPanel />
    </main>
  </div>
)
