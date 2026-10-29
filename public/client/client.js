/**
 * Zero-license SpreadJS collaborative client for the architecture lab.
 *
 * Transport: socket.io, event "m", payload [type, data, compressed] — the same wire
 * shape as the official GrapeCity collaboration client (DEV-CONTRACT §4). This page
 * deliberately uses the raw socket.io UMD bundle + a hand-rolled codec instead of the
 * 10 MB official client bundle, because the whole point of the mirror engine is that
 * a real SpreadJS workbook can be collaborated on over a protocol you can read.
 *
 * Client -> server frames
 *   lab:join    { label, roomId }            register, server replies lab:snapshot
 *   lab:op      { opId, row, col, value }    edit, server replies lab:op-ack + relays
 *   lab:resync  {}                           ask for a fresh lab:snapshot
 *   lab:ping    { t }                        measure latency (lab:pong)
 *
 * Server -> client frames
 *   sjs-node-info  { nodeId, port, adapterEnabled, impl, storeMode, ... }
 *   lab:snapshot   { roomId, docId, version, cells, members, nodeId, storeMode }
 *   lab:op-ack     { opId, version, ts, nodeId }
 *   lab:op         { opId, version, row, col, value, from, fromLabel, nodeId, ts }
 *   lab:presence   { members, nodeId, ts }
 *   lab:error      { code, message }
 *
 * Automation hooks (DEV-CONTRACT §9): window.__labReady / __labNodeId / __labNodePort /
 * __labRoomId / __labVersion / __labSetCell / __labGetCell / __labMembers. Extras used
 * by the lab's own verification: __labStats / __labEndpoint / __labSocketId.
 */
(function () {
  'use strict';

  var SOCKET_IO_EVENT = 'm';
  var COMPRESSION_THRESHOLD = 128;

  var params = new URLSearchParams(location.search);
  var roomId = String(params.get('room') || params.get('roomId') || 'arch-lab-demo').trim();
  var label = String(params.get('label') || '').trim() ||
    ('访客-' + Math.random().toString(36).slice(2, 7));
  var wantSeed = params.get('seed') === '1';
  var socketPath = params.get('path') || '/collaboration/';

  var state = {
    workbook: null,
    sheet: null,
    socket: null,
    endpoint: null,
    nodeId: null,
    nodePort: null,
    adapterEnabled: null,
    impl: null,
    storeMode: null,
    roomId: roomId,
    label: label,
    docId: roomId,
    version: 0,
    members: [],
    socketId: null,
    ready: false,
    applyingRemote: false,
    seenOps: Object.create(null),
    pendingOps: Object.create(null),
    logCount: 0,
    lastPingAt: 0,
    sendChain: Promise.resolve(),
    messageChain: Promise.resolve(),
    autoPingTimer: null,
  };

  var stats = { snapshots: 0, opsSent: 0, opsApplied: 0, opsDeduped: 0, presence: 0 };

  /* ------------------------------------------------------------------ hooks */
  // Declared up front so a headless test can poll them without racing the boot.
  window.__labReady = false;
  window.__labNodeId = null;
  window.__labNodePort = null;
  window.__labRoomId = roomId;
  window.__labVersion = 0;
  window.__labMembers = [];
  window.__labStats = stats;
  window.__labEndpoint = null;

  /* -------------------------------------------------------------------- dom */
  function $(id) { return document.getElementById(id); }

  function setConn(text, kind) {
    var el = $('connBadge');
    if (!el) return;
    el.textContent = text;
    el.className = 'badge ' + kind;
  }

  function setBoot(title, text, isError) {
    var box = $('bootBox');
    if (!box) return;
    box.classList.toggle('error', Boolean(isError));
    var h = box.querySelector('h3');
    var p = $('bootText');
    if (h && title) h.textContent = title;
    if (p && text !== undefined) p.innerHTML = text;
  }

  function hideBoot() {
    var el = $('boot');
    if (!el) return;
    el.classList.add('hidden');
    setTimeout(function () { if (el.parentNode) el.style.display = 'none'; }, 300);
  }

  function fatal(title, html) {
    setBoot(title, html, true);
    setConn('无法连接', 'err');
  }

  function make(tag, className, text) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined && text !== null) el.textContent = String(text);
    return el;
  }

  function esc(text) {
    return String(text === undefined || text === null ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ------------------------------------------------------------------ utils */
  function nowTime() {
    var d = new Date();
    function two(n) { return n < 10 ? '0' + n : String(n); }
    return two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds());
  }

  function cellRef(row, col) {
    var name = '';
    var c = Number(col) + 1;
    while (c > 0) {
      var rem = (c - 1) % 26;
      name = String.fromCharCode(65 + rem) + name;
      c = Math.floor((c - 1) / 26);
    }
    return name + (Number(row) + 1);
  }

  function fmtValue(value) {
    if (value === null || value === undefined) return '（空）';
    if (typeof value === 'string') {
      return value.length > 42 ? JSON.stringify(value.slice(0, 42)) + '…' : JSON.stringify(value);
    }
    if (value instanceof Date) return JSON.stringify(value.toISOString());
    return String(value);
  }

  function shortId(opId) { return String(opId || '').slice(0, 8); }

  function makeOpId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return 'op-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function nodeColor(nodeId) {
    var palette = ['#7c3aed', '#0891b2', '#db2777', '#ea580c', '#2563eb', '#15803d'];
    var hash = 0;
    var s = String(nodeId || '');
    for (var i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
    return palette[hash % palette.length];
  }

  /* ------------------------------------------------------------------- log */
  function addLog(kind, text) {
    var log = $('log');
    if (!log) return;
    var line = make('div', 'line ' + kind);
    line.appendChild(make('span', 'time', nowTime()));
    line.appendChild(make('span', 'text', text));
    log.insertBefore(line, log.firstChild);
    state.logCount++;
    while (state.logCount > 120 && log.lastChild) {
      log.removeChild(log.lastChild);
      state.logCount--;
    }
  }

  /* ----------------------------------------------------------------- labels */
  function renderIdentity() {
    $('roomChip').textContent = state.roomId;
    $('labelChip').textContent = state.label;
    $('docRoom').textContent = state.roomId;
    $('docId').textContent = state.docId || '—';
    document.title = '协同客户端 · ' + state.roomId + ' · ' + state.label;
  }

  function renderNode() {
    var idEl = $('nodeId');
    var dot = $('nodeDot');
    if (state.nodeId) {
      idEl.textContent = state.nodeId;
      dot.classList.add('live');
      dot.style.background = nodeColor(state.nodeId);
      $('nodePort').textContent = state.nodePort == null ? '—' : String(state.nodePort);
      window.__labNodeId = state.nodeId;
      window.__labNodePort = state.nodePort == null ? null : Number(state.nodePort);
    }
    $('nodeAdapter').textContent = state.adapterEnabled === null || state.adapterEnabled === undefined
      ? '—' : (state.adapterEnabled ? '已启用' : '未启用');
    $('nodeStore').textContent = state.storeMode === 'shared' ? '共享存储' :
      state.storeMode === 'local' ? '每节点本地' : (state.storeMode || '—');
    $('nodeImpl').textContent = state.impl || '—';
    updateNodeNote();
  }

  function updateNodeNote() {
    var note = $('nodeNote');
    if (!note) return;
    var others = state.members.filter(function (m) {
      return m.nodeId && state.nodeId && m.nodeId !== state.nodeId;
    });
    if (!state.nodeId) {
      note.textContent = '正在确认这个客户端由哪个协同服务节点提供服务…';
      note.style.background = '';
      note.style.color = '';
      return;
    }
    if (others.length && state.adapterEnabled === false) {
      note.innerHTML = '⚠ 房间里有 <b>' + others.length + '</b> 位成员在其它节点，而本架构<b>没有</b>跨节点适配器：' +
        '他们的编辑不会实时到达你这里。这正是“分区多机没有亲和”时会出现的现象。';
      note.style.background = '#fffbeb';
      note.style.color = '#92400e';
      return;
    }
    if (others.length && state.adapterEnabled) {
      note.textContent = '房间里有 ' + others.length + ' 位成员在其它节点；Redis 适配器会把实时编辑跨节点转发过来。';
      note.style.background = '#ecfdf3';
      note.style.color = '#166534';
      return;
    }
    note.textContent = '同一个房间的成员如果落在不同节点，只有启用 Redis 适配器时编辑才能跨节点送达。';
    note.style.background = '';
    note.style.color = '';
  }

  function renderVersion() {
    $('versionNum').textContent = String(state.version);
    window.__labVersion = state.version;
  }

  function setVersion(version) {
    var v = Number(version);
    if (!Number.isFinite(v)) return;
    if (v > state.version) {
      state.version = v;
      renderVersion();
    }
  }

  function renderSocketId() {
    $('socketId').textContent = state.socketId || '—';
    window.__labSocketId = state.socketId || null;
  }

  function renderMembers(members) {
    state.members = Array.isArray(members) ? members.slice() : [];
    window.__labMembers = state.members;
    var list = $('members');
    var count = $('memberCount');
    if (count) count.textContent = String(state.members.length);
    if (!list) return;
    list.innerHTML = '';
    if (!state.members.length) {
      list.appendChild(make('li', 'empty', '等待成员加入…'));
      updateNodeNote();
      return;
    }
    state.members.forEach(function (m) {
      var li = make('li');
      var dot = make('span', 'dot-sm');
      dot.style.background = nodeColor(m.nodeId || 'unknown');
      var who = make('div', 'who');
      var name = make('div', 'name', m.label || m.id || '匿名');
      var sub = make('div', 'sub', m.id ? '连接 ' + String(m.id).slice(0, 10) : '');
      who.appendChild(name);
      who.appendChild(sub);
      li.appendChild(dot);
      li.appendChild(who);
      if (m.id && state.socketId && m.id === state.socketId) {
        li.appendChild(make('span', 'me-tag', '我'));
      }
      var nodeTag = make('span', 'member-node' + (m.nodeId && state.nodeId && m.nodeId !== state.nodeId ? ' cross' : ''),
        m.nodeId || '未知节点');
      li.appendChild(nodeTag);
      list.appendChild(li);
    });
    updateNodeNote();
  }

  /* ----------------------------------------------------------------- codec */
  function byteLength(text) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).length;
    return unescape(encodeURIComponent(text)).length;
  }

  function compressToBase64(text) {
    if (typeof CompressionStream === 'undefined' || typeof Blob === 'undefined') {
      return Promise.resolve(null);
    }
    var bytes = new TextEncoder().encode(text);
    var stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Response(stream).arrayBuffer().then(function (buf) {
      var arr = new Uint8Array(buf);
      var binary = '';
      for (var i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
      return btoa(binary);
    }).catch(function () { return null; });
  }

  function decompressFromBase64(b64) {
    if (typeof DecompressionStream === 'undefined') return Promise.resolve(null);
    try {
      var raw = Uint8Array.from(atob(b64), function (c) { return c.charCodeAt(0); });
      var stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'));
      return new Response(stream).text().then(function (text) { return JSON.parse(text); })
        .catch(function () { return null; });
    } catch (err) {
      return Promise.resolve(null);
    }
  }

  /** Encode one frame exactly like the server codec: [type, data, compressed]. */
  function encodeFrame(type, data) {
    var json;
    try { json = JSON.stringify(data); } catch (err) { json = ''; }
    if (!json || byteLength(json) < COMPRESSION_THRESHOLD) {
      return Promise.resolve([type, data, false]);
    }
    return compressToBase64(json).then(function (b64) {
      return b64 ? [type, b64, true] : [type, data, false];
    });
  }

  function decodeFrame(payload) {
    if (!Array.isArray(payload) || payload.length < 2) return Promise.resolve([payload, null]);
    var type = payload[0];
    var data = payload[1];
    var compressed = payload[2];
    if (!compressed) return Promise.resolve([data, type == null ? null : type]);
    if (typeof data !== 'string') return Promise.resolve([data, type == null ? null : type]);
    return decompressFromBase64(data).then(function (decoded) {
      return [decoded === null ? data : decoded, type == null ? null : type];
    });
  }

  /** Emit through a promise chain so compression never reorders two edits. */
  function emitFrame(type, data) {
    var socket = state.socket;
    if (!socket) return Promise.resolve(false);
    state.sendChain = state.sendChain.then(function () {
      return encodeFrame(type, data).then(function (payload) {
        if (!socket.connected) return false;
        socket.emit(SOCKET_IO_EVENT, payload);
        return true;
      });
    }).catch(function (err) {
      addLog('error', '发送失败：' + (err && err.message ? err.message : err));
      return false;
    });
    return state.sendChain;
  }

  /* -------------------------------------------------------------- endpoint */
  function stackState(raw) {
    if (!raw || typeof raw !== 'object') return {};
    if (raw.state && typeof raw.state === 'object') return raw.state;
    return raw;
  }

  /**
   * Pick the collaboration endpoint out of the aggregated `GET /api/stack` payload
   * (shape locked by the Lead in DEV-CONTRACT §7):
   *
   *   { running, state:{config.lb, nodes:[{port}], lb:{port}}, urls:{lb,web},
   *     nodes:[{id,port,...}], lb:{port,...} }
   *
   * With a load balancer we must use the LB URL (that is the whole point of the
   * multi-server modes); without one, the first node is the only entry point.
   */
  function pickStackEndpoint(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var s = stackState(raw);
    var cfg = (s && s.config) || raw.config || {};
    var urls = raw.urls || (s && s.urls) || {};
    if (cfg.lb && urls.lb) return String(urls.lb).replace(/\/+$/, '');
    var nodes = (Array.isArray(raw.nodes) && raw.nodes) ||
      (Array.isArray(s.nodes) && s.nodes) || [];
    if (nodes.length && nodes[0].port) {
      return location.protocol + '//' + location.hostname + ':' + nodes[0].port;
    }
    var lb = raw.lb || (s && s.lb) || {};
    if (lb.port) return location.protocol + '//' + location.hostname + ':' + lb.port;
    if (urls.lb) return String(urls.lb).replace(/\/+$/, '');
    return null;
  }

  /**
   * Determine the collaboration endpoint.
   *
   *   1. ?endpoint=http://127.0.0.1:3000   explicit full base URL (tests, deep links)
   *   2. ?port=8082                        explicit port on the page's host
   *   3. GET /api/stack                    the lab console's live topology
   *
   * Returns null when nothing can be resolved; the page then explains how to start
   * the stack instead of failing silently.
   */
  function resolveEndpoint() {
    var explicit = params.get('endpoint');
    if (explicit) return Promise.resolve(explicit.replace(/\/+$/, ''));
    var port = params.get('port');
    if (port) return Promise.resolve(location.protocol + '//' + location.hostname + ':' + port);
    return fetch('/api/stack', { cache: 'no-store' }).then(function (res) {
      if (!res.ok) throw new Error('/api/stack -> ' + res.status);
      return res.json();
    }).then(function (raw) {
      return pickStackEndpoint(raw);
    }).catch(function () { return null; });
  }

  /* -------------------------------------------------------------- workbook */
  function buildWorkbook() {
    if (!window.GC || !window.GC.Spread || !window.GC.Spread.Sheets) {
      fatal('SpreadJS 未加载', '无法从 <code>/vendor/spread-sheets.js</code> 找到 GC.Spread.Sheets，请检查 web 服务的 /vendor 路由。');
      return false;
    }
    var host = $('ss');
    var workbook = new window.GC.Spread.Sheets.Workbook(host, {
      sheetCount: 1,
      tabStripVisible: true,
      allowUserResize: true,
    });
    var sheet = workbook.getActiveSheet();
    sheet.name('协作工作簿');
    sheet.setColumnWidth(0, 210);
    sheet.setColumnWidth(1, 150);
    sheet.setColumnWidth(2, 130);
    sheet.setColumnWidth(3, 130);
    sheet.setRowHeight(0, 30);
    sheet.setActiveCell(0, 0);

    workbook.bind(window.GC.Spread.Sheets.Events.CellChanged, function (sender, args) {
      if (state.applyingRemote) return;
      if (args.propertyName && args.propertyName !== 'value') return;
      var sheetObj = args.sheet || state.sheet;
      if (!sheetObj) return;
      var value = sheetObj.getValue(args.row, args.col);
      if (value instanceof Date) value = value.toISOString();
      sendOp(args.row, args.col, value);
    });

    state.workbook = workbook;
    state.sheet = sheet;
    window.__labWorkbook = workbook; // convenience for debugging, not part of the contract
    renderVersion();
    return true;
  }

  /** Clear the viewport quietly; used when a snapshot replaces the whole document. */
  function clearSheet() {
    var sheet = state.sheet;
    if (!sheet) return;
    sheet.clear(0, 0, Math.max(sheet.getRowCount(), 200), Math.max(sheet.getColumnCount(), 26));
  }

  function applySnapshot(snap) {
    if (!snap || typeof snap !== 'object') return;
    stats.snapshots++;
    var firstSnapshot = !state.ready;
    state.applyingRemote = true;
    try {
      state.workbook.suspendPaint();
      clearSheet();
      var cells = snap.cells || {};
      Object.keys(cells).forEach(function (key) {
        var parts = key.split(',');
        var row = Number(parts[0]);
        var col = Number(parts[1]);
        if (!Number.isFinite(row) || !Number.isFinite(col)) return;
        state.sheet.setValue(row, col, cells[key]);
      });
      state.workbook.resumePaint();
    } finally {
      state.applyingRemote = false;
    }

    state.docId = snap.docId || snap.roomId || state.roomId;
    state.version = Number(snap.version) || 0;
    if (snap.nodeId && !state.nodeId) state.nodeId = snap.nodeId;
    if (snap.storeMode) state.storeMode = snap.storeMode;
    renderVersion();
    renderIdentity();
    renderNode();
    renderMembers(snap.members || []);
    addLog('ok', '已加载共享文档快照：版本 v' + state.version + '，' +
      Object.keys(snap.cells || {}).length + ' 个单元格');

    if (firstSnapshot) {
      state.ready = true;
      window.__labReady = true;
      hideBoot();
      setConn('已连接', 'ok');
      addLog('ok', '协同就绪 — 可以开始编辑');
      maybeSeed(snap);
      startAutoPing();
    }
  }

  function maybeSeed(snap) {
    if (!wantSeed) return;
    var hasCells = snap && snap.cells && Object.keys(snap.cells).length > 0;
    if (hasCells || (snap && Number(snap.version) > 0)) return;
    var rows = [
      [0, 0, 'SpreadJS 实时协同 · 架构实验室'],
      [2, 0, '示例数据'],
      [2, 1, '数量'],
      [3, 0, '授权方式'],
      [3, 1, '零授权 mirror'],
      [4, 0, '试试修改这一格'],
      [4, 1, 1],
      [5, 0, '打开的节点'],
      [5, 1, state.nodeId || '未知'],
    ];
    rows.forEach(function (r) { sendOp(r[0], r[1], r[2]); });
    addLog('info', '这是空文档，已写入一行示例数据（?seed=1 触发）');
  }

  function applyRemoteOp(op) {
    if (!op || typeof op !== 'object') return;
    var opId = op.opId;
    if (opId && state.seenOps[opId]) {
      stats.opsDeduped++;
      addLog('dedupe', '忽略重复投递的编辑 ' + shortId(opId) + '（幂等去重）');
      return;
    }
    if (opId) state.seenOps[opId] = true;
    var value = op.value instanceof Date ? op.value.toISOString() : op.value;
    state.applyingRemote = true;
    try {
      state.sheet.setValue(op.row, op.col, value);
    } finally {
      state.applyingRemote = false;
    }
    stats.opsApplied++;
    setVersion(op.version);
    var from = op.fromLabel || op.from || '其它成员';
    var node = op.nodeId || '未知节点';
    var cross = state.nodeId && op.nodeId && state.nodeId !== op.nodeId;
    addLog('recv', '← ' + from + '（' + node + (cross ? ' · 跨节点' : '') + '）修改 ' +
      cellRef(op.row, op.col) + ' = ' + fmtValue(value) + ' · v' + (op.version == null ? '?' : op.version));
  }

  /* ---------------------------------------------------------------- actions */
  function sendOp(row, col, value) {
    if (!state.socket || !state.socket.connected) {
      addLog('warn', '尚未连接协同服务，这次编辑只留在本地');
      return;
    }
    var opId = makeOpId();
    var payload = {
      opId: opId,
      row: row,
      col: col,
      value: value === undefined ? null : value,
      baseVersion: state.version,
      ts: Date.now(),
    };
    state.seenOps[opId] = true;
    state.pendingOps[opId] = { row: row, col: col, sentAt: Date.now() };
    stats.opsSent++;
    emitFrame('lab:op', payload);
    addLog('op', '→ 发送编辑 ' + cellRef(row, col) + ' = ' + fmtValue(payload.value) +
      ' · ' + shortId(opId) + ' · 基于 v' + state.version);
  }

  function sendJoin(reason) {
    if (!state.socket || !state.socket.connected) return;
    emitFrame('lab:join', { label: state.label, roomId: state.roomId });
    addLog('info', '加入房间「' + state.roomId + '」，等待服务端下发快照' + (reason ? '（' + reason + '）' : ''));
  }

  function requestPing() {
    if (!state.socket || !state.socket.connected) return;
    state.lastPingAt = Date.now();
    emitFrame('lab:ping', { t: state.lastPingAt });
  }

  function startAutoPing() {
    if (state.autoPingTimer) return;
    requestPing();
    state.autoPingTimer = setInterval(requestPing, 10000);
  }

  /* --------------------------------------------------------------- handlers */
  function handleFrame(type, data) {
    switch (type) {
      case 'sjs-node-info': {
        state.nodeId = data && data.nodeId ? data.nodeId : state.nodeId;
        if (data && data.port != null) state.nodePort = Number(data.port);
        if (data && data.adapterEnabled != null) state.adapterEnabled = Boolean(data.adapterEnabled);
        if (data && data.impl) state.impl = data.impl;
        if (data && data.storeMode) state.storeMode = data.storeMode;
        renderNode();
        addLog('info', '服务节点：' + state.nodeId + '（端口 ' + state.nodePort + '，' +
          (state.impl || '?') + ' 实现，适配器' + (state.adapterEnabled ? '已启用' : '未启用') + '）');
        break;
      }
      case 'lab:snapshot':
        applySnapshot(data);
        break;
      case 'lab:op-ack': {
        var version = data && data.version;
        setVersion(version);
        var opId = data && data.opId;
        if (opId && state.pendingOps[opId]) {
          var pending = state.pendingOps[opId];
          var ms = Date.now() - pending.sentAt;
          delete state.pendingOps[opId];
          addLog('ok', '✓ 服务端已接受 ' + cellRef(pending.row, pending.col) + ' 于 v' + version +
            '（' + ms + ' ms，' + (data.nodeId || state.nodeId) + '）');
        }
        break;
      }
      case 'lab:op':
        applyRemoteOp(data);
        break;
      case 'lab:presence':
        stats.presence++;
        renderMembers((data && data.members) || []);
        break;
      case 'lab:error':
        addLog('error', '服务端错误：' + ((data && (data.message || data.code)) || '未知错误'));
        break;
      case 'lab:pong': {
        var rtt = data && data.t ? (Date.now() - Number(data.t)) : null;
        if (rtt != null && Number.isFinite(rtt)) {
          $('rtt').textContent = rtt + ' ms';
          window.__labRtt = rtt;
        }
        break;
      }
      default:
        // Unknown app frame: keep it visible in the log instead of dropping it silently.
        addLog('warn', '收到未知消息类型 ' + type);
        break;
    }
  }

  /* --------------------------------------------------------------- connect */
  function connect(endpoint) {
    state.endpoint = endpoint;
    window.__labEndpoint = endpoint;
    addLog('info', '协同服务端点：' + endpoint + socketPath);
    setConn('连接中…', 'warn');

    var socket = window.io(endpoint, {
      path: socketPath,
      transports: ['websocket'],
      forceNew: true,
      autoConnect: false,
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 4000,
      timeout: 8000,
      query: {
        roomId: state.roomId,
        label: state.label,
        clientId: state.label + '-' + Date.now().toString(36),
      },
    });
    state.socket = socket;

    socket.on('connect', function () {
      state.socketId = socket.id;
      renderSocketId();
      setConn('已连接', 'ok');
      addLog('ok', 'WebSocket 已连接（socket.id ' + socket.id + '）');
      sendJoin('连接建立');
    });

    socket.on(SOCKET_IO_EVENT, function (payload) {
      // Serialize decoding: a compressed snapshot must not be overtaken by a small op.
      state.messageChain = state.messageChain.then(function () {
        return decodeFrame(payload).then(function (decoded) {
          handleFrame(decoded[1], decoded[0]);
        });
      }).catch(function (err) {
        addLog('error', '消息处理失败：' + (err && err.message ? err.message : err));
      });
    });

    socket.on('connect_error', function (err) {
      setConn('连接失败', 'err');
      var msg = (err && err.message) ? err.message : String(err);
      addLog('error', '连接失败：' + msg);
      if (!state.ready) {
        setBoot('无法连接协同服务', '端点 <code>' + esc(endpoint) + '</code> 连接失败：' +
          esc(msg) + '<br>请先在控制台启动一个架构，或带上 <code>?port=8082</code> 直连某个节点。', true);
      }
    });

    socket.on('disconnect', function (reason) {
      state.socketId = null;
      renderSocketId();
      setConn('已断开', 'warn');
      addLog('warn', '连接已断开：' + (reason || 'unknown') + '（自动重连中…）');
      if (state.autoPingTimer) { clearInterval(state.autoPingTimer); state.autoPingTimer = null; }
    });

    socket.io.on('reconnect', function (attempt) {
      addLog('ok', '重连成功（第 ' + attempt + ' 次尝试）');
    });

    socket.connect();
  }

  /* ------------------------------------------------------------------- boot */
  function boot() {
    renderIdentity();
    renderNode();
    renderSocketId();
    addLog('info', '页面启动：房间「' + state.roomId + '」，昵称「' + state.label + '」');
    if (!buildWorkbook()) return;

    resolveEndpoint().then(function (endpoint) {
      if (!endpoint) {
        fatal('找不到协同服务端点',
          '这个页面无法从 <code>/api/stack</code> 得知协同服务地址。<br>' +
          '请先在控制台启动一个架构，或用 <code>?port=8082</code> / ' +
          '<code>?endpoint=http://127.0.0.1:3000</code> 指定一个节点或负载均衡器。');
        return;
      }
      connect(endpoint);
    }).catch(function (err) {
      fatal('启动失败', esc(err && err.message ? err.message : err));
    });
  }

  /* ---------------------------------------------------------------- hooks API */
  window.__labSetCell = function (row, col, value) {
    if (!state.sheet) return null;
    state.sheet.setValue(Number(row), Number(col), value);
    return value;
  };
  window.__labGetCell = function (row, col) {
    if (!state.sheet) return null;
    return state.sheet.getValue(Number(row), Number(col));
  };
  window.__labResync = function () {
    if (state.socket && state.socket.connected) emitFrame('lab:resync', {});
  };

  /* ------------------------------------------------------------------- ui */
  var resyncBtn = $('resyncBtn');
  if (resyncBtn) {
    resyncBtn.addEventListener('click', function () {
      if (!state.socket || !state.socket.connected) { addLog('warn', '尚未连接，无法重新同步'); return; }
      emitFrame('lab:resync', {});
      addLog('info', '已请求重新同步');
    });
  }
  var pingBtn = $('pingBtn');
  if (pingBtn) pingBtn.addEventListener('click', requestPing);

  window.addEventListener('beforeunload', function () {
    if (state.socket) {
      try { state.socket.disconnect(); } catch (err) { /* ignore */ }
    }
  });

  // `?auto=1` is the headless hint from DEV-CONTRACT §9: nothing to click, the page
  // joins from the query string on its own (which is already the default behaviour),
  // so it simply gets logged for the record.
  if (params.get('auto') === '1') addLog('info', '自动模式（?auto=1）：无需操作，页面自动加入房间');

  boot();
})();
