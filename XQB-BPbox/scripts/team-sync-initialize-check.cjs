/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type -- Integration checks. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { createHash } = require('node:crypto')
const output = path.resolve(__dirname, '../.tmp/team-sync-initialize.cjs')
require('esbuild').buildSync({
  stdin: {
    contents:
      "export * from './src/main/teamSync/service'; export * from './src/main/teamSync/github'; export * from './src/main/teamSync/model'",
    resolveDir: path.resolve(__dirname, '..')
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: output,
  logLevel: 'silent'
})
const { TeamSyncService, GitHubStore, GitHubError, indexPath, legacyIndexPath } = require(output)
const profile = {
  id: 'default',
  name: 'Default',
  collections: [
    {
      type: 'character',
      label: '角色',
      store: 'config/characters.json',
      idField: 'id',
      nameFields: ['name'],
      assetFields: { avatar: '头像', pv: '视频', voice: '音频' }
    }
  ]
}
const index = indexPath(profile.id)
const asset = 'assets/characters/small/a.png'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bpbox-initialize-'))
const write = (dir, p, data) => {
  fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true })
  fs.writeFileSync(path.join(dir, p), typeof data === 'string' ? data : JSON.stringify(data))
}
const local = (name) => {
  const dir = path.join(root, name)
  write(dir, 'config/characters.json', [
    {
      id: 1,
      sync_id: 'char-one',
      name: '角色',
      power: 1,
      avatar: asset,
      pv: 'assets/videos/a.mp4',
      voice: 'assets/audios/missing.wav'
    }
  ])
  write(dir, asset, 'original-image')
  write(dir, 'assets/videos/a.mp4', 'video')
  return dir
}
const localBytes = (dir) =>
  Object.fromEntries(
    fs
      .readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && !e.parentPath.includes('.team-sync'))
      .map((e) => {
        const p = path.join(e.parentPath, e.name)
        return [path.relative(dir, p), fs.readFileSync(p).toString('base64')]
      })
  )
class Remote {
  constructor(files = [], empty = false) {
    this.files = new Map(files)
    this.revision = 1
    this.writable = true
    this.empty = empty
    this.history = new Map([['c1', new Map(this.files)]])
    this.commits = []
  }
  async head() {
    if (this.failure) throw this.failure
    return {
      sha: this.empty ? '' : `c${this.revision}`,
      tree: 'tree',
      writable: this.writable,
      empty: this.empty
    }
  }
  async inventory() {
    return [...this.files.keys()]
  }
  async read(p, head) {
    return this.history.get(head)?.get(p) ?? null
  }
  async commit(head, files, message, options) {
    options?.signal?.throwIfAborted()
    if (this.race || head.sha !== (await this.head()).sha) throw new Error('non-fast-forward')
    if (this.commitFailure) throw this.commitFailure
    assert.equal(options.createOnly, this.expectCreateOnly ?? options.createOnly)
    if (options.createOnly)
      for (const [p, data] of files) {
        assert.notEqual(data, null)
        if (this.files.has(p)) assert.deepEqual(data, this.files.get(p), `overwriting ${p}`)
      }
    this.empty = false
    for (const [p, data] of files) data === null ? this.files.delete(p) : this.files.set(p, data)
    this.history.set(`c${++this.revision}`, new Map(this.files))
    this.commits.push(new Map(files))
    return `c${this.revision}`
  }
  change(p, data) {
    data === null ? this.files.delete(p) : this.files.set(p, data)
    this.history.set(`c${++this.revision}`, new Map(this.files))
  }
}
const service = (dir, remote, extra = {}) =>
  new TeamSyncService({
    root: dir,
    profile,
    repositoryKey: 'test/main',
    remote,
    busy: () => null,
    ...extra
  })
const init = (s, v, risk = false) =>
  s.initialize({ profileId: profile.id, token: v.token, acknowledgeConflictRisk: risk })
const sync = (s, v, direction) =>
  s.sync({ profileId: profile.id, token: v.token, direction, selections: [{ id: 'char-one' }] })
let passed = 0
const test = async (name, fn) => {
  await fn()
  passed++
  console.log(`PASS ${name}`)
}
async function main() {
  await test('Markdown-only and truly empty repositories require manual initialization; local bytes preserved; sync recovers', async () => {
    for (const empty of [false, true]) {
      const dir = local(`init-${empty}`),
        before = localBytes(dir)
      const r = new Remote(empty ? [] : [['README.md', Buffer.from('keep README')]], empty)
      const s = service(dir, r),
        v = await s.inspect()
      assert.equal(v.remoteState.status, empty ? 'empty' : 'uninitialized')
      assert.equal(v.remoteState.canInitialize, true)
      assert.equal(v.offline, true)
      assert.ok(v.rows.every((row) => row.download !== 'deleted'))
      await assert.rejects(sync(s, v, 'upload'), /未就绪/)
      await assert.rejects(sync(s, v, 'download'), /未就绪/)
      assert.equal(r.commits.length, 0)
      r.expectCreateOnly = true
      await init(s, v)
      assert.equal(r.commits.length, 1)
      assert.ok(r.files.has(index))
      assert.ok(!r.files.has(legacyIndexPath(profile.id)))
      assert.equal(r.files.get(asset).toString(), 'original-image')
      assert.ok(![...r.files.keys()].some((p) => /\.mp4$|missing\.wav$/.test(p)))
      if (!empty) assert.equal(r.files.get('README.md').toString(), 'keep README')
      assert.deepEqual(localBytes(dir), before)
      let ready = await s.inspect()
      assert.equal(ready.offline, false)
      assert.equal(ready.remoteState.status, 'ready')
      assert.equal(ready.rows.find((row) => row.id === 'char-one').upload, 'unchanged')
      await assert.rejects(init(s, ready), /缺失及仓库写入权限/)
      fs.unlinkSync(path.join(dir, asset))
      ready = await s.inspect()
      assert.equal(ready.rows[0].download, 'missing')
      await sync(s, ready, 'download')
      assert.equal(fs.readFileSync(path.join(dir, asset), 'utf8'), 'original-image')
      r.expectCreateOnly = undefined
      write(dir, asset, 'updated-image')
      await sync(s, await s.inspect(), 'upload')
      assert.equal(r.files.get(asset).toString(), 'updated-image')
    }
  })
  await test('deleted index retains cache, suppresses deletion plans, requires risk acknowledgment, and preserves unindexed files', async () => {
    const dir = local('deleted'),
      r = new Remote(),
      s = service(dir, r)
    await init(s, await s.inspect())
    r.change(index, null)
    r.change('assets/remote-only.png', Buffer.from('remote only'))
    const before = localBytes(dir),
      v = await s.inspect()
    assert.equal(v.remoteState.status, 'index_missing')
    assert.equal(v.remoteState.previouslySynced, true)
    assert.equal(v.remoteState.conflictRisk, true)
    assert.ok(v.rows[0].remote)
    assert.ok(v.rows.every((row) => row.upload === 'unchanged' && row.download === 'unchanged'))
    await assert.rejects(init(s, v), /风险/)
    await assert.rejects(sync(s, v, 'download'), /未就绪/)
    await init(s, v, true)
    assert.equal(r.files.get('assets/remote-only.png').toString(), 'remote only')
    assert.deepEqual(localBytes(dir), before)
    assert.equal((await s.inspect()).offline, false)
  })
  await test('conflicting assets AND generated stores stop initialization before publication', async () => {
    for (const [p, bytes] of [
      [asset, 'other image'],
      ['config/characters.json', '[]']
    ]) {
      const dir = local(`conflict-${p.includes('config')}`),
        before = localBytes(dir)
      const r = new Remote([[p, Buffer.from(bytes)]]),
        s = service(dir, r),
        v = await s.inspect()
      await assert.rejects(init(s, v, true), /拒绝覆盖/)
      assert.equal(r.commits.length, 0)
      assert.equal(r.files.get(p).toString(), bytes)
      assert.deepEqual(localBytes(dir), before)
    }
  })
  await test('read-only, revoked permissions, stale head, stale local data and failed commit cannot initialize', async () => {
    const dir = local('gates'),
      r = new Remote(),
      s = service(dir, r)
    r.writable = false
    let v = await s.inspect()
    assert.equal(v.remoteState.canInitialize, false)
    await assert.rejects(init(s, v), /写入权限/)
    r.writable = true
    v = await s.inspect()
    r.writable = false
    await assert.rejects(init(s, v), /写入权限/)
    r.writable = true
    v = await s.inspect()
    r.change('README.md', Buffer.from('changed'))
    await assert.rejects(init(s, v), /分支已变化/)
    v = await s.inspect()
    write(dir, asset, 'local changed')
    await assert.rejects(init(s, v), /本地版本已变化/)
    v = await s.inspect()
    r.commitFailure = new Error('protected branch')
    await assert.rejects(init(s, v), /protected branch/)
    assert.equal(r.commits.length, 0)
    assert.ok(!r.files.has(index))
    r.commitFailure = null
    await init(s, await s.inspect())
  })
  await test('malformed JSON/schema never initializes; legacy index stays readable and is updated in place', async () => {
    for (const data of ['{bad', JSON.stringify({ schema: 99, objects: {} })]) {
      const r = new Remote([[index, Buffer.from(data)]]),
        s = service(local(`corrupt-${data.length}`), r)
      const v = await s.inspect()
      assert.equal(v.remoteState.status, 'index_invalid')
      assert.equal(v.remoteState.canInitialize, false)
      await assert.rejects(init(s, v))
    }
    const dir = local('legacy'),
      r = new Remote(),
      s = service(dir, r)
    await init(s, await s.inspect())
    r.change(legacyIndexPath(profile.id), r.files.get(index))
    r.change(index, null)
    let v = await s.inspect()
    assert.equal(v.offline, false)
    assert.equal(v.remoteState.indexPath, legacyIndexPath(profile.id))
    write(dir, asset, 'legacy update')
    await sync(s, await s.inspect(), 'upload')
    assert.ok(!r.files.has(index))
    assert.ok(r.files.has(legacyIndexPath(profile.id)))
    r.change(index, r.files.get(legacyIndexPath(profile.id)))
    v = await s.inspect()
    assert.equal(v.remoteState.status, 'index_invalid')
  })
  await test('typed transport failures remain distinct and cannot grant initialization', async () => {
    for (const [code, kind] of [
      [0, 'network_error'],
      [401, 'permission_denied'],
      [403, 'permission_denied'],
      [404, 'repository_unavailable'],
      [429, 'rate_limited'],
      [503, 'remote_error']
    ]) {
      const r = new Remote()
      r.failure = new GitHubError(code, 'diagnostic', kind)
      const s = service(local(`error-${code}`), r),
        v = await s.inspect()
      assert.equal(v.remoteState.status, kind)
      assert.equal(v.remoteState.canInitialize, false)
      await assert.rejects(init(s, v))
      assert.equal(r.commits.length, 0)
    }
  })
  await test('empty local profile still creates a valid empty index only on explicit initialization', async () => {
    const dir = path.join(root, 'empty-local')
    fs.mkdirSync(dir)
    const r = new Remote(),
      s = service(dir, r),
      v = await s.inspect()
    assert.equal(v.rows.length, 0)
    await init(s, v)
    assert.deepEqual(JSON.parse(r.files.get(index)).objects, {})
    assert.equal((await s.inspect()).offline, false)
  })
  await test('preparation and initialization validation report real totals and current paths, heartbeat stays live, asset checks are not repeated', async () => {
    const dir = local('progress'),
      r = new Remote(),
      events = [],
      reads = []
    const s = service(dir, r, { progress: (event) => events.push(event) })
    const view = await s.inspect(),
      read = r.read.bind(r)
    r.read = async (p, head, limit, options) => {
      reads.push(p)
      if (
        p === 'config/characters.json' &&
        events.at(-1)?.stage === 'validating' &&
        events.at(-1)?.total
      ) {
        assert.equal(
          events.at(-1).currentFile,
          p,
          'validation must not display the last prepared JSON path'
        )
        options.onProgress({ activity: '读取远程配置，单次超时 60 秒' })
        await new Promise((resolve) => setTimeout(resolve, 2100))
        options.onProgress({ activity: '' })
      }
      return read(p, head, limit)
    }
    await init(s, view)
    assert.equal(
      reads.filter((p) => p === asset).length,
      1,
      'do not repeat asset reads in final validation'
    )
    for (const stage of ['checking', 'validating']) {
      const measured = events.filter((e) => e.stage === stage && e.total > 0)
      assert.ok(measured.some((e) => e.completed === 0))
      assert.ok(measured.some((e) => e.completed === e.total))
      assert.ok(measured.every((e) => e.completed <= e.total))
    }
    assert.ok(events.some((e) => e.waitingSeconds >= 1 && e.activity.includes('读取远程配置')))
    assert.equal(events.at(-1).stage, 'completed')
    const cancelRemote = new Remote()
    let cancelling
    cancelling = service(local('validation-cancel'), cancelRemote, {
      progress: (event) => {
        if (event.stage === 'validating' && event.total > 0 && event.currentFile)
          cancelling.cancel(event.operationId)
      }
    })
    await assert.rejects(init(cancelling, await cancelling.inspect()), /取消/)
    assert.equal(cancelRemote.commits.length, 0)
  })
  await transportChecks()
  console.log(`\n${passed} initialization checks passed. Fixtures: ${root}`)
}
async function transportChecks() {
  const sha = (data) =>
    createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex')
  const make = (respond) =>
    new GitHubStore(
      { owner: 'team', repo: 'private', branch: 'main' },
      () => 'test-credential',
      respond,
      () => {}
    )
  const failure = (status, message) => Response.json({ message }, { status })
  await test('GitHub empty repository requires explicit empty response; inaccessible refs remain blocked', async () => {
    const remote = make(async (url) => {
      if (url.endsWith('/private'))
        return Response.json({ private: true, permissions: { push: true } })
      if (url.includes('/git/ref/')) return failure(404, 'Not Found')
      if (url.includes('/commits?')) return failure(409, 'Git Repository is empty.')
      assert.fail(url)
    })
    assert.equal((await remote.head()).empty, true)
    const branch = make(async (url) => {
      if (url.endsWith('/private'))
        return Response.json({ private: true, permissions: { push: true } })
      if (url.includes('/git/ref/')) return failure(404, 'Not Found')
      if (url.includes('/commits?')) return Response.json([{ sha: 'other-head' }])
      assert.fail(url)
    })
    await assert.rejects(branch.head(), (e) => e.kind === 'branch_unavailable')
  })
  await test('GitHub create-only commit rejects overwrite/delete/path collisions before any mutations', async () => {
    for (const [p, data, entry] of [
      [
        'existing',
        Buffer.from('new'),
        { path: 'existing', type: 'blob', sha: sha(Buffer.from('old')) }
      ],
      ['existing', null, { path: 'existing', type: 'blob', sha: sha(Buffer.from('old')) }],
      ['parent/file', Buffer.from('new'), { path: 'parent', type: 'blob', sha: 'blob' }],
      ['directory', Buffer.from('new'), { path: 'directory', type: 'tree', sha: 'tree' }]
    ]) {
      const remote = make(async (url, options) => {
        assert.equal(options.method, 'GET')
        return Response.json({ tree: [entry], truncated: false })
      })
      await assert.rejects(
        remote.commit({ sha: 'head', tree: 'tree' }, new Map([[p, data]]), 'init', {
          createOnly: true
        }),
        /拒绝覆盖|禁止删除|路径冲突/
      )
    }
  })
  await test('GitHub empty bootstrap creates only a unique metadata note then commits full resources without force', async () => {
    const calls = []
    let created = false
    const remote = make(async (url, options) => {
      const body = options.body && JSON.parse(options.body)
      calls.push({ url, method: options.method, body })
      if (url.endsWith('/private'))
        return Response.json({ private: true, permissions: { push: true } })
      if (url.includes('/git/ref/')) return failure(404, 'Not Found')
      if (url.includes('/commits?')) return failure(409, 'Git Repository is empty.')
      if (options.method === 'PUT') {
        assert.match(url, /\/contents\/\.bpbox\/initializations\/[\w-]+\.md$/)
        assert.equal(body.sha, undefined)
        assert.equal(body.branch, 'main')
        created = true
        return Response.json({
          commit: { sha: 'bootstrap', tree: { sha: 'bootstrap-tree' }, parents: [] }
        })
      }
      assert.ok(created)
      if (url.includes('/git/trees/bootstrap-tree'))
        return Response.json({ tree: [], truncated: false })
      if (url.endsWith('/git/blobs'))
        return Response.json({ sha: sha(Buffer.from(body.content, 'base64')) })
      if (url.endsWith('/git/trees')) {
        assert.equal(body.base_tree, 'bootstrap-tree')
        return Response.json({ sha: 'new-tree' })
      }
      if (url.endsWith('/git/commits')) {
        assert.deepEqual(body.parents, ['bootstrap'])
        return Response.json({ sha: 'new-head' })
      }
      if (options.method === 'PATCH') {
        assert.equal(body.force, false)
        return Response.json({})
      }
      assert.fail(url)
    })
    const head = await remote.head()
    assert.equal(
      await remote.commit(
        head,
        new Map([
          [index, Buffer.from('{}')],
          [asset, Buffer.from('image')]
        ]),
        'init',
        { createOnly: true }
      ),
      'new-head'
    )
    assert.equal(calls.filter((c) => c.method === 'PUT').length, 1)
    assert.equal(calls.filter((c) => c.method === 'PATCH').length, 1)
  })
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
