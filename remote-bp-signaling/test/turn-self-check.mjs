import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions, Response as MFResponse } from 'miniflare';
import { AUTH_SECONDS, checkPassword, signToken, verifyToken, issueTurnCredentials } from '../src/turn.mjs';

// Synthetic secrets and reserved .test endpoints only. No real WTN calls are made.
const env = { TURN_ACCESS_PASSWORD: 'mock-password', TURN_AUTH_SIGNING_KEY: 'mock-signing-key-at-least-32-characters', WTN_APP_ID: 'test-app', WTN_APP_KEY: 'mock-app-key' };
const claims = { sub: randomUUID(), jti: randomUUID(), iat: Math.floor(Date.now()/1000), aud: 'xqb-bp-turn-host' };
claims.exp = claims.iat + AUTH_SECONDS;
const token = await signToken(env.TURN_AUTH_SIGNING_KEY, claims);
await checkPassword(env, env.TURN_ACCESS_PASSWORD);
await assert.rejects(checkPassword(env, 'wrong'), /TURN_PASSWORD_INVALID/);
await assert.rejects(checkPassword({}, 'wrong'), /TURN_AUTH_NOT_CONFIGURED/);
assert.deepEqual(await verifyToken(env, token), claims);
await assert.rejects(verifyToken(env, token + 'x'), /TURN_TOKEN_INVALID/);
await assert.rejects(verifyToken(env, await signToken('different-signing-key', claims)), /TURN_TOKEN_INVALID/);
await assert.rejects(verifyToken(env, await signToken(env.TURN_AUTH_SIGNING_KEY, { ...claims, iat: claims.iat-AUTH_SECONDS-10, exp: claims.iat-10 })), /TURN_AUTH_EXPIRED/);
let permission = true, providerCalls = 0;
const mockEnv = { ...env, TURN_AUTH: { idFromName: x => x, get: () => ({ valid: async () => permission, rate: async () => true }) } };
const grant = () => ({ ...claims, expiresAt: claims.exp*1000, requestTimes: [], cache: {} });
const providerData = ttl => ({ code: 200, ttl, ice_servers: [ { urls: ['stun:ignored.example.test', 'turn:relay.example.test:3478?transport=udp', 'turns:relay.example.test:5349?transport=tcp'], username: 'mock-user', credential: 'mock-credential' } ] });
function checkProvider(url, authorization) {
  assert.equal(url.origin, 'https://wtn.volcvideo.com');
  assert.equal(url.pathname, '/turn/test-app');
  assert.equal(url.searchParams.get('TTL'), '3600');
  const [header, payload, signature] = authorization.slice(7).split('.');
  assert.equal(signature, createHmac('sha256', env.WTN_APP_KEY).update(`${header}.${payload}`).digest('base64url'));
  assert.deepEqual(Object.keys(JSON.parse(Buffer.from(payload, 'base64url'))).sort(), ['appID','exp','version']);
  assert.equal(JSON.parse(Buffer.from(payload, 'base64url')).version, '1.0');
}
const provider = async (url, options) => { providerCalls++; checkProvider(url, options.headers.Authorization); return Response.json(providerData(3600)); };
const g = grant();
await assert.rejects(issueTurnCredentials(mockEnv, null, 'peer', provider), /TURN_NOT_AUTHORIZED/);
await assert.rejects(issueTurnCredentials({ ...mockEnv, WTN_APP_KEY: '' }, g, 'peer', provider), /TURN_NOT_CONFIGURED/);
const credentials = await issueTurnCredentials(mockEnv, g, 'peer', provider);
assert.equal(credentials.iceServers[0].urls.length, 2);
assert.deepEqual(await issueTurnCredentials(mockEnv, g, 'peer', provider), credentials);
assert.equal(providerCalls, 1);
for (const [reply, error] of [
  [() => new Response('', { status: 403 }), 'TURN_PROVIDER_DENIED'],
  [() => new Response('', { status: 503 }), 'TURN_PROVIDER_HTTP'],
  [() => new Response('', { status: 302, headers: { Location: 'https://untrusted.example.test' } }), 'TURN_PROVIDER_HTTP'],
  [() => Response.json({ code: 403 }), 'TURN_PROVIDER_CODE'],
  [() => Response.json(providerData(90000)), 'TURN_PROVIDER_INVALID'],
  [() => Response.json({ code: 200, ttl: 3600, ice_servers: [{urls:'https://evil.test',username:'u',credential:'c'}] }), 'TURN_PROVIDER_INVALID'],
  [() => new Response('bad json'), 'TURN_PROVIDER_INVALID'],
  [() => { throw new Error('network'); }, 'TURN_UNAVAILABLE'],
]) await assert.rejects(issueTurnCredentials(mockEnv, grant(), 'peer', reply), new RegExp(error));
await assert.rejects(issueTurnCredentials(mockEnv, grant(), 'peer', async () => { permission=false; return Response.json(providerData(3600)); }), /TURN_NOT_AUTHORIZED/);
permission=true;
for (let n=0;n<3;n++) await issueTurnCredentials(mockEnv, g, `peer-${n}`, provider);
await assert.rejects(issueTurnCredentials(mockEnv, g, 'over-budget', provider), /TURN_RATE_LIMITED/);
console.log('PASS password, HS256 signature, expiry, missing secrets, WTN HTTP/code/TTL/schema validation, cache, rate limit and in-flight revocation');

const compiled = await build({ entryPoints: [new URL('../src/index.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')], bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:workers'], target: 'es2022' });
const persistence = mkdtempSync(join(tmpdir(), 'xqb-turn-do-test-'));
let mode = 'ok', calls = 0, releaseProvider, enteredProvider;
const options = {
  modules: [{ type: 'ESModule', path: 'worker.mjs', contents: compiled.outputFiles[0].text }], compatibilityDate: '2026-09-02',
  bindings: env, cf: false, resourcePersistencePath: persistence,
  durableObjects: { BP_ROOMS: { className: 'BpRoom', useSQLite: true }, TURN_AUTH: { className: 'TurnAuthority', useSQLite: true } },
  outboundService: async request => {
    calls++;
    try { checkProvider(new URL(request.url), request.headers.get('Authorization')); }
    catch (error) { console.error('Mock WTN request validation failed:', error.message); throw error; }
    if (mode === 'wait') { enteredProvider(); await new Promise(resolve => { releaseProvider=resolve; }); }
    if (mode === 'denied') return new MFResponse('', { status: 403 });
    return MFResponse.json(providerData(3600));
  },
};
let mf = new Miniflare(convertV4MiniflareOptions(options));
const sockets = [];
async function http(path, body, bearer, ip='192.0.2.1') {
  const result = await mf.dispatchFetch(`https://signal.test/turn/${path}`, { method:'POST', headers: { 'Content-Type':'application/json', 'CF-Connecting-IP':ip, ...(bearer ? { Authorization:`Bearer ${bearer}` } : {}) }, ...(body ? { body:JSON.stringify(body) } : {}) });
  return { status: result.status, data: await result.json() };
}
async function connect(query='') {
  const result = await mf.dispatchFetch(`https://signal.test/${query}`, { headers: { Upgrade:'websocket' } });
  assert.equal(result.status,101);
  const socket=result.webSocket; socket.accept(); sockets.push(socket);
  const queue=[], waiters=[];
  socket.addEventListener('message', event => { const value=JSON.parse(event.data); const waiter=waiters.shift(); if(waiter) waiter(value); else queue.push(value); });
  return {
    socket,
    send(type,payload={},requestId=randomUUID()) { socket.send(JSON.stringify({type,payload,requestId})); return requestId; },
    async next(type) {
      const value=await new Promise((resolve,reject) => {
        const timer=setTimeout(()=>reject(new Error(`Timeout waiting for ${type}`)),6000);
        const done=v=>{clearTimeout(timer);resolve(v);};
        if(queue.length)done(queue.shift());else waiters.push(done);
      });
      if(type) assert.equal(value.type,type,`Expected ${type}; got ${value.type} / ${value.payload?.code ?? ''}`);
      return value;
    }
  };
}
async function room() {
  const host=await connect(); host.send('CREATE_ROOM',{ turnEnabled:true, role:'HOST' });
  const created=await host.next('ROOM_CREATED');
  const player=await connect(`?roomId=${created.payload.roomCode}`);
  player.send('JOIN_ROOM',{roomCode:created.payload.roomCode,side:'FIRST'});
  const joined=await player.next('ROOM_JOINED'); await host.next('PEER_JOINED');
  const connectionId=randomUUID();
  player.send('PEER_READY',{targetRole:'HOST',connectionId,negotiationId:0}); await host.next('PEER_READY');
  return {host,player,created,joined,request:{targetRole:'FIRST',targetSessionId:joined.payload.sessionId,connectionId}};
}
try {
  const hostId=randomUUID();
  assert.equal((await http('authorize',{hostId,password:'wrong'})).status,401);
  const login=await http('authorize',{hostId,password:env.TURN_ACCESS_PASSWORD});
  assert.equal(login.status,200); const authorization=login.data.token;
  assert.ok(Math.abs(login.data.expiresAt-Date.now()-AUTH_SECONDS*1000)<2000);
  assert.equal((await http('status',null,authorization)).status,200);
  assert.equal((await http('status',null,authorization+'x')).status,401);
  const plain=await room();
  assert.equal(plain.created.payload.turnAuthorizedUntil,null);
  plain.host.send('TURN_REQUEST',plain.request); assert.equal((await plain.host.next('ERROR')).payload.code,'TURN_NOT_AUTHORIZED');
  plain.player.send('TURN_AUTHORIZE',{token:authorization,role:'HOST'}); assert.equal((await plain.player.next('ERROR')).payload.code,'HOST_ONLY');
  plain.host.send('TURN_AUTHORIZE',{token:authorization+'x'}); assert.equal((await plain.host.next('ERROR')).payload.code,'TURN_TOKEN_INVALID');
  const expired=await signToken(env.TURN_AUTH_SIGNING_KEY,{...claims,iat:claims.iat-AUTH_SECONDS-10,exp:claims.iat-10});
  plain.host.send('TURN_AUTHORIZE',{token:expired}); assert.equal((await plain.host.next('ERROR')).payload.code,'TURN_AUTH_EXPIRED');
  assert.equal(calls,0);
  // Existing authenticated host can authorize the room without recreating BP state.
  plain.host.send('TURN_AUTHORIZE',{token:authorization});
  await plain.host.next('TURN_STATUS'); await plain.player.next('TURN_STATUS');
  plain.host.send('TURN_REQUEST',{...plain.request,targetSessionId:'forged'});
  assert.equal((await plain.host.next('ERROR')).payload.code,'STALE_SIGNAL');
  plain.player.send('TURN_REQUEST',{...plain.request,targetRole:'HOST'});
  const pc=await plain.player.next('TURN_CREDENTIALS'), hc=await plain.host.next('TURN_CREDENTIALS');
  assert.deepEqual(pc.payload,hc.payload); assert.equal(calls,1);
  assert.equal(JSON.stringify(pc).includes(env.WTN_APP_KEY),false);
  assert.equal(JSON.stringify(pc).includes(authorization),false);
  plain.host.send('TURN_REQUEST',plain.request); await plain.player.next('TURN_CREDENTIALS'); await plain.host.next('TURN_CREDENTIALS'); assert.equal(calls,1);
  const unassigned=await connect(`?roomId=${plain.created.payload.roomCode}&mode=resume`);
  unassigned.send('TURN_REQUEST',{...plain.request,role:'HOST'}); assert.equal((await unassigned.next('ERROR')).payload.code,'NOT_IN_ROOM');
  const missing=await connect('?roomId=ZZZZZZ'); missing.send('JOIN_ROOM',{roomCode:'ZZZZZZ',side:'FIRST'}); assert.equal((await missing.next('ERROR')).payload.code,'ROOM_NOT_FOUND');
  assert.equal((await http('revoke',null,authorization)).status,200);
  await plain.host.next('TURN_STATUS'); await plain.player.next('TURN_STATUS');
  plain.host.send('TURN_REQUEST',plain.request); assert.equal((await plain.host.next('ERROR')).payload.code,'TURN_NOT_AUTHORIZED');
  assert.equal((await http('status',null,authorization)).status,401);
  assert.equal(calls,1);
  console.log('PASS real Worker/DO room identity, host binding, player self-service, no-cost P2P, forged/expired/unassigned requests, cache and revoke');

  const again=await http('authorize',{hostId,password:env.TURN_ACCESS_PASSWORD});
  const auth2=again.data.token;
  plain.host.send('TURN_AUTHORIZE',{token:auth2}); await plain.host.next('TURN_STATUS'); await plain.player.next('TURN_STATUS');
  mode='wait'; const entered=new Promise(resolve=>{enteredProvider=resolve;});
  plain.host.send('TURN_REQUEST',plain.request); await entered;
  assert.equal((await http('revoke',null,auth2)).status,200);
  await plain.host.next('TURN_STATUS'); await plain.player.next('TURN_STATUS');
  releaseProvider(); assert.equal((await plain.host.next('ERROR')).payload.code,'TURN_NOT_AUTHORIZED');
  mode='ok';
  for(let i=0;i<5;i++) assert.equal((await http('authorize',{hostId:randomUUID(),password:'wrong'},null,'198.51.100.2')).status,401);
  assert.equal((await http('authorize',{hostId:randomUUID(),password:env.TURN_ACCESS_PASSWORD},null,'198.51.100.2')).status,429);
  for(let i=0;i<20;i++) { plain.player.send('TURN_REQUEST',{...plain.request,targetRole:'HOST'}); await plain.player.next('ERROR'); }
  plain.player.send('TURN_REQUEST',{...plain.request,targetRole:'HOST'}); assert.equal((await plain.player.next('ERROR')).payload.code,'TURN_RATE_LIMITED');
  const retained=await http('authorize',{hostId:randomUUID(),password:env.TURN_ACCESS_PASSWORD},null,'203.0.113.3');
  for(const socket of sockets)socket.close();
  await mf.dispose(); mf=new Miniflare(convertV4MiniflareOptions(options));
  assert.equal((await http('status',null,retained.data.token)).status,200);
  assert.equal((await http('status',null,authorization)).status,401);
  assert.equal((await http('authorize',{hostId:randomUUID(),password:'wrong'},null,'198.51.100.2')).status,429);
  console.log('PASS revoke during provider request, persistent password/credential throttles and valid/revoked tokens across Worker restart');
  await mf.dispose(); mf=new Miniflare(convertV4MiniflareOptions({...options,bindings:{...env,WTN_APP_KEY:''}}));
  const noKey=await room(); noKey.host.send('TURN_AUTHORIZE',{token:retained.data.token}); await noKey.host.next('TURN_STATUS'); await noKey.player.next('TURN_STATUS');
  noKey.host.send('TURN_REQUEST',noKey.request); assert.equal((await noKey.host.next('ERROR')).payload.code,'TURN_NOT_CONFIGURED');
  console.log('PASS missing AppKey reports a clear error without inventing credentials');
} finally {
  for(const socket of sockets)try{socket.close();}catch{}
  await mf.dispose();
}
