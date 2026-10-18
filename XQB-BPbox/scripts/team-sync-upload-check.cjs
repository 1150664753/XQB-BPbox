/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type -- Node integration test. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const output = path.resolve(__dirname, '../.tmp/team-sync-upload')
fs.mkdirSync(output, { recursive: true })
require('esbuild').buildSync({
  entryPoints: [path.resolve(__dirname, '../src/main/teamSync/github.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: path.join(output, 'github.cjs'),
  logLevel: 'silent'
})
const { GitHubStore } = require(path.join(output, 'github.cjs'))
const sha = (data) => createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex')
const parent = { sha: 'head', tree: 'root' }
function fixture(initial = {}, intercept) {
  const calls = [],
    logs = [],
    progress = []
  const existing = Object.entries(initial).map(([path, content]) => ({
    path,
    type: 'blob',
    sha: sha(Buffer.from(content))
  }))
  let head = parent.sha
  const remote = new GitHubStore(
    { owner: 'team', repo: 'private', branch: 'main' },
    () => 'private-credential',
    async (url, init) => {
      const call = {
        endpoint: url.split('/private')[1],
        method: init.method,
        body: init.body && JSON.parse(init.body),
        signal: init.signal
      }
      calls.push(call)
      if (intercept) {
        const result = await intercept(call)
        if (result) return result
      }
      if (call.endpoint === '/git/trees/root?recursive=1')
        return Response.json({ truncated: false, tree: existing })
      if (call.endpoint === '/git/blobs')
        return Response.json(
          { sha: sha(Buffer.from(call.body.content, 'base64')) },
          { status: 201 }
        )
      if (call.endpoint === '/git/trees') return Response.json({ sha: 'new-tree' }, { status: 201 })
      if (call.endpoint === '/git/commits')
        return Response.json({ sha: 'new-commit' }, { status: 201 })
      if (call.endpoint === '/git/refs/heads/main') {
        head = 'new-commit'
        return Response.json({})
      }
      if (call.endpoint === '') return Response.json({ private: true })
      if (call.endpoint === '/git/ref/heads/main') return Response.json({ object: { sha: head } })
      if (call.endpoint === `/git/commits/${head}`)
        return Response.json({ tree: { sha: 'new-tree' } })
      throw new Error(`Unexpected request ${call.method} ${call.endpoint}`)
    },
    (log) => logs.push(log),
    40
  )
  const options = {
    operationId: 'upload-test',
    onProgress: (update) => progress.push({ ...progress.at(-1), ...update })
  }
  return { remote, calls, logs, progress, options }
}
const blobs = (f) => f.calls.filter((c) => c.endpoint === '/git/blobs')
const writes = (f) => f.calls.filter((c) => c.method !== 'GET')
async function main() {
  const f = fixture({ 'assets/existing.png': 'same', 'assets/unchanged.png': 'unchanged' })
  const files = new Map([
    ['assets/unchanged.png', Buffer.from('unchanged')],
    ['assets/copy.png', Buffer.from('same')],
    ['assets/new-a.png', Buffer.from('new')],
    ['assets/new-b.png', Buffer.from('new')]
  ])
  assert.equal(await f.remote.commit(parent, files, 'selected', f.options), 'new-commit')
  assert.equal(blobs(f).length, 1, 'identical bytes across paths must create one blob')
  assert.deepEqual(
    f.calls.find((c) => c.endpoint === '/git/trees').body.tree.map((e) => e.path),
    ['assets/copy.png', 'assets/new-a.png', 'assets/new-b.png']
  )
  assert.deepEqual(f.calls.find((c) => c.method === 'PATCH').body, {
    sha: 'new-commit',
    force: false
  })
  assert.equal(f.progress.at(-1).completed, 4)
  assert.equal(f.progress.at(-1).skipped, 3)
  const diagnostic = f.logs.find((e) => e.method === 'POST' && e.target.endsWith('/git/blobs'))
  assert.equal(diagnostic.filePath, 'assets/new-a.png')
  assert.equal(diagnostic.fileSize, 3)
  assert.equal(diagnostic.sha, sha(Buffer.from('new')))
  assert.equal(diagnostic.total, 4)
  assert.equal(diagnostic.operationId, 'upload-test')
  assert.ok(!JSON.stringify(f.logs).includes('private-credential'))
  const noop = fixture({ 'assets/a.png': 'same' })
  assert.equal(
    await noop.remote.commit(
      parent,
      new Map([
        ['assets/a.png', Buffer.from('same')],
        ['absent.json', null]
      ]),
      'none',
      noop.options
    ),
    'head'
  )
  assert.equal(writes(noop).length, 0)
  assert.equal(noop.progress.at(-1).skipped, 2)
  const deletion = fixture({ 'results/bp/old.json': 'old' })
  await deletion.remote.commit(
    parent,
    new Map([['results/bp/old.json', null]]),
    'delete',
    deletion.options
  )
  assert.equal(blobs(deletion).length, 0)
  assert.deepEqual(deletion.calls.find((c) => c.endpoint === '/git/trees').body.tree, [
    { path: 'results/bp/old.json', mode: '100644', type: 'blob', sha: null }
  ])
  console.log(
    'PASS upload: remote content comparison, same-content deduplication, no-op publication, exact paths, counts and blob diagnostics'
  )
  const truncated = fixture({}, (call) => {
    if (call.endpoint === '/git/trees/root?recursive=1')
      return Response.json({ truncated: true, tree: [] })
    if (call.endpoint === '/git/trees/root')
      return Response.json({
        truncated: false,
        tree: [{ path: 'assets', type: 'tree', sha: 'assets-tree' }]
      })
    if (call.endpoint === '/git/trees/assets-tree')
      return Response.json({
        truncated: false,
        tree: [{ path: 'same.png', type: 'blob', sha: sha(Buffer.from('same')) }]
      })
  })
  await truncated.remote.commit(
    parent,
    new Map([
      ['assets/same.png', Buffer.from('same')],
      ['assets/new.png', Buffer.from('new')]
    ]),
    'truncated',
    truncated.options
  )
  assert.equal(blobs(truncated).length, 1)
  assert.equal(truncated.calls.filter((c) => c.endpoint === '/git/trees/assets-tree').length, 1)
  const incomplete = fixture({}, (call) =>
    call.endpoint.startsWith('/git/trees/root')
      ? Response.json({ truncated: true, tree: [] })
      : undefined
  )
  await assert.rejects(
    incomplete.remote.commit(parent, files, 'incomplete', incomplete.options),
    /子目录不完整/
  )
  assert.equal(writes(incomplete).length, 0)
  console.log(
    'PASS upload: truncated recursive trees fall back to complete cached subtrees; incomplete evidence stops writes'
  )

  let fail = true
  const retry = fixture({}, (call) =>
    call.endpoint === '/git/blobs' &&
    Buffer.from(call.body.content, 'base64').toString() === 'second' &&
    fail
      ? Response.json({ message: 'permission denied' }, { status: 403 })
      : undefined
  )
  const pair = new Map([
    ['first.png', Buffer.from('first')],
    ['second.png', Buffer.from('second')]
  ])
  await assert.rejects(
    retry.remote.commit(parent, pair, 'test', retry.options),
    /second.png.*\n.*HTTP 403/
  )
  assert.equal(retry.progress.at(-1).failed, 1)
  assert.equal(retry.calls.filter((c) => c.endpoint === '/git/trees').length, 0)
  fail = false
  await retry.remote.commit(parent, pair, 'retry', retry.options)
  assert.equal(
    blobs(retry).filter((c) => Buffer.from(c.body.content, 'base64').toString() === 'first').length,
    1
  )
  console.log(
    'PASS upload: a failed file stops publication and retry reuses successfully created blobs'
  )

  for (const mode of ['request', 'body', 'backoff']) {
    const controller = new AbortController()
    const stalled = fixture({}, (call) => {
      if (call.endpoint !== '/git/blobs') return
      setTimeout(() => controller.abort(new Error('test cancelled')), 10)
      if (mode === 'request') return new Promise(() => {})
      if (mode === 'body')
        return new Response(new ReadableStream({ cancel: () => new Promise(() => {}) }), {
          status: 201
        })
      return Response.json(
        { message: 'retry later' },
        { status: 503, headers: { 'retry-after': '1' } }
      )
    })
    await assert.rejects(
      stalled.remote.commit(parent, pair, 'cancel', {
        ...stalled.options,
        signal: controller.signal
      }),
      /test cancelled/
    )
    assert.equal(blobs(stalled).length, 1)
    assert.equal(stalled.calls.filter((c) => c.endpoint === '/git/trees').length, 0)
  }
  const timed = fixture({}, (call) =>
    call.endpoint === '/git/blobs'
      ? new Response(new ReadableStream({ cancel: () => new Promise(() => {}) }), {
          status: 201
        })
      : undefined
  )
  await assert.rejects(
    timed.remote.commit(parent, pair, 'timeout', timed.options),
    /first.png.*\n.*响应读取超时/
  )
  assert.equal(blobs(timed).length, 1)
  const stuckFetch = fixture({}, (call) =>
    call.endpoint === '/git/blobs' ? new Promise(() => {}) : undefined
  )
  await assert.rejects(
    stuckFetch.remote.commit(parent, pair, 'timeout', stuckFetch.options),
    /first.png.*\n.*请求超时/
  )
  assert.equal(blobs(stuckFetch).length, 3, 'timeouts stop after the fixed retry limit')
  console.log(
    'PASS upload: cancellation interrupts fetch, stalled response bodies and retry waits; response timeout is bounded'
  )

  for (const endpoint of ['/git/trees', '/git/commits', '/git/refs/heads/main']) {
    const failed = fixture({}, (call) =>
      call.endpoint === endpoint
        ? Response.json({ message: 'blocked stage' }, { status: 403 })
        : undefined
    )
    await assert.rejects(
      failed.remote.commit(parent, pair, 'failure', failed.options),
      /blocked stage/
    )
    assert.equal(
      failed.calls.filter((c) => c.method === 'PATCH').length,
      endpoint.includes('/refs/') ? 1 : 0
    )
  }
  const controller = new AbortController()
  const finalizing = fixture({}, (call) => {
    if (call.endpoint === '/git/refs/heads/main') {
      controller.abort(new Error('too late'))
      throw new DOMException('lost PATCH response', 'TimeoutError')
    }
    if (call.endpoint === '/git/ref/heads/main')
      return Response.json({ object: { sha: 'new-commit' } })
    if (call.endpoint === '/git/commits/new-commit')
      return Response.json({ tree: { sha: 'new-tree' } })
  })
  assert.equal(
    await finalizing.remote.commit(parent, pair, 'accepted', {
      ...finalizing.options,
      signal: controller.signal
    }),
    'new-commit'
  )
  assert.equal(finalizing.calls.filter((c) => c.method === 'PATCH').length, 1)
  assert.equal(finalizing.progress.at(-1).cancellable, false)
  console.log(
    'PASS upload: Tree/Commit/ref errors terminate; accepted ref updates are reconciled without retrying PATCH'
  )
}
// Timeout signals are unref'ed; keep this standalone test alive during stalled mock streams.
const watchdog = setTimeout(() => {
  console.error('Upload checks timed out')
  process.exit(1)
}, 20000)
main()
  .then(() => clearTimeout(watchdog))
  .catch((error) => {
    clearTimeout(watchdog)
    console.error(error)
    process.exitCode = 1
  })
