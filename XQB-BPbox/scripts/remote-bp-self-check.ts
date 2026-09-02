import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { RemoteAssetProvider } from '../src/main/remoteBp/RemoteAssetProvider'
import {
  BpActionDispatcher,
  DEFAULT_REMOTE_SIDE_MAPPING,
  MockRemoteHostTransport,
  RemoteBpHost,
  REMOTE_BP_PROTOCOL_VERSION,
  MAX_REMOTE_BP_MESSAGE_BYTES,
  parseRemoteClientMessage,
  serializeRemoteBpState,
  type BpActionDispatchSnapshot,
  type BpActionExecutor,
  type AssetManifestEntry,
  type RemoteBpAction,
  type RemoteBpActionResult
} from '../src/shared/remoteBp'
import type {
  BpActionRecord,
  BpRuntimeState,
  Character,
  FlowStep,
  LightCone
} from '../src/shared/types'

const now = '2026-08-31T00:00:00.000Z'

function character(id: number, patch: Partial<Character> = {}): Character {
  return {
    id,
    code: String(id),
    english_name: `Character ${id}`,
    chinese_name: `角色${id}`,
    rarity: 5,
    element: '测试属性',
    path: '测试命途',
    left_head_image: null,
    right_head_image: null,
    chant_video: null,
    pv: null,
    pv_start_time: 0,
    pv_end_time: 0,
    avatar_small_image: null,
    full_body_image: null,
    ban_voice: null,
    pick_voice: null,
    pick_sound: null,
    created_at: now,
    updated_at: now,
    ...patch
  }
}

function runtimeFor(steps: FlowStep[]): BpRuntimeState {
  return {
    flowName: 'Remote BP 自检',
    createdAt: now,
    stepCursor: 0,
    status: steps.length > 0 ? 'running' : 'complete',
    currentStep: steps[0] ?? null,
    followingStep: steps[1] ?? null,
    slotCounts: {
      star: { picks: 1, bans: 1 },
      rail: { picks: 1, bans: 1 }
    },
    starTeam: { name: '星队', picks: [], bans: [] },
    railTeam: { name: '穹队', picks: [], bans: [] },
    actions: []
  }
}

function lightCone(id: number, patch: Partial<LightCone> = {}): LightCone {
  return {
    id,
    name: `光锥${id}`,
    path: '测试命途',
    rarity: 5,
    small_image: null,
    large_image: null,
    created_at: now,
    updated_at: now,
    ...patch
  }
}

function snapshot(step: FlowStep): BpActionDispatchSnapshot {
  return {
    started: true,
    currentStep: step,
    availableCharacterIds: ['1', '2'],
    availableLightConeIds: [],
    pickedCharacterIds: [],
    pickedCharacterIdsBySide: { star: [], rail: [] },
    availablePairedTargetIdsBySide: { star: [], rail: [] },
    selectedTarget: null,
    selectedTargetsBySide: { star: null, rail: null }
  }
}

function successfulExecutor(): BpActionExecutor {
  return {
    selectTarget: async () => ({ stateChanged: true }),
    deselectTarget: async () => ({ stateChanged: true }),
    confirmTarget: async () => ({ stateChanged: true }),
    commitTargets: async () => ({ stateChanged: true })
  }
}

function banAction(actionId: string, actorSide: 'first' | 'second', revision = 1): RemoteBpAction {
  return {
    actionId,
    actorSide,
    expectedRevision: revision,
    stepIndex: 1,
    createdAt: now,
    kind: 'BAN',
    targets: [{ kind: 'CHARACTER', id: '1' }]
  }
}

async function checkDispatcher(): Promise<void> {
  const step: FlowStep = { index: 1, side: 'star', action: 'ban', targetType: 'character' }
  const dispatcher = new BpActionDispatcher(1)
  const executor = successfulExecutor()

  const accepted = await dispatcher.dispatch(
    banAction('valid', 'first'),
    'local',
    snapshot(step),
    executor,
    DEFAULT_REMOTE_SIDE_MAPPING
  )
  assert.equal(accepted.accepted, true)
  assert.equal(accepted.resultingRevision, 2)

  const wrongSide = await dispatcher.dispatch(
    banAction('wrong-side', 'second', 2),
    'remote',
    snapshot(step),
    executor,
    DEFAULT_REMOTE_SIDE_MAPPING
  )
  assert.equal(wrongSide.code, 'NOT_YOUR_TURN')
  assert.equal(dispatcher.getRevision(), 2)

  const unavailableAction = banAction('unavailable', 'first', 2)
  assert.equal(unavailableAction.kind, 'BAN')
  if (unavailableAction.kind !== 'BAN') throw new Error('测试操作类型错误')
  unavailableAction.targets[0].id = '404'
  const unavailable = await dispatcher.dispatch(
    unavailableAction,
    'remote',
    snapshot(step),
    executor,
    DEFAULT_REMOTE_SIDE_MAPPING
  )
  assert.equal(unavailable.code, 'CHARACTER_UNAVAILABLE')

  const conflict = await dispatcher.dispatch(
    banAction('conflict', 'first', 99),
    'remote',
    snapshot(step),
    executor,
    DEFAULT_REMOTE_SIDE_MAPPING
  )
  assert.equal(conflict.code, 'REVISION_CONFLICT')

  const runFrom = async (source: 'local' | 'remote'): Promise<RemoteBpActionResult> => {
    const isolated = new BpActionDispatcher(1)
    return isolated.dispatch(
      banAction(`same-${source}`, 'first'),
      source,
      snapshot(step),
      successfulExecutor(),
      DEFAULT_REMOTE_SIDE_MAPPING
    )
  }
  const [localResult, remoteResult] = await Promise.all([runFrom('local'), runFrom('remote')])
  assert.deepEqual(
    {
      accepted: localResult.accepted,
      code: localResult.code,
      resultingRevision: localResult.resultingRevision,
      stateChanged: localResult.stateChanged
    },
    {
      accepted: remoteResult.accepted,
      code: remoteResult.code,
      resultingRevision: remoteResult.resultingRevision,
      stateChanged: remoteResult.stateChanged
    }
  )

  const protectStep: FlowStep = {
    index: 2,
    side: 'star',
    action: 'protect',
    targetType: 'character'
  }
  const pairedDispatcher = new BpActionDispatcher(1)
  const confirmedSides = new Set<'star' | 'rail'>()
  let pairedCommitted = false
  const pairedExecutor: BpActionExecutor = {
    ...successfulExecutor(),
    confirmTarget: async (_target, actorSide) => {
      confirmedSides.add(actorSide)
      pairedCommitted = confirmedSides.size === 2
      return { stateChanged: true }
    }
  }
  const pairedSnapshot: BpActionDispatchSnapshot = {
    ...snapshot(protectStep),
    pickedCharacterIds: ['1', '2'],
    pickedCharacterIdsBySide: { star: ['1'], rail: ['2'] },
    availablePairedTargetIdsBySide: { star: ['1'], rail: ['2'] },
    selectedTargetsBySide: {
      star: { kind: 'CHARACTER', id: '1' },
      rail: { kind: 'CHARACTER', id: '2' }
    }
  }
  const confirmAction = (
    actionId: string,
    actorSide: 'first' | 'second',
    expectedRevision: number
  ): RemoteBpAction => ({
    actionId,
    actorSide,
    expectedRevision,
    stepIndex: protectStep.index,
    createdAt: now,
    kind: 'CONFIRM',
    targets: []
  })
  const firstConfirmed = await pairedDispatcher.dispatch(
    confirmAction('protect-first-confirm', 'first', 1),
    'remote',
    pairedSnapshot,
    pairedExecutor,
    DEFAULT_REMOTE_SIDE_MAPPING
  )
  assert.equal(firstConfirmed.accepted, true)
  assert.equal(pairedCommitted, false)
  const secondConfirmed = await pairedDispatcher.dispatch(
    confirmAction('protect-second-confirm', 'second', 2),
    'remote',
    pairedSnapshot,
    pairedExecutor,
    DEFAULT_REMOTE_SIDE_MAPPING
  )
  assert.equal(secondConfirmed.accepted, true)
  assert.equal(pairedCommitted, true)
}

function checkSerializer(): void {
  const step: FlowStep = { index: 1, side: 'star', action: 'ban', targetType: 'character' }
  const runtime = runtimeFor([step])
  const input = {
    runtime,
    characters: [character(1), character(2)],
    lightCones: [lightCone(1)],
    revision: 7,
    roomId: 'MOCKTEST',
    mapping: DEFAULT_REMOTE_SIDE_MAPPING,
    flowStepCount: 1,
    updatedAt: now
  }
  const first = serializeRemoteBpState(input)
  const second = serializeRemoteBpState(input)
  assert.deepEqual(first, second)
  assert.equal(first.currentActor, 'first')
  assert.equal(first.sideMapping.first, 'star')
  const serialized = JSON.stringify(first)
  assert.equal(serialized.includes('upCharacterPvPath'), false)
  assert.equal(serialized.includes('eventHistory'), false)
  assert.equal(serialized.includes('actions'), false)
  assert.equal(serialized.includes('rarity'), false)
  assert.equal(serialized.includes('profession'), false)
  assert.equal(serialized.includes('icon'), false)
}

function checkRuntimeValidation(): void {
  const envelope = JSON.stringify({
    type: 'ACTION_REQUEST',
    protocolVersion: REMOTE_BP_PROTOCOL_VERSION,
    messageId: 'validation-message',
    sentAt: now,
    payload: { action: banAction('validated', 'first') }
  })
  const parsed = parseRemoteClientMessage(envelope)
  assert.equal(parsed.type, 'ACTION_REQUEST')
  assert.throws(() => parseRemoteClientMessage('{'), /INVALID_JSON/)
  assert.throws(
    () =>
      parseRemoteClientMessage(
        JSON.stringify({
          type: 'UNKNOWN',
          protocolVersion: REMOTE_BP_PROTOCOL_VERSION,
          messageId: 'unknown',
          sentAt: now,
          payload: {}
        })
      ),
    /UNKNOWN_MESSAGE_TYPE/
  )
  assert.throws(
    () => parseRemoteClientMessage('x'.repeat(MAX_REMOTE_BP_MESSAGE_BYTES + 1)),
    /MESSAGE_TOO_LARGE/
  )
}

async function checkAssetProvider(): Promise<void> {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'xqb-remote-assets-'))
  try {
    const avatarPath = join(fixtureRoot, 'avatar.png')
    const portraitPath = join(fixtureRoot, 'portrait.webp')
    const iconPath = join(fixtureRoot, 'icon.jpg')
    const lightConePath = join(fixtureRoot, 'light-cone.png')
    writeFileSync(avatarPath, Buffer.from('avatar'))
    writeFileSync(portraitPath, Buffer.from('portrait'))
    writeFileSync(iconPath, Buffer.from('icon'))
    writeFileSync(lightConePath, Buffer.from('light-cone'))
    const fixtureCharacter = character(1, {
      avatar_small_image: 'avatar',
      full_body_image: 'portrait',
      left_head_image: 'icon'
    })
    const paths: Record<string, string> = {
      avatar: avatarPath,
      portrait: portraitPath,
      icon: iconPath,
      lightCone: lightConePath
    }
    const provider = new RemoteAssetProvider({
      listCharacters: () => [fixtureCharacter],
      listLightCones: () => [lightCone(1, { small_image: 'lightCone' })],
      resolveStoredPath: (storedPath) => (storedPath ? (paths[storedPath] ?? null) : null),
      now: () => new Date(now)
    })
    const manifest = await provider.getManifest()
    assert.equal(manifest.assets.length, 3)
    const manifestJson = JSON.stringify(manifest)
    assert.equal(manifestJson.includes(fixtureRoot), false)
    assert.equal(manifestJson.includes('../'), false)
    assert.equal(manifestJson.includes('character:1:icon'), false)
    assert.equal(manifestJson.includes('light-cone:1:image'), true)

    const repeatedManifest = await provider.getManifest()
    assert.equal(repeatedManifest.revision, manifest.revision)

    const avatar = await provider.getAsset('character:1:avatar')
    assert.equal(avatar.descriptor.size, Buffer.byteLength('avatar'))
    assert.equal(
      avatar.descriptor.hash,
      createHash('sha256').update(Buffer.from('avatar')).digest('hex')
    )
    writeFileSync(avatarPath, Buffer.from('avatar-updated'))
    const updatedManifest = await provider.getManifest()
    assert.equal(updatedManifest.revision > manifest.revision, true)
    assert.equal(
      updatedManifest.assets.find((asset) => asset.assetId === 'character:1:avatar')?.hash,
      createHash('sha256').update(Buffer.from('avatar-updated')).digest('hex')
    )
    await assert.rejects(() => provider.getAsset('../../not-allowed'))
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
}

async function checkRemoteHost(): Promise<void> {
  const steps: FlowStep[] = [
    { index: 1, side: 'star', action: 'ban', targetType: 'character' },
    { index: 2, side: 'rail', action: 'pick', targetType: 'character' }
  ]
  let runtime = runtimeFor(steps)
  const roster = [character(1), character(2)]
  const dispatcher = new BpActionDispatcher(1)
  const transport = new MockRemoteHostTransport()
  const transferData = new TextEncoder().encode('remote-character-image')
  const transferDescriptor: AssetManifestEntry = {
    assetId: 'character:1:avatar',
    type: 'avatar',
    hash: createHash('sha256').update(transferData).digest('hex'),
    size: transferData.byteLength,
    mimeType: 'image/png',
    characterId: '1',
    ownerId: '1'
  }
  let assetManifestRevision = 1
  const executor: BpActionExecutor = {
    ...successfulExecutor(),
    commitTargets: async (kind, targets) => {
      const target = roster.find((item) => String(item.id) === targets[0].id)
      const step = runtime.currentStep
      if (!target || !step || kind !== 'BAN') return { stateChanged: false }
      const record: BpActionRecord = {
        stepIndex: step.index,
        side: step.side,
        action: 'ban',
        targetType: 'character',
        targetId: target.id,
        targetName: target.chinese_name,
        target
      }
      runtime = {
        ...runtime,
        stepCursor: 1,
        currentStep: steps[1],
        followingStep: null,
        actions: [record],
        starTeam: { ...runtime.starTeam, bans: [target] }
      }
      return { stateChanged: true }
    }
  }
  const host = new RemoteBpHost({
    dispatcher,
    transport,
    getDispatchSnapshot: () => snapshot(steps[0]),
    getExecutor: () => executor,
    getSerializerInput: () => ({
      runtime,
      characters: roster,
      lightCones: [],
      flowStepCount: steps.length
    }),
    getAssetManifest: async () => ({
      revision: assetManifestRevision,
      generatedAt: now,
      assets: [transferDescriptor]
    }),
    getAsset: async (assetId) => {
      assert.equal(assetId, transferDescriptor.assetId)
      return { descriptor: transferDescriptor, data: transferData }
    }
  })

  await host.startRoom({ roomId: 'MOCKHOST', mapping: DEFAULT_REMOTE_SIDE_MAPPING })
  const initialManifestBroadcasts = transport.broadcasts.filter(
    (message) => message.type === 'ASSET_MANIFEST'
  ).length
  await host.refreshAssetManifest()
  assert.equal(
    transport.broadcasts.filter((message) => message.type === 'ASSET_MANIFEST').length,
    initialManifestBroadcasts
  )
  assetManifestRevision += 1
  await host.refreshAssetManifest()
  assert.equal(
    transport.broadcasts.filter((message) => message.type === 'ASSET_MANIFEST').length,
    initialManifestBroadcasts + 1
  )
  const result = await host.handleRemoteAction(banAction('host-ban', 'first'), {
    peerId: 'peer-first',
    side: 'first'
  })
  assert.equal(result.accepted, true)
  assert.equal(result.resultingRevision, 2)
  const remoteState = host.getCurrentRemoteState()
  assert.equal(remoteState?.revision, 2)
  assert.equal(remoteState?.bans[0]?.characterId, '1')
  assert.equal(
    transport.broadcasts.some(
      (message) => message.type === 'STATE_UPDATE' && message.payload.state.revision === 2
    ),
    true
  )
  transport.simulateMessage({
    type: 'ASSET_REQUEST',
    peerId: 'peer-first',
    side: 'first',
    assetIds: [transferDescriptor.assetId]
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  const starts = transport.sent.filter((entry) => entry.message.type === 'ASSET_START')
  const chunks = transport.sent.filter((entry) => entry.message.type === 'ASSET_CHUNK')
  const completes = transport.sent.filter((entry) => entry.message.type === 'ASSET_COMPLETE')
  assert.equal(starts.length, 1)
  assert.equal(chunks.length, 1)
  assert.equal(completes.length, 1)
  const reconstructed = Buffer.concat(
    chunks.map((entry) => {
      if (entry.message.type !== 'ASSET_CHUNK') throw new Error('测试消息类型错误')
      return Buffer.from(entry.message.payload.data, 'base64')
    })
  )
  assert.deepEqual(reconstructed, Buffer.from(transferData))
  await host.stopRoom()
  host.destroy()
}

async function main(): Promise<void> {
  await checkDispatcher()
  checkSerializer()
  checkRuntimeValidation()
  await checkAssetProvider()
  await checkRemoteHost()
  console.log('Remote BP self-check passed: dispatcher, serializer, assets, host end-to-end')
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
