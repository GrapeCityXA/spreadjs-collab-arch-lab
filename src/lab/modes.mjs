/**
 * Architecture mode catalogue.
 *
 * This module is the single source of truth shared by the CLI, the web console,
 * the automated checks and the documentation. Everything the lab can say about a
 * deployment — its promise, its cost, its failure modes — is defined here once
 * and consumed everywhere else.
 *
 * Three canonical modes answer the question the lab exists for:
 *
 *   single   one collaboration-server process, no load balancer
 *   sharded  N processes behind a load balancer that must route a room to one node
 *            (no cross-node room sharing)
 *   shared   N processes behind a load balancer where ANY node can serve ANY room
 *            (Socket.IO Redis adapter + a shared document store)
 *
 * Three "variants" reproduce the failure modes that customers actually hit. They
 * are first-class because they are the lesson: a topology you *think* is shared
 * but isn't is worse than one you know is partitioned.
 */

export const MODE_IDS = ['single', 'sharded', 'shared'];
export const VARIANT_IDS = ['broken-sharded', 'broken-adapter-only', 'broken-no-adapter'];

/** Canonical modes. */
export const MODES = {
  single: {
    id: 'single',
    label: '单机部署',
    labelEn: 'Single server',
    tagline: '一个协同服务进程，所有房间、所有文档都在这里面。',
    summary:
      '最简单的部署形态：客户端直连唯一的协同服务节点。没有负载均衡、没有跨节点通信、没有共享存储。' +
      '容量上限就是这一个进程的容量上限。',
    topology: { nodes: 1, lb: false, adapter: false, affinity: null, store: 'local' },
    promise: {
      scope: 'single-node',
      crossNodeRealtime: 'n/a',
      joinConsistent: true,
      storeConsistent: true,
    },
    whenToUse: [
      '真实工作簿与目标编辑频率经过单进程测试，延迟和资源占用符合要求',
      '可以接受进程重启期间协同短暂中断（单点）',
      '希望部署与排障成本最低，先验证业务再做扩容',
    ],
    notFor: [
      '要求服务高可用、滚动升级不停协同',
      '需要靠增加进程水平扩容',
      '需要多副本 / 多可用区部署',
    ],
    cost: '1 个进程 + 1 个存储',
    risk: '单进程可能先受广播、文档运算或存储串行路径限制；历史广播系数不能保证当前版本容量，见 docs/05-performance.md。',
    requires: { redis: false, license: false, browser: false },
    docker: 'none',
  },

  sharded: {
    id: 'sharded',
    label: '分区多机（不共享 room）',
    labelEn: 'Sharded multi-server (no cross-node room sharing)',
    tagline: 'N 个进程各自独立，负载均衡只负责“选一个进程”；同一个房间必须被路由到同一个进程。',
    summary:
      '每个协同服务进程完全独立：没有 Redis 适配器、没有共享文档库。负载均衡按房间做亲和路由' +
      '（room key → 固定节点），因此同一个房间的用户一定落在同一个进程上，进程之间不需要看见彼此的房间里有什么。' +
      '横向扩容靠“更多房间 → 更多进程”，而不是“一个房间摊到多个进程”。',
    topology: { nodes: 3, lb: true, adapter: false, affinity: 'room', store: 'local' },
    promise: {
      scope: 'same-node-only',
      crossNodeRealtime: 'not-required',
      joinConsistent: true,
      storeConsistent: 'per-room',
    },
    whenToUse: [
      '房间/文档天然可以按租户、业务线或文档 ID 做分区，且路由层能保证亲和',
      '同一个文档的协作者数量有上限，单进程能承载',
      '想水平扩容，但不愿意引入 Redis 与共享数据库',
      '希望节点故障只影响它承载的那部分房间（爆炸半径可控）',
    ],
    notFor: [
      '无法保证同一房间的连接落到同一节点（随机负载均衡、无粘性自动扩缩容）',
      '要求任意节点都能服务任意文档（例如用户被调度到任意副本）',
    ],
    cost: 'N 个进程 + 1 个负载均衡器（亲和路由）',
    risk:
      '这是最危险的“看起来能扩”的形态：负载均衡一旦没有亲和，同一房间会被拆到不同节点，' +
      '跨节点消息静默丢失（不报错、不重试），而“最终数据一致”的检查还可能假过（本仓库 P1-3 实测）。',
    requires: { redis: false, license: false, browser: false },
    docker: 'none',
  },

  shared: {
    id: 'shared',
    label: '共享 room 多机',
    labelEn: 'Shared-room multi-server',
    tagline: 'N 个进程 + Redis 适配器 + 共享文档库；任意节点都能服务同一个房间。',
    summary:
      '每个进程都注入同一个 Socket.IO Redis 适配器，房间广播通过 Redis Pub/Sub 跨节点转发；' +
      '文档状态放在所有进程共享的存储里（演示用共享 SQLite 文件，生产建议 PostgreSQL）。' +
      '于是负载均衡可以随意分发：同一个房间的成员落在哪些节点都行。',
    topology: { nodes: 3, lb: true, adapter: true, affinity: null, store: 'shared' },
    promise: {
      scope: 'any-node',
      crossNodeRealtime: true,
      joinConsistent: true,
      storeConsistent: true,
    },
    whenToUse: [
      '同一文档的协作者可能被分发到任意节点，无法做亲和',
      '要求任意节点故障后，客户端重连到其它节点仍能继续协同',
      '需要验证同一文档跨节点连接时的同步路径；单文档吞吐仍须单独测试',
    ],
    notFor: [
      '不愿意维护 Redis 与共享数据库（组件更多、排障面更大）',
      '单机容量已经够用，且能接受单点',
    ],
    cost: 'N 个进程 + 负载均衡器 + Redis + 共享数据库',
    risk:
      '组件更多；广播、文档状态和存储都可能限制容量，历史广播模型不能代表全部开销；' +
      'Redis 与共享库还需分别验证容量和故障切换。',
    requires: { redis: true, license: false, browser: false },
    docker: 'redis',
  },
};

/**
 * Teaching variants: real configurations that customers ship by accident.
 * They are reproduced on purpose so the lab can show — with numbers — what breaks.
 */
export const VARIANTS = {
  'broken-sharded': {
    id: 'broken-sharded',
    label: '反模式 A：分区多机但负载均衡没有亲和',
    labelEn: 'Anti-pattern A: sharded without room affinity',
    basedOn: 'sharded',
    overrides: { affinity: 'none' },
    predicts: ['room.placement'],
    teachingNote:
      '同一个房间的两个人被负载均衡分到不同节点。节点之间没有任何跨节点通道，' +
      '所以一方的编辑永远到不了另一方——而且不报错、不重试。“最终一致”检查可能仍然通过，' +
      '因为客户端重连或重新加载时会从各自节点的库里“追平”。',
  },
  'broken-adapter-only': {
    id: 'broken-adapter-only',
    label: '反模式 B：只加了 Redis 适配器，文档库还是各节点一份',
    labelEn: 'Anti-pattern B: adapter added, document store still per-node',
    basedOn: 'shared',
    overrides: { store: 'local' },
    predicts: ['join.consistency', 'store.consistency'],
    teachingNote:
      '实时广播通了，所以“两个人能看到对方改单元格”。但文档状态每个节点各存一份：' +
      '新用户如果被分到另一个节点，看到的是空文档；节点之间也不会收敛。' +
      '适配器只解决“消息怎么到达”，不解决“文档存在哪里”。',
  },
  'broken-no-adapter': {
    id: 'broken-no-adapter',
    label: '反模式 C：文档库共享了，但忘了注入 Redis 适配器',
    labelEn: 'Anti-pattern C: shared store, missing Redis adapter',
    basedOn: 'shared',
    overrides: { adapter: false },
    predicts: ['realtime.crossNode', 'eventual.mask'],
    teachingNote:
      '数据看起来最终一致（所有人重新加载后内容都对），但实时协同是断的：' +
      '跨节点的人 2 秒内收不到对方的编辑。这是最难验收的一种坏法——' +
      '只比对最终快照会“通过”，只有按有界时间验证投递才会暴露。',
  },
};

/** Merge a mode (or variant) with caller overrides into one effective config. */
export function expandConfig({ mode = 'single', variant = null, remoteNodes = 0, ...overrides } = {}) {
  const base = variant ? VARIANTS[variant] : MODES[mode];
  if (!base) throw new Error(`unknown mode "${mode}" / variant "${variant}"`);
  const target = variant ? MODES[base.basedOn] : base;
  const cfg = {
    mode: variant ? base.basedOn : mode,
    variant: variant ?? null,
    nodes: target.topology.nodes,
    lb: target.topology.lb,
    adapter: target.topology.adapter,
    affinity: target.topology.affinity,
    store: target.topology.store,
    impl: 'mirror',
    presence: false,
    ...(base.overrides ?? {}),
  };
  // Only accept overrides that are actual dials.
  for (const key of ['nodes', 'lb', 'adapter', 'affinity', 'store', 'impl', 'presence']) {
    if (overrides[key] !== undefined && overrides[key] !== null) cfg[key] = overrides[key];
  }
  cfg.nodes = Math.max(1, Number(cfg.nodes) || 1);
  // `nodes` counts controller-local processes. One local process plus agents is
  // still a multi-node topology and needs its normal LB/adapter/store settings.
  if (cfg.nodes === 1 && remoteNodes === 0) {
    cfg.lb = false;
    cfg.adapter = false;
    cfg.affinity = null;
    cfg.store = 'local';
  }
  // `shared` promises cross-node sharing, so it cannot run without an adapter.
  if (cfg.mode === 'shared' && cfg.adapter === true && overrides.adapter === undefined && !variant) {
    cfg.adapter = true;
  }
  if (cfg.mode === 'shared' && cfg.store === 'local' && !variant) {
    // A shared-room deployment may still pick a local store on purpose, but the
    // checks will flag it. Keep the dial honest instead of silently "fixing" it.
  }
  if (cfg.mode === 'sharded' && cfg.affinity === null) cfg.affinity = 'room';
  if (cfg.mode === 'single') cfg.presence = false;
  cfg.requires = {
    redis: Boolean(cfg.adapter),
    license: cfg.impl === 'real',
    browser: cfg.impl === 'real',
    sharedStore: cfg.store === 'shared',
  };
  return cfg;
}

/** Human-readable one-liner for a config, used by CLI output and the web console. */
export function describeConfig(cfg) {
  const parts = [
    `${cfg.nodes} 节点`,
    cfg.lb ? '负载均衡' : '无负载均衡',
    cfg.adapter ? 'Redis 适配器' : '无跨节点适配器',
  ];
  if (cfg.affinity) parts.push(`亲和=${cfg.affinity}`);
  parts.push(`文档库=${cfg.store === 'shared' ? '共享' : '每节点本地'}`);
  if (cfg.impl === 'real') parts.push('官方实现');
  if (cfg.variant) parts.push(`变体=${cfg.variant}`);
  return parts.join(' · ');
}

/**
 * What a user is entitled to expect from this configuration.
 *
 * The check runner compares observations against these expectations. A mismatch is
 * not a test bug: it is the finding. `'n/a'` means "this topology makes no promise
 * either way", `'record'` means "measure and report, pass/fail is meaningless".
 */
export function expectations(cfg) {
  const multi = cfg.nodes > 1;
  const hasLb = Boolean(cfg.lb);
  const e = {};

  e['nodes.health'] = 'pass';
  e['topology.config'] = 'pass';
  e['lb.distribution'] = multi && hasLb ? 'pass' : 'n/a';

  if (!multi) e['room.placement'] = 'n/a';
  else if (cfg.mode === 'sharded') e['room.placement'] = 'colocated';
  else e['room.placement'] = 'record';

  e['realtime.sameNode'] = 'pass';
  if (!multi) e['realtime.crossNode'] = 'n/a';
  // `shared` is the only topology that *promises* cross-node room traffic. It must
  // pass even when the user has also turned the adapter off: that combination is a
  // defect of the deployment, not a different promise.
  else if (cfg.mode === 'shared') e['realtime.crossNode'] = 'pass';
  else e['realtime.crossNode'] = 'not-required';

  // Joining the same room on a different node and seeing the same document.
  if (!multi) e['join.consistency'] = 'n/a';
  else if (cfg.mode === 'shared') e['join.consistency'] = 'pass';
  else e['join.consistency'] = 'record';

  // Do all nodes that hold the room agree on its document version?
  if (!multi) e['store.consistency'] = 'n/a';
  else if (cfg.mode === 'shared') e['store.consistency'] = 'pass';
  else e['store.consistency'] = 'record';

  e['isolation.rooms'] = 'pass';
  e['ack.latency'] = 'record';
  // The user's own scenario, measured once through the topology entry. It is a
  // number, not a promise: every mode records it (there is no "correct" p95).
  e['load.scenario'] = 'record';
  // Only a multi-node topology can be fooled by "eventually consistent, never live".
  e['eventual.mask'] = multi ? 'not-dangerous' : 'n/a';

  return e;
}

/** Everything the API/UI needs to render the mode picker. */
export function catalogue() {
  return {
    modes: MODE_IDS.map((id) => {
      const m = MODES[id];
      return {
        id: m.id,
        label: m.label,
        labelEn: m.labelEn,
        tagline: m.tagline,
        summary: m.summary,
        topology: m.topology,
        promise: m.promise,
        whenToUse: m.whenToUse,
        notFor: m.notFor,
        cost: m.cost,
        risk: m.risk,
        requires: m.requires,
      };
    }),
    variants: VARIANT_IDS.map((id) => {
      const v = VARIANTS[id];
      return {
        id: v.id,
        label: v.label,
        labelEn: v.labelEn,
        basedOn: v.basedOn,
        overrides: v.overrides,
        teachingNote: v.teachingNote,
      };
    }),
  };
}

/** Comparison matrix used by the docs and the console's "compare" view. */
export function comparisonMatrix() {
  const rows = [
    ['负载均衡把同一房间拆到不同节点时', '不可能（只有一个节点）', '❌ 消息静默丢失', '✅ 通过 Redis 转发'],
    ['任意节点都能服务任意文档', '✅（唯一节点）', '❌ 只能服务亲和到它的房间', '✅'],
    ['横向扩容', '只能纵向扩容', '✅ 按房间分区扩容', '✅ 按连接/房间扩容'],
    ['需要 Redis', '否', '否', '✅ 是'],
    ['需要共享文档库', '否', '否', '✅ 是'],
    ['节点故障影响范围', '全部协同中断', '该节点承载的房间中断', '客户端重连到其它节点继续'],
    ['部署/排障复杂度', '低', '中（亲和路由是硬要求）', '高（多一个 Redis + 共享库）'],
    ['主要成本', '单进程广播扇出', '每节点扇出（房间不跨节点）', '广播扇出 + Redis 转发'],
  ];
  return {
    headers: ['关心的问题', '单机 single', '分区多机 sharded', '共享多机 shared'],
    rows,
  };
}
