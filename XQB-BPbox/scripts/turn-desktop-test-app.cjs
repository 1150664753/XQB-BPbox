const { app, safeStorage, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const directory = process.env.XQB_TURN_TEST_DIRECTORY
app.setPath('userData', path.join(directory, 'user-data'))
app
  .whenReady()
  .then(async () => {
    const { TurnAuthStore } = require(path.join(directory, 'store.cjs'))
    const store = new TurnAuthStore(path.join(directory, 'auth.bin'), safeStorage)
    assert.ok(safeStorage.isEncryptionAvailable(), 'OS encryption must be available for this test')
    if (process.env.XQB_TURN_TEST_PHASE === 'write') {
      store.write({
        hostId: '11111111-1111-4111-8111-111111111111',
        token: 'MOCK_SECRET_TOKEN_FOR_PERSISTENCE_TEST',
        expiresAt: Date.now() + 604800000,
        pendingRevocation: false
      })
      assert.ok(!fs.readFileSync(path.join(directory, 'auth.bin')).includes('MOCK_SECRET_TOKEN'))
      console.log('PASS OS-encrypted token saved without plaintext')
      app.quit()
      return
    }
    const saved = store.read()
    assert.equal(saved.token, 'MOCK_SECRET_TOKEN_FOR_PERSISTENCE_TEST')
    assert.ok(saved.expiresAt > Date.now())
    store.write({ ...saved, pendingRevocation: true })
    assert.equal(
      new TurnAuthStore(path.join(directory, 'auth.bin'), safeStorage).read().pendingRevocation,
      true
    )
    assert.throws(
      () =>
        new TurnAuthStore(path.join(directory, 'auth.bin'), {
          isEncryptionAvailable: () => false
        }).read(),
      /安全存储/
    )
    console.log(
      'PASS OS-encrypted token restored after process restart; pending revoke is durable; no plaintext fallback'
    )
    let offline = false,
      remoteRevoked = false
    global.fetch = async (url, options) => {
      assert.equal(new URL(url).origin, 'https://signal.xqbbp.dpdns.org')
      if (offline) throw new Error('mock network offline')
      if (url.pathname === '/turn/authorize') {
        const body = JSON.parse(options.body)
        if (body.password !== 'mock-correct')
          return Response.json({ error: 'TURN_PASSWORD_INVALID' }, { status: 401 })
        remoteRevoked = false
        return Response.json({ token: 'MOCK_IPC_SIGNED_TOKEN', expiresAt: Date.now() + 604800000 })
      }
      assert.equal(options.headers.Authorization, 'Bearer MOCK_IPC_SIGNED_TOKEN')
      if (url.pathname === '/turn/revoke') {
        remoteRevoked = true
        return Response.json({ revoked: true })
      }
      return remoteRevoked
        ? Response.json({ error: 'TURN_TOKEN_INVALID' }, { status: 401 })
        : Response.json({ authorized: true, providerConfigured: true })
    }
    const window = new BrowserWindow({
      show: false,
      width: 960,
      height: 720,
      webPreferences: {
        preload: path.join(directory, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        offscreen: true,
        backgroundThrottling: false
      }
    })
    global.__XqbTurnTestWindowId = window.webContents.id
    require(path.join(directory, 'ipc.cjs')).registerTurnAuthIpc()
    await window.loadFile(path.join(directory, 'dialog.html'))
    const poll = async (script) => {
      const until = Date.now() + 5000
      while (Date.now() < until) {
        if (await window.webContents.executeJavaScript(script)) return
        await new Promise((r) => setTimeout(r, 30))
      }
      throw new Error('Dialog UI assertion timed out')
    }
    await poll('Boolean(window.bpAPI?.turnAuth)')
    // Wait for React's effect to subscribe, then deliver the same main-process shortcut event.
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(
      await window.webContents.executeJavaScript('Boolean(document.querySelector("dialog"))'),
      false
    )
    window.webContents.send('turn-auth:open')
    await poll(
      'Boolean(document.querySelector("dialog[open]")) && !document.querySelector("input").disabled'
    )
    async function submit(password) {
      await window.webContents.executeJavaScript(
        `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(document.querySelector('input'),${JSON.stringify(password)}); document.querySelector('input').dispatchEvent(new Event('input',{bubbles:true}));`
      )
      await new Promise((resolve) => setTimeout(resolve, 30))
      await window.webContents.executeJavaScript(`document.querySelector('form').requestSubmit()`)
    }
    await submit('mock-wrong')
    await poll('document.body.textContent.includes("授权密码错误")')
    assert.equal(
      await window.webContents.executeJavaScript('document.querySelector("input").value'),
      ''
    )
    await submit('mock-correct')
    await poll('document.body.textContent.includes("授权成功")')
    assert.equal(
      await window.webContents.executeJavaScript(
        `window.bpAPI.turnAuth.binding('wss://untrusted.example.test')`
      ),
      null
    )
    assert.equal(
      await window.webContents.executeJavaScript(
        `window.bpAPI.turnAuth.binding('wss://signal.xqbbp.dpdns.org').then(value=>Boolean(value))`
      ),
      true
    )
    assert.ok(
      !fs
        .readFileSync(path.join(app.getPath('userData'), 'turn-authorization.bin'))
        .includes('MOCK_IPC_SIGNED_TOKEN')
    )
    await new Promise((resolve) => setTimeout(resolve, 200))
    const screenshot = await window.webContents.capturePage()
    fs.writeFileSync(path.join(directory, 'authorization-dialog.png'), screenshot.toPNG())
    offline = true
    await window.webContents.executeJavaScript(
      `[...document.querySelectorAll('button')].find(b=>b.textContent==='退出授权').click()`
    )
    await poll('document.body.textContent.includes("服务器撤销尚未确认")')
    assert.equal(
      await window.webContents.executeJavaScript(
        `window.bpAPI.turnAuth.binding('wss://signal.xqbbp.dpdns.org')`
      ),
      null
    )
    offline = false
    const state = await window.webContents.executeJavaScript('window.bpAPI.turnAuth.status()')
    assert.equal(state.pendingRevocation, false)
    assert.equal(state.authorized, false)
    assert.equal(remoteRevoked, true)
    console.log(
      'PASS hidden dialog + actual main IPC, masked/cleared password, mock HTTPS verification, origin binding, encrypted persistence and offline revoke retry'
    )
    window.destroy()
    app.quit()
  })
  .catch((error) => {
    console.error(error.message)
    app.exit(1)
  })
