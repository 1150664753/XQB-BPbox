/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { buildSync } = require('esbuild')
const output = path.resolve(__dirname, '../.tmp/team-sync-paths-test')
fs.mkdirSync(output, { recursive: true })
for (const name of ['service', 'localProfile', 'model'])
  buildSync({
    entryPoints: [path.resolve(__dirname, `../src/main/teamSync/${name}.ts`)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(output, `${name}.cjs`),
    logLevel: 'silent'
  })
const { TeamSyncService } = require(path.join(output, 'service.cjs'))
const { defaultProfile, profilesAt, LocalProfile } = require(path.join(output, 'localProfile.cjs'))
const {
  digest,
  indexPath,
  fileDescriptor,
  resourceHash,
  pathDescriptor,
  validateFile,
  assetPath
} = require(path.join(output, 'model.cjs'))
const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'bpbox-paths-check-'))
const write = (root, p, value) => {
  const file = path.join(root, p)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)
  )
}
const json = (root, p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'))
const characters = 'config/app/characters.json'
const tablePath = 'config/app/character-resource-table.json'
const avatar = 'assets/characters/small/ban_00001.png'
const body = 'assets/characters/big/pick_00001.png'
const row = (id, image = avatar) => ({
  id,
  code: String(id).padStart(5, '0'),
  chinese_name: `角色${id}`,
  english_name: `role${id}`,
  rarity: 5,
  element: '火',
  path: '毁灭',
  created_at: `2026-01-${String(id).padStart(2, '0')}`,
  avatar_small_image: image,
  full_body_image: null,
  pv: 'assets/videos/PV/PV_00001.mp4'
})
class Remote {
  constructor() {
    this.revision = 0
    this.files = new Map([
      [
        indexPath('default'),
        Buffer.from(JSON.stringify({ schema: 2, profileId: 'default', objects: {} }))
      ]
    ])
    this.history = new Map([['c0', this.files]])
    this.commits = []
    this.reads = []
    this.offline = false
    this.corrupt = ''
  }
  async head() {
    if (this.offline) throw new Error('offline')
    return { sha: `c${this.revision}`, tree: 'tree' }
  }
  async read(p, head, limit) {
    this.reads.push(p)
    const bytes = this.history.get(head)?.get(p)
    if (!bytes) return null
    assert.ok(bytes.length <= limit)
    return p === this.corrupt ? Buffer.from('corruption') : Buffer.from(bytes)
  }
  async commit(head, changes) {
    assert.equal(head.sha, `c${this.revision}`)
    this.files = new Map(this.files)
    for (const [p, b] of changes) {
      if (b === null) this.files.delete(p)
      else this.files.set(p, Buffer.from(b))
    }
    this.history.set(`c${++this.revision}`, this.files)
    this.commits.push(new Map(changes))
    return `c${this.revision}`
  }
  manifest() {
    return JSON.parse(this.files.get(indexPath('default')).toString())
  }
  async seed(files) {
    await this.commit(await this.head(), files)
  }
}
let count = 0
const test = async (name, fn) => {
  await fn()
  count++
  console.log(`PASS ${name}`)
}
const root = (name) => {
  const r = path.join(fixtures, name)
  write(r, characters, [])
  write(r, 'config/app/light-cones.json', [])
  return r
}
const service = (root, remote, extra = {}) =>
  new TeamSyncService({
    root,
    profile: defaultProfile,
    repositoryKey: 'KKosame/XQB-Resources/main',
    remote,
    busy: () => null,
    ...extra
  })
const sync = async (s, direction, pick) => {
  const view = await s.inspect()
  const selections = typeof pick === 'function' ? pick(view) : pick
  const result = await s.sync({ profileId: 'default', token: view.token, direction, selections })
  if (result.pending) throw new Error(result.message)
  return result
}
const select = (v, name, extra = {}) => ({ id: v.rows.find((r) => r.name === name).id, ...extra })
async function main() {
  await test('upload queue skips equal remote bytes; progress terminates and locks release after cancellation or failure', async () => {
    const a = root('upload-lifecycle/a'),
      r = new Remote(),
      events = []
    let mode = 'scan-cancel',
      A
    A = service(a, r, {
      progress: (p) => {
        events.push(p)
        if (mode === 'scan-cancel' && p.currentFile) A.cancel(p.operationId)
      }
    })
    write(a, characters, [row(1)])
    write(a, avatar, 'already-on-remote')
    await r.seed(new Map([[avatar, Buffer.from('already-on-remote')]]))
    const commit = r.commit.bind(r)
    r.commit = async (head, files, _message, options) => {
      assert.ok(!files.has(avatar), 'equal remote bytes must never enter the blob queue')
      options.onProgress({
        stage: 'uploading',
        total: files.size,
        completed: 0,
        skipped: 0,
        failed: 0,
        currentFile: files.keys().next().value
      })
      assert.equal(A.cancel('stale-operation'), false)
      if (mode === 'upload-cancel') {
        assert.equal(A.cancel(options.operationId), true)
        options.signal.throwIfAborted()
      }
      if (mode === 'failure') {
        options.onProgress({ failed: 1 })
        throw new Error('injected upload failure')
      }
      options.onProgress({ completed: files.size, stage: 'committing', cancellable: false })
      assert.equal(A.cancel(options.operationId), false, 'ref finalization cannot be abandoned')
      return commit(head, files)
    }
    for (mode of ['scan-cancel', 'upload-cancel', 'failure']) {
      events.length = 0
      await assert.rejects(
        sync(A, 'upload', (v) => [select(v, '角色1')]),
        mode === 'failure' ? /injected/ : /取消/
      )
      assert.equal(events.at(-1).stage, mode === 'failure' ? 'failed' : 'cancelled')
      assert.equal(events.at(-1).cancellable, false)
      assert.equal((await A.inspect()).rows.find((row) => row.name === '角色1').upload, 'added')
      assert.equal(r.revision, 1, 'failure/cancellation cannot advance the branch or baseline')
    }
    mode = 'success'
    events.length = 0
    await sync(A, 'upload', (v) => [select(v, '角色1')])
    assert.equal(events.at(-1).stage, 'completed')
    assert.equal(events.at(-1).completed, events.at(-1).total)
    assert.equal(events.at(-1).skipped, 1)
    assert.ok(events.some((e) => e.stage === 'committing'))
    assert.equal((await A.inspect()).rows.find((row) => row.name === '角色1').upload, 'unchanged')
  })
  await test('results JSON publishes selectively, restores at the same head, preserves paths and supports conflicts and deletion', async () => {
    const a = root('results/a'),
      b = root('results/b'),
      r = new Remote(),
      A = service(a, r),
      B = service(b, r)
    const resultPath = 'results/bp/决赛 第一局.json'
    const otherPath = 'results/archive/保留结果.json'
    const result = {
      name: '决赛 第一局',
      flowName: '流程',
      createdAt: '2026-10-17T00:00:00Z',
      flowConfig: { name: '流程', steps: [] },
      starTeam: {
        name: '先手',
        picks: [
          { id: 1, avatar_small_image: avatar, avatar_small_image_url: 'xqb-asset://local/private' }
        ],
        bans: []
      },
      railTeam: { name: '后手', picks: [], bans: [] },
      actions: [{ targetImage: avatar }],
      upCharacterPvPath: 'assets/videos/PV/example.mp4',
      privateToken: 'must-stay-local'
    }
    write(a, avatar, 'result-avatar')
    write(a, resultPath, result)
    write(a, otherPath, { name: 'unselected', actions: [] })
    write(a, 'results/export.mp4', 'not-a-json-result')
    let view = await A.inspect()
    const row = view.rows.find((x) => x.name === resultPath)
    assert.ok(row, 'results files must be scanned')
    assert.equal(row.type, 'result')
    assert.equal(row.typeLabel, '结果文件')
    await sync(A, 'upload', (v) => [select(v, resultPath)])
    assert.ok(r.files.has(resultPath))
    assert.ok(!r.files.has(otherPath))
    assert.ok(!r.files.has('results/export.mp4'))
    const published = JSON.parse(r.files.get(resultPath))
    assert.equal(published.privateToken, undefined)
    assert.equal(published.starTeam.picks[0].avatar_small_image_url, undefined)
    assert.equal(published.starTeam.picks[0].avatar_small_image, avatar)
    assert.deepEqual(published.actions, result.actions)
    const unselectedConfig = fs.readFileSync(path.join(b, characters))
    write(b, otherPath, { name: 'local-only', actions: [] })
    const otherBefore = fs.readFileSync(path.join(b, otherPath))
    await sync(B, 'download', (v) => [select(v, resultPath)])
    assert.deepEqual(json(b, resultPath), published)
    assert.equal(fs.readFileSync(path.join(b, avatar), 'utf8'), 'result-avatar')
    assert.deepEqual(fs.readFileSync(path.join(b, characters)), unselectedConfig)
    assert.deepEqual(fs.readFileSync(path.join(b, otherPath)), otherBefore)
    const head = (await r.head()).sha
    fs.unlinkSync(path.join(b, resultPath))
    view = await B.inspect()
    assert.equal(view.rows.find((x) => x.name === resultPath).download, 'missing')
    await sync(B, 'download', (v) => [select(v, resultPath)])
    assert.deepEqual(json(b, resultPath), published)
    assert.equal((await r.head()).sha, head)
    write(a, resultPath, { ...result, name: '远程修改' })
    await sync(A, 'upload', (v) => [select(v, resultPath)])
    write(b, resultPath, { ...published, name: '本地修改' })
    await assert.rejects(
      sync(B, 'download', (v) => [select(v, resultPath)]),
      /冲突/
    )
    await sync(B, 'download', (v) => [select(v, resultPath, { resolution: 'copy' })])
    const copy = fs.readdirSync(path.join(b, 'results/bp')).find((p) => p.includes('.local-'))
    assert.equal(json(b, `results/bp/${copy}`).name, '本地修改')
    assert.equal(json(b, resultPath).name, '远程修改')
    fs.unlinkSync(path.join(a, resultPath))
    await sync(A, 'upload', (v) => [select(v, resultPath)])
    assert.ok(!r.files.has(resultPath))
    await sync(B, 'download', (v) => [select(v, resultPath)])
    assert.ok(!fs.existsSync(path.join(b, resultPath)))
    assert.ok(fs.existsSync(path.join(b, avatar)))
    assert.deepEqual(fs.readFileSync(path.join(b, otherPath)), otherBefore)
  })
  await test('results batches beyond one page restore unchanged commits and preserve portable voice-timeline references', async () => {
    const a = root('results-batch/a'),
      b = root('results-batch/b'),
      r = new Remote(),
      A = service(a, r),
      B = service(b, r)
    const paths = Array.from({ length: 35 }, (_, i) => `results/bp/team-第 ${i + 1} 局.json`)
    for (const p of paths) write(a, p, { name: p, actions: [], previewRecords: [] })
    const links = [
      paths[0].slice('results/bp/'.length),
      path.join(a, paths[1]),
      require('node:url').pathToFileURL(path.join(a, paths[2])).href
    ]
    const timelinePaths = links.map((bpResultFile, i) => {
      const p = `config/audio/时间线${i}.json`
      write(a, p, { name: `时间线${i}`, bpResultFile, segments: [] })
      return p
    })
    await sync(A, 'upload', (v) => v.rows.map((row) => ({ id: row.id })))
    for (let i = 0; i < timelinePaths.length; i++)
      assert.equal(JSON.parse(r.files.get(timelinePaths[i])).bpResultFile, paths[i])
    await sync(B, 'download', (v) => v.rows.map((row) => ({ id: row.id })))
    const originals = new Map(paths.map((p) => [p, fs.readFileSync(path.join(b, p))]))
    const timelines = new Map(timelinePaths.map((p) => [p, fs.readFileSync(path.join(b, p))]))
    for (const p of paths) fs.unlinkSync(path.join(b, p))
    const restarted = service(b, r),
      view = await restarted.inspect(),
      head = (await r.head()).sha
    const missing = view.rows.filter((row) => row.download === 'missing')
    assert.equal(missing.length, 35)
    assert.ok(missing.every((row) => row.type === 'result' && row.upload === 'deleted'))
    await sync(restarted, 'download', (v) =>
      v.rows.filter((row) => row.download === 'missing').map((row) => ({ id: row.id }))
    )
    for (const [p, bytes] of [...originals, ...timelines])
      assert.deepEqual(fs.readFileSync(path.join(b, p)), bytes, p)
    assert.equal((await r.head()).sha, head)
    assert.ok((await restarted.inspect()).rows.every((row) => row.download === 'unchanged'))
  })
  await test('uploaded character/light-cone files can be restored at the same remote head, individually and in batches without rewriting configuration', async () => {
    const a = root('restore/a'),
      r = new Remote(),
      A = service(a, r)
    const characterFiles = {
      left_head_image: 'assets/characters/left/左头像 00001.png',
      right_head_image: 'assets/characters/right/right_00001.png',
      avatar_small_image: avatar,
      full_body_image: body,
      ban_voice: 'assets/audios/ban/ban_00001.wav',
      pick_voice: 'assets/audios/pick/pick_00001.mp3',
      pick_sound: 'assets/audios/pick_sound/sound_00001.ogg'
    }
    const coneFiles = {
      small_image: 'assets/lightcones/small/光锥 00001.png',
      large_image: 'assets/lightcones/big/cone_00001.webp'
    }
    const bytes = new Map(
      Object.values({ ...characterFiles, ...coneFiles }).map((p) => [
        p,
        Buffer.from(`content:${p}`)
      ])
    )
    for (const [p, b] of bytes) write(a, p, b)
    write(a, characters, [{ ...row(1), ...characterFiles }, row(2)])
    write(a, 'config/app/light-cones.json', [{ id: 1, name: '恢复光锥', ...coneFiles }])
    await sync(A, 'upload', (v) => v.rows.map((x) => ({ id: x.id })))
    const head = (await r.head()).sha
    // Unselected display configuration also references the missing shared file.
    write(a, 'config/display/本机.json', { backgroundImage: avatar, localOnly: true })
    write(a, tablePath, {
      version: 1,
      rows: [{ code: '00001', ...characterFiles, custom: 'keep' }]
    })
    const configPaths = [
      characters,
      'config/app/light-cones.json',
      tablePath,
      'config/display/本机.json'
    ]
    const before = new Map(configPaths.map((p) => [p, fs.readFileSync(path.join(a, p))]))
    for (const p of bytes.keys()) fs.unlinkSync(path.join(a, p))
    fs.rmdirSync(path.dirname(path.join(a, characterFiles.left_head_image)))
    let v = await A.inspect()
    assert.equal(v.head, head)
    for (const x of v.rows.filter((x) => x.type !== 'configuration')) {
      assert.equal(x.download, 'missing', x.name)
      for (const f of x.fields.filter((f) => f.remotePath)) {
        assert.equal(f.download, 'missing', f.field)
        assert.equal(f.upload, 'deleted', f.field)
      }
    }
    await sync(A, 'download', (v) => [select(v, '角色1', { fields: ['avatar_small_image'] })])
    assert.deepEqual(fs.readFileSync(path.join(a, avatar)), bytes.get(avatar))
    assert.ok(!fs.existsSync(path.join(a, body)))
    // Default field selection must restore only differences, leaving local attributes untouched.
    await sync(A, 'download', (v) =>
      v.rows
        .filter((x) => x.type !== 'configuration' && x.download !== 'unchanged')
        .map((x) => ({ id: x.id }))
    )
    for (const [p, b] of bytes) assert.deepEqual(fs.readFileSync(path.join(a, p)), b, p)
    for (const [p, b] of before) assert.deepEqual(fs.readFileSync(path.join(a, p)), b, p)
    assert.equal((await r.head()).sha, head, 'recovery must not publish any changes')
    v = await A.inspect()
    assert.ok(
      v.rows
        .filter((x) => x.type !== 'configuration')
        .every((x) => x.download === 'unchanged' && x.upload === 'unchanged')
    )
    assert.equal(
      r.reads.filter((p) => p === body).length,
      2,
      'one upload collision check and one recovery download'
    )
  })
  await test('missing recovery preserves local properties and unselected changed files, with conflicts and stale-review protection', async () => {
    const a = root('restore-conflict/a'),
      r = new Remote(),
      A = service(a, r)
    write(a, avatar, 'remote-avatar')
    write(a, body, 'remote-body')
    write(a, characters, [{ ...row(1), full_body_image: body }])
    await sync(A, 'upload', (v) => [select(v, '角色1')])
    write(a, body, 'local-edited-body')
    write(a, characters, [
      { ...json(a, characters)[0], rarity: 4, privateNote: 'preserve local metadata' }
    ])
    fs.unlinkSync(path.join(a, avatar))
    let v = await A.inspect(),
      x = v.rows.find((x) => x.name === '角色1')
    assert.equal(x.download, 'conflict')
    assert.equal(x.fields.find((f) => f.field === 'avatar_small_image').download, 'missing')
    assert.equal(x.fields.find((f) => f.field === 'full_body_image').download, 'conflict')
    await assert.rejects(
      A.sync({
        profileId: 'default',
        token: v.token,
        direction: 'download',
        selections: [{ id: x.id }]
      }),
      /冲突/
    )
    const before = fs.readFileSync(path.join(a, characters))
    await sync(A, 'download', (v) => [select(v, '角色1', { fields: ['avatar_small_image'] })])
    assert.deepEqual(fs.readFileSync(path.join(a, characters)), before)
    assert.equal(fs.readFileSync(path.join(a, body), 'utf8'), 'local-edited-body')
    fs.unlinkSync(path.join(a, avatar))
    v = await A.inspect()
    x = v.rows.find((x) => x.name === '角色1')
    write(a, avatar, 'created-after-review')
    await assert.rejects(
      A.sync({
        profileId: 'default',
        token: v.token,
        direction: 'download',
        selections: [{ id: x.id, fields: ['avatar_small_image'] }]
      }),
      /已变化/
    )
    assert.equal(fs.readFileSync(path.join(a, avatar), 'utf8'), 'created-after-review')
  })
  await test('recovery after restart preserves local edits, handles missing metadata and still allows explicit publication of deletions', async () => {
    const a = root('restore-restart/a'),
      r = new Remote()
    let A = service(a, r)
    write(a, avatar, 'avatar')
    write(a, body, 'body')
    write(a, characters, [{ ...row(1), full_body_image: body }])
    await sync(A, 'upload', (v) => [select(v, '角色1')])
    write(a, characters, [{ ...json(a, characters)[0], rarity: 4 }])
    fs.unlinkSync(path.join(a, avatar))
    A = service(a, r)
    const before = fs.readFileSync(path.join(a, characters))
    await sync(A, 'download', (v) => [select(v, '角色1')])
    assert.deepEqual(fs.readFileSync(path.join(a, characters)), before)
    assert.equal((await A.inspect()).rows.find((x) => x.name === '角色1').upload, 'modified')
    // Removing object metadata is independently recoverable, even if the files still exist.
    write(a, characters, [])
    let v = await A.inspect()
    assert.equal(v.rows[0].upload, 'deleted')
    assert.equal(v.rows[0].download, 'missing')
    await sync(A, 'download', (v) => [select(v, '角色1')])
    assert.equal(json(a, characters)[0].avatar_small_image, avatar)
    assert.equal(json(a, characters)[0].full_body_image, body)
    fs.unlinkSync(path.join(a, body))
    await sync(A, 'upload', (v) => [select(v, '角色1', { fields: ['full_body_image'] })])
    assert.equal(Object.values(r.manifest().objects)[0].files.full_body_image, undefined)
    assert.equal(
      (await A.inspect()).rows[0].fields.find((f) => f.field === 'full_body_image').download,
      'unchanged'
    )
  })
  await test('configuration asset recovery keeps private/local JSON bytes, and deferred recovery never overwrites a newly created file', async () => {
    const a = root('restore-config/a'),
      r = new Remote()
    let busy = false
    const A = service(a, r, { busy: () => (busy ? 'BP running' : null) })
    const cfg = 'config/display/recovery.json'
    write(a, avatar, 'remote-image')
    write(a, cfg, { backgroundImage: avatar, title: 'shared', privateToken: 'private' })
    await sync(A, 'upload', (v) => v.rows.map((x) => ({ id: x.id })))
    write(a, cfg, { backgroundImage: avatar, title: 'shared', privateToken: 'local-private' })
    const before = fs.readFileSync(path.join(a, cfg))
    fs.unlinkSync(path.join(a, avatar))
    await sync(A, 'download', (v) => v.rows.map((x) => ({ id: x.id })))
    assert.deepEqual(fs.readFileSync(path.join(a, cfg)), before)
    fs.unlinkSync(path.join(a, avatar))
    busy = true
    const v = await A.inspect()
    const result = await A.sync({
      profileId: 'default',
      token: v.token,
      direction: 'download',
      selections: v.rows.map((x) => ({ id: x.id }))
    })
    assert.equal(result.pending, true)
    write(a, avatar, 'new-local-image')
    busy = false
    await assert.rejects(A.applyPending(), /已修改/)
    assert.equal(fs.readFileSync(path.join(a, avatar), 'utf8'), 'new-local-image')
    await A.discardPending()
    assert.equal((await A.inspect()).rows[0].download, 'conflict')
  })
  await test('A → GitHub → B preserves original assets/config paths, names, IDs and selected fields; videos excluded', async () => {
    const a = root('roundtrip/a'),
      b = root('roundtrip/b'),
      r = new Remote(),
      A = service(a, r),
      B = service(b, r)
    write(a, avatar, 'image-1')
    write(a, body, 'body-unselected')
    write(a, 'assets/videos/PV/PV_00001.mp4', 'video-never-upload')
    write(a, characters, [
      { ...row(1), full_body_image: body, ban_voice: 'assets/audios/ban/missing.wav' },
      row(2, 'assets/characters/small/ban_00002.png')
    ])
    await sync(A, 'upload', (v) => [
      select(v, '角色1', { fields: ['$properties', 'avatar_small_image'] })
    ])
    assert.ok(r.files.has(avatar))
    assert.ok(r.files.has(characters))
    assert.ok(r.files.has(tablePath))
    assert.ok(!r.files.has(body))
    assert.ok(![...r.files.keys()].some((p) => p.includes('/videos/') || p.includes('/blobs/')))
    assert.equal(JSON.parse(r.files.get(characters)).length, 1)
    assert.equal(
      r.manifest().objects[Object.keys(r.manifest().objects)[0]].files.avatar_small_image
        .relativePath,
      avatar
    )
    await sync(B, 'download', (v) => [select(v, '角色1')])
    assert.equal(json(b, characters)[0].avatar_small_image, avatar)
    assert.equal(json(b, tablePath).rows[0].avatar_small_image, avatar)
    assert.equal(fs.readFileSync(path.join(b, avatar), 'utf8'), 'image-1')
    assert.ok(!fs.existsSync(path.join(b, 'assets/team-sync')))
    const status = (await A.inspect()).rows.find((x) => x.name === '角色1')
    assert.equal(status.fields.find((f) => f.field === 'full_body_image').upload, 'added')
    assert.equal(status.fields.find((f) => f.field === 'ban_voice').state, 'missing')
    assert.equal(status.fields.find((f) => f.field === 'pv').state, 'excluded')
  })
  await test('relative legacy fallback and absolute paths inside P retain the same classified repository path', async () => {
    const a = root('fallback/a'),
      legacy = root('fallback/userData'),
      r = new Remote()
    write(legacy, avatar, 'fallback-image')
    write(a, body, 'inside-image')
    write(a, characters, [{ ...row(1), full_body_image: path.join(a, body) }])
    const A = service(a, r, {
      resolveAsset: (p) => (fs.existsSync(path.join(a, p)) ? path.join(a, p) : path.join(legacy, p))
    })
    await sync(A, 'upload', (v) => [select(v, '角色1')])
    assert.equal(r.files.get(avatar).toString(), 'fallback-image')
    assert.equal(r.files.get(body).toString(), 'inside-image')
    assert.ok(!r.files.get(indexPath('default')).toString().includes(fixtures))
    assert.ok(!fs.existsSync(path.join(a, avatar)))
  })
  await test('external files require explicit safe import; original remains unchanged and destination cannot be overwritten', async () => {
    const a = root('external/a'),
      external = path.join(fixtures, 'external/original.png'),
      r = new Remote()
    fs.writeFileSync(external, 'external-image')
    write(a, characters, [row(1, external)])
    const A = service(a, r)
    let v = await A.inspect()
    const id = v.rows[0].id
    assert.equal(v.rows[0].fields.find((f) => f.field === 'avatar_small_image').state, 'external')
    await assert.rejects(
      A.sync({
        profileId: 'default',
        token: v.token,
        direction: 'upload',
        selections: [{ id, fields: ['avatar_small_image'] }]
      }),
      /外部|缺失/
    )
    await A.importResource(v.token, id, 'avatar_small_image', avatar)
    assert.equal(json(a, characters)[0].avatar_small_image, avatar)
    assert.equal(fs.readFileSync(external, 'utf8'), 'external-image')
    await sync(A, 'upload', (v) => [select(v, '角色1')])
    assert.ok(r.files.has(avatar))
  })
  await test('same-path updates require review and preserve unselected fields and references', async () => {
    const a = root('replace/a'),
      b = root('replace/b'),
      r = new Remote(),
      A = service(a, r),
      B = service(b, r)
    write(a, avatar, 'old')
    write(a, characters, [row(1)])
    await sync(A, 'upload', (v) => [select(v, '角色1')])
    await sync(B, 'download', (v) => [select(v, '角色1')])
    write(a, avatar, 'new')
    await sync(A, 'upload', (v) => [select(v, '角色1', { fields: ['avatar_small_image'] })])
    let v = await B.inspect(),
      id = v.rows[0].id
    assert.equal(v.rows[0].download, 'conflict')
    await assert.rejects(
      B.sync({
        profileId: 'default',
        token: v.token,
        direction: 'download',
        selections: [{ id, fields: ['avatar_small_image'] }]
      }),
      /冲突/
    )
    write(b, 'config/display/shared.json', { backgroundImage: avatar })
    await assert.rejects(
      sync(B, 'download', (v) => [
        select(v, '角色1', { fields: ['avatar_small_image'], resolution: 'remote' })
      ]),
      /共享文件/
    )
    fs.unlinkSync(path.join(b, 'config/display/shared.json'))
    await sync(B, 'download', (v) => [
      select(v, '角色1', { fields: ['avatar_small_image'], resolution: 'copy' })
    ])
    const rows = json(b, characters),
      copy = rows.find((v) => v.chinese_name.includes('副本'))
    assert.equal(fs.readFileSync(path.join(b, copy.avatar_small_image), 'utf8'), 'old')
    assert.equal(fs.readFileSync(path.join(b, avatar), 'utf8'), 'new')
    assert.equal(path.dirname(copy.avatar_small_image), path.dirname(avatar))
  })
  await test('shared remote path cannot update one owner only; consistent batch succeeds', async () => {
    const a = root('shared/a'),
      r = new Remote(),
      A = service(a, r)
    write(a, avatar, 'old')
    write(a, characters, [row(1), row(2)])
    await sync(A, 'upload', (v) => v.rows.map((x) => ({ id: x.id })))
    write(a, avatar, 'changed')
    await assert.rejects(
      sync(A, 'upload', (v) => [select(v, '角色1')]),
      /共享路径冲突/
    )
    await sync(A, 'upload', (v) =>
      v.rows.map((x) => ({ id: x.id, fields: ['avatar_small_image'] }))
    )
    assert.equal(r.files.get(avatar).toString(), 'changed')
  })
  await test('configuration directories, filenames, asset dependencies and private setting filtering round-trip', async () => {
    const a = root('config/a'),
      b = root('config/b'),
      r = new Remote(),
      A = service(a, r),
      B = service(b, r)
    write(a, 'assets/backgrounds/比赛 场地.png', 'background')
    write(a, 'assets/audios/pick/配音.wav', 'audio')
    write(a, 'config/bp/比赛.json', { name: '比赛', steps: [] })
    write(a, 'config/display/展示.json', {
      backgroundImage: 'assets/backgrounds/比赛 场地.png',
      backgroundImageUrl: 'xqb-asset://local/private',
      pendingVideo: 'assets/videos/effect.mp4'
    })
    write(a, 'config/audio/配音.json', {
      name: '配音',
      audioPath: 'assets/audios/pick/配音.wav',
      audioUrl: 'file:///private/path',
      audioExists: true,
      clickPoints: []
    })
    write(a, 'config/settings.json', {
      theme: 'dark',
      githubToken: 'never-upload-this',
      password: 'never-upload-password'
    })
    write(a, 'config/app/profiles.json', {
      currentProfileId: 'star-rail',
      profiles: [
        { id: 'star-rail', displayName: '星铁', directory: { directoryName: 'Star Rail' } }
      ]
    })
    await sync(A, 'upload', (v) => v.rows.map((x) => ({ id: x.id })))
    for (const p of [
      'config/bp/比赛.json',
      'config/display/展示.json',
      'config/audio/配音.json',
      'config/settings.json',
      'config/app/profiles.json'
    ])
      assert.ok(r.files.has(p), p)
    const all = [...r.files.values()].map((b) => b.toString()).join('\n')
    for (const forbidden of [
      'never-upload',
      'xqb-asset:',
      'file:///',
      'audioExists',
      'currentProfileId'
    ])
      assert.ok(!all.includes(forbidden), forbidden)
    assert.ok(!r.files.has('assets/videos/effect.mp4'))
    write(b, 'config/settings.json', { theme: 'light', githubToken: 'keep-my-token' })
    await sync(B, 'download', (v) =>
      v.rows
        .filter((x) => x.type === 'configuration')
        .map((x) => ({ id: x.id, resolution: 'remote' }))
    )
    assert.equal(json(b, 'config/settings.json').githubToken, 'keep-my-token')
    assert.equal(json(b, 'config/settings.json').theme, 'dark')
    assert.equal(json(b, 'config/audio/配音.json').audioPath, 'assets/audios/pick/配音.wav')
    assert.equal(
      fs.readFileSync(path.join(b, 'assets/backgrounds/比赛 场地.png'), 'utf8'),
      'background'
    )
  })
  await test('configuration selection preserves unselected media references and conflict copies keep old media', async () => {
    const a = root('config-partial/a'),
      b = root('config-partial/b'),
      r = new Remote(),
      A = service(a, r),
      B = service(b, r),
      cfg = 'config/display/选择.json',
      oldPath = 'assets/backgrounds/old.png',
      newPath = 'assets/backgrounds/new.png'
    write(a, oldPath, 'old-image')
    write(a, newPath, 'new-image')
    write(a, cfg, { backgroundImage: oldPath, title: 'first' })
    await sync(A, 'upload', (v) => v.rows.map((x) => ({ id: x.id })))
    await sync(B, 'download', (v) => v.rows.map((x) => ({ id: x.id })))
    write(a, cfg, { backgroundImage: newPath, title: 'second' })
    await sync(A, 'upload', (v) => v.rows.map((x) => ({ id: x.id, fields: ['document'] })))
    assert.equal(JSON.parse(r.files.get(cfg)).backgroundImage, oldPath)
    assert.ok(!r.files.has(newPath), 'unselected media must stay unpublished')
    await sync(A, 'upload', (v) =>
      v.rows.map((x) => ({
        id: x.id,
        fields: x.fields.filter((f) => f.field.startsWith('asset_')).map((f) => f.field)
      }))
    )
    assert.equal(JSON.parse(r.files.get(cfg)).backgroundImage, newPath)
    await sync(B, 'download', (v) => v.rows.map((x) => ({ id: x.id, resolution: 'remote' })))
    write(a, newPath, 'remote-update')
    write(b, newPath, 'local-update')
    await sync(A, 'upload', (v) => v.rows.map((x) => ({ id: x.id })))
    await sync(B, 'download', (v) => v.rows.map((x) => ({ id: x.id, resolution: 'copy' })))
    const backup = fs.readdirSync(path.join(b, 'config/display')).find((p) => p.includes('.local-'))
    const copied = json(b, `config/display/${backup}`)
    assert.equal(fs.readFileSync(path.join(b, copied.backgroundImage), 'utf8'), 'local-update')
    assert.equal(
      fs.readFileSync(path.join(b, json(b, cfg).backgroundImage), 'utf8'),
      'remote-update'
    )
    write(a, cfg, { backgroundImage: newPath, logoImage: oldPath, title: 'third' })
    await assert.rejects(
      sync(A, 'upload', (v) =>
        v.rows.map((x) => ({
          id: x.id,
          fields: x.fields.filter((f) => f.field.startsWith('asset_')).map((f) => f.field)
        }))
      ),
      /一并选择配置文件/
    )
  })
  await test('case-insensitive collisions are rejected and oversized files do not block usable fields', async () => {
    const a = root('case-size/a'),
      r = new Remote(),
      A = service(a, r)
    write(a, avatar, 'image')
    write(a, characters, [row(1), row(2, avatar.replace('ban_', 'BAN_'))])
    await assert.rejects(
      sync(A, 'upload', (v) => v.rows.map((x) => ({ id: x.id }))),
      /共享路径冲突/
    )
    const large = path.join(a, 'assets/characters/big/large.png')
    fs.mkdirSync(path.dirname(large), { recursive: true })
    const handle = fs.openSync(large, 'w')
    fs.ftruncateSync(handle, 96 * 1024 * 1024)
    fs.closeSync(handle)
    write(a, characters, [{ ...row(1), full_body_image: 'assets/characters/big/large.png' }])
    const view = await A.inspect()
    assert.equal(view.rows[0].fields.find((f) => f.field === 'full_body_image').state, 'tooLarge')
    await sync(A, 'upload', (v) => v.rows.map((x) => ({ id: x.id })))
    assert.ok(r.files.has(avatar))
    assert.ok(!r.files.has('assets/characters/big/large.png'))
  })
  await test('configuration external audio import updates its pointer without exposing the source path', async () => {
    const a = root('config-import/a'),
      r = new Remote(),
      A = service(a, r),
      external = path.join(fixtures, 'config-import/audio.wav')
    fs.writeFileSync(external, 'voice')
    write(a, 'config/audio/轴.json', { name: '轴', audioPath: external, privateToken: 'local' })
    const v = await A.inspect(),
      object = v.rows.find((x) => x.type === 'configuration'),
      field = object.fields.find((f) => f.state === 'external').field
    await A.importResource(v.token, object.id, field, 'assets/audios/pick/导入.wav')
    assert.equal(json(a, 'config/audio/轴.json').audioPath, 'assets/audios/pick/导入.wav')
    assert.equal(json(a, 'config/audio/轴.json').privateToken, 'local')
    await sync(A, 'upload', (v) => v.rows.map((x) => ({ id: x.id })))
    assert.ok(!r.files.get('config/audio/轴.json').toString().includes(fixtures))
  })
  await test('legacy blobs download with confirmed original names; republish preserves blobs and old baseline', async () => {
    const b = root('legacy/b'),
      r = new Remote(),
      B = service(b, r),
      bytes = Buffer.from('legacy-image'),
      id = 'legacy-character'
    const file = fileDescriptor('default', digest(bytes), bytes.length, '.png')
    const object = {
      id,
      type: 'character',
      name: '历史角色',
      version: 4,
      hash: '',
      properties: { chinese_name: '历史角色', code: '00001' },
      files: { avatar_small_image: file },
      dependencies: []
    }
    object.hash = resourceHash(object)
    await r.seed(
      new Map([
        [file.path, bytes],
        [
          indexPath('default'),
          Buffer.from(
            JSON.stringify({ schema: 1, profileId: 'default', objects: { [id]: object } })
          )
        ]
      ])
    )
    const statePath = `.team-sync/${digest('KKosame/XQB-Resources/main')}/default.json`,
      old = JSON.stringify({ base: { [id]: object.hash } })
    write(b, statePath, old)
    await assert.rejects(
      sync(B, 'download', (v) => [select(v, '历史角色', { resolution: 'remote' })]),
      /原文件名|目标路径/
    )
    await sync(B, 'download', (v) => [
      select(v, '历史角色', { resolution: 'remote', paths: { avatar_small_image: avatar } })
    ])
    assert.equal(json(b, characters)[0].avatar_small_image, avatar)
    await sync(B, 'upload', (v) => [select(v, '历史角色', { fields: ['avatar_small_image'] })])
    assert.ok(r.files.has(avatar))
    assert.ok(r.files.has(file.path))
    assert.equal(fs.readFileSync(path.join(b, statePath), 'utf8'), old)
  })
  await test('profile mapping preserves default namespace and isolates future profile asset paths', async () => {
    const a = root('profiles/a')
    write(a, 'config/app/profiles.json', {
      currentProfileId: 'star-rail',
      profiles: [{ id: 'star-rail', displayName: '星铁' }]
    })
    const p = profilesAt(a)[0]
    assert.equal(p.id, 'default')
    assert.equal(p.localProfileId, 'star-rail')
    const f = pathDescriptor('other-game', avatar, digest('x'), 1)
    assert.equal(f.path, `bpbox/profiles/other-game/${avatar}`)
    assert.equal(f.relativePath, avatar)
    const result = pathDescriptor('other-game', 'results/bp/原始结果.json', digest('x'), 1)
    assert.equal(result.path, 'bpbox/profiles/other-game/results/bp/原始结果.json')
    assert.equal(result.relativePath, 'results/bp/原始结果.json')
  })
  await test('binary assets and configuration roll back together after a disk failure; retry is safe', async () => {
    const a = root('rollback/a'),
      b = root('rollback/b'),
      r = new Remote(),
      A = service(a, r),
      B = service(b, r)
    write(a, avatar, 'old')
    write(a, characters, [row(1)])
    await sync(A, 'upload', (v) => [select(v, '角色1')])
    await sync(B, 'download', (v) => [select(v, '角色1')])
    write(a, avatar, 'new')
    await sync(A, 'upload', (v) => [select(v, '角色1')])
    const before = fs.readFileSync(path.join(b, characters), 'utf8'),
      original = fs.renameSync
    let failed = false
    fs.renameSync = (from, to) => {
      if (!failed && to === path.join(b, characters)) {
        failed = true
        throw new Error('injected write failure')
      }
      return original(from, to)
    }
    try {
      await assert.rejects(
        sync(B, 'download', (v) => [select(v, '角色1', { resolution: 'remote' })]),
        /injected/
      )
    } finally {
      fs.renameSync = original
    }
    assert.equal(fs.readFileSync(path.join(b, avatar), 'utf8'), 'old')
    assert.equal(fs.readFileSync(path.join(b, characters), 'utf8'), before)
    await B.applyPending()
    assert.equal(fs.readFileSync(path.join(b, avatar), 'utf8'), 'new')
  })
  await test('traversal, Windows aliases, credential extensions and case-colliding descriptors are rejected', async () => {
    for (const p of [
      'assets/../token.png',
      'assets/a/CON.png',
      'assets/a/a.png:token',
      'assets/a/../b.png',
      'assets/a/secret.bin',
      'assets/team-sync/x.png',
      'assets/videos/a.mp4',
      'assets/a./b.png',
      'assets/a%2fb.png'
    ])
      assert.throws(() => assetPath(p))
    for (const p of [
      'results/../config/settings.json',
      'results/.private/secret.json',
      'results/bp/CON.json',
      'results/bp/a.json:token',
      'results/bp/a%2fb.json',
      'results/bp/export.mp4',
      'config/team-sync.json'
    ])
      assert.throws(() => pathDescriptor('default', p, digest('x'), 1))
    assert.throws(() =>
      validateFile(
        { ...pathDescriptor('default', avatar, digest('x'), 1), path: '../../secret.bin' },
        'default'
      )
    )
    const a = root('escape/a'),
      outside = path.join(fixtures, 'escape/outside')
    fs.mkdirSync(outside, { recursive: true })
    fs.symlinkSync(outside, path.join(a, 'assets'), 'junction')
    write(a, characters, [row(1)])
    const snapshot = await new LocalProfile(a, defaultProfile).scan()
    assert.equal(Object.values(snapshot.objects)[0].fields.avatar_small_image.state, 'invalid')
  })
  await test('configuration deletion is explicit and leaves media files intact', async () => {
    const a = root('delete-config/a'),
      b = root('delete-config/b'),
      r = new Remote(),
      A = service(a, r),
      B = service(b, r)
    write(a, 'config/bp/删除测试.json', { name: '删除测试', steps: [] })
    await sync(A, 'upload', (v) => v.rows.map((x) => ({ id: x.id })))
    await sync(B, 'download', (v) => v.rows.map((x) => ({ id: x.id })))
    fs.unlinkSync(path.join(a, 'config/bp/删除测试.json'))
    await sync(A, 'upload', (v) => v.rows.map((x) => ({ id: x.id })))
    assert.ok(!r.files.has('config/bp/删除测试.json'))
    await sync(B, 'download', (v) => v.rows.map((x) => ({ id: x.id })))
    assert.ok(!fs.existsSync(path.join(b, 'config/bp/删除测试.json')))
  })
  console.log(`\n${count} original-path/config integration checks passed. Fixtures: ${fixtures}`)
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
