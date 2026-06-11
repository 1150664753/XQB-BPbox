export const designStageWidth = 1920
export const designStageHeight = 1080

// User-facing coordinates and rendered pixels share the same 1920x1080 space.
export const renderScaleFactor = 1
export const renderStageWidth = designStageWidth * renderScaleFactor
export const renderStageHeight = designStageHeight * renderScaleFactor
export const coordinateScaleX = renderStageWidth / designStageWidth
export const coordinateScaleY = renderStageHeight / designStageHeight
