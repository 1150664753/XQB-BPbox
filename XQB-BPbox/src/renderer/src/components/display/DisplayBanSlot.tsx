import type { CSSProperties, ReactNode } from 'react'

import type { Character } from '../../types/character'
import type { LightCone } from '../../types/lightCone'

interface DisplayBanSlotProps {
  target?: Character | LightCone
  index: number
  style?: CSSProperties
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

function banImage(target: Character | LightCone | undefined): string | null {
  if (!target) {
    return null
  }

  return isLightCone(target)
    ? target.small_image_url || target.large_image_url || null
    : target.avatar_small_image_url ||
        target.left_head_image_url ||
        target.right_head_image_url ||
        target.full_body_image_url ||
        null
}

function DisplayBanSlot({
  target,
  index,
  style,
  tentative = false,
  children
}: DisplayBanSlotProps): React.JSX.Element {
  const imageUrl = banImage(target)
  const name = targetName(target)

  return (
    <div
      className={`display-slot display-ban-slot${tentative ? ' display-slot-tentative' : ''}`}
      style={style}
    >
      {imageUrl ? <img src={imageUrl} alt={name} /> : <span>B{index}</span>}
      {target ? <strong>{name}</strong> : null}
      {children}
    </div>
  )
}

export default DisplayBanSlot
