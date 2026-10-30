/**
 * Report rendering and persistence.
 *
 * A check writes two files and the console serves the newest pair:
 *   reports/check-<UTC>.json  machine-readable, used by `compare` and other scripts
 *   reports/check-<UTC>.md    human-readable, the artefact a user pastes into a ticket
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPORT_DIR } from '../lab/paths.mjs';
import { MODES, VARIANTS } from '../lab/modes.mjs';

const STATUS_LABEL = {
  pass: '✅ PASS',
  fail: '❌ FAIL',
  'n/a': '— N/A',
  record: '· RECORD',
  'expected-failure': '⚠️ EXPECTED-FAIL',
};

export function timestampForFile(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
}

function fmtMs(value) {
  return value === null || value === undefined ? '—' : `${value} ms`;
}

export function renderMarkdown(result) {
  const modeLabel = MODES[result.mode]?.label ?? result.mode;
  const variantLabel = result.variant ? VARIANTS[result.variant]?.label ?? result.variant : null;
  const lines = [];
  lines.push(`# mirror 架构体检报告`);
  lines.push('');
  lines.push(`- 时间：${result.generatedAt}`);
  lines.push(`- 拓扑：**${modeLabel}**${variantLabel ? `（变体：${variantLabel}）` : ''}`);
  lines.push(`- 实际配置：${result.describe ?? '—'}`);
  lines.push(`- 引擎：${result.engine === 'mirror' ? 'mirror 演示协同协议' : '官方实现（real）'}`);
  if (result.scope) lines.push(`- 验证范围：${result.scope}`);
  if (result.engine === 'mirror') lines.push('- 硬件评估必须使用真实 SpreadJS、官方协同服务和业务负载；本报告只验证 mirror 框架行为。');
  const envInfo = result.environment ?? {};
  if (envInfo.remoteNodes) {
    lines.push(
      `- 多机：${envInfo.localNodes} 个本机节点 + ${envInfo.remoteNodes} 个远端节点（共 ${envInfo.totalNodes} 个）`,
    );
  }
  if (result.scenario) {
    const m = result.scenario.model ?? {};
    lines.push(
      `- 场景：${result.scenario.describe ?? `${result.scenario.users} 用户`}` +
        `（目标编辑 ${m.opsPerSecond ?? '—'} 次/s · 推算投递 ${m.fanoutPerSecond ?? '—'} 条/s）`,
    );
    if (result.scenario.load) {
      const load = result.scenario.load;
      lines.push(
        `- 场景实测：${load.clients} 客户端${load.capped ? '（按上限收敛）' : ''} · ` +
          `${load.ops} 次编辑 / ${load.opsFailed} 失败 · ACK p50 ${fmtMs(load.ackMs?.p50)} / p95 ${fmtMs(load.ackMs?.p95)} / p99 ${fmtMs(load.ackMs?.p99)} · ` +
          `推算投递量 ${load.fanoutPerSecond} 条/s`,
      );
      if (load.writingMs !== undefined && load.timingBasis !== 'legacy-elapsed-fallback') {
        lines.push(`- 负载窗口：连接 ${load.connectionMs} ms · 写入 ${load.writingMs} ms · 发送 ${load.sentOpsPerSecond} 次/s · 目标发送速率达成 ${Number((load.targetRateAchievement * 100).toFixed(1))}%`);
        lines.push('- 吞吐仅以写入窗口为分母；投递量由成功写入和已连接房间人数推算，不是逐条收件确认。');
      } else if (load.elapsedMs !== undefined) {
        lines.push(`- 旧统计口径：总窗口 ${load.elapsedMs} ms 包含建连，需重测后比较写入速率。`);
      }
      if (load.receiveWindowMs !== undefined) lines.push(`- 广播实收 ${load.broadcastReceived} 条，接收窗口 ${load.receiveWindowMs} ms；接收率按此独立窗口计算。`);
      if (load.roomDistribution) lines.push(`- 已连接房间人数分布（人数:房间数）：${JSON.stringify(load.roomDistribution.histogram)}`);
    }
  }
  lines.push(`- 结论：**${result.summary.status}** — ${result.summary.headline}`);
  lines.push('');
  lines.push('## 检查项');
  lines.push('');
  lines.push('| 检查 | 结果 | 说明 |');
  lines.push('| --- | --- | --- |');
  for (const check of result.checks) {
    const detail = String(check.detail ?? '').replace(/\|/g, '\\|');
    lines.push(`| ${check.label}<br><sub>${check.id}</sub> | ${STATUS_LABEL[check.status] ?? check.status} | ${detail} |`);
  }
  lines.push('');
  if (result.variant) {
    lines.push('> 这是刻意复现的反模式，FAIL 是预期结果，用来证明“这样配会坏在哪”。');
    lines.push('');
  }
  lines.push('## 关键数字');
  lines.push('');
  const m = result.metrics ?? {};
  lines.push(`- 写入确认（ACK）：${m.ackMs ? `p50 ${fmtMs(m.ackMs.p50)} / p95 ${fmtMs(m.ackMs.p95)} / p99 ${fmtMs(m.ackMs.p99)}` : '—'}`);
  lines.push(`- 同节点编辑到达：${fmtMs(m.sameNodeMs)}`);
  lines.push(`- 跨节点编辑到达：${fmtMs(m.crossNodeMs)}`);
  if (m.placement) lines.push(`- 同房间放置：${m.placement.nodesUsed} 个节点（${(m.placement.placement ?? []).join(' / ')}）`);
  if (m.load) {
    lines.push(
      `- 场景负载：${m.load.clients} 客户端 · ACK p95 ${fmtMs(m.load.ack?.p95)} · ` +
        `推算投递量 ${m.load.fanoutPerSecond} 条/s`,
    );
  }
  lines.push('');
  lines.push('## 拓扑');
  lines.push('');
  lines.push('```');
  for (const node of result.topology.nodes ?? []) {
    const where = node.remote ? `  远端 ${node.host ?? '?'}` : '';
    lines.push(
      `${node.id}  :${node.port}  impl=${node.impl ?? '?'} adapter=${node.adapter} store=${node.store ?? '?'} clients=${node.clients}${where}`,
    );
  }
  if (result.topology.lb) lines.push(`负载均衡 :${result.topology.lb.port} 策略=${result.topology.lb.strategy}`);
  if (result.topology.redis) lines.push(`Redis ${result.topology.redis.url} (${result.topology.redis.mode})`);
  lines.push('```');
  lines.push('');
  if (result.summary.advice?.length) {
    lines.push('## 建议');
    lines.push('');
    for (const advice of result.summary.advice) lines.push(`- ${advice}`);
    lines.push('');
  }
  lines.push('## 如何读这张表');
  lines.push('');
  lines.push('- `PASS`：该拓扑承诺的能力，实测成立。');
  lines.push('- `FAIL`：该拓扑承诺的能力，实测不成立——这是需要处理的缺陷。');
  lines.push('- `RECORD`：该拓扑不承诺、但值得记录的数字（例如分区模式下的跨节点延迟）。');
  lines.push('- `N/A`：在当前拓扑下没有意义，或本机环境无法验证（原因写在说明里）。');
  lines.push('- `EXPECTED-FAIL`：反模式变体的预期失败，用来演示“这样配会坏”。');
  lines.push('');
  lines.push('> “最终数据一致”不等于“实时协同可用”。本报告同时测量有界时间内的投递与最终文档状态，');
  lines.push('> 因为只后者会通过，才是最危险的误判。');
  lines.push('');
  return lines.join('\n');
}

export function writeReport(result, outDir = REPORT_DIR) {
  mkdirSync(outDir, { recursive: true });
  const base = `check-${timestampForFile(new Date(result.generatedAt))}`;
  const jsonFile = resolve(outDir, `${base}.json`);
  const mdFile = resolve(outDir, `${base}.md`);
  writeFileSync(jsonFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  writeFileSync(mdFile, renderMarkdown(result), 'utf8');
  return { json: jsonFile, markdown: mdFile, base };
}

/** Newest `check-*.json` in the report dir, or null. */
export function latestReport(outDir = REPORT_DIR) {
  let files;
  try {
    files = readdirSync(outDir).filter((f) => f.startsWith('check-') && f.endsWith('.json'));
  } catch {
    return null;
  }
  if (!files.length) return null;
  files.sort();
  const newest = files[files.length - 1];
  const jsonPath = resolve(outDir, newest);
  const mdPath = jsonPath.replace(/\.json$/, '.md');
  let json = null;
  let markdown = '';
  try {
    json = JSON.parse(readFileSync(jsonPath, 'utf8'));
  } catch {
    return null;
  }
  try {
    markdown = readFileSync(mdPath, 'utf8');
  } catch {
    markdown = renderMarkdown(json);
  }
  return { json, markdown, file: { json: jsonPath, markdown: mdPath }, generatedAt: json.generatedAt };
}

/** Human labels for the "期望" column (what the topology promises). */
const EXPECT_LABEL = {
  pass: '必须通过',
  record: '记录',
  'n/a': '—',
  colocated: '必须同节点',
  'not-required': '不承诺',
  'not-dangerous': '不能误判',
};

/** Plain-text matrix for the terminal. */
export function renderCliMatrix(result) {
  const rows = result.checks.map((check) => ({
    id: check.id,
    label: check.label,
    status: STATUS_LABEL[check.status] ?? check.status,
    expected: EXPECT_LABEL[check.expected] ?? check.expected ?? '—',
    detail: check.detail ?? '',
  }));
  const labelWidth = Math.max(...rows.map((r) => displayWidth(r.label)), 4);
  const expectWidth = Math.max(...rows.map((r) => displayWidth(r.expected)), 6);
  const lines = [];
  for (const row of rows) {
    const labelPad = ' '.repeat(Math.max(0, labelWidth - displayWidth(row.label)));
    const expectPad = ' '.repeat(Math.max(0, expectWidth - displayWidth(row.expected)));
    lines.push(
      `${row.status.padEnd(18)} ${row.expected}${expectPad}  ${row.label}${labelPad}  ${row.detail}`,
    );
  }
  return lines.join('\n');
}

/** CJK-aware display width so the CLI matrix lines up. */
function displayWidth(text) {
  let width = 0;
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    width += code >= 0x1100 && (code <= 0x115f || (code >= 0x2e80 && code <= 0xa4cf)) ? 2 : 1;
  }
  return width;
}
