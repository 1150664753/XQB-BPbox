import { contextBridge, ipcRenderer } from 'electron'

import type { BpAPI } from './types'
import type { ProjectFileChangeEvent } from '../shared/types'

const bpAPI: BpAPI = {
  updater: {
    getState: () => ipcRenderer.invoke('updater:get-state'),
    checkForUpdates: () => ipcRenderer.invoke('updater:check'),
    downloadUpdate: () => ipcRenderer.invoke('updater:download'),
    installUpdate: () => ipcRenderer.invoke('updater:install'),
    onState: (callback): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, state): void => callback(state)
      ipcRenderer.on('updater:state', listener)
      return () => ipcRenderer.removeListener('updater:state', listener)
    }
  },
  characters: {
    list: (filters) => ipcRenderer.invoke('characters:list', filters),
    create: (payload) => ipcRenderer.invoke('characters:create', payload),
    update: (id, payload) => ipcRenderer.invoke('characters:update', id, payload),
    delete: (id) => ipcRenderer.invoke('characters:delete', id),
    loadResourceTable: () => ipcRenderer.invoke('characters:resource-table:load'),
    scanResourceTable: () => ipcRenderer.invoke('characters:resource-table:scan'),
    saveResourceTable: (rows) => ipcRenderer.invoke('characters:resource-table:save', rows)
  },
  lightCones: {
    list: (filters) => ipcRenderer.invoke('light-cones:list', filters),
    create: (payload) => ipcRenderer.invoke('light-cones:create', payload),
    update: (id, payload) => ipcRenderer.invoke('light-cones:update', id, payload),
    delete: (id) => ipcRenderer.invoke('light-cones:delete', id)
  },
  files: {
    selectImage: () => ipcRenderer.invoke('files:select-image'),
    selectVideo: () => ipcRenderer.invoke('files:select-video'),
    selectAudio: () => ipcRenderer.invoke('files:select-audio'),
    importAsset: (sourcePath, category, ownerName, assetKey) =>
      ipcRenderer.invoke('files:import-asset', sourcePath, category, ownerName, assetKey),
    toFileUrl: (storedPath) => ipcRenderer.invoke('files:to-file-url', storedPath),
    exists: (storedPath) => ipcRenderer.invoke('files:exists', storedPath),
    scanAssets: (kind) => ipcRenderer.invoke('files:scan-assets', kind),
    openConfigFolder: () => ipcRenderer.invoke('files:open-config-folder'),
    openAssetsFolder: () => ipcRenderer.invoke('files:open-assets-folder'),
    onChanged: (callback): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, event: ProjectFileChangeEvent): void =>
        callback(event)
      ipcRenderer.on('project-files:changed', listener)
      return () => ipcRenderer.removeListener('project-files:changed', listener)
    }
  },
  flows: {
    list: () => ipcRenderer.invoke('flows:list'),
    save: (config) => ipcRenderer.invoke('flows:save', config),
    load: (fileName) => ipcRenderer.invoke('flows:load', fileName),
    delete: (fileName) => ipcRenderer.invoke('flows:delete', fileName),
    rename: (fileName, nextName) => ipcRenderer.invoke('flows:rename', fileName, nextName),
    openFolder: () => ipcRenderer.invoke('flows:open-folder')
  },
  displaySettings: {
    list: () => ipcRenderer.invoke('display-settings:list'),
    get: (fileName) => ipcRenderer.invoke('display-settings:get', fileName),
    save: (settings, fileName) => ipcRenderer.invoke('display-settings:save', settings, fileName),
    updateLive: (settings) => ipcRenderer.invoke('display-settings:update-live', settings),
    delete: (fileName) => ipcRenderer.invoke('display-settings:delete', fileName),
    rename: (fileName, nextName) =>
      ipcRenderer.invoke('display-settings:rename', fileName, nextName),
    openFolder: () => ipcRenderer.invoke('display-settings:open-folder'),
    onUpdated: (callback): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, settings): void => callback(settings)
      ipcRenderer.on('display-settings:updated', listener)
      return () => ipcRenderer.removeListener('display-settings:updated', listener)
    }
  },
  bp: {
    sendStateToDisplay: (state) => ipcRenderer.invoke('bp:send-state-to-display', state),
    getCurrentState: () => ipcRenderer.invoke('bp:get-current-state'),
    getPreviewState: () => ipcRenderer.invoke('bp:get-preview-state'),
    listResults: () => ipcRenderer.invoke('bp:list-results'),
    loadResult: (fileName) => ipcRenderer.invoke('bp:load-result', fileName),
    saveResult: (result, fileName) => ipcRenderer.invoke('bp:save-result', result, fileName),
    deleteResult: (fileName) => ipcRenderer.invoke('bp:delete-result', fileName),
    renameResult: (fileName, nextName) =>
      ipcRenderer.invoke('bp:rename-result', fileName, nextName),
    getDisplayStatus: () => ipcRenderer.invoke('bp:get-display-status'),
    onDisplayStatus: (callback): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, online): void => callback(online)
      ipcRenderer.on('bp:display-status', listener)
      return () => ipcRenderer.removeListener('bp:display-status', listener)
    },
    openResultsFolder: () => ipcRenderer.invoke('bp:open-results-folder'),
    openDisplayWindow: () => ipcRenderer.invoke('bp:open-display-window'),
    sendDisplayReplayClick: (clickType) =>
      ipcRenderer.invoke('bp:send-display-replay-click', clickType),
    openDisplayWindowLinked: (state, playback, settings) =>
      ipcRenderer.invoke('bp:open-display-window-linked', state, playback, settings),
    openPreviewWindow: (state) => ipcRenderer.invoke('bp:open-preview-window', state),
    setVoiceTimelinePlayback: (playback) =>
      ipcRenderer.invoke('bp:set-voice-timeline-playback', playback),
    getVoiceTimelinePlayback: () => ipcRenderer.invoke('bp:get-voice-timeline-playback'),
    onVoiceTimelinePlayback: (callback): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, playback): void => callback(playback)
      ipcRenderer.on('bp:voice-timeline-playback', listener)
      return () => ipcRenderer.removeListener('bp:voice-timeline-playback', listener)
    },
    onState: (callback): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, state): void => callback(state)
      ipcRenderer.on('bp:state', listener)
      return () => ipcRenderer.removeListener('bp:state', listener)
    },
    onDisplayReplayClick: (callback): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, clickType): void => callback(clickType)
      ipcRenderer.on('bp:display-replay-click', listener)
      return () => ipcRenderer.removeListener('bp:display-replay-click', listener)
    }
  },
  remoteBp: {
    getAssetManifest: () => ipcRenderer.invoke('remote-bp:get-asset-manifest'),
    getAssetDescriptor: (assetId) => ipcRenderer.invoke('remote-bp:get-asset-descriptor', assetId),
    getAsset: (assetId) => ipcRenderer.invoke('remote-bp:get-asset', assetId)
  },
  voiceTimelines: {
    list: () => ipcRenderer.invoke('voice-timelines:list'),
    load: (fileName) => ipcRenderer.invoke('voice-timelines:load', fileName),
    save: (config, fileName) => ipcRenderer.invoke('voice-timelines:save', config, fileName),
    delete: (fileName) => ipcRenderer.invoke('voice-timelines:delete', fileName),
    rename: (fileName, nextName) =>
      ipcRenderer.invoke('voice-timelines:rename', fileName, nextName),
    openFolder: () => ipcRenderer.invoke('voice-timelines:open-folder')
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('bpAPI', bpAPI)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.bpAPI = bpAPI
}
