#!/usr/bin/env node
/**
 * Large-document memory probe.
 *
 * The bench tools measure fan-out (many clients, few cells). Real customer scenarios
 * also have big workbooks: a 500 000-cell document costs memory per cell and a full
 * snapshot when somebody joins. This script writes N cells into ONE room with a single
 * client, then measures:
 *
 *   - how long the writes took (op/s),
 *   - the node's RSS before / right after / after settling (memory per cell),
 *   - the join time and snapshot size when a second client opens the document.
 *
 * It is a probe, not a benchmark: it uses the mirror implementation, so treat the
 * numbers as an order of magnitude and re-measure against the official engine.
 *
 * Usage (server must already be up):
 *   npm run up -- --mode=single --no-web
 *   npm run big-doc -- --cells=500000
 *   npm run down
 *
 * Options:
 *   --url=http://127.0.0.1:8081   node entry (default: local single node)
 *   --room=big-doc                room / document id to fill
 *   --cells=500000                how many cells to write
 *   --batch=200                   concurrent unacknowledged writes
 *   --settle-ms=3000              wait before the RSS "steady" reading
 *   --json                        machine-readable output only
 */
import { openClient } from '../src/checks/mirror-client.mjs';
import { getJson } from '../src/lab/ports.mjs';

const args = new Map(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const i = a.indexOf('=');
      return i < 0 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)];
    }),
);

const url = String(args.get('url') ?? 'http://127.0.0.1:8081');
const roomId = String(args.get('room') ?? 'big-doc');
const cells = Number(args.get('cells') ?? 500_000);
const batch = Math.max(1, Number(args.get('batch') ?? 200));
const settleMs = Math.max(0, Number(args.get('settle-ms') ?? 3000));
const asJson = args.has('json');

if (!Number.isSafeInteger(cells) || cells < 1) {
  process.stderr.write('[big-doc] --cells 需要是正整数\n');
  process.exit(2);
}

/** Read the node's own RSS from /health (no OS process access needed). */
async function rss() {
  try {
    const res = await getJson(`${url}/health`, 1500);
    return res.ok && res.body ? { pid: res.body.pid, rss: res.body.rssBytes, heap: res.body.heapUsedBytes } : null;
  } catch {
    return null;
  }
}

const before = await rss();
const t0 = Date.now();
const writer = await openClient({ url, path: '/collaboration/', roomId, label: 'big-doc-writer' });
const writerJoinMs = Date.now() - t0;

let pending = [];
let written = 0;
let lastReportAt = Date.now();
const start = Date.now();
for (let i = 0; i < cells; i++) {
  pending.push(writer.setCell(Math.floor(i / 1000), i % 1000, `v${i}`));
  if (pending.length >= batch) {
    await Promise.all(pending);
    pending = [];
    written += batch;
    if (Date.now() - lastReportAt >= 2000) {
      lastReportAt = Date.now();
      process.stderr.write(`[big-doc] ${written}/${cells} cells, ${Math.round(written / ((Date.now() - start) / 1000))} op/s\n`);
    }
  }
}
await Promise.all(pending);
written += pending.length;
const writeMs = Date.now() - start;

const afterWrite = await rss();
if (settleMs) await new Promise((r) => setTimeout(r, settleMs));
const steady = await rss();

const t1 = Date.now();
const reader = await openClient({ url, path: '/collaboration/', roomId, label: 'big-doc-reader' });
const readerJoinMs = Date.now() - t1;
const receivedCells = reader.cells.size;
const snapshotJson = JSON.stringify(reader.getCells());

const rssOf = (snap) => (snap ? Math.round(snap.rss / 1024 / 1024) : null);
const result = {
  room: roomId,
  cellsWritten: written,
  writerJoinMs,
  writeMs,
  opsPerSecond: Math.round(written / (writeMs / 1000)),
  server: { pid: steady?.pid ?? before?.pid ?? null, rssMbBefore: rssOf(before), rssMbAfterWrite: rssOf(afterWrite), rssMbSteady: rssOf(steady) },
  bytesPerCell:
    before && steady && written ? Math.round((steady.rss - before.rss) / written) : null,
  readerJoinMs,
  receivedCells,
  snapshotJsonBytes: snapshotJson.length,
  snapshotBytesPerCell: Number((snapshotJson.length / Math.max(1, receivedCells)).toFixed(1)),
};

reader.close();
writer.close();

if (asJson) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  const s = result.server;
  process.stdout.write([
    `[big-doc] 房间 ${roomId}：写入 ${written} 格，${result.opsPerSecond} op/s`,
    s.rssMbBefore == null
      ? '[big-doc] 未取到 /health，RSS 略过'
      : `[big-doc] 节点 RSS：写入前 ${s.rssMbBefore} MB → 写入后 ${s.rssMbAfterWrite} MB → 稳定 ${s.rssMbSteady} MB（≈ ${result.bytesPerCell} B/格）`,
    `[big-doc] 第二个客户端加入：${result.readerJoinMs} ms，收到 ${result.receivedCells} 格，快照 JSON ${(result.snapshotJsonBytes / 1024 / 1024).toFixed(2)} MB（${result.snapshotBytesPerCell} B/格）`,
    '[big-doc] 注意：mirror 实现只存值，官方实现更重；这是量级参考，不是容量承诺。',
  ].join('\n') + '\n');
}
