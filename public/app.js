/**
 * Lab console — vanilla JS, no framework, no build step.
 *
 * The console is a thin presentation layer over the web API (DEV-CONTRACT §7):
 *   /api/catalogue, /api/stack, /api/stack/up|down, /api/check[/:jobId],
 *   /api/bench[/:jobId], /api/report/latest.
 *
 * Scenario (DEV-CONTRACT §11): users / seconds-per-edit / duration / rooms are
 * read from the catalogue defaults + limits, converted to the internal shape
 * (<seconds> -> ms) and sent with both check and bench. The derived line uses
 * the same formula as src/lab/scenario.mjs so the UI cannot disagree with it.
 *
 * Multi-machine (DEV-CONTRACT §12): the console only lists the agents that
 * /api/stack reports and forwards their URLs in the next POST /api/stack/up.
 * It never starts an agent process.
 *
 * Design rules:
 *  - the API owns the facts (mode copy, comparison matrix, check results); this file
 *    only normalises the envelopes and renders them, so the docs and the UI cannot drift;
 *  - every number shown in the topology panel comes from a live GET /api/stack poll;
 *  - the client iframes are only created when the user opens them, and are never
 *    recreated by the polling loop (that would reload the collaborative clients).
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ state */
  var state = {
    catalogue: null,
    comparison: null,
    environment: null,
    stack: null,
    stackError: null,
    apiError: null,
    busy: '',
    check: { jobId: null, timer: null, view: null, lastJob: null },
    bench: { jobId: null, timer: null, status: 'idle', stats: null, error: null, scenario: null, request: null },
    scenarioTouched: false,
    scenarioDefaults: null,
    scenarioLimits: null,
    pendingAgents: [],
    slots: [],
    pollTimer: null,
    clientTimer: null,
    noticeTimer: null,
    room: 'arch-lab-demo',
    lastAction: '',
  };

  /* Contract fallbacks only used when /api/catalogue predates the scenario block.
   * When the API provides scenario.defaults / scenario.limits these are ignored. */
  var SCENARIO_FALLBACK_DEFAULTS = {
    check: { users: 20, opIntervalMs: 2000, durationMs: 8000, rooms: 1 },
    bench: { users: 50, opIntervalMs: 600, durationMs: 20000, rooms: 1 },
  };
  var SCENARIO_FALLBACK_LIMITS = {
    users: { min: 1, max: 100000 },
    opIntervalMs: { min: 50, max: 3600000 },
    durationMs: { min: 1000, max: 600000 },
    rooms: { min: 1, max: 10000 },
  };
  var CORES_PER_FANOUT = 12700; // same constant as src/lab/scenario.mjs (modelScenario)

  var MODE_ICONS = { single: '▣', sharded: '⧉', shared: '☷' };
  var MODE_CTA = {
    single: '启动单机架构',
    sharded: '启动分区多机',
    shared: '启动共享多机',
  };
  var STATUS_TEXT = {
    pass: '通过',
    fail: '失败',
    'n/a': '不适用',
    record: '仅记录',
    'expected-failure': '预期失败',
    running: '执行中',
    pending: '等待中',
  };
  var EXPECTATION_TEXT = {
    pass: '应通过',
    'n/a': '无承诺',
    record: '仅记录',
    colocated: '必须同节点',
    'not-required': '非本架构契约',
    'not-dangerous': '不应出现',
  };
  var SUMMARY_TEXT = {
    healthy: '健康',
    degraded: '降级',
    broken: '已破坏',
    'expected-broken': '预期破坏',
  };

  /* -------------------------------------------------------------------- dom */
  function $(id) { return document.getElementById(id); }

  function h(tag, props, children) {
    var node = document.createElement(tag);
    if (props) {
      for (var key in props) {
        if (!Object.prototype.hasOwnProperty.call(props, key)) continue;
        var value = props[key];
        if (value === undefined || value === null || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = String(value);
        else if (key === 'html') node.innerHTML = value;
        else if (key === 'value') node.value = value;
        else if (key === 'disabled') node.disabled = Boolean(value);
        else if (key === 'checked') node.checked = Boolean(value);
        else if (key === 'style' && typeof value === 'object') {
          for (var s in value) node.style[s] = value[s];
        } else if (key.indexOf('on') === 0 && typeof value === 'function') {
          node.addEventListener(key.slice(2).toLowerCase(), value);
        } else {
          node.setAttribute(key, String(value));
        }
      }
    }
    if (children) appendChildren(node, children);
    return node;
  }

  function appendChildren(node, children) {
    if (children === undefined || children === null) return node;
    var list = Array.isArray(children) ? children : [children];
    for (var i = 0; i < list.length; i++) {
      var child = list[i];
      if (child === undefined || child === null || child === false) continue;
      if (Array.isArray(child)) { appendChildren(node, child); continue; }
      node.appendChild(typeof child === 'string' || typeof child === 'number'
        ? document.createTextNode(String(child)) : child);
    }
    return node;
  }

  function clearNode(node) {
    if (!node) return node;
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  function text(value) {
    return value === undefined || value === null || value === '' ? '—' : String(value);
  }

  function badge(labelText, kind) {
    return h('span', { class: 'badge ' + (kind || 'gray'), text: labelText });
  }

  function flash(message, kind) {
    var el = $('notice');
    if (!el) return;
    el.className = 'notice show ' + (kind || '');
    clearNode(el);
    el.appendChild(document.createTextNode(message));
    var close = h('button', { class: 'close', type: 'button', text: '×', onclick: hideNotice });
    el.appendChild(close);
    if (state.noticeTimer) window.clearTimeout(state.noticeTimer);
    state.noticeTimer = window.setTimeout(hideNotice, kind === 'error' ? 8000 : 4500);
  }

  function hideNotice() {
    var el = $('notice');
    if (el) el.className = 'notice';
  }

  /* -------------------------------------------------------------------- api */
  function apiFetch(path, options) {
    var opts = options || {};
    var headers = { accept: 'application/json' };
    if (opts.body) headers['content-type'] = 'application/json';
    return fetch(path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body,
      cache: 'no-store',
    }).then(function (res) {
      return res.text().then(function (raw) {
        var body = null;
        try { body = raw ? JSON.parse(raw) : null; } catch (err) { body = { raw: raw }; }
        if (!res.ok) {
          var err = new Error((body && (body.error || body.message)) || ('HTTP ' + res.status));
          err.status = res.status;
          err.detail = body && body.detail;
          throw err;
        }
        return body;
      });
    });
  }

  function errorText(err) {
    if (!err) return '未知错误';
    var msg = err.message || String(err);
    return err.detail ? msg + ' — ' + err.detail : msg;
  }

  function setApiBadge(ok, label) {
    var el = $('apiBadge');
    if (!el) return;
    el.className = 'badge ' + (ok ? 'ok' : 'err');
    el.textContent = label || (ok ? 'API 已连接' : 'API 未就绪');
  }

  /* ------------------------------------------------------------- normalisers */
  function normalizeCatalogue(raw) {
    var data = raw || {};
    var catalogue = data.catalogue || {};
    var modes = data.modes || catalogue.modes || [];
    var variants = data.variants || catalogue.variants || [];
    var comparison = data.comparison || data.comparisonMatrix || data.comparison_matrix || { headers: [], rows: [] };
    return {
      modes: Array.isArray(modes) ? modes : [],
      variants: Array.isArray(variants) ? variants : [],
      comparison: comparison,
      environment: data.environment || {},
      stackHint: data.stack || null,
      scenario: normalizeScenarioCatalogue(data.scenario || catalogue.scenario),
    };
  }

  function finiteNumber(value, fallback) {
    var n = Number(value);
    return isFinite(n) ? n : fallback;
  }

  function normalizeScenarioRange(raw, fallback) {
    if (!raw || typeof raw !== 'object') return { min: fallback.min, max: fallback.max };
    return { min: finiteNumber(raw.min, fallback.min), max: finiteNumber(raw.max, fallback.max) };
  }

  function normalizeScenarioInput(raw, fallback) {
    var src = raw && typeof raw === 'object' ? raw : {};
    return {
      users: finiteNumber(src.users, fallback.users),
      opIntervalMs: finiteNumber(src.opIntervalMs, fallback.opIntervalMs),
      durationMs: finiteNumber(src.durationMs, fallback.durationMs),
      rooms: finiteNumber(src.rooms, fallback.rooms),
    };
  }

  /** Accepts the contract shape ({defaults:{check,bench},limits,formula?}); falls back whole. */
  function normalizeScenarioCatalogue(raw) {
    var source = raw && typeof raw === 'object' ? raw : null;
    var defaults = (source && source.defaults) || {};
    var limits = (source && source.limits) || {};
    return {
      available: Boolean(source && source.defaults),
      defaults: {
        check: normalizeScenarioInput(defaults.check, SCENARIO_FALLBACK_DEFAULTS.check),
        bench: normalizeScenarioInput(defaults.bench, SCENARIO_FALLBACK_DEFAULTS.bench),
      },
      limits: {
        users: normalizeScenarioRange(limits.users, SCENARIO_FALLBACK_LIMITS.users),
        opIntervalMs: normalizeScenarioRange(limits.opIntervalMs, SCENARIO_FALLBACK_LIMITS.opIntervalMs),
        durationMs: normalizeScenarioRange(limits.durationMs, SCENARIO_FALLBACK_LIMITS.durationMs),
        rooms: normalizeScenarioRange(limits.rooms, SCENARIO_FALLBACK_LIMITS.rooms),
      },
      formula: (source && source.formula) || null,
    };
  }

  /** Accepts the Lead's canonical aggregated /api/stack shape, plus a raw state. */
  function normalizeStack(raw) {
    var empty = {
      running: false, config: {}, state: null, describe: '', urls: {},
      nodes: [], lb: null, redis: null, web: null, ports: {}, room: state.room,
      remote: [],
    };
    if (!raw || typeof raw !== 'object') return empty;
    var orchestrator = raw.state && typeof raw.state === 'object' ? raw.state : (raw.startedAt ? raw : null);
    var config = (orchestrator && orchestrator.config) || raw.config || {};
    var running = raw.running !== undefined ? Boolean(raw.running) : Boolean(orchestrator);
    var rawNodes = (Array.isArray(raw.nodes) && raw.nodes.length ? raw.nodes : (orchestrator && orchestrator.nodes) || []);
    var nodes = rawNodes.map(function (n) {
      var health = n.health || null;
      return {
        id: n.id || (health && health.nodeId) || ('node-' + n.port),
        port: n.port,
        pid: n.pid,
        healthy: n.healthy !== undefined ? Boolean(n.healthy) : Boolean(health),
        health: health,
        clients: Array.isArray(n.clients) ? n.clients : [],
        rooms: Array.isArray(n.rooms) ? n.rooms : [],
        docs: Array.isArray(n.docs) ? n.docs : [],
        error: n.error || null,
        remote: Boolean(n.remote),
        host: n.host || null,
      };
    });
    var lb = raw.lb || (orchestrator && orchestrator.lb) || null;
    var redis = raw.redis || (orchestrator && orchestrator.redis) || null;
    var web = raw.web || (orchestrator && orchestrator.web) || null;
    return {
      running: running,
      config: config,
      state: orchestrator,
      describe: raw.describe || (orchestrator && orchestrator.describe) || describeConfig(config),
      urls: raw.urls || (orchestrator && orchestrator.urls) || {},
      nodes: nodes,
      lb: lb,
      redis: redis,
      web: web,
      ports: raw.ports || (orchestrator && orchestrator.ports) || {},
      room: (orchestrator && orchestrator.room) || state.room,
      startedAt: orchestrator && orchestrator.startedAt,
      remote: Array.isArray(raw.remote) ? raw.remote : [],
    };
  }

  function describeConfig(cfg) {
    if (!cfg || !cfg.nodes) return '未运行';
    var parts = [String(cfg.nodes) + ' 节点', cfg.lb ? '负载均衡' : '无负载均衡',
      cfg.adapter ? 'Redis 适配器' : '无跨节点适配器'];
    if (cfg.affinity) parts.push('亲和=' + cfg.affinity);
    parts.push('文档库=' + (cfg.store === 'shared' ? '共享' : '每节点本地'));
    if (cfg.variant) parts.push('变体=' + cfg.variant);
    return parts.join(' · ');
  }

  function topologicalChips(topology) {
    var t = topology || {};
    var chips = [];
    chips.push(String(t.nodes || 1) + ' 个节点');
    chips.push(t.lb ? '有负载均衡' : '无负载均衡');
    chips.push(t.adapter ? 'Redis 适配器' : '无跨节点适配器');
    if (t.affinity) chips.push('亲和=' + t.affinity);
    chips.push(t.store === 'shared' ? '共享文档库' : '每节点本地库');
    return chips;
  }

  function docForRoom(node, room) {
    var docs = node.docs || [];
    for (var i = 0; i < docs.length; i++) {
      if (docs[i].roomId === room) return docs[i];
    }
    return null;
  }

  /* --------------------------------------------------------------- catalogue */
  function renderCatalogueLoaded() {
    var cat = state.catalogue;
    if (!cat) return;
    var meta = $('modesMeta');
    if (meta) {
      meta.textContent = cat.modes.length + ' 种架构 · ' + cat.variants.length + ' 个反模式 · 数据来自 /api/catalogue';
    }
    renderModeCards();
    renderVariants();
    renderComparison();
    renderEnvironment();
    renderCheckConfig();
    renderHero();
  }

  function renderModeCards() {
    var grid = $('modeCards');
    if (!grid) return;
    clearNode(grid);
    var cat = state.catalogue;
    var activeConfig = state.stack && state.stack.config;
    (cat ? cat.modes : []).forEach(function (mode) {
      var isActive = Boolean(state.stack && state.stack.running && activeConfig &&
        activeConfig.mode === mode.id && !activeConfig.variant);
      var card = h('div', { class: 'card mode-card' + (isActive ? ' active' : ''), 'data-mode': mode.id });
      var head = h('div', { class: 'mode-card-head' }, [
        h('div', { class: 'mode-icon', text: MODE_ICONS[mode.id] || '▦' }),
        h('div', {}, [
          h('div', { class: 'mode-card-title', text: mode.label }),
          h('div', { class: 'mode-card-title-en', text: mode.labelEn }),
        ]),
        isActive ? badge('当前运行', 'ok') : null,
      ]);
      card.appendChild(head);

      card.appendChild(h('div', { class: 'mode-tagline', text: mode.tagline }));

      var chips = h('div', { class: 'chips' });
      topologicalChips(mode.topology).forEach(function (labelText, index) {
        chips.appendChild(h('span', { class: 'chip' + (index === 0 ? ' strong' : ''), text: labelText }));
      });
      card.appendChild(chips);

      card.appendChild(h('div', { class: 'mode-section-label', text: '什么时候选它' }));
      var use = h('ul', { class: 'mode-list' });
      (mode.whenToUse || []).forEach(function (item) { use.appendChild(h('li', { text: item })); });
      card.appendChild(use);

      card.appendChild(h('div', { class: 'mode-section-label', text: '什么时候别选' }));
      var notFor = h('ul', { class: 'mode-list' });
      (mode.notFor || []).forEach(function (item) { notFor.appendChild(h('li', { text: item })); });
      card.appendChild(notFor);

      if (mode.risk) {
        var risk = h('div', { class: 'mode-risk' });
        risk.appendChild(h('b', { text: '最容易踩的坑：' }));
        risk.appendChild(document.createTextNode(mode.risk));
        card.appendChild(risk);
      }

      var foot = h('div', { class: 'mode-card-foot' }, [
        h('span', { class: 'mode-cost', text: '成本：' + text(mode.cost) }),
      ]);
      var startBtn = h('button', {
        class: 'btn ' + (isActive ? 'ghost' : 'primary') + ' small',
        type: 'button',
        'data-start-mode': mode.id,
        text: isActive ? '重新启动' : (MODE_CTA[mode.id] || '启动'),
        onclick: function () { startStack(mode.id, null); },
      });
      foot.appendChild(startBtn);
      card.appendChild(foot);
      grid.appendChild(card);
    });
    if (cat && !cat.modes.length) {
      grid.appendChild(h('div', { class: 'stack-empty', text: '没有从 /api/catalogue 读到任何模式。' }));
    }
  }

  function renderVariants() {
    var list = $('variantList');
    if (!list) return;
    clearNode(list);
    var cat = state.catalogue;
    (cat ? cat.variants : []).forEach(function (variant) {
      var card = h('div', { class: 'variant-card' });
      card.appendChild(h('h4', { text: variant.label }));
      card.appendChild(h('div', { class: 'based', text: '基于 ' + text(variant.basedOn) + ' · 覆盖项 ' + JSON.stringify(variant.overrides || {}) }));
      card.appendChild(h('div', { class: 'variant-note', text: variant.teachingNote || '' }));
      card.appendChild(h('button', {
        class: 'btn danger small',
        type: 'button',
        'data-start-variant': variant.id,
        text: '复现这个反模式',
        onclick: function () {
          var basedOn = variant.basedOn || 'shared';
          startStack(basedOn, variant.id);
        },
      }));
      list.appendChild(card);
    });
  }

  function renderComparison() {
    var wrap = $('comparisonTable');
    if (!wrap) return;
    clearNode(wrap);
    var comparison = state.comparison || { headers: [], rows: [] };
    var headers = comparison.headers || [];
    var rows = comparison.rows || [];
    if (!headers.length) {
      wrap.appendChild(h('div', { class: 'stack-empty', text: '比较矩阵尚未加载（GET /api/catalogue）。' }));
      return;
    }
    var table = h('table', { class: 'compare' });
    var thead = h('thead');
    var tr = h('tr');
    headers.forEach(function (labelText) { tr.appendChild(h('th', { text: labelText })); });
    thead.appendChild(tr);
    table.appendChild(thead);
    var tbody = h('tbody');
    rows.forEach(function (row) {
      var rowEl = h('tr');
      row.forEach(function (cell) { rowEl.appendChild(h('td', { text: cell })); });
      tbody.appendChild(rowEl);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
  }

  function renderEnvironment() {
    var strip = $('envStrip');
    if (!strip) return;
    clearNode(strip);
    var env = state.environment || {};
    strip.appendChild(h('span', { class: 'label', text: '环境能力' }));
    if (env.nodeVersion) strip.appendChild(envChip('Node', String(env.nodeVersion).replace(/^v/, 'v'), true));
    if (env.platform) strip.appendChild(envChip('平台', env.platform, true));
    if (env.redis) {
      var redisOk = env.redis.available !== undefined ? Boolean(env.redis.available) : Boolean(env.redis.running);
      strip.appendChild(envChip('Redis', redisOk ? ('可用' + (env.redis.mode ? ' · ' + env.redis.mode : '')) : '不可用', redisOk));
    }
    if (env.docker !== undefined) strip.appendChild(envChip('Docker', env.docker ? '可用' : '不可用', Boolean(env.docker)));
    if (env.browser) strip.appendChild(envChip('Chrome', env.browser.found ? '可用' : '未找到', Boolean(env.browser.found)));
    if (env.bundledRedis) strip.appendChild(envChip('内置 Redis', '已检测到', true));
    if (env.license) {
      var hasKey = Boolean(env.license.runtime || env.license.designer || env.license.server);
      strip.appendChild(envChip('授权', hasKey ? '已配置' : '未配置（mirror 引擎不需要）', hasKey));
    }
    if (env.licenseError) strip.appendChild(envChip('授权配置错误', env.licenseError, false));
    if (strip.children && strip.children.length === 1) {
      strip.appendChild(envChip('环境信息', 'API 未提供', false));
    }
  }

  function envChip(labelText, value, ok) {
    return h('span', { class: 'env-chip' + (ok ? ' ok' : ' warn') }, [labelText + ' ', h('b', { text: value })]);
  }

  function renderHero() {
    var host = $('heroStack');
    if (!host) return;
    clearNode(host);
    var stack = state.stack || normalizeStack(null);
    var cfg = stack.config || {};
    var rows = [
      ['状态', stack.running ? '运行中' : '未运行'],
      ['架构', stack.running ? stack.describe : '先启动一种架构'],
      ['节点', stack.running ? stack.nodes.length + ' 个' : '—'],
      ['负载均衡', stack.running ? (cfg.lb ? '已启用' : '未启用') : '—'],
      ['Redis 适配器', stack.running ? (cfg.adapter ? '已启用' : '未启用') : '—'],
      ['文档库', stack.running ? (cfg.store === 'shared' ? '共享' : '每节点本地') : '—'],
    ];
    rows.forEach(function (row) {
      host.appendChild(h('div', { class: 'row' }, [h('span', { text: row[0] }), h('b', { text: row[1] })]));
    });
    var heroBtn = $('heroStartBtn');
    if (heroBtn) {
      heroBtn.textContent = stack.running ? '重启为单机架构' : '启动单机架构';
      heroBtn.disabled = Boolean(state.busy);
    }
  }

  /* ------------------------------------------------------------------- stack */
  function renderStack() {
    renderHero();
    renderStackStatus();
    renderStackGrid();
    renderMultiMachine();
    updateClientNodeOptions();
    renderCheckConfig();
    renderModeCards();
    updateBenchControls();
  }

  function renderStackStatus() {
    var host = $('stackStatus');
    if (!host) return;
    clearNode(host);
    var stack = state.stack || normalizeStack(null);
    if (state.stackError && !stack.running) {
      host.appendChild(badge('无法读取 /api/stack', 'err'));
      host.appendChild(h('span', { class: 'describe', text: state.stackError }));
      return;
    }
    host.appendChild(badge(stack.running ? '运行中' : '未运行', stack.running ? 'ok' : 'gray'));
    host.appendChild(h('span', { class: 'describe', text: stack.running ? stack.describe : '还没有运行中的技术栈' }));
    if (stack.running && stack.startedAt) {
      host.appendChild(h('span', { class: 'muted', text: '启动于 ' + new Date(stack.startedAt).toLocaleTimeString() }));
    }
    var urls = h('div', { class: 'urls' });
    if (stack.running) {
      if (stack.urls && stack.urls.web) urls.appendChild(h('span', { class: 'url-chip', text: 'web ' + stack.urls.web }));
      // urls.lb is the *entry point*, not necessarily a load balancer: the server falls
      // back to nodes[0] when lb is disabled. Label it honestly so single mode is not
      // misread as "there is an LB".
      if (stack.lb) {
        if (stack.urls && stack.urls.lb) urls.appendChild(h('span', { class: 'url-chip', text: 'lb ' + stack.urls.lb }));
      } else if (stack.nodes.length) {
        urls.appendChild(h('span', { class: 'url-chip', text: '入口 node:' + stack.nodes[0].port }));
      }
      if (stack.ports && stack.ports.wsPath) urls.appendChild(h('span', { class: 'url-chip', text: 'ws ' + stack.ports.wsPath }));
    }
    host.appendChild(urls);
  }

  function renderStackGrid() {
    var grid = $('stackGrid');
    if (!grid) return;
    clearNode(grid);
    var stack = state.stack || normalizeStack(null);
    if (!stack.running) {
      var empty = h('div', { class: 'stack-empty' });
      empty.appendChild(h('div', {}, [
        h('b', { text: '还没有运行中的技术栈。' }),
        document.createTextNode(' 从上面的模式卡片启动一种架构，然后回到这里看实时拓扑。'),
      ]));
      empty.appendChild(h('button', {
        class: 'btn primary small', type: 'button', text: '启动单机架构',
        onclick: function () { startStack('single', null); },
      }));
      grid.appendChild(empty);
      return;
    }
    var room = currentRoom();

    /* LB */
    var lb = stack.lb;
    var lbCard = h('div', { class: 'card stack-card' });
    var lbTitle = h('div', { class: 'stack-card-title' }, [h('span', { text: '负载均衡' })]);
    if (lb) lbTitle.appendChild(badge(lb.healthy === false ? '不健康' : '存活', lb.healthy === false ? 'err' : 'ok'));
    else lbTitle.appendChild(badge('未启用', 'gray'));
    lbCard.appendChild(lbTitle);
    var lbBody = h('div', { class: 'stack-card-body' });
    if (lb) {
      lbBody.appendChild(kv('端口', text(lb.port)));
      lbBody.appendChild(kv('策略', text(lb.strategy || (lb.state && lb.state.strategy) || '—')));
      var lbState = lb.state || {};
      if (lbState.upstreams) lbBody.appendChild(kv('上游节点', String(lbState.upstreams.length || 0) + ' 个'));
      if (lbState.totals) lbBody.appendChild(kv('HTTP / WS', (lbState.totals.http || 0) + ' / ' + (lbState.totals.upgrades || 0)));
      var assignments = lbState.roomAssignments || {};
      var rooms = Object.keys(assignments);
      if (rooms.length) {
        lbBody.appendChild(h('div', { class: 'stack-kv' }, [h('span', { text: '房间亲和' }), h('b', { text: rooms.length + ' 个房间' })]));
        var list = h('div', { class: 'lb-assignments' });
        rooms.slice(0, 6).forEach(function (roomId) {
          list.appendChild(h('div', { class: 'lb-assignment' }, [h('span', { text: roomId }), h('b', { text: assignments[roomId] })]));
        });
        lbBody.appendChild(list);
      }
    } else {
      lbBody.appendChild(h('div', { class: 'stack-kv' }, [h('span', { text: '说明' }), h('b', { text: '直连节点，无代理' })]));
      if (stack.nodes.length) {
        lbBody.appendChild(h('div', { class: 'stack-kv' }, [h('span', { text: '客户端应连接' }), h('b', { text: 'node:' + stack.nodes[0].port })]));
      }
    }
    lbCard.appendChild(lbBody);
    grid.appendChild(lbCard);

    /* nodes */
    stack.nodes.forEach(function (node) {
      var card = h('div', { class: 'card stack-card' + (node.remote ? ' node-remote' : ' node-local') });
      var title = h('div', { class: 'stack-card-title' }, [
        h('span', { class: 'node-dot ' + (node.healthy ? 'ok' : 'bad') }),
        h('span', { text: '协同节点' }),
        h('span', { class: 'title-badges' }, [
          node.remote ? badge('远程 ' + (node.host || ''), 'violet') : badge('本机', 'gray'),
          badge(node.healthy ? '健康' : '异常', node.healthy ? 'ok' : 'err'),
        ]),
      ]);
      card.appendChild(title);
      card.appendChild(h('div', { class: 'node-card-big', text: node.id }));
      var doc = docForRoom(node, room);
      var metrics = h('div', { class: 'node-metrics' }, [
        h('div', { class: 'node-metric' }, [h('b', { text: String(node.clients.length) }), h('span', { text: '客户端' })]),
        h('div', { class: 'node-metric' }, [h('b', { text: doc ? String(doc.version) : '—' }), h('span', { text: '文档 v（' + room + '）' })]),
        h('div', { class: 'node-metric' }, [h('b', { text: String(node.rooms.length || 0) }), h('span', { text: '房间' })]),
      ]);
      card.appendChild(metrics);
      var body = h('div', { class: 'stack-card-body' });
      body.appendChild(kv('端口 / PID', text(node.port) + ' / ' + text(node.pid)));
      if (node.health) {
        body.appendChild(kv('实现 / 存储', text(node.health.impl) + ' / ' + (node.health.storeMode === 'shared' ? '共享' : '本地')));
        var clients = node.clients.map(function (c) { return c.label || c.id; }).slice(0, 5);
        body.appendChild(kv('成员', clients.length ? clients.join(', ') : '无'));
      }
      if (node.error) body.appendChild(h('div', { class: 'node-error', text: node.error }));
      card.appendChild(body);
      grid.appendChild(card);
    });

    /* redis */
    var redis = stack.redis;
    var redisCard = h('div', { class: 'card stack-card' });
    var redisTitle = h('div', { class: 'stack-card-title' }, [
      h('span', { text: 'Redis' }),
      redis ? badge(redis.healthy === false ? '不可用' : '已连接', redis.healthy === false ? 'err' : 'ok') : badge('未启用', 'gray'),
    ]);
    redisCard.appendChild(redisTitle);
    var redisBody = h('div', { class: 'stack-card-body' });
    if (redis) {
      redisBody.appendChild(kv('地址', text(redis.url)));
      redisBody.appendChild(kv('来源', text(redis.mode)));
      redisBody.appendChild(kv('由实验管理', redis.owned ? '是' : '否'));
      redisBody.appendChild(h('div', { class: 'stack-kv' }, [h('span', { text: '用途' }), h('b', { text: stack.config.adapter ? '跨节点广播' : '未接入适配器' })]));
    } else {
      redisBody.appendChild(h('div', { class: 'stack-kv' }, [h('span', { text: '说明' }), h('b', { text: stack.config.adapter ? '期望启用但未发现' : '本架构不需要' })]));
    }
    redisCard.appendChild(redisBody);
    grid.appendChild(redisCard);

    /* store */
    var storeCard = h('div', { class: 'card stack-card' });
    storeCard.appendChild(h('div', { class: 'stack-card-title' }, [h('span', { text: '文档存储' }), badge(stack.config.store === 'shared' ? '共享' : '每节点本地', stack.config.store === 'shared' ? 'violet' : 'gray')]));
    var storeBody = h('div', { class: 'stack-card-body' });
    storeBody.appendChild(h('div', { class: 'stack-kv' }, [h('span', { text: '存储模式' }), h('b', { text: stack.config.store || '—' })]));
    storeBody.appendChild(h('div', { class: 'stack-kv' }, [h('span', { text: '当前房间' }), h('b', { text: room })]));
    var versions = stack.nodes.map(function (n) { var d = docForRoom(n, room); return n.id + '=' + (d ? 'v' + d.version : '—'); });
    storeBody.appendChild(h('div', { class: 'stack-kv' }, [h('span', { text: '各节点版本' }), h('b', { text: versions.join(' · ') || '—' })]));
    var shared = stack.config.store === 'shared';
    storeBody.appendChild(h('div', { class: 'muted', text: shared
      ? '所有节点读写同一份文档，版本由存储层分配。'
      : '每个节点各存一份文档：换节点就是换文档，这是本模式要展示的边界。' }));
    storeCard.appendChild(storeBody);
    grid.appendChild(storeCard);

    /* web */
    if (stack.web) {
      var webCard = h('div', { class: 'card stack-card' });
      webCard.appendChild(h('div', { class: 'stack-card-title' }, [h('span', { text: '控制台 / 静态服务' }), badge(stack.web.alive === false ? '异常' : '存活', stack.web.alive === false ? 'err' : 'ok')]));
      var webBody = h('div', { class: 'stack-card-body' });
      webBody.appendChild(kv('端口', text(stack.web.port)));
      webBody.appendChild(kv('PID', text(stack.web.pid)));
      webBody.appendChild(h('div', { class: 'muted', text: '页面、/vendor、/api 都由它提供。' }));
      webCard.appendChild(webBody);
      grid.appendChild(webCard);
    }
  }

  function kv(labelText, valueText) {
    return h('div', { class: 'stack-kv' }, [h('span', { text: labelText }), h('b', { text: valueText })]);
  }

  function currentRoom() {
    var input = $('roomInput');
    var value = input && input.value ? String(input.value).trim() : '';
    return value || state.room;
  }

  /* ----------------------------------------------------------------- clients */
  var CLIENT_SLOTS = [
    { key: 'a', name: '客户端 A', label: '协作者 A' },
    { key: 'b', name: '客户端 B', label: '协作者 B' },
    { key: 'c', name: '客户端 C', label: '协作者 C' },
  ];

  function buildClientSlots() {
    var grid = $('clientGrid');
    if (!grid) return;
    clearNode(grid);
    state.slots = CLIENT_SLOTS.map(function (def) {
      var labelInput = h('input', { type: 'text', value: def.label, 'aria-label': def.name + ' 标签' });
      var nodeSelect = h('select', { 'aria-label': def.name + ' 所在节点' });
      var badgeEl = h('div', { class: 'client-badge' }, [
        h('span', { class: 'dot' }),
        h('span', { class: 'node', text: '未打开' }),
        h('span', { class: 'ver', text: '' }),
      ]);
      var wrap = h('div', { class: 'client-frame-wrap' }, [
        h('div', { class: 'client-placeholder' }, [
          h('b', { text: def.name + ' 还没有打开。' }),
          h('div', { text: '选好节点后点「打开」，这里会嵌入一个真实的 SpreadJS 协作客户端。' }),
        ]),
        badgeEl,
      ]);
      var slot = {
        key: def.key, name: def.name, labelInput: labelInput, nodeSelect: nodeSelect,
        badgeEl: badgeEl, wrap: wrap, iframe: null, placeholder: wrap.firstChild,
      };
      var card = h('div', { class: 'card client-card', 'data-slot': def.key });
      card.appendChild(h('div', { class: 'client-head' }, [
        h('span', { class: 'client-name', text: def.name }),
        h('span', { class: 'badge gray slot-badge', text: '未打开' }),
      ]));
      card.appendChild(h('div', { class: 'client-controls' }, [
        h('label', { class: 'field' }, [h('span', { text: '标签' }), labelInput]),
        h('label', { class: 'field' }, [h('span', { text: '节点' }), nodeSelect]),
        h('button', { class: 'btn tiny primary', type: 'button', text: '打开', onclick: function () { openClient(slot); } }),
        h('button', { class: 'btn tiny ghost', type: 'button', text: '刷新', onclick: function () { refreshClient(slot); } }),
        h('button', { class: 'btn tiny ghost', type: 'button', text: '关闭', onclick: function () { closeClient(slot); } }),
      ]));
      card.appendChild(wrap);
      grid.appendChild(card);
      return slot;
    });
    state.slots.forEach(function (slot) { updateClientNodeOptions(slot); });
  }

  function updateClientNodeOptions(only) {
    var stack = state.stack || normalizeStack(null);
    var targets = only ? [only] : state.slots;
    targets.forEach(function (slot) {
      if (!slot || !slot.nodeSelect) return;
      var previous = slot.nodeSelect.value || '';
      clearNode(slot.nodeSelect);
      slot.nodeSelect.appendChild(h('option', { value: '', text: '自动（跟随入口）' }));
      (stack.nodes || []).forEach(function (node) {
        slot.nodeSelect.appendChild(h('option', { value: String(node.port), text: node.id + ' : ' + node.port }));
      });
      var stillThere = false;
      for (var i = 0; i < (stack.nodes || []).length; i++) {
        if (String(stack.nodes[i].port) === previous) stillThere = true;
      }
      slot.nodeSelect.value = stillThere ? previous : '';
    });
  }

  function clientUrl(slot) {
    var room = currentRoom();
    var label = slot.labelInput && slot.labelInput.value ? String(slot.labelInput.value).trim() : slot.name;
    var port = slot.nodeSelect ? String(slot.nodeSelect.value || '') : '';
    return '/client/?room=' + encodeURIComponent(room) +
      '&label=' + encodeURIComponent(label || slot.name) +
      '&seed=1' + (port ? '&port=' + encodeURIComponent(port) : '');
  }

  function openClient(slot) {
    if (!slot) return;
    var url = clientUrl(slot);
    if (!slot.iframe) {
      slot.iframe = document.createElement('iframe');
      slot.iframe.className = 'client-frame';
      slot.iframe.setAttribute('title', slot.name + ' · 协同客户端');
      slot.iframe.setAttribute('loading', 'eager');
      if (slot.placeholder && slot.placeholder.parentNode === slot.wrap) {
        slot.wrap.removeChild(slot.placeholder);
      }
      slot.wrap.appendChild(slot.iframe);
    }
    slot.iframe.setAttribute('src', url);
    setClientBadge(slot, '加载中…', '', false);
    updateSlotBadge(slot, '加载中…', 'warn');
    flash(slot.name + ' 正在打开：' + url, 'ok');
  }

  function refreshClient(slot) {
    if (!slot || !slot.iframe) { openClient(slot); return; }
    openClient(slot);
  }

  function closeClient(slot) {
    if (!slot) return;
    if (slot.iframe && slot.iframe.parentNode === slot.wrap) {
      slot.wrap.removeChild(slot.iframe);
    }
    slot.iframe = null;
    if (!slot.placeholder) {
      slot.placeholder = h('div', { class: 'client-placeholder' }, [
        h('b', { text: slot.name + ' 已关闭。' }),
        h('div', { text: '点「打开」重新连接。' }),
      ]);
    }
    if (slot.placeholder.parentNode !== slot.wrap) {
      slot.wrap.appendChild(slot.placeholder);
    }
    setClientBadge(slot, '未打开', '', false);
    updateSlotBadge(slot, '未打开', 'gray');
  }

  function setClientBadge(slot, nodeText, versionText, ok) {
    if (!slot || !slot.badgeEl) return;
    slot.badgeEl.className = 'client-badge' + (ok ? ' ok' : '');
    var nodeEl = slot.badgeEl.children[1];
    var verEl = slot.badgeEl.children[2];
    if (nodeEl) nodeEl.textContent = nodeText;
    if (verEl) verEl.textContent = versionText;
  }

  function updateSlotBadge(slot, labelText, kind) {
    var card = slot.wrap && slot.wrap.parentNode;
    var badgeEl = null;
    if (card && card.children && card.children[0]) {
      for (var i = 0; i < card.children[0].children.length; i++) {
        var child = card.children[0].children[i];
        if (child.className && String(child.className).indexOf('slot-badge') >= 0) badgeEl = child;
      }
    }
    if (badgeEl) {
      badgeEl.className = 'badge ' + kind;
      badgeEl.textContent = labelText;
    }
  }

  /** Best-effort read of the collaborating page's automation hooks (same origin). */
  function updateClientBadges() {
    state.slots.forEach(function (slot) {
      if (!slot.iframe) return;
      var win;
      try { win = slot.iframe.contentWindow; } catch (err) { win = null; }
      if (!win) {
        setClientBadge(slot, '无法读取（跨域）', '', false);
        return;
      }
      var ready = win.__labReady === true;
      var nodeId = win.__labNodeId || null;
      var version = win.__labVersion;
      var room = win.__labRoomId || currentRoom();
      if (!nodeId) {
        setClientBadge(slot, ready ? '等待节点信息…' : '连接中…', '', false);
        updateSlotBadge(slot, '连接中…', 'warn');
        return;
      }
      setClientBadge(slot, nodeId, 'v' + (version === undefined ? '?' : version) + ' · ' + room, ready);
      updateSlotBadge(slot, nodeId + (ready ? ' · 就绪' : ' · 同步中'), ready ? 'ok' : 'warn');
    });
  }

  /* ------------------------------------------------------------------- check */
  function renderCheckConfig() {
    var select = $('checkConfig');
    if (!select) return;
    var previous = select.value || '';
    clearNode(select);
    var stack = state.stack || normalizeStack(null);
    var current = stack.config || {};
    var currentLabel = stack.running
      ? '当前运行：' + (stack.describe || describeConfig(current))
      : '当前没有运行中的技术栈';
    select.appendChild(h('option', { value: '', text: currentLabel }));
    var cat = state.catalogue;
    (cat ? cat.modes : []).forEach(function (mode) {
      select.appendChild(h('option', {
        value: 'mode:' + mode.id,
        text: '模式：' + mode.label + '（' + mode.id + '）',
      }));
    });
    (cat ? cat.variants : []).forEach(function (variant) {
      select.appendChild(h('option', {
        value: 'variant:' + variant.id,
        text: '变体：' + variant.label,
      }));
    });
    // Keep the previous selection when it still exists.
    var found = false;
    for (var i = 0; i < select.children.length; i++) {
      if (select.children[i].value === previous) found = true;
    }
    select.value = found ? previous : '';
  }

  function parseCheckSelection() {
    var select = $('checkConfig');
    var value = select ? String(select.value || '') : '';
    if (value.indexOf('mode:') === 0) return { mode: value.slice(5), variant: null };
    if (value.indexOf('variant:') === 0) {
      var variantId = value.slice(8);
      var variant = null;
      if (state.catalogue) {
        for (var i = 0; i < state.catalogue.variants.length; i++) {
          if (state.catalogue.variants[i].id === variantId) variant = state.catalogue.variants[i];
        }
      }
      return { mode: variant ? variant.basedOn : 'shared', variant: variantId };
    }
    var stack = state.stack || normalizeStack(null);
    return { mode: (stack.config && stack.config.mode) || null, variant: (stack.config && stack.config.variant) || null };
  }

  function startStack(mode, variant) {
    if (state.busy) { flash('上一个操作还没结束，请稍候…', 'warn'); return; }
    state.busy = 'up';
    setBusyUI(true);
    var label = variant ? ('反模式 ' + variant) : (MODE_CTA[mode] || ('架构 ' + mode));
    state.lastAction = '正在启动 ' + label + '…';
    flash(state.lastAction, 'ok');
    var body = variant ? { mode: mode, variant: variant } : { mode: mode };
    var agents = state.pendingAgents.slice();
    if (agents.length && mode === 'single') {
      flash('单机模式不接受多机 agent（只有负载均衡拓扑才支持），已忽略 ' + agents.length + ' 个 agent', 'warn');
      agents = [];
    }
    if (agents.length) body.agents = agents;
    apiFetch('/api/stack/up', { method: 'POST', body: JSON.stringify(body) })
      .then(function () {
        if (agents.length) {
          state.pendingAgents = [];
          flash(label + ' 已带 ' + agents.length + ' 个 agent 启动，正在刷新拓扑…', 'ok');
        } else {
          flash(label + ' 启动完成，正在刷新拓扑…', 'ok');
        }
        return loadStack();
      })
      .catch(function (err) {
        flash('启动失败：' + errorText(err), 'error');
      })
      .then(function () {
        state.busy = '';
        setBusyUI(false);
        renderMultiMachine();
      });
  }

  function stopStack() {
    if (state.busy) { flash('上一个操作还没结束，请稍候…', 'warn'); return; }
    state.busy = 'down';
    setBusyUI(true);
    flash('正在停止技术栈…', 'ok');
    apiFetch('/api/stack/down', { method: 'POST' })
      .then(function () {
        flash('技术栈已停止', 'ok');
        state.check.lastJob = null;
        return loadStack();
      })
      .catch(function (err) {
        flash('停止失败：' + errorText(err), 'error');
      })
      .then(function () {
        state.busy = '';
        setBusyUI(false);
      });
  }

  function setBusyUI(busy) {
    var ids = ['heroStartBtn', 'stopStackBtn', 'runCheckBtn', 'refreshStackBtn', 'benchRunBtn', 'runCheckScenarioBtn'];
    ids.forEach(function (id) {
      var el = $(id);
      if (el) el.disabled = Boolean(busy) || (id === 'stopStackBtn' && !(state.stack && state.stack.running));
    });
    var run = $('runCheckBtn');
    if (run) run.textContent = busy === 'check' ? '体检进行中…' : '运行架构体检';
    var runScenario = $('runCheckScenarioBtn');
    if (runScenario) runScenario.textContent = busy === 'check' ? '体检进行中…' : '运行架构体检';
    var bench = $('benchRunBtn');
    if (bench) bench.textContent = busy === 'bench' ? 'mirror 实验进行中…' : 'mirror 框架负载实验';
  }

  function renderCheckIdle() {
    var host = $('checkBody');
    if (!host) return;
    clearNode(host);
    var scenarioHost = $('checkScenario');
    if (scenarioHost) clearNode(scenarioHost);
    var stack = state.stack || normalizeStack(null);
    host.appendChild(h('div', { class: 'check-empty' }, stack.running
      ? '当前技术栈运行中。点「运行架构体检」，检查会针对这个正在运行的拓扑执行。'
      : '还没有运行中的技术栈。先在上面的模式卡片启动一种架构，再运行体检。'));
  }

  function renderCheckRunning(job) {
    var host = $('checkBody');
    if (!host) return;
    clearNode(host);
    var card = h('div', { class: 'check-running card' });
    card.appendChild(h('div', {}, [
      h('b', { text: '正在体检当前技术栈…' }),
      document.createTextNode(' 检查项会边执行边回传，结果矩阵在全部完成后出现。'),
    ]));
    var progress = h('div', { class: 'check-progress' });
    var items = job && Array.isArray(job.progress) ? job.progress : [];
    if (!items.length) {
      progress.appendChild(h('div', { class: 'progress-row' }, [
        h('span', { class: 'spinner-dot' }),
        h('span', { class: 'name', text: '连接检查任务…' }),
      ]));
    }
    items.forEach(function (item) {
      progress.appendChild(progressRow(item));
    });
    card.appendChild(progress);
    host.appendChild(card);
  }

  function progressRow(item) {
    var status = item.status || 'pending';
    var row = h('div', { class: 'progress-row' });
    if (status === 'running') row.appendChild(h('span', { class: 'spinner-dot' }));
    row.appendChild(h('span', { class: 'name', text: text(item.label || item.id) }));
    row.appendChild(h('span', { class: 'detail', text: text(item.detail) }));
    row.appendChild(statusPill(status));
    return row;
  }

  function statusPill(status) {
    // The check runner sends CLASSIFIED statuses: pass | fail | n/a | record |
    // expected-failure. `n/a` becomes the CSS class `n-a` (a slash cannot be a class
    // token), which is why the replace below turns '/' into '-'.
    var cls = String(status || 'pending').replace(/\//g, '-').replace(/[^a-z-]/g, '');
    return h('span', { class: 'progress-row-status status-pill ' + cls, text: STATUS_TEXT[status] || status });
  }

  function renderCheckError(err) {
    var host = $('checkBody');
    if (!host) return;
    clearNode(host);
    var card = h('div', { class: 'check-empty card' });
    card.appendChild(h('b', { text: '体检失败：' }));
    card.appendChild(document.createTextNode(errorText(err)));
    host.appendChild(card);
  }

  function renderCheckResult(result) {
    if (!result) { renderCheckIdle(); return; }
    var host = $('checkBody');
    if (!host) return;
    clearNode(host);
    renderCheckScenario(result);

    /* summary */
    var summary = result.summary || {};
    var summaryCard = h('div', { class: 'card check-summary' });
    var left = h('div');
    left.appendChild(badge(SUMMARY_TEXT[summary.status] || summary.status || '未知', summaryBadgeKind(summary.status)));
    left.appendChild(h('div', { class: 'check-headline', text: summary.headline || '（没有结论）' }));
    if (result.describe) left.appendChild(h('div', { class: 'muted', text: result.describe }));
    if (summary.advice && summary.advice.length) {
      var advice = h('ul', { class: 'check-advice' });
      summary.advice.forEach(function (line) { advice.appendChild(h('li', { text: line })); });
      left.appendChild(advice);
    }
    summaryCard.appendChild(left);
    summaryCard.appendChild(renderMetrics(result.metrics));
    host.appendChild(summaryCard);

    /* matrix */
    var tableCard = h('div', { class: 'card check-table-card' });
    var wrap = h('div', { class: 'table-wrap' });
    var table = h('table', { class: 'matrix' });
    var thead = h('thead');
    thead.appendChild(h('tr', {}, ['检查项', '期望', '实际', '说明 / 指标', '建议'].map(function (labelText) {
      return h('th', { text: labelText });
    })));
    table.appendChild(thead);
    var tbody = h('tbody');
    (result.checks || []).forEach(function (check) {
      var tr = h('tr');
      var labelCell = h('td');
      labelCell.appendChild(h('div', { class: 'check-label', text: check.label || check.id }));
      labelCell.appendChild(h('div', { class: 'check-id', text: check.id || '' }));
      tr.appendChild(labelCell);

      var expected = h('td');
      expected.appendChild(h('span', { class: 'expectation', text: EXPECTATION_TEXT[check.expected] || check.expected || '—' }));
      tr.appendChild(expected);

      var status = h('td');
      status.appendChild(statusPill(check.status));
      tr.appendChild(status);

      var detail = h('td');
      detail.appendChild(h('div', { class: 'check-detail', text: check.detail || '—' }));
      var metrics = metricInline(check.metrics);
      if (metrics) detail.appendChild(metrics);
      tr.appendChild(detail);

      var adviceCell = h('td');
      if (check.advice) adviceCell.appendChild(h('div', { class: 'check-advice-cell', text: check.advice }));
      else adviceCell.appendChild(h('span', { class: 'muted', text: '—' }));
      tr.appendChild(adviceCell);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    tableCard.appendChild(wrap);
    host.appendChild(tableCard);

    /* report bar */
    var bar = h('div', { class: 'card report-bar' });
    var reportText = '报告生成于 ' + text(result.generatedAt) + ' · 引擎 ' + text(result.engine) + ' · 模式 ' + text(result.mode) + (result.variant ? ' / ' + result.variant : '');
    if (result.files && result.files.json) reportText += ' · 文件 ' + result.files.json;
    bar.appendChild(h('span', { text: reportText }));
    bar.appendChild(h('button', {
      class: 'btn primary small', type: 'button', text: '查看最新报告',
      onclick: showReport,
    }));
    host.appendChild(bar);
  }

  function summaryBadgeKind(status) {
    if (status === 'healthy') return 'ok';
    if (status === 'degraded') return 'warn';
    if (status === 'broken') return 'err';
    if (status === 'expected-broken') return 'violet';
    return 'gray';
  }

  function renderMetrics(metrics) {
    var host = h('div', { class: 'metric-chips' });
    var map = [
      ['ackMs', 'ACK 延迟', 'ms'],
      ['crossNodeMs', '跨节点延迟', 'ms'],
      ['joinMs', '加入耗时', 'ms'],
    ];
    var found = false;
    map.forEach(function (entry) {
      var value = metrics && metrics[entry[0]];
      if (!value) return;
      found = true;
      var chip = h('div', { class: 'metric-chip' });
      chip.appendChild(h('b', { text: 'p50 ' + text(value.p50) + ' / p95 ' + text(value.p95) }));
      chip.appendChild(h('span', { text: entry[1] + ' (' + entry[2] + ') · max ' + text(value.max) }));
      host.appendChild(chip);
    });
    if (!found) host.appendChild(h('span', { class: 'muted', text: '本次没有可量化的指标' }));
    return host;
  }

  function metricInline(metrics) {
    if (!metrics || typeof metrics !== 'object') return null;
    var parts = [];
    Object.keys(metrics).forEach(function (key) {
      var value = metrics[key];
      if (value === null || value === undefined) return;
      if (typeof value === 'object') {
        parts.push(key + ': ' + ['p50', 'p95', 'p99', 'max'].filter(function (k) { return value[k] !== undefined; })
          .map(function (k) { return k + '=' + value[k]; }).join(' '));
      } else {
        parts.push(key + '=' + value);
      }
    });
    if (!parts.length) return null;
    return h('div', { class: 'metric-inline', text: parts.join(' · ') });
  }

  function runCheck() {
    if (state.busy) { flash('上一个操作还没结束，请稍候…', 'warn'); return; }
    var selection = parseCheckSelection();
    try { selection.scenario = readScenario(); } catch (err) { flash(err.message, 'err'); return; }
    state.busy = 'check';
    setBusyUI(true);
    var scenarioHost = $('checkScenario');
    if (scenarioHost) clearNode(scenarioHost);
    renderCheckRunning(null);
    apiFetch('/api/check', { method: 'POST', body: JSON.stringify(selection) })
      .then(function (job) {
        if (!job || !job.jobId) throw new Error('/api/check 没有返回 jobId');
        state.check.jobId = job.jobId;
        pollCheck(job.jobId, 0);
      })
      .catch(function (err) {
        state.busy = '';
        setBusyUI(false);
        renderCheckError(err);
        flash('无法开始体检：' + errorText(err), 'error');
      });
  }

  function pollCheck(jobId, attempt) {
    if (state.check.timer) window.clearTimeout(state.check.timer);
    state.check.timer = window.setTimeout(function () {
      apiFetch('/api/check/' + encodeURIComponent(jobId))
        .then(function (job) {
          state.check.lastJob = job;
          if (job.status === 'running') {
            renderCheckRunning(job);
            pollCheck(jobId, attempt + 1);
            return;
          }
          state.busy = '';
          setBusyUI(false);
          if (job.status === 'error') {
            renderCheckError(new Error(job.error || '检查任务失败'));
            flash('体检失败：' + (job.error || '检查任务失败'), 'error');
            return;
          }
          renderCheckResult(job.result);
          if (job.result && job.result.summary) {
            flash('体检完成：' + (SUMMARY_TEXT[job.result.summary.status] || job.result.summary.status), 'ok');
          }
        })
        .catch(function (err) {
          if (attempt < 8) {
            pollCheck(jobId, attempt + 1);
            return;
          }
          state.busy = '';
          setBusyUI(false);
          renderCheckError(err);
          flash('读取体检进度失败：' + errorText(err), 'error');
        });
    }, 350);
  }

  /* --------------------------------------------------------------- scenario */
  function scenarioCatalogue() {
    return (state.catalogue && state.catalogue.scenario) || normalizeScenarioCatalogue(null);
  }

  function scenarioLimits() {
    return scenarioCatalogue().limits;
  }

  /** Validate user input before starting a job; never replace it with defaults. */
  function readScenario() {
    var limits = scenarioLimits();
    function field(id, label, scale, range, integer) {
      var raw = valueOf(id);
      var value = Number(raw) * scale;
      if (String(raw).trim() === '' || !isFinite(value) ||
          (integer && Math.floor(value) !== value) || value < range.min || value > range.max) {
        throw new Error(label + '请输入 ' + (range.min / scale) + ' 到 ' + (range.max / scale) +
          ' 之间的' + (integer ? '整数' : '数值'));
      }
      return value;
    }
    var users = field('scenarioUsers', '用户数：', 1, limits.users, true);
    return {
      users: users,
      opIntervalMs: field('scenarioInterval', '编辑间隔（秒）：', 1000, limits.opIntervalMs, false),
      durationMs: field('scenarioDuration', '负载时长（秒）：', 1000, limits.durationMs, false),
      rooms: field('scenarioRooms', '房间数：', 1, { min: 1, max: Math.min(limits.rooms.max, users) }, true),
    };
  }

  function valueOf(id) {
    var el = $(id);
    return el ? el.value : '';
  }

  function setValue(id, value) {
    var el = $(id);
    if (el) el.value = String(value);
  }

  /** 2000 -> "2", 500 -> "0.5", 50 -> "0.05" (input is in seconds). */
  function secondsText(ms) {
    var seconds = ms / 1000;
    return String(Math.round(seconds * 1000) / 1000);
  }

  function writeScenarioInputs(scenario) {
    setValue('scenarioUsers', scenario.users);
    setValue('scenarioInterval', secondsText(scenario.opIntervalMs));
    setValue('scenarioDuration', secondsText(scenario.durationMs));
    setValue('scenarioRooms', scenario.rooms);
  }

  /** DEV-CONTRACT §11 — the same formula as src/lab/scenario.mjs (modelScenario). */
  function computeScenarioModel(scenario) {
    var rooms = Math.max(1, scenario.rooms);
    var usersPerRoom = scenario.users / rooms;
    var base = Math.floor(usersPerRoom);
    var extra = scenario.users % rooms;
    var opsPerSecond = scenario.users / (scenario.opIntervalMs / 1000);
    var fanoutPerSecond = (extra * (base + 1) * base + (rooms - extra) * base * (base - 1)) /
      (scenario.opIntervalMs / 1000);
    var presence = Boolean(state.stack && state.stack.config && state.stack.config.presence);
    var predictedCores = fanoutPerSecond / CORES_PER_FANOUT * (presence ? 1.17 : 1);
    return {
      usersPerRoom: usersPerRoom,
      usersPerRoomMin: base,
      usersPerRoomMax: base + (extra > 0 ? 1 : 0),
      opsPerSecond: opsPerSecond,
      fanoutPerSecond: fanoutPerSecond,
      predictedCores: predictedCores,
    };
  }

  function fmtInt(value) {
    if (!isFinite(value)) return '—';
    return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function fmtRate(value) {
    if (!isFinite(value)) return '—';
    if (value >= 100) return String(Math.round(value));
    if (value >= 10) return String(Math.round(value * 10) / 10);
    return (Math.round(value * 100) / 100).toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  }

  function fmtCores(value) {
    if (!isFinite(value)) return '—';
    if (value >= 10) return value.toFixed(1);
    if (value >= 1) return value.toFixed(2);
    if (value >= 0.1) return value.toFixed(3);
    return value.toFixed(4);
  }

  function scenarioLine(scenario) {
    return '场景：' + fmtInt(scenario.users) + ' 用户 · 每 ' + secondsText(scenario.opIntervalMs) +
      ' 秒一次编辑 · ' + secondsText(scenario.durationMs) + ' 秒 · ' + fmtInt(scenario.rooms) + ' 房间';
  }

  function renderScenarioPanel(forceDefaults) {
    var scenario = scenarioCatalogue();
    state.scenarioLimits = scenario.limits;
    state.scenarioDefaults = scenario.defaults;
    if (forceDefaults || !state.scenarioTouched) {
      writeScenarioInputs(scenario.defaults.check);
      state.scenarioTouched = false;
    }
    renderScenarioHints();
    renderScenarioDerived();
  }

  function setFieldHint(id, message, invalid) {
    var el = $(id);
    if (!el) return;
    el.textContent = message;
    var field = el.parentNode;
    if (field && field.className !== undefined) {
      var input = field.querySelector ? field.querySelector('input') : null;
      if (input && input.className !== undefined) {
        var cls = String(input.className || '').replace(/\s*invalid/g, '');
        input.className = invalid ? (cls + ' invalid').trim() : cls;
      }
    }
  }

  function renderScenarioHints() {
    var limits = scenarioLimits();
    var users = Number(valueOf('scenarioUsers'));
    setFieldHint('scenarioUsersHint', '范围 ' + fmtInt(limits.users.min) + ' – ' + fmtInt(limits.users.max));
    setFieldHint('scenarioIntervalHint', '范围 ' + secondsText(limits.opIntervalMs.min) + ' – ' +
      secondsText(limits.opIntervalMs.max) + ' 秒');
    setFieldHint('scenarioDurationHint', '范围 ' + secondsText(limits.durationMs.min) + ' – ' +
      secondsText(limits.durationMs.max) + ' 秒');
    setFieldHint('scenarioRoomsHint', '范围 ' + fmtInt(limits.rooms.min) + ' – ' +
      fmtInt(Math.min(limits.rooms.max, users || limits.rooms.max)) + '（≤ 用户数）');
  }

  function renderScenarioDerived() {
    var host = $('scenarioDerived');
    if (!host) return;
    var scenario;
    try { scenario = readScenario(); }
    catch (err) {
      host.textContent = err.message;
      var invalidNote = $('scenarioNote');
      if (invalidNote) invalidNote.textContent = '请修正输入后再运行，场景不会自动改为默认值。';
      return;
    }
    var model = computeScenarioModel(scenario);
    clearNode(host);
    host.appendChild(document.createTextNode('目标编辑 '));
    host.appendChild(h('b', { text: fmtRate(model.opsPerSecond) }));
    host.appendChild(document.createTextNode(' 次/s · 推算投递 '));
    host.appendChild(h('b', { text: fmtInt(model.fanoutPerSecond) }));
    host.appendChild(document.createTextNode(' 条/s'));
    host.appendChild(h('span', { class: 'muted', text: '（均匀分配每房间 ' + model.usersPerRoomMin +
      (model.usersPerRoomMax !== model.usersPerRoomMin ? '–' + model.usersPerRoomMax : '') + ' 用户）' }));

    var note = $('scenarioNote');
    if (note) {
      clearNode(note);
      note.appendChild(document.createTextNode(
        '体检会先跑 11 个正确性探针，再用 min(用户数, 服务端上限) 个客户端跑一次短负载（实测 p95）；' +
        '「mirror 框架负载实验」按同一场景生成合成写入 ' + secondsText(scenario.durationMs) + ' 秒。投递量只反映消息数量，不是资源测量；零广播仍需资源。'));
      if (!scenarioCatalogue().available) {
        note.appendChild(document.createTextNode(' 服务端 /api/catalogue 没有 scenario 配置，正在使用契约默认值。'));
      }
    }
  }

  function resetScenario() {
    writeScenarioInputs(scenarioCatalogue().defaults.check);
    state.scenarioTouched = false;
    renderScenarioHints();
    renderScenarioDerived();
  }

  function renderMeasuredLoad(load, model) {
    var ack = load.ackMs || load.ack || {};
    var line = h('div', { class: 'measured-line' });
    line.appendChild(document.createTextNode('实测：'));
    line.appendChild(h('b', { text: fmtInt(load.clients) + ' 客户端' }));
    if (load.capped) {
      line.appendChild(document.createTextNode('（实际只测试上限内的客户端，其余用户未执行负载）'));
    }
    line.appendChild(document.createTextNode(' · ' + fmtRate(load.opsPerSecond) + ' 次编辑/s · 推算投递量 ' +
      fmtInt(load.fanoutPerSecond) + ' 条/s'));
    if (ack.p95 !== undefined) {
      line.appendChild(document.createTextNode(' · '));
      line.appendChild(h('b', { text: 'ACK p95 ' + text(ack.p95) + 'ms' }));
    }
    if (model) {
      line.appendChild(document.createTextNode('（场景目标编辑 ' + fmtRate(model.opsPerSecond) + ' 次/s · 推算投递 ' +
        fmtInt(model.fanoutPerSecond) + ' 条/s）'));
    }
    return line;
  }

  function renderCheckScenario(result) {
    var host = $('checkScenario');
    if (!host) return;
    clearNode(host);
    var scenario = result && result.scenario;
    if (!scenario) return; // older server / no scenario: leave the slot empty
    var load = scenario.load || null;
    if (!load && Array.isArray(result.checks)) {
      for (var i = 0; i < result.checks.length; i++) {
        if (result.checks[i].id === 'load.scenario' && result.checks[i].metrics) {
          load = result.checks[i].metrics;
        }
      }
    }
    var model = scenario.model || computeScenarioModel(scenario);
    var card = h('div', { class: 'card load-summary' });
    card.appendChild(h('div', { class: 'kicker', text: '本次场景' }));
    card.appendChild(h('div', { class: 'scene-line', text: scenarioLine(scenario) }));
    card.appendChild(h('div', { class: 'model-line' }));
    card.lastChild.appendChild(document.createTextNode('mirror 场景：平均每房间 ' + fmtRate(model.usersPerRoom) +
      ' 用户 · 目标编辑 ' + fmtRate(model.opsPerSecond) + ' 次/s · 推算投递 ' + fmtInt(model.fanoutPerSecond) + ' 条/s'));
    if (load) card.appendChild(renderMeasuredLoad(load, model));
    host.appendChild(card);
  }

  /* ----------------------------------------------------------- multi-machine */
  function normalizeAgentUrl(raw) {
    var value = String(raw || '').trim();
    if (!value) return null;
    var withScheme = /^https?:\/\//i.test(value) ? value : ('http://' + value);
    var match = /^(https?:\/\/[^\s/]+)/i.exec(withScheme);
    return match ? match[1].replace(/\/+$/, '').toLowerCase() : null;
  }

  function parseAgentUrls(raw) {
    var parts = String(raw || '').split(/[\s,，;；]+/);
    var found = [];
    parts.forEach(function (part) {
      var url = normalizeAgentUrl(part);
      if (url && found.indexOf(url) < 0) found.push(url);
    });
    return found;
  }

  function addAgentsFromInput() {
    var input = $('mmInput');
    if (!input) return;
    var urls = parseAgentUrls(input.value);
    if (!urls.length) {
      flash('请输入 agent 地址，例如 http://h1:9100（多个用逗号或空格分隔）', 'warn');
      return;
    }
    var added = [];
    urls.forEach(function (url) {
      if (state.pendingAgents.indexOf(url) < 0) {
        state.pendingAgents.push(url);
        added.push(url);
      }
    });
    input.value = '';
    renderMultiMachine();
    flash(added.length
      ? '已加入 ' + added.length + ' 个 agent，下一次启动架构时生效（console 不会启动 agent 进程）'
      : '这些 agent 已经在待应用列表里了', added.length ? 'ok' : 'warn');
  }

  function removePendingAgent(url) {
    var index = state.pendingAgents.indexOf(url);
    if (index >= 0) state.pendingAgents.splice(index, 1);
    renderMultiMachine();
  }

  function remoteAgents(stack) {
    var remotes = stack && Array.isArray(stack.remote) ? stack.remote.slice() : [];
    if (!remotes.length && stack && Array.isArray(stack.nodes)) {
      stack.nodes.forEach(function (node) {
        if (!node.remote) return;
        remotes.push({
          agentUrl: '—',
          host: node.host || null,
          nodeId: node.id,
          nodeUrl: node.host ? ('http://' + node.host + ':' + node.port) : ('node:' + node.port),
          health: node.health,
        });
      });
    }
    return remotes;
  }

  function renderMultiMachine() {
    var host = $('mmList');
    if (!host) return;
    clearNode(host);
    var stack = state.stack || normalizeStack(null);
    var remotes = remoteAgents(stack);
    var localCount = (stack.nodes || []).filter(function (node) { return !node.remote; }).length;

    var badgeEl = $('mmBadge');
    if (badgeEl) {
      if (!stack.running) {
        badgeEl.className = 'badge gray';
        badgeEl.textContent = '未运行';
      } else if (remotes.length) {
        badgeEl.className = 'badge violet';
        badgeEl.textContent = remotes.length + ' 远程 · ' + localCount + ' 本机';
      } else {
        badgeEl.className = 'badge gray';
        badgeEl.textContent = localCount + ' 本机 · 无远程';
      }
    }

    if (remotes.length) {
      remotes.forEach(function (remote) {
        var health = remote.health && typeof remote.health === 'object' ? remote.health : null;
        var healthy = health ? health.ok !== false && health.healthy !== false : true;
        var row = h('div', { class: 'mm-row' });
        row.appendChild(h('span', { class: 'dot ' + (healthy ? 'ok' : 'err') }));
        row.appendChild(h('div', {}, [
          h('div', { class: 'host', text: remote.host || remote.agentUrl || 'agent' }),
          h('div', { class: 'who', text: 'agent ' + text(remote.agentUrl) }),
        ]));
        row.appendChild(h('div', {}, [
          h('div', { class: 'who', text: '节点 ' + text(remote.nodeId) }),
          h('div', { class: 'who', text: text(remote.nodeUrl) }),
        ]));
        row.appendChild(h('code', { text: text(remote.nodeUrl) }));
        row.appendChild(badge(healthy ? '健康' : '异常', healthy ? 'ok' : 'err'));
        host.appendChild(row);
      });
    } else if (!stack.running) {
      host.appendChild(h('div', { class: 'mm-empty', text: '技术栈未运行。启动 shared / sharded 时可以在下面的输入框里带上 agent；单机模式不接受 agent。' }));
    } else if (!Array.isArray(stack.remote)) {
      host.appendChild(h('div', { class: 'mm-empty', text: '当前 /api/stack 没有返回 remote[]（服务端可能还没有升级多机接口）；CLI 仍可用 npm run up -- --agents=…。' }));
    } else {
      host.appendChild(h('div', { class: 'mm-empty', text: '当前没有远程 agent：所有节点都在本机运行。需要多机时，在另一台机器执行 npm run agent 后把地址加到下面。' }));
    }

    if (state.pendingAgents.length) {
      var pending = h('div', { class: 'mm-pending' });
      state.pendingAgents.forEach(function (url) {
        var chip = h('span', { class: 'mm-chip' });
        chip.appendChild(document.createTextNode(url));
        chip.appendChild(h('button', {
          type: 'button', title: '从待应用列表移除', text: '×',
          onclick: function () { removePendingAgent(url); },
        }));
        pending.appendChild(chip);
      });
      host.appendChild(pending);
    }

    var pendingText = $('mmPending');
    if (pendingText) {
      pendingText.textContent = state.pendingAgents.length
        ? '待应用 ' + state.pendingAgents.length + ' 个，下一次「启动架构」生效'
        : '';
    }
  }

  function updateBenchControls() {
    var checkbox = $('benchDistribute');
    if (!checkbox) return;
    var remotes = state.stack ? remoteAgents(state.stack) : [];
    var canDistribute = remotes.length > 0;
    checkbox.disabled = !canDistribute;
    if (!canDistribute) checkbox.checked = false;
    var label = checkbox.parentNode;
    if (label && label.classList) label.classList.toggle('disabled', !canDistribute);
    if (label) {
      label.title = canDistribute
        ? '把负载拆到本机 + ' + remotes.length + ' 个 agent（distribute:true）'
        : '需要先加入 agent 并启动，/api/stack 的 remote[] 非空时才可跨机分摊';
    }
  }

  /* ------------------------------------------------------------------- bench */
  function renderBenchRunning(scenario, job) {
    var host = $('benchBody');
    if (!host) return;
    clearNode(host);
    var card = h('div', { class: 'card bench-card' });
    var head = h('div', { class: 'bench-head' }, [
      h('div', {}, [
        h('div', { class: 'scenario-title', text: 'mirror 框架负载实验' }),
        h('div', { class: 'scenario-sub', text: scenarioLine(scenario) }),
      ]),
      badge('mirror 实验进行中', 'info'),
    ]);
    card.appendChild(head);
    var progress = h('div', { class: 'check-running' });
    progress.appendChild(h('span', { class: 'spinner-dot' }));
    progress.appendChild(document.createTextNode(' 正在通过拓扑入口施压，完成后这里会出现参与者和聚合结果。'));
    if (job && job.progress && job.progress.length) {
      var list = h('div', { class: 'check-progress' });
      job.progress.forEach(function (item) { list.appendChild(progressRow(item)); });
      progress.appendChild(list);
    }
    card.appendChild(progress);
    host.appendChild(card);
  }

  function renderBenchUnsupported(err) {
    var host = $('benchBody');
    if (!host) return;
    clearNode(host);
    var card = h('div', { class: 'card bench-card' });
    card.appendChild(h('div', { class: 'bench-unsupported' }));
    card.lastChild.appendChild(h('b', { text: '当前服务端还没有 /api/bench（或该端点不可用）。' }));
    card.lastChild.appendChild(document.createTextNode(
      ' 更新服务端后，用「mirror 框架负载实验」按钮重试；也可用 CLI：npm run bench -- --users=… --interval=…'));
    if (err) card.appendChild(h('div', { class: 'bench-note', text: errorText(err) }));
    host.appendChild(card);
  }

  function renderBenchError(err) {
    var host = $('benchBody');
    if (!host) return;
    clearNode(host);
    var card = h('div', { class: 'card bench-card' });
    card.appendChild(h('div', { class: 'bench-unsupported', text: '压测失败：' + errorText(err) }));
    host.appendChild(card);
  }

  function benchFailureCount(record) {
    if (!record || typeof record !== 'object') return null;
    if (record.errors !== undefined && record.errors !== null) return record.errors;
    if (record.opsFailed !== undefined) return record.opsFailed;
    if (record.ops && typeof record.ops === 'object' && record.ops.failed !== undefined) return record.ops.failed;
    return null;
  }

  /** The real bench summary may omit stats.users (it has clients) and may return
   *  participants: [] for a local-only run; normalise both so one renderer works. */
  function benchUsers(stats) {
    if (!stats) return null;
    if (stats.users !== undefined) return stats.users;
    if (stats.clients !== undefined) return stats.clients;
    var participants = Array.isArray(stats.participants) ? stats.participants : [];
    var total = null;
    participants.forEach(function (p) {
      if (p.users !== undefined) total = (total || 0) + Number(p.users);
    });
    return total;
  }

  function benchParticipants(stats) {
    var list = stats && Array.isArray(stats.participants) ? stats.participants.slice() : [];
    if (!list.length && stats && (stats.ops !== undefined || stats.opsPerSecond !== undefined)) {
      list.push({
        kind: 'local', label: '本机', target: 'local', host: null,
        users: benchUsers(stats),
        ops: stats.ops, opsFailed: benchFailureCount(stats),
        opsPerSecond: stats.opsPerSecond, fanoutPerSecond: stats.fanoutPerSecond,
        ackMs: stats.ackMs || stats.ack, errors: benchFailureCount(stats),
        synthetic: true,
      });
    }
    return list;
  }

  function benchStatsTable(stats) {
    var table = h('table', { class: 'bench' });
    table.appendChild(h('thead', {}, [
      h('tr', {}, ['参与者', '类型', '用户', 'ops/s', '扇出/s', 'ACK p50', 'ACK p95', 'ACK p99', '错误'].map(function (labelText) {
        return h('th', { text: labelText });
      })),
    ]));
    var tbody = h('tbody');
    var participants = benchParticipants(stats);
    participants.forEach(function (participant) {
      var ack = participant.ackMs || participant.ack || {};
      var row = h('tr');
      row.appendChild(h('td', { text: text(participant.label || participant.host || participant.target) }));
      row.appendChild(h('td', { class: 'kind', text: participant.kind === 'agent' ? 'agent' : '本机' }));
      row.appendChild(h('td', { text: fmtInt(participant.users) }));
      row.appendChild(h('td', { text: fmtRate(participant.opsPerSecond) }));
      row.appendChild(h('td', { text: fmtInt(participant.fanoutPerSecond) }));
      row.appendChild(h('td', { text: text(ack.p50) }));
      row.appendChild(h('td', { text: text(ack.p95) }));
      row.appendChild(h('td', { text: text(ack.p99) }));
      row.appendChild(h('td', { text: text(benchFailureCount(participant)) }));
      tbody.appendChild(row);
    });
    var ack = stats.ackMs || stats.ack || {};
    var aggregate = h('tr', { class: 'aggregate' });
    aggregate.appendChild(h('td', { text: '合计' }));
    var kindText = participants.length === 1 && participants[0].kind !== 'agent'
      ? '1 本机' : (participants.length + ' 参与者');
    aggregate.appendChild(h('td', { class: 'kind', text: kindText }));
    aggregate.appendChild(h('td', { text: fmtInt(benchUsers(stats)) }));
    aggregate.appendChild(h('td', { text: fmtRate(stats.opsPerSecond) }));
    aggregate.appendChild(h('td', { text: fmtInt(stats.fanoutPerSecond) }));
    aggregate.appendChild(h('td', { text: text(ack.p50) }));
    aggregate.appendChild(h('td', { text: text(ack.p95) }));
    aggregate.appendChild(h('td', { text: text(ack.p99) }));
    aggregate.appendChild(h('td', { text: text(benchFailureCount(stats)) }));
    tbody.appendChild(aggregate);
    table.appendChild(tbody);
    return table;
  }

  function renderBenchResult(stats, scenario) {
    var host = $('benchBody');
    if (!host) return;
    clearNode(host);
    if (!stats || typeof stats !== 'object') { renderBenchError(new Error('压测返回里没有 stats')); return; }
    var card = h('div', { class: 'card bench-card' });
    var ack = stats.ackMs || stats.ack || {};

    var head = h('div', { class: 'bench-head' });
    var left = h('div');
    var title = h('div', { class: 'scenario-title', text: 'mirror 框架负载实验结果' });
    left.appendChild(title);
    if (scenario) left.appendChild(h('div', { class: 'scenario-sub', text: scenarioLine(scenario) }));
    else if (stats.scenario) left.appendChild(h('div', { class: 'scenario-sub', text: scenarioLine(stats.scenario) }));
    head.appendChild(left);
    var writesPassed = stats.outcome ? stats.outcome.writesPassed : false;
    head.appendChild(badge(writesPassed ? '负载完成' : '结果需检查', writesPassed ? 'ok' : 'err'));
    card.appendChild(head);
    card.appendChild(h('div', { class: 'bench-note', text: stats.scope || 'mirror 框架负载实验；硬件评估必须使用真实 SpreadJS、官方协同服务和业务负载。当前 bench 尚未提供官方负载测试。' }));
    if (stats.outcome) card.appendChild(h('div', { class: 'bench-note', text: stats.outcome.message }));

    var kpis = h('div', { class: 'bench-kpis' });
    [
      ['用户', fmtInt(benchUsers(stats))],
      ['总 ops', fmtInt(stats.ops && typeof stats.ops === 'object' ? stats.ops.ok : stats.ops)],
      ['ops/s', fmtRate(stats.opsPerSecond)],
      ['推算投递/s', fmtInt(stats.fanoutPerSecond)],
      ['ACK p95', text(ack.p95) + ' ms'],
      ['错误', text(benchFailureCount(stats))],
    ].forEach(function (entry) {
      kpis.appendChild(h('div', { class: 'bench-kpi' }, [h('b', { text: entry[1] }), h('span', { text: entry[0] })]));
    });
    card.appendChild(kpis);

    card.appendChild(benchStatsTable(stats));

    var participantRows = benchParticipants(stats);
    var remoteCount = participantRows.filter(function (p) { return p.kind === 'agent'; }).length;
    if (participantRows.length > 1 || remoteCount > 0) {
      card.appendChild(h('div', { class: 'bench-note', text: '参与者：' + (participantRows.some(function (p) { return p.kind === 'local'; }) ? '本机 + ' : '') + remoteCount + ' 个 agent；聚合 ops = 各参与者之和，ACK 分位数由各参与者保留样本合并估计。' }));
    } else {
      card.appendChild(h('div', { class: 'bench-note', text: '本次仅本机执行（distribute=false）。跨机压测：先把 agent 加入下一次启动，再勾选「跨机分摊」。' }));
    }
    if (stats.broadcastMs && stats.broadcastMs.p95 !== undefined) {
      card.appendChild(h('div', { class: 'bench-note', text: '广播延迟 p95 ' + text(stats.broadcastMs.p95) + ' ms（接收端记录的到达样本）。' }));
    }
    if (stats.writingMs !== undefined && stats.timingBasis !== 'legacy-elapsed-fallback') {
      card.appendChild(h('div', { class: 'bench-note', text: '连接窗口 ' + secondsText(stats.connectionMs) +
        ' 秒 · 写入窗口 ' + secondsText(stats.writingMs) + ' 秒；速率以写入窗口计算。' }));
      card.appendChild(h('div', { class: 'bench-note', text: '发送 ' + fmtRate(stats.sentOpsPerSecond) +
        ' 次/s，目标 ' + fmtRate(stats.targetOpsPerSecond) + ' 次/s，发送速率达成 ' +
        fmtRate(stats.targetRateAchievement * 100) + '%。投递量按成功写入与房间人数推算，不代表逐条收件确认。' }));
    } else if (stats.elapsedMs !== undefined) {
      card.appendChild(h('div', { class: 'bench-note', text: '旧报告总时长 ' + secondsText(stats.elapsedMs) +
        ' 秒（含建连），请重测后比较写入速率。' }));
    }
    if (stats.roomDistribution) card.appendChild(h('div', { class: 'bench-note', text:
      '已连接房间人数分布（人数:房间数）：' + JSON.stringify(stats.roomDistribution.histogram) }));
    if (stats.receiveWindowMs !== undefined) card.appendChild(h('div', { class: 'bench-note', text:
      '广播实收 ' + text(stats.broadcastReceived) + ' 条，接收窗口 ' + secondsText(stats.receiveWindowMs) +
      ' 秒；接收率使用独立窗口，不能与推算投递率直接相减作为丢失率。' }));
    host.appendChild(card);
  }

  function pollBench(jobId, attempt, scenario) {
    if (state.bench.timer) window.clearTimeout(state.bench.timer);
    state.bench.timer = window.setTimeout(function () {
      apiFetch('/api/bench/' + encodeURIComponent(jobId))
        .then(function (job) {
          if (job.status === 'running') {
            state.bench.status = 'running';
            renderBenchRunning(scenario, job);
            pollBench(jobId, attempt + 1, scenario);
            return;
          }
          state.busy = '';
          setBusyUI(false);
          if (job.status === 'error') {
            state.bench.status = 'error';
            state.bench.error = job.error || '压测任务失败';
            renderBenchError(new Error(state.bench.error));
            flash('压测失败：' + state.bench.error, 'error');
            return;
          }
          state.bench.status = 'done';
          state.bench.stats = job.stats || null;
          renderBenchResult(job.stats, scenario);
          flash('压测完成', 'ok');
        })
        .catch(function (err) {
          if (err.status === 404 && attempt < 2) {
            state.busy = '';
            setBusyUI(false);
            renderBenchUnsupported(err);
            return;
          }
          if (attempt < 8) { pollBench(jobId, attempt + 1, scenario); return; }
          state.busy = '';
          setBusyUI(false);
          renderBenchError(err);
          flash('读取压测结果失败：' + errorText(err), 'error');
        });
    }, 400);
  }

  function runBench() {
    if (state.busy) { flash('上一个操作还没结束，请稍候…', 'warn'); return; }
    var scenario;
    try { scenario = readScenario(); } catch (err) { flash(err.message, 'err'); return; }
    state.busy = 'bench';
    setBusyUI(true);
    var body = { scenario: scenario };
    var checkbox = $('benchDistribute');
    if (checkbox && checkbox.checked && !checkbox.disabled) body.distribute = true;
    state.bench = { jobId: null, timer: null, status: 'running', stats: null, error: null, scenario: scenario, request: body };
    renderBenchRunning(scenario, null);
    flash('已提交压测：' + scenarioLine(scenario), 'ok');
    apiFetch('/api/bench', { method: 'POST', body: JSON.stringify(body) })
      .then(function (job) {
        if (!job || !job.jobId) throw new Error('/api/bench 没有返回 jobId');
        state.bench.jobId = job.jobId;
        pollBench(job.jobId, 0, scenario);
      })
      .catch(function (err) {
        state.busy = '';
        setBusyUI(false);
        if (err.status === 404 || /未知的 API 路径|Not Found/i.test(String(err.message || ''))) {
          renderBenchUnsupported(err);
        } else {
          renderBenchError(err);
          flash('无法开始压测：' + errorText(err), 'error');
        }
      });
  }


  function showReport() {
    var modal = $('reportModal');
    var body = $('reportBody');
    if (!modal || !body) return;
    modal.className = 'modal open';
    clearNode(body);
    body.appendChild(h('div', { class: 'skeleton-line' }));
    body.appendChild(h('div', { class: 'skeleton-line short' }));
    apiFetch('/api/report/latest')
      .then(function (report) {
        clearNode(body);
        var generatedAt = report.generatedAt || (report.json && report.json.generatedAt);
        body.appendChild(h('div', { class: 'report-meta', text: '生成时间：' + text(generatedAt) + (report.file && report.file.markdown ? ' · ' + report.file.markdown : '') }));
        var actions = h('div', { class: 'hero-actions' });
        actions.appendChild(h('a', { class: 'btn ghost small', href: '/api/report/latest', target: '_blank', rel: 'noreferrer', text: '打开原始 JSON' }));
        body.appendChild(actions);
        body.appendChild(h('pre', { class: 'report-md', text: report.markdown || JSON.stringify(report.json || report, null, 2) }));
      })
      .catch(function (err) {
        clearNode(body);
        if (err.status === 404) {
          body.appendChild(h('div', { class: 'check-empty', text: '还没有生成过报告。先运行一次「架构体检」。' }));
        } else {
          body.appendChild(h('div', { class: 'check-empty', text: '读取报告失败：' + errorText(err) }));
        }
      });
  }

  function closeReport() {
    var modal = $('reportModal');
    if (modal) modal.className = 'modal';
  }

  /* ------------------------------------------------------------------- loads */
  function loadCatalogue() {
    return apiFetch('/api/catalogue')
      .then(function (raw) {
        var norm = normalizeCatalogue(raw);
        state.catalogue = norm;
        state.comparison = norm.comparison;
        state.environment = norm.environment;
        renderScenarioPanel(false);
        setApiBadge(true);
        renderCatalogueLoaded();
        if (norm.stackHint && !state.stack) {
          state.stack = normalizeStack(norm.stackHint);
          renderStack();
        }
      })
      .catch(function (err) {
        setApiBadge(false);
        state.apiError = err;
        flash('无法读取 /api/catalogue：' + errorText(err) + '（控制台需要由 lab web 服务提供，见 npm run web）', 'error');
      });
  }

  function loadStack() {
    return apiFetch('/api/stack')
      .then(function (raw) {
        state.stack = normalizeStack(raw);
        state.stackError = null;
        setApiBadge(true);
        renderStack();
        setBusyUI(Boolean(state.busy));
        if (!state.check.lastJob) renderCheckIdle();
      })
      .catch(function (err) {
        state.stackError = errorText(err);
        setApiBadge(false);
        renderStackStatus();
        renderStackGrid();
        if (!state.check.lastJob) renderCheckIdle();
        throw err;
      });
  }

  /* ------------------------------------------------------------------ events */
  function bindEvents() {
    var reportBtn = $('reportBtn');
    if (reportBtn) reportBtn.addEventListener('click', showReport);
    var closeBtn = $('closeReportBtn');
    if (closeBtn) closeBtn.addEventListener('click', closeReport);
    var hero = $('heroStartBtn');
    if (hero) hero.addEventListener('click', function () { startStack('single', null); });
    var refreshBtn = $('refreshStackBtn');
    if (refreshBtn) refreshBtn.addEventListener('click', function () {
      loadStack().catch(function () {});
      flash('已请求刷新拓扑', 'ok');
    });
    var stopBtn = $('stopStackBtn');
    if (stopBtn) stopBtn.addEventListener('click', stopStack);
    var runBtn = $('runCheckBtn');
    if (runBtn) runBtn.addEventListener('click', runCheck);
    var openAll = $('openAllBtn');
    if (openAll) openAll.addEventListener('click', function () {
      state.slots.forEach(function (slot) { openClient(slot); });
    });
    var refreshClients = $('refreshClientsBtn');
    if (refreshClients) refreshClients.addEventListener('click', function () {
      state.slots.forEach(function (slot) { if (slot.iframe) refreshClient(slot); });
    });
    var roomInput = $('roomInput');
    if (roomInput) roomInput.addEventListener('change', function () {
      state.room = currentRoom();
      renderStackGrid();
      flash('房间已切换为 ' + state.room + '，刷新客户端后生效', 'ok');
    });

    /* scenario inputs: seconds in the UI, ms on the wire */
    ['scenarioUsers', 'scenarioInterval', 'scenarioDuration', 'scenarioRooms'].forEach(function (id) {
      var el = $(id);
      if (!el) return;
      el.addEventListener('input', function () {
        state.scenarioTouched = true;
        renderScenarioDerived();
      });
      el.addEventListener('change', function () {
        state.scenarioTouched = true;
        renderScenarioDerived();
      });
    });
    var reset = $('scenarioReset');
    if (reset) reset.addEventListener('click', function (event) {
      if (event && event.preventDefault) event.preventDefault();
      resetScenario();
    });
    var benchBtn = $('benchRunBtn');
    if (benchBtn) benchBtn.addEventListener('click', runBench);
    var runScenarioBtn = $('runCheckScenarioBtn');
    if (runScenarioBtn) runScenarioBtn.addEventListener('click', runCheck);
    var mmAddBtn = $('mmAddBtn');
    if (mmAddBtn) mmAddBtn.addEventListener('click', addAgentsFromInput);
    var mmInput = $('mmInput');
    if (mmInput) mmInput.addEventListener('keydown', function (event) {
      if (event && event.key === 'Enter') {
        if (event.preventDefault) event.preventDefault();
        addAgentsFromInput();
      }
    });
  }

  /* -------------------------------------------------------------- poll loop */
  function refreshTick() {
    if (typeof document !== 'undefined' && document.hidden) return;
    if (state.busy === 'up' || state.busy === 'down') return;
    loadStack().catch(function () {});
    updateClientBadges();
  }

  /* --------------------------------------------------------------------- init */
  function init() {
    bindEvents();
    buildClientSlots();
    renderScenarioPanel(false);
    renderMultiMachine();
    renderCheckIdle();
    loadCatalogue();
    loadStack().catch(function () {});
    state.pollTimer = window.setInterval(refreshTick, 2500);
    state.clientTimer = window.setInterval(updateClientBadges, 1200);
  }

  if (typeof window !== 'undefined') {
    window.__labConsole = {
      state: state,
      refresh: function () { return loadStack(); },
      start: startStack,
      runCheck: runCheck,
      runBench: runBench,
      scenarioModel: computeScenarioModel,
      readScenario: readScenario,
      setScenario: function (values) {
        state.scenarioTouched = true;
        writeScenarioInputs(values || {});
        renderScenarioDerived();
        return readScenario();
      },
      resetScenario: resetScenario,
      pendingAgents: function () { return state.pendingAgents.slice(); },
      openClient: function (key) {
        for (var i = 0; i < state.slots.length; i++) if (state.slots[i].key === key) return openClient(state.slots[i]);
        return null;
      },
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }
})();
