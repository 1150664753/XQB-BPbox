import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, watch, type FSWatcher } from 'node:fs'
import { resolve } from 'node:path'

import { ensureProjectDirectories, getAssetsPath, getConfigPath, getResultsPath } from './assets'
import { sendToAllWindows } from './windows'
import type { ProjectFileChangeArea, ProjectFileChangeEvent } from '../shared/types'

export const projectFilesChangedChannel = 'project-files:changed'

const debounceMs = 250
let started = false
let pendingTimer: NodeJS.Timeout | null = null
const pendingAreas = new Set<ProjectFileChangeArea>()
const directoryWatchers: DirectoryTreeWatcher[] = []

function uniqueAreas(
  areas: ProjectFileChangeArea | ProjectFileChangeArea[]
): ProjectFileChangeArea[] {
  return [...new Set(Array.isArray(areas) ? areas : [areas])]
}

export function notifyProjectFilesChanged(
  areas: ProjectFileChangeArea | ProjectFileChangeArea[]
): void {
  const nextAreas = uniqueAreas(areas)
  if (nextAreas.length === 0) {
    return
  }

  const event: ProjectFileChangeEvent = {
    areas: nextAreas,
    changedAt: new Date().toISOString()
  }

  sendToAllWindows(projectFilesChangedChannel, event)
}

function scheduleProjectFilesChanged(areas: ProjectFileChangeArea[]): void {
  areas.forEach((area) => pendingAreas.add(area))

  if (pendingTimer) {
    clearTimeout(pendingTimer)
  }

  pendingTimer = setTimeout(() => {
    const areasToSend = [...pendingAreas]
    pendingAreas.clear()
    pendingTimer = null
    notifyProjectFilesChanged(areasToSend)
  }, debounceMs)
}

function collectDirectories(rootPath: string): string[] {
  if (!existsSync(rootPath)) {
    return []
  }

  const directories = [rootPath]

  try {
    readdirSync(rootPath, { withFileTypes: true }).forEach((entry) => {
      if (entry.isDirectory()) {
        directories.push(...collectDirectories(resolve(rootPath, entry.name)))
      }
    })
  } catch {
    return directories
  }

  return directories
}

class DirectoryTreeWatcher {
  private readonly rootPath: string
  private readonly areas: ProjectFileChangeArea[]
  private readonly watchers = new Map<string, FSWatcher>()
  private refreshTimer: NodeJS.Timeout | null = null

  constructor(rootPath: string, areas: ProjectFileChangeArea[]) {
    this.rootPath = resolve(rootPath)
    this.areas = areas
  }

  start(): void {
    mkdirSync(this.rootPath, { recursive: true })
    this.refreshWatchedDirectories()
  }

  close(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer)
      this.refreshTimer = null
    }

    this.watchers.forEach((watcher) => watcher.close())
    this.watchers.clear()
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer)
    }

    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      this.refreshWatchedDirectories()
      scheduleProjectFilesChanged(this.areas)
    }, debounceMs)
  }

  private refreshWatchedDirectories(): void {
    const directories = new Set(
      collectDirectories(this.rootPath).map((directory) => resolve(directory))
    )

    this.watchers.forEach((watcher, directory) => {
      if (!directories.has(directory)) {
        watcher.close()
        this.watchers.delete(directory)
      }
    })

    directories.forEach((directory) => {
      if (this.watchers.has(directory)) {
        return
      }

      try {
        const watcher = watch(directory, { persistent: true }, () => this.scheduleRefresh())
        watcher.on('error', () => {
          watcher.close()
          this.watchers.delete(directory)
          this.scheduleRefresh()
        })
        this.watchers.set(directory, watcher)
      } catch {
        this.watchers.delete(directory)
      }
    })
  }
}

export function startProjectFileWatchers(): void {
  if (started) {
    return
  }

  started = true
  ensureProjectDirectories()

  const watchTargets: Array<{ rootPath: string; areas: ProjectFileChangeArea[] }> = [
    {
      rootPath: getAssetsPath(),
      areas: ['assets', 'characters', 'lightCones', 'characterResourceTable']
    },
    {
      rootPath: getConfigPath('app'),
      areas: ['characters', 'lightCones', 'characterResourceTable']
    },
    {
      rootPath: getConfigPath('display'),
      areas: ['displaySettings']
    },
    {
      rootPath: getConfigPath('bp'),
      areas: ['flows']
    },
    {
      rootPath: getConfigPath('audio'),
      areas: ['voiceTimelines']
    },
    {
      rootPath: getResultsPath('bp'),
      areas: ['bpResults']
    }
  ]

  watchTargets.forEach((target) => {
    const watcher = new DirectoryTreeWatcher(target.rootPath, target.areas)
    watcher.start()
    directoryWatchers.push(watcher)
  })
}

export function stopProjectFileWatchers(): void {
  directoryWatchers.forEach((watcher) => watcher.close())
  directoryWatchers.length = 0
  pendingAreas.clear()

  if (pendingTimer) {
    clearTimeout(pendingTimer)
    pendingTimer = null
  }

  started = false
}

app.once('before-quit', stopProjectFileWatchers)
