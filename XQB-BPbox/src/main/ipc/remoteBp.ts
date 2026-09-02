import { ipcMain } from 'electron'

import { projectRemoteAssetProvider } from '../remoteBp/projectRemoteAssetProvider'

export function registerRemoteBpIpc(): void {
  ipcMain.handle('remote-bp:get-asset-manifest', () => projectRemoteAssetProvider.getManifest())
  ipcMain.handle('remote-bp:get-asset-descriptor', (_event, assetId: string) =>
    projectRemoteAssetProvider.getDescriptor(assetId)
  )
  ipcMain.handle('remote-bp:get-asset', (_event, assetId: string) =>
    projectRemoteAssetProvider.getAsset(assetId)
  )
}
