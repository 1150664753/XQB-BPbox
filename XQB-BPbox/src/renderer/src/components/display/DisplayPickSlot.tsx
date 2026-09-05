import type { CSSProperties, ReactNode } from 'react'

import type { Character } from '../../types/character'
import type { LightCone } from '../../types/lightCone'

interface DisplayPickSlotProps {
  target?: Character | LightCone
  side: 'star' | 'rail'
  index: number
  tentative?: boolean
  imageMode?: 'avatar' | 'sideHeads'
  variant?: 'pick' | 'protect' | 'borrow'
  fallbackName?: string | null
  showName?: boolean
  placeholder?: string
  style?: CSSProperties
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
  side: 'star' | 'rail',
  imageMode: 'avatar' | 'sideHeads'
): string | null {
  if (!target) {
    return null
  }

  if (isLightCone(target)) {
    return imageMode === 'avatar'
      ? target.small_image_url || target.large_image_url || null
      : target.large_image_url || target.small_image_url || null
  }

  if (imageMode === 'avatar') {
    return (
      target.avatar_small_image_url ||
      target.left_head_image_url ||
      target.right_head_image_url ||
      null
    )
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
  imageMode = 'sideHeads',
  variant = 'pick',
  fallbackName = null,
  showName = true,
  placeholder,
  style,
  children
}: DisplayPickSlotProps): React.JSX.Element {
  const imageUrl = pickImage(target, side, imageMode)
  const name = targetName(target) || fallbackName || ''
  const className = [
    'display-slot',
    `display-${variant}-slot`,
    imageMode === 'avatar' ? 'display-slot-avatar-mode' : 'display-slot-side-head-mode',
    tentative ? 'display-slot-tentative' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={className} style={style}>
      {imageUrl ? <img src={imageUrl} alt={name} /> : <span>{placeholder ?? `P${index}`}</span>}
      {showName && name ? <strong>{name}</strong> : null}
      {children}
    </div>
  )
}

export default DisplayPickSlot
