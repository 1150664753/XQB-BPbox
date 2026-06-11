import { app, BrowserWindow } from 'electron'

const mutedByVoiceDisplay = new WeakMap<BrowserWindow, boolean>()
let latestCreatedWindow: BrowserWindow | null = null
let manualVoiceTimelineAudioMuteActive = false
let manualVoiceTimelineDisplayWindow: BrowserWindow | null = null
let manualVoiceTimelineDisplayWindowClosedHandler: (() => void) | null = null

function normalizedWindowText(window: BrowserWindow): string {
  try {
    return decodeURIComponent(`${window.webContents.getURL()} ${window.getTitle()}`).toLowerCase()
  } catch {
    return `${window.webContents.getURL()} ${window.getTitle()}`.toLowerCase()
  }
}

function isVoiceTimelineDisplayWindow(window: BrowserWindow): boolean {
  const text = normalizedWindowText(window)
  return (
    text.includes('voice-timeline-display') ||
    text.includes('voicetimelinedisplay') ||
    text.includes('voicetimeline') ||
    (text.includes('voice') && text.includes('timeline'))
  )
}

function updatePreviewAudioMuted(): void {
  const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed())
  const voiceTimelineDisplayWindows = windows.filter(isVoiceTimelineDisplayWindow)
  const manualVoiceTimelineWindow =
    manualVoiceTimelineDisplayWindow &&
    !manualVoiceTimelineDisplayWindow.isDestroyed() &&
    windows.includes(manualVoiceTimelineDisplayWindow)
      ? manualVoiceTimelineDisplayWindow
      : null
  const fallbackVoiceDisplayWindow =
    latestCreatedWindow &&
    !latestCreatedWindow.isDestroyed() &&
    windows.includes(latestCreatedWindow) &&
    latestCreatedWindow.webContents.isCurrentlyAudible()
      ? latestCreatedWindow
      : null
  const windowsToKeepAudible = manualVoiceTimelineAudioMuteActive
    ? new Set(manualVoiceTimelineWindow ? [manualVoiceTimelineWindow] : [])
    : voiceTimelineDisplayWindows.length > 0
      ? new Set(voiceTimelineDisplayWindows)
      : fallbackVoiceDisplayWindow
        ? new Set([fallbackVoiceDisplayWindow])
        : null

  for (const window of windows) {
    if (windowsToKeepAudible && !windowsToKeepAudible.has(window)) {
      if (!mutedByVoiceDisplay.has(window)) {
        mutedByVoiceDisplay.set(window, window.webContents.isAudioMuted())
      }
      window.webContents.setAudioMuted(true)
      continue
    }

    if (mutedByVoiceDisplay.has(window)) {
      window.webContents.setAudioMuted(mutedByVoiceDisplay.get(window) ?? false)
      mutedByVoiceDisplay.delete(window)
    }
  }
}

function schedulePreviewAudioMutedUpdate(): void {
  setTimeout(updatePreviewAudioMuted, 0)
}

function clearManualVoiceTimelineDisplayWindow(): void {
  if (
    manualVoiceTimelineDisplayWindow &&
    manualVoiceTimelineDisplayWindowClosedHandler &&
    !manualVoiceTimelineDisplayWindow.isDestroyed()
  ) {
    manualVoiceTimelineDisplayWindow.removeListener(
      'closed',
      manualVoiceTimelineDisplayWindowClosedHandler
    )
  }
  manualVoiceTimelineDisplayWindow = null
  manualVoiceTimelineDisplayWindowClosedHandler = null
}

export function beginVoiceTimelineDisplayAudioMute(window?: BrowserWindow): void {
  manualVoiceTimelineAudioMuteActive = true
  if (window && !window.isDestroyed() && window !== manualVoiceTimelineDisplayWindow) {
    clearManualVoiceTimelineDisplayWindow()
    manualVoiceTimelineDisplayWindow = window
    manualVoiceTimelineDisplayWindowClosedHandler = endVoiceTimelineDisplayAudioMute
    window.once('closed', manualVoiceTimelineDisplayWindowClosedHandler)
  }
  updatePreviewAudioMuted()
}

export function endVoiceTimelineDisplayAudioMute(): void {
  manualVoiceTimelineAudioMuteActive = false
  clearManualVoiceTimelineDisplayWindow()
  updatePreviewAudioMuted()
}

export function registerPreviewAudioMute(): void {
  app.on('browser-window-created', (_event, window) => {
    latestCreatedWindow = window

    window.webContents.on('did-finish-load', schedulePreviewAudioMutedUpdate)
    window.webContents.on('did-navigate', schedulePreviewAudioMutedUpdate)
    window.webContents.on('did-navigate-in-page', schedulePreviewAudioMutedUpdate)
    window.webContents.on('media-started-playing', schedulePreviewAudioMutedUpdate)
    window.on('page-title-updated', schedulePreviewAudioMutedUpdate)
    window.on('show', schedulePreviewAudioMutedUpdate)
    window.on('closed', schedulePreviewAudioMutedUpdate)

    schedulePreviewAudioMutedUpdate()
  })
}

registerPreviewAudioMute()
