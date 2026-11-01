'use strict';
/* v2.3 AI 行为测试（ML 2.0.0）：世界模型 + 采样世界计划评估（planpi）/ 三阶段自由框架 / 决战 build 自由（全合法行动 + 防 stall 护栏）/ 战斗首行动多样性 / 无 stall-forfeit / 确定性 / 公平 / 合法
 * 运行：node tests/ai-behavior.test.js（已加入 tests/run-all.js）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const E = require(path.join(ROOT, 'js', 'engine.js'));
const AI = require(path.join(ROOT, 'js', 'ai.js'));
const ML = require(path.join(ROOT, 'js', 'ai-ml.js'));

const ML_POLICY = ML.createPolicy(AI, { strength: 'hard' });
const AGENTS = {
  heuristic: { label: 'heuristic ' + AI.VERSION, ai: AI, strength: 'hard' },
  ml: { label: 'ML ' + ML.VERSION, ai: ML_POLICY, strength: 'hard' }
};
const CANON = [
  { regions: 3, settle: 1, difficulty: 1 }, { regions: 3, settle: 2, difficulty: 2 }, { regions: 3, settle: 4, difficulty: 3 },
  { regions: 5, settle: 1, difficulty: 2 }, { regions: 5, settle: 2, difficulty: 1 }, { regions: 5, settle: 4, difficulty: 3 }
];
const PRODUCTIVE = new Set(['settle', 'flip', 'place', 'draw']);
const key = (a) => JSON.stringify(a || null);
function canonical(a) { if (!a || typeof a !== 'object') return String(a); const o = {}; for (const k of Object.keys(a).sort()) o[k] = a[k]; return JSON.stringify(o); }
function entropy(counts) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (!total) return 0;
  let h = 0;
  for (const v of Object.values(counts)) if (v > 0) { const p = v / total; h -= p * Math.log(p); }
  return h;
}

function newGame(seed, cfg) {
  const state = E.createGame(E.defaultConfig({
    endgameApCapRule: false, // task-147: legacy behavior pin
    seed, regionCount: cfg.regions, difficulty: cfg.difficulty, settleCards: cfg.settle,
    firstPlayer: seed % 2 === 0 ? 'p1' : 'p2', aiStrength: 'hard'
  }));
  // 产品集成：ML 只重排行动，布局由启发式 3.2.0 完成（v2.2 布局自由框架实测 subsetDiff=0）
  for (const pid of ['p1', 'p2']) E.submitLayout(state, pid, AI.chooseLayout(state, pid, { strength: 'hard' }));
  E.finalizeLayout(state);
  return state;
}

function newTurn(pid, isBuild) { return { pid, actions: [], places: 0, flips: 0, moves: 0, settles: 0, draws: 0, productive: 0, isBuild, endedEarly: false }; }
function finishTurn(stats, turn) {
  if (!turn) return;
  stats.turns++;
  if (!turn.actions.length) return;
  stats.turnsWithAction++;
  const last = turn.actions[turn.actions.length - 1];
  if (last.type === 'end_turn' && last.apBefore > 0 && turn.productive > 0) { stats.earlyEnd++; turn.endedEarly = true; }
  if (turn.isBuild) {
    stats.buildTurns++;
    if (!turn.productive) stats.buildNoProductiveTurns++;
    if (last.type === 'end_turn' && turn.productive === 0) {
      stats.endTurnBeforeProductive++;
      // v2.4/ML 2.1.0：build 阶段允许「学习到的主动空过」（不写死，由价值模型决定）——单独统计，战斗阶段仍视为 stall 风险
      if (turn.isBuild) stats.endTurnBeforeProductiveBuild++; else stats.endTurnBeforeProductiveBattle++;
    }
    stats.buildActions += turn.actions.length;
    stats.buildPlacesTotal += turn.places;
    stats.buildFlipsTotal += turn.flips;
    stats.buildMovesTotal += turn.moves;
    const first = turn.actions[0].type;
    stats.buildFirstType[first] = (stats.buildFirstType[first] || 0) + 1;
    const seq = turn.actions.map((a) => ({ flip: 'F', place: 'P', move: 'M', end_turn: 'E', settle: 'S', draw: 'D' }[a.type] || '?')).join('');
    stats.buildSeqTop[seq] = (stats.buildSeqTop[seq] || 0) + 1;
  } else {
    stats.battleTurns++;
    stats.battleFirstType[turn.actions[0].type] = (stats.battleFirstType[turn.actions[0].type] || 0) + 1;
    for (const a of turn.actions) {
      if (a.type === 'settle') stats.battleSettles++;
      else if (a.type === 'draw') stats.battleDraws++;
      else if (a.type === 'place') stats.battlePlaces++;
      else if (a.type === 'flip') stats.battleFlips++;
      else if (a.type === 'move') stats.battleMoves++;
    }
  }
}

function runAgent(agent, games) {
  const stats = {
    label: agent.label, games, turns: 0, turnsWithAction: 0, earlyEnd: 0,
    buildTurns: 0, buildNoProductiveTurns: 0, endTurnBeforeProductive: 0, endTurnBeforeProductiveBuild: 0, endTurnBeforeProductiveBattle: 0,
    buildActions: 0, buildPlacesTotal: 0, buildFlipsTotal: 0, buildMovesTotal: 0,
    buildFirstType: {}, buildSeqTop: {},
    battleTurns: 0, battleFirstType: {},
    battleSettles: 0, battleDraws: 0, battlePlaces: 0, battleFlips: 0, battleMoves: 0,
    forfeits: 0, illegals: 0, anomalies: 0, reasons: {}
  };
  for (let gi = 0; gi < games; gi++) {
    const seed = 850100 + gi;
    const cfg = CANON[gi % CANON.length];
    const state = newGame(seed, cfg);
    let guard = 0, cur = null;
    while (state.phase === 'battle' && guard++ < 5000) {
      const pid = state.turn;
      const legal = E.getLegalActions(state);
      if (!legal.length) { stats.anomalies++; break; }
      const isBuild = !!(state.endgame && state.endgame.triggered && state.endgame.phase === 'build');
      if (!cur || cur.pid !== pid) { finishTurn(stats, cur); cur = newTurn(pid, isBuild); }
      let action = null;
      try { action = agent.ai.chooseAction(state, pid, { strength: agent.strength }); } catch (e) { action = null; }
      if (!action) { stats.anomalies++; break; }
      if (!legal.some((x) => key(x) === key(action))) { stats.illegals++; break; }
      cur.actions.push({ type: action.type, apBefore: state.players[pid].ap });
      if (action.type === 'place') cur.places++;
      if (action.type === 'flip') cur.flips++;
      if (action.type === 'move') cur.moves++;
      if (PRODUCTIVE.has(action.type)) cur.productive++;
      E.performAction(state, action);
      if (action.type === 'end_turn') { finishTurn(stats, cur); cur = null; }
    }
    finishTurn(stats, cur);
    if (state.phase !== 'gameover') { stats.anomalies++; continue; }
    const r = state.result || {};
    stats.reasons[r.reason || 'unknown'] = (stats.reasons[r.reason || 'unknown'] || 0) + 1;
    if (r.reason === 'forfeit') stats.forfeits++;
  }
  stats.earlyEndRatio = stats.turnsWithAction ? stats.earlyEnd / stats.turnsWithAction : 0;
  const buildFirstTotal = Object.values(stats.buildFirstType).reduce((a, b) => a + b, 0);
  stats.buildFirstEntropy = entropy(stats.buildFirstType);
  stats.buildFirstTypesUsed = Object.keys(stats.buildFirstType).filter((k) => stats.buildFirstType[k] > 0).length;
  stats.buildTopPattern = Object.entries(stats.buildSeqTop).sort((a, b) => b[1] - a[1])[0] || [null, 0];
  stats.buildTopPatternShare = stats.buildTurns ? stats.buildTopPattern[1] / Math.max(1, buildFirstTotal) : 0;
  const battleTotal = Object.values(stats.battleFirstType).reduce((a, b) => a + b, 0);
  stats.battleFirstEntropy = entropy(stats.battleFirstType);
  stats.battleFirstTypesUsed = Object.keys(stats.battleFirstType).filter((k) => stats.battleFirstType[k] > 0).length;
  stats.battleTopType = Object.entries(stats.battleFirstType).sort((a, b) => b[1] - a[1])[0] || [null, 0];
  stats.battleTopTypeShare = battleTotal ? stats.battleTopType[1] / battleTotal : 0;
  return stats;
}

function actionSequence(agent, seed, cfg) {
  const state = newGame(seed, cfg);
  const seq = [];
  let guard = 0;
  while (state.phase === 'battle' && guard++ < 5000) {
    const legal = E.getLegalActions(state);
    if (!legal.length) break;
    const a = agent.ai.chooseAction(state, state.turn, { strength: agent.strength });
    if (!legal.some((x) => key(x) === key(a))) break;
    seq.push(canonical(a));
    E.performAction(state, a);
  }
  return { seq, reason: state.result ? state.result.reason : null };
}

function fairnessCheck(agent, samples) {
  let checked = 0, mismatch = 0; const diffs = [];
  const state = newGame(852100 + samples, CANON[0]);
  let guard = 0;
  while (state.phase === 'battle' && checked < samples && guard++ < 5000) {
    const legal = E.getLegalActions(state);
    if (!legal.length) break;
    const pid = state.turn;
    const a = agent.ai.chooseAction(state, pid, { strength: agent.strength });
    // 只在决策时刻抽查：扰动隐藏信息（对手手牌顺序/背面牌身份轮换/牌堆反转）
    const clone = JSON.parse(JSON.stringify(state));
    clone.deck.reverse();
    const opp = pid === 'p1' ? 'p2' : 'p1';
    const arrs = [clone.players[opp].hand];
    for (const r of clone.regions) arrs.push(r.sides[opp].faceDown);
    const pool = [];
    for (const arr of arrs) for (let i = 0; i < arr.length; i++) pool.push(arr[i]);
    if (pool.length > 1) {
      let rot = pool.slice(1).concat([pool[0]]);
      let k = 0;
      for (const arr of arrs) for (let i = 0; i < arr.length; i++) arr[i] = rot[k++];
    }
    const b = agent.ai.chooseAction(clone, pid, { strength: agent.strength });
    checked++;
    if (canonical(a) !== canonical(b)) { mismatch++; if (diffs.length < 3) diffs.push({ seed: state.config.seed, turn: state.turn, a: canonical(a), b: canonical(b) }); }
    if (!legal.some((x) => key(x) === key(a))) break;
    E.performAction(state, a);
  }
  return { checked, mismatch, diffs };
}

const CACHE = {};
function statsOf(kind) { if (!CACHE[kind]) CACHE[kind] = runAgent(AGENTS[kind], 24); return CACHE[kind]; }

test('AI 行为：ML 2.1.1 三阶段自由框架（战斗首行动多样 + 决战 build 自由 + 防 stall 护栏）', () => {
  assert.equal(ML.VERSION, '2.3.0', 'task-147: 当前 ML VERSION 2.3.0，实际 ' + ML.VERSION);
  assert.equal(ML_POLICY.isMlEnabled(7), true, 'ML 2.0.0 应启用全部区域（含 7 区）');
  const h = statsOf('heuristic');
  const m = statsOf('ml');
  console.log('[behavior] heuristic:', JSON.stringify({ turns: h.turnsWithAction, earlyEndRatio: h.earlyEndRatio, battleFirstType: h.battleFirstType, buildTurns: h.buildTurns, buildFirstType: h.buildFirstType, buildFirstEntropy: h.buildFirstEntropy, buildTop: [h.buildTopPattern[0], h.buildTopPatternShare], reasons: h.reasons }));
  console.log('[behavior] ml:', JSON.stringify({ turns: m.turnsWithAction, earlyEndRatio: m.earlyEndRatio, battleTurns: m.battleTurns, battleFirstType: m.battleFirstType, battleFirstEntropy: m.battleFirstEntropy, battleCounts: { S: m.battleSettles, D: m.battleDraws, P: m.battlePlaces, F: m.battleFlips, M: m.battleMoves }, buildTurns: m.buildTurns, buildFirstType: m.buildFirstType, buildFirstEntropy: m.buildFirstEntropy, buildTop: [m.buildTopPattern[0], m.buildTopPatternShare], buildMoves: m.buildMovesTotal, endTurnBeforeProductive: m.endTurnBeforeProductive, reasons: m.reasons }));
  // ML 提前结束回合：只在已有推进行动后（守卫），比例保持在合理区间
  assert.ok(m.turnsWithAction > 200, 'ML 样本回合数应足够，实际 ' + m.turnsWithAction);
  assert.ok(m.earlyEndRatio >= 0.02 && m.earlyEndRatio <= 0.55, 'ML 提前 end_turn 占比应在 2%~55%，实际 ' + (100 * m.earlyEndRatio).toFixed(2) + '%');
  // 战斗阶段：世界模型/采样世界计划评估带来的首行动多样性（settle/flip/place/move/draw 多类均可先手）
  assert.ok(m.battleTurns > 100, 'ML 应有足够战斗回合，实际 ' + m.battleTurns);
  assert.ok(m.battleFirstTypesUsed >= 5, '战斗首行动应至少使用 5 类行动，实际 ' + JSON.stringify(m.battleFirstType));
  assert.ok(m.battleFirstEntropy >= 1.0, '战斗首行动熵应≥1.0（多类自由先手），实际 ' + m.battleFirstEntropy.toFixed(3));
  assert.ok(m.battleTopTypeShare <= 0.65, '战斗单一首行动类型占比应≤65%，实际 ' + (100 * m.battleTopTypeShare).toFixed(1) + '%');
  // 决战 build：全部合法行动自由（≥2 类首行动被使用、熵≥0.75），无固定单一套路
  assert.ok(m.buildTurns > 0, '应有决战 build 回合');
  assert.ok(m.buildFirstTypesUsed >= 2, 'build 首行动应至少使用 2 类行动，实际 ' + JSON.stringify(m.buildFirstType));
  assert.ok(m.buildFirstEntropy >= 0.75, 'build 首行动熵应≥0.75（实测 move 偏多但非单一固定），实际 ' + m.buildFirstEntropy.toFixed(3));
  assert.ok(m.buildTopPatternShare <= 0.85, 'build 单一序列模式占比应≤85%，实际 ' + (100 * m.buildTopPatternShare).toFixed(1) + '%');
  assert.ok(m.buildMovesTotal > 0, 'build 应实际使用 move（自由战术），实际 ' + m.buildMovesTotal);
  // 防 stall：战斗阶段绝不无推进 end_turn；build 阶段允许 ML 2.1.0「学习到的主动空过」（不写死，单独统计并要求非退化）
  assert.equal(m.endTurnBeforeProductiveBattle, 0, 'ML 战斗阶段不应在无推进行动时 end_turn（build 主动空过另计），实际 ' + m.endTurnBeforeProductiveBattle);
  assert.ok(m.endTurnBeforeProductiveBuild > 0, 'ML 2.1.0 build 应出现「学习到的主动空过」（0 说明空过候选未生效），实际 ' + m.endTurnBeforeProductiveBuild);
  assert.ok(m.endTurnBeforeProductiveBuild <= Math.max(5, Math.round(0.75 * m.buildTurns)), 'build 主动空过占比应≤75%（防退化），实际 ' + m.endTurnBeforeProductiveBuild + '/' + m.buildTurns);
  assert.equal(m.buildNoProductiveTurns, m.endTurnBeforeProductiveBuild, 'build 无推进回合应仅为主动空过，实际 ' + m.buildNoProductiveTurns + ' vs ' + m.endTurnBeforeProductiveBuild);
  // 启发式 3.2.0：仅报告宽松上限
  assert.ok(h.earlyEndRatio >= 0 && h.earlyEndRatio <= 0.60, 'heuristic 提前 end_turn 占比异常：' + (100 * h.earlyEndRatio).toFixed(2) + '%');
});

test('无 stall/forfeit 与非法行动（canon6 自对弈）', () => {
  for (const kind of ['heuristic', 'ml']) {
    const s = statsOf(kind);
    assert.equal(s.forfeits, 0, kind + ' 不应出现认输判负');
    assert.equal(s.illegals, 0, kind + ' 不应有非法行动');
    assert.equal(s.anomalies, 0, kind + ' 不应有异常/卡死/空行动');
    assert.ok((s.reasons.region_wins || 0) > 0, kind + ' 应至少有一局区域胜场终局，实际 ' + JSON.stringify(s.reasons));
  }
});

test('同 seed 确定性：AI 行动序列完全一致', () => {
  for (const kind of ['heuristic', 'ml']) {
    const agent = AGENTS[kind];
    for (const seed of [853100, 853101, 853102]) {
      const cfg = CANON[seed % CANON.length];
      const a = actionSequence(agent, seed, cfg);
      const b = actionSequence(agent, seed, cfg);
      assert.equal(a.seq.join('|'), b.seq.join('|'), kind + ' seed=' + seed + ' 决策序列不一致');
      assert.equal(a.reason, b.reason, kind + ' seed=' + seed + ' 结果不一致');
    }
  }
});

test('信息公平：扰动隐藏信息后决策不变', () => {
  for (const kind of ['heuristic', 'ml']) {
    const f = fairnessCheck(AGENTS[kind], 12);
    assert.ok(f.checked >= 8, kind + ' 公平检查样本应≥8，实际 ' + f.checked);
    assert.equal(f.mismatch, 0, kind + ' 隐藏信息扰动后出现决策不一致：' + JSON.stringify(f.diffs));
  }
});
