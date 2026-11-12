/* eslint-disable @typescript-eslint/no-require-imports */
// Real Electron preload/IPC/dialog and loopback service; public probe routing is a fixture, never a public tunnel test.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')
const output = path.resolve(__dirname, '../.tmp/sakura-electron')
if (!process.versions.electron) {
  fs.mkdirSync(output, { recursive: true })
  const { buildSync } = require('esbuild')
  const mainDir = path.resolve(__dirname, '../src/main')
  let manager = fs.readFileSync(path.join(mainDir, 'remoteBp/SakuraManager.ts'), 'utf8')
  manager = manager.replace(
    "import { WebSocket } from 'ws'",
    "import type { WebSocket as Socket } from 'ws'; type WebSocket = Socket; const WebSocket = (globalThis as any).__sakuraSocket;"
  )
  const ipc = fs
    .readFileSync(path.join(mainDir, 'ipc/sakura.ts'), 'utf8')
    .replace(
      "import { isMainWebContents } from '../windows'",
      'const isMainWebContents = (wc: Electron.WebContents): boolean => wc.id === (globalThis as any).__sakuraOwner;'
    )
    .replace(
      "import { SakuraManager } from '../remoteBp/SakuraManager'",
      `const { SakuraManager } = require(${JSON.stringify(path.join(output, 'manager.cjs'))});`
    )
  buildSync({
    stdin: { contents: manager, resolveDir: path.join(mainDir, 'remoteBp'), loader: 'ts' },
    outfile: path.join(output, 'manager.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron', 'ws'],
    logLevel: 'silent'
  })
  buildSync({
    stdin: { contents: ipc, resolveDir: path.join(mainDir, 'ipc'), loader: 'ts' },
    outfile: path.join(output, 'ipc.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron', 'ws'],
    logLevel: 'silent'
  })
  buildSync({
    entryPoints: [path.resolve(__dirname, '../src/preload/index.ts')],
    outfile: path.join(output, 'preload.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    logLevel: 'silent'
  })
  buildSync({
    stdin: {
      contents: `
import React from 'react'; import {createRoot} from 'react-dom/client';
import RemoteBpPanel from './src/renderer/src/components/remoteBp/RemoteBpPanel';
import NetworkDialog from './src/renderer/src/components/remoteBp/TurnAuthorizationDialog';
import {networkSettings} from './src/renderer/src/services/remoteBp/networkSettings';
import {RemoteBpHost,BpActionDispatcher,MockRemoteHostTransport} from './src/shared/remoteBp';
import {SakuraRemoteHostTransport} from './src/renderer/src/services/remoteBp/SakuraRemoteHostTransport';
import {SelectableRemoteHostTransport} from './src/renderer/src/services/remoteBp/SelectableRemoteHostTransport';
import './src/renderer/src/styles/vscode-light.css'; import './src/renderer/src/styles/remote-bp.css';
const fakeWebRTC=()=>{const transport=new MockRemoteHostTransport();const start=transport.start.bind(transport);return Object.assign(transport,{kind:'webrtc',start:async(room)=>{await start({...room,roomId:'TEST99'});return {roomId:'TEST99',connectionState:'connected'}}})};
const host=new RemoteBpHost({dispatcher:new BpActionDispatcher(), transport:new SelectableRemoteHostTransport(
mode=>mode==='sakura'?new SakuraRemoteHostTransport(window.bpAPI.sakura):fakeWebRTC(),fakeWebRTC()),
getAssetManifest:async()=>({revision:1,generatedAt:new Date().toISOString(),assets:[]}),getAsset:async()=>{throw Error('unused')},
getDispatchSnapshot:()=>({}),getExecutor:()=>({}),getSerializerInput:()=>({})});
host.getCurrentRemoteState=()=>null;
window.testHost=host; window.testNetwork=networkSettings;
createRoot(document.getElementById('root')).render(<><RemoteBpPanel host={host}/><NetworkDialog/></>);
`,
      resolveDir: path.resolve(__dirname, '..'),
      loader: 'tsx'
    },
    outfile: path.join(output, 'panel.js'),
    bundle: true,
    platform: 'browser',
    jsx: 'automatic',
    logLevel: 'silent'
  })
  fs.writeFileSync(
    path.join(output, 'panel.html'),
    '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="panel.css"><style>body{overflow:auto;padding:20px}#root{width:500px;--bp-gap-sm:8px;--bp-pad-md:12px;--bp-font-size:14px;--bp-small-font-size:12px;--bp-title-font-size:16px}</style><div id="root"></div><script src="panel.js"></script>'
  )
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xqb-sakura-test-'))
  for (const phase of ['write', 'read']) {
    const env = { ...process.env, XQB_SAKURA_TEST_DATA: dataDir, XQB_SAKURA_TEST_PHASE: phase }
    delete env.ELECTRON_RUN_AS_NODE
    const result = spawnSync(require('electron'), [__filename], {
      env,
      windowsHide: true,
      encoding: 'utf8',
      timeout: 45000
    })
    process.stdout.write(result.stdout ?? '')
    process.stderr.write(result.stderr ?? '')
    assert.equal(result.status, 0, 'Sakura Electron integration failed')
  }
} else {
  const { app, BrowserWindow, ipcMain } = require('electron')
  const { WebSocket } = require('ws')
  const dataDir = process.env.XQB_SAKURA_TEST_DATA
  const readPhase = process.env.XQB_SAKURA_TEST_PHASE === 'read'
  app.setPath('userData', dataDir)
  app.disableHardwareAcceleration()
  let localPort,
    probeFailure = false,
    turnStatusCalls = 0
  global.__sakuraSocket = class extends WebSocket {
    constructor(url, options) {
      assert.equal(url, 'wss://test.example:1234/bp')
      assert.equal(options.rejectUnauthorized, true)
      assert.equal(options.followRedirects, false)
      // Explicit loopback probe routing, NOT a real WSS/public Sakura test.
      super(`ws://127.0.0.1:${probeFailure ? 1 : localPort}/bp`, options)
    }
  }
  global.fetch = () => {
    throw new Error('Sakura mode must not call TURN or provider APIs')
  }
  app
    .whenReady()
    .then(async () => {
      const net = require('node:net')
      const reservation = net.createServer()
      await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve))
      localPort = reservation.address().port
      await new Promise((resolve) => reservation.close(resolve))
      const window = new BrowserWindow({
        show: false,
        width: 800,
        height: 1000,
        webPreferences: {
          preload: path.join(output, 'preload.cjs'),
          contextIsolation: true,
          nodeIntegration: false,
          offscreen: true,
          backgroundThrottling: false
        }
      })
      global.__sakuraOwner = window.webContents.id
      require(path.join(output, 'ipc.cjs')).registerSakuraIpc()
      ipcMain.handle('turn-auth:status', () => {
        turnStatusCalls++
        return { authorized: false, expiresAt: null, pendingRevocation: false, message: null }
      })
      await window.loadFile(path.join(output, 'panel.html'))
      const js = (script) => window.webContents.executeJavaScript(script)
      const call = (method, ...args) =>
        js(`window.bpAPI.sakura.${method}(...${JSON.stringify(args)})`)
      const until = async (script, label) => {
        const deadline = Date.now() + 8000
        while (Date.now() < deadline) {
          if (await js(script)) return
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        const diagnostic = await js(
          'JSON.stringify({lifecycle:window.testHost?.getRoomState().lifecycle,error:window.testHost?.getRoomState().error,transport:window.testHost?.getRoomState().transport,network:window.testNetwork?.getSnapshot()})'
        )
        throw new Error(label + ': ' + diagnostic)
      }
      const click = (label) =>
        js(
          `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}).click()`
        )
      const setInput = async (label, value) => {
        await js(
          `(()=>{const e=document.querySelector('input[aria-label="${label}"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`
        )
        await new Promise((resolve) => setTimeout(resolve, 40))
      }
      const mode = async (value) => {
        await js(
          `(()=>{const e=document.querySelector('select[aria-label="连接模式"]');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}))})()`
        )
        await until(
          `window.testNetwork.getSnapshot().settings.mode===${JSON.stringify(value)} && !window.testNetwork.getSnapshot().busy`,
          'mode save'
        )
      }
      const open = async () => {
        window.webContents.send('turn-auth:open')
        await until('!!document.querySelector("dialog[open]")', 'network dialog did not open')
      }
      const close = () => js('document.querySelector("button[aria-label=关闭]").click()')
      await until('window.testNetwork?.getSnapshot().ready', 'settings hydration')
      assert.equal(
        await js(
          '"chooseExecutable" in window.bpAPI.sakura || "tunnels" in window.bpAPI.sakura || "clearToken" in window.bpAPI.sakura'
        ),
        false
      )
      assert.equal((await call('status')).service, 'stopped')
      assert.equal(await js('!!document.querySelector("dialog")'), false)
      if (readPhase) {
        const settings = await call('settings')
        assert.equal(settings.mode, 'sakura')
        assert.equal(settings.publicUrl, 'wss://test.example:1234/bp')
        assert.equal(await js('window.testHost.getRoomState().transport'), 'sakura')
        await open()
        await until('!!document.querySelector(".sakura-settings")', 'restored Sakura UI')
        assert.equal(turnStatusCalls, 0)
        console.log(
          'PASS process restart restores mode/port/address without starting a listener or requesting TURN'
        )
        app.quit()
        return
      }
      assert.deepEqual(await call('settings'), { mode: 'webrtc', publicUrl: '', localPort: 18787 })
      await assert.rejects(call('startService'), /樱花穿透模式/)
      await open()
      await until(
        '!!document.querySelector("#turn-password") && !document.querySelector("select").disabled',
        'legacy TURN UI'
      )
      await mode('sakura')
      const baselineTurnCalls = turnStatusCalls
      await setInput('本地 BP 服务端口', String(localPort))
      await setInput('樱花公网连接地址', 'https://test.example:1234')
      await click('保存网络配置')
      await until(
        `window.testNetwork.getSnapshot().settings.localPort===${localPort} && !window.testNetwork.getSnapshot().busy`,
        'config persisted'
      )
      assert.deepEqual(
        Object.keys(
          JSON.parse(fs.readFileSync(path.join(dataDir, 'sakura/network.json'), 'utf8'))
        ).sort(),
        ['localPort', 'mode', 'publicUrl']
      )
      await click('启动本地服务')
      await until(
        'document.body.textContent.includes("WSS 验证通过")',
        'fixture probe verification'
      )
      assert.equal((await call('status')).roomId, null, 'service alone must not create a BP room')
      const health = await new Promise((resolve, reject) =>
        require('node:http')
          .get(`http://127.0.0.1:${localPort}/health`, (response) => {
            let body = ''
            response.on('data', (chunk) => (body += chunk))
            response.on('end', () => resolve(JSON.parse(body)))
          })
          .on('error', reject)
      )
      assert.equal(health.service, 'xqb-sakura-bp')
      await new Promise((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${localPort}/bp`, {
          origin: 'https://bp.xqbbp.dpdns.org'
        })
        socket.on('open', () =>
          socket.send(
            JSON.stringify({
              type: 'SAKURA_JOIN',
              version: 'sakura-ws/1',
              protocolVersion: '1.2.1',
              roomId: 'unused'
            })
          )
        )
        socket.on('message', (data) => {
          try {
            assert.ok(data.toString().includes('ROOM_NOT_FOUND'))
            socket.close()
            resolve()
          } catch (error) {
            reject(error)
          }
        })
        socket.on('error', reject)
      })
      await close()
      await click('启动樱花房间')
      await until('window.testHost.getRoomState().lifecycle==="active"', 'BP room creation')
      const room = await call('status')
      assert.ok(room.invitationLink.includes('#sakura='))
      assert.ok(!room.invitationLink.includes('127.0.0.1'))
      await open()
      assert.equal(await js('document.querySelector("select").disabled'), true)
      await assert.rejects(
        call('configure', { mode: 'webrtc', localPort, publicUrl: '' }),
        /先关闭/
      )
      await assert.rejects(call('stopService'), /先关闭/)
      await js(
        'window.testNetwork.configure({...window.testNetwork.getSnapshot().settings,mode:"webrtc"})'
      )
      assert.equal(await js('window.testHost.getRoomState().transport'), 'sakura')
      assert.equal(await js('window.testHost.getRoomState().lifecycle'), 'active')
      probeFailure = true
      assert.equal((await call('verify')).publicConnection, 'failed')
      await until('document.body.textContent.includes("连接失败")', 'failed public status')
      probeFailure = false
      assert.equal((await call('verify')).publicConnection, 'verified')
      assert.equal(turnStatusCalls, baselineTurnCalls)
      await close()
      await click('关闭房间')
      await until('window.testHost.getRoomState().lifecycle==="idle"', 'room close')
      assert.equal((await call('status')).service, 'stopped')
      await open()
      await click('启动本地服务')
      await until('document.body.textContent.includes("监听中")', 'standalone start')
      await mode('webrtc')
      assert.equal((await call('status')).service, 'stopped')
      await until(
        '!!document.querySelector("#turn-password") && !document.querySelector("select").disabled',
        'TURN restored'
      )
      await close()
      await click('创建远程 BP')
      await until('window.testHost.getRoomState().lifecycle==="active"', 'WebRTC fixture room')
      await open()
      assert.equal(await js('document.querySelector("select").disabled'), true)
      assert.equal((await call('status')).service, 'stopped')
      await close()
      await click('关闭房间')
      await until('window.testHost.getRoomState().lifecycle==="idle"', 'WebRTC fixture close')
      await open()
      await mode('sakura')
      await click('启动本地服务')
      await until('document.body.textContent.includes("WSS 验证通过")', 'service before reload')
      fs.writeFileSync(
        path.join(output, 'network-settings.png'),
        (await window.webContents.capturePage()).toPNG()
      )
      const other = new BrowserWindow({
        show: false,
        webPreferences: { preload: path.join(output, 'preload.cjs'), contextIsolation: true }
      })
      await other.loadURL('about:blank')
      assert.equal(
        await other.webContents.executeJavaScript(
          'window.bpAPI.sakura.settings().then(()=>false,()=>true)'
        ),
        true
      )
      other.destroy()
      await window.loadFile(path.join(output, 'panel.html'))
      await until('window.testNetwork?.getSnapshot().ready', 'reload settings')
      assert.equal((await call('status')).service, 'stopped')
      assert.equal(await js('window.testHost.getRoomState().transport'), 'sakura')
      console.log(
        'PASS real Electron global network dialog, mode guards, local listener, public probe failure/recovery (loopback fixture), persistence, owner-only IPC, reload cleanup; no frpc or provider API'
      )
      app.quit()
    })
    .catch((error) => {
      console.error(error)
      app.exit(1)
    })
}
