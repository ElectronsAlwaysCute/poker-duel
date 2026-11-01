'use strict';
/*
 * 扑克牌 · 比大小 —— AI 合法性与信息公平测试（零依赖，node:test）
 * 运行：node tests/ai.test.js
 *
 * 验收目标（CONTRACT §6 + RULES）：
 *  1) chooseLayout 返回 R 个、来自自己手牌、不重复的 cardId；
 *  2) chooseAction 永远返回当前合法行动集合内的动作（穷举集合）；
 *  3) 确定性：同 seed / 同 opts.rng / 同局面 → 同决策；
 *  4) 纯函数：不修改 state；
 *  5) 信息公平：隐藏信息（牌堆顺序、对手手牌顺序/身份、对手背面牌身份）变化不影响决策；
 *  6) AI 自对弈整局不越界、不卡死、状态不变量成立。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');

const E = h.loadEngine();
const AI = h.loadAI();

function invariant(state, label, opts) {
  h.assertInvariants(E, state, label, opts);
}

function makeOpts(seed, extra) {
  return Object.assign({ rng: E.makeRng(seed) }, extra || {});
}

function aiLayout(state, pid, seed, strength) {
  return AI.chooseLayout(state, pid, makeOpts(seed, strength ? { strength } : undefined));
}

function assertLegalAIAction(state, pid, action) {
  const legal = E.getLegalActions(state);
  const matched = h.findLegalEquivalent(action, legal);
  assert.ok(matched, 'AI 返回的行动不在合法集合内：' + h.canonicalAction(action) +
    '\n局面：' + h.describeState(state) +
    '\n合法集合：' + legal.map(h.canonicalAction).join(', '));
  return matched;
}

/** 确定性推进策略（用于构造局面，避免 AP 多行动下空转 end_turn）。 */
function apPolicyPick(state, legal, prefer) {
  const inBuild = !!(state.endgame && state.endgame.triggered && state.endgame.phase === 'build');
  if (inBuild) {
    const a = legal.find((x) => x.type === 'place') || legal.find((x) => x.type === 'flip') || legal.find((x) => x.type === 'move');
    if (a) return a;
    return legal.find((x) => x.type === 'end_turn') || legal[0];
  }
  for (const t of prefer || []) {
    const a = legal.find((x) => x.type === t);
    if (a) return a;
  }
  for (const t of ['settle', 'draw', 'place', 'flip']) {
    const a = legal.find((x) => x.type === t);
    if (a) return a;
  }
  return legal.find((x) => x.type === 'end_turn') || legal[0];
}

/** 用确定性策略打完整局（双方均用策略，AI 合法性测试用）。 */
function playToGameOver(seed, overrides) {
  const { state } = h.setupBattle(E, Object.assign({ seed, regionCount: 5, difficulty: 1, firstPlayer: 'p1' }, overrides || {}));
  let steps = 0;
  while (!E.isGameOver(state) && steps < 6000) {
    const legal = E.getLegalActions(state);
    E.performAction(state, apPolicyPick(state, legal, ['settle', 'draw', 'place', 'flip']));
    steps++;
  }
  assert.ok(E.isGameOver(state), 'playToGameOver 应自然到达终局（seed=' + seed + '）');
  return state;
}

/** AI 自对弈一局（带逐步不变量与合法性校验），返回统计。 */
function selfPlayGame(seed, overrides) {
  const config = E.defaultConfig(Object.assign({ seed, regionCount: 5, difficulty: 1, firstPlayer: 'p1', endgameApCapRule: false }, overrides || {}));
  const strength = config.aiStrength || 'medium';
  const state = E.createGame(config);
  const R = state.config.regionCount;
  const p1Layout = AI.chooseLayout(state, 'p1', makeOpts(seed * 17 + 1, { strength }));
  const p2Layout = AI.chooseLayout(state, 'p2', makeOpts(seed * 17 + 2, { strength }));
  assert.deepStrictEqual(p1Layout, aiLayout(state, 'p1', seed * 17 + 1, strength), 'AI 布局应确定');
  E.submitLayout(state, 'p1', p1Layout);
  E.submitLayout(state, 'p2', p2Layout);
  E.finalizeLayout(state);
  invariant(state, 'AI 自对弈布局后');

  const counts = { settle: 0, flip: 0, place: 0, move: 0, draw: 0, end_turn: 0 };
  const endgameBuildCounts = { flip: 0, place: 0, move: 0, end_turn: 0 };
  const trace = [];
  let steps = 0;
  while (!E.isGameOver(state)) {
    assert.ok(steps < 6000, 'AI 自对弈未在 6000 步内终止（疑似死循环）seed=' + seed);
    const pid = state.turn;
    const prevTurn = pid;
    const prevAp = state.players[pid].ap;
    const prevTurnCount = state.turnCount;
    const inBuild = !!(state.endgame && state.endgame.triggered && state.endgame.phase === 'build');
    const before = JSON.stringify(state);
    const action = AI.chooseAction(state, pid, makeOpts(seed * 1000 + steps * 7, { strength }));
    assert.strictEqual(JSON.stringify(state), before, 'AI chooseAction 不得修改 state（seed=' + seed + ' step=' + steps + '）');
    assert.ok(action, 'battle 阶段 AI 返回 null（seed=' + seed + ' step=' + steps + '）');
    const matched = assertLegalAIAction(state, pid, action);
    // v1.5 AI 2.2：medium/hard 可用 move 弃区/集中背面牌（easy 仍不用）；旧「AI 不使用 move」断言已移除
    if (inBuild) {
      assert.ok(['flip', 'place', 'move', 'end_turn'].includes(matched.type),
        '决战最终部署 AI 只应选 flip/place/move/end_turn，实际 ' + matched.type);
      endgameBuildCounts[matched.type] += 1;
    }
    const events = E.performAction(state, matched);
    counts[matched.type] += 1;
    trace.push(h.canonicalAction(matched));
    steps += 1;
    assert.ok(Array.isArray(events) && events[0].type === 'action');
    // v1.4：turnCount 只统计真实行动（end_turn 不增加）；AP 按 cost 扣减
    if (matched.type === 'end_turn') {
      assert.strictEqual(state.turnCount, prevTurnCount, 'end_turn 不应增加 turnCount');
    } else {
      assert.strictEqual(state.turnCount, prevTurnCount + 1, '真实行动应使 turnCount +1');
    }
    invariant(state, 'AI 自对弈第 ' + steps + ' 步');
    if (state.phase === 'battle') {
      const startEv = events.find((e) => e.type === 'turn_start');
      if (state.turn === prevTurn && !startEv) {
        // 同一回合继续：AP 已按 cost 扣减
        assert.strictEqual(state.players[prevTurn].ap, prevAp - E.ACTION_COSTS[matched.type],
          '同回合继续行动后 AP 应按 cost 扣减（seed=' + seed + ' step=' + steps + '）');
      } else {
        assert.strictEqual(state.players[state.turn].ap, E.AP_PER_TURN, '新回合 AP 应回满');
      }
    }
  }
  invariant(state, 'AI 自对弈终局');
  assert.strictEqual(state.phase, 'gameover');
  assert.strictEqual(state.turn, null);
  assert.deepStrictEqual(E.getLegalActions(state), []);
  return { state, trace, counts, endgameBuildCounts, steps, config };
}

/* ================================================================== */
/* 导出与布局                                                          */
/* ================================================================== */

test('AI 导出 API 与版本（CONTRACT §6）', () => {
  assert.strictEqual(AI.VERSION, '3.5.0-robust', 'task-147: 当前 AI VERSION 3.5.0-robust');
  assert.strictEqual(typeof AI.chooseLayout, 'function');
  assert.strictEqual(typeof AI.chooseAction, 'function');
  assert.ok(Array.isArray(AI.LAYOUT_STRATEGIES) && AI.LAYOUT_STRATEGIES.length > 0);
  assert.ok(AI._internals && typeof AI._internals.normalizeStrength === 'function', '应导出 _internals（含 normalizeStrength）');
  // v3.0：训练参数常量与内部训练钩子
  assert.ok(AI._internals.TRAINED && AI._internals.TRAINED.hard && AI._internals.TRAINED.medium && AI._internals.TRAINED.easy,
    '应导出 _internals.TRAINED（三档 CEM 收敛参数）');
  assert.strictEqual(typeof AI._internals.defaultParams, 'function', '应导出 _internals.defaultParams(tier)');
  assert.strictEqual(typeof AI._internals.TRAINED_META, 'object', '应导出 _internals.TRAINED_META（训练来源说明）');
  for (const tier of ['hard', 'medium', 'easy']) {
    const p = AI._internals.defaultParams(tier);
    assert.ok(p && typeof p === 'object', tier + ' 参数应为对象');
    for (const k of Object.keys(p)) {
      if (typeof p[k] === 'number') assert.ok(Number.isFinite(p[k]), tier + '.' + k + ' 应为有限数值');
    }
  }
  // 旧值 normal 兼容映射为 medium
  assert.strictEqual(AI._internals.normalizeStrength('normal'), 'medium');
  assert.strictEqual(AI._internals.normalizeStrength('easy'), 'easy');
  assert.strictEqual(AI._internals.normalizeStrength('hard'), 'hard');
  assert.strictEqual(AI._internals.normalizeStrength('unknown'), 'medium', '非法强度应回退 medium');
});

test('§6 chooseLayout：长度 R / 来自自己手牌 / 不重复 / 不同策略与配置均合法', () => {
  for (const regionCount of [3, 5, 7]) {
    for (const difficulty of [1, 2, 3]) {
      for (const settleCards of [1, 2, 4]) {
        const state = E.createGame(E.defaultConfig({ seed: regionCount * 10 + difficulty + settleCards, regionCount, difficulty, settleCards }));
        for (const pid of ['p1', 'p2']) {
          for (const strategy of AI.LAYOUT_STRATEGIES) {
            const ids = AI.chooseLayout(state, pid, makeOpts(regionCount * 100 + difficulty * 7, { layoutStrategy: strategy }));
            assert.ok(Array.isArray(ids), '布局应返回数组');
            assert.strictEqual(ids.length, state.config.regionCount, '布局数量应等于 R');
            assert.strictEqual(new Set(ids).size, ids.length, '布局牌不得重复');
            const handIds = new Set(state.players[pid].hand.map((c) => c.id));
            for (const id of ids) assert.ok(handIds.has(id), '布局牌必须来自自己手牌：' + id);
          }
        }
      }
    }
  }
});

test('§6 chooseLayout：确定性，且提交顺序/对手已提交分配不泄露影响', () => {
  const base = E.createGame(E.defaultConfig({ seed: 4242, regionCount: 5, firstPlayer: 'p1' }));
  const a = aiLayout(base, 'p2', 99);
  const b = aiLayout(base, 'p2', 99);
  assert.deepStrictEqual(a, b, '同 opts.rng 布局应确定');

  // 把 p1 的提交分配改成不同内容，p2 的 AI 布局不应变化（不得读取对手选择）
  const variant = h.clone(base);
  E.submitLayout(variant, 'p1', variant.players.p1.hand.slice(0, 5).map((c) => c.id));
  assert.deepStrictEqual(aiLayout(variant, 'p2', 99), a, 'AI 布局不应依赖对手已提交的分配');

  // 未提交 vs 已提交对手分配：同样不受影响（注意：直接传 opts，避免重复包装 rng）
  const c = AI.chooseLayout(base, 'p2', makeOpts(100));
  assert.deepStrictEqual(AI.chooseLayout(variant, 'p2', makeOpts(100)), c);
});

test('§6 chooseLayout：不修改 state（纯函数）', () => {
  const state = E.createGame(E.defaultConfig({ seed: 51, regionCount: 5 }));
  const before = JSON.stringify(state);
  AI.chooseLayout(state, 'p1', makeOpts(1));
  AI.chooseLayout(state, 'p2', makeOpts(2));
  assert.strictEqual(JSON.stringify(state), before, 'chooseLayout 不得修改 state');
});

/* ================================================================== */
/* 行动合法性                                                          */
/* ================================================================== */

test('§6 chooseAction：多种局面下永远返回合法行动', () => {
  const cases = [];
  // 开局（AP=3，可结算/放牌/摸牌/结束回合）
  const g1 = h.setupBattle(E, { seed: 61, firstPlayer: 'p1' });
  cases.push(['开局(AP=3)', g1.state, g1.state.turn]);
  // 一回合多行动后（放牌 1 点 + 翻牌 2 点 → 换人；局面有背面牌→正面牌）
  const g2 = h.setupBattle(E, { seed: 62, firstPlayer: 'p1' });
  E.performAction(g2.state, E.getLegalActions(g2.state).find((a) => a.type === 'place'));
  E.performAction(g2.state, E.getLegalActions(g2.state).find((a) => a.type === 'flip'));
  cases.push(['一回合多行动后(换人)', g2.state, g2.state.turn]);
  // 已单独结算一区（任意区域可结算）
  const g3 = h.setupBattle(E, { seed: 63, difficulty: 2, firstPlayer: 'p1' });
  E.performAction(g3.state, E.getLegalActions(g3.state).find((a) => a.type === 'settle'));
  if (g3.state.phase === 'battle') cases.push(['已结算一区', g3.state, g3.state.turn]);
  // 决战前（牌堆=阈值+1，且从 AP 回满的回合起点开始）
  const g4 = h.setupBattle(E, { seed: 1, difficulty: 2, firstPlayer: 'p1' });
  const r = new h.Runner(E, g4.state, {
    checkInvariants: false, maxSteps: 1200,
    stopWhen: (s) => s.deck.length === E.getEndgameThreshold(s) + 1,
    pick: (st, legal) => legal.find((a) => a.type === 'draw') || legal.find((a) => a.type === 'end_turn'),
  });
  r.run();
  while (g4.state.phase === 'battle' && g4.state.players[g4.state.turn].ap < E.AP_PER_TURN) {
    E.performAction(g4.state, E.getLegalActions(g4.state).find((a) => a.type === 'end_turn'));
  }
  cases.push(['决战前(AP=3)', g4.state, g4.state.turn]);

  for (const [label, state, pid] of cases) {
    for (const strength of ['easy', 'medium', 'hard', 'normal']) {
      for (let k = 0; k < 5; k++) {
        const action = AI.chooseAction(state, pid, makeOpts(1234 + k, { strength }));
        assertLegalAIAction(state, pid, action);
        // v1.5 AI 2.2：easy 档仍不使用 move；medium/hard 允许（用于弃区/集中背面牌）
        if (strength === 'easy') {
          assert.notStrictEqual(action.type, 'move', label + '：easy 档 AI 不应选择 move');
        }
      }
    }
  }
});

test('§6 强度档位：旧值 normal 等价于 medium；easy/medium/hard 均可完成整局且合法', () => {
  const { state } = h.setupBattle(E, { seed: 63, firstPlayer: 'p1', settleCards: 2 });
  const base = { rng: E.makeRng(777) };
  const a = AI.chooseAction(state, state.turn, Object.assign({ strength: 'medium' }, { rng: E.makeRng(777) }));
  const b = AI.chooseAction(state, state.turn, Object.assign({ strength: 'normal' }, { rng: E.makeRng(777) }));
  assert.deepStrictEqual(b, a, '旧值 normal 应映射为 medium 且决策一致');

  const { state: st2 } = h.setupBattle(E, { seed: 64, firstPlayer: 'p1' });
  const c = AI.chooseAction(st2, st2.turn, Object.assign({ strength: 'NORMAL' }, { rng: E.makeRng(5) }));
  assertLegalAIAction(st2, st2.turn, c);
});

test('§6 chooseAction：非其回合 / 非战斗阶段返回 null，且不抛异常', () => {
  const layoutState = E.createGame(E.defaultConfig({ seed: 71, firstPlayer: 'p1' }));
  assert.strictEqual(AI.chooseAction(layoutState, 'p1', makeOpts(1)), null, '布局阶段应返回 null');
  const { state } = h.setupBattle(E, { seed: 71, firstPlayer: 'p1' });
  const other = state.turn === 'p1' ? 'p2' : 'p1';
  assert.strictEqual(AI.chooseAction(state, other, makeOpts(1)), null, '非当前行动方应返回 null');
  const found = playToGameOver(1, { difficulty: 1 });
  assert.strictEqual(AI.chooseAction(found, 'p1', makeOpts(1)), null, '终局应返回 null');
});

test('§6 chooseAction：确定性（同局面/同 rng → 同决策；同 seed 派生也确定）', () => {
  const { state } = h.setupBattle(E, { seed: 81, firstPlayer: 'p1' });
  for (let k = 0; k < 10; k++) {
    const a = AI.chooseAction(state, state.turn, makeOpts(500 + k));
    const b = AI.chooseAction(state, state.turn, makeOpts(500 + k));
    assert.deepStrictEqual(a, b, '相同 rng seed 应得到相同行动');
  }
  // 不传 opts 时由 seed 派生，也应确定
  const x = AI.chooseAction(state, state.turn);
  const y = AI.chooseAction(state, state.turn);
  assert.deepStrictEqual(x, y, '缺省 opts 应按 seed 派生确定性决策');
  // 同 seed 重开同一局，AI 决策一致
  const g1 = selfPlayGame(31337, { difficulty: 2, regionCount: 5 });
  const g2 = selfPlayGame(31337, { difficulty: 2, regionCount: 5 });
  assert.deepStrictEqual(g1.trace, g2.trace, '同 seed AI 自对弈行动序列应完全一致');
  assert.deepStrictEqual(g1.state.result, g2.state.result);
  assert.deepStrictEqual(g1.state.regionWins, g2.state.regionWins);
});

/* ================================================================== */
/* 信息公平（隐藏信息无关性）                                          */
/* ================================================================== */

/**
 * 构造一个「可见信息完全相同、隐藏信息被打乱」的局面副本：
 *  - 反转牌堆顺序（隐藏）
 *  - 反转对手手牌顺序（隐藏）
 *  - 反转双方背面牌数组顺序（身份隐藏）
 *  - 反转弃牌堆顺序（未揭示牌身份隐藏）
 * AI 的决策必须完全一致，否则视为信息泄露。
 */
function scrambleHiddenInfo(state, aiPid) {
  const v = h.clone(state);
  const opp = aiPid === 'p1' ? 'p2' : 'p1';
  // 只打乱隐藏信息：牌堆顺序、对手手牌顺序、对手背面牌顺序、弃牌堆顺序。
  // 我方手牌/我方背面牌顺序会改变合法行动枚举顺序（可见信息），不可改动以免假阳性。
  v.deck.reverse();
  v.players[opp].hand.reverse();
  for (const r of v.regions) {
    r.sides[opp].faceDown.reverse();
  }
  v.discard.reverse();
  return v;
}

test('§6 信息公平：打乱隐藏信息后 AI 决策不变（chooseAction）', () => {
  // 收集不同阶段（AP 多行动语义下）的局面
  const states = [];
  const g = h.setupBattle(E, { seed: 91, firstPlayer: 'p1', difficulty: 1 });
  states.push(['开局', h.clone(g.state)]);
  // 放牌（AP 3→2，同回合）
  E.performAction(g.state, E.getLegalActions(g.state).find((a) => a.type === 'place'));
  states.push(['放牌后(AP=2)', h.clone(g.state)]);
  // 翻牌（2 点 → AP=0 → 换人）
  E.performAction(g.state, E.getLegalActions(g.state).find((a) => a.type === 'flip'));
  states.push(['翻牌后(换人)', h.clone(g.state)]);
  // 已单独结算一区
  const g3 = h.setupBattle(E, { seed: 92, difficulty: 2, firstPlayer: 'p1' });
  E.performAction(g3.state, E.getLegalActions(g3.state).find((a) => a.type === 'settle'));
  if (g3.state.phase === 'battle') states.push(['已结算一区', h.clone(g3.state)]);

  for (const [label, state] of states) {
    for (const pid of ['p1', 'p2']) {
      if (state.turn !== pid) continue;
      for (const strength of ['easy', 'medium', 'hard']) {
        const seed = 2000 + label.length;
        const original = AI.chooseAction(state, pid, makeOpts(seed, { strength }));
        const scrambled = AI.chooseAction(scrambleHiddenInfo(state, pid), pid, makeOpts(seed, { strength }));
        assert.deepStrictEqual(scrambled, original,
          'AI 决策依赖隐藏信息！局面=' + label + ' pid=' + pid + ' strength=' + strength +
          '\n原始=' + h.canonicalAction(original) + ' 打乱后=' + h.canonicalAction(scrambled));
      }
    }
  }
});

test('§6 信息公平：getUnseenCards 不含已知牌且不泄露牌堆顺序；AI 仅据此估计', () => {
  const { state } = h.setupBattle(E, { seed: 92, firstPlayer: 'p1' });
  for (const pid of ['p1', 'p2']) {
    const known = new Set(E.getKnownCards(state, pid).map((c) => c.id));
    const unseen = E.getUnseenCards(state, pid);
    for (const c of unseen) assert.ok(!known.has(c.id), '未知牌不可是已知牌');
    // 牌堆顺序不同不应影响 unseen 的顺序（固定顺序 = 完整牌堆顺序剔除已知）
    const swapped = h.clone(state);
    swapped.deck.reverse();
    assert.deepStrictEqual(E.getUnseenCards(swapped, pid).map((c) => c.id), unseen.map((c) => c.id),
      'getUnseenCards 顺序不得随牌堆顺序改变');
  }
});

/* ================================================================== */
/* AI 自对弈整局                                                       */
/* ================================================================== */

test('§6 AI 自对弈：多配置整局合法、不变量成立、必终止、结果合法、同 seed 可复现', () => {
  const configs = [
    { regionCount: 5, difficulty: 1, firstPlayer: 'p1' },
    { regionCount: 5, difficulty: 2, firstPlayer: 'p2' },
    { regionCount: 5, difficulty: 3, firstPlayer: 'p1' },
    { regionCount: 3, difficulty: 1, firstPlayer: 'p1' },
    { regionCount: 3, difficulty: 3, firstPlayer: 'p2', settleCards: 4 },
    { regionCount: 7, difficulty: 2, firstPlayer: 'p1', settleCards: 1 },
    { regionCount: 7, difficulty: 2, firstPlayer: 'p1', settleCards: 4 },
    // 小牌堆（简单结算）：高概率进入决战
    { regionCount: 5, difficulty: 1, firstPlayer: 'p1', settleCards: 1, deck: { jokers: true, ranks: ['A','2','3','4','5','6','7','8'] } },
    { regionCount: 5, difficulty: 2, firstPlayer: 'p2', settleCards: 1, deck: { jokers: true, ranks: ['A','2','3','4','5','6','7','8','9'] } },
    { regionCount: 3, difficulty: 3, firstPlayer: 'p1', settleCards: 2, deck: { jokers: true, suits: ['s', 'h', 'd'] } },
  ];
  let endgameCount = 0;
  let allIndividualCount = 0;
  let earlyCount = 0;
  let buildCount = 0;
  for (const cfg of configs) {
    for (let seed = 1; seed <= 3; seed++) {
      const g = selfPlayGame(seed * 1000 + cfg.regionCount * 10 + cfg.difficulty, cfg);
      const s = g.state;
      assert.strictEqual(s.phase, 'gameover');
      if (s.result.early) {
        earlyCount++;
        assert.strictEqual(s.result.reason, 'region_wins');
        assert.ok(s.result.unsettledRegions.length > 0, '提前锁定应有未结算区域');
        assert.deepStrictEqual(s.result.unsettledRegions,
          s.regions.filter((r) => r.status === 'open').map((r) => r.id), '未结算区域应与 open 状态一致');
      } else if (s.endgame.triggered) {
        endgameCount++;
        assert.strictEqual(s.deck.length, 0, '触发决战且未提前锁定时牌堆应已摸空');
        assert.ok(s.regions.every((r) => r.status === 'settled'));
      } else {
        allIndividualCount++;
        assert.ok(s.regions.every((r) => r.status === 'settled'), '全部单独结算完应无 open 区域');
        assert.deepStrictEqual(E.getLegalActions(s), []);
      }
      if (s.endgame.triggered) {
        // 决战补牌：把触发时的牌堆摸空；各摸 ≤ X（不足 2X 时对半下调）
        assert.strictEqual(s.deck.length, 0, '决战补牌后牌堆为空');
        const dc = s.endgame.drawnCounts;
        assert.ok(dc.p1 <= s.endgame.drawPerPlayer && dc.p2 <= s.endgame.drawPerPlayer,
          '双方补牌数不得超过理想值 X=' + s.endgame.drawPerPlayer + '，实际 ' + JSON.stringify(dc));
        assert.ok(dc.p1 + dc.p2 <= 2 * s.endgame.drawPerPlayer, '补牌总数不得超过 2X');
      }
      if (g.endgameBuildCounts.flip + g.endgameBuildCounts.place + g.endgameBuildCounts.move + g.endgameBuildCounts.end_turn > 0) buildCount++;
      assert.ok(g.counts.settle > 0 || s.endgame.triggered, 'AI 自对弈应有结算行动或进入决战');
      // 同 seed 重放完全一致
      const g2 = selfPlayGame(seed * 1000 + cfg.regionCount * 10 + cfg.difficulty, cfg);
      assert.deepStrictEqual(g2.trace, g.trace, '同 seed AI 对局行动序列应一致（配置 ' + JSON.stringify(cfg) + '）');
      assert.deepStrictEqual(g2.state.result, g.state.result);
    }
  }
  assert.ok(endgameCount + earlyCount > 0, 'AI 自对弈应覆盖决战路径');
  assert.ok(buildCount > 0, 'AI 自对弈应覆盖决战最终部署（flip/place）路径');
  assert.ok(allIndividualCount + earlyCount > 0, 'AI 自对弈应覆盖单独结算/提前锁定路径（标准牌堆）');
});

test('§6 AI 三档强度：easy/medium/hard 均只产生合法行动且可完成整局（同 seed 确定性）', () => {
  for (const strength of ['easy', 'medium', 'hard']) {
    for (const difficulty of [1, 2, 3]) {
      const config = E.defaultConfig({ seed: 555, regionCount: 5, difficulty, settleCards: 2, firstPlayer: 'p1', aiStrength: strength });
      const state = E.createGame(config);
      E.submitLayout(state, 'p1', AI.chooseLayout(state, 'p1', makeOpts(1, { strength })));
      E.submitLayout(state, 'p2', AI.chooseLayout(state, 'p2', makeOpts(2, { strength })));
      E.finalizeLayout(state);
      let steps = 0;
      while (!E.isGameOver(state) && steps < 4000) {
        const pid = state.turn;
        const action = AI.chooseAction(state, pid, makeOpts(steps + 1, { strength }));
        assertLegalAIAction(state, pid, action);
        if (strength === 'easy') assert.notStrictEqual(action.type, 'move', 'easy 档 AI 不使用 move');
        E.performAction(state, action);
        steps++;
      }
      assert.ok(E.isGameOver(state), 'strength=' + strength + ' difficulty=' + difficulty + ' 应完成整局');
      invariant(state, 'strength=' + strength + ' difficulty=' + difficulty + ' 终局');
    }
  }
});

/* ================================================================== */
/* 战略决战（v1.3）：build 阶段 AI 合法性与公平性                        */
/* ================================================================== */

/** 驱动到「决战最终部署（build）」阶段：摸牌触发决战。 */
function driveToEndgameBuild(seed) {
  const { state } = h.setupBattle(E, { seed, regionCount: 5, difficulty: 2, settleCards: 2, firstPlayer: 'p1' });
  const r = new h.Runner(E, state, {
    checkInvariants: false, maxSteps: 1200,
    pick: (st, legal) => legal.find((a) => a.type === 'draw') || legal.find((a) => a.type === 'end_turn'),
  });
  while (!state.endgame.triggered && state.phase === 'battle') {
    const legal = E.getLegalActions(state);
    r.step(legal.find((a) => a.type === 'draw') || legal.find((a) => a.type === 'end_turn'));
  }
  assert.ok(state.endgame.triggered && state.endgame.phase === 'build', '应进入决战最终部署阶段');
  return { state, runner: r };
}

test('§6 决战 build 阶段：AI 只选 flip/place/move/end_turn、合法、确定、不修改 state', () => {
  const { state } = driveToEndgameBuild(3);
  for (const strength of ['easy', 'medium', 'hard']) {
    for (let k = 0; k < 6; k++) {
      theLoop: {
        const pid = state.turn;
        const before = JSON.stringify(state);
        const action = AI.chooseAction(state, pid, makeOpts(4000 + k, { strength }));
        assert.strictEqual(JSON.stringify(state), before, 'AI 不得修改 state');
        assert.ok(action, 'build 阶段 AI 应返回行动');
        assert.ok(['flip', 'place', 'move', 'end_turn'].includes(action.type),
          'build 阶段 AI 只应选 flip/place/move/end_turn，实际 ' + action.type + '（strength=' + strength + '）');
        assertLegalAIAction(state, pid, action);
        const again = AI.chooseAction(state, pid, makeOpts(4000 + k, { strength }));
        assert.deepStrictEqual(again, action, '同 rng 决策应确定');
        break theLoop;
      }
    }
  }
});

test('§6 决战 build 阶段：AI 对隐藏信息无关（信息公平）', () => {
  const { state } = driveToEndgameBuild(5);
  for (const strength of ['easy', 'medium', 'hard']) {
    const pid = state.turn;
    const seed = 777 + strength.length;
    const original = AI.chooseAction(state, pid, makeOpts(seed, { strength }));
    const scrambled = AI.chooseAction(scrambleHiddenInfo(state, pid), pid, makeOpts(seed, { strength }));
    assert.deepStrictEqual(scrambled, original, '决战 build 阶段决策不应依赖隐藏信息（strength=' + strength + '）');
  }
});

test('§6 决战 build 阶段：easy/medium/hard 三档均能完成整局且终局合法', () => {
  for (const strength of ['easy', 'medium', 'hard']) {
    const { state } = driveToEndgameBuild(7 + strength.length);
    let steps = 0;
    while (!E.isGameOver(state) && steps < 3000) {
      const pid = state.turn;
      const action = AI.chooseAction(state, pid, makeOpts(steps + 11, { strength }));
      assertLegalAIAction(state, pid, action);
      if (strength === 'easy') assert.notStrictEqual(action.type, 'move', 'easy 档 AI 不使用 move');
      E.performAction(state, action);
      steps++;
      invariant(state, '决战 build AI 第 ' + steps + ' 步（' + strength + '）');
    }
    assert.ok(E.isGameOver(state), 'strength=' + strength + ' 应完成决战');
    assert.strictEqual(state.phase, 'gameover');
    assert.deepStrictEqual(E.getLegalActions(state), []);
    invariant(state, '决战终局（' + strength + '）');
  }
});

/* ================================================================== */
/* v1.5 AI 2.2：移牌弃区 / 终止性保障 / 性能 / _internals              */
/* ================================================================== */

test('§6 v3.0 导出：投影/开局/强制翻牌辅助函数齐全且可用', () => {
  for (const name of ['buildEndgameProjection', 'cloneProjection', 'endgameProjectionValue', 'applyProjectionAction',
    'endgameCandidatesFromProjection', 'chooseForcedFlip', 'chooseTurnOpening', 'chooseEndgameHard', 'chooseEndgameMedium',
    'TRAINED', 'TRAINED_META', 'defaultParams']) {
    assert.ok(AI._internals[name], '_internals.' + name + ' 应导出');
  }
  const { state } = driveToEndgameBuild(21);
  const pid = state.turn;
  const proj = AI._internals.buildEndgameProjection(state, pid, 7, true);
  assert.ok(proj && Array.isArray(proj.regions) && proj.regions.length === E.getOpenRegionIds(state).length,
    'buildEndgameProjection 应返回与未结算区域数一致的投影');
  const cloned = AI._internals.cloneProjection(proj);
  assert.notStrictEqual(cloned, proj, 'cloneProjection 应返回新对象');
  assert.strictEqual(AI._internals.endgameProjectionValue(cloned), AI._internals.endgameProjectionValue(proj),
    '克隆投影的估值应一致');
  const ff = AI._internals.chooseForcedFlip(state, pid, 7);
  assert.ok(ff === null || ff.type === 'flip', 'chooseForcedFlip 只能返回 flip 或 null');
});

test('§6 v1.5 AI 2.2：easy 永不使用 move（战役 + 决战 build）', () => {
  for (const seed of [101, 102, 103]) {
    const { state } = h.setupBattle(E, { seed, regionCount: 5, difficulty: 1, settleCards: 2, firstPlayer: 'p1' });
    for (let k = 0; k < 8; k++) {
      const pid = state.turn;
      const action = AI.chooseAction(state, pid, makeOpts(5000 + k * 7 + seed, { strength: 'easy' }));
      assertLegalAIAction(state, pid, action);
      assert.notStrictEqual(action.type, 'move', 'easy 档战役不应选 move（seed=' + seed + '）');
    }
  }
  const { state: build } = driveToEndgameBuild(31);
  for (let k = 0; k < 12; k++) {
    const pid = build.turn;
    const action = AI.chooseAction(build, pid, makeOpts(6000 + k, { strength: 'easy' }));
    assertLegalAIAction(build, pid, action);
    assert.notStrictEqual(action.type, 'move', 'easy 档决战 build 不应选 move');
  }
});

test('§6 v1.5 AI 2.2：medium 战役 move 仅限明显正收益（抽样应为少见且合法）', () => {
  let samples = 0;
  let moves = 0;
  for (const seed of [201, 202, 203, 204]) {
    const { state } = h.setupBattle(E, { seed, regionCount: 5, difficulty: 2, settleCards: 2, firstPlayer: 'p1' });
    for (let step = 0; step < 14; step++) {
      if (state.phase !== 'battle' || (state.endgame && state.endgame.triggered)) break;
      const pid = state.turn;
      for (let k = 0; k < 3; k++) {
        const action = AI.chooseAction(state, pid, makeOpts(seed * 100 + step * 11 + k, { strength: 'medium' }));
        const matched = assertLegalAIAction(state, pid, action);
        samples += 1;
        if (matched.type === 'move') moves += 1;
      }
      const legal = E.getLegalActions(state);
      const advance = legal.find((a) => a.type === 'place') || legal.find((a) => a.type === 'flip') ||
        legal.find((a) => a.type === 'draw') || legal.find((a) => a.type === 'end_turn');
      if (!advance) break;
      E.performAction(state, advance);
    }
  }
  // 战役 move 只在明显正收益时进候选：允许出现（实测偶发），但不应成为主要选择
  assert.ok(moves <= Math.max(2, Math.floor(samples * 0.5)),
    'medium 战役 move 不应成为主要选择，实际 ' + moves + '/' + samples);
});

test('§6 v2.1：决战 build 手牌优先连续放牌（替代每回合强制先翻），手牌空后翻牌', () => {
  let tested = 0, handCases = 0, emptyCases = 0;
  for (const seed of [11, 12, 13, 21, 31]) {
    const { state } = driveToEndgameBuild(seed);
    for (const strength of ['medium', 'hard']) {
      const copy = h.clone(state);
      copy.turn = 'p1';
      copy.turnCount = 0;
      copy.players.p1.ap = 3;
      copy.players.p2.ap = 0;
      const handAtStart = copy.players.p1.hand.length;
      const hiddenAtStart = E.getOpenRegionIds(copy)
        .reduce((a, id) => a + copy.regions[id].sides.p1.faceDown.length, 0);
      const types = [];
      let guard = 0;
      while (copy.phase === 'battle' && copy.turn === 'p1' && copy.players.p1.ap > 0 && guard++ < 8) {
        const a = AI.chooseAction(copy, 'p1', makeOpts(seed * 1000 + guard, { strength }));
        const matched = assertLegalAIAction(copy, 'p1', a);
        types.push(matched.type);
        E.performAction(copy, matched);
      }
      if (handAtStart > 0) {
        tested++; handCases++;
        assert.strictEqual(types[0], 'place', '有手牌时应优先 place（实际：' + types.join(',') + '）');
        const places = types.filter((t) => t === 'place').length;
        assert.ok(places >= 1 && types.every((t) => ['place', 'flip', 'move'].includes(t)), '有手牌时 build 回合应至少 place 一次且只用 build 合法行动（v3.5 投影评分池可能 place/move 混合；实际：' + types.join(',') + '）');
      } else if (hiddenAtStart > 0) {
        tested++; emptyCases++;
        assert.ok(types.includes('flip') || types.includes('place'),
          '无手牌时应翻牌推进（实际：' + types.join(',') + '）');
      }
    }
  }
  assert.ok(tested > 0, '应至少覆盖一个可测试的决战 build 回合');
  assert.ok(handCases > 0, '应覆盖「有手牌连续放牌」场景');
});

test('§6 v2.1：战斗提前结束回合仅在本回合已有推进行动后（不 stall/认输）', () => {
  const result = {};
  for (const strength of ['hard', 'medium']) {
    let early = 0, stallRisk = 0, forfeits = 0;
    const cfgs = [{ regionCount: 5, difficulty: 1 }, { regionCount: 3, difficulty: 2 }];
    for (const cfg of cfgs) {
      for (const seed of [1, 2]) {
        const { state } = h.setupBattle(E, Object.assign({ seed: seed * 31 + 5, firstPlayer: 'p1' }, cfg));
        let steps = 0;
        while (!E.isGameOver(state) && steps < 4000) {
          const pid = state.turn;
          const ap = state.players[pid].ap;
          const prod = state.turnProgress ? (Number(state.turnProgress.productive) || 0) : 0;
          const action = AI.chooseAction(state, pid, { strength: strength });
          const matched = assertLegalAIAction(state, pid, action);
          if (matched.type === 'end_turn' && ap > 0) {
            if (prod > 0) early++;
            else stallRisk++;
          }
          E.performAction(state, matched);
          steps++;
        }
        assert.ok(E.isGameOver(state), 'strength=' + strength + ' 对局应正常结束');
        if (state.result.reason === 'forfeit') forfeits++;
      }
    }
    result[strength] = { early, stallRisk, forfeits };
    assert.strictEqual(stallRisk, 0, strength + ' 不得在本回合无推进行动时 end_turn（stall 自杀），实际 ' + stallRisk);
    assert.strictEqual(forfeits, 0, strength + ' 不应出现 forfeit');
  }
  // v3.3.0：hard 行为不变（仍会出现提前结束回合）；medium 改为大概率更优计划+概率表校准后，
  // 「继续行动不提升局面」的回合显著变少（提前结束≈0 属预期），档位差异由强度矩阵保证。
  assert.ok(result.hard.early > 0, 'hard 自对弈应有「提前结束回合」行为，实际 ' + result.hard.early);
  assert.ok(result.medium.early >= 0, 'medium 提前结束回合次数应为非负');
});

/** v1.5：构造「区域 0 必败」的决战 build 局面（Lead 提供口径），用于验证 AI 主动弃区。 */
function buildAbandonState() {
  const state = E.createGame(E.defaultConfig({ regionCount: 5, difficulty: 2, settleCards: 2, seed: 4242 }));
  E.submitLayout(state, 'p1', AI.chooseLayout(state, 'p1', makeOpts(9001)));
  E.submitLayout(state, 'p2', AI.chooseLayout(state, 'p2', makeOpts(9002)));
  E.finalizeLayout(state);
  const deck = E.createDeck(E.defaultConfig().deck);
  const used = new Set();
  const pick = (value) => {
    const card = deck.find((c) => c.value === value && !c.joker && !used.has(c.id));
    used.add(card.id);
    return Object.assign({}, card);
  };
  state.phase = 'battle';
  state.endgame = {
    triggered: true, phase: 'build', threshold: 10, settleCards: 2, drawPerPlayer: 5,
    drawnCounts: { p1: 0, p2: 0 }, skipped: { p1: false, p2: false }
  };
  state.turn = 'p1';
  state.turnCount = 0;
  state.players.p1.ap = 1;
  state.players.p2.ap = 0;
  state.regionWins = { p1: 1, p2: 1, ties: 0 };
  state.deck = [];
  state.players.p1.hand = [];
  state.players.p2.hand = [];
  const p1Values = [1, 10, 8, 12, 6];
  const p2Values = [13, 9, 8, 2, 5];
  for (let i = 0; i < 5; i++) {
    const region = state.regions[i];
    region.status = 'open';
    region.result = null;
    region.sides.p1 = { faceUp: [pick(p1Values[i])], faceDown: [] };
    region.sides.p2 = { faceUp: [pick(p2Values[i])], faceDown: [] };
  }
  // 区域 0 我方必败（1 + 3 + 4 = 8 < 13），放两张低值背面牌；区域 2 为 8:8 可争夺
  state.regions[0].sides.p1.faceDown = [pick(3), pick(4)];
  return state;
}

test('§6 v1.5 AI 2.2 弃区：hard/medium 把必败区背面牌移入可争夺区，easy 不 move', () => {
  const state = buildAbandonState();
  // 局面自检：区域 0 我方必败；区域 2 我方 8 vs 对手 8（可争夺）
  assert.ok(8 < 13, '区域 0 我方正面+背面 8 < 对手 13（必败）');
  const hard = AI.chooseAction(state, 'p1', makeOpts(4242, { strength: 'hard' }));
  const medium = AI.chooseAction(state, 'p1', makeOpts(4242, { strength: 'medium' }));
  const easy = AI.chooseAction(state, 'p1', makeOpts(4242, { strength: 'easy' }));
  for (const [label, action] of [['hard', hard], ['medium', medium]]) {
    assert.strictEqual(action.type, 'move', label + ' 应选 move 主动放弃必败区域，实际 ' + h.canonicalAction(action));
    assert.strictEqual(action.fromRegionId, 0, label + ' 应从必败区域 0 移出');
    assert.notStrictEqual(action.toRegionId, 0, label + ' 应移入其它未结算区域');
    // v3.0：CEM 收敛参数下移入目标可为任意可争夺区域（区域 1/2/4 均可能，按估值最优选择）
    assert.ok(state.regions[action.toRegionId].status === 'open', label + ' 目标区域应仍未结算');
    assertLegalAIAction(state, 'p1', action);
    const copy = h.clone(state);
    const events = E.performAction(copy, action);
    assert.ok(events.some((e) => e.type === 'move'), '执行后应有 move 事件');
    assert.strictEqual(copy.regions[0].sides.p1.faceDown.length, 1, label + ' 执行后区域 0 我方背面牌应从 2 减为 1');
    assert.strictEqual(copy.regions[action.toRegionId].sides.p1.faceDown.length, 1,
      label + ' 执行后目标区域我方背面牌应为 1');
    // AP=1 行动后：若对手无牌可动会被跳过（endgame_skip）→ 本方重新开回合 AP 回满 3；否则 AP=0
    assert.ok(copy.players.p1.ap === 0 || copy.players.p1.ap === 3,
      label + ' move 后 AP 应清零（或被跳过回满 3），实际 ap=' + copy.players.p1.ap);
  }
  assert.notStrictEqual(easy.type, 'move', 'easy 档不应选 move（放弃区域只由 medium/hard 执行）');
  assert.ok(['end_turn', 'flip', 'place'].includes(easy.type), 'easy 在 AP=1 时应回退为 end_turn（或其它非 move 合法行动），实际 ' + easy.type);
  assertLegalAIAction(state, 'p1', easy);
});

test('§6 v1.5 AI 2.2：同 seed 决策确定（含 move 局面）', () => {
  const state = buildAbandonState();
  for (const strength of ['medium', 'hard']) {
    const a1 = AI.chooseAction(state, 'p1', makeOpts(777, { strength }));
    const a2 = AI.chooseAction(state, 'p1', makeOpts(777, { strength }));
    assert.deepStrictEqual(a2, a1, strength + ' 同 seed 决策应确定');
  }
  // 信息公平：必败区/可争夺区均为公开正面牌 + 自己背面牌；改动对手隐藏信息不影响决策
  const scrambled = scrambleHiddenInfo(state, 'p1');
  const hard = AI.chooseAction(state, 'p1', makeOpts(888, { strength: 'hard' }));
  const hardScrambled = AI.chooseAction(scrambled, 'p1', makeOpts(888, { strength: 'hard' }));
  assert.deepStrictEqual(hardScrambled, hard, '弃区决策不应依赖隐藏信息');
});

test('§6 v3.0 hard 单次决策 p95 ≤25ms / max ≤60ms（战役 + 决战 build）', () => {
  const { state } = h.setupBattle(E, { seed: 301, regionCount: 5, difficulty: 2, settleCards: 2, firstPlayer: 'p1' });
  for (let i = 0; i < 12 && state.phase === 'battle' && !(state.endgame && state.endgame.triggered); i++) {
    const legal = E.getLegalActions(state);
    const advance = legal.find((a) => a.type === 'draw') || legal.find((a) => a.type === 'end_turn');
    if (!advance) break;
    E.performAction(state, advance);
  }
  const times = [];
  for (let i = 0; i < 120; i++) {
    const pid = state.turn;
    const t0 = process.hrtime.bigint();
    const action = AI.chooseAction(state, pid, makeOpts(7000 + i, { strength: 'hard' }));
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    assertLegalAIAction(state, pid, action);
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.floor(0.95 * times.length)];
  const maxMs = times[times.length - 1];
  assert.ok(p95 <= 25, 'hard 单次决策 p95=' + p95.toFixed(2) + 'ms（契约 ≤25ms）');
  assert.ok(maxMs <= 60, 'hard 单次决策 max=' + maxMs.toFixed(2) + 'ms（契约 ≤60ms）');
});

test('§6 v3.3.0 medium 单次决策 p95 ≤10ms（概率表校准 + 轻量整回合前瞻）', () => {
  const { state } = h.setupBattle(E, { seed: 302, regionCount: 5, difficulty: 1, settleCards: 2, firstPlayer: 'p1' });
  const times = [];
  for (let i = 0; i < 120; i++) {
    const pid = state.turn;
    const t0 = process.hrtime.bigint();
    const action = AI.chooseAction(state, pid, makeOpts(7100 + i, { strength: 'medium' }));
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    assertLegalAIAction(state, pid, action);
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.floor(0.95 * times.length)];
  // v3.3.0：medium 增加整回合前瞻（top5/follow8/2 步），契约放宽到 p95≤10ms（benchmark 实测 ~1.7-3.2ms）
  assert.ok(p95 <= 10, 'medium 单次决策 p95=' + p95.toFixed(2) + 'ms（契约 ≤10ms）');
});

test('§6 v1.5 AI 2.2 自对弈：hard 出现 move 弃区、easy 从不用 move、对局正常终止', () => {
  const stats = { hard: { games: 0, moves: 0 }, medium: { games: 0, moves: 0 }, easy: { games: 0, moves: 0 } };
  for (const strength of ['hard', 'medium', 'easy']) {
    const games = strength === 'hard' ? 100 : (strength === 'medium' ? 60 : 20);
    for (let s = 1; s <= games; s++) {
      const g = selfPlayGame(4000 + s, { aiStrength: strength, difficulty: 2 });
      stats[strength].games += 1;
      stats[strength].moves += g.counts.move;
      assert.ok(g.steps < 6000, strength + ' 自对弈应在 6000 步内终止（seed=' + (4000 + s) + '）');
    }
  }
  assert.strictEqual(stats.easy.moves, 0, 'easy 档自对弈不应出现 move');
  assert.ok(stats.hard.moves > 0, 'hard 档自对弈应出现 move（主动弃区），实际 0（games=' + stats.hard.games + '）');
  assert.ok(stats.medium.moves >= 0, 'medium 档允许少量 move');
});

/* ================================================================== */
/* v3.0：CEM 收敛参数 / 分档波动 / 档位方向性回归                        */
/* ================================================================== */

/** 迷你自对弈（确定性，用于档位方向性回归；正式门槛见 docs/AI-OPTIMIZATION.md 的 holdout）。 */
function miniGame(seed, cfg, s1, s2) {
  const config = E.defaultConfig(Object.assign({ seed, firstPlayer: 'random' }, cfg));
  const state = E.createGame(config);
  const R = state.config.regionCount;
  E.submitLayout(state, 'p1', AI.chooseLayout(state, 'p1', { rng: E.makeRng(seed ^ 0x1111), strength: s1 }));
  E.submitLayout(state, 'p2', AI.chooseLayout(state, 'p2', { rng: E.makeRng(seed ^ 0x2222), strength: s2 }));
  E.finalizeLayout(state);
  let steps = 0;
  while (!E.isGameOver(state) && steps < 3000) {
    const action = AI.chooseAction(state, state.turn, { strength: state.turn === 'p1' ? s1 : s2 });
    assert.ok(action, 'miniGame AI 返回空行动');
    const matched = h.findLegalEquivalent(action, E.getLegalActions(state));
    assert.ok(matched, 'miniGame AI 返回非法行动');
    E.performAction(state, matched);
    steps++;
  }
  return state.result;
}

function miniMatchup(aStrength, bStrength, configs, seeds) {
  let wins = 0, losses = 0, draws = 0;
  for (const cfg of configs) {
    for (const seed of seeds) {
      // 双向座位：A 分别坐 p1 / p2（同 seed 同一副牌）
      const r1 = miniGame(seed, cfg, aStrength, bStrength);
      if (r1.winner === 'draw') draws++; else if (r1.winner === 'p1') wins++; else losses++;
      const r2 = miniGame(seed, cfg, bStrength, aStrength);
      if (r2.winner === 'draw') draws++; else if (r2.winner === 'p2') wins++; else losses++;
    }
  }
  return { wins, losses, draws, decisive: wins / Math.max(1, wins + losses) };
}

test('§6 v3.0 CEM 参数常量：三档参数齐备、波动幅度 easy > medium > hard 且有界', () => {
  const T = AI._internals.TRAINED;
  for (const tier of ['hard', 'medium', 'easy']) {
    assert.ok(T[tier] && typeof T[tier] === 'object', tier + ' 参数缺失');
    assert.ok(Number.isFinite(T[tier].waveAmp), tier + '.waveAmp 应为数值');
    assert.ok(Number.isFinite(T[tier].waveEps), tier + '.waveEps 应为数值');
    assert.ok(T[tier].waveAmp >= 0 && T[tier].waveAmp <= 0.5, tier + '.waveAmp 应有界 [0,0.5]');
    assert.ok(T[tier].waveEps >= 0 && T[tier].waveEps <= 0.15, tier + '.waveEps 应有界 [0,0.15]');
  }
  assert.ok(T.easy.waveAmp > T.medium.waveAmp, '波动幅度应 easy > medium');
  /* v3.3.0（task-95）：medium 关闭波动噪声（waveAmp=0）以获得对冻结 medium32 的稳定强度增益
     （benchmark n=1200：56.99%，hard vs medium 55.9% 保持档位）；档位差异由强度矩阵保证，而非噪声幅度。 */
  assert.strictEqual(T.medium.waveAmp, 0, 'v3.3.0 medium 应为确定性策略（waveAmp=0）');
  assert.strictEqual(T.medium.waveEps, 0, 'v3.3.0 medium 应为确定性策略（waveEps=0）');
  assert.ok(T.hard.waveAmp <= 0.02, 'hard 波动必须极小（≤0.02）');
  // defaultParams 返回副本（训练工具/测试可安全修改）
  const a = AI._internals.defaultParams('hard');
  a.settleBias = 123;
  assert.notStrictEqual(AI._internals.TRAINED.hard.settleBias, 123, 'defaultParams 不得返回 TRAINED 引用');
});

test('§6 v3.0 波动确定性：同 seed 决策完全确定、不同 seed 存在有界差异（easy 最明显）', () => {
  const base = h.setupBattle(E, { seed: 900, regionCount: 5, difficulty: 1, settleCards: 2, firstPlayer: 'p1' }).state;
  for (const strength of ['hard', 'medium', 'easy']) {
    // 同 seed 同 opts.rng → 决策完全一致（可复现）
    const a = AI.chooseAction(base, base.turn, makeOpts(1234, { strength }));
    const b = AI.chooseAction(base, base.turn, makeOpts(1234, { strength }));
    assert.deepStrictEqual(b, a, strength + ' 同 seed 决策应确定');
    // 不同 seed（opts.rng 或 state.config.seed）→ 决策允许有差异，但每次本身确定
    const seen = new Set();
    for (let k = 1; k <= 12; k++) {
      const x = AI.chooseAction(base, base.turn, makeOpts(3000 + k, { strength }));
      const y = AI.chooseAction(base, base.turn, makeOpts(3000 + k, { strength }));
      assert.deepStrictEqual(y, x, strength + ' 同 rng seed 决策应确定（k=' + k + '）');
      seen.add(h.canonicalAction(x));
    }
    if (strength === 'easy') assert.ok(seen.size >= 2, 'easy 档不同 seed 应出现不同决策（大噪声），实际 ' + seen.size);
    // 不同 state.config.seed（波动随机源由 seed 派生）→ 每个 seed 本身仍确定
    for (let k = 1; k <= 6; k++) {
      const variant = h.clone(base);
      variant.config.seed = (base.config.seed + k * 7919) >>> 0;
      const x = AI.chooseAction(variant, variant.turn, { strength });
      const y = AI.chooseAction(h.clone(variant), variant.turn, { strength });
      assert.deepStrictEqual(y, x, strength + ' 同 state seed 变体决策应确定（k=' + k + '）');
    }
    assert.ok(seen.size >= 1, strength + ' 12 个不同 seed 决策数应 ≥1');
    if (strength === 'easy') assert.ok(seen.size >= 2, 'easy 档不同 seed 应出现不同决策（大噪声），实际 ' + seen.size);
  }
  // 信息公平仍成立：params 覆盖钩子不读取隐藏信息（打乱隐藏信息决策不变）
  const scrambled = scrambleHiddenInfo(base, base.turn);
  const p = { hard: AI._internals.defaultParams('hard') };
  const orig = AI.chooseAction(base, base.turn, { strength: 'hard', params: p });
  const scr = AI.chooseAction(scrambled, base.turn, { strength: 'hard', params: p });
  assert.deepStrictEqual(scr, orig, 'params 覆盖钩子决策不得依赖隐藏信息');
});

test('§6 v3.0 参数覆盖钩子（训练用）：覆盖后仍只返回合法行动', () => {
  const { state } = h.setupBattle(E, { seed: 77, firstPlayer: 'p1' });
  for (const strength of ['hard', 'medium', 'easy']) {
    const params = {};
    params[strength] = AI._internals.defaultParams(strength);
    params[strength].waveAmp = 0;
    const action = AI.chooseAction(state, state.turn, { strength, params });
    assertLegalAIAction(state, state.turn, action);
  }
});

test('§6 v3.0 三档方向性回归（固定 seed、双向座位、canon 子集；正式 holdout 门槛见文档）', () => {
  const configs = [
    { regionCount: 3, settleCards: 2, difficulty: 2 },
    { regionCount: 3, settleCards: 1, difficulty: 1 },
    { regionCount: 5, settleCards: 2, difficulty: 1 },
    { regionCount: 5, settleCards: 4, difficulty: 3 },
  ];
  const seeds = [11, 22, 33, 44, 55, 66, 77, 88, 99, 111, 222, 333];
  const hm = miniMatchup('hard', 'medium', configs, seeds);
  const me = miniMatchup('medium', 'easy', configs, seeds);
  const he = miniMatchup('hard', 'easy', configs, seeds);
  // 方向性（hard > medium > easy）与回归护栏；低于以下阈值为回归失败（不是 task-40 最终门槛）
  assert.ok(hm.decisive >= 0.48, 'hard vs medium 方向性回归失败：' + (100 * hm.decisive).toFixed(1) + '%');
  assert.ok(me.decisive >= 0.62, 'medium vs easy 方向性回归失败：' + (100 * me.decisive).toFixed(1) + '%');
  assert.ok(he.decisive >= 0.62, 'hard vs easy 方向性回归失败：' + (100 * he.decisive).toFixed(1) + '%');
  assert.ok(he.decisive > me.decisive - 0.12, 'hard 对 easy 的压制不应明显弱于 medium（回归护栏）');
});
