import { useEffect, useMemo, useState } from 'react'

import DisplayCanvas from '../components/display/DisplayCanvas'
import type { BpRuntimeState, DisplaySettings } from '../types/bp'

const emptyPreviewState: BpRuntimeState = {
  flowName: '预览流程',
  createdAt: new Date().toISOString(),
  stepCursor: 0,
  status: 'idle',
  currentStep: null,
  slotCounts: {
    star: {
      picks: 1,
      bans: 1
    },
    rail: {
      picks: 1,
      bans: 1
    }
  },
  starTeam: {
    name: '先手',
    picks: [],
    bans: []
  },
  railTeam: {
    name: '后手',
    picks: [],
    bans: []
  },
  actions: [],
  eventHistory: [],
  currentEvents: [],
  executedPageChangeIds: [],
  currentPageChangeIds: []
}

function PreviewPage(): React.JSX.Element {
  const [settings, setSettings] = useState<DisplaySettings | null>(null)
  const [state, setState] = useState<BpRuntimeState>(emptyPreviewState)
  const [replayNonce, setReplayNonce] = useState(0)

  useEffect(() => {
    window.bpAPI.displaySettings.get().then(setSettings)
    window.bpAPI.bp.getPreviewState().then((previewState) => {
      if (previewState) {
        setState(previewState)
        setReplayNonce(0)
      }
    })

    const stopSettings = window.bpAPI.displaySettings.onUpdated(setSettings)
    const stopBp = window.bpAPI.bp.onState((previewState) => {
      setState(previewState)
      setReplayNonce(0)
    })

    return () => {
      stopSettings()
      stopBp()
    }
  }, [])

  const slotEffectPreview = state.slotEffectPreview ?? null
  const previewSettings = useMemo<DisplaySettings | null>(() => {
    if (!settings || !slotEffectPreview) {
      return settings
    }

    return {
      ...settings,
      slotEffects: {
        ...settings.slotEffects,
        [slotEffectPreview.action]: slotEffectPreview.config
      }
    }
  }, [settings, slotEffectPreview])
  const previewLabel = slotEffectPreview
    ? `${
        slotEffectPreview.action === 'pick'
          ? 'PICK'
          : slotEffectPreview.action === 'ban'
            ? 'BAN'
            : slotEffectPreview.action === 'protect'
              ? '保护'
              : '租借'
      } · ${slotEffectPreview.videoMode === 'pending' ? '待选特效' : '确选特效'}`
    : null

  return (
    <div className="display-page preview-page">
      {previewSettings ? (
        <DisplayCanvas
          settings={previewSettings}
          state={state}
          className="preview-window-stage"
          showCenterStage={false}
          showChantVideoSlotGuide={!slotEffectPreview}
          showProtectRentFrameGuides={!slotEffectPreview}
          previewSlotEffect={
            slotEffectPreview
              ? {
                  action: slotEffectPreview.action,
                  videoMode: slotEffectPreview.videoMode,
                  nonce: slotEffectPreview.nonce + replayNonce
                }
              : null
          }
        />
      ) : null}
      {slotEffectPreview ? (
        <div className="preview-effect-toolbar">
          <span>{previewLabel}</span>
          <button type="button" onClick={() => setReplayNonce((current) => current + 1)}>
            播放 / 重播
          </button>
        </div>
      ) : null}
    </div>
  )
}

export default PreviewPage
