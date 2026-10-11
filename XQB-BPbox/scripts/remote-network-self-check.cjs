const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const directory = path.resolve(__dirname, '../.tmp/remote-network-test')
if (!process.versions.electron) {
  fs.mkdirSync(directory, { recursive: true })
  require('esbuild').buildSync({
    entryPoints: [path.join(__dirname, 'remote-network-browser-check.tsx')],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    outfile: path.join(directory, 'test.js'),
    logLevel: 'silent'
  })
  const css = fs.readFileSync(
    path.resolve(__dirname, '../src/renderer/src/styles/remote-bp.css'),
    'utf8'
  )
  fs.writeFileSync(
    path.join(directory, 'test.html'),
    `<!doctype html><html><meta charset="utf-8"><style>body{font:13px Segoe UI,Microsoft YaHei,sans-serif;margin:16px;color:#24292f;background:#f7f9fc}#root{background:white;padding:16px;border:1px solid #d0d7de;border-radius:12px} ${css}</style><body><div id="root"></div><script src="test.js"></script></body></html>`
  )
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const result = spawnSync(require('electron'), [__filename], {
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 65000
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  assert.equal(result.status, 0, 'real WebRTC/cache/UI check failed')
} else {
  const { app, BrowserWindow } = require('electron')
  app.setPath('userData', path.join(directory, 'user-data'))
  app.disableHardwareAcceleration()
  app
    .whenReady()
    .then(async () => {
      const win = new BrowserWindow({
        show: false,
        width: 450,
        height: 1400,
        webPreferences: { backgroundThrottling: false, contextIsolation: true, offscreen: true }
      })
      await win.loadFile(path.join(directory, 'test.html'))
      const end = Date.now() + 50000
      let result
      while (!result && Date.now() < end) {
        await new Promise((resolve) => setTimeout(resolve, 200))
        result = await win.webContents.executeJavaScript('window.__networkTest')
      }
      assert.ok(result, 'browser check timed out')
      assert.ok(!result.error, result.error)
      assert.match(await win.webContents.executeJavaScript('document.body.innerText'), /候选路径/)
      win.webContents.invalidate()
      await new Promise((resolve) => setTimeout(resolve, 300))
      fs.writeFileSync(
        path.join(directory, 'diagnostics.json'),
        JSON.stringify(result.diagnostics, null, 2)
      )
      fs.writeFileSync(
        path.join(directory, 'diagnostics.png'),
        (await win.webContents.capturePage()).toPNG()
      )
      result.checks.forEach((check) => console.log(`PASS ${check}`))
      console.log(
        `PASS diagnostics panel rendering and export; screenshot: ${path.join(directory, 'diagnostics.png')}`
      )
      win.close()
      app.exit(0)
    })
    .catch((error) => {
      console.error(error)
      app.exit(1)
    })
}
