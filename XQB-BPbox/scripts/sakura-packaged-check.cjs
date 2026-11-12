/* eslint-disable @typescript-eslint/no-require-imports */
// Loads the real packaged ASAR main/preload/renderer with an isolated user data directory.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const archive = path.resolve(__dirname, '../dist/win-unpacked/resources/app.asar')
if (!process.versions.electron) {
  assert.ok(fs.existsSync(archive), 'Run npm run build:unpack first')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  const result = require('node:child_process').spawnSync(require('electron'), [__filename], {
    env,
    windowsHide: true,
    encoding: 'utf8',
    timeout: 25000
  })
  process.stdout.write(result.stdout ?? '')
  process.stderr.write(result.stderr ?? '')
  assert.equal(result.status, 0, 'Packaged ASAR smoke test failed')
} else {
  const { app, BrowserWindow } = require('electron')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xqb-sakura-asar-'))
  app.setPath('userData', directory)
  process.env.XQB_BP_ROOT = directory
  BrowserWindow.prototype.show = function () {}
  app.disableHardwareAcceleration()
  assert.ok(require(path.join(archive, 'node_modules/ws')).WebSocketServer)
  require(path.join(archive, 'out/main/index.js'))
  app
    .whenReady()
    .then(async () => {
      const deadline = Date.now() + 12000
      let main
      while (Date.now() < deadline) {
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.webContents.getURL().includes('/renderer/index.html')) continue
          const authorized = await window.webContents
            .executeJavaScript(
              "window.bpAPI?.sakura?.settings().then(s=>s.mode==='webrtc',()=>false)"
            )
            .catch(() => false)
          if (authorized) {
            main = window
            break
          }
        }
        if (main) break
        await new Promise((resolve) => setTimeout(resolve, 40))
      }
      assert.ok(main, 'Packaged renderer/preload/main Sakura IPC must load')
      assert.equal(
        await main.webContents.executeJavaScript('window.bpAPI.sakura.status().then(s=>s.service)'),
        'stopped'
      )
      await assert.rejects(
        main.webContents.executeJavaScript('window.bpAPI.sakura.start()'),
        /配置|公网|设置/
      )
      const js = (code) => main.webContents.executeJavaScript(code)
      const until = async (code) => {
        const deadline = Date.now() + 5000
        while (Date.now() < deadline) {
          if (await js(code)) return
          await new Promise((resolve) => setTimeout(resolve, 30))
        }
        throw new Error('Packaged UI assertion timed out')
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
      main.webContents.sendInputEvent({
        type: 'keyDown',
        keyCode: 'T',
        modifiers: ['control', 'shift']
      })
      await until('!!document.querySelector("dialog[open]")')
      assert.equal(await js('document.querySelector("dialog h2").textContent'), '远程 BP 网络设置')
      await until(
        '!!document.querySelector("#turn-password") && !document.querySelector("select[aria-label=连接模式]").disabled'
      )
      await js(
        '(()=>{const e=document.querySelector("select[aria-label=连接模式]");e.value="sakura";e.dispatchEvent(new Event("change",{bubbles:true}))})()'
      )
      await until('!!document.querySelector(".sakura-settings")')
      const net = require('node:net')
      const reservation = net.createServer()
      await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve))
      const port = reservation.address().port
      await new Promise((resolve) => reservation.close(resolve))
      await js(`window.bpAPI.sakura.configure({mode:'sakura',publicUrl:'',localPort:${port}})`)
      assert.equal(await js('window.bpAPI.sakura.startService().then(s=>s.service)'), 'listening')
      assert.equal(await js('window.bpAPI.sakura.stopService().then(s=>s.service)'), 'stopped')
      await js('window.bpAPI.sakura.stop()')
      console.log(
        'PASS packaged ASAR dependencies, real Ctrl+Shift+T, unified settings, main/preload/renderer IPC and loopback start/stop; no live tunnel'
      )
      app.quit()
    })
    .catch((error) => {
      console.error(error)
      app.exit(1)
    })
}
