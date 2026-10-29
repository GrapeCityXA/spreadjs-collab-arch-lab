# Developer reference: configuration and interfaces

This document is the contract every part of the lab is built against. It exists so
the CLI, the server, the browser pages, the checks and the docs can be developed
independently without drifting.

> Audience: contributors. Users only need [`../README.md`](../README.md) and
> [`01-quickstart.md`](01-quickstart.md).

## 0. Development conventions

- **ESM only** (`"type": "module"`), Node **>= 20**. Use `node:` prefixed builtins.
- Declare npm dependencies in `package.json`, update `package-lock.json`, and verify
  a fresh `npm ci` when changing them.
  The dependency set is deliberately the same packages a real SpreadJS
  collaboration deployment needs, plus `webpack` for the optional official client.
- **Windows first**: demonstrations and verification target Windows + PowerShell.
  macOS and Linux have not been verified. Keep Node code portable with `node:path`
  and `import.meta.url`; other-platform acceptance is not required for this demo.
- **Child processes must not use piped stdio.** Some sandboxed environments fail
  `spawn(..., { stdio: 'pipe' })` with `EPERM`. Use
  `{ stdio: ['ignore', fd, fd] }` with `fs.openSync(logFile, 'a')`, or `'ignore'`.
- **Never log or commit license keys.** `config/license.json` is gitignored; report
  only `SET` / `MISSING`.
- **The lab never pretends.** If a step is not verified in the current
  environment, the output says so (see `docs/04-architecture-check.md`).

## 1. Directory ownership

| Path | Owner | Contents |
|---|---|---|
| `src/lab/**`, `src/cli.mjs`, `src/web/**`, `src/checks/**`, `src/bench/**` | lead | orchestration, HTTP API, probes, reports |
| `src/server/**`, `src/lb/**` | server owner | collaboration node, mirror protocol, Redis adapter, load balancer |
| `public/**`, `webpack.official.config.cjs` | web owner | lab console, mirror client page, optional official page |
| `docs/**`, `README*.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `config/nginx.reference.conf` | docs owner | user-facing and operator-facing documentation |
| `tests/**`, `scripts/capacity.mjs` | verification owner | self-test, browser test, capacity calculator |

The owner labels above describe module responsibilities from the original development
work, not access restrictions for external contributors. Use shared helpers for
runtime `data/`, `logs/` and `.lab/` state. Start with CONTRIBUTING.md when making changes.

## 2. Effective configuration (`cfg`)

`src/lab/modes.mjs` is the single source of truth. `expandConfig()` returns:

```js
{
  mode: 'single' | 'sharded' | 'shared',
  variant: null | 'broken-sharded' | 'broken-adapter-only' | 'broken-no-adapter',
  nodes: number,              // collaboration server processes
  lb: boolean,                // put a load balancer in front
  adapter: boolean,           // inject Socket.IO Redis adapter into every node
  affinity: 'room' | 'none' | null,  // load balancer routing strategy
  store: 'local' | 'shared',  // document store: per node vs shared
  impl: 'mirror' | 'real',    // reference implementation vs official server
  presence: boolean,          // official presence feature (real only)
  requires: { redis, license, browser, sharedStore }
}
```

`expectations(cfg)` returns, per check id, one of:

| value | meaning |
|---|---|
| `pass` | this configuration promises the behaviour; a failure is a defect |
| `n/a` | this topology makes no promise either way |
| `record` | measure and report the number, pass/fail is meaningless |
| `colocated` | all members of one room must be on the same node |
| `not-required` | cross-node room traffic is not part of this topology's contract |
| `not-dangerous` | the "eventual consistency masks a broken realtime path" condition must NOT occur |

## 3. Node server (`src/server/node-server.mjs`)

**Launch**

```
node src/server/node-server.mjs --port=8081 --node-id=node-8081
```

**Environment** (all optional, resolved by `src/server/config.mjs`)

| Variable | Default | Meaning |
|---|---|---|
| `SJS_PORT` / `--port` | 8081 | listen port |
| `SJS_NODE_ID` | `node-<port>` | stable node identity reported to clients |
| `SJS_IMPL` | `mirror` unless a server key is configured, then `real` | implementation |
| `SJS_ADAPTER` | `1` | inject Socket.IO Redis adapter |
| `SJS_REDIS_URL` | `redis://127.0.0.1:6379` | Redis used by the adapter |
| `SJS_PATH` | `/collaboration/` | socket.io path (must match client + LB) |
| `SJS_OT` | `0` | mount OT shared-document services (**real only**) |
| `SJS_OT_DB` | `sqlite` | `memory` or `sqlite` (real only) |
| `SJS_OT_DB_FILE` | `data/ot.sqlite` | shared OT database file |
| `SJS_PRESENCE` | `0` | mount presence feature (**real only**) |
| `SJS_STORE` | `local` | mirror document store: `local` (per node memory) or `shared` (shared SQLite at `SJS_STORE_FILE`) |
| `SJS_STORE_FILE` | `data/lab-store.sqlite` | shared mirror store |
| `SJS_BIND_HOST` | `127.0.0.1` | listen interface |
| `SJS_LICENSE_FILE` | `config/license.json` | license file |
| `SJS_VERBOSE` | unset | debug logging |

License resolution is shared by doctor, up, web, nodes and official tests through
`resolveLicense` in `src/server/config.mjs`. Default: this project's
`config/license.json`; no parent fallback. `SJS_LICENSE_FILE` explicitly selects a
file (relative paths resolve from the project root); a missing selected file or
malformed JSON is an error. Environment keys override file fields; environment-only
configuration is accepted without a default file. SET means configured, not validated.

**Hard rules**

- `SJS_IMPL=real` without `server.serverLicenseKey` → exit code **2** with an
  explicit message. Do not silently fall back to mirror.
- `SJS_OT=1` or `SJS_PRESENCE=1` with `SJS_IMPL=mirror` → exit code **2**.
- `SJS_ADAPTER=1` but Redis unreachable → exit code **2** (bounded 5 s connect,
  `SJS_REDIS_CONNECT_TIMEOUT_MS`). Silent degradation is forbidden.
- The control HTTP plane shares the node's single HTTP server (the collaboration
  server owns the port); unmatched paths fall through to socket.io.

**Control plane** (consumed by the orchestrator, the checks and the web API)

| Endpoint | Response |
|---|---|
| `GET /health` | `{ ok, nodeId, port, pid, rssBytes, heapUsedBytes, impl, adapterEnabled, otEnabled, otDbMode, presenceEnabled, storeMode, startedAt, uptimeMs }` |
| `GET /state` | health fields + `{ clients: [{id, roomId, label, connectedAt}], rooms: [{roomId, members: [id], version}], docs: [{roomId, docId, version, cells, updatedAt}], messagesSeen, inbound: n, outbound: n }` |
| `GET /docs?room=<id>` | `{ roomId, docId, version, cells, updatedAt }` or 404 — **501 `{docsSupported:false}` in `impl=real`** |
| `POST /reset` | `{ ok: true }`, clears counters only (never document state) |
| `POST /shutdown` | `202 { ok: true, nodeId }`, then graceful close (socket.io → Redis adapter → store) and `process.exit(0)`; same path as SIGINT/SIGTERM, and it must still work when Redis is already gone |

`cells` is a flat object `{ "r,c": value }`; `docs` is capped to 50 rooms in
`/state` to keep responses small.

In `impl=real` the official OT/presence layers own the document protocol, so the
node **must not relay `m` frames** next to them (that would double-apply
operations, and `POST /shutdown` — never "fix" this into a relay). Consequences:
`/docs` answers 501 with `docsSupported: false`, `/state.docs` is `[]`, and
`storeMode` reports `shared` only when `SJS_OT=1 && SJS_OT_DB=sqlite`. The check
matrix never drives `impl=real` for exactly this reason: it measures topologies,
not the commercial OT engine.

## 4. Mirror wire protocol (zero-license reference implementation)

Transport: **socket.io**, `transports: ['websocket']`, `path` = `SJS_PATH`,
`serveClient: false`. Room id comes from the handshake query `roomId`
(fallback `SJS_ROOM`); optional `label`, `clientId`.

Application frames use socket.io event **`m`** with payload
**`[type, data, compressed]`**, identical in shape to the official protocol
(`src/server/mirror-codec.mjs`; `compressed=true` means `data` is gzip+base64 JSON,
used above 128 bytes — clients must implement the same decode).

**Client → server**

| type | data | server behaviour |
|---|---|---|
| `lab:join` | `{ label, roomId? }` | register client, reply `lab:snapshot`, broadcast `lab:presence` |
| `lab:op` | `{ opId, row, col, value, baseVersion?, ts? }` | apply to the room document, bump version, reply `lab:op-ack`, broadcast `lab:op` to the other members |
| `lab:resync` | `{}` | reply `lab:snapshot` |
| `lab:ping` | `{ t }` | reply `lab:pong` `{ t, nodeId, serverTime }` |

**Server → client**

| type | data |
|---|---|
| `sjs-node-info` | `{ kind: 'node-info', nodeId, port, adapterEnabled, impl, ot, otDb, presence, storeMode }` — pushed on connect and on `enterRoom` |
| `lab:snapshot` | `{ roomId, docId, version, cells, members: [{id, label, nodeId}], nodeId, storeMode, ts }` |
| `lab:op-ack` | `{ opId, version, ts, nodeId }` |
| `lab:op` | `{ opId, version, row, col, value, from, fromLabel, nodeId, ts }` (broadcast, `except sender`) |
| `lab:presence` | `{ members, nodeId, ts }` |
| `lab:error` | `{ code, message }` |

**Document semantics (this is the point of the mirror)**

- Per room, a document `{ docId: roomId, version, cells }`.
- `store = local` → the document lives in that node's memory. A client on another
  node sees a different document. Restart loses it.
- `store = shared` → all nodes read/write the same SQLite file
  (`SJS_STORE_FILE`, WAL, `busy_timeout`, retry on `SQLITE_BUSY`). Version is
  allocated in the database so two nodes cannot both commit version *n*.
- With `SJS_ADAPTER=1`, the live `lab:op` broadcast crosses nodes via Redis. With
  `SJS_ADAPTER=0` it never does — that asymmetry is the experiment.
- `lab:op` must be applied idempotently by clients keyed on `opId` (a reconnecting
  client may receive an op twice).

**Presence (mirror)**: `members` is the member list of the room **as known by that
node**. With several nodes and `SJS_ADAPTER=0` it is naturally partial. The check
uses this to report placement, not to judge correctness.

## 5. Load balancer (`src/lb/load-balancer.mjs`)

```
node src/lb/load-balancer.mjs --listen=3000 --host=127.0.0.1 \
  --nodes=127.0.0.1:8081,127.0.0.1:8082,127.0.0.1:8083 \
  --strategy=rr|least-conn|room-affinity
```

- Proxies plain HTTP (round-robin or least-connections) and raw WebSocket
  upgrades (`server.on('upgrade')`, `net.connect` pipe, keep the `head` buffer).
- **Room affinity**: the socket.io handshake URL carries `roomId=<room>`; when
  `--strategy=room-affinity`, `hash(roomId) % nodes` selects the upstream and the
  mapping is remembered so the same room always lands on the same node while that
  node is healthy. If the node dies, re-pin to another healthy node.
- Health: passive. On upstream error during upgrade, try the next node once.
- Introspection: `GET /healthz` → `200 ok`; `GET /__lb/state` →
  `{ ok, strategy, startedAt, upstreams: [{host, port, connections, healthy}],
     roomAssignments: {room: "host:port"}, totals: {http, upgrades} }`.
- Windows is the verified demonstration platform; macOS/Linux are unverified. No `nginx` requirement; nginx is
  only supplied as a production reference config.

## 6. Orchestrator (`src/lab/orchestrator.mjs`)

State file: `.lab/state.json` (gitignored, atomic write via tmp+rename):

```json
{
  "startedAt": 1700000000000,
  "config": { /* effective cfg (LOCAL nodes only) */ },
  "webPort": 5173,
  "lb":   { "port": 3000, "pid": 1234, "logFile": "logs/lb.log",
            "adminToken": "…", "publicUrl": "http://<bindHost>:3000" },
  "redis": { "url": "redis://127.0.0.1:6379", "owned": true, "pid": 1235 },
  "nodes": [
    { "id": "node-8081", "port": 8081, "pid": 1240, "base": "http://127.0.0.1:8081",
      "remote": false, "host": null, "logFile": "logs/node-8081.log" },
    { "id": "node-agent-h1", "port": 8081, "base": "http://10.0.0.5:8081",
      "remote": true, "host": "10.0.0.5", "agentUrl": "http://10.0.0.5:9100" }
  ],
  "remote": [{ "agentUrl": "http://10.0.0.5:9100", "lbUrl": "http://10.0.0.10:3000",
               "nodeUrl": "http://10.0.0.5:8081", "nodeId": "node-agent-h1", "host": "10.0.0.5" }],
  "agentToken": "… | null",
  "web":   { "port": 5173, "pid": 1250, "logFile": "logs/web.log" }
}
```

- `up`: validate config → ensure Redis if required → start local nodes → wait `/health`
  on every local node → start LB (with `adminToken`) → wait `/healthz` → attach every
  `--agents` entry → (optional) start web → write state.
  Any failure must roll back what was started (including detaching already-attached
  agents) and print a concrete next step.
- `up({agents, agentToken})`: `--agents` on a topology without an LB is a config error
  (there would be nothing to route clients to). `state.config.nodes` counts **local**
  nodes; total nodes = `state.nodes.length` (local + remote). Consumers that reason
  about "is this multi-node?" must use `state.nodes.length`, not `config.nodes`.
- `down({stopAgents})`: detach remote agents first (bounded, best-effort), then stop
  owned local processes only (never kill a process the lab did not start); remove state
  file; leave `data/` and `logs/` alone.
- Child processes: **detached = false**, `stdio: ['ignore', fd, fd]`, and the pid
  must be the actual node process. On Windows killing a child must use
  `taskkill /PID <pid> /T /F`; elsewhere `process.kill(-pid)` or `SIGTERM`.
- Port allocation: `config/lab.config.json` provides `lbPort`, `webPort`,
  `nodeBasePort`. If a port is occupied by a *foreign* service, fail with a clear
  message naming the port — never silently pick another port (the URL the user
  sees must match reality).
- Redis resolution order: `SJS_REDIS_URL` → `redis://127.0.0.1:<redisPort>` if it
  answers PING → `tools/redis/redis-server(.exe)` if present (`SJS_REDIS_BIN`
  overrides) → `docker run --rm -d -p <port>:6379 redis:7-alpine` → fail with
  instructions. Report which path was taken in `state.redis.mode`
  (`external|bundled|docker`).

## 7. Web server + API (`src/web/server.mjs`)

Plain `node:http` (no express). Static + JSON API, port `webPort`.

| Route | Method | Purpose |
|---|---|---|
| `/` | GET | lab console (`public/index.html`) |
| `/client/` | GET | mirror client page (`public/client/index.html`) |
| `/official/` | GET | official client page (build output, 404 with hint if absent) |
| `/vendor/socket.io.js` | GET | `node_modules/socket.io/client-dist/socket.io.min.js` |
| `/vendor/spread-sheets.js` | GET | `node_modules/@grapecity-software/spread-sheets/dist/gc.spread.sheets.all.min.js` |
| `/vendor/spread-sheets.css` | GET | `.../styles/gc.spread.sheets.excel2013white.css` |
| `/api/catalogue` | GET | `catalogue()` + `comparisonMatrix()` + environment capability + current stack |
| `/api/stack` | GET | orchestrator state + live health of each node + `remote[]` (agent hosts) |
| `/api/stack/up` | POST | `{ mode, variant, overrides, agents? }` → start; returns new state (`agents` = `["http://h1:9100"]`) |
| `/api/stack/down` | POST | stop the stack |
| `/api/check` | POST | `{ mode?, variant?, scenario? }` → `{ jobId }` (async, in-process) |
| `/api/check/:jobId` | GET | `{ status: 'running'\|'done'\|'error', progress: [...], result }` |
| `/api/bench` | POST | `{ scenario?, distribute? }` → `{ jobId }` (same job map/polling as check) |
| `/api/bench/:jobId` | GET | `{ status, stats }` |
| `/api/report/latest` | GET | `{ json, markdown, file, generatedAt }` of the newest report |
| `/api/collab-config` | GET | `{ wsUrl, path, impl, room, licenseKey, designerLicenseKey, license:{runtime,designer,server}, source }` for browser clients |
| `/api/health` | GET | `{ ok: true }` liveness for the console |
| `/shutdown` | POST | internal: `202 { ok: true }` then exit 0 (lets `npm run down` stop the console without an OS-level kill) |

- `WEB_ROOT` = `public/`, resolved from `import.meta.url`; serve with correct
  `content-type`, `no-store` for HTML/JSON, long cache for `/vendor/`.
- Vendor assets must be resolved through Node module resolution
  (`createRequire(import.meta.url).resolve(...)`), **not** a hardcoded
  `node_modules/` path, so a monorepo install also works.
- Every API error returns `{ error, detail }` with a non-2xx status and a message
  a user can act on.
- The server never exposes `server.serverLicenseKey` (server-only secret); the
  browser keys may be returned because the pages need them. Management credentials
  (`adminToken` and `agentToken`) are serialized as `SET` / `MISSING` in API and CLI
  JSON responses; the actual values remain in private runtime state for cleanup.

## 8. Check result schema (`src/checks/**`)

```jsonc
{
  "generatedAt": "2026-10-27T...",
  "labVersion": "1.0.0",
  "engine": "mirror" | "real",
  "mode": "sharded", "variant": null,
  "config": { },
  "describe": "3 节点 · 负载均衡 · 无跨节点适配器 · 亲和=room · 文档库=每节点本地",
  "expectations": {
    "nodes.health": "pass", "topology.config": "pass",
    "lb.distribution": "pass", "room.placement": "colocated",
    "realtime.sameNode": "pass", "realtime.crossNode": "not-required",
    "join.consistency": "record", "store.consistency": "record",
    "isolation.rooms": "pass", "ack.latency": "record",
    "eventual.mask": "not-dangerous"
  },
  "checks": [{
    "id": "realtime.crossNode",
    "label": "跨节点实时协同（有界时间投递）",
    "expected": "pass" | "n/a" | "record" | "colocated" | "not-required" | "not-dangerous",
    "status": "pass" | "fail" | "n/a" | "record" | "expected-failure",
    "detail": "node-8081 的编辑在 2ms 内到达 node-8082",
    "metrics": { "latencyMs": 2, "timeoutMs": 2000 },
    "advice": "…only when failing or expected-failing…"
  }],
  "summary": {
    "status": "healthy" | "degraded" | "broken" | "expected-broken",
    "headline": "一句话结论",
    "advice": ["可执行建议"],
    "failures": 0, "expectedFailures": 0
  },
  "metrics": {
    "ackMs": { "p50": 1, "p95": 2, "p99": 2, "max": 2, "samples": 10 },
    "sameNodeMs": 1, "crossNodeMs": 2,
    "join": { "writerVersion": 1, "joinerVersion": 1 },
    "store": { "perNode": [{ "nodeId": "node-8081", "version": 1, "present": true }], "versions": [1] },
    "placement": { "nodesUsed": 1, "placement": ["node-8083", "node-8083", "node-8083"] }
  },
  "topology": {
    "mode": "sharded", "variant": null, "store": "local",
    "nodes": [{ "id": "node-8081", "port": 8081, "impl": "mirror", "adapter": false, "store": "local", "clients": 0 }],
    "lb": { "port": 3000, "strategy": "room-affinity" } | null,
    "redis": { "url": "redis://127.0.0.1:6379", "mode": "external" } | null
  },
  "environment": { "node": "v24.13.0", "platform": "win32-x64", "lbStrategy": "room-affinity" },
  "files": { "json": "…/reports/check-….json", "markdown": "…/reports/check-….md", "base": "check-…" }
}
```

Rules:

- A check that cannot run in this environment is `n/a` **with the reason in
  `detail`** — never silently skipped, never counted as a pass.
- `expected-failure` is used only for a `broken-*` variant: the lab is showing the
  defect on purpose. It is still counted as a success of the lab, not of the
  architecture.
- `eventual.mask` is the headline trap: when cross-node realtime delivery fails but
  a reload/settle makes the document look consistent, the summary must say so in
  one sentence a business stakeholder understands.
- `expectations()` is per configuration; the same check id can be `pass`,
  `not-required` or `n/a` depending on the mode. For `single` the four cross-node
  checks are all `n/a`; for `sharded` `realtime.crossNode` is `not-required`;
  for `shared` it is `pass` even when the adapter is off (that is a deployment
  defect, not a different promise).
- Reports are written to `reports/check-<UTC timestamp>.{json,md}` and the newest
  is served at `/api/report/latest`.
- The console (`GET /api/check/:jobId`) streams `progress[]` entries of
  `{ id, label, status, detail }` where `status` is the **classified** status, so a
  sharded `realtime.crossNode` shows `n/a`, not `fail`.
- `npm run check` renders four columns (`状态 / 期望 / 检查项 / 说明`) and exits
  `0` healthy or expected-broken, `1` broken (or degraded with
  `--fail-on-degraded`), `2` no stack, `3` degraded.

## 9. Browser client pages

`/client/?room=<id>&label=<name>&auto=1` (mirror engine, no license needed):

- Loads `/vendor/socket.io.js`, `/vendor/spread-sheets.js` and the CSS by `<script>`
  tags (no bundler) — this is why the lab's zero-license path has no build step.
- Renders a real SpreadJS workbook, joins the room, renders the shared document
  from `lab:snapshot`, applies `lab:op` frames, sends its own edits on
  `CellChanged`, shows: room, client label, **which node served it**, document
  version, member list, and a message log.
- Exposes automation hooks (used by `tests/**` and the checks):

```js
window.__labReady      // boolean, true after bind + first snapshot
window.__labNodeId     // e.g. 'node-8082'
window.__labNodePort   // 8082
window.__labRoomId     // 'arch-lab-demo'
window.__labVersion    // number
window.__labSetCell(row, col, value)   // behaves like a user edit
window.__labGetCell(row, col)
window.__labMembers    // [{id,label,nodeId}]
```

`/official/` (optional, license): same hook names, backed by the official
`js-collaboration-client` + OT `SharedDoc` + `bind(workbook, doc)`. Built by
`npm run build:official` (webpack → `public/official/bundle.js`). If the bundle is
missing the page must say "run npm run build:official" instead of failing blank.

## 10. Independent installation

Run `npm ci` in this directory, including when it is nested in a larger workspace.
Parent dependency resolution must not substitute for a standalone installation check.
The lockfile belongs to this project. Do not copy licenses or runtime state from the
parent project into a public checkout.

## 11. Scenario: how many users, one edit every N seconds

The lab must answer "**my** scenario", not the lab's default. One vocabulary, used by
`check`, `bench`, `compare` and the console.

Internal shape (`src/lab/scenario.mjs`):

```js
{
  users: number,        // concurrent users, 1..100000
  opIntervalMs: number, // one edit per user every N ms, >= 50
  durationMs: number,   // length of the load phase, 1000..600000
  rooms: number         // spread users over N rooms, 1..users
}
```

CLI — **seconds on purpose** (people say "every 2 seconds"):

```bash
check --users=20 --interval=2 --duration=10 --rooms=1 [--max-load-clients=300]
bench --users=200 --interval=2 --duration=20 --rooms=1 [--distribute=local,http://h1:9100]
# --interval accepts a float (0.5 = twice a second); --interval-ms= is the exact alias
```

Explicit invalid inputs must fail (BAD_SCENARIO / HTTP 400); defaults apply only
when fields are omitted. Users and rooms must be integers; rooms cannot exceed users.
The console must show invalid input without clamping it or starting a job.

Defaults: `check` = `{20, 2000ms, 8000ms, 1}`; `bench` = `{50, 600ms, 20000ms, 1}`.
`check` is correctness + a short load sample; `bench` is the load test for heavy
scenarios.

Derived model (`modelScenario`, the only formula in the code base):

```
usersPerRoom     = ceil(users / rooms)            (last room can be smaller)
opsPerSecond     = users / (opIntervalMs / 1000)
fanoutPerSecond  = opsPerSecond * (usersPerRoom - 1)   // one edit fans out to the room
predictedCores   = fanoutPerSecond / 12700 * (presence ? 1.17 : 1)
```

Rules:

- `check` first runs the 11 correctness probes (small, bounded), then **one load phase**
  of `durationMs` with `min(users, maxLoadClients)` clients spread over `rooms`. If the
  client count is clamped, `detail` says so (`"<N> 个客户端（场景 <M>，按上限收敛）"` and
  `scenario.load.capped === true`); never imply the full scenario was measured when only
  part of it was. The clamp default is 300 clients (`--max-load-clients` /
  `SJS_LAB_MAX_LOAD_CLIENTS`).
- The load phase goes **through the topology entry** (the LB when the topology has one,
  otherwise the single node), i.e. the same path a browser takes.
- New 12th check `load.scenario`, expectation `record` in **every** mode: status
  `record`, `detail` carries measured p95, modelled fan-out and predicted cores. Advice
  on high p95: lower users/interval, or generate load with `--distribute` on more hosts.
- `check` job progress may emit one extra entry `{id:'load.scenario', status:'running'}`
  before the load phase finishes; it is replaced by the final `record` entry. Console
  clients must tolerate both (same `id`, the later one wins).
- Reports embed `scenario` + `scenario.load` (measured). The CLI matrix prints the
  scenario as its first line. Two reports with different scenarios are not comparable,
  and `compare` passes the same scenario to all three modes.
- A report without an explicit scenario used the defaults — and still prints them.
- Presentation rules (docs quote these strings, so they are contract): every CLI line
  starts with `[lab] `, including `bench`'s pre-run `压测：`/`目标：`/`分摊：`; `check`
  prints the scenario+model pair **once** before the run; a modelled core count below
  0.01 prints `<0.01 核` (never `0 核`); `bench --distribute` recomputes aggregate
  fan-out as `Σ_room (Σ_p ops[p][room]) × (Σ_p members[p][room] − 1)` and sets
  `fanoutBasis:'global-room-membership'` — per-participant `fanoutPerSecond` is only that
  generator's slice and must not be added up; the `多机取最差参与者` broadcast note appears
  only when there is more than one participant.
- `runLoad` reports failures as `opsFailed` (not `errors`); the controller's
  `mergeLoadStats` maps both, so merged stats carry `errors`.

## 12. Multi-machine: controller + agent hosts

Why: one machine cannot generate (or serve) a scenario with thousands of users, and
"it works on one laptop" is not evidence for a real deployment. Roles:

- **controller** — where the user runs `npm run up`: orchestrator, load balancer,
  console, Redis (or a reachable Redis), checks, reports.
- **agent host** — any other machine: one collaboration node + a load generator,
  driven over HTTP. Never starts a load balancer or Redis.

### Agent process

```bash
npm run agent -- --port=9100 --lb=http://<controller>:3000 --token=<token> --public-host=<ip-or-hostname> [--node-port=8081] [--impl=mirror|real]
```

Env equivalents: `SJS_AGENT_PORT`, `SJS_LB_URL`, `SJS_LB_ADMIN_TOKEN`,
`SJS_PUBLIC_HOST`, `SJS_AGENT_NODE_PORT`. Child processes use fd stdio, never `pipe`.
The agent starts **listening and starts its node child at launch** (so a `--node-port`
collision is a launch error); `POST /agent/attach` applies the controller's topology
config and registers the node URL — it **restarts the node when the config differs**
(stop child, start with the merged env) and reuses it when identical. The controller
passes the LB's public address, so `SJS_LAB_LB_PUBLIC_URL` (or
`--bind-host`/`SJS_LAB_BIND_HOST` reaching the LAN) must be usable from agent hosts.

`nodeConfig` (attach body) is the partial env subset
`SJS_IMPL, SJS_ADAPTER, SJS_REDIS_URL, SJS_PATH, SJS_STORE, SJS_STORE_FILE, SJS_OT,
SJS_OT_DB, SJS_OT_DB_FILE, SJS_PRESENCE`; the agent rejects `SJS_PORT`, `SJS_NODE_ID`,
`SJS_BIND_HOST` (it owns its address) and unknown keys with `400`. Without `nodeConfig`
the agent falls back to its own flags/env defaults (that path exists for manual use, not
for `up`).

Cross-host `--store=shared` is **refused** by `up`: the demo store is a SQLite file and
each host would create its own copy, i.e. `broken-adapter-only` with extra steps. Real
cross-host shared rooms need a real shared database (PostgreSQL, `docs/06-production.md`);
same-machine agent simulation (loopback URLs) is supported and shares the one file.

The node child runs under `src/remote/node-supervisor.mjs` (an ordinary child of the
agent): it polls the agent pid and kills the node if the agent disappears, so a crashed or
force-killed agent (`taskkill /T /F`, un-catchable SIGINT on Windows) releases
`--node-port` within ~1–2 s. The graceful path still deregisters from the LB first
(`/agent/shutdown`). Never replace this with a bare `spawn` — the pre-supervisor version
leaked a listening node on hard kill.

Agent HTTP (JSON; every `/agent/*` control endpoint requires `x-lab-token`):

| Endpoint | Body / result |
|---|---|
| `POST /agent/attach` | `{lbUrl, token, nodePort?, nodeConfig?}` → `{ok, nodeUrl, nodeId, restarted}` — applies `nodeConfig` (restarting the node when it differs), waits for `/health`, registers `nodeUrl` in the LB |
| `POST /agent/detach` | `{lbUrl, token}` → `{ok}` — deregisters `nodeUrl` and stops the node |
| `POST /agent/load` | `{lbUrl, path, users, opIntervalMs, durationMs, rooms, roomPrefix}` → load stats; `409 {error:'busy'}` when a load is already running |
| `POST /agent/load/cancel` | `{ok}` |
| `GET /agent/status` | `{ok, host, nodePort, node:{…/health}, load:{running, users}}` |
| `GET /health` | `{ok:true, role:'agent'}` (used by the controller's attach wait) |
| `POST /agent/shutdown` | `{ok}`, then `process.exit(0)` |

Load stats — **one implementation** shared by the local load phase, `bench --distribute`
and the agent:

```js
{ ok, users, elapsedMs, ops, opsPerSecond, fanoutPerSecond, errors,
  ackMs: { p50, p95, p99, max, samples },
  ackSamples: number[],            // capped at 500 for merging percentiles
  perNode: { [nodeId]: clients }, cancelled }
```

### Load balancer admin API

Only active when `SJS_LB_ADMIN_TOKEN` is set (started by the controller):

| Endpoint | Auth | Result |
|---|---|---|
| `POST /__lb/upstreams` `{url}` | `x-lab-token` | `{ok, upstreams:[…]}`, idempotent, probes `/health` first |
| `DELETE /__lb/upstreams?url=<url>` | `x-lab-token` | `{ok, upstreams:[…]}` |
| `GET /__lb/state` | none | unchanged (upstreams, health, pins, counters) |

No token configured → `403 {error:'admin-disabled', detail:'set SJS_LB_ADMIN_TOKEN'}`;
wrong token → `401`. An admin API that is open by default would be a remote-controlled
proxy on a public port.

### Controller behaviour

```bash
up --mode=sharded --nodes=2 --agents=http://h1:9100,http://h2:9100 [--agent-token=…]
down [--stop-agents]
status
```

- `--agents` requires a load-balanced topology (`sharded`/`shared`); `single` refuses.
- The controller generates (or accepts) one token, starts the LB with it, attaches every
  agent, records `state.remote[{agentUrl, nodeUrl, nodeId, host}]`. A failed attach
  fails `up` with exit 2 and an actionable message.
- Total nodes = local nodes + remote nodes. `status` and the topology diagram mark which
  node runs on which host.
- `down` detaches every agent (its node stops) but leaves the agent process alive for
  reuse; `down --stop-agents` also POSTs `/agent/shutdown`.
- An unreachable agent is bounded at 10 s and reported as a warning
  (`! agent <host> 未能摘除：<reason>`), the other agents are still detached, local
  processes are still stopped, and `down` still exits 0 (best-effort cleanup). The JSON
  result keeps a row per remote node with `detached:false, error`. Only surviving
  *local* processes make `down` exit 1.
- Checks and probes address nodes **by URL**: every node is `{id, port, base, remote}`,
  and no module may assume `127.0.0.1`.
- `bench --distribute=local,http://h1:9100` splits `users` evenly across the listed
  participants (at most one local), runs them in parallel, then merges: total ops,
  weighted ack percentiles from `ackSamples`, summed `perNode`. The report embeds
  `distributed.participants`.

### Safety / bounded timeouts

- `--public-host` is the address **as the LB sees it**; it must be reachable from the
  controller, not just from the agent itself.
- Every remote call is bounded: attach 30 s, load `durationMs + 30 s`, detach 10 s.
- An agent may only deregister the exact upstream URL it registered.
- The token is never printed in reports or logs (show `SET`/`MISSING`, like licenses).

## 13. Definition of done for a feature

1. Works on a clean clone with `npm ci` on Windows (no dependency on the parent workspace).
2. `npm run doctor` explains anything that is missing instead of crashing.
3. `npm run self-test` passes (mirror engine, no license).
4. If it changes a user-visible behaviour, the docs change in the same commit.
5. The failure mode is demonstrated, not just described: every "this can break"
   claim has a check or a broken variant that reproduces it.
