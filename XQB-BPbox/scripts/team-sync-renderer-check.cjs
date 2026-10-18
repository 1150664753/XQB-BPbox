/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type -- Node/Electron CommonJS test runner. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const output = path.resolve(__dirname, '../.tmp/team-sync-ui')
if (!process.versions.electron) {
  fs.mkdirSync(output, { recursive: true })
  require('esbuild').buildSync({
    entryPoints: [path.join(__dirname, 'team-sync-renderer-fixture.tsx')],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    outfile: path.join(output, 'fixture.js'),
    logLevel: 'silent'
  })
  fs.writeFileSync(
    path.join(output, 'index.html'),
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><style>body{margin:0;overflow:auto;background:#f3f3f3}#root{min-width:680px}button{cursor:pointer}input,select{padding:5px 8px}button{padding:5px 12px}</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>'
  )
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const result = spawnSync(require('electron'), [__filename], {
    env,
    encoding: 'utf8',
    timeout: 45000,
    windowsHide: true
  })
  process.stdout.write(result.stdout ?? '')
  process.stderr.write(result.stderr ?? '')
  assert.equal(result.status, 0, 'Team resources renderer checks failed')
} else {
  const { app, BrowserWindow } = require('electron')
  app.setPath('userData', path.join(output, 'user-data'))
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('force-device-scale-factor', '1')
  app
    .whenReady()
    .then(async () => {
      const win = new BrowserWindow({
        show: false,
        width: 1240,
        height: 960,
        webPreferences: {
          offscreen: true,
          backgroundThrottling: false,
          contextIsolation: true,
          nodeIntegration: false
        }
      })
      const js = (source) =>
        win.webContents.executeJavaScript(source).catch((error) => {
          throw new Error(`${error.message}\nScript: ${source}`)
        })
      async function until(source) {
        for (let i = 0; i < 100; i++) {
          if (await js(source)) return
          await new Promise((r) => setTimeout(r, 50))
        }
        throw new Error(`UI condition timed out: ${source}`)
      }
      const click = (text) =>
        js(
          `Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === ${JSON.stringify(text)}).click()`
        )
      await win.loadFile(path.join(output, 'index.html'))
      await until(
        "document.querySelectorAll('.team-resource').length === 2 && !document.querySelector('.team-notice')?.textContent.includes('正在读取')"
      )
      await until("document.querySelectorAll('.team-resource-image img').length === 2")
      await click('上传')
      await until("document.querySelectorAll('.team-conflict-choices').length === 1")
      assert.match(await js("document.querySelector('[role=alert]').textContent"), /冲突/)
      assert.equal((await js('window.teamSyncTest.calls')).length, 0)
      await until("document.querySelectorAll('.team-image-pair img').length === 2")
      await new Promise((resolve) => setTimeout(resolve, 250))
      fs.writeFileSync(
        path.join(output, 'team-resources-conflict.png'),
        (await win.webContents.capturePage()).toPNG()
      )
      await js("document.querySelectorAll('.team-conflict-choices input')[2].click()")
      await click('上传')
      await until('window.teamSyncTest.calls.length === 1')
      assert.equal((await js('window.teamSyncTest.calls[0]')).selections[0].resolution, 'copy')
      await until("document.querySelectorAll('.team-conflict-choices').length === 0")
      await js(
        "document.querySelector('select[aria-label=资源类型]').value = 'weapon'; document.querySelector('select[aria-label=资源类型]').dispatchEvent(new Event('change', {bubbles:true}))"
      )
      await until("document.querySelectorAll('.team-resource').length === 1")
      assert.match(await js("document.querySelector('.team-resource').textContent"), /巡游之刃/)
      await js("document.querySelector('input[aria-label=选择全部筛选结果中的可同步资源]').click()")
      await click('批量发布（1）')
      await until('window.teamSyncTest.calls.length === 2')
      assert.deepEqual((await js('window.teamSyncTest.calls[1]')).selections, [
        { id: 'beta', resolution: undefined }
      ])
      await js(
        "document.querySelector('select[aria-label=资源类型]').value = ''; document.querySelector('select[aria-label=资源类型]').dispatchEvent(new Event('change', {bubbles:true}))"
      )
      await js("document.querySelectorAll('[role=tab]')[1].click()")
      await until(
        "document.querySelector('[role=tab][aria-selected=true]').textContent.includes('获取远程')"
      )
      assert.match(await js("document.querySelector('.team-list').textContent"), /夜色中的约定/)
      await js(
        "const search = document.querySelector('input[type=search]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(search, '夜色'); search.dispatchEvent(new Event('input', {bubbles:true}))"
      )
      await until("document.querySelectorAll('.team-resource').length === 1")
      await click('下载')
      await until('window.teamSyncTest.calls.length === 3')
      assert.equal((await js('window.teamSyncTest.calls[2]')).direction, 'download')
      await click('仓库与授权')
      await until("document.querySelector('.team-repository') !== null")
      await js("document.querySelector('.team-resources').scrollTop = 0")
      await new Promise((resolve) => setTimeout(resolve, 250))
      fs.writeFileSync(
        path.join(output, 'team-resources-settings.png'),
        (await win.webContents.capturePage()).toPNG()
      )
      assert.equal(await js('document.documentElement.scrollWidth > window.innerWidth'), false)
      win.setSize(1120, 720)
      await new Promise((resolve) => setTimeout(resolve, 150))
      assert.equal(
        await js(
          "document.querySelector('.team-resources').scrollWidth > document.querySelector('.team-resources').clientWidth"
        ),
        false,
        'minimum app width must not clip resource actions'
      )
      assert.equal(
        await js("getComputedStyle(document.querySelector('.team-resources')).overflowY"),
        'auto',
        'resource details must scroll inside workbench'
      )
      await click('仓库与授权')
      await js('window.teamSyncTest.enableFields()')
      await click('刷新差异')
      await until("!document.querySelector('.team-notice')?.textContent.includes('正在读取')")
      await click('详情')
      await until("document.querySelector('input[aria-label=立绘目标路径]') !== null")
      await js(
        "const target=document.querySelector('input[aria-label=立绘目标路径]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(target,'assets/hire/card.png'); target.dispatchEvent(new Event('input',{bubbles:true}))"
      )
      await click('下载')
      await until('window.teamSyncTest.calls.length === 4')
      assert.equal(
        (await js('window.teamSyncTest.calls[3]')).selections[0].paths.avatar,
        'assets/hire/card.png'
      )
      await js(
        "{ const search=document.querySelector('input[type=search]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(search,'巡游'); search.dispatchEvent(new Event('input',{bubbles:true})); document.querySelectorAll('[role=tab]')[0].click() }"
      )
      await until(
        "document.querySelectorAll('.team-resource').length === 1 && document.querySelector('.team-resource').textContent.includes('巡游')"
      )
      await click('详情')
      await until('document.querySelector(\'input[aria-label="同步 大图"]\') !== null')
      for (const label of ['缺失音频', '视频', '外部音频'])
        assert.equal(
          await js(`document.querySelector('input[aria-label="同步 ${label}"]').disabled`),
          true
        )
      await js('document.querySelector(\'input[aria-label="同步 大图"]\').click()')
      await click('上传')
      await until('window.teamSyncTest.calls.length === 5')
      assert.deepEqual((await js('window.teamSyncTest.calls[4]')).selections[0].fields, [
        '$properties',
        'avatar'
      ])
      await until("document.querySelectorAll('.team-file-selection').length === 0")
      await click('详情')
      await until("document.querySelector('input[aria-label=外部音频目标路径]') !== null")
      await js(
        "{ const target=document.querySelector('input[aria-label=外部音频目标路径]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(target,'assets/audios/pick/import.wav'); target.dispatchEvent(new Event('input',{bubbles:true})) }"
      )
      win.setSize(1240, 960)
      await new Promise((resolve) => setTimeout(resolve, 250))
      fs.writeFileSync(
        path.join(output, 'team-resources-file-selection.png'),
        (await win.webContents.capturePage()).toPNG()
      )
      await click('安全导入到本地分类目录')
      await until('window.teamSyncTest.imports.length === 1')
      assert.deepEqual(await js('window.teamSyncTest.imports[0]'), [
        'demo',
        'fixture',
        'beta',
        'external',
        'assets/audios/pick/import.wav'
      ])
      await js(`{
        const search = document.querySelector('input[type=search]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(search, '');
        search.dispatchEvent(new Event('input', {bubbles:true}));
        window.teamSyncTest.enableRecovery();
        document.querySelectorAll('[role=tab]')[1].click();
      }`)
      await click('刷新差异')
      await until("document.querySelectorAll('.team-status.missing').length === 2")
      assert.match(
        await js("document.querySelector('.team-status.missing').textContent"),
        /本地缺失 \/ 可恢复/
      )
      await click('恢复')
      await until('window.teamSyncTest.calls.length === 6')
      assert.equal((await js('window.teamSyncTest.calls[5]')).direction, 'download')
      assert.deepEqual((await js('window.teamSyncTest.calls[5]')).selections[0].fields, ['avatar'])
      await until(
        "!document.querySelector('input[aria-label=选择全部筛选结果中的可同步资源]').disabled"
      )
      await js("document.querySelector('input[aria-label=选择全部筛选结果中的可同步资源]').click()")
      await js('document.querySelector(\'input[aria-label="选择 开拓者"]\').click()')
      await click('批量恢复（2）')
      await until('window.teamSyncTest.calls.length === 7')
      assert.deepEqual(
        (await js('window.teamSyncTest.calls[6]')).selections.map((s) => [s.id, s.fields]),
        [
          ['beta', ['avatar']],
          ['gamma', ['avatar']]
        ]
      )
      win.setSize(1120, 720)
      await new Promise((resolve) => setTimeout(resolve, 150))
      assert.equal(
        await js(
          "document.querySelector('.team-resources').scrollWidth > document.querySelector('.team-resources').clientWidth"
        ),
        false,
        'recovery status and actions must fit the minimum app width'
      )
      console.log(
        'PASS renderer recovery: missing status, individual/batch restore, changed-field masks preserve local metadata, compact layout'
      )
      await js('window.teamSyncTest.enablePagination()')
      await click('刷新差异')
      await until("document.querySelectorAll('.team-resource').length === 30")
      await js("document.querySelectorAll('[role=tab]')[0].click()")
      const selectAll = "document.querySelector('input[aria-label=选择全部筛选结果中的可同步资源]')"
      const selectedVisible =
        "Array.from(document.querySelectorAll('.team-resource-row > input')).filter(input => input.checked).length"
      const setType = (type) =>
        js(`{
        const input = document.querySelector('select[aria-label=资源类型]');
        input.value = ${JSON.stringify(type)};
        input.dispatchEvent(new Event('change', {bubbles:true}));
      }`)
      const setSearch = (value) =>
        js(`{
        const input = document.querySelector('input[type=search]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
        input.dispatchEvent(new Event('input', {bubbles:true}));
      }`)
      await setType('result')
      await js("document.querySelector('.team-changes-filter input').click()")
      await until("document.querySelector('.team-footer').textContent.includes('66 个资源')")
      await js(`${selectAll}.click()`)
      await until("document.querySelector('.team-batch-action').textContent === '批量发布（65）'")
      await click('下一页')
      await until(`${selectedVisible} === 30`)
      await js("document.querySelector('.team-resource-row > input').click()")
      await until(`${selectAll}.indeterminate && !${selectAll}.checked`)
      assert.match(await js("document.querySelector('.team-batch-action').textContent"), /64/)
      await js(`${selectAll}.click()`)
      await until(`${selectAll}.checked && ${selectedVisible} === 30`)
      await click('下一页')
      await until("document.querySelectorAll('.team-resource').length === 6")
      assert.equal(await js(selectedVisible), 5, 'unchanged rows must stay unselected')
      await js(`${selectAll}.click()`)
      await until(
        `${selectedVisible} === 0 && document.querySelector('.team-batch-action').disabled`
      )
      await js(`${selectAll}.click()`)
      await click('批量发布（65）')
      await until('window.teamSyncTest.calls.length === 8')
      const publishedResults = (await js('window.teamSyncTest.calls[7]')).selections
      assert.deepEqual(
        publishedResults.map((s) => s.id),
        Array.from({ length: 65 }, (_, i) => `result-${i}`)
      )
      assert.ok(publishedResults.every((s) => s.fields.join(',') === '$properties,document'))
      await until(`!${selectAll}.checked && !${selectAll}.disabled`)
      await js(
        "document.querySelectorAll('[role=tab]')[1].click(); document.querySelector('.team-changes-filter input').click()"
      )
      await setSearch('预赛')
      await until("document.querySelector('.team-footer').textContent.includes('35 个资源')")
      await js(`${selectAll}.click()`)
      await until("document.querySelector('.team-batch-action').textContent === '批量恢复（35）'")
      await click('下一页')
      await until("document.querySelectorAll('.team-resource').length === 5")
      assert.equal(await js(selectedVisible), 5)
      await click('批量恢复（35）')
      await until('window.teamSyncTest.calls.length === 9')
      const restoredResults = await js('window.teamSyncTest.calls[8]')
      assert.equal(restoredResults.direction, 'download')
      assert.deepEqual(
        restoredResults.selections.map((s) => s.id),
        Array.from({ length: 35 }, (_, i) => `result-${i}`)
      )
      await until(`!${selectAll}.checked && !${selectAll}.disabled`)
      await setType('')
      await setSearch('')
      await js(`${selectAll}.click()`)
      await until("document.querySelector('.team-batch-action').textContent === '批量下载（66）'")
      await click('下一页')
      await click('下一页')
      await until("document.querySelectorAll('.team-resource').length === 7")
      assert.equal(await js(selectedVisible), 6, 'unmapped resources must stay unselected')
      await js(`${selectAll}.click()`)
      await until("document.querySelector('.team-batch-action').disabled")
      console.log(
        'PASS renderer pagination: selects all 65 results across pages, preserves checks on page changes, indeterminate/deselect-all feedback, search/type filters, excludes unchanged/unmapped rows, batch publishes and restores beyond 30 resources'
      )
      await js(
        "document.querySelectorAll('[role=tab]')[0].click(); window.teamSyncTest.holdUpload()"
      )
      await click('上传')
      await until("document.querySelector('.team-upload-progress.uploading') !== null")
      assert.match(
        await js("document.querySelector('.team-progress-counts').textContent"),
        /总文件 65.*已完成 12.*跳过 4.*失败 0/
      )
      assert.match(
        await js("document.querySelector('.team-progress-file').textContent"),
        /当前上传文件.png/
      )
      assert.equal(await js("document.querySelector('progress').value"), 12)
      await new Promise((resolve) => setTimeout(resolve, 150))
      fs.writeFileSync(
        path.join(output, 'team-resources-upload-progress.png'),
        (await win.webContents.capturePage()).toPNG()
      )
      await js(
        "window.teamSyncTest.advanceProgress({stage:'checking', total:80, completed:23, currentFile:'results/bp/当前核对文件.json', activity:'读取远程文件，第 1/3 次请求，单次超时 60 秒', elapsedSeconds:15, waitingSeconds:7})"
      )
      await until("document.querySelector('.team-upload-progress.checking') !== null")
      assert.equal(await js("document.querySelector('progress').value"), 23)
      assert.match(
        await js("document.querySelector('.team-progress-counts').textContent"),
        /总文件 80.*已完成 23.*已用时 15 秒.*28%/
      )
      assert.match(
        await js("document.querySelector('.team-upload-progress [role=status]').textContent"),
        /第 1\/3 次请求.*已等待 7 秒/
      )
      await js(
        "window.teamSyncTest.advanceProgress({stage:'validating', total:0, completed:0, currentFile:'config/app/characters.json', activity:'', waitingSeconds:0})"
      )
      await until("document.querySelector('progress').getAttribute('value') === null")
      assert.equal(
        await js("getComputedStyle(document.querySelector('progress')).animationName"),
        'team-progress-wait'
      )
      await js('window.teamSyncTest.advanceProgress({total:8, completed:5})')
      await until("document.querySelector('.team-upload-progress.validating') !== null")
      assert.equal(await js("document.querySelector('progress').value"), 5)
      assert.match(
        await js("document.querySelector('.team-progress-file').textContent"),
        /config\/app\/characters.json/
      )
      fs.writeFileSync(
        path.join(output, 'team-resources-validation-progress.png'),
        (await win.webContents.capturePage()).toPNG()
      )
      await click('取消同步')
      await until(
        "document.querySelector('.team-upload-progress.cancelled') !== null && !Array.from(document.querySelectorAll('button')).find(b => b.textContent === '刷新差异').disabled"
      )
      await js('window.teamSyncTest.holdUpload()')
      await click('上传')
      await until("document.querySelector('.team-upload-progress.uploading') !== null")
      await js("window.teamSyncTest.finishUpload('测试文件上传失败：HTTP 403')")
      await until(
        "document.querySelector('.team-upload-progress.failed') !== null && !Array.from(document.querySelectorAll('button')).find(b => b.textContent === '上传').disabled"
      )
      assert.match(await js("document.querySelector('[role=alert]').textContent"), /HTTP 403/)
      await js('window.teamSyncTest.holdUpload()')
      await click('上传')
      await until("document.querySelector('.team-upload-progress.uploading') !== null")
      await js(
        "window.teamSyncTest.advanceProgress({stage:'committing', completed:65, message:'更新并确认分支引用', cancellable:false})"
      )
      await until("document.querySelector('.team-upload-progress.committing') !== null")
      assert.equal(
        await js(
          "Array.from(document.querySelectorAll('button')).some(b => b.textContent === '取消同步')"
        ),
        false
      )
      await js('window.teamSyncTest.finishUpload()')
      await until(
        "document.querySelector('.team-upload-progress.completed') !== null && !Array.from(document.querySelectorAll('button')).find(b => b.textContent === '刷新差异').disabled"
      )
      assert.equal(await js("document.querySelector('progress').value"), 65)
      console.log(
        'PASS renderer upload progress: file counts, filename, cancel/failure unlock the UI, commit finalization and completion'
      )
      console.log(
        'PASS renderer: conflict choices, lazy image comparison, filters, batch/name selection, download direction, settings layout, individual files, missing/video exclusion, legacy destination and safe external import'
      )
      await js("window.teamSyncTest.remoteState('index_missing')")
      await click('刷新差异')
      await until(
        "Array.from(document.querySelectorAll('button')).some(b => b.textContent.trim() === '初始化远程索引')"
      )
      assert.match(
        await js("document.querySelector('.team-sync-indicator').textContent"),
        /远程索引缺失/
      )
      assert.equal(
        await js(
          "Array.from(document.querySelectorAll('button')).find(b => b.textContent === '上传').disabled"
        ),
        true
      )
      await click('初始化远程索引')
      await until("document.querySelector('section[aria-label=确认初始化远程索引]') !== null")
      const confirm =
        "Array.from(document.querySelectorAll('button')).find(b => b.textContent === '确认初始化并发布本地资源')"
      assert.equal(await js(`${confirm}.disabled`), true)
      await js(
        "document.querySelector('section[aria-label=确认初始化远程索引]').scrollIntoView({block:'center'})"
      )
      await new Promise((resolve) => setTimeout(resolve, 150))
      fs.writeFileSync(
        path.join(output, 'team-resources-initialize.png'),
        (await win.webContents.capturePage()).toPNG()
      )
      assert.equal(await js('document.documentElement.scrollWidth > window.innerWidth'), false)
      await click('取消')
      assert.equal(await js('window.teamSyncTest.initializations.length'), 0)
      await click('初始化远程索引')
      await js(
        "document.querySelector('section[aria-label=确认初始化远程索引] input[type=checkbox]').click()"
      )
      await until(`!${confirm}.disabled`)
      await click('确认初始化并发布本地资源')
      await until('window.teamSyncTest.initializations.length === 1')
      await until(
        "!Array.from(document.querySelectorAll('button')).find(b => b.textContent === '上传').disabled"
      )
      assert.deepEqual(await js('window.teamSyncTest.initializations[0]'), {
        profileId: 'demo',
        token: 'fixture',
        acknowledgeConflictRisk: true
      })
      for (const [status, label] of [
        ['network_error', '网络连接异常'],
        ['permission_denied', '授权或权限不足'],
        ['index_invalid', '索引格式损坏'],
        ['empty', '空仓库，待初始化']
      ]) {
        await js(`window.teamSyncTest.remoteState('${status}', false)`)
        await click('刷新差异')
        await until(
          `document.querySelector('.team-sync-indicator').textContent.includes('${label}')`
        )
        assert.equal(
          await js(
            "Array.from(document.querySelectorAll('button')).some(b => b.textContent === '初始化远程索引')"
          ),
          false
        )
      }
      console.log(
        'PASS renderer initialization: distinct states, locked sync, risk confirmation, cancellation, permission gate, successful refresh'
      )
      console.log(`Screenshots: ${output}`)
      win.destroy()
      app.exit(0)
    })
    .catch((error) => {
      console.error(error)
      app.exit(1)
    })
}
