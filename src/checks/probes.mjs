/**
 * The architecture checks, mirror engine.
 *
 * Every probe answers one question a person choosing an architecture actually asks,
 * and records the observation even when the answer is "this topology does not
 * promise that". The classification of pass/fail/expected-failure happens in
 * `runner.mjs` against `expectations(cfg)`; this file only measures.
 *
 * The single most important detail here is BOUNDED-TIME delivery
 * (`CROSS_NODE_TIMEOUT_MS`). An earlier iteration of this project proved that
 * "eventually the document looks consistent" can pass while realtime collaboration
 * is completely broken, because clients lazily catch up from a shared store. Any
 * check based on final snapshots only would bless exactly the defect this lab
 * exists to expose.
 */
import { openClient, closeAll } from './mirror-client.mjs';
import { getJson, sleep } from '../lab/ports.mjs';

/** If a cross-node edit is not received within this window, realtime is broken. */
export const CROSS_NODE_TIMEOUT_MS = 2000;

/** Number of writes used for the latency distribution. */
const ACK_SAMPLES = 10;

function stats(samples) {
  if (!samples.length) return { p50: null, p95: null, p99: null, max: null, samples: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1) + 0.5))];
  return {
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted[sorted.length - 1],
    samples: sorted.length,
  };
}

function unique(values) {
  return [...new Set(values.filter((v) => v !== null && v !== undefined))];
}

/** GET a node's document record without trusting a client. */
async function fetchDoc(node, room) {
  try {
    const res = await getJson(`${node.base}/docs?room=${encodeURIComponent(room)}`);
    if (res.status === 200 && res.body && typeof res.body === 'object') {
      return { present: true, version: Number(res.body.version ?? 0), cells: res.body.cells ?? {} };
    }
    return { present: false, version: null, cells: null };
  } catch {
    return { present: false, version: null, cells: null, error: true };
  }
}

/* -------------------------------------------------------------------------- */
/* probes                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * How a node is named in check details. A remote node's port is identical to the
 * controller's own node port (8081), so `:8081` alone is ambiguous — always include the
 * host for remote nodes, and say `远端` so the reader knows where to look.
 */
function nodeTag(node) {
  return node.remote ? `${node.host ?? node.base}:${node.port}(远端)` : `:${node.port}`;
}

async function probeNodesHealth(ctx) {
  const rows = [];
  for (const node of ctx.nodes) {
    try {
      const res = await getJson(`${node.base}/health`);
      rows.push({ nodeId: node.nodeId, port: node.port, tag: nodeTag(node), ok: res.ok && res.body?.ok === true, body: res.body });
    } catch (err) {
      rows.push({ nodeId: node.nodeId, port: node.port, tag: nodeTag(node), ok: false, error: err.message });
    }
  }
  let lbOk = null;
  if (ctx.lb) {
    try {
      const res = await getJson(`${ctx.lb.base}/healthz`);
      lbOk = res.ok && (res.body === 'ok' || res.body?.ok === true);
    } catch {
      lbOk = false;
    }
  }
  const pass = rows.every((r) => r.ok) && (lbOk === null || lbOk === true);
  return {
    id: 'nodes.health',
    label: '服务节点与负载均衡健康',
    pass,
    detail: pass
      ? `${rows.length} 个节点全部健康${lbOk === null ? '' : '，负载均衡健康'}`
      : `不健康：${rows.filter((r) => !r.ok).map((r) => r.tag).join(', ')}${lbOk === false ? ' 负载均衡' : ''}`,
    metrics: { nodes: rows.length, lb: lbOk },
  };
}

async function probeTopologyConfig(ctx) {
  const mismatches = [];
  for (const node of ctx.nodes) {
    const tag = nodeTag(node);
    try {
      const res = await getJson(`${node.base}/health`);
      const h = res.body ?? {};
      if (h.impl && h.impl !== ctx.cfg.impl) mismatches.push(`${tag} impl=${h.impl} ≠ ${ctx.cfg.impl}`);
      if (typeof h.adapterEnabled === 'boolean' && h.adapterEnabled !== Boolean(ctx.cfg.adapter)) {
        mismatches.push(`${tag} adapter=${h.adapterEnabled} ≠ ${Boolean(ctx.cfg.adapter)}`);
      }
      const storeMode = h.storeMode ?? h.store;
      if (storeMode && storeMode !== ctx.cfg.store) mismatches.push(`${tag} store=${storeMode} ≠ ${ctx.cfg.store}`);
    } catch (err) {
      mismatches.push(`${tag} 无法读取配置（${err.message}）`);
    }
  }
  if (ctx.lb) {
    try {
      const res = await getJson(`${ctx.lb.base}/__lb/state`);
      const strategy = res.body?.strategy;
      if (strategy && ctx.lb.strategy && strategy !== ctx.lb.strategy) {
        mismatches.push(`负载均衡策略=${strategy} ≠ ${ctx.lb.strategy}`);
      }
    } catch (err) {
      mismatches.push(`负载均衡无法读取状态（${err.message}）`);
    }
  }
  const pass = mismatches.length === 0;
  return {
    id: 'topology.config',
    label: '运行中的配置与所选拓扑一致',
    pass,
    detail: pass ? `实际运行配置 = ${ctx.cfg.mode}${ctx.cfg.variant ? `/${ctx.cfg.variant}` : ''}` : mismatches.join('；'),
    metrics: { mismatches: mismatches.length },
  };
}

async function probeLbDistribution(ctx) {
  if (!ctx.lb) {
    return { id: 'lb.distribution', label: '负载均衡把连接分到多个节点', pass: null, detail: '该拓扑没有负载均衡（单机）', metrics: {} };
  }
  const wanted = Math.min(12, Math.max(6, ctx.nodes.length * 4));
  const clients = [];
  const placed = [];
  try {
    for (let i = 0; i < wanted; i++) {
      // Distinct rooms on purpose: a room-affinity balancer is *supposed* to keep one
      // room on one node, so spreading can only be observed across rooms.
      const client = await openClient({
        url: ctx.lb.base,
        path: ctx.path,
        roomId: `${ctx.roomId}-lb-${i}`,
        label: `lb-${i}`,
      });
      clients.push(client);
      placed.push(client.nodeId);
    }
  } finally {
    closeAll(clients);
  }
  const perNode = {};
  for (const id of placed) perNode[id ?? 'unknown'] = (perNode[id ?? 'unknown'] ?? 0) + 1;
  const distinct = unique(placed).length;
  const pass = ctx.nodes.length > 1 ? distinct >= 2 : null;
  return {
    id: 'lb.distribution',
    label: '负载均衡把连接分到多个节点',
    pass,
    detail: pass
      ? `${wanted} 个连接（${wanted} 个不同房间）落在 ${distinct} 个节点：${Object.entries(perNode).map(([k, v]) => `${k}×${v}`).join('，')}`
      : `只落在 ${distinct} 个节点（期望至少 2 个）`,
    metrics: { clients: wanted, distinctNodes: distinct, perNode },
  };
}

async function probeRoomPlacement(ctx) {
  if (!ctx.lb) {
    return { id: 'room.placement', label: '同一房间的成员是否落在同一节点', pass: null, detail: '没有负载均衡，不存在放置问题', metrics: {} };
  }
  const room = `${ctx.roomId}-place`;
  const clients = [];
  const placed = [];
  try {
    // Sequential on purpose: least_conn can put two simultaneous connections on the
    // same upstream before either is counted, which would fake "colocation".
    for (const label of ['alice', 'bob', 'carol']) {
      const client = await openClient({ url: ctx.lb.base, path: ctx.path, roomId: room, label });
      clients.push(client);
      placed.push(client.nodeId);
    }
  } finally {
    closeAll(clients);
  }
  const distinct = unique(placed).length;
  const colocated = distinct === 1;
  return {
    id: 'room.placement',
    label: '同一房间的成员落在同一节点',
    pass: ctx.cfg.mode === 'sharded' ? colocated : null,
    detail: colocated
      ? `3 个客户端全部落在 ${placed[0]}`
      : `同一房间被拆到 ${distinct} 个节点（${placed.join(' / ')}）`,
    metrics: { nodesUsed: distinct, placement: placed },
  };
}

async function probeRealtimeSameNode(ctx) {
  const node = ctx.nodes[0];
  const room = `${ctx.roomId}-same`;
  const writer = await openClient({ url: node.base, path: ctx.path, roomId: room, label: 'writer' });
  const reader = await openClient({ url: node.base, path: ctx.path, roomId: room, label: 'reader' });
  try {
    const value = `same-${Date.now()}`;
    const wait = reader.waitFor('op', (op) => op.value === value, CROSS_NODE_TIMEOUT_MS);
    const sentAt = Date.now();
    await writer.setCell(0, 0, value);
    let received = null;
    try {
      received = await wait;
    } catch {
      received = null;
    }
    return {
      id: 'realtime.sameNode',
      label: '同节点实时协同',
      pass: Boolean(received),
      detail: received
        ? `同节点写入后 ${Date.now() - sentAt}ms 内对方收到`
        : `${CROSS_NODE_TIMEOUT_MS}ms 内没收到（同节点本应最快，说明链路本身有问题）`,
      metrics: { latencyMs: received ? received.receivedAt - sentAt : null },
    };
  } finally {
    closeAll([writer, reader]);
  }
}

async function probeIsolation(ctx) {
  const node = ctx.nodes[0];
  const roomA = `${ctx.roomId}-iso-a`;
  const roomB = `${ctx.roomId}-iso-b`;
  const a = await openClient({ url: node.base, path: ctx.path, roomId: roomA, label: 'room-a' });
  const b = await openClient({ url: node.base, path: ctx.path, roomId: roomB, label: 'room-b' });
  try {
    const value = `iso-${Date.now()}`;
    const leaked = b.waitFor('op', (op) => op.value === value, 800).then(() => true).catch(() => false);
    await a.setCell(0, 3, value);
    const didLeak = await leaked;
    return {
      id: 'isolation.rooms',
      label: '不同房间互相隔离',
      pass: !didLeak,
      detail: didLeak ? '房间 B 收到了房间 A 的编辑（房间隔离被破坏）' : '房间 B 没有收到房间 A 的编辑',
      metrics: {},
    };
  } finally {
    closeAll([a, b]);
  }
}

async function probeAckLatency(ctx) {
  const node = ctx.nodes[0];
  const room = `${ctx.roomId}-ack`;
  const client = await openClient({ url: node.base, path: ctx.path, roomId: room, label: 'ack' });
  const samples = [];
  try {
    for (let i = 0; i < ACK_SAMPLES; i++) {
      const ack = await client.setCell(i, 0, `ack-${i}`);
      if (typeof ack.latencyMs === 'number') samples.push(ack.latencyMs);
      await sleep(20);
    }
  } finally {
    closeAll([client]);
  }
  const s = stats(samples);
  return {
    id: 'ack.latency',
    label: '写入确认延迟（本机）',
    pass: null,
    detail: `写入 ${s.samples} 次：p50 ${s.p50}ms / p95 ${s.p95}ms / p99 ${s.p99}ms / max ${s.max}ms`,
    metrics: { ackMs: s },
  };
}

/**
 * Cross-node coherence: realtime delivery, join consistency, store consistency and
 * the "eventual consistency masks a broken realtime path" trap, measured once on one
 * room so the four numbers describe the same document.
 */
async function probeCrossNodeCoherence(ctx) {
  const results = [];
  const na = (id, label, detail) => results.push({ id, label, pass: null, detail, metrics: {} });

  if (ctx.nodes.length < 2) {
    na('realtime.crossNode', '跨节点实时协同', '单节点拓扑不存在跨节点场景');
    na('join.consistency', '在另一个节点加入房间仍能看到文档', '单节点拓扑不存在跨节点场景');
    na('store.consistency', '各节点上的文档版本一致', '单节点拓扑不存在跨节点场景');
    na('eventual.mask', '“最终一致但实时不通”的危险组合', '单节点拓扑不存在跨节点场景');
    return results;
  }

  const room = `${ctx.roomId}-cross`;
  const writerNode = ctx.nodes[0];
  const readerNode = ctx.nodes[1];
  const writer = await openClient({ url: writerNode.base, path: ctx.path, roomId: room, label: 'writer' });
  const reader = await openClient({ url: readerNode.base, path: ctx.path, roomId: room, label: 'reader' });
  const value = `cross-${Date.now()}`;
  let received = null;
  try {
    const wait = reader.waitFor('op', (op) => op.value === value, CROSS_NODE_TIMEOUT_MS);
    const sentAt = Date.now();
    await writer.setCell(0, 1, value);
    try {
      received = await wait;
    } catch {
      received = null;
    }
    results.push({
      id: 'realtime.crossNode',
      label: '跨节点实时协同（有界时间投递）',
      pass: Boolean(received),
      detail: received
        ? `${writerNode.nodeId} 的编辑在 ${received.receivedAt - sentAt}ms 内到达 ${readerNode.nodeId}`
        : `${CROSS_NODE_TIMEOUT_MS}ms 内 ${readerNode.nodeId} 没有收到 ${writerNode.nodeId} 的编辑（消息静默丢失）`,
      metrics: { latencyMs: received ? received.receivedAt - sentAt : null, timeoutMs: CROSS_NODE_TIMEOUT_MS },
    });

    // ---- join consistency: a fresh client on ANOTHER node joins the same room ----
    const joiner = await openClient({ url: readerNode.base, path: ctx.path, roomId: room, label: 'joiner' });
    try {
      const sameVersion = joiner.version === writer.version;
      const sameCell = joiner.getCell(0, 1) === value;
      results.push({
        id: 'join.consistency',
        label: '在另一个节点加入房间仍能看到文档',
        pass: sameVersion && sameCell,
        detail: sameVersion && sameCell
          ? `新客户端在 ${readerNode.nodeId} 加入，看到版本 ${joiner.version} 与写入内容`
          : `新客户端在 ${readerNode.nodeId} 加入，版本 ${joiner.version}（写入端 ${writer.version}）` +
            `${sameCell ? '' : '，且看不到刚写入的单元格'}`,
        metrics: { writerVersion: writer.version, joinerVersion: joiner.version },
      });
    } finally {
      closeAll([joiner]);
    }

    // ---- store consistency: ask every node what version of this room it holds ----
    const perNode = [];
    for (const node of ctx.nodes) {
      const doc = await fetchDoc(node, room);
      perNode.push({ nodeId: node.nodeId, version: doc.version, present: doc.present });
    }
    const present = perNode.filter((p) => p.present);
    const versions = unique(present.map((p) => p.version));
    const allNodesHaveIt = present.length === ctx.nodes.length;
    const consistent = allNodesHaveIt && versions.length === 1;
    results.push({
      id: 'store.consistency',
      label: '各节点上的文档版本一致',
      pass: consistent,
      detail: consistent
        ? `全部 ${ctx.nodes.length} 个节点都持有该房间，版本 ${versions[0]}`
        : `持有该房间的节点：${present.length}/${ctx.nodes.length}，版本：${versions.join(', ') || '无'}`,
      metrics: { perNode, versions },
    });

    // ---- the trap: does a reload make a broken realtime path look fine? ----
    if (received) {
      results.push({
        id: 'eventual.mask',
        label: '“最终一致但实时不通”的危险组合',
        pass: true,
        detail: '实时投递正常，不存在“最终一致掩盖实时断裂”的情况',
        metrics: { dangerous: false },
      });
    } else {
      await sleep(CROSS_NODE_TIMEOUT_MS + 500);
      const reloader = await openClient({ url: readerNode.base, path: ctx.path, roomId: room, label: 'reloader' });
      let dangerous = false;
      let reloadedVersion = reloader.version;
      try {
        dangerous = reloader.version === writer.version && reloader.getCell(0, 1) === value;
        reloadedVersion = reloader.version;
      } finally {
        closeAll([reloader]);
      }
      results.push({
        id: 'eventual.mask',
        label: '“最终一致但实时不通”的危险组合',
        pass: !dangerous,
        detail: dangerous
          ? `实时不通，但重新加入后版本变成 ${reloadedVersion}（与写入端一致）：只比对最终数据会误判为“协同正常”`
          : `实时不通，重新加入后版本仍为 ${reloadedVersion}：最终数据也不一致，问题会暴露得比较明显`,
        metrics: { dangerous, writerVersion: writer.version, reloadedVersion },
      });
    }
  } finally {
    closeAll([writer, reader]);
  }
  return results;
}

/**
 * Run every mirror probe.
 *
 * @param {{cfg: object, stack: object, nodes: Array, lb: object|null, path: string, roomId: string, progress?: Function}} ctx
 * @returns {Promise<Array<{id,label,pass,detail,metrics}>>}
 */
export async function runMirrorProbes(ctx) {
  const results = [];
  const step = async (fn) => {
    const out = await fn(ctx);
    for (const item of Array.isArray(out) ? out : [out]) {
      results.push(item);
      ctx.progress?.({ id: item.id, label: item.label, pass: item.pass, detail: item.detail });
    }
  };

  await step(probeNodesHealth);
  await step(probeTopologyConfig);
  await step(probeLbDistribution);
  await step(probeRoomPlacement);
  await step(probeRealtimeSameNode);
  await step(probeCrossNodeCoherence);
  await step(probeIsolation);
  await step(probeAckLatency);

  return results;
}
