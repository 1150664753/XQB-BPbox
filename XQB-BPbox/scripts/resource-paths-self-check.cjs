/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type -- Node/Electron integration checks. */
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
const output = path.resolve(__dirname, '../.tmp/resource-path-tests')
if (!process.versions.electron) {
  fs.mkdirSync(output, { recursive: true })
  for (const [name, source] of Object.entries({
    paths: 'resourcePaths',
    migration: 'resourceMigration',
    assets: 'assets',
    characters: 'stores/characters',
    lightCones: 'stores/lightCones',
    table: 'stores/characterResourceTable',
    voice: 'ipc/voiceTimelines',
    flows: 'ipc/flows',
    bp: 'ipc/bp',
    display: 'ipc/displaySettings',
    protocols: 'protocols',
    configuration: 'teamSync/configuration',
    localProfile: 'teamSync/localProfile'
  }))
    require('esbuild').buildSync({
      entryPoints: [path.resolve(__dirname, `../src/main/${source}.ts`)],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
      loader: { '.png': 'dataurl' },
      outfile: path.join(output, `${name}.cjs`),
      logLevel: 'silent'
    })
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const result = require('node:child_process').spawnSync(require('electron'), [__filename], {
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60000
  })
  process.stdout.write(result.stdout || '')
  process.stderr.write(result.stderr || '')
  assert.equal(result.status, 0, 'Resource path checks failed')
} else {
  const { app, ipcMain, protocol } = require('electron')
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'xqb-resource-paths-'))
  const root = path.join(temporary, 'root'),
    legacy = path.join(temporary, 'legacy'),
    external = path.join(temporary, 'external')
  for (const dir of [root, legacy, external]) fs.mkdirSync(dir)
  process.env.XQB_BP_ROOT = root
  app.setPath('userData', legacy)
  app.disableHardwareAcceleration()
  const write = (base, file, value) => {
    const dest = path.join(base, file)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(
      dest,
      typeof value === 'string' || Buffer.isBuffer(value)
        ? value
        : JSON.stringify(value, null, 2) + '\n'
    )
    return dest
  }
  const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))
  const url = (value) => `xqb-asset://local/${encodeURIComponent(value)}`
  app
    .whenReady()
    .then(async () => {
      const { ResourcePathPlan } = require(path.join(output, 'paths.cjs'))
      const { migrateResourcePaths } = require(path.join(output, 'migration.cjs'))
      const assets = require(path.join(output, 'assets.cjs'))
      const face = write(root, 'assets/characters/small/原名.png', 'face')
      const audio = write(external, '完整原名.m4a', 'external-audio')
      const legacyVideo = write(legacy, 'assets/videos/chant/chant_00001.mp4', '0123456789')
      write(root, 'config/bp/流程.json', { name: '流程', steps: [], path: '毁灭' })
      const legacyFlow = { name: '旧流程', steps: [], backgroundImage: face }
      write(legacy, 'flows/旧流程.json', legacyFlow)
      write(legacy, 'flows/损坏流程.json', '{bad json')
      write(root, 'config/display/旧流程展示.json', { triggerFlowFile: '旧流程.json' })
      write(root, 'config/display/损坏流程展示.json', { triggerFlowFile: '损坏流程.json' })
      write(root, 'results/bp/结果.json', {
        name: '结果',
        actions: [],
        starTeam: { name: 'A', picks: [], bans: [] },
        railTeam: { name: 'B', picks: [], bans: [] }
      })
      const character = {
        id: 1,
        name: '角色',
        path: '毁灭',
        avatar_small_image: face,
        chant_video: 'assets/videos/chant/chant_00001.mp4',
        pv: 'assets/videos/PV/missing.mp4'
      }
      write(root, 'config/app/characters.json', [character])
      write(root, 'config/app/light-cones.json', [
        { id: 1, path: '记忆', small_image: 'assets/characters/small/原名.png' }
      ])
      write(root, 'config/app/character-resource-table.json', {
        rows: [{ ...character, resource_status: { avatar_small_image: 'found', pv: 'missing' } }]
      })
      const timeline = {
        id: 'test',
        name: 'Test',
        audioPath: audio,
        audioUrl: url(audio),
        audioExists: true,
        bpFlowConfigFile: '流程.json',
        bpResultFile: '结果.json',
        duration: 1,
        clickPoints: [{ id: 'point', type: 'bp_step', time: 0, iconPath: url(face) }]
      }
      const timelineFile = write(root, 'config/audio/Test.json', timeline)
      const original = fs.readFileSync(timelineFile, 'utf8')
      const plan = migrateResourcePaths(root, [legacy])
      assert.equal(plan.applied, false)
      assert.equal(fs.readFileSync(timelineFile, 'utf8'), original)
      assert.equal(fs.existsSync(path.join(root, 'assets/audios/完整原名.m4a')), false)
      assert.ok(!plan.issues.some((issue) => ['found', 'missing'].includes(issue.value)))
      const migrated = migrateResourcePaths(root, [legacy], true)
      assert.equal(
        fs.readFileSync(path.join(migrated.backupDirectory, 'config/audio/Test.json'), 'utf8'),
        original
      )
      assert.equal(read('config/audio/Test.json').audioPath, 'assets/audios/完整原名.m4a')
      assert.equal(read('config/audio/Test.json').bpFlowConfigFile, 'config/bp/流程.json')
      assert.equal(read('config/audio/Test.json').bpResultFile, 'results/bp/结果.json')
      assert.equal(
        read('config/audio/Test.json').clickPoints[0].iconPath,
        'assets/characters/small/原名.png'
      )
      assert.ok(!('audioUrl' in read('config/audio/Test.json')))
      assert.equal(read('config/app/characters.json')[0].path, '毁灭')
      assert.equal(read('config/display/旧流程展示.json').triggerFlowFile, 'config/bp/旧流程.json')
      assert.equal(
        read('config/bp/旧流程.json').backgroundImage,
        'assets/characters/small/原名.png'
      )
      assert.deepEqual(
        JSON.parse(
          fs.readFileSync(path.join(migrated.backupDirectory, 'config/bp/旧流程.json'), 'utf8')
        ),
        legacyFlow
      )
      assert.equal(read('config/display/损坏流程展示.json').triggerFlowFile, '损坏流程.json')
      assert.ok(!fs.existsSync(path.join(root, 'config/bp/损坏流程.json')))
      assert.equal(read('config/app/characters.json')[0].pv, character.pv)
      assert.deepEqual(read('config/app/character-resource-table.json').rows[0].resource_status, {
        avatar_small_image: 'found',
        pv: 'missing'
      })
      assert.ok(fs.existsSync(audio) && fs.existsSync(legacyVideo))
      assert.equal(
        fs.readFileSync(path.join(root, 'assets/videos/chant/chant_00001.mp4'), 'utf8'),
        '0123456789'
      )
      const again = migrateResourcePaths(root, [legacy])
      assert.deepEqual(again.changedFiles, [])
      assert.deepEqual(again.copies, [])
      console.log(
        'PASS migration: backups, root-relative references, original filenames, legacy copy, missing preservation, business/status fields and idempotence'
      )

      const colliding = write(external, '原名.png', 'different-face')
      const collisionPlan = new ResourcePathPlan(root, [legacy])
      const collision = collisionPlan.document({ avatar_small_image: colliding })
      assert.equal(collision.avatar_small_image, colliding)
      assert.match(collisionPlan.issues[0].reason, /同名不同内容/)
      assert.equal(fs.readFileSync(face, 'utf8'), 'face')
      assert.throws(
        () => assets.importAssetFile(colliding, 'characters', 'owner', 'avatar_small_image'),
        /同名不同内容/
      )
      const missing = path.join(external, 'not-found.wav')
      assert.throws(
        () => assets.prepareAssetValue(missing, 'characters', 'owner', 'pick_voice'),
        /不存在/
      )
      assert.equal(
        assets.prepareAssetValue(missing, 'characters', 'owner', 'pick_voice', missing),
        missing
      )
      assert.equal(assets.resolveStoredPath('../external/完整原名.m4a'), null)
      assert.throws(() => assets.toStoredPath(audio), /根目录/)
      assert.equal(assets.toStoredPath('assets/audios/完整原名.m4a'), 'assets/audios/完整原名.m4a')
      assert.equal(
        assets.resolveStoredPath(url('assets/audios/完整原名.m4a')),
        path.join(root, 'assets/audios/完整原名.m4a')
      )
      assert.equal(assets.storedPathToFileUrl(face), url('assets/characters/small/原名.png'))
      const another = write(external, '后续.wav', 'new-audio')
      assert.equal(
        assets.importAssetFile(another, 'characters', 'must-not-be-folder', 'pick_voice')
          .storedPath,
        'assets/audios/pick/后续.wav'
      )
      assert.ok(fs.existsSync(another))
      assert.ok(!fs.existsSync(path.join(root, 'assets/characters/must-not-be-folder')))
      console.log(
        'PASS runtime: data-root resolution, URL decoding, classified imports, collision/no-overwrite and missing-reference safety'
      )

      const handlers = new Map()
      ipcMain.handle = (channel, handler) => handlers.set(channel, handler)
      require(path.join(output, 'voice.cjs')).registerVoiceTimelineIpc()
      require(path.join(output, 'flows.cjs')).registerFlowIpc()
      require(path.join(output, 'bp.cjs')).registerBpIpc()
      require(path.join(output, 'display.cjs')).registerDisplaySettingsIpc()
      const call = (channel, ...args) => handlers.get(channel)({}, ...args)
      const loaded = call('voice-timelines:load', 'Test.json')
      assert.equal(loaded.audioUrl, url('assets/audios/完整原名.m4a'))
      assert.equal(loaded.clickPoints[0].iconUrl, url('assets/characters/small/原名.png'))
      assert.equal((await call('flows:load', loaded.bpFlowConfigFile)).name, '流程')
      assert.equal(call('bp:load-result', loaded.bpResultFile).name, '结果')
      write(root, 'flows/原位置流程.json', { name: '原位置流程', steps: [] })
      assert.equal((await call('flows:load', 'flows/原位置流程.json')).name, '原位置流程')
      assert.equal((await call('flows:load', 'config\\bp\\流程.json')).name, '流程')
      call(
        'voice-timelines:save',
        { ...loaded, audioPath: another, audioUrl: url(another) },
        'Test.json'
      )
      assert.equal(read('config/audio/Test.json').audioPath, 'assets/audios/后续.wav')
      assert.ok(!('audioUrl' in read('config/audio/Test.json')))
      const snapshot = {
        ...character,
        avatar_small_image: 'assets/characters/small/原名.png',
        avatar_small_image_url: url(face)
      }
      assets.writeResourceDocument(path.join(root, 'results/bp/图片结果.json'), {
        name: '图片结果',
        actions: [{ target: snapshot, targetImage: url(face) }]
      })
      const reloaded = call('bp:load-result', 'results/bp/图片结果.json')
      assert.equal(
        reloaded.actions[0].target.avatar_small_image_url,
        url('assets/characters/small/原名.png')
      )
      assert.equal(reloaded.actions[0].targetImage, url('assets/characters/small/原名.png'))
      assert.ok(
        !fs.readFileSync(path.join(root, 'results/bp/图片结果.json'), 'utf8').includes('xqb-asset:')
      )
      const visual = write(external, '背景.png', 'background')
      const defaults = call('display-settings:get', 'new.json')
      call(
        'display-settings:save',
        {
          ...defaults,
          backgroundImage: visual,
          backgroundLayers: [],
          triggerFlowFile: '流程.json'
        },
        'new.json'
      )
      assert.equal(
        read('config/display/new.json').backgroundImage,
        'assets/backgrounds/base/背景.png'
      )
      const characters = require(path.join(output, 'characters.cjs'))
      const created = characters.createCharacter({
        english_name: 'new',
        chinese_name: '新增角色',
        rarity: 5,
        element: '火',
        path: '毁灭',
        avatar_small_image: visual
      })
      assert.equal(created.avatar_small_image, 'assets/characters/small/背景.png')
      assert.equal(created.path, '毁灭')
      const cones = require(path.join(output, 'lightCones.cjs'))
      const cone = cones.createLightCone({
        name: '新增光锥',
        rarity: 5,
        path: '记忆',
        small_image: visual
      })
      assert.equal(cone.small_image, 'assets/lightcones/small/背景.png')
      const table = require(path.join(output, 'table.cjs'))
      const savedTable = table.saveCharacterResourceTable([
        { code: '00088', chinese_name: '测试表', path: '虚无', avatar_small_image: visual }
      ])
      assert.equal(savedTable.rows[0].avatar_small_image, 'assets/characters/small/背景.png')
      assert.equal(read('config/app/character-resource-table.json').rows[0].path, '虚无')
      write(root, 'config/bp/无效配置.json', '{invalid')
      const invalid = migrateResourcePaths(root, [legacy])
      assert.ok(
        invalid.issues.some(
          (issue) => issue.field === 'config/bp/无效配置.json' && /JSON/.test(issue.reason)
        )
      )
      assert.equal(fs.readFileSync(path.join(root, 'config/bp/无效配置.json'), 'utf8'), '{invalid')
      assert.equal(read('config/display/new.json').triggerFlowFile, 'config/bp/流程.json')
      console.log(
        'PASS IPC: voice save/load, regenerated preview icons, BP flow/result loading, snapshot images and display saves'
      )

      const { configuration } = require(path.join(output, 'configuration.cjs'))
      const shared = configuration(read('config/audio/Test.json'), root)
      assert.equal(shared.content.audioPath, 'assets/audios/后续.wav')
      assert.ok(shared.references.some((ref) => ref.path === 'assets/audios/后续.wav'))
      assert.equal(shared.content.bpFlowConfigFile, 'config/bp/流程.json')
      assert.equal(
        configuration({ site: 'https://example.com', path: '毁灭' }, root).content.site,
        'https://example.com'
      )
      let protocolHandler
      protocol.handle = (_scheme, handler) => {
        protocolHandler = handler
      }
      require(path.join(output, 'protocols.cjs')).registerAssetProtocol()
      const response = await protocolHandler(
        new Request(url('assets/videos/chant/chant_00001.mp4'), { headers: { Range: 'bytes=2-5' } })
      )
      assert.equal(response.status, 206)
      assert.equal(await response.text(), '2345')
      console.log(
        'PASS shared configuration uses classified root-relative paths; video protocol Range playback resolves the copied file'
      )
      const { LocalProfile, defaultProfile } = require(path.join(output, 'localProfile.cjs'))
      const scanRoot = path.join(temporary, 'sync-presence')
      process.env.XQB_BP_ROOT = scanRoot
      const relativeImage = 'assets/characters/small/存在性 测试.png'
      const absoluteImage = write(scanRoot, relativeImage, 'current')
      const fallbackImage = write(legacy, relativeImage, 'fallback')
      write(scanRoot, 'config/app/characters.json', [
        {
          id: 1,
          chinese_name: '路径检测',
          avatar_small_image: relativeImage,
          left_head_image: relativeImage.replaceAll('/', '\\'),
          right_head_image: url(relativeImage),
          full_body_image: require('node:url').pathToFileURL(absoluteImage).href
        }
      ])
      write(scanRoot, 'config/app/light-cones.json', [
        { id: 1, name: '路径光锥', small_image: absoluteImage }
      ])
      const scanner = new LocalProfile(scanRoot, defaultProfile, assets.resolveStoredPath)
      const files = async () =>
        Object.values((await scanner.scan()).objects).flatMap((x) =>
          Object.values(x.fields).filter((f) => f.localPath)
        )
      assert.ok((await files()).every((f) => f.state === 'ready' && f.localPath === relativeImage))
      fs.unlinkSync(absoluteImage)
      assert.equal(assets.resolveStoredPath(relativeImage), fallbackImage)
      assert.ok(
        (await files()).every((f) => f.state === 'ready'),
        'same relative legacy fallback remains available'
      )
      fs.unlinkSync(fallbackImage)
      assert.equal(assets.resolveStoredPath(relativeImage), absoluteImage)
      assert.ok(
        (await files()).every((f) => f.state === 'missing'),
        'relative, Windows, URL and absolute references detect missing bytes after hash caching'
      )
      write(scanRoot, relativeImage, 'restored')
      assert.ok((await files()).every((f) => f.state === 'ready'))
      console.log(
        'PASS team sync presence: actual resolver, data root priority, legacy fallback, relative/absolute/URL paths, delete and restore'
      )
      app.exit(0)
    })
    .catch((error) => {
      console.error(error)
      app.exit(1)
    })
}
