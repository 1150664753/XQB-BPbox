export function playManagedAudio(
  url: string | null | undefined,
  volume: number,
  activeAudios?: Set<HTMLAudioElement>
): void {
  if (!url) {
    return
  }

  const audio = new Audio(url)
  audio.volume = volume

  const cleanup = (): void => {
    activeAudios?.delete(audio)
    audio.removeEventListener('ended', cleanup)
    audio.removeEventListener('error', cleanup)
  }

  if (activeAudios) {
    activeAudios.add(audio)
    audio.addEventListener('ended', cleanup)
    audio.addEventListener('error', cleanup)
  }

  audio.play().catch(() => cleanup())
}

export function updateManagedAudioVolume(
  activeAudios: Set<HTMLAudioElement>,
  volume: number
): void {
  activeAudios.forEach((audio) => {
    audio.volume = volume
  })
}
