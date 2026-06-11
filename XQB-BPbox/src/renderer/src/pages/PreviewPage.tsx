import { useEffect, useState } from 'react'

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
    name: '左侧队',
    picks: [],
    bans: []
  },
  railTeam: {
    name: '右侧队',
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

  useEffect(() => {
    window.bpAPI.displaySettings.get().then(setSettings)
    window.bpAPI.bp.getPreviewState().then((previewState) => {
      if (previewState) {
        setState(previewState)
      }
    })

    const stopSettings = window.bpAPI.displaySettings.onUpdated(setSettings)
    const stopBp = window.bpAPI.bp.onState(setState)

    return () => {
      stopSettings()
      stopBp()
    }
  }, [])

  return (
    <div className="display-page preview-page">
      {settings ? (
        <DisplayCanvas
          settings={settings}
          state={state}
          className="preview-window-stage"
          showCenterStage={false}
          showChantVideoSlotGuide
        />
      ) : null}
    </div>
  )
}

export default PreviewPage
