import { ipcMain } from 'electron'

import type { CharacterFilters, CharacterPayload } from '../../shared/types'
import {
  createCharacter,
  deleteCharacter,
  listCharacters,
  syncCharacterBasicsFromResourceRows,
  updateCharacter
} from '../stores/characters'
import {
  loadCharacterResourceTable,
  saveCharacterResourceTable,
  scanCharacterResourceTable
} from '../stores/characterResourceTable'
import type { CharacterResourceTableRow } from '../../shared/types'
import { notifyProjectFilesChanged } from '../projectFileWatchers'

export function registerCharacterIpc(): void {
  ipcMain.handle('characters:list', (_event, filters?: CharacterFilters) => listCharacters(filters))
  ipcMain.handle('characters:create', (_event, payload: CharacterPayload) => {
    const character = createCharacter(payload)
    notifyProjectFilesChanged(['characters'])
    return character
  })
  ipcMain.handle('characters:update', (_event, id: number, payload: CharacterPayload) => {
    const character = updateCharacter(id, payload)
    notifyProjectFilesChanged(['characters'])
    return character
  })
  ipcMain.handle('characters:delete', (_event, id: number) => {
    const deleted = deleteCharacter(id)
    if (deleted) {
      notifyProjectFilesChanged(['characters'])
    }
    return deleted
  })
  ipcMain.handle('characters:resource-table:load', () => loadCharacterResourceTable())
  ipcMain.handle('characters:resource-table:scan', () => {
    const result = scanCharacterResourceTable()
    notifyProjectFilesChanged(['characterResourceTable'])
    return result
  })
  ipcMain.handle('characters:resource-table:save', (_event, rows: CharacterResourceTableRow[]) => {
    const result = saveCharacterResourceTable(rows)
    const syncedCharacters = syncCharacterBasicsFromResourceRows(result.rows)
    notifyProjectFilesChanged(
      syncedCharacters > 0 ? ['characterResourceTable', 'characters'] : ['characterResourceTable']
    )
    return {
      ...result,
      synced_characters: syncedCharacters
    }
  })
}
