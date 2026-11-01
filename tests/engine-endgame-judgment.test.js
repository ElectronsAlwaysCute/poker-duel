'use strict';
/* v2.6 终局判定回归（task-103）：胜场多者胜 → 手牌总和 → 真平局
 * 覆盖：7 区 3:2+2平 摊牌 0:0（旧 BUG 场景）、胜场多但手牌相等、hand_sum、真平局、提前锁定不变。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const E = require(path.join(ROOT, 'js', 'engine.js'));
const AI = require(path.join(ROOT, 'js', 'ai.js'));
const h = require(path.join(ROOT, 'tests', 'helpers.js'));
const key = (a) => JSON.stringify(a || null);

function play(seed, cfg) {
  const state = E.createGame(E.defaultConfig({ seed, regionCount: cfg.regionCount, settleCards: cfg.settleCards, difficulty: cfg.difficulty, firstPlayer: 'random', aiStrength: 'medium' }));
  E.submitLayout(state, 'p1', AI.chooseLayout(state, 'p1'));
  E.submitLayout(state, 'p2', AI.chooseLayout(state, 'p2'));
  E.finalizeLayout(state);
  let guard = 0;
  while (!E.isGameOver(state) && guard++ < 6000) {
    const legal = E.getLegalActions(state);
    assert.ok(legal.length, 'battle 阶段应有合法行动');
    const a = AI.chooseAction(state, state.turn);
    assert.ok(legal.some((x) => key(x) === key(a)), 'AI 行动应合法：' + key(a));
    E.performAction(state, a);
  }
  assert.ok(E.isGameOver(state), '对局应正常结束');
  return state;
}
const logText = (state) => state.log.map((l) => l.text).join('\n');

test('§6 回归（BUG）：7 区摊牌 3:2（2 平）手牌 0:0 → 多胜方获胜 reason=region_wins early=false', () => {
  const state = play(9, { regionCount: 7, settleCards: 1, difficulty: 1 });
  const r = state.result;
  assert.equal(r.winner, 'p1', '3:2 时应判多胜方 p1 获胜（旧 BUG 会判 draw）');
  assert.equal(r.reason, 'region_wins');
  assert.equal(r.early, false);
  assert.deepStrictEqual(r.regionWins, { p1: 3, p2: 2, ties: 2 });
  assert.deepStrictEqual(r.handSums, { p1: 0, p2: 0 });
  assert.deepStrictEqual(r.unsettledRegions, []);
  assert.match(logText(state), /对局结束：你获胜（区域胜利 3 : 2）/);
  assert.doesNotMatch(logText(state), /对局结束：平局/);
  h.assertInvariants(E, state, 'seed9 7区3:2摊牌');
});

test('§6 回归：区域胜场多者优先于手牌总和（7 区 3:2 · 2 平，手牌总和相等 20:20）', () => {
  const state = play(101, { regionCount: 7, settleCards: 1, difficulty: 3 });
  const r = state.result;
  assert.deepStrictEqual(r.regionWins, { p1: 3, p2: 2, ties: 2 });
  assert.deepStrictEqual(r.handSums, { p1: 20, p2: 20 }, '手牌总和相等，旧逻辑会判 draw');
  assert.equal(r.winner, 'p1');
  assert.equal(r.reason, 'region_wins');
  assert.equal(r.early, false);
  assert.match(logText(state), /对局结束：你获胜（区域胜利 3 : 2）/);
  h.assertInvariants(E, state, 'seed101 胜场优先');
});

test('§6 回归：胜场相同 → 手牌总和多者胜（reason=hand_sum，文案含「区域胜场相同」）', () => {
  const state = play(5, { regionCount: 3, settleCards: 2, difficulty: 3 });
  const r = state.result;
  assert.deepStrictEqual(r.regionWins, { p1: 1, p2: 1, ties: 1 });
  assert.equal(r.reason, 'hand_sum');
  assert.equal(r.winner, r.handSums.p1 > r.handSums.p2 ? 'p1' : 'p2');
  assert.notEqual(r.handSums.p1, r.handSums.p2);
  assert.match(logText(state), /区域胜场相同 1 : 1/);
  assert.match(logText(state), /比较手牌总和 \d+ : \d+/);
  h.assertInvariants(E, state, 'seed5 hand_sum');
});

test('§6 回归：胜场相同且手牌总和相同 → 真平局（draw，文案如实写胜场与手牌）', () => {
  const state = play(178, { regionCount: 5, settleCards: 4, difficulty: 2 });
  const r = state.result;
  assert.deepStrictEqual(r.regionWins, { p1: 2, p2: 2, ties: 1 });
  assert.deepStrictEqual(r.handSums, { p1: 0, p2: 0 });
  assert.equal(r.winner, 'draw');
  assert.equal(r.reason, 'draw');
  assert.match(logText(state), /对局结束：平局（区域胜场相同 2 : 2 · 平 1，手牌总和相同 0 : 0）/);
  h.assertInvariants(E, state, 'seed178 真平局');
});

test('§6 回归：提前锁定优先级不变（early=true / 未结算区域保留）', () => {
  const state = play(1, { regionCount: 3, settleCards: 1, difficulty: 2 });
  const r = state.result;
  assert.equal(r.reason, 'region_wins');
  assert.equal(r.early, true);
  assert.ok(r.unsettledRegions.length > 0, '提前锁定应保留未结算区域');
  assert.ok(Math.max(r.regionWins.p1, r.regionWins.p2) >= state.config.winsNeeded);
  assert.match(logText(state), /提前锁定：/);
  h.assertInvariants(E, state, 'seed1 提前锁定');
});

test('§6 性质扫描：任意终局均满足「胜场多者胜 / 胜场同看手牌 / 全同才平局」', () => {
  const configs = [];
  for (const R of [3, 5, 7]) for (const N of [1, 2, 4]) for (const D of [1, 2, 3]) configs.push({ regionCount: R, settleCards: N, difficulty: D });
  const counts = { region_wins: 0, hand_sum: 0, draw: 0 };
  const anomalies = [];
  for (let seed = 1; seed <= 60; seed++) {
    const state = play(seed, configs[seed % configs.length]);
    const r = state.result, rw = r.regionWins, hs = r.handSums;
    counts[r.reason] = (counts[r.reason] || 0) + 1;
    const winsEqual = rw.p1 === rw.p2;
    const handsEqual = hs.p1 === hs.p2;
    const need = state.config.winsNeeded;
    if (r.reason === 'draw' && !(winsEqual && handsEqual)) anomalies.push({ seed, kind: 'draw 但胜场/手牌不同', rw, hs });
    if (r.reason === 'hand_sum' && (!winsEqual || handsEqual)) anomalies.push({ seed, kind: 'hand_sum 前提不成立', rw, hs });
    if (r.reason === 'region_wins' && !r.early) {
      const reached = Math.max(rw.p1, rw.p2) >= need;
      if (!reached && (winsEqual || r.winner !== (rw.p1 > rw.p2 ? 'p1' : 'p2'))) anomalies.push({ seed, kind: '非提前 region_wins 胜场判定错误', rw, winner: r.winner });
    }
    h.assertInvariants(E, state, '性质扫描 seed=' + seed);
  }
  assert.deepStrictEqual(anomalies, [], '判定不变量异常：' + JSON.stringify(anomalies));
  // 真平局分支由上面的固定 seed178 专项用例覆盖；性质扫描至少覆盖 region_wins + hand_sum
  assert.ok(counts.region_wins > 0 && counts.hand_sum > 0, '性质扫描应覆盖 region_wins + hand_sum，实际 ' + JSON.stringify(counts));
  console.log('[drawfix] 判定分支覆盖:', JSON.stringify(counts));
});
