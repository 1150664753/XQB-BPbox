import { resolveStoredPath } from '../assets'
import { listCharacters } from '../stores/characters'
import { listLightCones } from '../stores/lightCones'
import { RemoteAssetProvider } from './RemoteAssetProvider'

export const projectRemoteAssetProvider = new RemoteAssetProvider({
  listCharacters,
  listLightCones,
  resolveStoredPath
})
