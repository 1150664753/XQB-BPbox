import { resolveStoredPath } from '../assets'
import { listCharacters } from '../stores/characters'
import { listLightCones } from '../stores/lightCones'
import { RemoteAssetProvider } from './RemoteAssetProvider'
import { prepareRemoteImage } from './prepareRemoteImage'

export const projectRemoteAssetProvider = new RemoteAssetProvider({
  listCharacters,
  listLightCones,
  resolveStoredPath,
  prepareImage: prepareRemoteImage
})
