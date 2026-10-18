/* eslint-disable @typescript-eslint/no-require-imports -- Node/Electron CommonJS test runner. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')
const output = path.resolve(__dirname, '../.tmp/team-sync-electron')
if (!process.versions.electron) {
  fs.mkdirSync(output, { recursive: true })
  for (const [name, entry] of Object.entries({
    auth: 'teamSync/auth',
    logging: 'teamSync/logging',
    characters: 'stores/characters',
    lightCones: 'stores/lightCones'
  })) {
    require('esbuild').buildSync({
      entryPoints: [path.resolve(__dirname, `../src/main/${entry}.ts`)],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
      outfile: path.join(output, `${name}.cjs`),
      logLevel: 'silent'
    })
  }
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const result = spawnSync(require('electron'), [__filename], {
    env,
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true
  })
  process.stdout.write(result.stdout ?? '')
  process.stderr.write(result.stderr ?? '')
  assert.equal(result.status, 0, 'Team sync Electron checks failed')
} else {
  const { app, net, shell } = require('electron')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bpbox-team-electron-'))
  process.env.XQB_BP_ROOT = root
  app.setPath('userData', root)
  app.disableHardwareAcceleration()
  app
    .whenReady()
    .then(async () => {
      const auth = require(path.join(output, 'auth.cjs'))
      let responses = [
        {
          device_code: 'private-device-code',
          user_code: 'USER-CODE',
          expires_in: 900,
          interval: 5
        },
        { error: 'authorization_pending' },
        { error: 'slow_down' },
        { access_token: 'mock-personal-token' }
      ]
      const calls = [],
        opens = []
      net.fetch = async (url, options) => {
        calls.push({ url, options })
        return Response.json(responses.shift())
      }
      shell.openExternal = async (url) => {
        opens.push(url)
      }
      const time = Date.now
      let now = time()
      Date.now = () => now
      const code = await auth.authorizeGitHub('test-client-id')
      assert.equal(code.userCode, 'USER-CODE')
      assert.ok(!('device_code' in code))
      assert.deepEqual(opens, ['https://github.com/login/device'])
      assert.equal(await auth.pollGitHub('test-client-id'), 'pending')
      assert.equal(await auth.pollGitHub('test-client-id'), 'pending')
      assert.equal(calls.length, 2, 'poll respects GitHub interval')
      now += 6000
      assert.equal(await auth.pollGitHub('test-client-id'), 'pending')
      now += 6000
      assert.equal(await auth.pollGitHub('test-client-id'), 'pending')
      assert.equal(calls.length, 3, 'slow_down extends interval')
      now += 6000
      assert.equal(await auth.pollGitHub('test-client-id'), 'authorized')
      assert.equal(auth.githubToken('test-client-id'), 'mock-personal-token')
      assert.equal(auth.githubToken('other-client-id'), '')
      assert.match(auth.githubAuthorization('other-client-id').problem, /Client ID 不匹配/)
      const encrypted = fs.readFileSync(path.join(root, 'team-github-auth.bin'))
      assert.ok(!encrypted.includes(Buffer.from('mock-personal-token')))
      auth.logoutGitHub()
      assert.equal(auth.githubToken('test-client-id'), '')
      assert.match(auth.githubAuthorization('test-client-id').problem, /未保存/)
      await assert.rejects(auth.pollGitHub('test-client-id'), /过期/)
      responses = [
        { device_code: 'private-device-code', user_code: 'CODE', expires_in: 900 },
        { access_token: 'limited-token', scope: 'public_repo' }
      ]
      await auth.authorizeGitHub('test-client-id')
      await assert.rejects(auth.pollGitHub('test-client-id'), /未授予 repo scope/)
      assert.equal(auth.githubToken('test-client-id'), '')
      Date.now = time
      console.log(
        'PASS Electron: device flow interval/slow_down, fixed verification URL, encrypted per-user token and logout'
      )

      const logging = require(path.join(output, 'logging.cjs'))
      app.setPath('logs', path.join(root, 'logs'))
      logging.logTeamSync({ event: 'test', status: 403, message: 'Denied ghp_privateCredential' })
      const diagnostic = fs.readFileSync(logging.teamSyncLogPath(), 'utf8')
      assert.ok(!diagnostic.includes('ghp_privateCredential'))
      assert.equal(JSON.parse(diagnostic).status, 403)
      fs.appendFileSync(logging.teamSyncLogPath(), 'x'.repeat(2 * 1024 * 1024))
      logging.logTeamSync({ event: 'rotated', status: 200 })
      assert.ok(fs.existsSync(`${logging.teamSyncLogPath()}.previous`))
      assert.equal(JSON.parse(fs.readFileSync(logging.teamSyncLogPath(), 'utf8')).event, 'rotated')
      console.log(
        'PASS Electron: persisted diagnostic logs redact credentials and rotate without touching resource state'
      )

      const characters = require(path.join(output, 'characters.cjs'))
      const cones = require(path.join(output, 'lightCones.cjs'))
      const characterPayload = {
        english_name: 'alpha',
        chinese_name: '角色',
        rarity: 5,
        element: '火',
        path: '毁灭'
      }
      const character = characters.createCharacter(characterPayload)
      const characterId = character.sync_id
      assert.ok(characterId)
      characters.updateCharacter(character.id, { ...characterPayload, chinese_name: '改名角色' })
      assert.equal(characters.getCharacter(character.id).sync_id, characterId)
      const payload = { name: '光锥', rarity: 5, path: '毁灭' }
      const cone = cones.createLightCone(payload)
      const coneId = cone.sync_id
      assert.ok(coneId)
      cones.updateLightCone(cone.id, { ...payload, name: '改名光锥' })
      assert.equal(cones.getLightCone(cone.id).sync_id, coneId)
      cones.deleteLightCone(cone.id)
      const replacement = cones.createLightCone(payload)
      assert.equal(replacement.id, cone.id)
      assert.notEqual(
        replacement.sync_id,
        coneId,
        'local numeric ID reuse must not reuse team identity'
      )
      console.log(
        'PASS legacy stores: stable IDs survive edits and are not recycled after deletion'
      )
      app.exit(0)
    })
    .catch((error) => {
      console.error(error)
      app.exit(1)
    })
}
