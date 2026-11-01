/*
 * tests/qa-ai-verify.js —— AI 独立验证脚本（QA 自建，不复用 tools/ai-benchmark.js 统计口径）
 *
 * 目的：独立验证 AI 三档强度门槛、确定性、性能与异常；支持「新 AI vs 指定基线文件」对打
 *      （v1.7：新 hard PIMC vs tools/baseline-ai-3.0.0.js 的 v3.0 启发式 hard；同时保留 v2.2 基线）。
 *  - 新 AI：默认 js/ai.js；可用 --new-file 指定候选文件
 *  - 基线：默认 tools/baseline-ai-2.2.0.js；可用 --p2-baseline（别名 --old-file）指定任意冻结基线
 *  - 每一 seed 双向对打：同一 seed、同一 firstPlayer（由 seed 派生）下，
 *    新 AI 先坐 p1，再坐 p2，牌堆/座位发牌完全一致 → 消除座位/发牌偏差。
 *  - 混合配置：默认 Lead 指定 canon 六配置（R3N1D1/R3N2D2/R3N4D3/R5N1D2/R5N2D1/R5N4D3，
 *    按 seed 轮转分配）；--configs=all9 为 3/5/7 区 × settle 1/2/4 混合（D1）；也可自定义 区域/结算/难度
 *  - 独立 holdout seed 集：由 --seed-base 指定（v3.0 用 100000+；v1.7 PIMC 用 200000+）
 *  - 指标：胜/负/平、去平胜率（主）、Wilson 95% CI、含平胜率（次）、方向拆分、
 *          新 AI 决策耗时 p50/p95/p99/max（含目标/底线门槛判定）、布局耗时、
 *          平均步数、stall/forfeit、非法动作/异常/牌张守恒、
 *          行为画像（每回合 AP/end_turn/move/结算时机，新旧对比）；
 *          可选：确定性复核、信息公平探针（隐藏牌扰动）、抽样复盘 trace
 *  - 退出码：底线门槛/性能底线/确定性/公平性失败 → 1（--no-fail 可关闭）
 *
 * 用法：
 *   node tests/qa-ai-verify.js --games-per-direction=500                       # canon 六配置全矩阵（默认）
 *   node tests/qa-ai-verify.js --pairs=new-hard_vs_new-medium --games-per-direction=1000
 *   node tests/qa-ai-verify.js --configs=all9 --pairs=new-hard_vs_old-hard22  # 9 配置混合（含 7 区分项）
 *   # v1.7 PIMC 硬档 vs v3.0 启发式（baseline 文件）：
 *   node tests/qa-ai-verify.js --p1=new:hard --p2=old:hard --p2-baseline=tools/baseline-ai-3.0.0.js \
 *        --pair-name=new-hard_vs_hard30 --threshold-target=0.65 --threshold-floor=0.60 \
 *        --games-per-direction=500 --seed-base=200000
 *   node tests/qa-ai-verify.js --p1=old:hard --p2=old:hard --games-per-direction=150   # 座位对称性自检（≈50%）
 *   node tests/qa-ai-verify.js --fairness-hidden=20 --determinism-check=20
 *   # v1.8 ML 策略（封装 API 自动创建，基线模块作为启发式基座）：
 *   node tests/qa-ai-verify.js --ml --p2-baseline=tools/baseline-ai-3.1.0.js \
 *        --p1=new:hard --p2=old:hard --pair-name=ml_vs_hard31 --games-per-direction=600 --seed-base=600000
 * 选项：
 *   --pairs=a,b | --p1=... --p2=...   对局矩阵（token: new:hard|new:medium|new:easy|old:hard|old:medium|old:easy）
 *   --new-file=path                   新 AI 模块文件（默认 js/ai.js；可为直接 API 或封装 API 如 js/ai-ml.js）
 *   --ml                              等价 --new-file=js/ai-ml.js（封装模块会用 --p2-baseline 指向的启发式模块创建策略）
 *   --ml-base=path                    ML 策略的启发式基座（如 tools/baseline-ai-3.1.0.js；对照 hard22/medium/easy 时必须显式指定）
 *   --new-label=name                  自定义新 AI 显示标签（如 ML）；--baseline-label=name 同 base 线
 *   --p2-baseline=path                基线 AI 模块文件（默认 tools/baseline-ai-2.2.0.js；别名 --old-file）
 *   --pair-name=name                  自定义 --p1/--p2 对局的显示名
 *   --threshold-target=X              自定义目标胜率（仅报告）；--threshold-floor=Y 底线（决定 pass/fail）
 *   --wilson-floor=Z                  Wilson 95% 下界门槛（决定 pass/fail；v1.8 用，如 0.505）
 *   --games-per-direction=N           每方向 seed 数（总对局 = 2N；默认 500）
 *   --seed-base=N                     起始 seed（默认 100000）
 *   --configs=canon|all9|3/1/1,...    配置集（默认 canon 六配置；也可自定义 区域/结算/难度）
 *   --difficulty=1                    两段式 --configs 的默认难度（默认 1）
 *   --no-fail                         门槛不满足也退出 0
 *   --json=path                       输出完整 JSON 报告
 *   --determinism-check=N             对每个 pair 做 N 个 seed 的重复对局一致性检查
 *   --fairness-scan                   对 ai.js 做静态信息公平性扫描（启发式）
 *   --fairness-hidden=N               信息公平探针：扰动隐藏牌身份/牌堆顺序后决策应不变（N seed/对）
 *   --sample-seeds=100000,100001      输出指定 seed 的逐步决策 trace（人工复盘长远规划）
 *   --max-steps=N                     单局上限（默认 5000）
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');

/* ------------------------------------------------------------------ *
 * 参数（先解析 AI 文件参数，再加载模块：支持新旧基线/候选文件对打）
 * ------------------------------------------------------------------ */
function argValue(name, fallback) {
  const hit = process.argv.slice(2).find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : fallback;
}
function hasFlag(name) {
  return process.argv.slice(2).includes('--' + name);
}
function loadRawModule(file, role) {
  try {
    return require(file);
  } catch (err) {
    throw new Error('[qa-ai-verify] 加载' + role + '失败：' + file + ' — ' + (err && err.message));
  }
}
/**
 * 模块适配：
 *  - 直接暴露 chooseAction/chooseLayout 的启发式模块（js/ai.js、tools/baseline-*.js）直接使用；
 *  - 封装 API（如 js/ai-ml.js 的 PokerAIML.createPolicy(heuristicAI)）→ 用「基线模块」作为启发式基座创建策略；
 *  - 兼容 defaultPolicy()。
 */
function adaptAIModule(mod, heur, role, file) {
  if (mod && typeof mod.chooseAction === 'function' && typeof mod.chooseLayout === 'function') return mod;
  if (mod && typeof mod.createPolicy === 'function') {
    let policy = null;
    try { policy = mod.createPolicy(heur); } catch (err) {
      throw new Error('[qa-ai-verify] ' + role + ' createPolicy 失败（需 --p2-baseline 指定带 _internals 的启发式模块）：' + (err && err.message));
    }
    if (policy && typeof policy.chooseAction === 'function' && typeof policy.chooseLayout === 'function') return policy;
    throw new Error('[qa-ai-verify] ' + role + ' createPolicy 未返回合法策略（缺 chooseAction/chooseLayout）：' + file);
  }
  if (mod && typeof mod.defaultPolicy === 'function') {
    const policy = mod.defaultPolicy();
    if (policy && typeof policy.chooseAction === 'function' && typeof policy.chooseLayout === 'function') return policy;
  }
  throw new Error('[qa-ai-verify] ' + role + ' 不是可用的 PokerAI 模块（缺 chooseAction/chooseLayout，也未提供 createPolicy/defaultPolicy）：' + file);
}
const NEW_AI_FILE = path.resolve(ROOT, argValue('new-file', hasFlag('ml') ? 'js/ai-ml.js' : 'js/ai.js'));
const BASELINE_FILE = path.resolve(ROOT, argValue('p2-baseline', argValue('old-file', 'tools/baseline-ai-2.2.0.js')));
const ML_BASE_FILE_ARG = argValue('ml-base', '');
const NEW_LABEL_ARG = argValue('new-label', '');
const BASELINE_LABEL_ARG = argValue('baseline-label', '');
const E = require(path.join(ROOT, 'js', 'engine.js'));
const NEW_RAW = loadRawModule(NEW_AI_FILE, '新 AI（--new-file）');
const OLD_RAW = loadRawModule(BASELINE_FILE, '基线（--p2-baseline）');
const OLD_AI = adaptAIModule(OLD_RAW, null, '基线（--p2-baseline）', BASELINE_FILE);
/* ML 策略的启发式基座（--ml-base；缺省用 --p2-baseline 模块）。对照 hard22/medium/easy 时应显式传 baseline31。 */
let ML_BASE_AI = OLD_AI;
if (ML_BASE_FILE_ARG) ML_BASE_AI = adaptAIModule(loadRawModule(path.resolve(ROOT, ML_BASE_FILE_ARG), 'ML 基座（--ml-base）'), null, 'ML 基座（--ml-base）', ML_BASE_FILE_ARG);
const NEW_AI = adaptAIModule(NEW_RAW, ML_BASE_AI, '新 AI（--new-file）', NEW_AI_FILE);
const NEW_VER = NEW_AI.VERSION || NEW_RAW.VERSION || '?';
const OLD_VER = OLD_AI.VERSION || OLD_RAW.VERSION || '?';
const NEW_KIND = String(NEW_AI.kind || NEW_RAW.kind || '');
const OLD_KIND = String(OLD_AI.kind || OLD_RAW.kind || '');

const GAMES_PER_DIR = Math.max(1, Number(argValue('games-per-direction', 500)) || 500);
const SEED_BASE = Number(argValue('seed-base', 100000)) || 100000;
const DIFFICULTY = Number(argValue('difficulty', 1)) || 1;
const MAX_STEPS = Number(argValue('max-steps', 5000)) || 5000;
const JSON_OUT = argValue('json', '');
const DUMP_GAMES = argValue('dump-games', '');
const NO_FAIL = hasFlag('no-fail');
const DET_CHECK = Number(argValue('determinism-check', 0)) || 0;
const FAIRNESS_SCAN = hasFlag('fairness-scan');
const FAIRNESS_HIDDEN = Math.max(0, Number(argValue('fairness-hidden', 0)) || 0);
const SAMPLE_SEEDS = (argValue('sample-seeds', '') || '').split(',').map((x) => Number(String(x).trim())).filter((x) => Number.isFinite(x) && x > 0);
const PAIRS_ARG = argValue('pairs', '');
const P1_ARG = argValue('p1', '');
const P2_ARG = argValue('p2', '');
const PAIR_NAME_ARG = argValue('pair-name', '');
const THRESH_TARGET = argValue('threshold-target', '') === '' ? null : Number(argValue('threshold-target', ''));
const THRESH_FLOOR = argValue('threshold-floor', '') === '' ? null : Number(argValue('threshold-floor', ''));
/* v1.8：CI 下界门槛（如要求 Wilson 95% 下界 > 50.5% → --wilson-floor=0.505） */
const THRESH_WILSON_LO = argValue('wilson-floor', '') === '' ? null : Number(argValue('wilson-floor', ''));

/* Lead 指定的 canon 六配置口径（区域/结算档/难度）：R3N1D1 / R3N2D2 / R3N4D3 / R5N1D2 / R5N2D1 / R5N4D3 */
const CANON_CONFIGS = [
  { regions: 3, settle: 1, difficulty: 1 },
  { regions: 3, settle: 2, difficulty: 2 },
  { regions: 3, settle: 4, difficulty: 3 },
  { regions: 5, settle: 1, difficulty: 2 },
  { regions: 5, settle: 2, difficulty: 1 },
  { regions: 5, settle: 4, difficulty: 3 }
];
/* 9 配置混合（3/5/7 × settle 1/2/4，难度默认 1）—— 用于报告分项/7 区分项 */
const ALL_CONFIGS = [];
for (const regions of [3, 5, 7]) {
  for (const settle of [1, 2, 4]) ALL_CONFIGS.push({ regions, settle, difficulty: 1 });
}
function cfgLabel(c) {
  return c.regions + 'R/' + c.settle + 'N/D' + c.difficulty;
}
function parseConfigs(spec) {
  if (!spec || spec === 'canon') return CANON_CONFIGS.slice();
  if (spec === 'all9' || spec === 'mixed9') return ALL_CONFIGS.slice();
  const out = [];
  for (const item of String(spec).split(',')) {
    const m = /^(\d+)\/(\d+)(?:\/(\d+))?$/.exec(item.trim());
    if (!m) throw new Error('非法 --configs 项：' + item + '（期望 区域数/结算档[/难度]，如 5/2/1；或 canon / all9）');
    out.push({ regions: Number(m[1]), settle: Number(m[2]), difficulty: m[3] ? Number(m[3]) : DIFFICULTY });
  }
  return out;
}

const IS_DEFAULT_NEW = NEW_VER === '3.0.0';
const IS_DEFAULT_OLD = OLD_VER === '2.2.0';
function aiSrcLabel(src) {
  const custom = src === 'new' ? NEW_LABEL_ARG : BASELINE_LABEL_ARG;
  if (custom) return custom;
  if (src === 'new') return IS_DEFAULT_NEW ? 'new' : 'new@' + NEW_VER + (NEW_KIND ? '[' + NEW_KIND + ']' : '');
  return IS_DEFAULT_OLD ? 'old' : 'old@' + OLD_VER + (OLD_KIND ? '[' + OLD_KIND + ']' : '');
}
/** token → {ai, strength, label}（label 自动带非默认版本号，如 old@3.0.0:hard） */
function resolveToken(token) {
  const m = /^(new|old):(easy|medium|hard|hard22|medium22|easy22)$/.exec(String(token || '').trim());
  if (!m) throw new Error('非法 AI token：' + token + '（期望 new:hard / old:hard 等）');
  const src = m[1];
  let strength = m[2];
  if (strength === 'hard22') strength = 'hard';
  if (strength === 'medium22') strength = 'medium';
  if (strength === 'easy22') strength = 'easy';
  return {
    ai: src === 'new' ? NEW_AI : OLD_AI, strength,
    label: aiSrcLabel(src) + ':' + m[2], src,
    version: src === 'new' ? NEW_VER : OLD_VER
  };
}
function makePair(p1Token, p2Token) {
  const p1 = resolveToken(p1Token);
  const p2 = resolveToken(p2Token);
  return { name: p1.label + '_vs_' + p2.label, p1, p2 };
}

const PRESET_PAIRS = [
  { name: 'new-hard_vs_old-hard22', p1: resolveToken('new:hard'), p2: resolveToken('old:hard22'),
    threshold: { rate: 0.65, wilsonLo: 0.60 }, note: 'Lead 门槛：新 hard vs 旧 hard22 ≥65%，Wilson 95% 下界 ≥60%' },
  { name: 'new-hard_vs_new-medium', p1: resolveToken('new:hard'), p2: resolveToken('new:medium'),
    threshold: { rate: 0.65 }, note: '三档差距：新 hard vs 新 medium ≥65%' },
  { name: 'new-medium_vs_new-easy', p1: resolveToken('new:medium'), p2: resolveToken('new:easy'),
    threshold: { rate: 0.70 }, note: '三档差距：新 medium vs 新 easy ≥70%' },
  { name: 'new-hard_vs_new-easy', p1: resolveToken('new:hard'), p2: resolveToken('new:easy'),
    threshold: { rate: 0.90 }, note: '三档差距：新 hard vs 新 easy ≥90%' },
  { name: 'new-medium_vs_old-medium22', p1: resolveToken('new:medium'), p2: resolveToken('old:medium22'),
    threshold: { rate: 0.60 }, note: 'Lead 门槛：新 medium vs 旧 medium22 ≥60%' },
  { name: 'new-easy_vs_old-easy22', p1: resolveToken('new:easy'), p2: resolveToken('old:easy22'),
    threshold: null, note: '分项报告：新 easy vs 旧 easy22（task-40 原要求 ≥60%，本轮 Lead 门槛列表未列，仅报告）' }
];

function selectPairs() {
  if (P1_ARG || P2_ARG) {
    if (!P1_ARG || !P2_ARG) throw new Error('必须同时提供 --p1 与 --p2');
    const pair = makePair(P1_ARG, P2_ARG);
    if (PAIR_NAME_ARG) pair.name = PAIR_NAME_ARG;
    if (THRESH_TARGET != null || THRESH_FLOOR != null || THRESH_WILSON_LO != null) {
      pair.threshold = { target: THRESH_TARGET, floor: THRESH_FLOOR, wilsonLo: THRESH_WILSON_LO };
      pair.note = '自定义门槛：目标 ' + (THRESH_TARGET == null ? '-' : (100 * THRESH_TARGET).toFixed(0) + '%') +
        ' / 底线 ' + (THRESH_FLOOR == null ? '-' : (100 * THRESH_FLOOR).toFixed(0) + '%') +
        (THRESH_WILSON_LO == null ? '' : ' / Wilson 下界 ' + (100 * THRESH_WILSON_LO).toFixed(1) + '%');
    } else {
      pair.threshold = null; pair.note = '自定义对局（无硬门槛）';
    }
    return [pair];
  }
  if (!PAIRS_ARG) return PRESET_PAIRS.slice();
  const byName = {};
  for (const p of PRESET_PAIRS) byName[p.name] = p;
  return PAIRS_ARG.split(',').map((n) => {
    const key = n.trim();
    const hit = byName[key] || byName[key.replace(/^new-/, 'new-')];
    if (!hit) throw new Error('未知 pair：' + key + '（可用：' + PRESET_PAIRS.map((p) => p.name).join(', ') + '）');
    return hit;
  });
}

/* ------------------------------------------------------------------ *
 * 统计工具
 * ------------------------------------------------------------------ */
function nowNs() { return process.hrtime.bigint(); }
function ms(ns) { return Number(ns) / 1e6; }
function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}
/** Wilson 95% CI（proportion, n） */
function wilson(wins, n, z) {
  if (!n) return { lo: null, hi: null, center: null };
  const zz = z || 1.959963984540054;
  const p = wins / n;
  const denom = 1 + zz * zz / n;
  const center = (p + zz * zz / (2 * n)) / denom;
  const margin = zz * Math.sqrt((p * (1 - p) + zz * zz / (4 * n)) / n) / denom;
  return { lo: Math.max(0, center - margin), hi: Math.min(1, center + margin), center };
}
function rate(n, d) { return d ? n / d : null; }
function fmtPct(x) { return x == null ? '-' : (100 * x).toFixed(2) + '%'; }
function fmtMs(x) { return x == null ? '-' : x.toFixed(2) + 'ms'; }
function sum(a) { return a.reduce((s, x) => s + x, 0); }

/* ------------------------------------------------------------------ *
 * 行为画像（长远规划反向检验：AP 使用/结束回合/弃区 move/结算时机）
 * ------------------------------------------------------------------ */
function emptyBehavior() {
  return {
    actions: 0, costSum: 0, turns: 0,
    settle: 0, flip: 0, place: 0, move: 0, draw: 0, end_turn: 0,
    settleTurnSum: 0, settleCount: 0
  };
}
function emptyBehaviorAgg() {
  return {
    actions: 0, costSum: 0, turns: 0,
    settle: 0, flip: 0, place: 0, move: 0, draw: 0, end_turn: 0,
    settleTurnSum: 0, settleCount: 0
  };
}
function mergeBehavior(agg, b) {
  agg.actions += b.actions; agg.costSum += b.costSum; agg.turns += b.turns;
  for (const k of ['settle', 'flip', 'place', 'move', 'draw', 'end_turn']) agg[k] += b[k];
  agg.settleTurnSum += b.settleTurnSum; agg.settleCount += b.settleCount;
  return agg;
}
function finalizeBehavior(agg) {
  const turns = Math.max(1, agg.turns);
  return {
    actions: agg.actions, turns: agg.turns,
    apPerTurn: agg.turns ? agg.costSum / agg.turns : null,
    costSum: agg.costSum,
    settle: agg.settle, flip: agg.flip, place: agg.place, move: agg.move, draw: agg.draw, end_turn: agg.end_turn,
    actionMix: {
      settle: agg.actions ? agg.settle / agg.actions : 0,
      flip: agg.actions ? agg.flip / agg.actions : 0,
      place: agg.actions ? agg.place / agg.actions : 0,
      move: agg.actions ? agg.move / agg.actions : 0,
      draw: agg.actions ? agg.draw / agg.actions : 0,
      end_turn: agg.actions ? agg.end_turn / agg.actions : 0
    },
    avgSettleTurn: agg.settleCount ? agg.settleTurnSum / agg.settleCount : null
  };
}

/* ------------------------------------------------------------------ *
 * 单局
 * ------------------------------------------------------------------ */
function cardsOfSide(side) { return side.faceUp.length + side.faceDown.length; }
function totalCards(state) {
  let n = state.deck.length + state.discard.length;
  n += state.players.p1.hand.length + state.players.p2.hand.length;
  for (const r of state.regions) n += cardsOfSide(r.sides.p1) + cardsOfSide(r.sides.p2);
  return n;
}
function actionKey(a) { return JSON.stringify(a); }
function chooseActionChecked(ai, state, pid, strength, timings, label) {
  const legal = E.getLegalActions(state);
  if (!legal.length) throw new Error('battle 阶段无合法行动（' + label + '）');
  const t0 = nowNs();
  let action;
  try {
    action = ai.chooseAction(state, pid, { strength });
  } catch (err) {
    throw new Error('AI 决策抛异常（' + label + '）：' + (err && err.message));
  }
  const dt = ms(nowNs() - t0);
  if (timings) timings.push(dt);
  if (!action || !action.type) throw new Error('AI 返回空行动（' + label + '）');
  if (!legal.some((x) => actionKey(x) === actionKey(action))) {
    throw new Error('AI 返回非法行动（' + label + '）：' + actionKey(action) +
      ' legal=' + JSON.stringify(legal.slice(0, 5)));
  }
  return action;
}

/**
 * @returns {{winner, result, steps, actionCounts, maxStall, firstPlayer, newWins:boolean|null, duration}}
 */
function playOne(pair, seed, config, opts) {
  const options = opts || {};
  const swapped = !!options.swapped; // true = 双方交换座位（pair.p2 坐 p1、pair.p1 坐 p2）
  const seat = { p1: swapped ? pair.p2 : pair.p1, p2: swapped ? pair.p1 : pair.p2 };
  const firstPlayer = (seed % 2 === 0) ? 'p1' : 'p2';
  const deckSpec = { jokers: true, ranks: E.RANKS.slice() };
  const state = E.createGame({
    regionCount: config.regions,
    difficulty: config.difficulty || DIFFICULTY,
    settleCards: config.settle,
    firstPlayer,
    deck: deckSpec,
    seed,
    aiStrength: 'medium'
  });
  const deckSize = state.deck.length + state.players.p1.hand.length + state.players.p2.hand.length;
  const R = config.regions;
  // 布局：各自的 AI（记录新 AI 布局耗时）
  const layout = {};
  for (const pid of ['p1', 'p2']) {
    const side = seat[pid];
    let ids;
    const t0 = nowNs();
    try {
      ids = side.ai.chooseLayout(state, pid, { strength: side.strength });
    } catch (err) {
      throw new Error('chooseLayout 抛异常（' + side.label + '）：' + (err && err.message));
    }
    const dt = ms(nowNs() - t0);
    layout[pid] = dt;
    if (opts.layoutTimings && side === opts.newSide) opts.layoutTimings.push(dt);
    const handIds = state.players[pid].hand.map((c) => c.id);
    if (!Array.isArray(ids) || ids.length !== R) throw new Error('chooseLayout 返回长度错误（' + side.label + '）：' + JSON.stringify(ids));
    const seen = {};
    for (const id of ids) {
      if (handIds.indexOf(id) < 0) throw new Error('chooseLayout 返回非手牌（' + side.label + '）：' + id);
      if (seen[id]) throw new Error('chooseLayout 返回重复牌（' + side.label + '）：' + id);
      seen[id] = true;
    }
    E.submitLayout(state, pid, ids);
  }
  E.finalizeLayout(state);

  const actionCounts = { settle: 0, flip: 0, place: 0, move: 0, draw: 0, end_turn: 0 };
  const newActionCounts = { settle: 0, flip: 0, place: 0, move: 0, draw: 0, end_turn: 0 };
  const behavior = { p1: emptyBehavior(), p2: emptyBehavior() };
  const trace = opts.trace || null;
  let steps = 0;
  const lastTurnCount = { p1: -1, p2: -1 };
  const started = nowNs();
  while (!E.isGameOver(state)) {
    if (steps >= MAX_STEPS) throw new Error('对局未终止（超过 ' + MAX_STEPS + ' 步）');
    if (state.phase !== 'battle') throw new Error('循环内意外的非 battle 阶段：' + state.phase);
    if (totalCards(state) !== deckSize) throw new Error('牌张不守恒：' + totalCards(state) + ' != ' + deckSize + ' @step ' + steps);
    const pid = state.turn;
    if (pid !== 'p1' && pid !== 'p2') throw new Error('battle 阶段无行动方');
    const side = seat[pid];
    const isNew = side === opts.newSide;
    const action = chooseActionChecked(side.ai, state, pid, side.strength, isNew ? opts.timings : opts.oldTimings, side.label + ':' + pid);
    if (trace) {
      trace.push({
        step: steps, turn: pid, turnCount: state.turnCount, ap: state.players[pid].ap,
        openRegions: E.getOpenRegionIds(state).length,
        action: JSON.parse(JSON.stringify(action))
      });
    }
    const turnCountBefore = state.turnCount;
    E.performAction(state, action);
    actionCounts[action.type] = (actionCounts[action.type] || 0) + 1;
    if (isNew) newActionCounts[action.type] = (newActionCounts[action.type] || 0) + 1;
    const behave = behavior[pid];
    behave.actions++;
    behave.costSum += (E.ACTION_COSTS && E.ACTION_COSTS[action.type]) || 0;
    if (lastTurnCount[pid] !== turnCountBefore) { behave.turns++; lastTurnCount[pid] = turnCountBefore; }
    behave[action.type] = (behave[action.type] || 0) + 1;
    if (action.type === 'settle') { behave.settleTurnSum += turnCountBefore; behave.settleCount++; }
    steps++;
    if (totalCards(state) !== deckSize) throw new Error('牌张不守恒（行动后）：' + totalCards(state) + ' != ' + deckSize);
  }
  const duration = ms(nowNs() - started);
  if (state.phase !== 'gameover') throw new Error('终局阶段错误：' + state.phase);
  const res = state.result;
  let winner = res ? res.winner : null;
  let newWins = null;
  if (winner === 'draw') newWins = null;
  else if (winner === 'p1') newWins = seat.p1 === opts.newSide;
  else if (winner === 'p2') newWins = seat.p2 === opts.newSide;
  const maxStall = Math.max(state.players.p1.stallCount || 0, state.players.p2.stallCount || 0);
  return {
    winner, result: res, steps, actionCounts, newActionCounts,
    maxStall, firstPlayer, newWins, duration,
    behavior,
    trace,
    layoutTimes: layout,
    forfeitedBy: res && res.forfeitedBy ? res.forfeitedBy : null
  };
}

/* ------------------------------------------------------------------ *
 * Pair 汇总
 * ------------------------------------------------------------------ */
function newEmptyStats(pair, configs) {
  return {
    pair: pair.name,
    p1: pair.p1.label, p2: pair.p2.label,
    note: pair.note || '', threshold: pair.threshold || null,
    seeds: 0, games: 0, wins: 0, losses: 0, draws: 0,
    asP1: { games: 0, wins: 0, losses: 0, draws: 0 },
    asP2: { games: 0, wins: 0, losses: 0, draws: 0 },
    steps: [], newTimings: [], oldTimings: [], layoutTimings: [],
    actionCounts: { settle: 0, flip: 0, place: 0, move: 0, draw: 0, end_turn: 0 },
    newActionCounts: { settle: 0, flip: 0, place: 0, move: 0, draw: 0, end_turn: 0 },
    reasons: {}, forfeits: { total: 0, byNew: 0, byOld: 0 },
    stalls: { gamesWithStall: 0, maxSeen: 0 },
    firstPlayerWins: 0, firstPlayerGames: 0,
    newBehavior: emptyBehaviorAgg(), oldBehavior: emptyBehaviorAgg(),
    gamesLog: [],
    anomalies: [],
    perConfig: configs.map((c) => ({
      config: cfgLabel(c),
      games: 0, wins: 0, losses: 0, draws: 0, stepsSum: 0
    }))
  };
}
function recordGame(stats, pair, seed, config, cfgIdx, game, newIsP1) {
  stats.seeds = Math.max(stats.seeds, 1);
  stats.games++;
  if (stats.gamesLog) {
    stats.gamesLog.push({
      seed, config: cfgLabel(config), newIsP1,
      winner: game.winner, newWins: game.newWins, steps: game.steps, firstPlayer: game.firstPlayer,
      reason: game.result && game.result.reason ? game.result.reason : null,
      forfeitedBy: game.forfeitedBy || null
    });
  }
  stats.wins += game.newWins === true ? 1 : 0;
  stats.losses += game.newWins === false ? 1 : 0;
  stats.draws += game.newWins === null ? 1 : 0;
  const dir = newIsP1 ? stats.asP1 : stats.asP2;
  dir.games++;
  if (game.newWins === true) dir.wins++;
  else if (game.newWins === false) dir.losses++;
  else dir.draws++;
  stats.steps.push(game.steps);
  stats.actionCounts = game.actionCounts;
  for (const k of Object.keys(game.newActionCounts)) stats.newActionCounts[k] = (stats.newActionCounts[k] || 0) + game.newActionCounts[k];
  if (game.behavior) {
    mergeBehavior(stats.newBehavior, newIsP1 ? game.behavior.p1 : game.behavior.p2);
    mergeBehavior(stats.oldBehavior, newIsP1 ? game.behavior.p2 : game.behavior.p1);
  }
  const reason = game.result && game.result.reason ? game.result.reason : String(game.winner);
  stats.reasons[reason] = (stats.reasons[reason] || 0) + 1;
  if (game.forfeitedBy) {
    stats.forfeits.total++;
    if ((game.forfeitedBy === 'p1') === newIsP1) stats.forfeits.byNew++;
    else stats.forfeits.byOld++;
  }
  if (game.maxStall > 0) stats.stalls.gamesWithStall++;
  stats.stalls.maxSeen = Math.max(stats.stalls.maxSeen, game.maxStall);
  if (game.winner !== 'draw') {
    stats.firstPlayerGames++;
    if (game.winner === game.firstPlayer) stats.firstPlayerWins++;
  }
  const cfg = stats.perConfig[cfgIdx];
  cfg.games++;
  if (game.newWins === true) cfg.wins++;
  else if (game.newWins === false) cfg.losses++;
  else cfg.draws++;
  cfg.stepsSum += game.steps;
}

function summarizePair(stats) {
  const decisive = stats.wins + stats.losses;
  const decisiveRate = rate(stats.wins, decisive);
  const overallRate = rate(stats.wins + 0.5 * stats.draws, stats.games);
  const ci = wilson(stats.wins, decisive);
  const sortedTimings = stats.newTimings.slice().sort((a, b) => a - b);
  const sortedOld = stats.oldTimings.slice().sort((a, b) => a - b);
  const sortedLayout = stats.layoutTimings.slice().sort((a, b) => a - b);
  const p = (arr, x) => percentile(arr, x);
  const stepsSorted = stats.steps.slice().sort((a, b) => a - b);
  const lat = (arr) => arr.length ? {
    count: arr.length,
    p50: p(arr, 50), p95: p(arr, 95), p99: p(arr, 99), max: arr[arr.length - 1],
    mean: sum(arr) / arr.length
  } : null;
  const latNew = lat(sortedTimings);
  const latOld = lat(sortedOld);
  const latLayout = lat(sortedLayout);
  const checks = [];
  if (stats.threshold) {
    if (stats.threshold.target != null) {
      checks.push({ kind: 'target', name: '去平胜率 ≥ 目标 ' + fmtPct(stats.threshold.target),
        pass: decisiveRate != null && decisiveRate >= stats.threshold.target, actual: fmtPct(decisiveRate) });
    }
    if (stats.threshold.floor != null) {
      checks.push({ kind: 'floor', name: '去平胜率 ≥ 底线 ' + fmtPct(stats.threshold.floor),
        pass: decisiveRate != null && decisiveRate >= stats.threshold.floor, actual: fmtPct(decisiveRate) });
    }
    if (stats.threshold.rate != null) {
      checks.push({ kind: 'required', name: '去平胜率 ≥ ' + fmtPct(stats.threshold.rate),
        pass: decisiveRate != null && decisiveRate >= stats.threshold.rate, actual: fmtPct(decisiveRate) });
    }
    if (stats.threshold.wilsonLo != null) {
      checks.push({ kind: 'required', name: 'Wilson 95% 下界 ≥ ' + fmtPct(stats.threshold.wilsonLo),
        pass: ci.lo != null && ci.lo >= stats.threshold.wilsonLo, actual: fmtPct(ci.lo) });
    }
  }
  const requiredChecks = checks.filter((c) => c.kind !== 'target');
  /* 性能门槛（task-48）：目标 p95≤25ms/max≤60ms；底线 p95≤35ms/max≤100ms（fallback 后） */
  const perfGate = latNew ? {
    target: { p95Ms: 25, maxMs: 60 },
    floor: { p95Ms: 35, maxMs: 100 },
    passTarget: latNew.p95 <= 25 && latNew.max <= 60,
    passFloor: latNew.p95 <= 35 && latNew.max <= 100,
    actual: { p50Ms: latNew.p50, p95Ms: latNew.p95, p99Ms: latNew.p99, maxMs: latNew.max }
  } : null;
  return {
    pair: stats.pair, p1: stats.p1, p2: stats.p2, note: stats.note, threshold: stats.threshold,
    games: stats.games, wins: stats.wins, losses: stats.losses, draws: stats.draws,
    decisiveWinRate: decisiveRate, overallWinRate: overallRate,
    wilson95: ci,
    asP1: stats.asP1, asP2: stats.asP2,
    thresholds: checks,
    allThresholdsPass: requiredChecks.every((c) => c.pass),
    avgSteps: stats.steps.length ? sum(stats.steps) / stats.steps.length : null,
    stepsP50: p(stepsSorted, 50), stepsP95: p(stepsSorted, 95), stepsMax: stepsSorted.length ? stepsSorted[stepsSorted.length - 1] : null,
    latencyNewMs: latNew, latencyOldMs: latOld, layoutLatencyNewMs: latLayout,
    perfGate,
    actionCounts: stats.actionCounts, newActionCounts: stats.newActionCounts,
    reasons: stats.reasons, forfeits: stats.forfeits, stalls: stats.stalls,
    behavior: {
      new: finalizeBehavior(stats.newBehavior),
      old: finalizeBehavior(stats.oldBehavior)
    },
    firstPlayerWinRate: rate(stats.firstPlayerWins, stats.firstPlayerGames),
    perConfig: stats.perConfig.map((c) => ({
      config: c.config, games: c.games, wins: c.wins, losses: c.losses, draws: c.draws,
      decisiveWinRate: rate(c.wins, c.wins + c.losses), avgSteps: c.games ? c.stepsSum / c.games : null
    })),
    anomalies: stats.anomalies
  };
}

function printPairReport(rep) {
  console.log('\n================ ' + rep.pair + ' ================');
  if (rep.note) console.log('说明: ' + rep.note);
  console.log('对局: ' + rep.games + ' 局（新AI坐 p1 ' + rep.asP1.games + ' 局 / 坐 p2 ' + rep.asP2.games + ' 局；配置混合 ' +
    rep.perConfig.map((c) => c.config).join(', ') + '）');
  console.log('结果: 胜 ' + rep.wins + ' / 负 ' + rep.losses + ' / 平 ' + rep.draws +
    ' | 去平胜率 ' + fmtPct(rep.decisiveWinRate) +
    ' | 含平胜率 ' + fmtPct(rep.overallWinRate) +
    ' | Wilson95 [' + fmtPct(rep.wilson95.lo) + ', ' + fmtPct(rep.wilson95.hi) + ']');
  console.log('方向: 坐p1 ' + rep.asP1.wins + '-' + rep.asP1.losses + '-' + rep.asP1.draws +
    ' | 坐p2 ' + rep.asP2.wins + '-' + rep.asP2.losses + '-' + rep.asP2.draws +
    ' | 先手胜率 ' + fmtPct(rep.firstPlayerWinRate));
  console.log('步数: 平均 ' + (rep.avgSteps == null ? '-' : rep.avgSteps.toFixed(1)) +
    ' / p50 ' + (rep.stepsP50 == null ? '-' : rep.stepsP50) + ' / p95 ' + (rep.stepsP95 == null ? '-' : rep.stepsP95) + ' / max ' + (rep.stepsMax == null ? '-' : rep.stepsMax));
  const ln = rep.latencyNewMs, lo = rep.latencyOldMs, ll = rep.layoutLatencyNewMs;
  console.log('新AI决策耗时: ' + (ln ? 'p50 ' + fmtMs(ln.p50) + ' / p95 ' + fmtMs(ln.p95) + ' / p99 ' + fmtMs(ln.p99) +
    ' / max ' + fmtMs(ln.max) + ' / mean ' + fmtMs(ln.mean) + ' / n=' + ln.count : '-'));
  console.log('旧AI决策耗时: ' + (lo ? 'p50 ' + fmtMs(lo.p50) + ' / p95 ' + fmtMs(lo.p95) + ' / max ' + fmtMs(lo.max) : '-'));
  console.log('新AI布局耗时: ' + (ll ? 'p50 ' + fmtMs(ll.p50) + ' / p95 ' + fmtMs(ll.p95) + ' / max ' + fmtMs(ll.max) : '-'));
  console.log('新AI行动分布: ' + JSON.stringify(rep.newActionCounts));
  if (rep.behavior && rep.behavior.new) {
    const nb = rep.behavior.new, ob = rep.behavior.old || {};
    const f1 = (x, d) => (x == null ? '-' : x.toFixed(d == null ? 2 : d));
    console.log('行为对比（新/旧）: 每回合AP ' + f1(nb.apPerTurn) + '/' + f1(ob.apPerTurn) +
      ' | end_turn 占比 ' + fmtPct(nb.actionMix && nb.actionMix.end_turn) + '/' + fmtPct(ob.actionMix && ob.actionMix.end_turn) +
      ' | move 占比 ' + fmtPct(nb.actionMix && nb.actionMix.move) + '/' + fmtPct(ob.actionMix && ob.actionMix.move) +
      ' | 结算占比 ' + fmtPct(nb.actionMix && nb.actionMix.settle) + '/' + fmtPct(ob.actionMix && ob.actionMix.settle) +
      ' | 平均结算回合 ' + f1(nb.avgSettleTurn, 1) + '/' + f1(ob.avgSettleTurn, 1) + '（turnCount，越小越早）');
  }
  console.log('胜因: ' + JSON.stringify(rep.reasons) + ' | forfeit: ' + JSON.stringify(rep.forfeits) +
    ' | stall: ' + JSON.stringify(rep.stalls));
  console.log('分配置: ' + rep.perConfig.map((c) => c.config + ' ' + c.games + '局 ' + fmtPct(c.decisiveWinRate)).join(' | '));
  if (rep.thresholds.length) {
    for (const c of rep.thresholds) {
      const tag = c.kind === 'target' ? '（目标，仅报告）' : c.kind === 'floor' ? '（底线，决定 pass/fail）' : '';
      console.log('  [' + (c.pass ? 'PASS' : 'FAIL') + '] 门槛 ' + c.name + tag + '（实际 ' + c.actual + '）');
    }
  }
  if (rep.perfGate) {
    console.log('  [' + (rep.perfGate.passTarget ? 'PASS' : (rep.perfGate.passFloor ? 'PASS(底线)' : 'FAIL')) + '] 性能门槛(新AI决策) 目标 p95≤25ms/max≤60ms，底线 p95≤35ms/max≤100ms — 实际 p95 ' +
      fmtMs(rep.perfGate.actual.p95Ms) + ' / max ' + fmtMs(rep.perfGate.actual.maxMs) + ' / p99 ' + fmtMs(rep.perfGate.actual.p99Ms));
  }
  if (rep.anomalies.length) console.log('异常: ' + rep.anomalies.length + ' — ' + JSON.stringify(rep.anomalies.slice(0, 5)));
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */
function runBenchmark(pairs, configs) {
  const reports = [];
  const allGames = {};
  const tStart = Date.now();
  for (const pair of pairs) {
    const stats = newEmptyStats(pair, configs);
    const newSide = pair.p1.src === 'new' ? pair.p1 : pair.p2;
    const opts = { newSide, timings: stats.newTimings, oldTimings: stats.oldTimings, layoutTimings: stats.layoutTimings };
    const t0 = Date.now();
    console.log('\n>>> 开始 ' + pair.name + '：每方向 ' + GAMES_PER_DIR + ' seed（总 ' + (GAMES_PER_DIR * 2) + ' 局）...');
    let done = 0;
    for (let i = 0; i < GAMES_PER_DIR; i++) {
      const seed = SEED_BASE + i;
      const cfgIdx = i % configs.length;
      const config = configs[cfgIdx];
      // 同一 seed 双向座位：A=new 坐 p1；B=双方交换座位（new 坐 p2）；firstPlayer/牌堆一致
      for (const swapped of [false, true]) {
        const newIsP1 = (swapped ? pair.p2 : pair.p1) === newSide;
        try {
          const game = playOne(pair, seed, config, Object.assign({}, opts, { swapped }));
          recordGame(stats, pair, seed, config, cfgIdx, game, newIsP1);
        } catch (err) {
          stats.anomalies.push({ seed, config: cfgLabel(config), direction: newIsP1 ? 'new@p1' : 'new@p2', error: String(err && err.message || err) });
          if (stats.anomalies.length <= 5) console.error('  [异常] seed=' + seed + ' config=' + cfgLabel(config) + ' ' + (newIsP1 ? 'new@p1' : 'new@p2') + '：' + (err && err.message));
        }
        done++;
      }
      stats.seeds = i + 1;
      if ((i + 1) % 50 === 0 || i + 1 === GAMES_PER_DIR) {
        const elapsed = (Date.now() - t0) / 1000;
        const eta = elapsed / (i + 1) * (GAMES_PER_DIR - i - 1);
        console.log('  [' + pair.name + '] ' + (i + 1) + '/' + GAMES_PER_DIR + ' seed（' + done + ' 局）已用 ' + elapsed.toFixed(1) +
          's，ETA ' + eta.toFixed(1) + 's，当前胜率 ' + fmtPct(rate(stats.wins, stats.wins + stats.losses)));
      }
    }
    stats.seeds = GAMES_PER_DIR;
    if (stats.gamesLog) allGames[pair.name] = stats.gamesLog;
    const rep = summarizePair(stats);
    reports.push(rep);
    printPairReport(rep);
  }
  const totalSec = (Date.now() - tStart) / 1000;
  console.log('\n================ 汇总（' + (reports.length) + ' 组 / ' + reports.reduce((s, r) => s + r.games, 0) + ' 局 / ' + totalSec.toFixed(1) + 's） ================');
  let allPass = true;
  for (const r of reports) {
    const ok = r.thresholds.length ? r.allThresholdsPass : true;
    if (!ok) allPass = false;
    console.log('  ' + (r.thresholds.length ? (ok ? '[PASS] ' : '[FAIL] ') : '[INFO] ') + r.pair +
      ' 去平胜率 ' + fmtPct(r.decisiveWinRate) + ' Wilson95[' + fmtPct(r.wilson95.lo) + ',' + fmtPct(r.wilson95.hi) + ']' +
      ' 局数 ' + r.games + (r.thresholds.length ? ' 门槛 ' + r.thresholds.map((t) => (t.pass ? 'PASS' : 'FAIL')).join('/') : '') +
      (r.perfGate ? ' | 性能 p95 ' + fmtMs(r.perfGate.actual.p95Ms) + '/max ' + fmtMs(r.perfGate.actual.maxMs) +
        (r.perfGate.passTarget ? ' [目标PASS]' : (r.perfGate.passFloor ? ' [底线PASS]' : ' [底线FAIL]')) : ''));
  }
  return { reports, allPass, runtimeSec: totalSec, allGames };
}

/* ---------------- 确定性复核 ---------------- */
function signatureOf(pair, seed, config, opts) {
  const game = playOne(pair, seed, config, opts || {});
  return JSON.stringify({
    winner: game.winner, reason: game.result && game.result.reason, steps: game.steps,
    p1Cards: game.result && game.result.regionWins, firstPlayer: game.firstPlayer
  });
}
function runDeterminism(pairs, configs) {
  console.log('\n================ 确定性复核（同 seed 重复对局一致） ================');
  let mismatches = 0;
  let checked = 0;
  for (const pair of pairs) {
    const newSide = pair.p1.src === 'new' ? pair.p1 : pair.p2;
    const opts = { newSide };
    for (let i = 0; i < DET_CHECK; i++) {
      const seed = SEED_BASE + i;
      const config = configs[i % configs.length];
      let a, b;
      try {
        a = signatureOf(pair, seed, config, opts);
        b = signatureOf(pair, seed, config, opts);
      } catch (err) {
        mismatches++;
        console.log('  [FAIL] ' + pair.name + ' seed=' + seed + ' 异常：' + (err && err.message));
        continue;
      }
      checked++;
      if (a !== b) {
        mismatches++;
        console.log('  [FAIL] ' + pair.name + ' seed=' + seed + ' 两次跑结果不一致');
      }
    }
    console.log('  ' + pair.name + '：检查 ' + DET_CHECK + ' seed ×2，不一致 ' + mismatches);
  }
  return { checked, mismatches };
}

/* ---------------- 信息公平静态扫描（启发式，仅提示） ---------------- */
function runFairnessScan() {
  console.log('\n================ 信息公平静态扫描（启发式，仅供参考） ================');
  const file = path.join(ROOT, 'js', 'ai.js');
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split(/\r?\n/);
  const suspicious = [];
  const patterns = [
    { re: /\.deck\s*\[/, why: '直接索引牌堆顺序' },
    { re: /state\.players\s*\[\s*(otherId\(|other\(|opp|1\s*-|p2)/, why: '可能访问对手手牌' },
    { re: /opponent.*\.hand\s*\[/, why: '可能访问对手手牌索引' },
    { re: /faceDown.*(opp|p2)/, why: '可能读取对手背面牌' },
    { re: /Math\.random/, why: '使用非 seed 随机源' }
  ];
  for (let i = 0; i < lines.length; i++) {
    for (const p of patterns) {
      if (p.re.test(lines[i]) && !/getUnseenCards|unseen|未知牌/.test(lines[i])) {
        suspicious.push({ line: i + 1, why: p.why, text: lines[i].trim().slice(0, 140) });
      }
    }
  }
  console.log('js/ai.js 版本 ' + NEW_AI.VERSION + '；可疑模式命中 ' + suspicious.length + ' 条（需人工复核）：');
  for (const s of suspicious.slice(0, 20)) console.log('  L' + s.line + ' [' + s.why + '] ' + s.text);
  return { version: NEW_AI.VERSION, suspicious };
}

/* ---------------- 信息公平：隐藏牌身份/顺序扰动后决策不变（独立探针） ---------------- */
function runHiddenInfoFairness(pairs, configs, n) {
  console.log('\n================ 信息公平探针（隐藏牌身份/牌堆顺序扰动后决策应不变，共 ' + n + ' seed/对） ================');
  const out = [];
  for (const pair of pairs) {
    const testedIsP1 = pair.p1.src === 'new' ? true : (pair.p2.src === 'new' ? false : true);
    const tested = testedIsP1 ? pair.p1 : pair.p2;
    const testedPid = testedIsP1 ? 'p1' : 'p2';
    const oppPid = testedIsP1 ? 'p2' : 'p1';
    let checked = 0, mismatch = 0;
    const samples = [];
    for (let i = 0; i < n; i++) {
      const seed = SEED_BASE + i;
      const config = configs[i % configs.length];
      try {
        const state = E.createGame({
          regionCount: config.regions, difficulty: config.difficulty || DIFFICULTY,
          settleCards: config.settle, firstPlayer: 'p1',
          deck: { jokers: true, ranks: E.RANKS.slice() }, seed, aiStrength: 'medium'
        });
        for (const pid of ['p1', 'p2']) {
          const side = pid === 'p1' ? pair.p1 : pair.p2;
          E.submitLayout(state, pid, side.ai.chooseLayout(state, pid, { strength: side.strength }));
        }
        E.finalizeLayout(state);
        let guard = 0;
        while (state.phase === 'battle' && state.turn !== testedPid && guard++ < 300) {
          const side = state.turn === 'p1' ? pair.p1 : pair.p2;
          E.performAction(state, chooseActionChecked(side.ai, state, state.turn, side.strength, null, 'hidden-info:' + side.label));
        }
        if (state.phase !== 'battle' || state.turn !== testedPid) continue;
        const actionA = canonicalActionForFairness(tested.ai.chooseAction(state, testedPid, { strength: tested.strength }));
        // 扰动（不改变被测 AI 的合法可见信息多重集）：反转牌堆顺序 + 对手手牌/背面牌身份池内轮换
        const clone = JSON.parse(JSON.stringify(state));
        clone.deck.reverse();
        const positions = [];
        const cards = [];
        for (const r of clone.regions) {
          const arr = r.sides[oppPid].faceDown;
          for (let idx = 0; idx < arr.length; idx++) { positions.push({ arr, idx }); cards.push(arr[idx]); }
        }
        const oppHand = clone.players[oppPid].hand;
        for (let idx = 0; idx < oppHand.length; idx++) { positions.push({ arr: oppHand, idx }); cards.push(oppHand[idx]); }
        if (cards.length > 1) {
          for (let k = 0; k < positions.length; k++) positions[k].arr[positions[k].idx] = cards[(k + 1) % cards.length];
        }
        const actionB = canonicalActionForFairness(tested.ai.chooseAction(clone, testedPid, { strength: tested.strength }));
        checked++;
        if (actionA !== actionB) {
          mismatch++;
          if (samples.length < 3) samples.push({ seed, config: cfgLabel(config), before: actionA, after: actionB });
        }
      } catch (err) {
        samples.push({ seed, config: cfgLabel(config), error: String(err && err.message || err) });
      }
    }
    const rec = { pair: pair.name, tested: tested.label, checked, mismatch, samples };
    out.push(rec);
    console.log('  ' + (mismatch === 0 ? '[PASS] ' : '[FAIL] ') + pair.name + '（被测 ' + tested.label + '）：检查 ' + checked + ' seed，决策不一致 ' + mismatch);
    for (const s of samples.slice(0, 2)) console.log('    ' + JSON.stringify(s));
  }
  return out;
}
function canonicalActionForFairness(action) {
  if (!action || typeof action !== 'object') return String(action);
  const keys = Object.keys(action).sort();
  const out = {};
  for (const k of keys) out[k] = action[k];
  return JSON.stringify(out);
}

/* ---------------- 抽样复盘：输出指定 seed 的逐步决策序列（供人工复盘长远规划） ---------------- */
function runSamples(pairs, configs, seeds) {
  console.log('\n================ 抽样复盘（seed → 逐步决策，供人工检查长远规划） ================');
  const out = [];
  for (const pair of pairs) {
    const newSide = pair.p1.src === 'new' ? pair.p1 : pair.p2;
    for (let i = 0; i < seeds.length; i++) {
      const seed = seeds[i];
      const config = configs[i % configs.length];
      const trace = [];
      try {
        const game = playOne(pair, seed, config, { newSide, trace });
        const rec = {
          pair: pair.name, seed, config: cfgLabel(config), winner: game.winner,
          reason: game.result && game.result.reason, steps: game.steps, firstPlayer: game.firstPlayer,
          actionCounts: game.actionCounts, trace
        };
        out.push(rec);
        console.log('  ' + pair.name + ' seed=' + seed + ' ' + cfgLabel(config) + ' → winner=' + game.winner +
          ' steps=' + game.steps + ' actions=' + JSON.stringify(game.actionCounts));
      } catch (err) {
        console.log('  ' + pair.name + ' seed=' + seed + ' 异常：' + (err && err.message));
        out.push({ pair: pair.name, seed, config: cfgLabel(config), error: String(err && err.message || err) });
      }
    }
  }
  return out;
}

/* ---------------- main ---------------- */
function main() {
  const configs = parseConfigs(argValue('configs', ''));
  const pairs = selectPairs();
  console.log('QA AI 独立验证 — 新 AI ' + NEW_VER + '（' + path.relative(ROOT, NEW_AI_FILE) + '） / 基线 ' + OLD_VER + '（' + path.relative(ROOT, BASELINE_FILE) + '）');
  console.log('seed 集：' + SEED_BASE + ' .. ' + (SEED_BASE + GAMES_PER_DIR - 1) + '（每 seed 双向各 1 局）');
  console.log('配置（' + configs.length + ' 组）：' + configs.map(cfgLabel).join(', '));
  // 配置预检
  for (const c of configs) {
    const v = E.validateConfig({ regionCount: c.regions, settleCards: c.settle, difficulty: c.difficulty, deck: { jokers: true, ranks: E.RANKS.slice() } });
    if (!v.ok) {
      console.error('配置不可用 ' + cfgLabel(c) + '：' + v.errors.join('；'));
      process.exit(2);
    }
  }
  let out = {
    newAiVersion: NEW_VER, oldAiVersion: OLD_VER,
    newAiKind: NEW_KIND, oldAiKind: OLD_KIND,
    newAiFile: path.relative(ROOT, NEW_AI_FILE), baselineFile: path.relative(ROOT, BASELINE_FILE),
    seedBase: SEED_BASE, gamesPerDirection: GAMES_PER_DIR, configs
  };
  if (FAIRNESS_SCAN) out.fairnessScan = runFairnessScan();
  const bench = runBenchmark(pairs, configs);
  out.benchmark = bench.reports;
  const perfFail = bench.reports.some((r) => r.perfGate && !r.perfGate.passFloor);
  out.summary = { allPass: bench.allPass, perfFloorFail: perfFail, runtimeSec: bench.runtimeSec };
  if (DET_CHECK > 0) out.determinism = runDeterminism(pairs, configs);
  if (FAIRNESS_HIDDEN > 0) out.hiddenInfoFairness = runHiddenInfoFairness(pairs, configs, FAIRNESS_HIDDEN);
  if (SAMPLE_SEEDS.length) out.samples = runSamples(pairs, configs, SAMPLE_SEEDS);
  if (JSON_OUT) {
    fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
    fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 2));
    console.log('JSON → ' + JSON_OUT);
  }
  if (DUMP_GAMES) {
    fs.mkdirSync(path.dirname(DUMP_GAMES), { recursive: true });
    fs.writeFileSync(DUMP_GAMES, JSON.stringify({ seedBase: SEED_BASE, gamesPerDirection: GAMES_PER_DIR, games: bench.allGames }, null, 2));
    console.log('games dump → ' + DUMP_GAMES);
  }
  const detFail = out.determinism && out.determinism.mismatches > 0;
  const fairFail = out.hiddenInfoFairness && out.hiddenInfoFairness.some((r) => r.mismatch > 0);
  if ((!bench.allPass || detFail || fairFail || perfFail) && !NO_FAIL) process.exit(1);
}

main();
