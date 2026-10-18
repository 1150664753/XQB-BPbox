/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type -- Node test runner. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { buildSync } = require('esbuild')
const output = path.resolve(__dirname, '../.tmp/team-sync-github')
fs.mkdirSync(output, { recursive: true })
for (const entry of ['github', 'service', 'model']) {
  buildSync({
    entryPoints: [path.resolve(__dirname, `../src/main/teamSync/${entry}.ts`)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(output, `${entry}.cjs`),
    logLevel: 'silent'
  })
}
const { GitHubStore, GitHubError } = require(path.join(output, 'github.cjs'))
const { TeamSyncService } = require(path.join(output, 'service.cjs'))
const { indexPath } = require(path.join(output, 'model.cjs'))
const repository = {
  owner: 'test-owner',
  repo: 'XQB-Resources',
  branch: 'main',
  clientId: 'test-client'
}
const secret = 'mock-private-credential-should-never-appear'
const base = 'https://api.github.com/repos/test-owner/XQB-Resources'
const profile = {
  id: 'test',
  name: 'Test',
  collections: [
    {
      type: 'character',
      label: '角色',
      store: 'config/characters.json',
      idField: 'id',
      nameFields: ['name'],
      assetFields: {}
    }
  ]
}
const failure = (status, message = 'Not Found', headers = {}) =>
  Response.json({ message }, { status, headers })
const normal = (url) => {
  if (url === base) return Response.json({ private: true, permissions: { push: true } })
  if (url.endsWith('/commits?per_page=1')) return Response.json([{ sha: 'head' }])
  if (url.endsWith('/git/trees/root-tree?recursive=1'))
    return Response.json({ tree: [], truncated: false })
  if (url.includes('/git/ref/heads/')) return Response.json({ object: { sha: 'head' } })
  if (url.endsWith('/git/commits/head')) return Response.json({ tree: { sha: 'root-tree' } })
  if (url.endsWith('/git/trees/root-tree')) return Response.json({ tree: [], truncated: false })
  if (url.includes('/contents/')) return failure(404)
  throw new Error(`Unexpected mock endpoint: ${url}`)
}
const store = (respond, logs = [], getToken = () => secret) =>
  new GitHubStore(repository, getToken, respond, (entry) => logs.push(entry))
const bytesOnDisk = (root) =>
  Object.fromEntries(
    fs
      .readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const file = path.join(entry.parentPath, entry.name)
        return [path.relative(root, file), fs.readFileSync(file).toString('base64')]
      })
  )

async function main() {
  const calls = [],
    logs = []
  const github = store(async (url, init) => {
    calls.push({ url, init })
    if (url.includes('/contents/'))
      return new Response('README', { headers: { etag: 'readme-v1' } })
    return normal(url)
  }, logs)
  assert.deepEqual(await github.head(), { sha: 'head', tree: 'root-tree', writable: true })
  assert.equal((await github.read('文件/a b.png', 'head', 100)).toString(), 'README')
  assert.ok(calls.at(-1).url.endsWith('/contents/%E6%96%87%E4%BB%B6/a%20b.png?ref=head'))
  for (const { init } of calls) {
    assert.equal(init.headers.Authorization, `Bearer ${secret}`)
    assert.equal(init.headers['X-GitHub-Api-Version'], '2022-11-28')
    assert.equal(init.headers['User-Agent'], 'XQB-BPbox-TeamSync')
    assert.equal(init.redirect, 'error')
  }
  assert.equal(calls.at(-1).init.headers.Accept, 'application/vnd.github.raw+json')
  assert.ok(logs.every((entry) => entry.status === 200 && entry.tokenPresent))
  assert.ok(!JSON.stringify(logs).includes(secret))

  for (const [status, message, expected, headers] of [
    [401, 'Bad credentials', /授权已失效/, {}],
    [403, 'Resource not accessible by integration', /拒绝访问/, {}],
    [404, 'Not Found', /Owner\/Repository/, {}],
    [403, 'API rate limit exceeded', /限额/, { 'x-ratelimit-remaining': '0' }],
    [403, 'You have exceeded a secondary rate limit', /限额/, {}],
    [429, 'Too many requests', /限额/, { 'retry-after': '60' }],
    [503, 'Service Unavailable', /服务暂时不可用/, { 'retry-after': '60' }]
  ]) {
    const diagnostics = []
    const denied = store(
      async () =>
        failure(status, message, {
          ...headers,
          'x-github-request-id': 'test-request',
          'x-oauth-scopes': 'repo'
        }),
      diagnostics
    )
    await assert.rejects(denied.head(), (error) => {
      assert.equal(error.status, status)
      assert.match(error.message, expected)
      assert.ok(error.message.includes(`HTTP ${status}`))
      assert.ok(error.message.includes(message))
      assert.ok(error.message.includes(base))
      return true
    })
    assert.equal(diagnostics[0].status, status)
    assert.equal(diagnostics[0].requestId, 'test-request')
    assert.equal(diagnostics[0].oauthScopes, 'repo')
  }
  await assert.rejects(
    store(async (url) => (url.includes('/git/ref/') ? failure(404) : normal(url))).head(),
    /无法读取分支 main/
  )
  const missingLogs = []
  await assert.rejects(
    store(
      async () => assert.fail('missing token must not send a request'),
      missingLogs,
      () => ''
    ).head(),
    /请先/
  )
  assert.equal(missingLogs[0].status, null)
  assert.equal(missingLogs[0].kind, 'authorization')
  for (const [error, expected, kind] of [
    [new TypeError(`fetch failed ${secret}`), /网络请求失败/, 'network'],
    [new DOMException(`timeout ${secret}`, 'TimeoutError'), /请求超时/, 'timeout']
  ]) {
    const diagnostics = []
    await assert.rejects(
      store(async () => {
        throw error
      }, diagnostics).head(),
      expected
    )
    assert.equal(diagnostics.length, 3)
    assert.ok(diagnostics.every((entry) => entry.status === null && entry.kind === kind))
    assert.ok(!JSON.stringify(diagnostics).includes(secret))
  }
  const scrubbed = []
  await assert.rejects(
    store(
      async () =>
        failure(403, `Denied ${secret} Bearer other-secret ghp_anotherSecret`, {
          'x-github-request-id': secret,
          'x-oauth-scopes': secret
        }),
      scrubbed
    ).head(),
    (error) => {
      assert.ok(!error.message.includes(secret))
      assert.ok(!error.message.includes('other-secret'))
      assert.ok(!error.message.includes('ghp_anotherSecret'))
      return true
    }
  )
  assert.ok(!JSON.stringify(scrubbed).includes(secret))
  console.log(
    'PASS request URL/headers, token forwarding, HTTP/network/timeout classification and credential redaction'
  )

  assert.equal(
    await store(async (url) => normal(url)).read(indexPath(profile.id), 'head', 1000),
    null
  )
  await assert.rejects(
    store(async (url) =>
      url.includes('/git/trees/') ? Response.json({ tree: [], truncated: true }) : normal(url)
    ).read(indexPath(profile.id), 'head', 1000),
    /文件树不完整/
  )
  await assert.rejects(
    store(async (url) => (url.includes('/git/commits/') ? failure(403) : normal(url))).read(
      indexPath(profile.id),
      'head',
      1000
    ),
    /拒绝访问/
  )
  await assert.rejects(
    store(async (url) =>
      url.includes('/git/trees/')
        ? Response.json({
            tree: [{ path: 'manifest.json', type: 'blob', sha: 'blob' }],
            truncated: false
          })
        : normal(url)
    ).read('manifest.json', 'head', 1000),
    (error) => error instanceof GitHubError && error.status === 404
  )
  const nested = store(async (url) => {
    if (url.endsWith('/git/trees/root-tree'))
      return Response.json({
        tree: [{ path: 'profiles', type: 'tree', sha: 'sub-tree' }],
        truncated: false
      })
    if (url.endsWith('/git/trees/sub-tree')) return Response.json({ tree: [], truncated: false })
    return normal(url)
  })
  assert.equal(await nested.read('profiles/test/manifest.json', 'head', 1000), null)
  console.log(
    'PASS Contents 404 needs complete authenticated tree evidence; denied/truncated/existing paths fail closed'
  )

  // A README-only repository must not incur Contents+commit+tree requests per missing file.
  const treeCalls = []
  let revoked = false
  const bulk = store(async (url) => {
    treeCalls.push(url)
    if (revoked) return failure(403, 'Forbidden')
    if (url.endsWith('/git/commits/head')) return Response.json({ tree: { sha: 'root' } })
    if (url.endsWith('/git/trees/root?recursive=1'))
      return Response.json({
        tree: [{ path: 'README.md', type: 'blob', sha: 'readme' }],
        truncated: false
      })
    assert.fail(`Unnecessary per-file request: ${url}`)
  })
  for (let i = 0; i < 1000; i++)
    assert.equal(
      await bulk.read(`assets/characters/image-${i}.png`, 'head', 1024, { operationId: 'bulk' }),
      null
    )
  assert.equal(treeCalls.length, 2, '1000 absent paths need just one commit and one complete tree')
  revoked = true
  await assert.rejects(
    bulk.read('new.png', 'head', 1024, { operationId: 'next-operation' }),
    /拒绝访问/
  )
  assert.equal(treeCalls.length, 3, 'another operation must revalidate access')
  const subtreeCalls = []
  const bulkTruncated = store(async (url) => {
    subtreeCalls.push(url)
    if (url.endsWith('/git/commits/head')) return Response.json({ tree: { sha: 'root' } })
    if (url.endsWith('/git/trees/root?recursive=1'))
      return Response.json({ tree: [], truncated: true })
    if (url.endsWith('/git/trees/root'))
      return Response.json({
        tree: [{ path: 'assets', type: 'tree', sha: 'assets' }],
        truncated: false
      })
    if (url.endsWith('/git/trees/assets')) return Response.json({ tree: [], truncated: false })
    assert.fail(url)
  })
  for (let i = 0; i < 100; i++)
    assert.equal(
      await bulkTruncated.read(`assets/missing-${i}.png`, 'head', 1024, {
        operationId: 'truncated-bulk'
      }),
      null
    )
  assert.equal(
    subtreeCalls.length,
    4,
    'complete subtree proofs are reused, never truncated absence'
  )
  console.log(
    'PASS bulk preparation: 1000 missing files need 2 requests; complete subtree reuse and per-operation permission validation'
  )

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xqb-github-preserve-'))
  fs.mkdirSync(path.join(root, 'config'))
  fs.writeFileSync(
    path.join(root, 'config/characters.json'),
    JSON.stringify([{ id: 1, name: 'Local resource', power: 1 }])
  )
  const create = (remote) =>
    new TeamSyncService({
      root,
      profile,
      repositoryKey: 'same-repository/main',
      remote,
      busy: () => null
    })
  let manifest = { schema: 2, profileId: profile.id, objects: {} }
  const seed = create({
    head: async () => ({ sha: 'head', tree: 'tree' }),
    read: async (p) => (p === indexPath(profile.id) ? Buffer.from(JSON.stringify(manifest)) : null)
  })
  const first = await seed.inspect()
  const local = first.rows.find((row) => row.local?.type === 'character').local
  manifest.objects[local.id] = local
  await seed.inspect()
  const before = bytesOnDisk(root)
  const failures = [
    async () => failure(401, 'Bad credentials'),
    async () => failure(403, 'Forbidden'),
    async () => failure(404),
    async () => failure(429, 'Limited', { 'retry-after': '60' }),
    async () => failure(503, 'Unavailable', { 'retry-after': '60' }),
    async (url) => (url.includes('/git/ref/') ? failure(404) : normal(url)),
    async (url) => (url.includes('/contents/') ? failure(403) : normal(url)),
    async (url) => (url.includes('/git/trees/') ? failure(404) : normal(url)),
    async () => {
      throw new TypeError('offline')
    },
    async (url) => (url.includes('/contents/') ? new Response('{invalid JSON') : normal(url)),
    async (url) => normal(url) // Confirmed missing manifest still cannot replace a previous non-empty index.
  ]
  for (const respond of failures) {
    const service = create(store(respond))
    const snapshot = await service.inspect()
    assert.equal(snapshot.offline, true)
    assert.ok(snapshot.rows.find((row) => row.id === local.id).remote)
    await assert.rejects(
      service.sync({
        token: snapshot.token,
        profileId: profile.id,
        direction: 'download',
        selections: [{ id: local.id }]
      }),
      /远程索引未就绪/
    )
    assert.deepEqual(
      bytesOnDisk(root),
      before,
      'failure must not create, overwrite or delete local resources/index/baseline'
    )
  }
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'xqb-github-empty-'))
  const freshDenied = new TeamSyncService({
    root: fresh,
    profile,
    repositoryKey: 'new-repository/main',
    remote: store(async () => failure(404)),
    busy: () => null
  })
  assert.equal((await freshDenied.inspect()).offline, true)
  assert.deepEqual(
    bytesOnDisk(fresh),
    {},
    'failed first connection must not create any local index'
  )
  const freshService = new TeamSyncService({
    root: fresh,
    profile,
    repositoryKey: 'new-repository/main',
    remote: store(async (url) => normal(url)),
    busy: () => null
  })
  assert.equal(
    (await freshService.inspect()).offline,
    true,
    'verified first-time empty repository requires explicit initialization'
  )
  console.log(
    'PASS failures preserve every local byte and cached index; verified first-time empty repository remains supported'
  )
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
