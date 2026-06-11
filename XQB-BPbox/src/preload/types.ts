import type {
  BpResult,
  BpResultListItem,
  BpDisplayReplayClickType,
  BpRuntimeState,
  Character,
  CharacterFilters,
  CharacterPayload,
  CharacterResourceTableLoadResult,
  CharacterResourceTableRow,
  DisplaySettings,
  DisplaySettingsListItem,
  FlowConfig,
  FlowListItem,
  ImportedAssetResult,
  LocalAssetFile,
  LocalAssetKind,
  LightCone,
  LightConeFilters,
  LightConePayload,
  ProjectFileChangeEvent,
  SavedFileResult,
  SelectFileResult,
  VoiceTimelineConfig,
  VoiceTimelineListItem,
  VoiceTimelinePlayback
} from '../shared/types'

export interface BpAPI {
  characters: {
    list: (filters?: CharacterFilters) => Promise<Character[]>
    create: (payload: CharacterPayload) => Promise<Character>
    update: (id: number, payload: CharacterPayload) => Promise<Character>
    delete: (id: number) => Promise<boolean>
    loadResourceTable: () => Promise<CharacterResourceTableLoadResult>
    scanResourceTable: () => Promise<CharacterResourceTableLoadResult>
    saveResourceTable: (
      rows: CharacterResourceTableRow[]
    ) => Promise<CharacterResourceTableLoadResult>
  }
  lightCones: {
    list: (filters?: LightConeFilters) => Promise<LightCone[]>
    create: (payload: LightConePayload) => Promise<LightCone>
    update: (id: number, payload: LightConePayload) => Promise<LightCone>
    delete: (id: number) => Promise<boolean>
  }
  files: {
    selectImage: () => Promise<SelectFileResult>
    selectVideo: () => Promise<SelectFileResult>
    selectAudio: () => Promise<SelectFileResult>
    importAsset: (
      sourcePath: string,
      category: 'characters' | 'light_cones' | 'display',
      ownerName: string,
      assetKey: string
    ) => Promise<ImportedAssetResult>
    toFileUrl: (storedPath: string | null | undefined) => Promise<string | null>
    exists: (storedPath: string | null | undefined) => Promise<boolean>
    scanAssets: (kind?: LocalAssetKind) => Promise<LocalAssetFile[]>
    openConfigFolder: () => Promise<boolean>
    openAssetsFolder: () => Promise<boolean>
    onChanged: (callback: (event: ProjectFileChangeEvent) => void) => () => void
  }
  flows: {
    list: () => Promise<FlowListItem[]>
    save: (config: FlowConfig) => Promise<SavedFileResult>
    load: (fileName?: string) => Promise<FlowConfig | null>
    delete: (fileName: string) => Promise<boolean>
    rename: (fileName: string, nextName: string) => Promise<SavedFileResult>
    openFolder: () => Promise<boolean>
  }
  displaySettings: {
    list: () => Promise<DisplaySettingsListItem[]>
    get: (fileName?: string) => Promise<DisplaySettings>
    save: (settings: DisplaySettings, fileName?: string) => Promise<DisplaySettings>
    updateLive: (settings: DisplaySettings) => Promise<DisplaySettings>
    delete: (fileName: string) => Promise<boolean>
    rename: (fileName: string, nextName: string) => Promise<SavedFileResult>
    openFolder: () => Promise<boolean>
    onUpdated: (callback: (settings: DisplaySettings) => void) => () => void
  }
  bp: {
    sendStateToDisplay: (state: BpRuntimeState) => Promise<boolean>
    getCurrentState: () => Promise<BpRuntimeState | null>
    getPreviewState: () => Promise<BpRuntimeState | null>
    listResults: () => Promise<BpResultListItem[]>
    loadResult: (fileName: string) => Promise<BpResult>
    saveResult: (result: BpResult, fileName?: string) => Promise<SavedFileResult>
    deleteResult: (fileName: string) => Promise<boolean>
    renameResult: (fileName: string, nextName: string) => Promise<SavedFileResult>
    getDisplayStatus: () => Promise<boolean>
    openResultsFolder: () => Promise<boolean>
    openDisplayWindow: () => Promise<boolean>
    sendDisplayReplayClick: (clickType: BpDisplayReplayClickType) => Promise<boolean>
    openDisplayWindowLinked: (
      state: BpRuntimeState,
      playback: VoiceTimelinePlayback,
      settings?: DisplaySettings | null
    ) => Promise<boolean>
    openPreviewWindow: (state?: BpRuntimeState) => Promise<boolean>
    onState: (callback: (state: BpRuntimeState) => void) => () => void
    onDisplayReplayClick: (callback: (clickType: BpDisplayReplayClickType) => void) => () => void
    setVoiceTimelinePlayback: (playback: VoiceTimelinePlayback | null) => Promise<boolean>
    getVoiceTimelinePlayback: () => Promise<VoiceTimelinePlayback | null>
    onVoiceTimelinePlayback: (
      callback: (playback: VoiceTimelinePlayback | null) => void
    ) => () => void
  }
  voiceTimelines: {
    list: () => Promise<VoiceTimelineListItem[]>
    load: (fileName: string) => Promise<VoiceTimelineConfig>
    save: (config: VoiceTimelineConfig, fileName?: string) => Promise<SavedFileResult>
    delete: (fileName: string) => Promise<boolean>
    rename: (fileName: string, nextName: string) => Promise<SavedFileResult>
    openFolder: () => Promise<boolean>
  }
}
