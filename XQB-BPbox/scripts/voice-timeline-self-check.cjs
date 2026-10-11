/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type -- CommonJS self-check, matching the existing test scripts. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const { buildSync } = require('esbuild')

const root = path.resolve(__dirname, '..')
const outfile = path.join(root, '.tmp/voice-timeline-self-check.cjs')
buildSync({
  stdin: {
    contents: `export * from './src/shared/voiceTimeline'; export * from './src/shared/pvPlayback';`,
    resolveDir: root,
    loader: 'ts'
  },
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent'
})
const core = require(outfile)

// Execute the production pure functions, including both existing event resolvers and IPC
// normalizers, without creating an Electron window or touching the user's saved files.
function functionsFrom(file, names, globals = {}) {
  const source = fs.readFileSync(path.join(root, file), 'utf8')
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const declarations = ast.statements.filter(
    (node) =>
      ts.isFunctionDeclaration(node) ||
      (ts.isVariableStatement(node) &&
        node.declarationList.declarations.some((declaration) =>
          ['defaultFlow', 'emptyState', 'maxEventChainDepth'].includes(
            declaration.name.getText(ast)
          )
        ))
  )
  const panel = ast.statements.find(
    (node) =>
      ts.isFunctionDeclaration(node) &&
      ['VoiceTimelinePanel', 'DisplayPage'].includes(node.name?.text)
  )
  const callbacks = (panel?.body?.statements ?? []).filter(
    (node) =>
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some((declaration) =>
        names.includes(declaration.name.getText(ast))
      )
  )
  const code =
    [...declarations, ...callbacks].map((node) => node.getText(ast)).join('\n') +
    `\nmodule.exports = {${names.join(',')}}`
  const context = { module: { exports: {} }, ...core }
  Object.defineProperties(context, Object.getOwnPropertyDescriptors(globals))
  context.exports = context.module.exports
  vm.runInNewContext(
    ts.transpileModule(code, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.React
      }
    }).outputText,
    context
  )
  return context.module.exports
}
const editor = functionsFrom('src/renderer/src/pages/VoiceTimelinePanel.tsx', [
  'buildRuntimeFromActions',
  'buildReplayState',
  'pendingDelayedChanges'
])
const player = functionsFrom('src/renderer/src/pages/DisplayPage.tsx', [
  'buildTimelineReplayProgress',
  'buildReplayState',
  'normalizeTimelineClickPoints'
])
const storage = functionsFrom('src/main/ipc/voiceTimelines.ts', ['normalizeVoiceTimeline'], {
  normalizeStoredPath: (value) => value,
  storedPathToFileUrl: (value) => `file:///${value}`,
  storedPathExists: () => true
})
const results = functionsFrom('src/main/ipc/bp.ts', ['normalizeResult'])
const plain = (value) => JSON.parse(JSON.stringify(value))
let checks = 0
function check(name, fn) {
  fn()
  checks++
  console.log(`PASS ${name}`)
}
const actions = [
  {
    stepIndex: 1,
    side: 'star',
    action: 'ban',
    targetType: 'character',
    targetId: 1,
    targetName: 'A',
    target: { id: 1, chinese_name: 'A' },
    eventName: 'first-done'
  },
  {
    stepIndex: 2,
    side: 'rail',
    action: 'pick',
    targetType: 'character',
    targetId: 2,
    targetName: 'B',
    target: { id: 2, chinese_name: 'B' }
  },
  {
    stepIndex: 3,
    side: 'star',
    action: 'ban',
    targetType: 'lightCone',
    targetId: 3,
    targetName: 'C',
    target: { id: 3, name: 'C' }
  }
]
const flow = {
  name: 'test',
  steps: actions.map((action) => ({ ...action, index: action.stepIndex }))
}
const source = editor.buildRuntimeFromActions(flow, actions)
const selection = {
  side: 'star',
  action: 'ban',
  target: { id: 10, chinese_name: 'Preview A', avatar_small_image_url: 'avatar.png' }
}
const record = {
  id: 'preview-1',
  stepIndex: 1,
  selection,
  createdAt: '2026-10-11T00:00:00.000Z',
  duration: 2
}
const changes = [
  {
    id: 'start',
    triggerEvent: 'start',
    delayTriggerEnabled: true,
    delayClickCount: 2,
    emitEvent: 'ready'
  },
  { id: 'start-chain', triggerEvent: 'ready', delayTriggerEnabled: true, delayClickCount: 1 },
  { id: 'after', triggerEvent: 'first-done', delayTriggerEnabled: true, delayClickCount: 2 },
  { id: 'end', triggerEvent: 'end', delayTriggerEnabled: true, delayClickCount: 1 }
]
const types = [
  'preview',
  'delay_extra_click',
  'preview',
  'delay_extra_click',
  'delay_extra_click',
  'preview',
  'bp_step',
  'preview',
  'delay_extra_click',
  'delay_extra_click',
  'bp_step',
  'bp_step',
  'delay_extra_click'
]
const points = types.map((type, sequence) => ({
  id: `point-${sequence}`,
  type,
  time: sequence,
  sequence,
  ...(type === 'preview' ? { previewRecord: record, previewDuration: 2 } : {})
}))
function progress(points, time, pageChanges = changes) {
  return core.replayTimeline(points, time, actions.length, (p) =>
    editor.pendingDelayedChanges(
      editor.buildReplayState(source, p.cursor),
      pageChanges,
      p.completedDelayedChangeKeys,
      p.delayClickProgress
    )
  )
}
const summarize = (p) => ({
  cursor: p.cursor,
  completed: [...p.completedDelayedChangeKeys],
  clicks: plain(p.delayClickProgress),
  index: p.clickIndex
})

check('Live selection replacement, duplicate suppression, deselection and commit duration', () => {
  let records = core.recordPreviewSelection([], flow.steps[0], selection, 'a', 0)
  records = core.recordPreviewSelection(records, flow.steps[0], selection, 'ignored', 500)
  assert.equal(records.length, 1)
  const changed = { ...selection, target: { ...selection.target, id: 11 } }
  records = core.recordPreviewSelection(records, flow.steps[0], changed, 'b', 1000)
  assert.equal(records[0].duration, 1)
  records = core.recordPreviewSelection(records, flow.steps[0], null, 'ignored', 3000)
  assert.equal(records[1].duration, 2)
  assert.equal(records.length, 2)
  assert.deepEqual(core.closePreviewRecords(records), records)
})
check('Old results load without previews; new records survive result normalization', () => {
  const old = results.normalizeResult({ actions }, 'old')
  assert.equal(old.previewRecords.length, 0)
  const result = results.normalizeResult({ ...old, previewRecords: [record] }, 'new')
  assert.deepEqual(plain(result.actions), actions)
  assert.deepEqual(plain(result.previewRecords), [record])
  assert.equal(core.normalizePreviewRecords([null, {}, record]).length, 1)
})
check('Editor and linked player agree after seeks, chained delays and end delays', () => {
  for (const time of [0, 1, 2, 4, 6, 7, 8, 12, 5, 11, 2, 30]) {
    assert.deepEqual(
      summarize(progress(points, time)),
      summarize(player.buildTimelineReplayProgress(source, changes, points, time))
    )
  }
  assert.equal(progress(points, 5).cursor, 0)
  assert.equal(progress(points, 6).cursor, 1)
  assert.equal(progress(points, 8).cursor, 1)
  assert.equal(progress(points, Infinity).cursor, 3)
  assert.equal(progress(points, Infinity).completedDelayedChangeKeys.size, 4)
})
check('Previews neither consume delays nor advance main BP', () => {
  const mainOnly = points.filter((p) => p.type !== 'preview')
  for (let time = 0; time < 14; time++) {
    const withPreview = summarize(progress(points, time))
    const withoutPreview = summarize(progress(mainOnly, time))
    delete withPreview.index
    delete withoutPreview.index
    assert.deepEqual(withPreview, withoutPreview)
  }
})
check('Stable simultaneous click order and unique IDs survive save/load', () => {
  const simultaneous = points.map((p) => ({ ...p, time: 0 }))
  const saved = storage.normalizeVoiceTimeline({ clickPoints: simultaneous }, 'test')
  const loaded = storage.normalizeVoiceTimeline(plain(saved), 'test')
  assert.deepEqual(
    plain(loaded.clickPoints).map((p) => p.id),
    points.map((p) => p.id)
  )
  assert.deepEqual(
    summarize(progress(loaded.clickPoints, 0)),
    summarize(progress(points, Infinity))
  )
  assert.equal(
    player.normalizeTimelineClickPoints(loaded.clickPoints).filter((p) => p.type === 'preview')
      .length,
    4
  )
  assert.deepEqual(plain(loaded.clickPoints[0].previewRecord), record)
})
check('Legacy points receive stable sequence metadata and natural numeric ID order', () => {
  const legacy = ['click-11', 'click-2', 'click-10'].map((id) => ({ id, time: 3, type: 'bp_step' }))
  const loaded = storage.normalizeVoiceTimeline({ clickPoints: legacy }, 'old')
  assert.deepEqual(
    plain(loaded.clickPoints).map((p) => p.id),
    ['click-2', 'click-10', 'click-11']
  )
  assert.deepEqual(
    plain(loaded.clickPoints).map((p) => p.sequence),
    [0, 1, 2]
  )
})
check('Undo removes only the last main operation and preserves all preview events', () => {
  const original = plain(points)
  assert.equal(core.removeTimelinePoint(points, 'point-6'), points)
  const undone = core.removeTimelinePoint(points, 'point-12')
  assert.equal(undone.length, points.length - 1)
  assert.equal(core.mainTimelinePoints(undone).at(-1).id, 'point-11')
  assert.equal(undone.filter((p) => p.type === 'preview').length, 4)
  assert.deepEqual(points, original)
  const noPreview = core.removeTimelinePoint(points, 'point-0')
  assert.equal(core.mainTimelinePoints(noPreview).at(-1).id, 'point-12')
  let remaining = points
  while (core.mainTimelinePoints(remaining).length) {
    remaining = core.removeTimelinePoint(remaining, core.mainTimelinePoints(remaining).at(-1).id)
  }
  assert.equal(remaining.length, 4)
  assert.equal(progress(remaining, Infinity).cursor, 0)
})
check('Main time edits cannot reorder steps; previews move independently', () => {
  const moved = core.moveTimelinePoint(points, 'point-6', 99)
  assert.equal(moved.find((p) => p.id === 'point-6').time, 8)
  assert.deepEqual(
    core.mainTimelinePoints(moved).map((p) => p.id),
    core.mainTimelinePoints(points).map((p) => p.id)
  )
  const previewMoved = core.moveTimelinePoint(points, 'point-0', 99)
  assert.equal(previewMoved.find((p) => p.id === 'point-0').time, 99)
  assert.deepEqual(core.mainTimelinePoints(previewMoved), core.mainTimelinePoints(points))
})
check(
  'Previews persist regardless of legacy duration, ignore extra clicks and end on confirmation',
  () => {
    const preview = {
      id: 'p',
      type: 'preview',
      sequence: 0,
      time: 1,
      previewRecord: record,
      previewDuration: 2
    }
    assert.equal(core.timelinePreviewAt([preview], 0, actions[0]), null)
    assert.equal(core.timelinePreviewAt([preview], 1.5, actions[0]), selection)
    assert.equal(core.timelinePreviewAt([preview], 3, actions[0]), selection)
    assert.equal(core.timelinePreviewAt([preview], 10000, actions[0]), selection)
    assert.equal(core.timelinePreviewAt([preview], 1.5, actions[1]), null)
    assert.equal(core.timelinePreviewAt([preview], 1.5, undefined), null)
    const main = { id: 'm', type: 'bp_step', sequence: 1, time: 2 }
    assert.equal(core.timelinePreviewAt([preview, main], 2, actions[0]), null)
    assert.equal(
      core.timelinePreviewAt([preview, { ...main, type: 'delay_extra_click' }], 2, actions[0]),
      selection
    )
    assert.equal(core.timelinePreviewAt([preview, { ...main, time: 1 }], 1, actions[0]), null)
    assert.equal(core.timelinePreviewAt([preview, main], 1.5, actions[0]), selection)
    assert.deepEqual(plain(source.actions), actions)
  }
)

const recordB = {
  ...record,
  id: 'preview-b',
  selection: { ...selection, target: { ...selection.target, id: 11, chinese_name: 'Preview B' } }
}
const rawRecords = [
  record,
  recordB,
  { ...record, id: 'preview-a-again' },
  { ...recordB, id: 'preview-b-again' }
]
check('Candidates deduplicate by resource ID within one step without modifying raw records', () => {
  const otherStep = { ...record, id: 'other-step', stepIndex: 2 }
  const sameName = {
    ...record,
    id: 'same-name',
    selection: { ...selection, target: { ...selection.target, id: 12 } }
  }
  const renamed = {
    ...record,
    id: 'renamed',
    selection: { ...selection, target: { ...selection.target, chinese_name: 'Renamed A' } }
  }
  const lightCone = {
    ...record,
    id: 'light-cone',
    selection: {
      ...selection,
      target: { id: selection.target.id, name: 'Light cone with same ID' }
    }
  }
  const records = [...rawRecords, otherStep, sameName, renamed, lightCone]
  const original = plain(records)
  assert.deepEqual(
    core.previewCandidatesForStep(records, 1).map((r) => r.id),
    [record.id, recordB.id, sameName.id, lightCone.id]
  )
  assert.deepEqual(core.previewCandidatesForStep(records, 2), [otherStep])
  assert.deepEqual(records, original)
  assert.equal(core.previewCandidatesForStep(records, 3).length, 0)
})

let repeatedTimeline = { clickPoints: [] }
check('Actual candidate buttons repeatedly insert A → B → A → B with independent IDs', () => {
  let insertionTime = 5
  const callbacks = functionsFrom(
    'src/renderer/src/pages/VoiceTimelinePanel.tsx',
    ['addPoint', 'insertPreview', 'renderPreviewCards'],
    {
      React: require('react'),
      crypto: require('node:crypto').webcrypto,
      previewRecords: rawRecords,
      stepTemplates: [{ stepIndex: 1, stepName: 'aB1' }],
      get currentTime() {
        return insertionTime
      },
      get timeline() {
        return repeatedTimeline
      },
      setTimeline: (update) => {
        repeatedTimeline = update(repeatedTimeline)
      },
      setSelectedPointId: () => {}
    }
  )
  const candidateButtons = () =>
    callbacks
      .renderPreviewCards(1)
      .props.children.map((card) => card.props.children.find((child) => child?.type === 'button'))
  assert.equal(candidateButtons().length, 2)
  for (const [index, time] of [
    [0, 5],
    [1, 8],
    [0, 12],
    [1, 14]
  ]) {
    insertionTime = time
    const button = candidateButtons()[index]
    assert.notEqual(button.props.disabled, true)
    button.props.onClick()
    assert.equal(candidateButtons().length, 2)
  }
  const events = repeatedTimeline.clickPoints
  assert.equal(events.length, 4)
  assert.equal(new Set(events.map((p) => p.id)).size, 4)
  assert.deepEqual(
    plain(events).map((p) => p.targetId),
    [10, 11, 10, 11]
  )
  assert.deepEqual(
    plain(events).map((p) => p.time),
    [5, 8, 12, 14]
  )
  assert.ok(events.every((p) => p.previewDuration === undefined))
  assert.equal(progress(events, Infinity, []).cursor, 0)
  assert.equal(core.mainTimelinePoints(events).length, 0)
  assert.equal(rawRecords.length, 4)
  callbacks.addPoint({ type: 'bp_step', stepIndex: 1, time: 16 })
})

function selectionAt(events, time, pageChanges = []) {
  const editorProgress = progress(events, time, pageChanges)
  const playerProgress = player.buildTimelineReplayProgress(source, pageChanges, events, time)
  assert.deepEqual(summarize(editorProgress), summarize(playerProgress))
  return (
    core.timelinePreviewAt(events, time, source.actions[editorProgress.cursor])?.target.id ?? null
  )
}
check(
  'A → B → A → B reconstructs exact intervals during playback, pause, arbitrary seeks and rates',
  () => {
    const events = repeatedTimeline.clickPoints
    const cases = [
      [4.9, null],
      [5, 10],
      [7.9, 10],
      [8, 11],
      [11.9, 11],
      [12, 10],
      [13.9, 10],
      [14, 11],
      [15.9, 11],
      [16, null],
      [20, null]
    ]
    for (const [time, expected] of [...cases, ...cases.toReversed(), ...cases]) {
      assert.equal(selectionAt(events, time), expected)
      assert.equal(selectionAt(events, time), expected, 'paused state must be stable')
    }
    for (const rate of [0.5, 1, 1.5, 2]) {
      for (let wallTime = 0; wallTime <= 40; wallTime += 0.25) {
        const time = wallTime * rate
        const expected =
          time < 5 || time >= 16 ? null : time < 8 ? 10 : time < 12 ? 11 : time < 14 ? 10 : 11
        assert.equal(selectionAt(events, time), expected)
      }
    }
  }
)
check(
  'Deleting or moving any repeated instance recomputes intervals without changing the main stream',
  () => {
    const events = repeatedTimeline.clickPoints
    const original = plain(events)
    const previews = events.filter((p) => p.type === 'preview')
    const withoutFirstB = core.removeTimelinePoint(events, previews[1].id)
    assert.equal(selectionAt(withoutFirstB, 10), 10)
    assert.equal(selectionAt(withoutFirstB, 15), 11, 'the second B is independent')
    const withoutLastB = core.removeTimelinePoint(events, previews[3].id)
    assert.equal(selectionAt(withoutLastB, 15), 10)
    assert.equal(selectionAt(withoutLastB, 16), null)
    const withoutFirstA = core.removeTimelinePoint(events, previews[0].id)
    assert.equal(selectionAt(withoutFirstA, 6), null)
    assert.equal(selectionAt(withoutFirstA, 13), 10)
    const movedB = core.moveTimelinePoint(events, previews[1].id, 13)
    assert.equal(selectionAt(movedB, 10), 10)
    assert.equal(selectionAt(movedB, 12), 10)
    assert.equal(selectionAt(movedB, 13), 11)
    const movedAfterCommit = core.moveTimelinePoint(events, previews[2].id, 17)
    assert.equal(
      selectionAt(movedAfterCommit, 17),
      null,
      'old step must not leak into the next step'
    )
    const movedBeforeFirst = core.moveTimelinePoint(events, previews[2].id, 3)
    assert.equal(selectionAt(movedBeforeFirst, 4), 10)
    const allRemoved = events.filter((p) => p.type !== 'preview')
    assert.equal(selectionAt(allRemoved, 10), null)
    for (const edited of [
      withoutFirstB,
      withoutLastB,
      withoutFirstA,
      movedB,
      movedAfterCommit,
      movedBeforeFirst
    ]) {
      assert.deepEqual(core.mainTimelinePoints(edited), core.mainTimelinePoints(events))
    }
    assert.deepEqual(plain(events), original)
  }
)
check(
  'Extra clicks preserve the current selection and preview edits preserve the undo target',
  () => {
    const events = repeatedTimeline.clickPoints
    const extra = {
      id: 'extra-between-previews',
      type: 'delay_extra_click',
      time: 10,
      sequence: 10
    }
    const withExtra = core.sortClickPoints([...events, extra])
    assert.equal(selectionAt(withExtra, 11), 11)
    const lastMain = core.mainTimelinePoints(withExtra).at(-1)
    assert.equal(lastMain.type, 'bp_step')
    const undone = core.removeTimelinePoint(withExtra, lastMain.id)
    assert.equal(selectionAt(undone, 20), 11)
    assert.equal(core.mainTimelinePoints(undone).at(-1).id, extra.id)
    assert.equal(undone.filter((p) => p.type === 'preview').length, 4)
  }
)
check(
  'Repeated previews survive save/load; legacy durations are preserved but never limit playback',
  () => {
    const events = repeatedTimeline.clickPoints
    const legacy = events.map((p) => (p.type === 'preview' ? { ...p, previewDuration: 0.1 } : p))
    const loaded = storage.normalizeVoiceTimeline(
      plain({ clickPoints: legacy }),
      'old-preview-axis'
    )
    assert.equal(loaded.clickPoints.filter((p) => p.type === 'preview').length, 4)
    assert.equal(loaded.clickPoints[0].previewDuration, 0.1)
    for (const time of [6, 10, 13, 15, 16, 5, 12, 8]) {
      assert.equal(selectionAt(loaded.clickPoints, time), selectionAt(events, time))
    }
    const fresh = storage.normalizeVoiceTimeline(plain({ clickPoints: events }), 'new-preview-axis')
    assert.ok(fresh.clickPoints.every((p) => p.previewDuration === undefined))
    const sameTime = events.map((p) => (p.type === 'preview' ? { ...p, time: 5 } : p))
    assert.equal(selectionAt(sameTime, 5), 11, 'last insertion wins at the same timestamp')
    const committedAtSameTime = events.map((p) => ({ ...p, time: 5 }))
    assert.equal(selectionAt(committedAtSameTime, 5), null)
  }
)
check('Linked audio callback restores previews and main cursor after backward time updates', () => {
  let renderedCursor = 0
  let renderedSelection = null
  const callbacks = functionsFrom(
    'src/renderer/src/pages/DisplayPage.tsx',
    ['processVoiceTimelineAudioTime'],
    {
      useCallback: (callback) => callback,
      voiceTimelineClickPointsRef: { current: repeatedTimeline.clickPoints },
      voiceTimelineClickIndexRef: { current: 0 },
      timelineTimeRef: { current: 0 },
      timelineCursorRef: { current: 0 },
      sourceStateRef: { current: source },
      timelinePageChangesRef: { current: [] },
      completedDelayedChangeKeysRef: { current: new Set() },
      delayClickProgressRef: { current: {} },
      setCompletedDelayedChangeKeys: () => {},
      setDelayClickProgress: () => {},
      setReplayCursor: (cursor) => {
        renderedCursor = cursor
      },
      setTimelinePreview: (selection) => {
        renderedSelection = selection
      }
    }
  )
  for (const time of [16, 10, 14, 5, 4, 8, 12, 12, 20, 0, 15]) {
    callbacks.processVoiceTimelineAudioTime(time)
    assert.equal(
      renderedSelection?.target.id ?? null,
      selectionAt(repeatedTimeline.clickPoints, time)
    )
    assert.equal(renderedCursor, time >= 16 ? 1 : 0)
  }
})
check('Complete history stays available when UI shows only two main cards', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    id: `long-${i}`,
    time: i,
    type: 'bp_step',
    sequence: i
  }))
  const restored = storage.normalizeVoiceTimeline(plain({ clickPoints: many }), 'long')
  assert.equal(restored.clickPoints.length, 40)
  assert.equal(core.mainTimelinePoints(restored.clickPoints).slice(-2).length, 2)
  let remaining = restored.clickPoints
  for (let i = 39; i >= 0; i--) remaining = core.removeTimelinePoint(remaining, `long-${i}`)
  assert.equal(remaining.length, 0)
})
console.log(`Voice timeline self-check passed (${checks} scenarios).`)
