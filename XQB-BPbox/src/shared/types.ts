export type BpSide = 'star' | 'rail'
export type BpAction = 'pick' | 'ban' | 'change' | 'protect' | 'borrow'
export type BpTargetType = 'character' | 'lightCone' | 'none'
export type BpPlaybackMode = 'manual' | 'live'
export type BpDisplayReplayClickType = 'bp_step' | 'delay_extra_click'
export type ChangeEffectMode = 'clear' | 'keep' | 'next' | 'keepNext'
export type DisplayEffectMode = 'state' | 'event' | 'continuous' | 'trigger'

export type CharacterRarity = 4 | 5
export type LightConeRarity = 3 | 4 | 5

export type CharacterAssetField =
  | 'left_head_image'
  | 'right_head_image'
  | 'chant_video'
  | 'pv'
  | 'avatar_small_image'
  | 'full_body_image'
  | 'ban_voice'
  | 'pick_voice'
  | 'pick_sound'

export type LightConeAssetField = 'small_image'
export type CharacterResourceStatus = 'found' | 'missing' | 'notConfigured'
export type CharacterResourceTableAssetField =
  | CharacterAssetField
  | 'light_cone_small_image'
  | 'light_cone_large_image'

export type CharacterResourceTableSource = 'table' | 'characters' | 'assets' | 'empty'

export interface SelectFileResult {
  canceled: boolean
  path?: string
  fileName?: string
}

export interface ImportedAssetResult {
  storedPath: string
  url: string | null
  exists: boolean
}

export type LocalAssetKind = 'image' | 'audio' | 'video' | 'other'

export interface LocalAssetFile {
  name: string
  path: string
  url: string | null
  kind: LocalAssetKind
  size: number
  updatedAt: string
}

export type ProjectFileChangeArea =
  | 'assets'
  | 'characters'
  | 'lightCones'
  | 'characterResourceTable'
  | 'flows'
  | 'displaySettings'
  | 'bpResults'
  | 'voiceTimelines'

export interface ProjectFileChangeEvent {
  areas: ProjectFileChangeArea[]
  changedAt: string
}

export interface CharacterPayload {
  code?: string
  english_name: string
  chinese_name: string
  rarity: CharacterRarity
  element: string
  path: string
  left_head_image?: string | null
  right_head_image?: string | null
  chant_video?: string | null
  pv?: string | null
  pv_start_time?: number
  pv_end_time?: number
  avatar_small_image?: string | null
  full_body_image?: string | null
  ban_voice?: string | null
  pick_voice?: string | null
  pick_sound?: string | null
}

export interface CharacterResourceTableRow {
  row_id: string
  code: string
  english_name: string
  chinese_name: string
  rarity: CharacterRarity | null
  element: string
  path: string
  left_head_image?: string | null
  right_head_image?: string | null
  chant_video?: string | null
  pv?: string | null
  pv_start_time?: number
  pv_end_time?: number
  avatar_small_image?: string | null
  full_body_image?: string | null
  ban_voice?: string | null
  pick_voice?: string | null
  pick_sound?: string | null
  light_cone_small_image?: string | null
  light_cone_large_image?: string | null
  resource_status?: Partial<Record<CharacterResourceTableAssetField, CharacterResourceStatus>>
  status?: string
  created_at: string
  updated_at: string
}

export interface CharacterResourceTableLoadResult {
  rows: CharacterResourceTableRow[]
  source: CharacterResourceTableSource
  path: string
  warnings: string[]
  synced_characters?: number
}

export interface Character extends CharacterPayload {
  id: number
  code: string
  left_head_image: string | null
  right_head_image: string | null
  chant_video: string | null
  pv: string | null
  pv_start_time: number
  pv_end_time: number
  avatar_small_image: string | null
  full_body_image: string | null
  ban_voice: string | null
  pick_voice: string | null
  pick_sound: string | null
  created_at: string
  updated_at: string
  left_head_image_url?: string | null
  right_head_image_url?: string | null
  chant_video_url?: string | null
  pv_url?: string | null
  avatar_small_image_url?: string | null
  full_body_image_url?: string | null
  ban_voice_url?: string | null
  pick_voice_url?: string | null
  pick_sound_url?: string | null
  left_head_image_exists?: boolean
  right_head_image_exists?: boolean
  chant_video_exists?: boolean
  pv_exists?: boolean
  avatar_small_image_exists?: boolean
  full_body_image_exists?: boolean
  ban_voice_exists?: boolean
  pick_voice_exists?: boolean
  pick_sound_exists?: boolean
}

export interface CharacterFilters {
  search?: string
  element?: string
  path?: string
  rarity?: CharacterRarity
}

export interface LightConePayload {
  name: string
  path: string
  rarity: LightConeRarity
  small_image?: string | null
  large_image?: string | null
}

export interface LightCone extends LightConePayload {
  id: number
  small_image: string | null
  large_image: string | null
  created_at: string
  updated_at: string
  small_image_url?: string | null
  large_image_url?: string | null
  small_image_exists?: boolean
  large_image_exists?: boolean
}

export interface LightConeFilters {
  search?: string
  path?: string
  rarity?: LightConeRarity
}

export interface FlowStep {
  index: number
  side: BpSide
  action: BpAction
  targetType: BpTargetType
  eventName?: string | null
  changeEffectMode?: ChangeEffectMode
  pageChangeName?: string | null
  pageChangeIndex?: number | null
}

export interface FlowConfig {
  name: string
  steps: FlowStep[]
}

export interface FlowListItem {
  fileName: string
  name: string
  updatedAt: string
}

export interface DisplaySettingsListItem {
  fileName: string
  name: string
  updatedAt: string
}

export interface DisplaySettings {
  stageWidth: number
  stageHeight: number
  triggerFlowFile: string
  backgroundImage: string
  backgroundX: number
  backgroundY: number
  backgroundScale: number
  backgroundOpacity: number
  backgroundImageUrl?: string | null
  bpSoundVolume: number
  characterVoiceVolume: number
  characterEffectVolume: number
  backgroundLayers: DisplayBackgroundLayer[]
  pageChanges: DisplayPageChange[]
  slotLayouts: DisplaySlotLayouts
  slotGroups?: DisplaySlotGroups
  secondaryPickCounts: DisplaySecondaryPickCounts
  secondaryBanCounts: DisplaySecondaryBanCounts
  chantVideoSlot: DisplayVideoSlotLayout
  slotEffects: DisplaySlotEffects
}

export interface DisplayBackgroundLayer {
  id: string
  name: string
  image: string
  imageUrl?: string | null
  x: number
  y: number
  scale: number
  opacity: number
  visible: boolean
  layer: number
}

export type DisplayPageChangeMode =
  | 'appear'
  | 'disappear'
  | 'flyIn'
  | 'flyOut'
  | 'expand'
  | 'collapse'
  | 'resizeVideo'
export type DisplayPageChangeTarget = 'backgroundLayer' | 'chantVideoSlot'
export type DisplayFlyInDirection = 'left' | 'right' | 'top' | 'bottom' | 'custom'

export interface DisplayPageChange {
  id: string
  index: number
  name: string
  triggerEvent?: string | null
  emitEvent?: string | null
  emitEventAfterComplete?: string | null
  triggerName: string
  delayTriggerEnabled?: boolean
  delayClickCount?: number
  target: DisplayPageChangeTarget
  layerId: string
  mode: DisplayPageChangeMode
  startX: number
  startY: number
  speed: number
  direction: DisplayFlyInDirection
  videoX: number
  videoY: number
  videoWidth: number
  videoHeight: number
}

export type DisplaySlotDirection = 'vertical' | 'horizontal'

export interface DisplaySlotLayout {
  x: number
  y: number
  width: number
  height: number
  gap: number
  gaps?: number[]
  layer: number
  direction: DisplaySlotDirection
  frameImage: string
  frameImageUrl?: string | null
  effectVideo: string
  effectVideoUrl?: string | null
}

export interface DisplaySlotLayouts {
  starPick: DisplaySlotLayout
  starPickSecond: DisplaySlotLayout
  starBan: DisplaySlotLayout
  starBanSecond: DisplaySlotLayout
  railPick: DisplaySlotLayout
  railPickSecond: DisplaySlotLayout
  railBan: DisplaySlotLayout
  railBanSecond: DisplaySlotLayout
}

export interface DisplaySlotGroup extends DisplaySlotLayout {
  slotCount: number
}

export interface DisplaySlotGroups {
  starPick: DisplaySlotGroup[]
  starBan: DisplaySlotGroup[]
  railPick: DisplaySlotGroup[]
  railBan: DisplaySlotGroup[]
}

export type DisplaySlotGroupKey = keyof DisplaySlotGroups

export interface DisplaySecondaryPickCounts {
  star: number
  rail: number
}

export interface DisplaySecondaryBanCounts {
  star: number
  rail: number
}

export interface DisplayVideoSlotLayout {
  x: number
  y: number
  width: number
  height: number
  visible: boolean
  layer: number
}

export interface DisplaySlotEffectLayout {
  x: number
  y: number
  scale: number
}

export interface DisplaySlotEffectConfig {
  effectMode: DisplayEffectMode
  triggerEvent?: string | null
  startEvent?: string | null
  endEvent?: string | null
  pendingVideo: string
  pendingVideoUrl?: string | null
  selectedVideo: string
  selectedVideoUrl?: string | null
  selectedSound: string
  selectedSoundUrl?: string | null
  pendingLayout: DisplaySlotEffectLayout
  delayActivateAfterEvents?: string[]
  keepLoop?: boolean
}

export interface DisplaySlotEffects {
  pick: DisplaySlotEffectConfig
  ban: DisplaySlotEffectConfig
  protect: DisplaySlotEffectConfig
  borrow: DisplaySlotEffectConfig
}

export type BpTeamTarget = Character | LightCone

export interface BpPreviewSelection {
  side: BpSide
  action: 'pick' | 'ban'
  target: BpTeamTarget
}

export interface TeamBpState {
  name: string
  picks: BpTeamTarget[]
  bans: BpTeamTarget[]
}

export interface TeamSlotCounts {
  picks: number
  bans: number
}

export interface BpSlotCounts {
  star: TeamSlotCounts
  rail: TeamSlotCounts
}

export interface BpActionRecord {
  stepIndex: number
  side: BpSide
  action: BpAction
  targetType: BpTargetType
  targetId: number
  targetName: string
  targetImage?: string | null
  target?: Character | LightCone | null
  eventName?: string | null
  starTargetId?: number | null
  starTargetName?: string | null
  starTarget?: Character | null
  railTargetId?: number | null
  railTargetName?: string | null
  railTarget?: Character | null
  changeEffectMode?: ChangeEffectMode
  pageChangeName?: string | null
  pageChangeIndex?: number | null
}

export interface BpEventRecord {
  name: string
  sourceActionIndex?: number | null
  depth: number
}

export interface BpRuntimeState {
  flowName: string
  createdAt: string
  playbackMode?: BpPlaybackMode
  upCharacterPvPath?: string | null
  upCharacterPvUrl?: string | null
  upCharacterPvStartTime?: number
  upCharacterPvEndTime?: number
  stepCursor: number
  status: 'idle' | 'running' | 'complete'
  currentStep: FlowStep | null
  previewSelection?: BpPreviewSelection | null
  followingStep?: FlowStep | null
  slotCounts: BpSlotCounts
  starTeam: TeamBpState
  railTeam: TeamBpState
  actions: BpActionRecord[]
  eventHistory?: BpEventRecord[]
  currentEvents?: string[]
  executedPageChangeIds?: string[]
  currentPageChangeIds?: string[]
}

export interface BpResult {
  name: string
  flowName: string
  flowConfig?: FlowConfig
  createdAt: string
  upCharacterPvPath?: string | null
  upCharacterPvStartTime?: number
  upCharacterPvEndTime?: number
  starTeam: TeamBpState
  railTeam: TeamBpState
  actions: BpActionRecord[]
}

export interface BpResultListItem {
  fileName: string
  name: string
  flowName: string
  createdAt: string
  updatedAt: string
  actionCount: number
}

export type VoiceTimelineClickPointType = 'bp_step' | 'delay_extra_click'

export interface VoiceTimelineClickPoint {
  id: string
  time: number
  type: VoiceTimelineClickPointType
  stepIndex?: number | null
  stepName?: string | null
  side?: BpSide | null
  action?: BpAction | null
  targetType?: BpTargetType | null
  targetId?: number | null
  targetName?: string | null
  iconPath?: string | null
  relatedDelayChangeId?: string | null
  relatedDelayChangeName?: string | null
  label?: string | null
}

export interface VoiceTimelineConfig {
  id: string
  name: string
  bpFlowConfigFile: string
  bpFlowConfigName: string
  bpResultFile: string
  bpResultName: string
  audioPath: string
  audioUrl?: string | null
  audioExists?: boolean
  duration: number
  playbackRate?: number
  clickPoints: VoiceTimelineClickPoint[]
  createdAt: string
  updatedAt?: string
}

export interface VoiceTimelineListItem {
  fileName: string
  name: string
  bpFlowConfigName: string
  bpResultName: string
  duration: number
  clickPointCount: number
  updatedAt: string
}

export interface VoiceTimelinePlayback {
  timelineId: string
  sessionId?: string
  timelineName: string
  audioPath: string
  audioUrl?: string | null
  duration: number
  clickPoints: VoiceTimelineClickPoint[]
  playbackRate?: number
  currentTime?: number
  playing?: boolean
  mode?: 'voice_timeline_linked'
}

export interface SavedFileResult {
  fileName: string
  path: string
}
