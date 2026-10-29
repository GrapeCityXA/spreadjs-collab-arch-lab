/**
 * Zero-license reference collaboration node: protocol shape, room document model
 * and the two document stores (DEV-CONTRACT §4).
 *
 * WHY A MIRROR AT ALL
 * -------------------
 * The commercial `@grapecity-software/js-collaboration` server rejects every
 * handshake unless a machine-activated server key is present. That makes the
 * multi-server question unanswerable for anyone without a license, which is the
 * situation this lab exists for. The mirror therefore reproduces exactly the parts
 * the topology question depends on:
 *
 *   - socket.io transport (`transports: ['websocket']`, `serveClient: false`)
 *   - room id taken from the handshake query, rooms mapped to socket.io rooms
 *   - the `m` / `[type, data, compressed]` frame codec of the official protocol
 *   - `lab:*` application frames with a snapshot document `{docId, version, cells}`
 *   - the `socketIoAdapter` injection point (so `SJS_ADAPTER=1|0` is the single
 *     independent variable)
 *
 * It does NOT reproduce GrapeCity's licensing, OT transformation or presence
 * semantics; `SJS_IMPL=real` does that. Any number measured here is a statement
 * about socket.io fan-out and room routing, never a certification of the
 * commercial server.
 *
 * THE POINT OF THE STORES
 * -----------------------
 *   store=local   the document lives in THIS process's memory. Two nodes hold two
 *                 different documents; a restart loses it. That is the honest
 *                 baseline for the `sharded` topology.
 *   store=shared  every node opens the same SQLite file, so any node can serve any
 *                 room and the version is allocated inside the database. That is
 *                 the "shared document store" half of the `shared` topology - the
 *                 Redis adapter alone is not enough, which is exactly the mistake
 *                 the `broken-adapter-only` variant demonstrates.
 */
import { Server as IOServer } from 'socket.io';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import sqlite3 from 'sqlite3';
import { encodeMessage, decodeMessage, SOCKET_IO_MESSAGE_EVENT } from './mirror-codec.mjs';
import { DEFAULT_ROOM } from './config.mjs';
import { describeError, sleep } from './hub.mjs';

/** Applied opIds remembered per room by the local store (bounded, FIFO eviction). */
const MAX_REMEMBERED_OPS = 5000;
/** How long a committed opId is kept in the shared store for replay protection. */
const SHARED_OP_RETENTION_MS = 60 * 60 * 1000;
/** How many applies between retention sweeps of the shared op table. */
const SHARED_PRUNE_EVERY = 128;
/** Cell coordinates beyond this are certainly a client bug, not a spreadsheet. */
const MAX_CELL_INDEX = 1_000_000;

function publicDoc(record) {
  return {
    roomId: record.roomId,
    docId: record.docId,
    version: record.version,
    // Clone so a caller can never mutate the stored document by accident.
    cells: { ...record.cells },
    updatedAt: record.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// store=local
// ---------------------------------------------------------------------------

/** Per-process document store. Deliberately not shared with anybody. */
class LocalStore {
  constructor() {
    this.mode = 'local';
    /** @type {Map<string, {roomId: string, docId: string, version: number, cells: Record<string, unknown>, updatedAt: number, applied: Map<string, number>}>} */
    this.docs = new Map();
  }

  #ensure(roomId) {
    let record = this.docs.get(roomId);
    if (!record) {
      record = {
        roomId,
        docId: roomId,
        version: 0,
        cells: {},
        updatedAt: Date.now(),
        applied: new Map(),
      };
      this.docs.set(roomId, record);
    }
    return record;
  }

  async peek(roomId) {
    const record = this.docs.get(roomId);
    return record ? publicDoc(record) : null;
  }

  async get(roomId) {
    return publicDoc(this.#ensure(roomId));
  }

  /**
   * Apply one op idempotently, keyed on opId: a reconnecting client may replay an
   * op it already delivered, and a replay must not bump the version (that would
   * make "did the document converge?" impossible to measure).
   */
  async applyOp({ roomId, opId, row, col, value }) {
    const record = this.#ensure(roomId);
    const known = record.applied.get(opId);
    if (known !== undefined) return { version: known, applied: false };

    record.version += 1;
    record.cells[`${row},${col}`] = value;
    record.updatedAt = Date.now();
    record.applied.set(opId, record.version);

    if (record.applied.size > MAX_REMEMBERED_OPS) {
      // Map preserves insertion order, so the first key is the oldest opId.
      record.applied.delete(record.applied.keys().next().value);
    }
    return { version: record.version, applied: true };
  }

  async list(limit) {
    return [...this.docs.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit)
      .map(publicDoc);
  }

  async close() {
    this.docs.clear();
  }
}

// ---------------------------------------------------------------------------
// store=shared (one SQLite file, every node opens it)
// ---------------------------------------------------------------------------

function runSql(handle, sql, params = []) {
  return new Promise((resolve, reject) => {
    handle.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function getSql(handle, sql, params = []) {
  return new Promise((resolve, reject) => {
    handle.get(sql, params, (err, row) => (err ? reject(err) : resolve(row ?? null)));
  });
}

function allSql(handle, sql, params = []) {
  return new Promise((resolve, reject) => {
    handle.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows ?? [])));
  });
}

/**
 * Shared document store backed by one SQLite file.
 *
 * True multi-process access needs three things, and skipping any one of them
 * produces intermittent "database is locked" failures under real collaboration
 * load:
 *   1. WAL journal mode, so readers never block the single writer;
 *   2. a busy timeout, so a process waits for the writer instead of failing;
 *   3. an explicit retry for the cases the timeout cannot absorb (for example two
 *      processes starting `BEGIN IMMEDIATE` at the same moment on network storage).
 */
class SharedStore {
  constructor(handle, file) {
    this.mode = 'shared';
    this.handle = handle;
    this.file = file;
    // Every transaction on this connection runs through one promise chain: two
    // concurrent applyOp() calls must not interleave BEGIN/COMMIT statements on
    // the same connection, or one would commit the other's half-finished work.
    this.tail = Promise.resolve();
    this.applies = 0;
  }

  #serialize(work) {
    const result = this.tail.then(work, work);
    this.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  /**
   * Retry only on SQLITE_BUSY: any other error (bad schema, disk full) must
   * surface immediately instead of being retried into a slow, confusing timeout.
   */
  async #withRetry(work, attempts = 6) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await work();
      } catch (err) {
        const text = `${err?.code ?? ''} ${err?.message ?? ''}`;
        const busy = /SQLITE_BUSY|database is locked|SQLITE_LOCKED/i.test(text);
        if (!busy || attempt >= attempts - 1) throw err;
        await sleep(20 * 2 ** attempt + Math.random() * 30);
      }
    }
  }

  async #transaction(work) {
    // IMMEDIATE takes the write lock up front. Without it, two processes can both
    // read version n, then both try to commit n+1 and one gets a busy error
    // mid-transaction - the classic lost-update window.
    await runSql(this.handle, 'BEGIN IMMEDIATE');
    try {
      const result = await work();
      await runSql(this.handle, 'COMMIT');
      return result;
    } catch (err) {
      await runSql(this.handle, 'ROLLBACK').catch(() => {});
      throw err;
    }
  }

  async peek(roomId) {
    const row = await this.#serialize(() =>
      getSql(
        this.handle,
        'SELECT room_id, doc_id, version, cells, updated_at FROM mirror_documents WHERE room_id = ?',
        [roomId],
      ),
    );
    return row ? rowToDoc(row) : null;
  }

  async get(roomId) {
    return this.#serialize(() =>
      this.#withRetry(async () => {
        await runSql(
          this.handle,
          "INSERT INTO mirror_documents(room_id, doc_id, version, cells, updated_at) VALUES (?, ?, 0, '{}', ?) " +
            'ON CONFLICT(room_id) DO NOTHING',
          [roomId, roomId, Date.now()],
        );
        const row = await getSql(
          this.handle,
          'SELECT room_id, doc_id, version, cells, updated_at FROM mirror_documents WHERE room_id = ?',
          [roomId],
        );
        return row ? rowToDoc(row) : null;
      }),
    );
  }

  /**
   * Apply one op idempotently.
   *
   * The version is allocated by the DATABASE, inside a single write transaction:
   *
   *   BEGIN IMMEDIATE;
   *     SELECT version FROM mirror_ops WHERE room_id=? AND op_id=?;             -- replay?
   *     INSERT INTO mirror_documents(...) VALUES (...,0,'{}',...)               -- ensure row
   *       ON CONFLICT(room_id) DO NOTHING;
   *     SELECT version, cells FROM mirror_documents WHERE room_id=?;            -- current state
   *     UPDATE mirror_documents
   *        SET version = version + 1, cells=?, updated_at=?
   *      WHERE room_id=?
   *      RETURNING version;                                                     -- n+1, atomically
   *     INSERT INTO mirror_ops(room_id, op_id, version, at) VALUES (?,?,?,?);
   *   COMMIT;
   *
   * Because the `UPDATE ... RETURNING` happens while this process holds the write
   * lock, two nodes can never both commit version n: the second one blocks on
   * BEGIN IMMEDIATE and then sees n+1.
   */
  async applyOp({ roomId, opId, row, col, value, ts }) {
    return this.#serialize(() =>
      this.#withRetry(() =>
        this.#transaction(async () => {
          const replay = await getSql(
            this.handle,
            'SELECT version FROM mirror_ops WHERE room_id = ? AND op_id = ?',
            [roomId, opId],
          );
          if (replay) return { version: replay.version, applied: false };

          await runSql(
            this.handle,
            "INSERT INTO mirror_documents(room_id, doc_id, version, cells, updated_at) VALUES (?, ?, 0, '{}', ?) " +
              'ON CONFLICT(room_id) DO NOTHING',
            [roomId, roomId, Date.now()],
          );
          const current = await getSql(
            this.handle,
            'SELECT version, cells FROM mirror_documents WHERE room_id = ?',
            [roomId],
          );
          const cells = current ? JSON.parse(current.cells) : {};
          cells[`${row},${col}`] = value;

          const updated = await getSql(
            this.handle,
            'UPDATE mirror_documents SET version = version + 1, cells = ?, updated_at = ? WHERE room_id = ? ' +
              'RETURNING version',
            [JSON.stringify(cells), Date.now(), roomId],
          );
          const version = updated.version;

          await runSql(this.handle, 'INSERT INTO mirror_ops(room_id, op_id, version, at) VALUES (?, ?, ?, ?)', [
            roomId,
            opId,
            version,
            ts ?? Date.now(),
          ]);

          this.applies += 1;
          if (this.applies % SHARED_PRUNE_EVERY === 0) {
            // Bounded growth: replay protection only matters for a reconnect, so
            // opIds older than the retention window can go.
            await runSql(this.handle, 'DELETE FROM mirror_ops WHERE at < ?', [Date.now() - SHARED_OP_RETENTION_MS]);
          }
          return { version, applied: true };
        }),
      ),
    );
  }

  async list(limit) {
    const rows = await this.#serialize(() =>
      allSql(
        this.handle,
        'SELECT room_id, doc_id, version, cells, updated_at FROM mirror_documents ORDER BY updated_at DESC LIMIT ?',
        [limit],
      ),
    );
    return rows.map(rowToDoc);
  }

  async close() {
    await this.tail;
    await new Promise((resolve) => this.handle.close(() => resolve()));
  }
}

function rowToDoc(row) {
  let cells = {};
  try {
    cells = JSON.parse(row.cells);
  } catch {
    // A corrupted row must not take the whole /state response down.
    cells = {};
  }
  return {
    roomId: row.room_id,
    docId: row.doc_id,
    version: row.version,
    cells,
    updatedAt: row.updated_at,
  };
}

/**
 * Bootstrap statement runner that tolerates two or more nodes opening the SAME new
 * SQLite file at the same instant.
 *
 * This is the one place where `busy_timeout` is not enough: switching a database to
 * WAL (or creating the tables for the first time) needs a brief exclusive lock, and
 * SQLite reports `SQLITE_BUSY` for `PRAGMA journal_mode = WAL` immediately instead of
 * waiting. Without this retry, starting N shared-store nodes together is a coin flip:
 * one of them exits with "database is locked" before the lab even begins.
 */
async function execWithBusyRetry(handle, sql, { log = null, attempts = 12 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        handle.exec(sql, (err) => (err ? reject(err) : resolve()));
      });
    } catch (err) {
      const text = `${err?.code ?? ''} ${err?.message ?? ''}`;
      if (!/SQLITE_BUSY|database is locked|SQLITE_LOCKED/i.test(text) || attempt >= attempts - 1) throw err;
      const wait = 20 * 2 ** attempt + Math.random() * 30;
      log?.warn?.(`shared store busy while opening (${err.message}); retrying in ${Math.round(wait)}ms`);
      await sleep(wait);
    }
  }
}

/**
 * Open the store selected by SJS_STORE.
 *
 * @param {{ mode: 'local'|'shared', file?: string, log?: { info: Function } }} options
 */
export async function createRoomStore({ mode, file, log = console }) {
  if (mode !== 'shared') return new LocalStore();

  await mkdir(dirname(file), { recursive: true });
  const handle = await new Promise((resolve, reject) => {
    const db = new sqlite3.Database(file, (err) => (err ? reject(err) : resolve(db)));
  });

  try {
    // busy_timeout FIRST so every later statement waits instead of failing fast...
    await execWithBusyRetry(handle, 'PRAGMA busy_timeout = 5000;', { log });
    // ...then the WAL switch, which is the statement that races on a fresh file.
    await execWithBusyRetry(handle, 'PRAGMA journal_mode = WAL;', { log });
    await execWithBusyRetry(handle, 'PRAGMA synchronous = NORMAL;', { log });
    await execWithBusyRetry(
      handle,
      `CREATE TABLE IF NOT EXISTS mirror_documents (
         room_id    TEXT PRIMARY KEY,
         doc_id     TEXT NOT NULL,
         version    INTEGER NOT NULL,
         cells      TEXT NOT NULL,
         updated_at INTEGER NOT NULL
       );
       CREATE TABLE IF NOT EXISTS mirror_ops (
         room_id TEXT NOT NULL,
         op_id   TEXT NOT NULL,
         version INTEGER NOT NULL,
         at      INTEGER NOT NULL,
         PRIMARY KEY (room_id, op_id)
       );`,
      { log },
    );
  } catch (err) {
    await new Promise((resolve) => handle.close(() => resolve()));
    throw err;
  }

  log.info?.(`document store: shared sqlite (${file}, WAL) - every node opening this file sees the same documents`);
  return new SharedStore(handle, file);
}

// ---------------------------------------------------------------------------
// socket.io protocol
// ---------------------------------------------------------------------------

/**
 * Build the mirror collaboration server.
 *
 * @param {object} options
 * @param {import('node:http').Server} options.httpServer
 * @param {import('./hub.mjs').NodeHub} options.hub
 * @param {object} [options.adapter]        socket.io adapter (Redis) or undefined
 * @param {string} options.path
 * @param {object} options.nodeInfo         payload pushed as `sjs-node-info`
 * @param {LocalStore|SharedStore} options.store
 * @param {string} [options.roomFallback]
 * @param {{info: Function, warn: Function, error: Function}} options.log
 */
export function createMirrorServer({
  httpServer,
  hub,
  adapter,
  path,
  nodeInfo,
  store,
  roomFallback = DEFAULT_ROOM,
  log,
}) {
  const io = new IOServer(httpServer, {
    // Mirror the commercial server: websocket only, no client files served.
    transports: ['websocket'],
    serveClient: false,
    path,
    adapter,
  });

  const nodeId = nodeInfo.nodeId;

  const send = (socket, type, data) => {
    socket.emit(SOCKET_IO_MESSAGE_EVENT, encodeMessage(data, type));
  };

  // The Redis adapter forwards frames, but does not merge their application data.
  // Sending hub.membersOf() across nodes would replace the room list with just
  // one node's members. fetchSockets queries the adapter's full room membership.
  const roomMembers = async (roomId) => {
    const sockets = await io.in(roomId).fetchSockets();
    return sockets.map((socket) => ({ id: socket.id, label: socket.data.label ?? socket.id, nodeId: socket.data.nodeId ?? nodeId }));
  };

  const broadcastPresence = async (roomId) => {
    try {
      const members = await roomMembers(roomId);
      io.to(roomId).emit(
        SOCKET_IO_MESSAGE_EVENT,
        encodeMessage({ members, nodeId, ts: Date.now() }, 'lab:presence'),
      );
    } catch (err) {
      // Adapter queries have a timeout. Do not publish a misleading local-only
      // list when a peer is unavailable, or leak a rejection from disconnect.
      log.warn(`room membership unavailable room=${roomId}: ${describeError(err)}`);
    }
  };

  io.on('connection', (socket) => {
    const query = socket.handshake.query ?? {};
    let roomId = String(query.roomId ?? query.room ?? roomFallback);
    let label = String(query.label ?? query.clientId ?? socket.id).slice(0, 64);

    socket.data.label = label;
    socket.data.nodeId = nodeId;
    socket.join(roomId);
    hub.setClient({ id: socket.id, roomId, label });
    // Match the commercial server's hook order: node-info on connect, then again
    // when the client enters the room.
    send(socket, 'sjs-node-info', nodeInfo);
    log.info(`connect id=${socket.id} room=${roomId} label=${label}`);

    /** Reply with the current document plus all reachable room members. */
    const sendSnapshot = async () => {
      const doc = await store.get(roomId);
      send(socket, 'lab:snapshot', {
        roomId,
        docId: doc.docId,
        version: doc.version,
        cells: doc.cells,
        members: await roomMembers(roomId),
        nodeId,
        storeMode: store.mode,
        ts: Date.now(),
      });
    };

    const join = async (data) => {
      if (typeof data?.label === 'string' && data.label.trim()) label = data.label.trim().slice(0, 64);
      const requested = typeof data?.roomId === 'string' ? data.roomId.trim() : '';
      const previousRoom = roomId;
      if (requested && requested !== roomId) {
        // A client may join a different room after connecting (the handshake query
        // is only a default). Both rooms' member lists change, so announce to both.
        socket.leave(roomId);
        roomId = requested;
        socket.join(roomId);
      }
      socket.data.label = label;
      hub.setClient({ id: socket.id, roomId, label });
      send(socket, 'sjs-node-info', nodeInfo);
      await sendSnapshot();
      await broadcastPresence(roomId);
      if (previousRoom !== roomId) await broadcastPresence(previousRoom);
    };

    const applyOp = async (data) => {
      const opId = typeof data?.opId === 'string' || typeof data?.opId === 'number' ? String(data.opId) : '';
      if (!opId) {
        return send(socket, 'lab:error', {
          code: 'bad-op',
          message: 'lab:op requires a non-empty opId; clients use it to apply the frame idempotently',
        });
      }
      const row = Number(data.row);
      const col = Number(data.col);
      if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0 || row > MAX_CELL_INDEX || col > MAX_CELL_INDEX) {
        return send(socket, 'lab:error', {
          code: 'bad-op',
          message: `lab:op requires integer row/col in [0, ${MAX_CELL_INDEX}], got row=${JSON.stringify(data.row)} col=${JSON.stringify(data.col)}`,
        });
      }
      const ts = Number.isFinite(Number(data.ts)) ? Number(data.ts) : Date.now();
      const value = data.value ?? null;

      const { version, applied } = await store.applyOp({ roomId, opId, row, col, value, ts });
      send(socket, 'lab:op-ack', { opId, version, ts, nodeId });
      if (applied) {
        // `socket.to(room)` excludes the sender - the sender already has the value
        // it just typed, and with a Redis adapter it still reaches every other
        // node's members of the room.
        socket.to(roomId).emit(
          SOCKET_IO_MESSAGE_EVENT,
          encodeMessage({ opId, version, row, col, value, from: socket.id, fromLabel: label, nodeId, ts }, 'lab:op'),
        );
      } else {
        log.warn(`replayed opId=${opId} room=${roomId} - acked version ${version} without re-applying`);
      }
    };

    /**
     * Frame dispatch. `lab:join` is NOT required before `lab:op`: a client that
     * reconnects mid-room keeps editing immediately, and the connection already
     * joined the handshake room above. Unknown `lab:*` types get an explicit
     * error instead of silence, so a protocol mismatch is visible in the browser
     * log rather than looking like a network problem.
     */
    const dispatch = async (type, data) => {
      switch (type) {
        case 'lab:join':
          return join(data ?? {});
        case 'lab:op':
          return applyOp(data ?? {});
        case 'lab:resync':
          return sendSnapshot();
        case 'lab:ping':
          return send(socket, 'lab:pong', {
            t: data?.t ?? null,
            nodeId,
            serverTime: Date.now(),
          });
        default:
          return send(socket, 'lab:error', {
            code: 'unknown-type',
            message: `unsupported frame type ${JSON.stringify(type)}; expected lab:join|lab:op|lab:resync|lab:ping`,
          });
      }
    };

    // One promise chain per connection: collaboration ops must be applied in the
    // order that connection sent them, otherwise two quick edits could be acked
    // out of order and the client would show the wrong version.
    let chain = Promise.resolve();
    socket.on(SOCKET_IO_MESSAGE_EVENT, (payload) => {
      const [data, type] = decodeMessage(payload);
      hub.recordMessage(type);
      chain = chain.then(async () => {
        try {
          await dispatch(type, data);
        } catch (err) {
          log.error(`frame ${type ?? 'null'} from ${socket.id} failed: ${describeError(err)}`);
          send(socket, 'lab:error', { code: 'internal', message: describeError(err) });
        }
      });
    });

    socket.on('disconnect', (reason) => {
      hub.removeClient(socket.id);
      log.info(`disconnect id=${socket.id} room=${roomId} reason=${reason}`);
      broadcastPresence(roomId);
    });
  });

  return {
    io,
    async close() {
      await new Promise((resolve) => io.close(() => resolve()));
    },
  };
}
