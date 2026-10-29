/**
 * SpreadJS collaboration (OT) wiring for `SJS_IMPL=real` (DEV-CONTRACT §3).
 *
 * This is what makes the commercial collaboration server understand SPREADSHEET
 * operations. Without it the server is a generic message relay: clients can
 * exchange arbitrary JSON, but there is no shared document and no OT transform,
 * so there is no real co-editing.
 *
 * The three steps come from the official quick start:
 *   1. OT.TypesManager.register(type)          - teach OT how to transform sheet ops
 *   2. new OT.DocumentServices({ db })         - the shared-document store
 *   3. server.useFeature(OT.documentFeature(..)) - expose it over the connection
 *
 * Everything here is loaded lazily so a mirror-only run never pays for - or
 * depends on - the commercial OT stack.
 */
import { type } from '@grapecity-software/spread-sheets-collaboration';

let registered = false;

function loadOt() {
  return import('@grapecity-software/js-collaboration-ot');
}

/** Register the SpreadJS OT type. Safe to call more than once per process. */
export async function registerSpreadType() {
  const OT = await loadOt();
  if (!registered) {
    OT.TypesManager.register(type);
    registered = true;
  }
  return OT;
}

/**
 * Mount the OT document feature on a collaboration Server instance.
 *
 * @param {object} options
 * @param {object} options.server  the `@grapecity-software/js-collaboration` Server
 * @param {object} [options.db]    database adapter (see createMemoryDb/createSqliteDb);
 *                                 when omitted DocumentServices creates its own storage
 * @param {{info: Function}} [options.log]
 */
export async function mountSpreadOt({ server, db = null, log = console } = {}) {
  if (!server || typeof server.useFeature !== 'function') {
    throw new Error('mountSpreadOt: server does not expose useFeature(); is SJS_IMPL=real?');
  }

  // Validate the adapter's SHAPE rather than letting a wrong object through. Passing
  // a wrapper (e.g. { adapter, file }) instead of the adapter itself is an easy
  // mistake that only surfaces later as "this.db.getDocument is not a function" on
  // the first fetch - far from the cause.
  if (db !== null) {
    const required = ['getDocument', 'getOps', 'commitOp'];
    const missing = required.filter((method) => typeof db[method] !== 'function');
    if (missing.length) {
      throw new Error(
        `mountSpreadOt: db is not a usable IDatabaseAdapter - missing ${missing.join(', ')}. ` +
          'Pass the adapter itself, not a wrapper such as { adapter }.',
      );
    }
  }

  const OT = await registerSpreadType();

  // DocumentServices takes a CONFIG OBJECT ({ db, milestoneDb, ... }), not a
  // database instance directly (verified against the 19.2.1 type definitions).
  const documentServices = new OT.DocumentServices(db ? { db } : undefined);
  server.useFeature(OT.documentFeature(documentServices));

  log.info?.(
    'spread OT mounted: TypesManager registered, DocumentServices created, documentFeature enabled' +
      (db ? ' (explicit db adapter)' : ' (default in-memory storage)'),
  );

  return { documentServices, db, type, OT };
}

/**
 * In-memory OT database adapter: documents live in this node's memory only.
 * Correct for a single node; several nodes each hold their own copy.
 */
export async function createMemoryDb() {
  const OT = await loadOt();
  return new OT.MemoryDb();
}

/**
 * Open a SQLite-backed OT database adapter that every node can share.
 *
 * WHY SQLITE: the collaboration nodes normally run on one host, so a file database
 * gives real cross-node document sharing and persistence without a separate
 * database server.
 *
 * Two non-obvious constraints, both verified against 19.2.1:
 *   1. the official adapter is a thin SQL layer over an EXISTING `sqlite3`
 *      Database handle - it does not create the file or the schema, and `sqlite3`
 *      is not a dependency of the adapter package;
 *   2. `init()` exists at runtime but is missing from the .d.ts, and its promise
 *      resolves BEFORE the CREATE TABLE statements have executed (it is
 *      fire-and-forget inside `db.serialize`). Skipping the wait makes the first
 *      query fail with `SQLITE_ERROR: no such table: documents`.
 */
export async function createSqliteDb(file, { log = console } = {}) {
  const [{ default: sqlite3 }, { SqliteDb }] = await Promise.all([
    import('sqlite3'),
    import('@grapecity-software/js-collaboration-ot-sqlite'),
  ]);

  const handle = await new Promise((resolve, reject) => {
    const db = new sqlite3.Database(file, (err) => (err ? reject(err) : resolve(db)));
  });

  const adapter = new SqliteDb(handle);
  if (typeof adapter.init !== 'function') {
    throw new Error('SqliteDb.init() not found - cannot create the OT schema');
  }

  await adapter.init(false);
  await waitForSchema(handle);

  // Concurrent writers across processes: WAL + a busy timeout avoids spurious
  // SQLITE_BUSY failures. Applied after the schema exists, because the PRAGMA
  // callbacks otherwise interleave with the pending CREATE TABLE work.
  await new Promise((resolve, reject) => {
    handle.serialize(() => {
      handle.run('PRAGMA journal_mode = WAL', (err) => (err ? reject(err) : null));
      handle.run('PRAGMA busy_timeout = 5000', (err) => (err ? reject(err) : resolve()));
    });
  });

  log.info?.(`OT database: sqlite (${file}, WAL) shared by every node pointing at this file`);

  return {
    adapter,
    handle,
    file,
    close: async () => {
      await new Promise((resolve) => handle.close(() => resolve()));
    },
  };
}

/** Tables the adapter's schema is expected to contain. */
const REQUIRED_TABLES = ['documents', 'operations', 'snapshot_fragments'];

/** Poll until the OT schema is fully present; fail loudly instead of querying a ghost. */
async function waitForSchema(handle, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let found = [];
  while (Date.now() < deadline) {
    found = await new Promise((resolve, reject) =>
      handle.all("SELECT name FROM sqlite_master WHERE type='table'", (err, rows) =>
        err ? reject(err) : resolve(rows.map((row) => row.name)),
      ),
    );
    if (REQUIRED_TABLES.every((table) => found.includes(table))) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `OT schema incomplete after ${timeoutMs}ms - expected ${REQUIRED_TABLES.join(', ')}, found [${found.join(', ')}]`,
  );
}

/**
 * Milestones are a SEPARATE adapter from the document database and default to an
 * in-memory store. The official SQLite package ships no milestone implementation,
 * so milestone snapshots stay per-node and are lost on restart. Live collaboration
 * is unaffected: document state goes through `db`.
 */
export const MILESTONE_NOTE =
  'milestoneDb uses the default in-memory store; only document state is persisted to SQLite';
