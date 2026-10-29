/**
 * OPTIONAL official (licensed) collaboration page.
 *
 * This is the "same lab, commercial engine" variant: it uses the real
 * `@grapecity-software/js-collaboration-client` + OT `SharedDoc` + `bind(workbook, doc)`
 * exactly like the parent repo's reference page, so a licensed deployment can be
 * compared against the zero-license mirror client on the same topology.
 *
 * It is bundled by `webpack.official.config.cjs` into `public/official/bundle.js`
 * (`npm run build:official`), because the collaboration packages are CommonJS and pull
 * in SpreadJS itself plus CSS. WITHOUT that bundle the page still renders and explains
 * how to build it — it never shows a blank page.
 *
 * Automation hooks are the same as the mirror page (DEV-CONTRACT §9):
 *   window.__labReady / __labNodeId / __labNodePort / __labRoomId / __labVersion /
 *   window.__labSetCell / window.__labGetCell / window.__labMembers
 */

import * as GC from '@grapecity-software/spread-sheets';
import '@grapecity-software/spread-sheets-collaboration-addon';
import '@grapecity-software/spread-sheets/styles/gc.spread.sheets.excel2013white.css';

import { Client } from '@grapecity-software/js-collaboration-client';
import * as OT from '@grapecity-software/js-collaboration-ot-client';
import { type, bind } from '@grapecity-software/spread-sheets-collaboration-client';

// Marks the bundle as loaded, so index.html can distinguish "bundle missing" from
// "bundle running". Set synchronously, before the first await.
window.__labOfficialBooted = true;

/* -------------------------------------------------------------------- page */
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const roomId = (params.get('room') || 'arch-lab-demo').trim();
const label = (params.get('label') || '官方客户端').trim();

const logEl = () => $('log');

function logLine(text, kind = 'info') {
  const el = logEl();
  if (!el) return;
  const div = document.createElement('div');
  div.className = `line ${kind}`;
  const time = new Date().toLocaleTimeString();
  div.textContent = `${time}  ${text}`;
  el.prepend(div);
  while (el.childElementCount > 80 && el.lastChild) el.removeChild(el.lastChild);
}

function setState(text, kind) {
  const el = $('state');
  if (!el) return;
  el.textContent = text;
  el.className = `badge ${kind}`;
}

function setNode(nodeId, port) {
  if (nodeId) {
    const el = $('node');
    if (el) el.textContent = `${nodeId} (端口 ${port ?? '?'})`;
    window.__labNodeId = nodeId;
    window.__labNodePort = port == null ? null : Number(port);
  }
}

function setVersion(version) {
  const value = Number(version);
  if (!Number.isFinite(value)) return;
  window.__labVersion = value;
  const el = $('version');
  if (el) el.textContent = String(value);
}

/* ------------------------------------------------------------ config fetch */
async function loadConfig() {
  // 1) Explicit override: ?endpoint=http://127.0.0.1:3000
  const explicit = params.get('endpoint');
  if (explicit) {
    return {
      wsUrl: explicit,
      path: params.get('path') || '/collaboration/',
      licenseKey: '',
      designerLicenseKey: '',
      license: { runtime: false, designer: false, server: false, source: 'query' },
    };
  }

  // 2) The lab web server exposes the one endpoint that knows the topology (and,
  //    when configured, the browser-side runtime keys — never the server key).
  try {
    const res = await fetch('/api/collab-config', { cache: 'no-store' });
    if (res.ok) {
      const config = await res.json();
      if (config && config.wsUrl) return config;
    }
  } catch {
    /* fall through to /api/stack */
  }

  // 3) Fallback: derive the entry point from the live topology.
  try {
    const res = await fetch('/api/stack', { cache: 'no-store' });
    if (res.ok) {
      const stack = await res.json();
      const state = stack.state && typeof stack.state === 'object' ? stack.state : stack;
      const config = state.config || stack.config || {};
      let wsUrl = stack.urls?.lb || state.urls?.lb || null;
      if (!config.lb) {
        const nodes = (stack.nodes && stack.nodes.length ? stack.nodes : state.nodes) || [];
        if (nodes.length && nodes[0].port) wsUrl = `${location.protocol}//${location.hostname}:${nodes[0].port}`;
      }
      if (wsUrl) {
        return {
          wsUrl: wsUrl.replace(/\/+$/, ''),
          path: stack.ports?.wsPath || state.ports?.wsPath || '/collaboration/',
          licenseKey: '',
          designerLicenseKey: '',
          license: { runtime: false, designer: false, server: false, source: 'stack' },
        };
      }
    }
  } catch {
    /* fall through to the error below */
  }

  throw new Error('no collaboration endpoint: start a stack in the lab console or pass ?endpoint=http://127.0.0.1:PORT');
}

/* ------------------------------------------------------------------- main */
async function main() {
  if ($('room')) $('room').textContent = roomId;
  if ($('label')) $('label').textContent = label;
  window.__labRoomId = roomId;
  window.__labReady = false;
  window.__labNodeId = null;
  window.__labNodePort = null;
  window.__labVersion = 0;
  window.__labMembers = [];

  const config = await loadConfig();
  logLine(`官方协同端点：${config.wsUrl}${config.path}（impl=${config.impl || 'unknown'}，` +
    `runtime key ${config.license?.runtime ? 'SET' : 'MISSING'}，server key ${config.license?.server ? 'SET' : 'MISSING'}）`,
    config.license?.runtime ? 'info' : 'warn');

  if (config.licenseKey) {
    GC.Spread.Sheets.LicenseKey = config.licenseKey;
  } else {
    logLine('没有 runtime licenseKey。在 127.0.0.1 上 SpreadJS 不显示水印；其它主机需要配置授权。', 'warn');
  }
  if (config.designerLicenseKey && GC.Spread.Sheets.Designer) {
    GC.Spread.Sheets.Designer.LicenseKey = config.designerLicenseKey;
  }

  // Register the spreadsheet OT type before the connection is opened.
  OT.TypesManager.register(type);

  const workbook = new GC.Spread.Sheets.Workbook($('ss'), { sheetCount: 1 });
  const sheet = workbook.getActiveSheet();
  sheet.name('协作工作簿');
  sheet.setColumnWidth(0, 190);
  sheet.setColumnWidth(1, 150);
  sheet.setColumnWidth(2, 130);
  sheet.setRowHeight(0, 30);
  sheet.setActiveCell(0, 0);
  window.__workbook = workbook;

  setState('连接中…', 'warn');
  logLine('正在连接官方协同服务 …');

  // `path` must be an option, not part of the URL (it would become a namespace).
  const conn = new Client(config.wsUrl, { path: config.path || '/collaboration/' }).connect(roomId);
  window.__conn = conn;

  conn.on('licenseValidation', (r) => {
    logLine(`授权校验：status=${r?.status} type=${r?.type} serverKeyType=${r?.serverKeyType} ${r?.message ?? ''}`,
      r?.status === 0 ? 'error' : 'info');
  });

  // The shipped Connection re-emits every inbound "m" frame as a decoded "message"
  // event with the frame spread into positional args: handler(data, type).
  conn.on('message', async (data, typeName) => {
    try {
      const d = await data;
      const t = await typeName;
      if (t === 'sjs-node-info' && d) setNode(d.nodeId, d.port);
    } catch {
      /* not a frame we care about */
    }
  });
  conn.on('connect', () => {
    setState('已连接', 'ok');
    logLine('官方协同连接已建立');
  });
  conn.on('error', (err) => logLine(`连接错误：${err?.data?.message ?? err?.message ?? err}`, 'error'));
  conn.on('disconnect', (reason) => {
    setState(`已断开(${reason})`, 'warn');
    logLine(`连接断开：${reason}`, 'warn');
  });

  const doc = new OT.SharedDoc(conn);
  doc.on('error', (err) => logLine(`共享文档错误：${err?.message ?? err}`, 'error'));

  logLine('正在获取共享文档 …');
  await doc.fetch();

  if (!doc.type) {
    logLine('文档不存在 — 用当前工作簿创建初始文档');
    sheet.setValue(0, 0, 'SpreadJS 官方协同 · 架构实验室');
    sheet.setValue(2, 0, '示例数据');
    sheet.setValue(2, 1, '数量');
    sheet.setValue(3, 0, '授权方式');
    sheet.setValue(3, 1, '官方 OT 引擎');
    sheet.setValue(4, 0, '试试修改这一格');
    sheet.setValue(4, 1, 1);
    await doc.create(workbook.collaboration.toSnapshot(), type.uri, {});
  } else {
    logLine('文档已存在 —— 绑定到共享文档');
  }

  await bind(workbook, doc);
  window.__doc = doc;
  window.__labReady = true;
  setVersion(doc.version ?? 0);
  setState('协同就绪', 'ok');
  logLine('工作簿已绑定共享文档：编辑会以 SpreadJS 操作同步', 'ok');

  // Keep the version hook live: official OT does not expose a single "version" frame
  // the page can listen to, but the SharedDoc tracks it.
  setInterval(() => {
    if (doc.version !== undefined) setVersion(doc.version);
  }, 500);

  window.__labSetCell = (row, col, value) => {
    workbook.getActiveSheet().setValue(Number(row), Number(col), value);
  };
  window.__labGetCell = (row, col) => workbook.getActiveSheet().getValue(Number(row), Number(col));
  // Official presence is a separately licensed feature; the lab's optional page does not
  // enable it, so the member hook reports an empty list rather than pretending.
  window.__labMembers = [];
}

main().catch((err) => {
  console.error(err);
  setState('启动失败', 'error');
  logLine(`FATAL: ${err?.message ?? err}`, 'error');
  const boot = $('boot');
  if (boot) {
    boot.textContent = `官方客户端启动失败：${err?.message ?? err}`;
    boot.className = 'boot error';
  }
});
