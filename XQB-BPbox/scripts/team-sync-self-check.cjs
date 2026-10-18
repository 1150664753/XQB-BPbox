/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type -- Node/Electron CommonJS test runner. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { buildSync } = require('esbuild')

const output = path.resolve(__dirname, '../.tmp/team-sync-test')
fs.mkdirSync(output, { recursive: true })
for (const entry of ['service', 'localProfile', 'model', 'github']) {
  buildSync({
    entryPoints: [path.resolve(__dirname, `../src/main/teamSync/${entry}.ts`)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(output, `${entry}.cjs`),
    logLevel: 'silent'
  })
}
const { TeamSyncService } = require(path.join(output, 'service.cjs'))
const { recoverTransaction, transaction, profilesAt } = require(
  path.join(output, 'localProfile.cjs')
)
const { validateManifest, indexPath } = require(path.join(output, 'model.cjs'))
const { GitHubStore } = require(path.join(output, 'github.cjs'))
const profile = {
  id: 'test',
  name: '通用 Profile',
  collections: [
    {
      type: 'character',
      label: '角色',
      store: 'config/characters.json',
      idField: 'id',
      nameFields: ['name'],
      assetFields: { avatar: '头像', portrait: '立绘' },
      thumbnailField: 'avatar',
      dependenciesField: 'dependencies'
    },
    {
      type: 'weapon',
      label: '武器',
      store: 'config/weapons.json',
      idField: 'id',
      nameFields: ['name'],
      assetFields: { icon: '图标' },
      dependenciesField: 'dependencies'
    }
  ]
}
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bpbox-team-sync-'))
const write = (root, relative, value) => {
  const file = path.join(root, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)
  )
}
const rows = (root, type = 'characters') =>
  JSON.parse(fs.readFileSync(path.join(root, `config/${type}.json`), 'utf8'))
const edit = (root, fn, type = 'characters') => {
  const data = rows(root, type)
  fn(data)
  write(root, `config/${type}.json`, data)
}
const row = (id, name, avatar) => ({
  id,
  name,
  avatar,
  power: 10,
  created_at: `2026-01-0${id}`,
  dependencies: []
})

class FakeRemote {
  constructor() {
    this.version = 1
    this.files = new Map([
      [
        indexPath(profile.id),
        Buffer.from(JSON.stringify({ schema: 2, profileId: profile.id, objects: {} }))
      ]
    ])
    this.history = new Map([['c1', this.files]])
    this.reads = []
    this.commits = []
    this.offline = false
    this.corrupt = false
    this.race = false
  }
  async head() {
    if (this.offline) throw new Error('offline')
    return { sha: `c${this.version}`, tree: `t${this.version}` }
  }
  async read(file, commit, limit) {
    if (this.offline) throw new Error('offline')
    this.reads.push(file)
    const data = this.history.get(commit)?.get(file)
    if (!data) return null
    assert.ok(data.length <= limit)
    return this.corrupt && file.includes('/assets/') ? Buffer.from('corrupt') : Buffer.from(data)
  }
  async commit(parent, files, message) {
    if (this.race || parent.sha !== `c${this.version}`) throw new Error('non-fast-forward')
    this.files = new Map([...this.files, ...files])
    this.version++
    this.history.set(`c${this.version}`, this.files)
    this.commits.push({ parent, files: new Map(files), message })
    return `c${this.version}`
  }
  manifest() {
    return JSON.parse(this.files.get(indexPath(profile.id)).toString())
  }
}
const remote = new FakeRemote()
const a = path.join(directory, 'a'),
  b = path.join(directory, 'b')
for (const root of [a, b]) {
  write(root, 'config/characters.json', [])
  write(root, 'config/weapons.json', [])
}
write(a, 'assets/a.png', 'alpha-image')
write(a, 'assets/b.png', 'beta-image')
write(a, 'config/characters.json', [
  row(1, 'Alpha', 'assets/a.png'),
  row(2, 'Beta', 'assets/b.png')
])
let busy = false
const create = (root) =>
  new TeamSyncService({
    root,
    profile,
    repositoryKey: 'org/private/main',
    remote,
    busy: () => (busy ? 'BP running' : null)
  })
let A = create(a),
  B = create(b)
const inspect = (service) => service.inspect()
const sync = (service, view, direction, selections) =>
  service.sync({
    profileId: profile.id,
    token: view.token,
    direction,
    selections: selections.map((s) => (typeof s === 'string' ? { id: s } : s))
  })
const idOf = (view, name) => view.rows.find((r) => r.name === name).id
let cases = 0
const pass = (name) => {
  cases++
  console.log(`PASS ${name}`)
}

async function main() {
  let view = await inspect(A)
  const alpha = idOf(view, 'Alpha'),
    beta = idOf(view, 'Beta')
  assert.equal(view.rows[0].upload, 'added')
  assert.ok(remote.reads.every((file) => file.endsWith('manifest.json')))
  const originalBeta = structuredClone(rows(a)[1])
  await sync(A, view, 'upload', [alpha])
  assert.deepEqual(Object.keys(remote.manifest().objects), [alpha])
  assert.equal(
    remote.commits[0].files.size,
    3,
    'one selected file plus merged configuration and manifest'
  )
  assert.ok(
    ![...remote.commits[0].files.values()].some((buffer) => buffer.toString() === 'beta-image')
  )
  assert.deepEqual(rows(a)[1], originalBeta)
  pass('initial scan reads only manifest; selected upload excludes other objects and files')

  view = await inspect(B)
  assert.equal(view.rows[0].download, 'added')
  await sync(B, view, 'download', [alpha])
  assert.equal(rows(b).length, 1)
  assert.equal(rows(b)[0].sync_id, alpha)
  assert.equal(fs.readFileSync(path.join(b, rows(b)[0].avatar), 'utf8'), 'alpha-image')
  assert.equal((await inspect(B)).rows[0].download, 'unchanged')
  pass('selective download verifies content and preserves stable identity across machines')

  edit(a, (data) => {
    data[0].name = 'Alpha renamed'
    data[0].power = 11
  })
  view = await inspect(A)
  assert.equal(idOf(view, 'Alpha renamed'), alpha)
  const oldView = view
  await sync(A, view, 'upload', [alpha])
  edit(b, (data) => {
    data[0].power = 12
  })
  view = await inspect(B)
  assert.equal(view.rows[0].download, 'conflict')
  await assert.rejects(sync(B, view, 'download', [alpha]), /处理冲突/)
  await sync(B, view, 'download', [{ id: alpha, resolution: 'copy' }])
  assert.equal(rows(b).length, 2)
  assert.equal(rows(b).find((r) => r.sync_id === alpha).power, 11)
  const copy = rows(b).find((r) => r.sync_id !== alpha)
  assert.equal(copy.power, 12)
  assert.match(copy.name, /本地副本/)
  assert.notEqual(copy.id, rows(b).find((r) => r.sync_id === alpha).id)
  await assert.rejects(sync(A, oldView, 'upload', [alpha]), /快照已过期/)
  pass(
    'rename keeps identity; conflicts require a choice; copy preserves local edits with a new ID'
  )

  edit(a, (data) => {
    data[0].power = 14
  })
  await sync(A, await inspect(A), 'upload', [alpha])
  view = await inspect(B)
  edit(b, (data) => {
    data.find((r) => r.sync_id === alpha).power = 13
  })
  await assert.rejects(sync(B, view, 'download', [alpha]), /本地版本已变化/)
  view = await inspect(B)
  await sync(B, view, 'download', [{ id: alpha, resolution: 'local' }])
  assert.equal(rows(b).find((r) => r.sync_id === alpha).power, 13)
  view = await inspect(B)
  assert.equal(view.rows.find((r) => r.id === alpha).upload, 'modified')
  assert.equal(view.rows.find((r) => r.id === alpha).download, 'unchanged')
  await sync(B, view, 'upload', [alpha])
  pass('stale local review is rejected; keep-local acknowledges remote and remains publishable')

  view = await inspect(A)
  await sync(A, view, 'download', [alpha])
  edit(a, (data) => {
    data[0].power = 15
  })
  const reviewed = await inspect(A)
  edit(b, (data) => {
    data.find((r) => r.sync_id === alpha).power = 16
  })
  await sync(B, await inspect(B), 'upload', [alpha])
  await assert.rejects(sync(A, reviewed, 'upload', [alpha]), /远程版本已变化/)
  view = await inspect(A)
  await sync(A, view, 'upload', [{ id: alpha, resolution: 'local' }])
  assert.equal(remote.manifest().objects[alpha].properties.power, 15)
  assert.equal(remote.manifest().objects[alpha].version, 6)
  pass('concurrent updates to the same object invalidate review, including prior conflict choices')

  view = await inspect(B)
  await sync(B, view, 'download', [alpha])
  edit(b, (data) => {
    data.find((r) => r.sync_id === alpha).power = 17
  })
  const bReview = await inspect(B)
  await sync(A, await inspect(A), 'upload', [beta])
  await sync(B, bReview, 'upload', [alpha])
  assert.ok(
    remote.manifest().objects[beta],
    'rebased selected upload preserves unrelated remote addition'
  )
  assert.equal(remote.manifest().objects[alpha].properties.power, 17)
  pass('unrelated concurrent publication is preserved when building on latest remote tree')

  view = await inspect(A)
  await sync(A, view, 'download', [alpha])
  write(a, 'assets/new.png', 'new-avatar-image')
  edit(a, (data) => {
    data[0].avatar = 'assets/new.png'
  })
  await sync(A, await inspect(A), 'upload', [alpha])
  view = await inspect(B)
  const beforeBadDownload = fs.readFileSync(path.join(b, 'config/characters.json'), 'utf8')
  remote.corrupt = true
  await assert.rejects(sync(B, view, 'download', [alpha]), /SHA-256/)
  assert.equal(fs.readFileSync(path.join(b, 'config/characters.json'), 'utf8'), beforeBadDownload)
  remote.corrupt = false
  busy = true
  assert.equal((await sync(B, view, 'download', [alpha])).pending, true)
  assert.equal(fs.readFileSync(path.join(b, 'config/characters.json'), 'utf8'), beforeBadDownload)
  B = create(b)
  assert.equal((await inspect(B)).pending, 1)
  await assert.rejects(B.applyPending(), /BP running/)
  busy = false
  edit(b, (data) => {
    data.find((r) => r.sync_id === alpha).power = 99
  })
  await assert.rejects(B.applyPending(), /等待期间本地资源已修改/)
  assert.equal(rows(b).find((r) => r.sync_id === alpha).power, 99)
  await B.discardPending()
  busy = true
  // Explicitly replace properties here; an omitted mask now downloads only changed fields.
  await sync(B, await inspect(B), 'download', [
    { id: alpha, resolution: 'remote', fields: ['$properties', 'avatar'] }
  ])
  busy = false
  remote.offline = true
  await create(b).applyPending()
  assert.equal(rows(b).find((r) => r.sync_id === alpha).power, 17)
  const offline = await inspect(B)
  assert.equal(offline.offline, true)
  await assert.rejects(sync(B, offline, 'download', [beta]), /远程索引未就绪/)
  remote.offline = false
  pass(
    'bad hashes never apply; queue survives restart, rejects later edits, and applies offline after BP'
  )

  view = await inspect(B)
  const beforeCopy = structuredClone(rows(b).find((r) => r.sync_id === copy.sync_id))
  await sync(B, view, 'download', [beta])
  assert.deepEqual(
    rows(b).find((r) => r.sync_id === copy.sync_id),
    beforeCopy
  )
  edit(a, (data) => {
    data.splice(
      data.findIndex((r) => r.sync_id === alpha),
      1
    )
  })
  // Alpha had acquired sync_id when downloaded; deleting it publishes only its manifest entry.
  await sync(A, await inspect(A), 'upload', [alpha])
  view = await inspect(B)
  assert.equal(view.rows.find((r) => r.id === alpha).download, 'deleted')
  await sync(B, view, 'download', [alpha])
  assert.ok(!rows(b).some((r) => r.sync_id === alpha))
  assert.deepEqual(
    rows(b).find((r) => r.sync_id === copy.sync_id),
    beforeCopy
  )
  assert.ok(rows(b).some((r) => r.sync_id === beta))
  pass('deletion and batch downloads leave unselected local objects intact')

  write(a, 'config/weapons.json', [
    { id: 1, name: '通用武器', damage: 42, dependencies: [beta], created_at: '2026-10-15' }
  ])
  view = await inspect(A)
  const weapon = idOf(view, '通用武器')
  await sync(A, view, 'upload', [weapon])
  const c = path.join(directory, 'c')
  write(c, 'config/characters.json', [])
  write(c, 'config/weapons.json', [])
  const C = create(c)
  await sync(C, await inspect(C), 'download', [weapon])
  assert.equal(rows(c, 'weapons')[0].damage, 42)
  assert.equal(rows(c)[0].sync_id, beta)
  assert.equal(rows(c).length, 1)
  edit(a, (data) => {
    data.splice(0, data.length)
  })
  await assert.rejects(sync(A, await inspect(A), 'upload', [beta]), /依赖/)
  pass(
    'generic weapon adapter works; only required missing dependencies download; referenced deletion is blocked'
  )

  const malformed = structuredClone(remote.manifest())
  malformed.objects[beta].files.avatar.path = '../../outside.txt'
  assert.throws(() => validateManifest(malformed, profile), /路径/)
  malformed.objects[beta].files.avatar.path = remote.manifest().objects[beta].files.avatar.path
  malformed.objects[beta].properties.name = 'tampered'
  assert.throws(() => validateManifest(malformed, profile), /摘要/)
  write(c, 'config/team-profiles.json', [
    { ...profile, collections: [{ ...profile.collections[0], store: 'config/../../outside.json' }] }
  ])
  assert.throws(() => profilesAt(c), /越界/)
  pass('untrusted manifest paths, content hashes and escaping Profile mappings are rejected')

  const journalRoot = path.join(directory, 'journal')
  write(journalRoot, 'config/a.json', 'old')
  write(journalRoot, '.team-sync/transaction.json', {
    committed: false,
    entries: [
      { path: 'config/a.json', before: 'old', after: 'new' },
      { path: 'config/b.json', before: null, after: 'added' }
    ]
  })
  write(journalRoot, 'config/a.json', 'new')
  write(journalRoot, 'config/b.json', 'added')
  recoverTransaction(journalRoot)
  assert.equal(fs.readFileSync(path.join(journalRoot, 'config/a.json'), 'utf8'), 'old')
  assert.ok(!fs.existsSync(path.join(journalRoot, 'config/b.json')))
  transaction(journalRoot, new Map([[path.join(journalRoot, 'config/a.json'), 'new']]))
  assert.equal(fs.readFileSync(path.join(journalRoot, 'config/a.json'), 'utf8'), 'new')
  pass('interrupted multi-store transaction rolls back; normal transaction commits')

  const batchRoot = path.join(directory, 'batch')
  write(batchRoot, 'config/characters.json', [
    row(1, 'Batch A', 'assets/image.png'),
    row(2, 'Batch B', 'assets/image.png')
  ])
  write(batchRoot, 'config/weapons.json', [])
  write(batchRoot, 'assets/image.png', 'same-image')
  const batchRemote = new FakeRemote()
  const batchService = new TeamSyncService({
    root: batchRoot,
    profile,
    repositoryKey: 'batch',
    remote: batchRemote,
    busy: () => null
  })
  let batchView = await inspect(batchService)
  const batchIds = batchView.rows.map((r) => r.id)
  await sync(batchService, batchView, 'upload', batchIds)
  assert.equal(batchRemote.commits.length, 1)
  assert.equal(
    batchRemote.commits[0].files.size,
    3,
    'shared file deduplicated within one atomic batch'
  )
  assert.equal(Object.keys(batchRemote.manifest().objects).length, 2)
  write(batchRoot, 'assets/image.webp', 'same-image')
  edit(batchRoot, (data) => {
    data[0].avatar = 'assets/image.webp'
  })
  batchView = await inspect(batchService)
  assert.equal(batchView.rows[0].upload, 'modified')
  assert.equal(batchView.rows[0].differences[0].kind, 'file')
  await sync(batchService, batchView, 'upload', [batchIds[0]])
  assert.ok([...batchRemote.commits[1].files.keys()].some((p) => p.endsWith('.webp')))
  pass(
    'batch publication is one commit; shared bytes deduplicate; extension-only changes publish the new path'
  )

  // A write failure after the first rename must roll back every store.
  write(journalRoot, 'config/b.json', 'original-b')
  const originalRename = fs.renameSync
  let injected = false
  fs.renameSync = (from, to) => {
    if (!injected && to === path.join(journalRoot, 'config/b.json')) {
      injected = true
      throw new Error('injected disk failure')
    }
    return originalRename(from, to)
  }
  try {
    assert.throws(
      () =>
        transaction(
          journalRoot,
          new Map([
            [path.join(journalRoot, 'config/a.json'), 'broken-a'],
            [path.join(journalRoot, 'config/b.json'), 'broken-b']
          ])
        ),
      /disk failure/
    )
  } finally {
    fs.renameSync = originalRename
  }
  assert.equal(fs.readFileSync(path.join(journalRoot, 'config/a.json'), 'utf8'), 'new')
  assert.equal(fs.readFileSync(path.join(journalRoot, 'config/b.json'), 'utf8'), 'original-b')
  pass('mid-application disk failure rolls back all changed stores')

  // Transport contract tests exercise HTTP caching, exact ref mutation and failure behavior.
  const calls = []
  const mockFetch = async (url, init) => {
    calls.push({ url, ...init, body: init.body && JSON.parse(init.body) })
    if (url.endsWith('/git/ref/heads/main')) return Response.json({ object: { sha: 'head' } })
    if (url.endsWith('/git/commits/head')) return Response.json({ tree: { sha: 'tree' } })
    if (url.includes('/contents/'))
      return init.headers['If-None-Match']
        ? new Response(null, { status: 304 })
        : new Response('index', { headers: { etag: 'test-etag' } })
    if (url.endsWith('/git/trees/tree?recursive=1'))
      return Response.json({ truncated: false, tree: [] })
    if (url.endsWith('/git/blobs')) {
      const data = Buffer.from(JSON.parse(init.body).content, 'base64')
      return Response.json({
        sha: require('node:crypto')
          .createHash('sha1')
          .update(`blob ${data.length}\0`)
          .update(data)
          .digest('hex')
      })
    }
    if (url.endsWith('/git/trees')) return Response.json({ sha: 'new-tree' })
    if (url.endsWith('/git/commits')) return Response.json({ sha: 'commit' })
    if (url.endsWith('/git/refs/heads/main')) return Response.json({})
    return Response.json({ private: true })
  }
  const github = new GitHubStore(
    { owner: 'team', repo: 'private', branch: 'main' },
    () => 'personal-token',
    mockFetch
  )
  const head = await github.head()
  assert.equal((await github.read('manifest.json', 'head', 100)).toString(), 'index')
  assert.equal((await github.read('manifest.json', 'head', 100)).toString(), 'index')
  assert.equal(
    await github.commit(head, new Map([['selected.txt', Buffer.from('selected')]]), 'selected'),
    'commit'
  )
  const patch = calls.find((c) => c.method === 'PATCH')
  assert.deepEqual(patch.body, { sha: 'commit', force: false })
  assert.deepEqual(calls.find((c) => c.url.endsWith('/git/trees')).body.base_tree, 'tree')
  assert.deepEqual(calls.find((c) => c.url.endsWith('/git/commits')).body.parents, ['head'])
  assert.ok(calls.every((c) => c.headers.Authorization === 'Bearer personal-token'))
  assert.ok(calls.every((c) => c.redirect === 'error'))
  const publicStore = new GitHubStore(
    { owner: 'team', repo: 'public', branch: 'main' },
    () => 't',
    async () => Response.json({ private: false })
  )
  await assert.rejects(publicStore.head(), /私有仓库/)
  const denied = new GitHubStore(
    { owner: 'team', repo: 'private', branch: 'main' },
    () => 't',
    async () => new Response('', { status: 403 })
  )
  await assert.rejects(denied.head(), /拒绝访问/)
  let retryCount = 0
  const recovering = new GitHubStore(
    { owner: 'team', repo: 'private', branch: 'main' },
    () => 't',
    async (url, init) => {
      if (retryCount++ === 0) return new Response('', { status: 503 })
      return mockFetch(url, init)
    }
  )
  await recovering.head()
  assert.equal(retryCount, 4, 'transient error retries then reads ref and commit')
  const limited = new GitHubStore(
    { owner: 'team', repo: 'private', branch: 'main' },
    () => 't',
    async () => new Response('', { status: 429, headers: { 'retry-after': '60' } })
  )
  await assert.rejects(limited.head(), /限额/)
  pass(
    'GitHub transport uses private repos, per-user auth, ETag, parent tree and one non-force ref update'
  )

  // A race after uploading blobs must not create a false local baseline.
  edit(b, (data) => {
    data.find((r) => r.sync_id === beta).power = 123
  })
  view = await inspect(B)
  remote.race = true
  await assert.rejects(sync(B, view, 'upload', [beta]), /non-fast-forward/)
  remote.race = false
  assert.equal((await inspect(B)).rows.find((r) => r.id === beta).upload, 'modified')
  pass('failed ref update never advances local sync baseline')
  console.log(`\n${cases} team sync integration checks passed. Fixtures: ${directory}`)
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
