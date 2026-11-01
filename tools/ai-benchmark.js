#!/usr/bin/env node
/* =========================================================================
 * AI 对弈基准 / 新旧强度对照（零依赖）
 *
 * 用途：
 *  1) AI 3.0 训练与验收的统一口径：固定种子集、双向座位、多配置混合、
 *     Wilson 95% 置信区间、行动分布、决策耗时、stall/forfeit 计数；
 *  2) 新旧 AI 对照：支持把冻结基线 tools/baseline-ai-2.2.0.js 作为 *22 选手；
 *  3) 行为对比：输出每个 AI 标签的战役期行为统计（AP 使用率、settle 时机、
 *     行动占比、提前锁定/决战触发、平均步数），供「长远规划」取证。
 *
 * 用法：
 *   node tools/ai-benchmark.js --p1=hard --p2=medium22 --games=1000
 *   node tools/ai-benchmark.js --p1=hard22 --p2=medium22 --games=600
 *   node tools/ai-benchmark.js --p1=hard --p2=hard22 --games=500 --json=tools/bench-h22.json
 *   node tools/ai-benchmark.js --p1=hard --p2=medium --regions=5 --settle=2 --difficulty=1
 *
 * 选项：
 *   --p1=NAME --p2=NAME   NAME ∈ hard|medium|easy（当前 js/ai.js）
 *                              hard22|medium22|easy22（冻结基线 2.2.0）
 *   --games=N             对局总数（默认 400；双向座位时同一副牌打两局，A 换座位）
 *   --seed=N              起始种子（默认 20260000）
 *   --bidir=0|1           双向座位（默认 1）
 *   --configs=mixed       9 种固定配置混合（默认）
 *           =R5N2D1,R3N1D2,...  自定义；R=区域数 N=结算补牌数 D=难度规则
 *   --regions= --settle= --difficulty=   在 3/5/7 × 1/2/4 × 1/2/3 全矩阵上过滤
 *   --json=PATH           输出机器可读报告 JSON
 *   --quiet               只输出 JSON 摘要行
 *
 * 口径约定（写入 docs/AI-OPTIMIZATION.md）：
 *  - 「胜率(去平)」= A 胜 / (A 胜 + B 胜)，用于强度门槛；「胜率(含平)」另列；
 *  - 同一 seed 打两局：A 先坐 p1 一局、再坐 p2 一局（消除先后手/座位偏差）；
 *  - 胜负按 A 视角统计；A=--p1 名称，B=--p2 名称；
 *  - 决策耗时只统计 AI.chooseAction（不含引擎 performAction）；
 *  - 冻结基线校验：tools/baseline-ai-2.2.0.js 归一化 require 后 sha256 必须等于
 *    冻结时的 js/ai.js 2.2.0 哈希，否则直接报错（防止基线被悄悄改动）。
 * ========================================================================= */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const E = require(path.join(ROOT, 'js', 'engine.js'));

/* 冻结基线：js/ai.js v2.2.0 的源文件 sha256（2026-10-25 由 ai-dev 冻结） */
const BASELINE_FROZEN_SOURCE_SHA256 = '1f81fb81ec9a9a4d982ffc7c62a9bfee448de8349c0af934dc26eae9b5eaeb83';
const BASELINE_PATH = path.join(__dirname, 'baseline-ai-2.2.0.js');
/* v2.4：新增冻结基线 3.2.0（medium32/hard32/easy32；2026-10-25 由 ai-dev 冻结，sha256 为文件本体） */
const BASELINE32_PATH = path.join(__dirname, 'baseline-ai-3.2.0.js');
const BASELINE32_SHA256 = '73989ad745f8b2b0b0fc8bad3c04072d0389f23760b63ed2abfe80ca7596373b';
const CURRENT_AI_PATH = path.join(ROOT, 'js', 'ai.js');

const Z95 = 1.959963984540054;
const MAX_STEPS = 6000;

/* 默认混合配置：3/5/7 区 × settle 1/2/4 × 难度 1/2/3 交叉覆盖（9 种） */
const MIXED_CONFIGS = [
  { key: 'R3-N1-D1', regionCount: 3, settleCards: 1, difficulty: 1 },
  { key: 'R3-N2-D2', regionCount: 3, settleCards: 2, difficulty: 2 },
  { key: 'R3-N4-D3', regionCount: 3, settleCards: 4, difficulty: 3 },
  { key: 'R5-N1-D2', regionCount: 5, settleCards: 1, difficulty: 2 },
  { key: 'R5-N2-D1', regionCount: 5, settleCards: 2, difficulty: 1 },
  { key: 'R5-N4-D3', regionCount: 5, settleCards: 4, difficulty: 3 },
  { key: 'R7-N1-D3', regionCount: 7, settleCards: 1, difficulty: 3 },
  { key: 'R7-N2-D2', regionCount: 7, settleCards: 2, difficulty: 2 },
  { key: 'R7-N4-D1', regionCount: 7, settleCards: 4, difficulty: 1 },
];

/* canon 六配置（AI 3.0 验收口径，2026-10-25 与 Lead 确认）：
 * R3/R5 × N1/N2/N4 交叉；不含 7 区（7 区对局几乎全程决战、先后手影响大于 AI 差异，
 * README 已注明不宜用于衡量 AI 强度）。旧 hard22 vs 旧 medium22 在此口径约 60%。 */
const CANON6_CONFIGS = [
  { key: 'R3-N1-D1', regionCount: 3, settleCards: 1, difficulty: 1 },
  { key: 'R3-N2-D2', regionCount: 3, settleCards: 2, difficulty: 2 },
  { key: 'R3-N4-D3', regionCount: 3, settleCards: 4, difficulty: 3 },
  { key: 'R5-N1-D2', regionCount: 5, settleCards: 1, difficulty: 2 },
  { key: 'R5-N2-D1', regionCount: 5, settleCards: 2, difficulty: 1 },
  { key: 'R5-N4-D3', regionCount: 5, settleCards: 4, difficulty: 3 },
];

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */
function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

function loadBaseline() {
  if (!fs.existsSync(BASELINE_PATH)) throw new Error('缺少冻结基线：' + BASELINE_PATH);
  const raw = fs.readFileSync(BASELINE_PATH, 'utf8');
  const normalized = raw.replace("require('../js/engine.js')", "require('./engine.js')");
  const h = sha256(normalized);
  if (h !== BASELINE_FROZEN_SOURCE_SHA256) {
    throw new Error('冻结基线完整性校验失败：归一化 sha256=' + h +
      '，期望 ' + BASELINE_FROZEN_SOURCE_SHA256 + '（基线文件被改动过？）');
  }
  const ai = require(BASELINE_PATH);
  if (ai.VERSION !== '2.2.0') throw new Error('冻结基线 VERSION 应为 2.2.0，实际 ' + ai.VERSION);
  return ai;
}

function loadCurrent() {
  const ai = require(CURRENT_AI_PATH);
  return ai;
}

/* v2.4：冻结 3.2.0 基线（hard32/medium32/easy32）。文件本体 sha256 必须等于冻结值。 */
let _baseline32 = null;
function loadBaseline32() {
  if (_baseline32) return _baseline32;
  if (!fs.existsSync(BASELINE32_PATH)) throw new Error('缺少冻结基线 3.2.0：' + BASELINE32_PATH);
  const raw = fs.readFileSync(BASELINE32_PATH);
  const h = sha256(raw);
  if (h !== BASELINE32_SHA256) {
    throw new Error('冻结基线 3.2.0 完整性校验失败：sha256=' + h + '，期望 ' + BASELINE32_SHA256 + '（基线文件被改动过？）');
  }
  const ai = require(BASELINE32_PATH);
  if (ai.VERSION !== '3.2.0') throw new Error('冻结基线 3.2.0 VERSION 应为 3.2.0，实际 ' + ai.VERSION);
  _baseline32 = ai;
  return ai;
}

function parseArgs(argv) {
  const out = {};
  argv.slice(2).forEach((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (!m) return;
    out[m[1]] = m[2] === undefined ? '1' : m[2];
  });
  return out;
}

function wilson(wins, n, z) {
  z = z || Z95;
  if (!n) return { p: 0, lo: 0, hi: 0 };
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { p, lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

function pct(x, digits) { return (100 * x).toFixed(digits == null ? 1 : digits) + '%'; }

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
  return sorted[i];
}

function canonical(action) {
  const t = action && action.type;
  if (t === 'settle') return 'settle|' + action.regionId;
  if (t === 'flip') return 'flip|' + action.regionId + '|' + action.cardId;
  if (t === 'place') return 'place|' + action.regionId + '|' + action.cardId;
  if (t === 'move') return 'move|' + action.fromRegionId + '|' + action.cardId + '|' + action.toRegionId;
  if (t === 'draw') return 'draw';
  if (t === 'end_turn') return 'end_turn';
  return 'unknown|' + JSON.stringify(action);
}

function findLegal(action, legal) {
  const key = canonical(action);
  for (let i = 0; i < legal.length; i++) if (canonical(legal[i]) === key) return legal[i];
  return null;
}

const LABEL_DEFS = {
  hard: { label: 'hard', source: 'current', strength: 'hard' },
  medium: { label: 'medium', source: 'current', strength: 'medium' },
  easy: { label: 'easy', source: 'current', strength: 'easy' },
  hard22: { label: 'hard22', source: 'baseline', strength: 'hard' },
  medium22: { label: 'medium22', source: 'baseline', strength: 'medium' },
  easy22: { label: 'easy22', source: 'baseline', strength: 'easy' },
  /* v2.4：冻结 3.2.0 基线 */
  hard32: { label: 'hard32', source: 'baseline32', strength: 'hard' },
  medium32: { label: 'medium32', source: 'baseline32', strength: 'medium' },
  easy32: { label: 'easy32', source: 'baseline32', strength: 'easy' },
};

function resolveSpec(name, loaded) {
  name = String(name);
  /* v2.4：特化 AI：spec:<name>（tools/ai-spec/index.js；也兼容 get 返回 {ai|module,label,strength} 包装） */
  if (name.indexOf('spec:') === 0) {
    const shortName = name.slice(5);
    const idx = require(path.join(ROOT, 'tools', 'ai-spec', 'index.js'));
    const spec = idx.get(shortName);
    if (!spec) throw new Error('未知特化 AI：' + name);
    const ai = spec.ai || spec.module || spec;
    const label = spec.label || ('spec:' + shortName);
    const strength = spec.strength || 'medium';
    if (!ai || typeof ai.chooseAction !== 'function' || typeof ai.chooseLayout !== 'function') {
      throw new Error('特化 AI 模块接口不完整（需要 chooseLayout/chooseAction）：' + name);
    }
    return { label: label, strength: strength, ai: ai, source: 'spec', spec: spec };
  }
  const def = LABEL_DEFS[name];
  if (!def) throw new Error('未知选手：' + name + '（可选：' + Object.keys(LABEL_DEFS).join('|') + ' 或 spec:<name>）');
  const ai = def.source === 'current' ? loaded.current : (def.source === 'baseline32' ? loaded.baseline32 : loaded.baseline);
  if (!ai) throw new Error('选手 ' + name + ' 所需 AI 模块未加载');
  return { label: def.label, strength: def.strength, ai, source: def.source };
}

function buildConfigs(args) {
  const want = args.configs || 'canon6';
  if (want === 'canon6' || want === 'canon') return CANON6_CONFIGS.slice();
  if (want !== 'mixed') {
    const parsed = String(want).split(',').map((raw) => {
      const m = /^R(\d+)N(\d+)D(\d+)$/.exec(raw.trim());
      if (!m) throw new Error('无法解析配置：' + raw + '（形如 R5N2D1）');
      return {
        key: raw.trim(),
        regionCount: Number(m[1]), settleCards: Number(m[2]), difficulty: Number(m[3]),
      };
    }).map((c) => {
      const v = E.validateConfig(E.defaultConfig({ regionCount: c.regionCount, settleCards: c.settleCards, difficulty: c.difficulty }));
      if (!v.ok) throw new Error('配置不合法 ' + c.key + '：' + v.errors.join('；'));
      return c;
    });
    return parsed;
  }
  let configs = MIXED_CONFIGS.slice();
  if (args.regions) {
    const rs = String(args.regions).split(',').map(Number);
    configs = configs.filter((c) => rs.indexOf(c.regionCount) >= 0);
  }
  if (args.settle) {
    const ns = String(args.settle).split(',').map(Number);
    configs = configs.filter((c) => ns.indexOf(c.settleCards) >= 0);
  }
  if (args.difficulty) {
    const ds = String(args.difficulty).split(',').map(Number);
    configs = configs.filter((c) => ds.indexOf(c.difficulty) >= 0);
  }
  if (!configs.length) throw new Error('过滤后没有可用配置');
  return configs;
}

/* ------------------------------------------------------------------ */
/* 单局对弈 + 行为采集                                                 */
/* ------------------------------------------------------------------ */
function newPlayerStats() {
  return {
    turns: 0, apSpent: 0, apLeftTotal: 0, decisions: 0,
    actions: { settle: 0, flip: 0, place: 0, move: 0, draw: 0, end_turn: 0 },
    settles: [], earlyLockWins: 0, forfeits: 0, stalls: 0,
    decisionMs: [],
  };
}

function sumFaceUp(cards) {
  let s = 0;
  for (let i = 0; i < cards.length; i++) s += cards[i].value;
  return s;
}

/* 选手调用参数（params 为训练/测试钩子：{ tier: 参数对象 }） */
function specOpts(spec, extra) {
  const o = Object.assign({ strength: spec.strength }, extra || {});
  if (spec.params) o.params = spec.params;
  return o;
}

/**
 * 打一局。seatAssignment: {p1: specA, p2: specB}。
 * 返回 { winner, reason, early, endgameTriggered, steps, forfeitedBy, firstPlayer, players: {p1: stats, p2: stats} }
 */
function playOne(seed, cfg, seats) {
  const config = E.defaultConfig({
    regionCount: cfg.regionCount,
    settleCards: cfg.settleCards,
    difficulty: cfg.difficulty,
    firstPlayer: 'random',
    seed: seed,
  });
  const state = E.createGame(config);
  const R = state.config.regionCount;
  const api = { p1: seats.p1.ai, p2: seats.p2.ai };
  const labels = { p1: seats.p1.label, p2: seats.p2.label };
  const errors = [];

  const stats = { p1: newPlayerStats(), p2: newPlayerStats() };
  const own = (pid) => stats[pid];

  // 布局（与 tools/selfplay.js 相同的确定性 rng 派生口径；params 为训练/测试钩子）
  let events;
  try {
    const l1 = api.p1.chooseLayout(state, 'p1', specOpts(seats.p1, { rng: E.makeRng(seed ^ 0x1111) }));
    E.submitLayout(state, 'p1', l1);
    const l2 = api.p2.chooseLayout(state, 'p2', specOpts(seats.p2, { rng: E.makeRng(seed ^ 0x2222) }));
    E.submitLayout(state, 'p2', l2);
    events = E.finalizeLayout(state);
  } catch (err) {
    return { error: '布局异常：' + err.message };
  }
  for (const ev of events) trackEvent(ev);

  let steps = 0;
  let endgameTriggered = !!state.endgame.triggered;
  while (!E.isGameOver(state) && steps < MAX_STEPS) {
    const legal = E.getLegalActions(state);
    if (!legal.length) { errors.push('battle 阶段无合法行动'); break; }
    const pid = state.turn;
    const spec = seats[pid];
    const t0 = process.hrtime.bigint();
    let action;
    try {
      action = spec.ai.chooseAction(state, pid, specOpts(spec, {}));
    } catch (err) {
      return { error: 'chooseAction 抛异常（' + labels[pid] + '）：' + err.message };
    }
    const dt = Number(process.hrtime.bigint() - t0) / 1e6;
    const matched = findLegal(action, legal);
    if (!matched) return { error: 'AI 返回非法行动（' + labels[pid] + '）：' + canonical(action) };
    const st = own(pid);
    st.decisions += 1;
    st.decisionMs.push(dt);
    const cost = matched.cost != null ? matched.cost : (E.ACTION_COSTS[matched.type] || 0);
    st.apSpent += cost;
    st.actions[matched.type] += 1;
    if (matched.type === 'settle') {
      const region = state.regions[matched.regionId];
      const opp = pid === 'p1' ? 'p2' : 'p1';
      st.settles.push({
        deck: state.deck.length,
        open: E.getOpenRegionIds(state).length,
        diff: sumFaceUp(region.sides[pid].faceUp) - sumFaceUp(region.sides[opp].faceUp),
        turnIndex: state.turnCount,
        orderInTurn: state.turnProgress ? state.turnProgress.count : 0,
        myWins: state.regionWins[pid],
        oppWins: state.regionWins[opp],
      });
    }
    let evs;
    try {
      evs = E.performAction(state, matched);
    } catch (err) {
      return { error: 'performAction 抛异常：' + err.message + ' action=' + canonical(matched) };
    }
    for (const ev of evs) trackEvent(ev);
    if (state.endgame.triggered) endgameTriggered = true;
    steps += 1;
  }
  function trackEvent(ev) {
    if (!ev) return;
    if (ev.type === 'turn_start') {
      own(ev.playerId).turns += 1;
    } else if (ev.type === 'turn_end') {
      own(ev.playerId).apLeftTotal += (ev.leftAp || 0);
    } else if (ev.type === 'forfeit') {
      own(ev.playerId).forfeits += 1;
    }
  }
  if (E.isGameOver(state)) {
    const result = state.result;
    stats.p1.stalls = state.players.p1.stallCount || 0;
    stats.p2.stalls = state.players.p2.stallCount || 0;
    if (result.winner === 'p1' || result.winner === 'p2') {
      if (result.early) own(result.winner).earlyLockWins += 1;
    }
    return {
      winner: result.winner,
      reason: result.reason,
      early: !!result.early,
      endgameTriggered: endgameTriggered,
      steps: steps,
      forfeitedBy: result.forfeitedBy || null,
      firstPlayer: state.config.firstPlayer,
      settleCount: stats.p1.actions.settle + stats.p2.actions.settle,
      regionWins: result.regionWins,
      winsNeeded: result.winsNeeded,
      errors: errors,
      labels: labels,
      stats: stats,
    };
  }
  return { error: '对局未终止（超过 ' + MAX_STEPS + ' 步）' };
}

/* ------------------------------------------------------------------ */
/* 聚合                                                                */
/* ------------------------------------------------------------------ */
function emptyAgg() {
  return { games: 0, aWins: 0, bWins: 0, draws: 0, errors: 0, earlyLocks: 0, endgameTriggers: 0, totalSteps: 0, forfeits: 0 };
}

function addOutcome(agg, outcome, aSeat) {
  agg.games += 1;
  agg.totalSteps += outcome.steps;
  if (outcome.early) agg.earlyLocks += 1;
  if (outcome.endgameTriggered) agg.endgameTriggers += 1;
  if (outcome.forfeitedBy) agg.forfeits += 1;
  const w = outcome.winner;
  if (w === 'draw') agg.draws += 1;
  else if (w === aSeat) agg.aWins += 1;
  else agg.bWins += 1;
}

function emptyLabelAgg() {
  return {
    games: 0, earlyLockWins: 0, forfeits: 0, stalls: 0, decisions: 0,
    turns: 0, apSpent: 0, apLeftTotal: 0,
    actions: { settle: 0, flip: 0, place: 0, move: 0, draw: 0, end_turn: 0 },
    settles: [], decisionMs: [],
  };
}

function addLabelStats(agg, st) {
  agg.games += 1;
  agg.earlyLockWins += st.earlyLockWins;
  agg.forfeits += st.forfeits;
  agg.stalls += st.stalls;
  agg.decisions += st.decisions;
  agg.turns += st.turns;
  agg.apSpent += st.apSpent;
  agg.apLeftTotal += st.apLeftTotal;
  for (const k of Object.keys(agg.actions)) agg.actions[k] += st.actions[k];
  for (const s of st.settles) agg.settles.push(s);
  for (const ms of st.decisionMs) agg.decisionMs.push(ms);
}

function summarize(agg) {
  const decisive = agg.aWins + agg.bWins;
  const wl = wilson(agg.aWins, decisive);
  const wi = wilson(agg.aWins, agg.games);
  return {
    games: agg.games, aWins: agg.aWins, bWins: agg.bWins, draws: agg.draws, errors: agg.errors,
    aWinRateDecisive: decisive ? agg.aWins / decisive : 0,
    aWinRateDecisiveCI: wl,
    aWinRateInclDraw: agg.games ? agg.aWins / agg.games : 0,
    aWinRateInclDrawCI: wi,
    earlyLocks: agg.earlyLocks,
    endgameTriggers: agg.endgameTriggers,
    forfeits: agg.forfeits,
    avgSteps: agg.games ? agg.totalSteps / agg.games : 0,
  };
}

function summarizeLabel(label, agg) {
  const actions = agg.actions;
  const totalActions = Object.keys(actions).reduce((s, k) => s + actions[k], 0) || 1;
  const ms = agg.decisionMs.slice().sort((a, b) => a - b);
  const apCapacity = agg.turns * E.AP_PER_TURN;
  const diffBucketCounts = { '<=-7': 0, '-6..-3': 0, '-2..0': 0, '1..3': 0, '4..6': 0, '>=7': 0 };
  const deckAtSettle = [];
  const openAtSettle = [];
  const turnAtSettle = [];
  for (const s of agg.settles) {
    if (s.diff <= -7) diffBucketCounts['<=-7']++;
    else if (s.diff <= -3) diffBucketCounts['-6..-3']++;
    else if (s.diff <= 0) diffBucketCounts['-2..0']++;
    else if (s.diff <= 3) diffBucketCounts['1..3']++;
    else if (s.diff <= 6) diffBucketCounts['4..6']++;
    else diffBucketCounts['>=7']++;
    deckAtSettle.push(s.deck);
    openAtSettle.push(s.open);
    turnAtSettle.push(s.turnIndex);
  }
  const nSettles = agg.settles.length || 1;
  const diffBuckets = {};
  for (const k of Object.keys(diffBucketCounts)) diffBuckets[k] = diffBucketCounts[k] / nSettles;
  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
  return {
    label: label,
    games: agg.games,
    decisions: agg.decisions,
    turns: agg.turns,
    apUsageRate: apCapacity ? agg.apSpent / apCapacity : 0,
    avgApLeftPerTurnEnd: agg.turns ? agg.apLeftTotal / agg.turns : 0,
    actionShare: Object.keys(actions).reduce((o, k) => { o[k] = actions[k] / totalActions; return o; }, {}),
    actionCounts: actions,
    avgActionsPerGame: agg.games ? Object.keys(actions).reduce((s, k) => s + actions[k], 0) / agg.games : 0,
    settlePerGame: agg.games ? agg.settles.length / agg.games : 0,
    settleAvgDeck: avg(deckAtSettle),
    settleAvgOpen: avg(openAtSettle),
    settleAvgTurnIndex: avg(turnAtSettle),
    settleDiffBuckets: diffBuckets,
    earlyLockRate: agg.games ? agg.earlyLockWins / agg.games : 0,
    forfeits: agg.forfeits,
    stalls: agg.stalls,
    decisionMs: {
      p50: quantile(ms, 0.5), p95: quantile(ms, 0.95), p99: quantile(ms, 0.99),
      max: ms.length ? ms[ms.length - 1] : 0,
    },
  };
}

/* ------------------------------------------------------------------ */
/* 主基准                                                              */
/* ------------------------------------------------------------------ */
function runBenchmarkImpl(ctx) {
  const { specs, games, startSeed, bidir, configs, loaded } = ctx;
  const specA = specs.p1;
  const specB = specs.p2;
  const agg = emptyAgg();
  const byConfig = {};
  const byLabel = {};
  const errors = [];
  const pairCount = bidir ? Math.ceil(games / 2) : games;
  let unit = 0;
  for (let i = 0; i < pairCount; i++) {
    const cfg = configs[unit % configs.length];
    const seed = startSeed + Math.floor(unit / configs.length);
    unit++;
    // 方向 1：A 坐 p1
    runDirection(cfg, seed, { p1: specA, p2: specB }, 'p1');
    if (bidir) {
      // 方向 2：同一副牌，A 坐 p2（消除座位偏差）
      runDirection(cfg, seed, { p1: specB, p2: specA }, 'p2');
    }
  }
  function runDirection(cfg, seed, seats, aSeat) {
    const outcome = playOne(seed, cfg, seats);
    const ckey = cfg.key;
    if (!byConfig[ckey]) byConfig[ckey] = emptyAgg();
    if (outcome.error) {
      agg.errors += 1;
      byConfig[ckey].errors += 1;
      errors.push({ seed: seed, config: ckey, error: outcome.error });
      return;
    }
    for (const e of outcome.errors) errors.push({ seed: seed, config: ckey, error: e });
    addOutcome(agg, outcome, aSeat);
    addOutcome(byConfig[ckey], outcome, aSeat);
    // 行为统计按标签聚合（每个标签在本局 p1/p2 的统计）
    ['p1', 'p2'].forEach((pid) => {
      const label = outcome.labels[pid];
      if (label === specA.label && label === specB.label) return; // 同标签合并无意义
      if (!byLabel[label]) byLabel[label] = emptyLabelAgg();
      addLabelStats(byLabel[label], outcome.stats[pid]);
    });
  }
  const configSummaries = {};
  for (const k of Object.keys(byConfig)) configSummaries[k] = summarize(byConfig[k]);
  const labelSummaries = {};
  for (const k of Object.keys(byLabel)) labelSummaries[k] = summarizeLabel(k, byLabel[k]);
  return {
    meta: {
      p1: specA.label,
      p2: specB.label,
      aLabel: specA.label,
      bLabel: specB.label,
      games: agg.games,
      requestedGames: games,
      bidir: !!bidir,
      startSeed: startSeed,
      configs: configs.map((c) => c.key),
      currentAIVersion: loaded.current ? loaded.current.VERSION : null,
      baselineVersion: loaded.baseline ? loaded.baseline.VERSION : null,
      baselineFrozenSourceSha256: BASELINE_FROZEN_SOURCE_SHA256,
      baseline32Version: loaded.baseline32 ? loaded.baseline32.VERSION : null,
      baseline32Sha256: loaded.baseline32 ? BASELINE32_SHA256 : null,
      generatedAt: new Date().toISOString(),
    },
    overall: summarize(agg),
    byConfig: configSummaries,
    byLabel: labelSummaries,
    errors: errors,
  };
}

function runBenchmark(opts) {
  const specA = resolveSpec(opts.p1Name, opts.loaded);
  const specB = resolveSpec(opts.p2Name, opts.loaded);
  return runBenchmarkImpl({
    specs: { p1: specA, p2: specB },
    games: opts.games, startSeed: opts.startSeed, bidir: opts.bidir,
    configs: opts.configs, loaded: opts.loaded,
  });
}

/* ------------------------------------------------------------------ */
/* 文本报告                                                            */
/* ------------------------------------------------------------------ */
function formatReport(rep) {
  const o = rep.overall;
  const lines = [];
  lines.push('================ AI 对弈基准 ================');
  lines.push('对局: ' + o.games + ' 局 | 双向座位: ' + (rep.meta.bidir ? '是' : '否') +
    ' | 配置: ' + rep.meta.configs.join(','));
  lines.push('种子: ' + rep.meta.startSeed + '..' + (rep.meta.startSeed + Math.ceil(rep.meta.requestedGames / rep.meta.configs.length)) +
    ' | 当前 AI: ' + (rep.meta.currentAIVersion || '-') + ' | 冻结基线: ' + (rep.meta.baselineVersion || '-') +
    (rep.meta.baselineVersion ? ' (源 sha256 ' + rep.meta.baselineFrozenSourceSha256.slice(0, 12) + '…)' : ''));
  lines.push('');
  lines.push('结果（A=' + rep.meta.p1 + ', B=' + rep.meta.p2 + '）:');
  const ci = (x) => '[' + pct(x.lo) + ', ' + pct(x.hi) + ']';
  lines.push('  A 胜 ' + o.aWins + ' / B 胜 ' + o.bWins + ' / 平 ' + o.draws +
    ' | A 胜率(去平) ' + pct(o.aWinRateDecisive) + ' Wilson95% ' + ci(o.aWinRateDecisiveCI) +
    ' | A 胜率(含平) ' + pct(o.aWinRateInclDraw) + ' ' + ci(o.aWinRateInclDrawCI));
  lines.push('  提前锁定 ' + o.earlyLocks + ' 局 | 决战触发 ' + o.endgameTriggers + ' 局 | 认输 ' + o.forfeits +
    ' 局 | 平均步数 ' + o.avgSteps.toFixed(1) + ' | 异常 ' + (o.errors + rep.errors.length));
  lines.push('');
  lines.push('按配置:');
  for (const k of Object.keys(rep.byConfig)) {
    const c = rep.byConfig[k];
    lines.push('  ' + k + ': ' + c.games + ' 局  A 胜率(去平) ' + pct(c.aWinRateDecisive) +
      ' ' + ci(c.aWinRateDecisiveCI) + '  平均步数 ' + c.avgSteps.toFixed(1));
  }
  const labels = Object.keys(rep.byLabel);
  if (labels.length > 1) {
    lines.push('');
    lines.push('战役期行为对比（按 AI 标签）:');
    const rows = [
      ['每局行动数', (l) => l.avgActionsPerGame.toFixed(2)],
      ['每回合 AP 使用率', (l) => pct(l.apUsageRate)],
      ['回合结束平均剩余 AP', (l) => l.avgApLeftPerTurnEnd.toFixed(2)],
      ['settle 次数/局', (l) => l.settlePerGame.toFixed(2)],
      ['settle 时平均剩余牌堆', (l) => l.settleAvgDeck.toFixed(1)],
      ['settle 时平均未结算区域', (l) => l.settleAvgOpen.toFixed(2)],
      ['settle 时平均 turnCount', (l) => l.settleAvgTurnIndex.toFixed(1)],
      ['settle 时区域分差 <=-7', (l) => pct(l.settleDiffBuckets['<=-7'])],
      ['settle 时区域分差 -6..-3', (l) => pct(l.settleDiffBuckets['-6..-3'])],
      ['settle 时区域分差 -2..0', (l) => pct(l.settleDiffBuckets['-2..0'])],
      ['settle 时区域分差 1..3', (l) => pct(l.settleDiffBuckets['1..3'])],
      ['settle 时区域分差 4..6', (l) => pct(l.settleDiffBuckets['4..6'])],
      ['settle 时区域分差 >=7', (l) => pct(l.settleDiffBuckets['>=7'])],
      ['行动占比 settle', (l) => pct(l.actionShare.settle)],
      ['行动占比 flip', (l) => pct(l.actionShare.flip)],
      ['行动占比 place', (l) => pct(l.actionShare.place)],
      ['行动占比 move', (l) => pct(l.actionShare.move)],
      ['行动占比 draw', (l) => pct(l.actionShare.draw)],
      ['行动占比 end_turn', (l) => pct(l.actionShare.end_turn)],
      ['提前锁定获胜率', (l) => pct(l.earlyLockRate)],
      ['决策 p50/p95/p99/max (ms)', (l) => l.decisionMs.p50.toFixed(2) + ' / ' + l.decisionMs.p95.toFixed(2) + ' / ' +
        l.decisionMs.p99.toFixed(2) + ' / ' + l.decisionMs.max.toFixed(2)],
    ];
    const w = Math.max.apply(null, labels.map((l) => l.length)) + 2;
    lines.push('  ' + '指标'.padEnd(34) + labels.map((l) => l.padEnd(w)).join(''));
    for (const [name, fn] of rows) {
      lines.push('  ' + name.padEnd(34) + labels.map((l) => String(fn(rep.byLabel[l])).padEnd(w)).join(''));
    }
  }
  if (rep.errors.length) {
    lines.push('');
    lines.push('异常（前 10 条）:');
    for (const e of rep.errors.slice(0, 10)) lines.push('  seed=' + e.seed + ' ' + e.config + ': ' + e.error);
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */
function main() {
  const args = parseArgs(process.argv);
  const p1Name = String(args.p1 || args.p1strength || 'hard');
  const p2Name = String(args.p2 || args.p2strength || 'medium');
  const games = Math.max(2, Number(args.games || 400));
  const startSeed = Number(args.seed || 20260000);
  const bidir = args.bidir === undefined ? true : !(args.bidir === '0' || args.bidir === 'false');
  const configs = buildConfigs(args);
  const loaded = { current: loadCurrent(), baseline: null, baseline32: null };
  const needsBaseline = [p1Name, p2Name].some((n) => /^(hard|medium|easy)22$/.test(n));
  const needsBaseline32 = [p1Name, p2Name].some((n) => /^(hard|medium|easy)32$/.test(n));
  if (needsBaseline) loaded.baseline = loadBaseline();
  if (needsBaseline32) loaded.baseline32 = loadBaseline32();
  const specs = {
    p1: resolveSpec(p1Name, loaded),
    p2: resolveSpec(p2Name, loaded),
  };
  // 训练 checkpoint 参数注入（tools/train-ai.js 产出；内部测试用）
  ['p1', 'p2'].forEach((slot) => {
    const file = args[slot + 'params'];
    if (!file) return;
    const abs = path.isAbsolute(String(file)) ? String(file) : path.join(ROOT, String(file));
    const raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
    const tier = specs[slot].strength;
    const params = raw && raw.params ? raw.params : raw;
    if (!params || typeof params !== 'object') throw new Error('参数文件格式不正确：' + abs);
    specs[slot].params = {};
    specs[slot].params[tier] = params;
    specs[slot].label = specs[slot].label + '-ckpt';
  });
  runBenchmarkWithSpecs({ specs, games, startSeed, bidir, configs, loaded, args });
}

function runBenchmarkWithSpecs(ctx) {
  const { specs, games, startSeed, bidir, configs, loaded, args } = ctx;
  const t0 = Date.now();
  const rep = runBenchmarkImpl({ specs, games, startSeed, bidir, configs, loaded });
  const ms = Date.now() - t0;
  rep.meta.elapsedMs = ms;
  const text = formatReport(rep);
  if (!args || !args.quiet) {
    console.log(text);
    console.log('耗时 ' + (ms / 1000).toFixed(1) + 's');
  }
  if (args && args.json) {
    const outPath = path.isAbsolute(String(args.json)) ? String(args.json) : path.join(ROOT, String(args.json));
    fs.writeFileSync(outPath, JSON.stringify(rep, null, 2), 'utf8');
    console.log('JSON 报告已写入 ' + outPath);
  }
  if (rep.errors.length) process.exitCode = 1;
  return rep;
}

module.exports = {
  MIXED_CONFIGS,
  CANON6_CONFIGS,
  BASELINE_FROZEN_SOURCE_SHA256,
  BASELINE32_SHA256,
  playOne,
  runBenchmark,
  runBenchmarkImpl,
  buildConfigs,
  wilson,
  formatReport,
  loadCurrent,
  loadBaseline,
  loadBaseline32,
};

if (require.main === module) main();
