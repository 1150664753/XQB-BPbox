import { ipcMain, nativeImage, net, webContents } from 'electron'
import type { TeamRepository, SyncRequest, InitializeIndexRequest } from '../../shared/teamSync'
import { getProjectRootPath, resolveStoredPath } from '../assets'
import { isMainWebContents } from '../windows'
import { getTeamResourceBusyReason } from './bp'
import { notifyProjectFilesChanged } from '../projectFileWatchers'
import { atomicJson, inside, jsonRead, profilesAt } from '../teamSync/localProfile'
import {
  authorizeGitHub,
  githubAuthorization,
  githubToken,
  logoutGitHub,
  pollGitHub
} from '../teamSync/auth'
import { GitHubStore, GitHubError } from '../teamSync/github'
import { logTeamSync, teamSyncLogPath } from '../teamSync/logging'
import { TeamSyncService } from '../teamSync/service'
import { prepareRemoteImage } from '../remoteBp/prepareRemoteImage'

export function registerTeamSyncIpc(): void {
  const root = getProjectRootPath()
  const configPath = inside(root, '.team-sync/repository.json')
  let repository = jsonRead<TeamRepository>(configPath, {
    owner: '',
    repo: '',
    branch: 'main',
    clientId: ''
  })
  const services = new Map<string, TeamSyncService>()
  const tokens = new Map<string, string>()
  let operating = false
  function service(profileId: string): TeamSyncService {
    const profile = profilesAt(root).find((p) => p.id === profileId)
    if (!profile) throw new Error('找不到 Profile 映射')
    let value = services.get(profileId)
    if (!value) {
      const authorization = githubAuthorization(repository.clientId)
      logTeamSync({
        event: 'configuration',
        configPath,
        root,
        owner: repository.owner,
        repository: repository.repo,
        branch: repository.branch,
        tokenPresent: Boolean(authorization.token),
        authorizationProblem: authorization.problem,
        credentialSource: 'userData/team-github-auth.bin',
        logPath: teamSyncLogPath()
      })
      value = new TeamSyncService({
        root,
        profile,
        repositoryKey: `${repository.owner.toLowerCase()}/${repository.repo.toLowerCase()}/${repository.branch}`,
        remote: new GitHubStore(
          repository,
          () => {
            const authorization = githubAuthorization(repository.clientId)
            if (!authorization.token) throw new GitHubError(401, authorization.problem!)
            return authorization.token
          },
          net.fetch.bind(net),
          logTeamSync
        ),
        busy: getTeamResourceBusyReason,
        progress: (progress) => {
          for (const contents of webContents.getAllWebContents())
            if (!contents.isDestroyed() && isMainWebContents(contents))
              contents.send('team-sync:progress', progress)
        },
        log: logTeamSync,
        resolveAsset: (path) => resolveStoredPath(path) ?? path,
        previewImage: (bytes) => {
          const prepared = prepareRemoteImage(bytes, 'avatar', 'image/png')
          const image = nativeImage.createFromBuffer(Buffer.from(prepared.data))
          if (image.isEmpty()) return null
          return image
            .resize({ width: Math.min(256, image.getSize().width), quality: 'good' })
            .toPNG()
        },
        changed: () =>
          notifyProjectFilesChanged([
            'characters',
            'lightCones',
            'assets',
            'characterResourceTable',
            'flows',
            'displaySettings',
            'voiceTimelines',
            'bpResults'
          ])
      })
      services.set(profileId, value)
    }
    return value
  }
  const handle = (channel: string, fn: (...args: never[]) => unknown, exclusive = true): void => {
    ipcMain.handle(`team-sync:${channel}`, async (event, ...args) => {
      if (!isMainWebContents(event.sender) || event.senderFrame !== event.sender.mainFrame)
        throw new Error('团队资源仅允许主控制台访问')
      if (exclusive && operating) throw new Error('正在处理团队资源，请稍后重试')
      if (exclusive) operating = true
      try {
        return await fn(...(args as never[]))
      } finally {
        if (exclusive) operating = false
      }
    })
  }
  handle(
    'settings',
    () => ({
      profiles: profilesAt(root),
      repository,
      authorized: Boolean(githubToken(repository.clientId))
    }),
    false
  )
  handle('configure', (next: TeamRepository) => {
    if (
      !next ||
      !/^[a-zA-Z0-9-]+$/.test(next.owner) ||
      !/^[a-zA-Z0-9_.-]+$/.test(next.repo) ||
      !next.branch ||
      next.branch.length > 200 ||
      /[\s~^:?*[\\]|\.\.|@\{|\/\//.test(next.branch) ||
      next.branch.startsWith('/') ||
      next.branch.endsWith('/') ||
      !/^[a-zA-Z0-9_.-]{6,100}$/.test(next.clientId)
    )
      throw new Error('请填写有效的仓库所有者、仓库名、分支和 OAuth App Client ID')
    repository = {
      owner: next.owner.trim(),
      repo: next.repo.trim(),
      branch: next.branch.trim(),
      clientId: next.clientId.trim()
    }
    atomicJson(configPath, repository)
    services.clear()
    tokens.clear()
  })
  handle('authorize', () => authorizeGitHub(repository.clientId))
  handle('poll-authorization', () => pollGitHub(repository.clientId), false)
  handle('logout', () => {
    logoutGitHub()
    services.clear()
    tokens.clear()
  })
  handle('inspect', async (id: string) => {
    const result = await service(id).inspect()
    for (const [token, p] of tokens) if (p === id) tokens.delete(token)
    tokens.set(result.token, id)
    return result
  })
  handle(
    'preview',
    (token: string, id: string, side: 'local' | 'remote', field?: string) => {
      const profile = tokens.get(token)
      if (!profile || !['local', 'remote'].includes(side)) throw new Error('预览快照已过期')
      return service(profile).preview(token, id, side, field)
    },
    false
  )
  handle('sync', (request: SyncRequest) => service(request.profileId).sync(request))
  handle('initialize', (request: InitializeIndexRequest) =>
    service(request.profileId).initialize(request)
  )
  handle(
    'cancel',
    (profileId: string, operationId: string) =>
      services.get(profileId)?.cancel(operationId) ?? false,
    false
  )
  handle('apply-pending', (id: string) => service(id).applyPending())
  handle('discard-pending', (id: string) => service(id).discardPending())
  handle(
    'import-resource',
    (profileId: string, token: string, id: string, field: string, target: string) =>
      service(profileId).importResource(token, id, field, target)
  )
}
