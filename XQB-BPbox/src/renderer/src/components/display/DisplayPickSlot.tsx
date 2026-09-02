import type { ReactNode } from 'react'

import type { Character } from '../../types/character'
import type { LightCone } from '../../types/lightCone'

interface DisplayPickSlotProps {
  target?: Character | LightCone
  side: 'star' | 'rail'
  index: number
  tentative?: boolean
  children?: ReactNode
}

function isLightCone(target: Character | LightCone): target is LightCone {
  return 'name' in target
}

function targetName(target: Character | LightCone | undefined): string {
  if (!target) {
    return ''
  }

  return isLightCone(target) ? target.name : target.chinese_name
}

function pickImage(
  target: Character | LightCone | undefined,
  side: 'star' | 'rail'
): string | null {
  if (!target) {
    return null
  }

  if (isLightCone(target)) {
    return target.large_image_url || target.small_image_url || null
  }

  return side === 'star'
    ? target.left_head_image_url || target.avatar_small_image_url || null
    : target.right_head_image_url || target.avatar_small_image_url || null
}

function DisplayPickSlot({
  target,
  side,
  index,
  tentative = false,
  children
}: DisplayPickSlotProps): React.JSX.Element {
  const imageUrl = pickImage(target, side)
  const name = targetName(target)

  return (
    <div className={`display-slot display-pick-slot${tentative ? ' display-slot-tentative' : ''}`}>
      {imageUrl ? <img src={imageUrl} alt={name} /> : <span>P{index}</span>}
      {target ? <strong>{name}</strong> : null}
      {children}
    </div>
  )
}

export default DisplayPickSlot
