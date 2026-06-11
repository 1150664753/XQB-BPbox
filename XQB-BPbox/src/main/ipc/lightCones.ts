import { ipcMain } from 'electron'

import type { LightConeFilters, LightConePayload } from '../../shared/types'
import {
  createLightCone,
  deleteLightCone,
  listLightCones,
  updateLightCone
} from '../stores/lightCones'
import { notifyProjectFilesChanged } from '../projectFileWatchers'

export function registerLightConeIpc(): void {
  ipcMain.handle('light-cones:list', (_event, filters?: LightConeFilters) =>
    listLightCones(filters)
  )
  ipcMain.handle('light-cones:create', (_event, payload: LightConePayload) => {
    const lightCone = createLightCone(payload)
    notifyProjectFilesChanged(['lightCones'])
    return lightCone
  })
  ipcMain.handle('light-cones:update', (_event, id: number, payload: LightConePayload) => {
    const lightCone = updateLightCone(id, payload)
    notifyProjectFilesChanged(['lightCones'])
    return lightCone
  })
  ipcMain.handle('light-cones:delete', (_event, id: number) => {
    const deleted = deleteLightCone(id)
    if (deleted) {
      notifyProjectFilesChanged(['lightCones'])
    }
    return deleted
  })
}
