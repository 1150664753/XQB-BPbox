import type { DisplaySettings } from './types'

export type DisplayAudioVolumeField =
  | 'bpSoundVolume'
  | 'characterVoiceVolume'
  | 'characterEffectVolume'

export const defaultDisplayAudioVolumePercent = 100

export function normalizeDisplayAudioVolumePercent(value: unknown): number {
  if (value === null || value === undefined || value === '') {
    return defaultDisplayAudioVolumePercent
  }

  const volume = Number(value)

  if (!Number.isFinite(volume)) {
    return defaultDisplayAudioVolumePercent
  }

  return Math.max(0, Math.min(100, Math.round(volume)))
}

export function displayAudioVolumeToGain(value: unknown): number {
  return normalizeDisplayAudioVolumePercent(value) / 100
}

export function displayAudioGain(
  settings: Pick<DisplaySettings, DisplayAudioVolumeField> | null | undefined,
  field: DisplayAudioVolumeField
): number {
  return displayAudioVolumeToGain(settings?.[field])
}
