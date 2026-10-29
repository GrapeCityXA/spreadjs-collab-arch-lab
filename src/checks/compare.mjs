/**
 * `npm run compare` — run every topology in turn and produce one comparison table.
 *
 * This is the "answer the question in one command" path: it starts each topology,
 * runs the same check against it, stops it, and writes a side-by-side report. The
 * user's own machine supplies the numbers, so the decision is based on evidence
 * from their environment rather than on a vendor slide.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPORT_DIR } from '../lab/paths.mjs';
import { MODES, VARIANT_IDS, VARIANTS } from '../lab/modes.mjs';
import { up, down } from '../lab/orchestrator.mjs';
import { runCheck } from '../checks/runner.mjs';
import { timestampForFile } from '../checks/report.mjs';
import { formatCores } from '../lab/scenario.mjs';

const CHECK_IDS = ['room.placement', 'realtime.crossNode', 'join.consistency', 'store.consistency', 'eventual.mask'];

export function comparisonExitCode(results) {
  return !results.length || results.some((item) => item.error ||
    item.result?.summary?.status !== (item.variant ? 'expected-broken' : 'healthy')) ? 1 : 0;
}

const STATUS_LABEL = {
  pass: 'PASS',
  fail: 'FAIL',
  'n/a': 'N/A',
  record: 'RECORD',
  'expected-failure': 'EXPECTED-FAIL',
};

function getCheck(result, id) {
  return result.checks.find((c) => c.id === id);
}

function cell(result, id) {
  const check = getCheck(result, id);
  if (!check) return '—';
  return STATUS_LABEL[check.status] ?? check.status;
}

function degradeCell(result) {
  const rt = getCheck(result, 'realtime.crossNode');
  const ms = rt?.metrics?.latencyMs;
  if (ms !== undefined && ms !== null) return `${ms} ms`;
  return cell(result, 'realtime.crossNode');
}

function renderComparison(results) {
  const lines = [];
  lines.push('# 三种协同架构对比（本机实测）');
  lines.push('');
  lines.push(`- 生成时间：${new Date().toISOString()}`);
  lines.push('- 验证范围：mirror 演示的消息转发、房间隔离与文档共享；不代表官方 OT 行为或 SpreadJS 容量。');
  const scenarioResult = results.find((r) => r.result?.scenario)?.result?.scenario;
  if (scenarioResult) {
    lines.push(
      `- 场景（三种拓扑共用）：${scenarioResult.describe}（模型：≈ ${scenarioResult.model?.opsPerSecond} 次编辑/s · ` +
        `扇出 ${scenarioResult.model?.fanoutPerSecond} 条/s · 预测 ${formatCores(scenarioResult.model?.predictedCores)} 核）`,
    );
  }
  lines.push('- 说明：每一行都是在本机按该拓扑真实启动后跑同一套体检得到的，不是理论推导。');
  lines.push('');
  lines.push('| 拓扑 | 结论 | 同房间放置 | 跨节点实时 | 跨节点加入 | 文档版本一致 | ACK p50/p95 | 说明 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const item of results) {
    if (item.error) {
      lines.push(`| ${item.label} | ERROR | — | — | — | — | — | ${item.error.replace(/\|/g, '\\|')} |`);
      continue;
    }
    const result = item.result;
    const ack = result.metrics?.ackMs;
    lines.push(
      `| ${item.label} | ${result.summary.status} | ${cell(result, 'room.placement')} | ${degradeCell(result)} | ${cell(
        result,
        'join.consistency',
      )} | ${cell(result, 'store.consistency')} | ${ack ? `${ack.p50} / ${ack.p95}` : '—'} | ${result.summary.headline.replace(/\|/g, '\\|')} |`,
    );
  }
  lines.push('');
  lines.push('## 怎么读');
  lines.push('');
  lines.push('- **同房间放置**：分区（sharded）模式下这一项必须是 PASS —— 同一房间落到同一节点是它能成立的前提。');
  lines.push('- **跨节点实时**：共享（shared）模式下这一项必须是 PASS；分区模式下是 N/A（本来就不共享）。');
  lines.push('- **跨节点加入**：换一个节点加入同一房间能不能看到文档。共享模式必须 PASS，否则说明只加了适配器、没有共享文档库。');
  lines.push('- **ACK p50/p95**：写入确认延迟，反映本机这台机器的处理能力，不等于生产指标。');
  lines.push('');
  return lines.join('\n');
}

/**
 * @param {{modes?: string[], includeVariants?: boolean, scenario?: object, log?: object, onProgress?: Function}} options
 */
export async function runCompare({
  modes = ['single', 'sharded', 'shared'],
  includeVariants = false,
  scenario = undefined,
  log = console,
} = {}) {
  const targets = modes.map((mode) => ({ mode, variant: null, label: MODES[mode]?.label ?? mode }));
  if (includeVariants) {
    for (const variant of VARIANT_IDS) {
      targets.push({ mode: null, variant, label: VARIANTS[variant]?.label ?? variant });
    }
  }

  const results = [];
  for (const target of targets) {
    log.info?.(`\n[compare] === ${target.label} ===`);
    try {
      await down({ log });
      const state = await up({
        mode: target.mode ?? 'single',
        variant: target.variant,
        withWeb: false,
        log,
      });
      const { result } = await runCheck({ stack: state, persist: true, scenario });
      results.push({ ...target, result, scenario: scenario ?? null });
      log.info?.(`[compare] ${target.label} → ${result.summary.status}：${result.summary.headline}`);
    } catch (err) {
      results.push({ ...target, error: err.message });
      log.info?.(`[compare] ${target.label} → 失败：${err.message}`);
    }
  }
  await down({ log });

  mkdirSync(REPORT_DIR, { recursive: true });
  const base = `compare-${timestampForFile()}`;
  const jsonFile = resolve(REPORT_DIR, `${base}.json`);
  const mdFile = resolve(REPORT_DIR, `${base}.md`);
  const payload = {
    generatedAt: new Date().toISOString(),
    engine: 'mirror',
    scope: 'mirror 消息转发、房间隔离与文档共享实验；不代表官方 OT 行为或 SpreadJS 容量。',
    results: results.map((r) => ({
      label: r.label,
      mode: r.mode,
      variant: r.variant,
      error: r.error ?? null,
      result: r.result ?? null,
    })),
  };
  writeFileSync(jsonFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  writeFileSync(mdFile, renderComparison(results), 'utf8');

  return { results, files: { json: jsonFile, markdown: mdFile } };
}

export function renderCompareCli(results) {
  const width = Math.max(...results.map((r) => r.label.length), 8);
  const lines = [];
  for (const item of results) {
    if (item.error) {
      lines.push(`${item.label.padEnd(width)}  ERROR  ${item.error}`);
      continue;
    }
    const r = item.result;
    const ack = r.metrics?.ackMs;
    lines.push(
      `${item.label.padEnd(width)}  ${r.summary.status.padEnd(14)} 放置=${cell(r, 'room.placement').padEnd(13)} 跨节点=${degradeCell(
        r,
      ).padEnd(9)} 加入=${cell(r, 'join.consistency').padEnd(13)} ACK p50/p95=${ack ? `${ack.p50}/${ack.p95}ms` : '—'}`,
    );
  }
  return lines.join('\n');
}

export { CHECK_IDS };
