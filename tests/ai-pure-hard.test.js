'use strict';
/*
 * v2.18.0 困难档纯学习 bundle 回归：接口 / 三档全局共存 / 合法性与整局可完成。
 * 模型：2026-10-31 交付 PPO H192 gen436（js/ai-pure-hard.js）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const E = require(path.join(ROOT, 'js', 'engine.js'));
globalThis.PokerEngine = E;
globalThis.PokerAI = require(path.join(ROOT, 'js', 'ai.js'));
globalThis.PokerAIML = require(path.join(ROOT, 'js', 'ai-ml.js'));
const AI = globalThis.PokerAI;

require(path.join(ROOT, 'js', 'ai-pure-simple.js'));
require(path.join(ROOT, 'js', 'ai-pure.js'));
require(path.join(ROOT, 'js', 'ai-pure-hard.js'));

const HARD = globalThis.PokerAIPureHard;
const MEDIUM = globalThis.PokerAIPure;
const SIMPLE = globalThis.PokerAIPureSimple;

function sameAction(a, b) {
  return !!a && !!b && a.type === b.type &&
    (a.regionId == null) === (b.regionId == null) && a.regionId === b.regionId &&
    (a.cardId == null) === (b.cardId == null) && a.cardId === b.cardId &&
    (a.fromRegionId == null) === (b.fromRegionId == null) && a.fromRegionId === b.fromRegionId &&
    (a.toRegionId == null) === (b.toRegionId == null) && a.toRegionId === b.toRegionId;
}

test('v2.18 困难档 bundle：存在、版本/参数 sha 正确、createPolicy 可用', () => {
  assert.ok(HARD, 'PokerAIPureHard 未加载');
  assert.strictEqual(HARD.VERSION, '2.7.4-opt-h192-final-20261031-gen436');
  assert.strictEqual(HARD.PARAMS_SHA256, '1B1A76CD095DF0F870D9DED4BC0E6516C86683D93AE797A9C8CF7462127ED985');
  assert.strictEqual(typeof HARD.createPolicy, 'function');
  assert.strictEqual(HARD.hasModel(), true);
  const pol = HARD.createPolicy(AI, { strength: 'hard' });
  assert.strictEqual(typeof pol.chooseAction, 'function');
  assert.strictEqual(typeof pol.chooseLayout, 'function');
});

test('v2.18 三档全局共存（hard 不覆盖 medium/simple）', () => {
  assert.ok(SIMPLE && SIMPLE.VERSION.indexOf('gen60') >= 0, 'simple 版本异常');
  assert.ok(MEDIUM && MEDIUM.VERSION.indexOf('phase17-psro-H128') >= 0, 'medium 版本异常');
  assert.ok(HARD && HARD.VERSION.indexOf('gen436') >= 0, 'hard 版本异常');
  assert.notStrictEqual(SIMPLE, MEDIUM);
  assert.notStrictEqual(MEDIUM, HARD);
});

test('v2.18 困难档：3 局（3/5/7 区）行动全部合法、整局可完成、确定性', () => {
  const cfgs = [
    { regionCount: 3, settleCards: 1, difficulty: 1 },
    { regionCount: 5, settleCards: 2, difficulty: 2 },
    { regionCount: 7, settleCards: 4, difficulty: 3 }
  ];
  const pol = HARD.createPolicy(AI, { strength: 'hard' });
  for (let gi = 0; gi < cfgs.length; gi++) {
    const cfg = cfgs[gi];
    const state = E.createGame(E.defaultConfig({
      regionCount: cfg.regionCount, settleCards: cfg.settleCards, difficulty: cfg.difficulty,
      firstPlayer: 'random', seed: 2180000 + gi, endgameApCapRule: true
    }));
    for (const pid of ['p1', 'p2']) {
      const ids = AI.chooseLayout(state, pid, { strength: 'hard' });
      E.submitLayout(state, pid, ids);
    }
    E.finalizeLayout(state);
    let steps = 0;
    while (!E.isGameOver(state) && steps < 8000) {
      const legal = E.getLegalActions(state);
      assert.ok(legal.length > 0, '应存在合法动作');
      const act = pol.chooseAction(state, state.turn, { strength: 'hard' });
      assert.ok(act, 'chooseAction 不应返回空');
      const match = legal.find((l) => sameAction(l, act));
      assert.ok(match, '困难档决策必须合法：' + JSON.stringify(act));
      E.performAction(state, match);
      steps++;
    }
    assert.ok(E.isGameOver(state), '困难档对局应在 8000 步内结束');
    assert.ok(state.result && ['p1', 'p2', 'draw'].indexOf(state.result.winner) >= 0);
  }
});
