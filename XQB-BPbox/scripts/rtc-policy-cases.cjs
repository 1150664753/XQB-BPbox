/* Connection policy tests use a fake clock; no paid TURN credentials or network calls. */
module.exports = async function policyChecks(h) {
  const {
    assert,
    session,
    tick,
    flush,
    signal,
    description,
    selectedStats,
    turnFixture,
    deferred,
    emit,
    Channel,
    Peer,
    Socket,
    WebRtcRemoteHostTransport,
    WebRtcRemoteBpConnection,
    run,
    logs
  } = h
  const answer = (s, generation = 1, mode = 'p2p') =>
    s.rtc.receive(
      'ANSWER',
      signal(s.rtc.connectionId, generation, {
        description: description('answer', `remote-${generation}`),
        connectionMode: mode
      })
    )
  const connect = async (s, generation = 1, mode = 'p2p') => {
    await answer(s, generation, mode)
    s.pc.network('connected')
    s.pc.channel.open()
    await flush()
  }
  const withTcp = () => ({
    ...turnFixture(),
    iceServers: [
      {
        ...turnFixture().iceServers[0],
        urls: ['turn:relay.test?transport=udp', 'turn:relay.test?transport=tcp']
      }
    ]
  })

  await run(
    'initial STUN only; healthy ICE without control channel still falls back at exactly 5 seconds',
    async () => {
      let calls = 0
      const s = session(true, 'deadline', {
        canUseTurn: () => true,
        fetchTurn: async () => {
          calls++
          return withTcp()
        }
      })
      await s.rtc.start()
      await answer(s)
      s.pc.network('connected')
      assert.equal(s.pc.config.iceTransportPolicy, 'all')
      assert.ok(s.pc.config.iceServers.every((server) => !JSON.stringify(server).includes('turn:')))
      await tick(4999)
      assert.equal(calls, 0)
      await tick(1)
      assert.equal(calls, 1)
      assert.equal(s.pc.config.iceTransportPolicy, 'relay')
      assert.equal(s.pc.offers.length, 2)
      assert.deepEqual(s.pc.config.iceServers[0].urls, ['turn:relay.test?transport=udp'])
      await tick(3000)
      assert.equal(s.pc.offers.length, 3)
      assert.ok(s.pc.config.iceServers[0].urls.some((url) => url.includes('tcp')))
      assert.equal(s.pc.config.iceTransportPolicy, 'relay')
    }
  )
  await run(
    'no authorization: no TURN request, no disconnect or restart at five seconds',
    async () => {
      let calls = 0
      const s = session(true, 'no-grant', {
        canUseTurn: () => false,
        fetchTurn: async () => {
          calls++
          return turnFixture()
        }
      })
      await s.rtc.start()
      await tick(10_000)
      assert.equal(calls, 0)
      assert.equal(s.pc.offers.length, 1)
      assert.notEqual(s.rtc.phase, 'failed')
      await connect(s)
      assert.equal(s.rtc.selectedMode, 'p2p')
    }
  )
  await run('control open wins before timeout; P2P ICE restart never requests TURN', async () => {
    let calls = 0
    const s = session(true, 'p2p-lock', {
      canUseTurn: () => true,
      fetchTurn: async () => {
        calls++
        return turnFixture()
      }
    })
    await s.rtc.start()
    await tick(4999)
    await connect(s)
    const samples = s.pc.statsCalls
    await tick(60_000)
    assert.equal(calls, 0)
    assert.equal(s.pc.statsCalls, samples, 'no periodic getStats polling on a connected path')
    s.pc.network('failed')
    await flush()
    assert.equal(s.pc.offers.length, 2)
    await connect(s, 2)
    assert.equal(s.rtc.selectedMode, 'p2p')
    assert.equal(calls, 0)
    assert.equal(s.pc.config.iceTransportPolicy, 'all')
  })
  for (const cancellation of ['open', 'close', 'revoke'])
    await run(`late TURN response loses to ${cancellation}`, async () => {
      let authorized = true
      const gate = deferred()
      const s = session(true, `late-${cancellation}`, {
        canUseTurn: () => authorized,
        fetchTurn: () => gate.promise
      })
      await s.rtc.start()
      await tick(5000)
      if (cancellation === 'open') await connect(s)
      if (cancellation === 'close') s.rtc.close()
      if (cancellation === 'revoke') {
        authorized = false
        s.rtc.clearTurn('revoked')
      }
      gate.resolve(turnFixture())
      await flush()
      assert.equal(s.pc.config.iceTransportPolicy, 'all')
      assert.equal(s.pc.offers.length, 1)
      assert.equal(s.rtc.relayExpiresAt, null)
    })
  await run('credential failure continues P2P and retries with a finite backoff', async () => {
    let calls = 0
    const s = session(true, 'failure', {
      canUseTurn: () => true,
      fetchTurn: async () => {
        calls++
        return null
      }
    })
    await s.rtc.start()
    await tick(5000)
    assert.equal(s.pc.config.iceTransportPolicy, 'all')
    assert.equal(s.pc.offers.length, 1)
    assert.notEqual(s.rtc.phase, 'failed')
    await tick(30_000)
    assert.equal(calls, 3)
    await connect(s)
    await tick(60_000)
    assert.equal(calls, 3)
  })
  await run('rejected relay configuration preserves P2P and can retry credentials', async () => {
    const s = session(true, 'invalid-config', {
      canUseTurn: () => true,
      fetchTurn: async () => turnFixture()
    })
    const configure = s.pc.setConfiguration.bind(s.pc)
    let rejectRelay = true
    s.pc.setConfiguration = (config) => {
      if (rejectRelay && config.iceTransportPolicy === 'relay')
        throw new Error('invalid native RTCConfiguration')
      configure(config)
    }
    await s.rtc.start()
    await tick(5000)
    assert.equal(s.rtc.connectionMode, 'p2p')
    assert.equal(s.pc.config.iceTransportPolicy, 'all')
    assert.equal(s.pc.offers.length, 1)
    assert.notEqual(s.rtc.phase, 'failed')
    rejectRelay = false
    await tick(10_000)
    assert.equal(s.pc.config.iceTransportPolicy, 'relay')
    assert.equal(s.pc.offers.length, 2)
  })
  await run(
    'grant arriving after deadline triggers fallback only while still connecting',
    async () => {
      let authorized = false,
        calls = 0
      const s = session(true, 'late-grant', {
        canUseTurn: () => authorized,
        fetchTurn: async () => {
          calls++
          return turnFixture()
        }
      })
      await s.rtc.start()
      await tick(6000)
      authorized = true
      s.rtc.authorizationChanged()
      await flush()
      assert.equal(calls, 1)
      assert.equal(s.pc.config.iceTransportPolicy, 'relay')
    }
  )
  await run(
    'both peers install relay before restarted SDP; keep mode through recovery and use actual TCP label',
    async () => {
      let player
      const host = session(true, 'both', {
        canUseTurn: () => true,
        fetchTurn: async () => {
          const payload = withTcp()
          player.rtc.stageTurn(payload)
          return payload
        },
        send: (type, payload) => {
          queueMicrotask(() => void player.rtc.receive(type, payload))
          return true
        }
      })
      player = session(false, 'both', {
        send: (type, payload) => {
          queueMicrotask(() => void host.rtc.receive(type, payload))
          return true
        }
      })
      await host.rtc.start()
      await tick(5000)
      for (const s of [host, player]) {
        assert.equal(s.pc.config.iceTransportPolicy, 'relay')
        assert.equal(s.rtc.connectionMode, 'turn')
        s.pc.getStats = async () => selectedStats()
        s.pc.network('connected')
      }
      const playerChannel = new Channel()
      emit(player.pc, 'datachannel', { channel: playerChannel })
      host.pc.channel.open()
      playerChannel.open()
      await flush()
      assert.equal(host.rtc.path, 'turn-udp')
      assert.equal(player.rtc.path, 'turn-udp')
      assert.equal(host.rtc.phase, 'connected')
      assert.equal(player.rtc.phase, 'connected')
      const offers = host.pc.offers.length
      host.pc.network('disconnected')
      await tick(2000)
      host.pc.network('connected')
      await tick(2000)
      assert.equal(
        host.pc.offers.length,
        offers,
        'successful UDP must cancel the TCP timeout restart'
      )
      host.pc.getStats = async () => {
        const stats = selectedStats()
        stats.get('local').relayProtocol = 'tcp'
        return stats
      }
      host.pc.network('failed')
      await flush()
      host.pc.network('connected')
      await flush()
      assert.equal(host.rtc.path, 'turn-tcp')
      assert.equal(host.rtc.selectedMode, 'turn')
      assert.equal(player.rtc.selectedMode, 'turn')
      host.rtc.clearTurn('revoked')
      assert.equal(host.rtc.phase, 'failed')
      assert.equal(host.pc.config.iceTransportPolicy, 'relay')
    }
  )
  await run(
    'player that already opened P2P rejects a racing fallback offer without switching mode',
    async () => {
      const s = session(false, 'race')
      await s.rtc.receive(
        'OFFER',
        signal('race', 1, { description: description('offer', 'remote-1') })
      )
      const channel = new Channel()
      emit(s.pc, 'datachannel', { channel })
      s.pc.network('connected')
      channel.open()
      s.rtc.stageTurn(turnFixture())
      await s.rtc.receive(
        'OFFER',
        signal('race', 2, { description: description('offer', 'remote-2'), connectionMode: 'turn' })
      )
      assert.equal(s.rtc.selectedMode, 'p2p')
      assert.equal(s.pc.config.iceTransportPolicy, 'all')
      assert.equal(s.pc.remoteCalls, 1)
      assert.equal(s.sent.at(-1).type, 'ICE_RESTART_REQUEST')
      assert.equal(s.sent.at(-1).payload.connectionMode, 'p2p')
    }
  )
  await run(
    'replacement PCs preserve selected mode; TURN resume without grant fails closed',
    async () => {
      const direct = session(true, 'resume-direct', {
        resumeMode: 'p2p',
        canUseTurn: () => true,
        fetchTurn: async () => {
          throw new Error('must not request')
        }
      })
      await direct.rtc.start()
      await tick(6000)
      assert.equal(direct.pc.offers.length, 1)
      const relay = session(true, 'resume-turn', {
        resumeMode: 'turn',
        canUseTurn: () => true,
        fetchTurn: async () => turnFixture()
      })
      relay.pc.getStats = async () => selectedStats()
      await relay.rtc.start()
      await connect(relay, 1, 'turn')
      assert.equal(relay.rtc.phase, 'connected')
      assert.equal(relay.pc.config.iceTransportPolicy, 'relay')
      const denied = session(true, 'resume-denied', { resumeMode: 'turn', canUseTurn: () => false })
      await denied.rtc.start()
      assert.equal(denied.rtc.phase, 'failed')
      assert.equal(denied.pc.offers.length, 0)
      assert.equal(denied.pc.config.iceTransportPolicy, 'relay')
    }
  )
  await run('host preserves the player P2P success that raced its TURN offer', async () => {
    let player
    const host = session(true, 'both-race', {
      canUseTurn: () => true,
      fetchTurn: async () => {
        const payload = withTcp()
        player.rtc.stageTurn(payload)
        return payload
      },
      send: (type, payload) => {
        queueMicrotask(() => void player.rtc.receive(type, payload))
        return true
      }
    })
    player = session(false, 'both-race', {
      send: (type, payload) => {
        queueMicrotask(() => void host.rtc.receive(type, payload))
        return true
      }
    })
    await host.rtc.start()
    await flush()
    const channel = new Channel()
    emit(player.pc, 'datachannel', { channel })
    player.pc.network('connected')
    channel.open()
    await tick(5000)
    assert.equal(
      host.pc.offers.length,
      3,
      'initial offer, fallback offer, then restored direct offer'
    )
    assert.equal(host.pc.config.iceTransportPolicy, 'all')
    assert.equal(player.pc.config.iceTransportPolicy, 'all')
    host.pc.network('connected')
    host.pc.channel.open()
    await flush()
    assert.equal(host.rtc.selectedMode, 'p2p')
    assert.equal(player.rtc.selectedMode, 'p2p')
    assert.equal(host.rtc.phase, 'connected')
    assert.equal(player.rtc.phase, 'connected')
  })
  await run(
    'queued fallback rechecks control success after an in-flight SDP operation',
    async () => {
      const s = session(true, 'queued-fallback', {
        canUseTurn: () => true,
        fetchTurn: async () => turnFixture()
      })
      await s.rtc.start()
      s.pc.remoteGate = deferred()
      const pending = answer(s)
      await tick(5000)
      assert.equal(s.pc.config.iceTransportPolicy, 'all', 'do not mutate policy during SDP')
      s.pc.channel.open()
      s.pc.remoteGate.resolve()
      await pending
      await flush()
      assert.equal(s.pc.config.iceTransportPolicy, 'all')
      assert.equal(s.pc.offers.length, 1)
      assert.equal(s.rtc.selectedMode, 'p2p')
    }
  )
  for (const mode of ['p2p', 'turn'])
    await run(`player signaling reconnect preserves ${mode} on a replacement PC`, async () => {
      const client = new WebRtcRemoteBpConnection({ signalingUrl: 'ws://test', iceServers: [] })
      const connected = client.connect({ roomId: 'ABCDEF', side: 'first', clientId: 'client' })
      await flush()
      const ws = Socket.all.at(-1)
      ws.message('ROOM_JOINED', { roomCode: 'ABCDEF', role: 'FIRST', sessionId: 'old-player' })
      await flush()
      const ready = ws.sent.find((m) => m.type === 'PEER_READY')
      const pc = Peer.all.at(-1)
      if (mode === 'turn') {
        ws.message('TURN_CREDENTIALS', {
          ...turnFixture(),
          roomId: 'ABCDEF',
          peerId: 'old-player',
          connectionId: ready.payload.connectionId
        })
        pc.getStats = async () => selectedStats()
      }
      ws.message(
        'OFFER',
        signal(ready.payload.connectionId, 1, {
          fromRole: 'HOST',
          targetSessionId: 'old-player',
          connectionMode: mode,
          description: description('offer', 'remote-1')
        })
      )
      await flush()
      const channel = new Channel()
      emit(pc, 'datachannel', { channel })
      pc.network('connected')
      channel.open()
      await connected
      ws.close(1006, 'network interrupted')
      await tick(1000)
      const nextSocket = Socket.all.at(-1)
      assert.notEqual(nextSocket, ws)
      nextSocket.message('ROOM_JOINED', {
        roomCode: 'ABCDEF',
        role: 'FIRST',
        sessionId: 'new-player'
      })
      await flush()
      const nextPc = Peer.all.at(-1)
      assert.notEqual(nextPc, pc)
      assert.equal(nextPc.config.iceTransportPolicy, mode === 'turn' ? 'relay' : 'all')
      assert.equal(nextSocket.sent.find((m) => m.type === 'PEER_READY').payload.resumeMode, mode)
      await client.disconnect()
    })
  await run(
    'old direct pair during relay restart does not preempt the TCP fallback deadline',
    async () => {
      const s = session(true, 'old-pair', {
        canUseTurn: () => true,
        fetchTurn: async () => withTcp()
      })
      await s.rtc.start()
      await tick(5000)
      await answer(s, 2, 'turn')
      s.pc.network('connected')
      s.pc.channel.open()
      await tick(2999)
      assert.notEqual(s.rtc.phase, 'failed')
      assert.notEqual(s.rtc.phase, 'connected', 'old direct pair must not count as TURN success')
      await tick(1)
      assert.equal(s.pc.offers.length, 3)
      assert.equal(s.pc.config.iceTransportPolicy, 'relay')
      s.pc.getStats = async () => selectedStats()
      await connect(s, 3, 'turn')
      assert.equal(s.rtc.phase, 'connected')
    }
  )
  await run(
    '701 is a gathering error, not a disconnect; channel closing stays bounded and secrets stay out of logs',
    async () => {
      const s = session(true, 'errors')
      await s.rtc.start()
      await connect(s)
      emit(s.pc, 'icecandidateerror', {
        errorCode: 701,
        url: 'turn:user:SECRET@relay.test',
        errorText: 'SECRET_TOKEN'
      })
      await tick(6000)
      assert.equal(s.rtc.phase, 'connected')
      assert.equal(s.pc.offers.length, 1)
      s.pc.channel.readyState = 'closing'
      emit(s.pc.channel, 'closing')
      await tick(10_000)
      assert.equal(s.rtc.phase, 'failed')
      assert.ok(!JSON.stringify(logs).includes('SECRET'))
    }
  )
  await run(
    'host credential inbox stays live and stale responses after room close cannot switch mode',
    async () => {
      const host = new WebRtcRemoteHostTransport({ signalingUrl: 'ws://test', iceServers: [] })
      const started = host.start()
      await flush()
      const ws = Socket.all.at(-1)
      ws.message('ROOM_CREATED', {
        roomCode: 'ABCDEF',
        createdAt: '2026-10-14T00:00:00Z',
        expiresAt: '9999-12-31T00:00:00Z',
        resumeToken: '0123456789abcdef',
        turnAuthorizedUntil: 100000
      })
      await started
      ws.message('PEER_JOINED', { role: 'FIRST', sessionId: 'player' })
      ws.message('PEER_READY', signal('ready', 0, { fromRole: 'FIRST', fromSessionId: 'player' }))
      await flush()
      const pc = Peer.all.at(-1)
      assert.equal(pc.offers.length, 1)
      await tick(5000)
      const request = ws.sent.find((m) => m.type === 'TURN_REQUEST')
      assert.ok(request)
      await host.stop()
      ws.message(
        'TURN_CREDENTIALS',
        { ...turnFixture(), roomId: 'ABCDEF', peerId: 'player', connectionId: 'ready' },
        request.requestId
      )
      await flush()
      assert.equal(pc.offers.length, 1)
      assert.equal(pc.config.iceTransportPolicy, 'all')
    }
  )
}
