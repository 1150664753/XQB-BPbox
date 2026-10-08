const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { buildSync } = require('esbuild')
const directory = path.resolve(__dirname, '../.tmp/turn-desktop-test')
fs.mkdirSync(directory, { recursive: true })
buildSync({
  entryPoints: [path.resolve(__dirname, '../src/main/remoteBp/turnAuthStore.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: path.join(directory, 'store.cjs')
})
buildSync({
  entryPoints: [path.resolve(__dirname, '../src/preload/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  outfile: path.join(directory, 'preload.cjs')
})
buildSync({
  stdin: {
    contents: fs
      .readFileSync(path.resolve(__dirname, '../src/main/ipc/turnAuth.ts'), 'utf8')
      .replace(
        "import { isMainWebContents } from '../windows'",
        'const isMainWebContents = (contents: Electron.WebContents): boolean => contents.id === (globalThis as any).__XqbTurnTestWindowId'
      ),
    loader: 'ts',
    resolveDir: path.resolve(__dirname, '../src/main/ipc')
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  outfile: path.join(directory, 'ipc.cjs')
})
buildSync({
  stdin: {
    contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import TurnAuthorizationDialog from './src/renderer/src/components/remoteBp/TurnAuthorizationDialog'; createRoot(document.getElementById('root')).render(<TurnAuthorizationDialog/>);`,
    loader: 'tsx',
    resolveDir: path.resolve(__dirname, '..')
  },
  bundle: true,
  platform: 'browser',
  format: 'iife',
  jsx: 'automatic',
  outfile: path.join(directory, 'dialog.js')
})
fs.writeFileSync(
  path.join(directory, 'dialog.html'),
  '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="dialog.css"><body style="font-family:Segoe UI,Microsoft YaHei,sans-serif;background:#f6f8fa"><div id="root"></div><script src="dialog.js"></script></body></html>'
)
const electron = require('electron')
for (const phase of ['write', 'read']) {
  const environment = {
    ...process.env,
    XQB_TURN_TEST_DIRECTORY: directory,
    XQB_TURN_TEST_PHASE: phase
  }
  delete environment.ELECTRON_RUN_AS_NODE
  const result = spawnSync(electron, [path.join(__dirname, 'turn-desktop-test-app.cjs')], {
    env: environment,
    encoding: 'utf8',
    timeout: 40_000,
    windowsHide: true
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  assert.equal(result.status, 0, 'Electron TURN test failed')
}
console.log('PASS Electron secure storage across process restart and hidden authorization dialog')
