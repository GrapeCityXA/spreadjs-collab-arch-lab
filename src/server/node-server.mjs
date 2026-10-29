/**
 * One SpreadJS collaboration server node (DEV-CONTRACT §3).
 *
 *   node src/server/node-server.mjs --port=8081 --node-id=node-8081
 *
 * SYNCHRONIZATION POINT ON PURPOSE: the mirror and the commercial implementation
 * receive exactly the same options object, and the only cross-node switch is the
 * `socketIoAdapter` option. Toggling `SJS_ADAPTER=0|1` is therefore the single
 * independent variable of the whole lab.
 *
 * Hard rules this process enforces instead of degrading silently:
 *   - impl=real without a machine-bound server key          -> exit 2
 *   - OT / presence requested on the mirror                 -> exit 2
 *   - adapter requested but Redis unusable (bounded connect)-> exit 2
 * A node that starts with a feature that cannot work is worse than a node that
 * refuses to start, because every measurement taken afterwards is a lie.
 */
import { createServer } from 'node:http';
import { resolveConfig, describeLicense } from './config.mjs';
import { NodeHub, createLogger, describeError, sleep } from './hub.mjs';
import { createMirrorServer, createRoomStore } from './mirror-server.mjs';

/** Exit code for an invalid configuration (DEV-CONTRACT §3). */
const EXIT_INVALID_CONFIG = 2;

const cfg = resolveConfig(process.argv.slice(2));
const log = createLogger(cfg.nodeId);

function failInvalid(message) {
  log.error(message);
  process.exit(EXIT_INVALID_CONFIG);
}

/** Reject if `promise` has not settled within `ms`. */
function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Build the Socket.IO Redis adapter - the ONE integration point of the `shared`
 * topology. Everything else about the server is unchanged.
 *
 * Two traps, both hit in the predecessor project:
 *   - node-redis retries forever by default, so with Redis unreachable
 *     `connect()` never settles and the node hangs at startup with no error at
 *     all. Only the INITIAL connect is bounded here; afterwards the client keeps
 *     its infinite reconnect strategy, so a Redis outage after startup recovers.
 *   - opening a socket is not proof the link carries commands, so it is verified
 *     with a PING before the node is allowed to accept clients.
 */
async function createRedisAdapter({ url, timeoutMs }) {
  const [{ createClient }, { createAdapter }] = await Promise.all([
    import('redis'),
    import('@socket.io/redis-adapter'),
  ]);

  // RESP2 explicitly. node-redis negotiates RESP3 with HELLO, which Redis < 6
  // rejects (verified against Redis 5.0.14: "ERR unknown command HELLO"). RESP2 is
  // supported by every Redis the lab can meet and is sufficient for pub/sub.
  const pubClient = createClient({ url, RESP: 2 });
  const subClient = pubClient.duplicate();

  const errors = [];
  pubClient.on('error', (err) => errors.push(`pub: ${err.message}`));
  subClient.on('error', (err) => errors.push(`sub: ${err.message}`));

  const connectAll = Promise.all([pubClient.connect(), subClient.connect()]);
  // Attach a consumer here so a late rejection is never "unhandled", whichever
  // side of the race below wins.
  connectAll.catch(() => {});

  try {
    await withTimeout(connectAll, timeoutMs, `redis connect (${url})`);
  } catch (err) {
    // Do not leave half-open retry loops behind a failing process.
    await Promise.allSettled([pubClient.disconnect(), subClient.disconnect()]);
    const detail = errors.length ? ` - client errors: ${errors.slice(-3).join('; ')}` : '';
    throw new Error(`${err.message}${detail}`);
  }

  await Promise.all([pubClient.ping(), subClient.ping()]);

  return {
    adapter: createAdapter(pubClient, subClient),
    close: async () => {
      // `quit()` is a round-trip: on a link that died after startup it would stay
      // pending forever. Bound it, then tear the socket down unconditionally.
      const closeClient = async (client) => {
        try {
          await withTimeout(client.quit(), 400, 'redis quit');
        } catch {
          try {
            client.disconnect();
          } catch {
            /* already gone */
          }
        }
      };
      await Promise.allSettled([closeClient(pubClient), closeClient(subClient)]);
    },
  };
}

/** Listen, turning the two actionable socket errors into explicit messages. */
async function listen(httpServer) {
  try {
    await new Promise((resolve, reject) => {
      const onError = (err) => {
        httpServer.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        httpServer.removeListener('error', onError);
        resolve();
      };
      httpServer.once('error', onError);
      httpServer.once('listening', onListening);
      httpServer.listen(cfg.port, cfg.bindHost);
    });
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      failInvalid(
        `port ${cfg.port} on ${cfg.bindHost} is already in use. Neither the lab nor a foreign service may share a node port: ` +
          `stop the process holding it, or start this node with --port=<free port> (the orchestrator picks the next free port).`,
      );
    }
    if (err.code === 'EACCES') {
      failInvalid(`port ${cfg.port} requires elevated privileges on this system; pick a port above 1024 with --port=`);
    }
    throw err;
  }
}

/** Wire the commercial implementation, its optional OT/presence features and hooks. */
async function startRealNode({ httpServer, adapter }) {
  const { Server } = await import('@grapecity-software/js-collaboration');
  const server = new Server({ httpServer, path: cfg.path, socketIoAdapter: adapter });

  // `licenseKey` / `serverLicenseKey` are read-only INSTANCE properties, not
  // constructor options: passing them as config is silently ignored. Assign before
  // any handshake can be validated.
  if (cfg.license.licenseKey) server.licenseKey = cfg.license.licenseKey;
  if (cfg.license.serverLicenseKey) server.serverLicenseKey = cfg.license.serverLicenseKey;

  let ot = null;
  let otDb = null;
  if (cfg.otEnabled) {
    // DocumentServices needs the ADAPTER itself (something with getDocument/getOps),
    // not our store handle - handing it the handle fails later with
    // "this.db.getDocument is not a function".
    const db = cfg.otDbMode === 'sqlite' ? (otDb = await openOtStore()).adapter : await openOtMemoryDb();
    const { mountSpreadOt, MILESTONE_NOTE } = await import('./spread-ot.mjs');
    ot = await mountSpreadOt({ server, db, log });
    if (cfg.otDbMode === 'sqlite') {
      log.info(`OT documents are SHARED across every node opening ${otDb.file}`);
      log.info(`note: ${MILESTONE_NOTE}`);
    } else {
      log.info(`OT documents are stored in-memory on THIS node (nodeId=${cfg.nodeId})`);
    }
  }

  let presence = null;
  if (cfg.presenceEnabled) {
    // Presence is a SEPARATE feature from OT documents, and its state is per-PROCESS
    // (a Presence instance per roomId, no database hook). See presence.mjs.
    const { mountPresence, PRESENCE_NOTE } = await import('./presence.mjs');
    presence = await mountPresence({ server, log });
    log.info(`note: ${PRESENCE_NOTE}`);
  }

  // `storeMode` reported to clients/checks: with impl=real the document store IS
  // the OT database, so it is shared only when a shared sqlite file backs it.
  const storeMode = ot && cfg.otDbMode === 'sqlite' ? 'shared' : 'local';

  const hub = new NodeHub({
    nodeId: cfg.nodeId,
    port: cfg.port,
    impl: 'real',
    adapterEnabled: cfg.adapterEnabled,
    storeMode,
    otEnabled: Boolean(ot),
    otDbMode: cfg.otEnabled ? cfg.otDbMode : null,
    presenceEnabled: Boolean(presence),
  });

  const nodeInfo = buildNodeInfo({ storeMode });

  server.on({
    connect: ({ connection, roomId }) => {
      hub.setClient({
        id: connection.id,
        roomId,
        label: connection.query?.label ?? connection.id,
      });
      // Tell the client which backend served it - this is what makes the load
      // balancer's distribution externally observable.
      try {
        connection.send(nodeInfo, 'sjs-node-info');
      } catch (err) {
        log.warn(`failed to send node-info: ${describeError(err)}`);
      }
    },
    enterRoom: ({ connection, roomId }) => {
      hub.setClient({ id: connection.id, roomId, label: connection.query?.label ?? connection.id });
      try {
        connection.send(nodeInfo, 'sjs-node-info');
      } catch {
        /* best effort: the client already got node-info on connect */
      }
    },
    message: ({ connection, roomId, type }) => {
      hub.recordMessage(type);
      if (cfg.verbose) log.info(`frame from=${connection.id} room=${roomId} type=${type ?? 'null'}`);
    },
    disconnect: ({ connection }) => hub.removeClient(connection.id),
  });

  const io = server.Gt;
  if (!io?.sockets?.adapter) {
    log.warn('could not locate the wrapped socket.io instance; /state will omit adapter counters');
  }

  return {
    hub,
    io,
    nodeInfo,
    // impl=real keeps documents inside the OT feature, so the mirror's /docs view
    // is genuinely unavailable here (see hub.mjs).
    documents: null,
    async close() {
      await new Promise((resolve) => (io ? io.close(() => resolve()) : resolve()));
      await otDb?.close();
    },
  };
}

async function openOtStore() {
  const { mkdir } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  const { createSqliteDb } = await import('./spread-ot.mjs');
  await mkdir(dirname(cfg.otDbFile), { recursive: true });
  return createSqliteDb(cfg.otDbFile, { log });
}

async function openOtMemoryDb() {
  const { createMemoryDb } = await import('./spread-ot.mjs');
  return createMemoryDb();
}

/** The payload pushed to clients as `sjs-node-info` (DEV-CONTRACT §4). */
function buildNodeInfo({ storeMode }) {
  return {
    kind: 'node-info',
    nodeId: cfg.nodeId,
    port: cfg.port,
    adapterEnabled: cfg.adapterEnabled,
    impl: cfg.impl,
    ot: cfg.otEnabled,
    otDb: cfg.otEnabled ? cfg.otDbMode : null,
    presence: cfg.presenceEnabled,
    storeMode,
  };
}

async function main() {
  log.info(
    `starting: port=${cfg.port} path=${cfg.path} impl=${cfg.impl} adapter=${cfg.adapterEnabled ? 'ON' : 'OFF'} ` +
      `store=${cfg.storeMode} pid=${process.pid}`,
  );
  log.info(describeLicense(cfg.license));

  // ------------------------------------------------------- contract hard rules
  if (cfg.impl === 'real' && !cfg.license.serverLicenseKey) {
    failInvalid(
      'SJS_IMPL=real but no server.serverLicenseKey is configured. The commercial server rejects every handshake ' +
        'without a machine-activated server license, so no client would ever reach the connect hook. ' +
        'Configure config/license.json (see config/license.example.json), point SJS_LICENSE_FILE at an existing ' +
        'file, or use SJS_IMPL=mirror for the zero-license path.',
    );
  }
  if ((cfg.otEnabled || cfg.presenceEnabled) && cfg.impl !== 'real') {
    failInvalid(
      `SJS_OT/SJS_PRESENCE require SJS_IMPL=real (got impl=${cfg.impl}): only the commercial collaboration server ` +
        'has OT documents and presence. The mirror has no feature hook, so these options would be silently absent. ' +
        'Set SJS_OT=0 SJS_PRESENCE=0, or run with SJS_IMPL=real and a server license.',
    );
  }
  if (cfg.impl === 'real' && cfg.storeMode === 'shared') {
    log.warn(
      'SJS_STORE=shared is a mirror-only switch; impl=real stores documents through the OT feature, so ' +
        'SJS_OT_DB/SJS_OT_DB_FILE control sharing instead (SJS_OT_DB=sqlite is the shared default).',
    );
  }
  if (cfg.impl === 'real' && !cfg.otEnabled && !cfg.presenceEnabled) {
    log.warn(
      'impl=real with SJS_OT=0 and SJS_PRESENCE=0: no collaboration feature is mounted, so clients connect but no ' +
        'document is synchronised. Set SJS_OT=1 (and usually SJS_PRESENCE=1) for a working real server.',
    );
  }

  // ------------------------------------------------------------------- adapter
  let redis = null;
  if (cfg.adapterEnabled) {
    try {
      redis = await createRedisAdapter({ url: cfg.redisUrl, timeoutMs: cfg.redisConnectTimeoutMs });
      log.info(`redis adapter ready (${cfg.redisUrl})`);
    } catch (err) {
      failInvalid(
        `SJS_ADAPTER=1 but Redis at ${cfg.redisUrl} is not usable: ${describeError(err)}. ` +
          'Refusing to start: without Redis, cross-node broadcast would fail silently. ' +
          'Start Redis (tools/redis/redis-server), fix SJS_REDIS_URL, or set SJS_ADAPTER=0 to run a deliberately isolated node.',
      );
    }
  } else {
    log.warn('adapter DISABLED - this node cannot share room traffic with other nodes (control group)');
  }

  const httpServer = createServer();
  let app;

  if (cfg.impl === 'real') {
    app = await startRealNode({ httpServer, adapter: redis?.adapter });
  } else {
    const store = await createRoomStore({ mode: cfg.storeMode, file: cfg.storeFile, log });
    if (store.mode === 'local') {
      log.warn(
        'document store: per-node memory - another node serving the same room sees a DIFFERENT document (that is the sharded baseline)',
      );
    }
    const storeMode = store.mode;
    const hub = new NodeHub({
      nodeId: cfg.nodeId,
      port: cfg.port,
      impl: 'mirror',
      adapterEnabled: cfg.adapterEnabled,
      storeMode,
    });
    const nodeInfo = buildNodeInfo({ storeMode });
    const mirror = createMirrorServer({
      httpServer,
      hub,
      adapter: redis?.adapter,
      path: cfg.path,
      nodeInfo,
      store,
      roomFallback: cfg.roomFallback,
      log,
    });
    app = {
      hub,
      io: mirror.io,
      nodeInfo,
      documents: store,
      async close() {
        await mirror.close();
        await store.close();
      },
    };
  }

  await app.hub.attachSocketIo(app.io);
  app.hub.installControl(httpServer, {
    documents: app.documents,
    licenseStatus: cfg.license.status,
    onShutdown: (reason) => shutdown(reason),
  });

  await listen(httpServer);
  log.info(`listening: ws=${cfg.path} control=http://${cfg.bindHost}:${cfg.port}/state`);

  let shuttingDown = false;
  let rejectedDuringShutdown = 0;

  /**
   * Graceful stop, shared by SIGINT/SIGTERM and `POST /shutdown`.
   *
   * Every step has a deadline: shutdown must never be the thing that hangs. A
   * Redis that died mid-run would otherwise keep `quit()` pending forever and the
   * process would stay alive holding its port - the exact orphan the shutdown
   * endpoint exists to prevent.
   */
  async function shutdown(reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    log.warn(`${reason}, shutting down`);

    const budget = async (label, work, ms) => {
      try {
        await withTimeout(Promise.resolve().then(work), ms, label);
      } catch (err) {
        log.warn(`shutdown: ${label} did not finish within ${ms}ms (${describeError(err)}) - continuing`);
      }
    };

    // io.close() disconnects remaining clients and closes the HTTP server, so it
    // also stops new HTTP requests / upgrades from being accepted.
    await budget('socket.io close', () => app.close(), 1500);
    await budget(
      'http server close',
      () =>
        new Promise((resolve) => {
          httpServer.close(() => resolve());
          // WebSockets are long-lived; without this the close callback would wait
          // for every browser tab to go away first.
          httpServer.closeAllConnections?.();
        }),
      800,
    );
    await budget('redis adapter close', () => (redis ? redis.close() : Promise.resolve()), 800);
    if (rejectedDuringShutdown) {
      log.info(`ignored ${rejectedDuringShutdown} rejection(s) from clients torn down during shutdown`);
    }
    await sleep(10);
    process.exit(0);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => log.error('uncaughtException', describeError(err)));
  process.on('unhandledRejection', (err) => {
    // While shutting down, node-redis rejects promises from its reconnect loop as
    // its sockets are torn down (observed as "Disconnects client" when Redis is
    // already gone). Those are expected and must not look like node failures.
    if (shuttingDown) {
      rejectedDuringShutdown += 1;
      return;
    }
    log.error('unhandledRejection', describeError(err));
  });
}

main().catch((err) => {
  log.error('fatal', describeError(err));
  process.exit(1);
});
