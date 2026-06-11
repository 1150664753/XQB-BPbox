import type {
  BpRuntimeState,
  DisplayBackgroundLayer,
  DisplayPageChange,
  DisplaySettings
} from '../../types/bp'
import {
  coordinateScaleX,
  coordinateScaleY,
  designStageWidth,
  renderStageHeight,
  renderStageWidth
} from './displayGeometry'

interface DisplayBackgroundProps {
  settings: DisplaySettings
  state: BpRuntimeState
}

interface LayerChangeState {
  visible: boolean
  activeChange: DisplayPageChange | null
}

function normalizeEventName(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function legacyPageChangeKey(
  pageChangeName?: string | null,
  pageChangeIndex?: number | null
): string | null {
  return normalizeEventName(pageChangeName) ?? (pageChangeIndex ? String(pageChangeIndex) : null)
}

function pageChangeKeys(state: BpRuntimeState): string[] {
  const eventKeys = state.eventHistory
    ?.map((eventRecord) => normalizeEventName(eventRecord.name))
    .filter((key): key is string => Boolean(key))
  if (eventKeys?.length) {
    return eventKeys
  }

  const actionKeys = state.actions
    .map((action) => legacyPageChangeKey(action.pageChangeName, action.pageChangeIndex))
    .filter((key): key is string => Boolean(key))
  const currentKey = legacyPageChangeKey(
    state.currentStep?.pageChangeName,
    state.currentStep?.pageChangeIndex
  )

  return currentKey ? [...actionKeys, currentKey] : actionKeys
}

function currentPageChangeKeys(state: BpRuntimeState): string[] {
  const currentEvents = state.currentEvents
    ?.map(normalizeEventName)
    .filter((key): key is string => Boolean(key))
  if (currentEvents?.length) {
    return currentEvents
  }

  const currentKey = legacyPageChangeKey(
    state.currentStep?.pageChangeName,
    state.currentStep?.pageChangeIndex
  )
  return currentKey ? [currentKey] : []
}

function pageChangeTriggerKey(pageChange: DisplayPageChange): string | null {
  return (
    normalizeEventName(pageChange.triggerEvent) ??
    normalizeEventName(pageChange.triggerName) ??
    normalizeEventName(pageChange.name) ??
    (pageChange.index ? String(pageChange.index) : null)
  )
}

function matchesPageChangeKey(pageChange: DisplayPageChange, key: string): boolean {
  return pageChangeTriggerKey(pageChange) === key
}

function resolvedPageChanges(
  state: BpRuntimeState,
  pageChanges: DisplayPageChange[]
): Array<{ pageChange: DisplayPageChange; active: boolean }> {
  if (Array.isArray(state.executedPageChangeIds)) {
    const currentIds = new Set(state.currentPageChangeIds ?? [])
    return state.executedPageChangeIds
      .map((id) => pageChanges.find((pageChange) => pageChange.id === id) ?? null)
      .filter((pageChange): pageChange is DisplayPageChange => Boolean(pageChange))
      .map((pageChange) => ({
        pageChange,
        active: currentIds.has(pageChange.id)
      }))
  }

  const currentChangeKeys = new Set(currentPageChangeKeys(state))
  return pageChangeKeys(state).flatMap((changeKey) =>
    pageChanges
      .filter((pageChange) => matchesPageChangeKey(pageChange, changeKey))
      .map((pageChange) => ({
        pageChange,
        active: currentChangeKeys.has(changeKey)
      }))
  )
}

function isAnimatedBackgroundChange(pageChange: DisplayPageChange): boolean {
  return (
    pageChange.mode === 'flyIn' ||
    pageChange.mode === 'flyOut' ||
    pageChange.mode === 'expand' ||
    pageChange.mode === 'collapse'
  )
}

function fallbackLayers(settings: DisplaySettings): DisplayBackgroundLayer[] {
  if (Array.isArray(settings.backgroundLayers) && settings.backgroundLayers.length > 0) {
    return settings.backgroundLayers
  }

  return settings.backgroundImageUrl
    ? [
        {
          id: 'background-1',
          name: '背景 1',
          image: settings.backgroundImage,
          imageUrl: settings.backgroundImageUrl,
          x: settings.backgroundX,
          y: settings.backgroundY,
          scale: settings.backgroundScale,
          opacity: settings.backgroundOpacity,
          visible: true,
          layer: 1
        }
      ]
    : []
}

function resolveLayerChangeState(
  layer: DisplayBackgroundLayer,
  state: BpRuntimeState,
  pageChanges: DisplayPageChange[]
): LayerChangeState {
  return resolvedPageChanges(state, pageChanges).reduce<LayerChangeState>(
    (layerState, { pageChange, active }) => {
      if (
        (pageChange.target ?? 'backgroundLayer') === 'backgroundLayer' &&
        pageChange.layerId === layer.id
      ) {
        layerState.visible =
          pageChange.mode !== 'disappear' &&
          pageChange.mode !== 'flyOut' &&
          pageChange.mode !== 'collapse'
        layerState.activeChange =
          active && isAnimatedBackgroundChange(pageChange) ? pageChange : null
      }

      return layerState
    },
    {
      visible: layer.visible,
      activeChange: null
    }
  )
}

function flyInOffset(change: DisplayPageChange | null): { x: number; y: number } {
  if (!change) {
    return { x: 0, y: 0 }
  }

  switch (change.direction) {
    case 'right':
      return { x: renderStageWidth, y: 0 }
    case 'top':
      return { x: 0, y: -renderStageHeight }
    case 'bottom':
      return { x: 0, y: renderStageHeight }
    case 'custom':
      return { x: change.startX * coordinateScaleX, y: change.startY * coordinateScaleY }
    case 'left':
    default:
      return { x: -renderStageWidth, y: 0 }
  }
}

function DisplayBackground({ settings, state }: DisplayBackgroundProps): React.JSX.Element {
  const layers = fallbackLayers(settings)
  const pageChanges = Array.isArray(settings.pageChanges) ? settings.pageChanges : []
  const renderLayers = layers.filter((layer) => layer.imageUrl)

  return (
    <div className="display-background">
      {renderLayers.map((layer, index) => {
        const layerState = resolveLayerChangeState(layer, state, pageChanges)
        const activeChange = layerState.activeChange
        const offset =
          activeChange?.mode === 'flyIn' || activeChange?.mode === 'flyOut'
            ? flyInOffset(activeChange)
            : { x: 0, y: 0 }

        return (
          <div
            className={`display-background-layer ${
              activeChange ? `change-${activeChange.mode}` : ''
            }`}
            key={layer.id}
            style={
              {
                opacity: layerState.visible ? layer.opacity : 0,
                zIndex: Number.isFinite(Number(layer.layer))
                  ? Number(layer.layer)
                  : renderLayers.length - index,
                '--background-layer-opacity': layer.opacity,
                '--background-change-duration': `${activeChange?.speed ?? 800}ms`,
                '--background-from-x': `${offset.x}px`,
                '--background-from-y': `${offset.y}px`
              } as React.CSSProperties
            }
          >
            <img
              className="display-background-image"
              src={layer.imageUrl ?? ''}
              alt=""
              aria-hidden="true"
              style={{
                left: `${layer.x * coordinateScaleX}px`,
                top: `${layer.y * coordinateScaleY}px`,
                width: `${designStageWidth * coordinateScaleX * Math.max(0.01, layer.scale)}px`
              }}
            />
          </div>
        )
      })}
    </div>
  )
}

export default DisplayBackground
