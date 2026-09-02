# Cloudflare 公网信令服务

该目录把现有 Remote BP 信令协议部署为 Cloudflare Worker。每个六位 `roomId` 对应一个 SQLite-backed `BpRoom` Durable Object；连接通过 WebSocket Hibernation API 保持，空闲时不需要让对象常驻内存。

要求 Node.js 22 或更高版本（当前 Wrangler 4 的运行要求）。

信令服务只管理 HOST/FIRST/SECOND 槽位并转发 WebRTC SDP 与 ICE candidate。BAN、PICK、PROTECT、BORROW、`RemoteBpState`、资源清单及图片分片仍只经过 WebRTC DataChannel。

## 本地检查

```bash
cd remote-bp-signaling
npm install
npm run typecheck
npm test
```

`npm test` 会启动本地 Wrangler runtime，验证创建房间、先后手加入、重复身份拒绝、OFFER/ANSWER/ICE 转发、断开释放槽位以及房主离开后关闭房间。

## 部署

```bash
cd remote-bp-signaling
npm install
npx wrangler login
npx wrangler deploy
```

Cloudflare 自动部署设置：

```text
Root directory: remote-bp-signaling
Build command: npm install
Deploy command: npx wrangler deploy
```

Wrangler 配置会创建 `xqb-bp-signaling` Worker、`BpRoom` Durable Object 和自定义域 `signal.xqbbp.dpdns.org`。该域必须位于执行部署的 Cloudflare 账号所管理的有效 Zone 中；Custom Domain 会由 Cloudflare 创建 DNS 记录和证书。如果同名 CNAME 已存在，应先移除冲突记录。

部署后访问 `/health` 应返回包含 `"service":"xqb-bp-signaling"` 的 JSON；如果仍返回占位文本，应先在 Workers & Pages 中解除该 Custom Domain 与旧 Worker 的绑定，再重新部署。

公网地址：

```text
wss://signal.xqbbp.dpdns.org
```

健康检查：

```text
https://signal.xqbbp.dpdns.org/health
```

房主连接基础地址，由 Worker 生成房间码；选手连接时使用 `?roomId=ABCDEFG` 定位相同 Durable Object。WebSocket 内的 `CREATE_ROOM`、`JOIN_ROOM`、`OFFER`、`ANSWER` 与 `ICE_CANDIDATE` 消息格式保持不变。

网页发布地址为 `https://xqbbp.dpdns.org`。生产构建默认使用公网 WSS；本地开发默认使用 `ws://localhost:8787`，也可以在 `.env.local` 中通过 `VITE_REMOTE_BP_SIGNALING_URL` 显式覆盖。

原 Node.js 本地信令服务仍可通过 `npm start` 启动，并使用 `npm run test:local` 自检。
