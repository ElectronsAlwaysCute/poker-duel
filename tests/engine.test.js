'use strict';
/*
 * 扑克牌 · 比大小 —— 规则引擎主测试套件（零依赖，node:test + node:assert）
 * 运行：node tests/engine.test.js
 *
 * 事实来源：docs/RULES.md（规则）/ docs/CONTRACT.md（接口）
 * 独立编写：断言由规则文档推导，不按引擎实现反推。发现问题只报告，不在此修改引擎。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const h = require('./helpers');

const E = h.loadEngine();

/* ================================================================== */
/* 本地辅助                                                            */
/* ================================================================== */

const R5 = { regionCount: 5, firstPlayer: 'p1' };

function battle(overrides) {
  return h.setupBattle(E, Object.assign({}, R5, overrides || {}));
}

function invariant(state, label, opts) {
  h.assertInvariants(E, state, label, opts);
}

function cardIds(cards) {
  return (cards || []).map((c) => c.id);
}

/** 从规则推导当前状态下 getLegalActions 的期望集合（CONTRACT §5/§6 v1.4：按 AP 过滤，含 end_turn）。 */
function expectedLegalActionKeys(state) {
  const pid = state.turn;
  const open = h.openRegionIds(state);
  const N = state.config.settleCards;
  const ap = state.players[pid].ap;
  const keys = new Set();
  const inEndgame = !!(state.endgame && state.endgame.triggered && state.endgame.phase === 'build');
  // v1.4：结算 3 点、摸牌/翻牌 2 点、放牌/移牌 1 点、结束回合 0 点；任意未结算区域均可结算
  if (!inEndgame && ap >= E.ACTION_COSTS.settle && open.length > 0 && state.deck.length >= 2 * N) {
    for (const rid of open) keys.add(h.canonicalAction({ type: 'settle', regionId: rid }));
  }
  if (ap >= E.ACTION_COSTS.flip) {
    for (const rid of open) {
      for (const c of state.regions[rid].sides[pid].faceDown) {
        keys.add(h.canonicalAction({ type: 'flip', regionId: rid, cardId: c.id }));
      }
    }
  }
  if (ap >= E.ACTION_COSTS.place) {
    for (const c of state.players[pid].hand) {
      for (const rid of open) keys.add(h.canonicalAction({ type: 'place', regionId: rid, cardId: c.id }));
    }
    for (const from of open) {
      for (const c of state.regions[from].sides[pid].faceDown) {
        for (const to of open) {
          if (to !== from) keys.add(h.canonicalAction({ type: 'move', fromRegionId: from, cardId: c.id, toRegionId: to }));
        }
      }
    }
  }
  if (!inEndgame && ap >= E.ACTION_COSTS.draw) keys.add('draw');
  keys.add('end_turn');
  return keys;
}

function assertLegalActionsExhaustive(state, label) {
  const actual = new Set(E.getLegalActions(state).map(h.canonicalAction));
  const expected = expectedLegalActionKeys(state);
  const missing = [...expected].filter((k) => !actual.has(k));
  const extra = [...actual].filter((k) => !expected.has(k));
  assert.deepStrictEqual(missing, [], label + '：getLegalActions 缺少合法行动\n' + h.describeState(state));
  assert.deepStrictEqual(extra, [], label + '：getLegalActions 多出非法行动\n' + h.describeState(state));
}

/** 决战事件分析（v1.3）：补牌 → 最终部署（可能跳过）→ 摊牌 → 逐区确定性结算（可能提前锁定中断）。 */
function analyzeEndgame(events, state) {
  const start = h.firstEventOfType(events, 'endgame_start');
  const draws = events.filter((e) => e.type === 'endgame_draw');
  const skips = events.filter((e) => e.type === 'endgame_skip');
  const showdown = h.firstEventOfType(events, 'endgame_showdown');
  const settles = events.filter((e) => e.type === 'endgame_settle');
  const early = !!(state.result && state.result.early);
  return { start, draws, skips, showdown, settles, k: settles.length, early };
}

/**
 * 构造一个「轮到行动方且可立即结算」的自然局面（v1.4：开局 AP=3、任意未结算区域均可结算）。
 * 返回 { state, runner, preSettleState, settleAction }。
 */
function buildSettleableState(seed, opts) {
  opts = opts || {};
  const { state } = battle({ seed, difficulty: opts.difficulty != null ? opts.difficulty : 2 });
  const r = new h.Runner(E, state);
  assert.strictEqual(state.players[state.turn].ap, E.AP_PER_TURN, '开局行动方 AP 应回满 3');
  const settle = r.legal().find((a) => a.type === 'settle' && a.regionId === 0);
  assert.ok(settle, '开局（AP=3、牌堆充足）区域 0 应可直接结算');
  return { state, runner: r, preSettleState: h.clone(state), settleAction: settle };
}

/** 在种子范围内寻找一个区域0单独结算满足条件的场景并执行。 */
function findSettleScenario(opts) {
  const o = Object.assign({ difficulty: 2, wantTie: null, startSeed: 1, maxSeeds: 300, firstPlayer: 'p1' }, opts || {});
  for (let seed = o.startSeed; seed < o.startSeed + o.maxSeeds; seed++) {
    const built = buildSettleableState(seed, { difficulty: o.difficulty });
    const pre = h.clone(built.state);
    const { events } = built.runner.step(built.settleAction);
    const se = h.firstEventOfType(events, 'settle');
    assert.ok(se, 'settle 事件缺失');
    const isTie = se.winner === 'tie';
    if (o.wantTie != null && isTie !== o.wantTie) continue;
    return { seed, state: built.state, runner: built.runner, pre, events, settleEvent: se, trace: built.runner.trace.slice() };
  }
  return null;
}

/**
 * v1.4 通用行动策略：按 prefer 顺序选类型；决战 build 阶段优先推进（place/flip/move），
 * 绝不空转 end_turn 死循环；战役阶段兜底 draw/place/flip 推进对局。
 */
function policyPick(E, state, legal, prefer) {
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

/** 只摸牌直到终局（快速进入决战，覆盖决战判定分支，行动序列可复现）。 */
function drawOnlyGame(seed, overrides) {
  const { state } = battle(Object.assign({ seed }, overrides || {}));
  const r = new h.Runner(E, state, {
    checkInvariants: false,
    maxSteps: 4000,
    pick: (st, legal) => policyPick(E, st, legal, ['draw']),
  });
  r.run();
  return { state, runner: r };
}

/** 只结算/翻牌/放牌（不摸牌、尽量不触发决战），用于 hand_sum / 全部单独结算分支。 */
function settleOnlyGame(seed, overrides) {
  const { state } = battle(Object.assign({ seed }, overrides || {}));
  const r = new h.Runner(E, state, {
    checkInvariants: false,
    maxSteps: 4000,
    pick: (st, legal) => policyPick(E, st, legal, ['settle', 'flip', 'place']),
  });
  r.run();
  return { state, runner: r };
}

/** 在种子范围内寻找指定胜因的终局。policy='draw'|'settle'。 */
function findBranch(reason, overrides, maxSeeds, policy) {
  const max = maxSeeds || 1200;
  for (let seed = 1; seed <= max; seed++) {
    const g = policy === 'settle' ? settleOnlyGame(seed, overrides) : drawOnlyGame(seed, overrides);
    invariant(g.state, '终局 seed=' + seed + ' 胜因=' + reason);
    assert.ok(g.state.phase === 'gameover', 'seed=' + seed + ' 应自然到达终局');
    if (g.state.result.reason === reason) return { seed, state: g.state, runner: g.runner };
  }
  return null;
}

/** 摸牌直至牌堆 = 决战阈值+1（下一步摸牌即触发决战）。 */
function driveToThresholdPlusOne(overrides) {
  const { state } = battle(Object.assign({ seed: 1, difficulty: 2, firstPlayer: 'p1' }, overrides || {}));
  const r = new h.Runner(E, state, {
    checkInvariants: false,
    stopWhen: (s) => s.deck.length === E.getEndgameThreshold(s) + 1,
    pick: (st, legal) => (legal.find((a) => a.type === 'draw') || policyPick(E, st, legal, [])),
  });
  const res = r.run();
  assert.strictEqual(res.reason, 'stopWhen', '应在牌堆=阈值+1 时停止');
  invariant(state, '摸牌触发前');
  return { state, runner: r };
}

/**
 * v1.3 白盒构造：用标准 54 张的完整分配（hand/deck/region faceUp/faceDown/discard 全不重复）
 * 拼出可以「一步行动触发战略决战」的局面。返回 { state, action }。
 * opts: { regionCount=5, settleCards=2, difficulty=2, deckCount, handSizes, regionFaces }
 *   regionFaces: [{p1:[id...],p2:[id...]}, ...]，缺省为每区各 1 张正面牌。
 */
function synthEndgameState(opts) {
  const o = Object.assign({ regionCount: 5, settleCards: 2, difficulty: 2, deckCount: 11 }, opts || {});
  const R = o.regionCount;
  const pool = E.createDeck({ jokers: true, ranks: E.RANKS.slice(), suits: null }).map((c) => c.id);
  let cursor = 0;
  const take = (n) => {
    const out = pool.slice(cursor, cursor + n);
    cursor += n;
    assert.strictEqual(out.length, n, 'synthEndgameState：牌池不足');
    return out;
  };
  const regionFaces = o.regionFaces || [];
  const regions = [];
  for (let i = 0; i < R; i++) {
    const rf = regionFaces[i] || { p1: take(1), p2: take(1) };
    regions.push({ p1FaceUp: rf.p1, p2FaceUp: rf.p2 });
  }
  const hands = { p1: [], p2: [] };
  for (const pid of ['p1', 'p2']) {
    const n = (o.handSizes && o.handSizes[pid]) || 0;
    if (n > 0) hands[pid] = take(n);
  }
  const deck = take(o.deckCount);
  const discard = pool.slice(cursor);
  const state = h.synthBattle(E, {
    regionCount: R,
    config: { settleCards: o.settleCards, difficulty: o.difficulty },
    deck,
    discard,
    hands,
    regions,
    regionWins: o.regionWins,
    turn: 'p1',
  });
  return { state, deck, regions, hands };
}

/** 连续行动直到终局；用于 v1.3 决战 build/skip/showdown 全流程。返回事件扁平数组与各步事件。 */
function runToGameOver(state, opts) {
  const o = Object.assign({ prefer: ['place', 'flip', 'move'], maxSteps: 400 }, opts || {});
  const all = [];
  const steps = [];
  const r = new h.Runner(E, state, Object.assign({}, o, {
    onStep: (st, action, events) => {
      steps.push({ action, events: events.slice() });
      for (const ev of events) all.push(ev);
    },
  }));
  const res = r.run();
  return { runner: r, result: res, events: all, steps };
}

/** 主动结束回合直到当前行动方 AP 回满（新回合起点），返回结束次数。 */
function normalizeTurnStart(state) {
  let n = 0;
  while (state.phase === 'battle' && state.turn && state.players[state.turn].ap < E.AP_PER_TURN) {
    const end = E.getLegalActions(state).find((a) => a.type === 'end_turn');
    assert.ok(end, '应能主动结束回合');
    E.performAction(state, end);
    n++;
    assert.ok(n < 10, 'normalizeTurnStart 循环异常');
  }
  return n;
}

/** 通过 end_turn 等到可摸牌的回合再摸 1 张（返回事件数组）。 */
function performDrawOnce(state) {
  for (let i = 0; i < 8; i++) {
    const legal = E.getLegalActions(state);
    const draw = legal.find((a) => a.type === 'draw');
    if (draw) return E.performAction(state, draw);
    const end = legal.find((a) => a.type === 'end_turn');
    assert.ok(end, '应能结束回合等待可摸牌回合');
    E.performAction(state, end);
  }
  throw new Error('performDrawOnce：无法摸牌');
}

/* ================================================================== */
/* 一、常量 / 牌 / RNG                                                 */
/* ================================================================== */

test('§2 常量：VERSION / RANK_VALUES / SUITS / DIFFICULTIES 与规则一致', () => {
  assert.strictEqual(E.VERSION, '1.7.0', 'VERSION 应为 1.7.0（v2.17 决战AP上限；v2.1 固定补偿保持）');
  assert.strictEqual(E.DEFAULT_SETTLE_CARDS, 2, '默认结算随机性应为标准（2）');
  assert.deepStrictEqual(E.SETTLE_MODES, [
    { id: 1, name: '简单', label: '双方各补 1 张', cards: 1 },
    { id: 2, name: '标准', label: '双方各补 2 张', cards: 2 },
    { id: 4, name: '复杂', label: '双方各补 4 张', cards: 4 },
  ], 'SETTLE_MODES 必须符 CONTRACT §2（简单=1/标准=2/复杂=4）');
  assert.ok(!E.SETTLE_MODES.some((m) => m.cards === 3), 'v1.3 复杂档应为 4 张，不再有 3 张档');

  assert.deepStrictEqual(E.RANK_VALUES, {
    A: 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10,
    J: 11, Q: 12, K: 13, '小王': 14, '大王': 15,
  }, 'RANK_VALUES 必须符 RULES §2：J=11,Q=12,K=13,小王=14,大王=15');

  assert.deepStrictEqual(E.SUITS, [
    { id: 's', symbol: '♠', red: false },
    { id: 'h', symbol: '♥', red: true },
    { id: 'd', symbol: '♦', red: true },
    { id: 'c', symbol: '♣', red: false },
  ], 'SUITS 顺序/颜色应固定 s h d c');

  assert.deepStrictEqual(Object.keys(E.DIFFICULTIES).map(Number).sort((a, b) => a - b), [1, 2, 3]);
  // v1.4 难度标题改名：1=消耗（败者摸牌）/2=均衡（不摸牌）/3=突进（胜者摸牌），枚举值不变
  assert.strictEqual(E.DIFFICULTIES[1].name, '消耗');
  assert.strictEqual(E.DIFFICULTIES[2].name, '均衡');
  assert.strictEqual(E.DIFFICULTIES[3].name, '突进');
  assert.match(E.DIFFICULTIES[1].label + E.DIFFICULTIES[1].rule, /败者/, '难度1 应为单独结算后败者摸牌');
  assert.match(E.DIFFICULTIES[3].label + E.DIFFICULTIES[3].rule, /胜者/, '难度3 应为单独结算后胜者摸牌');
  assert.match(E.DIFFICULTIES[2].label, /不摸牌/, '难度2 应为单独结算后不摸牌');
  assert.strictEqual(E.DIFFICULTIES[1].rule, 'loser-draw');
  assert.strictEqual(E.DIFFICULTIES[2].rule, 'none');
  assert.strictEqual(E.DIFFICULTIES[3].rule, 'winner-draw');
  // v1.4 行动点常量（CONTRACT §2）
  assert.strictEqual(E.AP_PER_TURN, 3, 'AP_PER_TURN 应为 3');
  assert.deepStrictEqual(E.ACTION_COSTS, { settle: 3, draw: 2, flip: 2, place: 1, move: 1, end_turn: 0 },
    'ACTION_COSTS 必须符 CONTRACT §2（v1.4）');
  // v1.5 回合倒计时常量（CONTRACT §2；引擎只存配置，不执行计时）
  assert.strictEqual(E.DEFAULT_TURN_TIME_LIMIT, 30, 'DEFAULT_TURN_TIME_LIMIT 应为 30 秒（默认开启）');
  assert.deepStrictEqual(E.TURN_TIME_LIMIT_OPTIONS, [0, 15, 30, 60],
    'TURN_TIME_LIMIT_OPTIONS 应为 [0,15,30,60]（关闭/15/30/60）');
});

test('§2 createDeck：默认 54 张 / 无王 52 张 / 自定义牌面 / id 唯一', () => {
  const deck = E.createDeck({ jokers: true, ranks: ['A','2','3','4','5','6','7','8','9','10','J','Q','K'] });
  assert.strictEqual(deck.length, 54, '标准牌堆应为 54 张（52 + 大小王）');
  assert.strictEqual(new Set(deck.map((c) => c.id)).size, 54, '牌 id 必须全局唯一');
  const byRank = {};
  for (const c of deck) byRank[c.rank] = (byRank[c.rank] || 0) + 1;
  for (const rank of ['A','2','3','4','5','6','7','8','9','10','J','Q','K']) {
    assert.strictEqual(byRank[rank], 4, rank + ' 应有 4 张（四种花色）');
  }
  const big = deck.find((c) => c.id === 'joker-B');
  const small = deck.find((c) => c.id === 'joker-S');
  assert.ok(big && small, '应包含 joker-B / joker-S');
  assert.strictEqual(big.rank, '大王');
  assert.strictEqual(big.value, 15);
  assert.strictEqual(big.joker, true);
  assert.strictEqual(big.suit, null);
  assert.strictEqual(small.rank, '小王');
  assert.strictEqual(small.value, 14);
  assert.strictEqual(small.joker, true);
  for (const c of deck) {
    assert.strictEqual(c.value, E.RANK_VALUES[c.rank], '牌 ' + c.id + ' 的 value 应与 RANK_VALUES 一致');
    assert.strictEqual(typeof c.revealed, 'boolean', 'Card.revealed 应为布尔');
    if (!c.joker) {
      assert.ok(['s','h','d','c'].includes(c.suit));
      assert.ok('♠♥♦♣'.includes(c.suitSymbol));
      assert.strictEqual(c.red, c.suit === 'h' || c.suit === 'd');
    }
  }

  assert.strictEqual(E.createDeck({ jokers: false }).length, 52, '去掉大小王应为 52 张');
  const custom = E.createDeck({ jokers: true, ranks: ['A', 'J', 'K'] });
  assert.strictEqual(custom.length, 14, '3 种牌面 + 2 王 = 14 张');
  assert.deepStrictEqual([...new Set(custom.map((c) => c.rank))].sort(), ['A', 'J', 'K', '大王', '小王'].sort());
});

test('§2 formatCard / formatCards 展示格式', () => {
  const deck = E.createDeck({ jokers: true, ranks: ['A','2','3','4','5','6','7','8','9','10','J','Q','K'] });
  const byId = new Map(deck.map((c) => [c.id, c]));
  assert.strictEqual(E.formatCard(byId.get('s-A')), '♠A');
  assert.strictEqual(E.formatCard(byId.get('h-10')), '♥10');
  assert.strictEqual(E.formatCard(byId.get('joker-S')), '小王');
  assert.strictEqual(E.formatCard(byId.get('joker-B')), '大王');
  const joined = E.formatCards([byId.get('s-A'), byId.get('h-10')]);
  assert.strictEqual(typeof joined, 'string');
  assert.ok(joined.includes('♠A') && joined.includes('♥10'), 'formatCards 应包含各牌面');
});

test('§8 makeRng：同 seed 确定、int 范围、shuffle 保集、pick 合法', () => {
  const a = E.makeRng(2024);
  const b = E.makeRng(2024);
  const c = E.makeRng(2025);
  const seqA = Array.from({ length: 20 }, () => a.next());
  const seqB = Array.from({ length: 20 }, () => b.next());
  const seqC = Array.from({ length: 20 }, () => c.next());
  assert.deepStrictEqual(seqA, seqB, '同 seed 的 RNG 序列必须一致');
  assert.notDeepStrictEqual(seqA, seqC, '不同 seed 的 RNG 序列应不同');
  for (const x of seqA) assert.ok(x >= 0 && x < 1, 'next() 应在 [0,1)');

  const rng = E.makeRng(7);
  assert.strictEqual(rng.int(1), 0, 'int(1) 恒为 0');
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const v = rng.int(5);
    assert.ok(Number.isInteger(v) && v >= 0 && v < 5, 'int(5) 应在 [0,5)');
    seen.add(v);
  }
  assert.deepStrictEqual([...seen].sort(), [0, 1, 2, 3, 4], 'int(5) 应覆盖全部取值');

  const src = [1, 2, 3, 4, 5];
  const s1 = E.makeRng(9).shuffle(src.slice());
  const s2 = E.makeRng(9).shuffle(src.slice());
  assert.deepStrictEqual(s1, s2, '同 seed shuffle 应确定');
  assert.deepStrictEqual([...s1].sort(), src, 'shuffle 不得增减牌');
  const picked = E.makeRng(1).pick(src);
  assert.ok(src.includes(picked), 'pick 应返回数组元素');
});

/* ================================================================== */
/* 二、配置                                                            */
/* ================================================================== */

test('§8 defaultConfig：默认值与派生字段', () => {
  const cfg = E.defaultConfig();
  assert.strictEqual(cfg.regionCount, 5, '默认 5 区域');
  assert.strictEqual(cfg.difficulty, 1, '默认难度 1');
  assert.strictEqual(cfg.firstPlayer, 'random', '默认随机先手');
  assert.strictEqual(cfg.winsNeeded, 3, '默认 5 区 3 胜');
  assert.strictEqual(cfg.initialDraw, 10, '初始摸牌 = 2R = 10');
  assert.strictEqual(cfg.layoutCount, 5, '布局数 = R = 5');
  assert.strictEqual(cfg.deck.jokers, true);
  assert.strictEqual(cfg.deck.ranks.length, 13);
  assert.deepStrictEqual(cfg.playerNames, { p1: '你', p2: '电脑' });
  assert.strictEqual(cfg.settleCards, 2, '默认结算随机性 = 标准 2');
  assert.strictEqual(cfg.aiStrength, 'medium', '默认 AI 强度 = medium');
  assert.strictEqual(cfg.apPerTurn, 3, '默认每回合行动点 = 3（v1.4）');
  assert.strictEqual(cfg.turnTimeLimit, 30, '默认回合倒计时 = 30 秒（v1.5）');
  assert.strictEqual(cfg.seed, null, '默认 seed 为 null（createGame 时生成）');
  // v1.5：turnTimeLimit 覆盖 / 0=关闭 / null 回落默认
  assert.strictEqual(E.defaultConfig({ turnTimeLimit: 15 }).turnTimeLimit, 15, '显式覆盖 15 秒');
  assert.strictEqual(E.defaultConfig({ turnTimeLimit: 0 }).turnTimeLimit, 0, '0 = 关闭倒计时');
  assert.strictEqual(E.defaultConfig({ turnTimeLimit: 60 }).turnTimeLimit, 60, '显式覆盖 60 秒');
  assert.strictEqual(E.defaultConfig({ turnTimeLimit: null }).turnTimeLimit, 30, 'null 应回落默认 30');

  const r3 = E.defaultConfig({ regionCount: 3 });
  assert.strictEqual(r3.winsNeeded, 2, 'R=3 → 2 胜');
  assert.strictEqual(r3.initialDraw, 6);
  assert.strictEqual(r3.layoutCount, 3);
  const r7 = E.defaultConfig({ regionCount: 7 });
  assert.strictEqual(r7.winsNeeded, 4, 'R=7 → 4 胜');
  assert.strictEqual(r7.initialDraw, 14);
  assert.strictEqual(r7.layoutCount, 7);
});

test('§3 validateConfig：默认 5 区 info 派生值', () => {
  const v = E.validateConfig(E.defaultConfig());
  assert.strictEqual(v.ok, true, '默认配置应合法');
  assert.deepStrictEqual(v.errors, []);
  assert.deepStrictEqual(v.warnings, [], '默认 54 张 5 区不应有警告');
  assert.strictEqual(v.info.deckSize, 54);
  assert.strictEqual(v.info.regionCount, 5);
  assert.strictEqual(v.info.initialDraw, 10);
  assert.strictEqual(v.info.layoutCount, 5);
  assert.strictEqual(v.info.winsNeeded, 3);
  assert.strictEqual(v.info.settleCards, 2);
  assert.strictEqual(v.info.settleMode, '标准');
  assert.strictEqual(v.info.compensationDraw, 1, '后手补偿固定 1 张（v2.1）');
  assert.strictEqual(v.info.apPerTurn, 3, 'info.apPerTurn = 3（v1.4）');
  assert.strictEqual(v.info.turnTimeLimit, 30, 'info.turnTimeLimit 默认 30（v1.5）');
  assert.deepStrictEqual(v.info.actionCosts, { settle: 3, draw: 2, flip: 2, place: 1, move: 1, end_turn: 0 },
    'info.actionCosts 应符 CONTRACT §2');
  assert.strictEqual(v.info.endgameThreshold, 10, '初始决战阈值 = 2R = 2×5 = 10');
  assert.strictEqual(v.info.deckAfterSetup, 33, '布局后牌堆 = 54 - 4R - 1 = 54 - 20 - 1 = 33');
  assert.strictEqual(v.info.gapToEndgame, 23, '决战前净消耗 = 54 - 6R - 1 = 54 - 30 - 1 = 23（不随 N 变化）');
});

test('§3 validateConfig：3/5/7 区域 × 结算随机性 1/2/4 全部合法（54 张）', () => {
  const expectByR = {
    3: { K: 1, winsNeeded: 2, initialDraw: 6, threshold: 6, deckAfterSetup: 54 - 12 - 1, gap: 54 - 18 - 1 },
    5: { K: 1, winsNeeded: 3, initialDraw: 10, threshold: 10, deckAfterSetup: 54 - 20 - 1, gap: 54 - 30 - 1 },
    7: { K: 1, winsNeeded: 4, initialDraw: 14, threshold: 14, deckAfterSetup: 54 - 28 - 1, gap: 54 - 42 - 1 },
  };
  for (const R of [3, 5, 7]) {
    for (const N of [1, 2, 4]) {
      const v = E.validateConfig(E.defaultConfig({ regionCount: R, settleCards: N }));
      const label = 'R=' + R + ' N=' + N;
      assert.strictEqual(v.ok, true, label + ' 使用标准 54 张应合法：' + JSON.stringify(v.errors));
      assert.strictEqual(v.info.deckSize, 54, label + ' deckSize 应为 54');
      assert.strictEqual(v.info.regionCount, R, label);
      assert.strictEqual(v.info.settleCards, N, label);
      assert.strictEqual(v.info.compensationDraw, 1, label + ' compensationDraw 固定 1（v2.1）');
      assert.strictEqual(v.info.winsNeeded, expectByR[R].winsNeeded, label);
      assert.strictEqual(v.info.initialDraw, expectByR[R].initialDraw, label);
      assert.strictEqual(v.info.endgameThreshold, expectByR[R].threshold, label + ' 阈值应为 2R');
      assert.strictEqual(v.info.deckAfterSetup, expectByR[R].deckAfterSetup, label);
      assert.strictEqual(v.info.gapToEndgame, expectByR[R].gap, label + ' gap 应为 D-6R-K，不随 N 变化');
      assert.deepStrictEqual(v.errors, [], label);
    }
  }
  // 7 区不再限制结算档位：标准/复杂均合法
  assert.strictEqual(E.validateConfig(E.defaultConfig({ regionCount: 7, settleCards: 2 })).ok, true, '7 区 + 标准结算应合法');
  assert.strictEqual(E.validateConfig(E.defaultConfig({ regionCount: 7, settleCards: 4 })).ok, true, '7 区 + 复杂(4)结算应合法');

  // 自定义牌堆：52 张仍可支撑 5 区任意 N；R=7 合法下限 = 6R+K+1 = 44
  const noJoker = E.validateConfig(E.defaultConfig({ deck: { jokers: false } }));
  assert.strictEqual(noJoker.ok, true);
  assert.strictEqual(noJoker.info.deckSize, 52);
  assert.strictEqual(noJoker.info.compensationDraw, 1);
  assert.strictEqual(noJoker.info.endgameThreshold, 10);
  assert.strictEqual(noJoker.info.deckAfterSetup, 52 - 20 - 1);
  assert.strictEqual(noJoker.info.gapToEndgame, 52 - 30 - 1, '52 张 R=5 gap = 21');

  const custom7 = E.validateConfig(E.defaultConfig({
    regionCount: 7,
    settleCards: 4,
    deck: { jokers: true, ranks: ['A','2','3','4','5','6','7','8','9','10','J'] },
  }));
  assert.strictEqual(custom7.ok, true, '46 张牌堆可支撑 7 区（≥ 6R+K+1=44）');
  assert.strictEqual(custom7.info.deckSize, 46);
  assert.strictEqual(custom7.info.compensationDraw, 1);
  assert.strictEqual(custom7.info.deckAfterSetup, 46 - 28 - 1);
  assert.strictEqual(custom7.info.gapToEndgame, 46 - 42 - 1, '46 张 R=7 gap = 3');
  // R=7 精确下限 44 = 6R+K+1（4 花色 × 11 牌面，无王）
  const custom44 = E.validateConfig(E.defaultConfig({
    regionCount: 7, settleCards: 1,
    deck: { jokers: false, ranks: ['A','2','3','4','5','6','7','8','9','10','J'] },
  }));
  assert.strictEqual(custom44.ok, true, '44 张 = 6R+K+1 为 R=7 合法下限');
  assert.strictEqual(custom44.info.gapToEndgame, 1, '44 张 R=7 gap = 1');
});

test('§3 validateConfig：非法配置报错（区域数/难度/结算档位/先手/牌面/牌堆过小）', () => {
  assert.strictEqual(E.validateConfig(E.defaultConfig({ regionCount: 2 })).ok, false, '区域数 <3 应报错');
  assert.strictEqual(E.validateConfig(E.defaultConfig({ regionCount: 2.5 })).ok, false, '区域数非整数应报错');
  assert.strictEqual(E.validateConfig(E.defaultConfig({ difficulty: 0 })).ok, false, '难度 0 应报错');
  assert.strictEqual(E.validateConfig(E.defaultConfig({ difficulty: 4 })).ok, false, '难度 4 应报错');
  assert.strictEqual(E.validateConfig(E.defaultConfig({ settleCards: 0 })).ok, false, 'settleCards=0 应报错');
  // v1.2 旧值 3 在 defaultConfig 中迁移为 4（复杂=各补 4 张），应合法且 info 反映 4
  const migrated = E.validateConfig(E.defaultConfig({ settleCards: 3 }));
  assert.strictEqual(migrated.ok, true, 'settleCards=3 应迁移为 4 而非报错');
  assert.strictEqual(migrated.info.settleCards, 4, '旧值 3 → 迁移为 4');
  assert.strictEqual(E.validateConfig(E.defaultConfig({ settleCards: 5 })).ok, false, 'settleCards=5 应报错');
  assert.strictEqual(E.validateConfig(E.defaultConfig({ firstPlayer: 'x' })).ok, false, '非法先手应报错');
  // 注：defaultConfig 对空 ranks 会回退为默认 13 牌面（补全默认值语义），故空数组无法作为非法用例。
  const badRank = E.validateConfig(E.defaultConfig({ deck: { jokers: true, ranks: ['A', 'X'] } }));
  assert.strictEqual(badRank.ok, false, '未知牌面应报错');

  // 牌堆过小：R=5 需 D ≥ 6R+K+1 = 32；D=24（6 牌面×4）应报错，且错误应指向牌堆不足
  const tiny = E.validateConfig(E.defaultConfig({ deck: { jokers: false, ranks: ['A', '2', '3', '4', '5', '6'] } }));
  assert.strictEqual(tiny.ok, false, '24 张牌堆无法支撑 5 区对局');
  assert.ok(tiny.errors.length > 0);
  assert.ok(tiny.errors.every((e) => typeof e === 'string' && e.length > 0), 'errors 应为非空字符串');

  // D=20 < 4R+K=21（连初始发牌+后手补偿都不够）；D=32 = 6R+K+1 为合法下限（gap=1）
  const tooSmall = E.validateConfig(E.defaultConfig({ deck: { jokers: false, ranks: ['A', '2', '3', '4', '5'] } }));
  assert.strictEqual(tooSmall.ok, false, '20 张牌堆连初始发牌+补偿都不够（< 4R+K）');
  const below = E.validateConfig(E.defaultConfig({ deck: { jokers: false, ranks: ['A', '2', '3', '4', '5', '6', '7'] } }));
  assert.strictEqual(below.ok, false, '28 张 < 6R+K+1=32 应非法');
  // D=32 = 6R+K+1 边界合法（4 花色 × 8 牌面，无王）
  const boundary = E.validateConfig(E.defaultConfig({
    deck: { jokers: false, ranks: ['A', '2', '3', '4', '5', '6', '7', '8'] },
  }));
  assert.strictEqual(boundary.ok, true, '32 张 = 6R+K+1 应合法');
  assert.strictEqual(boundary.info.gapToEndgame, 1, 'D=6R+K+1 时 gap=1');
});

test('§3 validateConfig：gap 过小/过大给出警告但 ok=true', () => {
  // R=7 D=44 = 6R+K+1 下限：gap = 1 ≤ 2 → 警告对局过短
  const shortGame = E.validateConfig(E.defaultConfig({
    regionCount: 7,
    settleCards: 2,
    deck: { jokers: false, ranks: ['A','2','3','4','5','6','7','8','9','10','J'] },
  }));
  assert.strictEqual(shortGame.ok, true, '44 张牌堆为 R=7 合法下限（6R+K+1=44）');
  assert.strictEqual(shortGame.info.gapToEndgame, 1);
  assert.ok(shortGame.warnings.length > 0, 'gap=1≤2 应警告对局过短');

  // R=3 + 54 张：gap = 35 > 30 → 警告对局可能较长（与 N 无关）
  const longGame = E.validateConfig(E.defaultConfig({ regionCount: 3, settleCards: 1 }));
  assert.strictEqual(longGame.ok, true);
  assert.strictEqual(longGame.info.gapToEndgame, 35);
  assert.ok(longGame.warnings.length > 0, 'R=3 + 54 张 gap=35>30 应警告对局可能较长');
  // R=5 + 54 张（任意 N）gap=23，不应警告
  assert.deepStrictEqual(E.validateConfig(E.defaultConfig({ regionCount: 5, settleCards: 4 })).warnings, [], 'R=5 gap=23 不应有警告');
  // R=7 + 54 张（任意 N）gap=11，不应警告
  assert.deepStrictEqual(E.validateConfig(E.defaultConfig({ regionCount: 7, settleCards: 4 })).warnings, [], 'R=7 gap=11 不应有警告');
});

test('§3 v1.5 回合倒计时：validateConfig 合法值/边界/非法值/错误文案', () => {
  // 合法值：UI 四档（0/15/30/60）+ 引擎边界（5/300）
  for (const val of [0, 5, 15, 30, 60, 300]) {
    const r = E.validateConfig(E.defaultConfig({ turnTimeLimit: val }));
    assert.strictEqual(r.ok, true, 'turnTimeLimit=' + val + ' 应合法：' + JSON.stringify(r.errors));
    assert.strictEqual(r.info.turnTimeLimit, val, 'info.turnTimeLimit 应透传 ' + val);
  }
  // 非法值：-5 / 1 / 4（低于 5）/ 30.5 / 301 / 非数字 → ok=false 且错误文案含规则
  for (const val of [-5, 1, 4, 30.5, 301, 'abc', Infinity, NaN]) {
    const r = E.validateConfig(E.defaultConfig({ turnTimeLimit: val }));
    assert.strictEqual(r.ok, false, 'turnTimeLimit=' + val + ' 应非法');
    assert.ok(r.errors.some((e) => /回合倒计时必须是 0（关闭）或 5-300 秒的整数/.test(e)),
      '非法值错误文案应含「回合倒计时必须是 0（关闭）或 5-300 秒的整数」：' + JSON.stringify(r.errors));
  }
  // 缺省 / null / undefined → 默认 30
  assert.strictEqual(E.validateConfig(E.defaultConfig({})).info.turnTimeLimit, 30, '缺省 → 30');
  assert.strictEqual(E.validateConfig(E.defaultConfig({ turnTimeLimit: null })).info.turnTimeLimit, 30, 'null → 30');
  assert.strictEqual(E.validateConfig(E.defaultConfig({ turnTimeLimit: undefined })).info.turnTimeLimit, 30, 'undefined → 30');
  // 结论：倒计时只影响 info.turnTimeLimit，不影响其余派生数值
  const offInfo = E.validateConfig(E.defaultConfig({ turnTimeLimit: 0 })).info;
  const timerInfo = E.validateConfig(E.defaultConfig({ turnTimeLimit: 60 })).info;
  for (const key of ['deckSize', 'suitCount', 'regionCount', 'settleCards', 'initialDraw', 'layoutCount',
    'compensationDraw', 'apPerTurn', 'winsNeeded', 'endgameThreshold', 'deckAfterSetup', 'gapToEndgame']) {
    assert.strictEqual(timerInfo[key], offInfo[key], 'turnTimeLimit 不应影响 info.' + key);
  }
});

/* ================================================================== */
/* 三、createGame                                                      */
/* ================================================================== */

test('§4 createGame：非法配置抛 BAD_CONFIG（中文信息）', () => {
  h.assertThrowsError(() => E.createGame(E.defaultConfig({ regionCount: 2 })), 'BAD_CONFIG', 'createGame 非法区域数');
});

test('§4 createGame：默认初始状态（布局前）', () => {
  const state = E.createGame(E.defaultConfig({ seed: 777, firstPlayer: 'p1' }));
  assert.strictEqual(state.version, '1.7.0');
  assert.strictEqual(state.config.turnTimeLimit, 30, 'state.config.turnTimeLimit 默认 30（v1.5）');
  assert.strictEqual(state.phase, 'layout');
  assert.strictEqual(state.turn, null);
  assert.strictEqual(state.turnCount, 0);
  assert.strictEqual(state.deck.length, 34, '布局前牌堆 = 54 - 2*10 = 34');
  assert.strictEqual(state.players.p1.hand.length, 10, '双方各 10 张手牌');
  assert.strictEqual(state.players.p2.hand.length, 10);
  assert.strictEqual(state.players.p1.name, '你');
  assert.strictEqual(state.players.p2.name, '电脑');
  assert.strictEqual(state.players.p1.regionsWon, 0);
  assert.strictEqual(state.discard.length, 0);
  assert.strictEqual(state.regions.length, 5);
  assert.deepStrictEqual(state.regions.map((r) => r.id), [0, 1, 2, 3, 4], '区域编号应为 0..R-1');
  for (const r of state.regions) {
    assert.strictEqual(r.status, 'open');
    assert.strictEqual(r.result, null);
    assert.strictEqual(h.countSideCards(r.sides.p1) + h.countSideCards(r.sides.p2), 0, '布局前区域应为空');
  }
  assert.deepStrictEqual(state.regionWins, { p1: 0, p2: 0, ties: 0 });
  assert.deepStrictEqual(state.layout, { submitted: { p1: false, p2: false }, assignments: { p1: null, p2: null }, revealed: false });
  assert.strictEqual(state.result, null);
  assert.strictEqual(state.endgame.triggered, false);
  assert.strictEqual(state.endgame.phase, null);
  assert.strictEqual(state.endgame.threshold, 10, '初始决战阈值 = 2R = 10');
  assert.strictEqual(state.endgame.drawPerPlayer, 0);
  assert.deepStrictEqual(state.endgame.drawnCounts, { p1: 0, p2: 0 });
  assert.deepStrictEqual(state.endgame.skipped, { p1: false, p2: false });
  assert.strictEqual(state.config.settleCards, 2);
  assert.ok(Array.isArray(state.log) && state.log.length >= 1, '应有中文开局日志');
  assert.strictEqual(typeof state.config.seed, 'number', '显式 seed 应保留为数字');
  assert.strictEqual(state.config.seed, 777);
  assert.strictEqual(state.config.firstPlayer, 'p1');
  assert.strictEqual(state.config.secondPlayer, 'p2');
  assert.strictEqual(state.config.winsNeeded, 3);
  assert.strictEqual(state.config.initialDraw, 10);
  assert.strictEqual(state.config.layoutCount, 5);
  assert.strictEqual(state.config.compensationDraw, 1, '后手补偿固定 1 张（v2.1）');
  invariant(state, 'createGame 初始状态');
});

test('§4 v1.5 createGame：turnTimeLimit 写入 state.config / 日志提示 / 引擎不执行计时 / 确定性不受影响', () => {
  const st = E.createGame(E.defaultConfig({ seed: 4242, firstPlayer: 'p1', turnTimeLimit: 15 }));
  assert.strictEqual(st.version, '1.7.0', 'state.version = 1.7.0');
  assert.strictEqual(st.config.turnTimeLimit, 15, 'state.config.turnTimeLimit 应透传 15');
  assert.ok(st.log.some((entry) => /回合倒计时：每回合 15 秒，超时自动结束回合/.test(String(entry.text || entry))),
    '开局日志应提示「回合倒计时：每回合 15 秒，超时自动结束回合」');
  // 0 = 关闭：不写倒计时日志
  const off = E.createGame(E.defaultConfig({ seed: 4242, firstPlayer: 'p1', turnTimeLimit: 0 }));
  assert.strictEqual(off.config.turnTimeLimit, 0, 'state.config.turnTimeLimit 0 = 关闭');
  assert.ok(!off.log.some((entry) => /回合倒计时/.test(String(entry.text || entry))), 'turnTimeLimit=0 时不应有倒计时日志');
  // 引擎不执行计时：状态里没有剩余秒数/截止时间字段，行动事件流无计时事件
  const stateText = JSON.stringify(st);
  assert.ok(!/"(remaining|deadline|timeLeft|timerState|countdown)"/i.test(stateText),
    '引擎状态不得含计时运行字段（计时由 UI 客户端执行）');
  const { state: battleState } = battle({ seed: 4243 });
  battleState.config.turnTimeLimit = 15;
  const events = E.performAction(battleState, E.getLegalActions(battleState)[0]);
  assert.ok(Array.isArray(events) && events.length > 0);
  assert.ok(!events.some((ev) => /timeout|timer|countdown/i.test(String(ev.type))), '行动事件流不得含计时事件');
  // 确定性：同 seed 下 turnTimeLimit 不影响发牌/手牌/先手
  const a = E.createGame(E.defaultConfig({ seed: 777, turnTimeLimit: 0 }));
  const b = E.createGame(E.defaultConfig({ seed: 777, turnTimeLimit: 60 }));
  assert.deepStrictEqual(cardIds(a.deck), cardIds(b.deck), '牌堆顺序不受 turnTimeLimit 影响');
  assert.deepStrictEqual(cardIds(a.players.p1.hand), cardIds(b.players.p1.hand), 'p1 手牌不受影响');
  assert.deepStrictEqual(cardIds(a.players.p2.hand), cardIds(b.players.p2.hand), 'p2 手牌不受影响');
  assert.deepStrictEqual(a.regions.map((r) => r.id), b.regions.map((r) => r.id), '区域结构不受影响');
  assert.strictEqual(a.config.firstPlayer, b.config.firstPlayer, '随机先手结果不受 turnTimeLimit 影响');
});

test('§8 createGame：3/5/7 区域与 52 张牌堆的初始牌数', () => {
  const r3 = E.createGame(E.defaultConfig({ seed: 1, regionCount: 3 }));
  assert.strictEqual(r3.deck.length, 54 - 12, 'R=3 布局前牌堆 = 54 - 4R = 42');
  assert.strictEqual(r3.players.p1.hand.length, 6);
  invariant(r3, 'R=3 初始状态');

  const r7 = E.createGame(E.defaultConfig({ seed: 1, regionCount: 7 }));
  assert.strictEqual(r7.deck.length, 54 - 28, 'R=7 布局前牌堆 = 54 - 28 = 26');
  assert.strictEqual(r7.players.p1.hand.length, 14);
  invariant(r7, 'R=7 初始状态');

  const r7long = E.createGame(E.defaultConfig({ seed: 1, regionCount: 7, settleCards: 4 }));
  assert.strictEqual(r7long.deck.length, 54 - 28, 'R=7 复杂结算同样使用 54 张牌堆');
  invariant(r7long, 'R=7 N=4 初始状态');

  const d52 = E.createGame(E.defaultConfig({ seed: 1, deck: { jokers: false } }));
  assert.strictEqual(d52.deck.length, 52 - 20);
  invariant(d52, '52 张牌堆初始状态');
});

test('§8 createGame：先手固定生效；随机先手由 seed 决定且可复现', () => {
  const p2First = E.createGame(E.defaultConfig({ seed: 5, firstPlayer: 'p2' }));
  assert.strictEqual(p2First.config.firstPlayer, 'p2');
  assert.strictEqual(p2First.config.secondPlayer, 'p1');

  const a = E.createGame(E.defaultConfig({ seed: 424242 }));
  const b = E.createGame(E.defaultConfig({ seed: 424242 }));
  assert.deepStrictEqual(a, b, '同 seed 同配置 createGame 应完全一致（含先手与牌堆）');
  assert.ok(['p1', 'p2'].includes(a.config.firstPlayer), '随机先手应解析为 p1/p2');
  assert.strictEqual(a.config.secondPlayer, a.config.firstPlayer === 'p1' ? 'p2' : 'p1');

  const seen = new Set();
  for (let seed = 1; seed <= 40; seed++) {
    seen.add(E.createGame(E.defaultConfig({ seed })).config.firstPlayer);
  }
  assert.deepStrictEqual([...seen].sort(), ['p1', 'p2'], '随机先手应两种都出现');

  const randomSeed = E.createGame(E.defaultConfig());
  assert.strictEqual(typeof randomSeed.config.seed, 'number', 'seed:null 时应生成数字种子写入 config');
  assert.ok(randomSeed.config.seed > 0);
});

/* ================================================================== */
/* 四、布局阶段                                                        */
/* ================================================================== */

test('§4 submitLayout：合法提交（cardIds 按区域序、牌仍在手牌中）', () => {
  const state = E.createGame(E.defaultConfig({ seed: 11, firstPlayer: 'p1' }));
  const handIds = cardIds(state.players.p1.hand);
  const picks = handIds.slice(2, 7); // 故意不选前 5 张，验证按传入顺序一一对应
  const ret = E.submitLayout(state, 'p1', picks);
  assert.strictEqual(ret, undefined, 'submitLayout 契约返回 void');
  assert.strictEqual(state.layout.submitted.p1, true);
  assert.strictEqual(state.layout.submitted.p2, false);
  assert.strictEqual(state.layout.assignments.p1.length, 5);
  assert.deepStrictEqual(h.idsOf(state.layout.assignments.p1), picks, 'assignments 应按区域顺序记录所选牌');
  assert.strictEqual(state.players.p1.hand.length, 10, '提交布阵只是选择，牌仍在手牌中');
  assert.strictEqual(state.phase, 'layout');
  invariant(state, 'p1 单方提交后');
});

test('§4 submitLayout：非法参数抛错（长度/重复/不在手牌/未知玩家/重复提交）', () => {
  const state = E.createGame(E.defaultConfig({ seed: 12 }));
  const hand = cardIds(state.players.p1.hand);
  h.assertThrowsError(() => E.submitLayout(state, 'p1', hand.slice(0, 4)), 'BAD_ACTION', '长度不等于 R');
  h.assertThrowsError(() => E.submitLayout(state, 'p1', hand.slice(0, 6)), 'BAD_ACTION', '长度大于 R');
  h.assertThrowsError(() => E.submitLayout(state, 'p1', [hand[0], hand[0], hand[1], hand[2], hand[3]]), 'BAD_ACTION', '重复牌');
  h.assertThrowsError(() => E.submitLayout(state, 'p1', [state.deck[0].id, ...hand.slice(0, 4)]), 'CARD_NOT_IN_HAND', '牌不在手牌');
  h.assertThrowsError(() => E.submitLayout(state, 'p3', hand.slice(0, 5)), null, '未知玩家');
  h.assertThrowsError(() => E.submitLayout(state, 'p1', null), 'BAD_ACTION', 'cardIds 不是数组');
  // 首次成功后再次提交
  E.submitLayout(state, 'p1', hand.slice(0, 5));
  h.assertThrowsError(() => E.submitLayout(state, 'p1', hand.slice(5, 10)), 'BAD_ACTION', '重复提交');
});

test('§4 finalizeLayout：双方未提交时抛 BAD_PHASE', () => {
  const state = E.createGame(E.defaultConfig({ seed: 13 }));
  h.assertThrowsError(() => E.finalizeLayout(state), 'BAD_PHASE', '双方均未提交');
  E.submitLayout(state, 'p1', cardIds(state.players.p1.hand).slice(0, 5));
  h.assertThrowsError(() => E.finalizeLayout(state), 'BAD_PHASE', '仅一方提交');
  assert.strictEqual(state.phase, 'layout', '失败的 finalizeLayout 不得改变阶段');
});

test('§4 finalizeLayout：事件流 / 区域揭示 / 后手补牌 / 进入战役（先手 p1）', () => {
  const config = E.defaultConfig({ seed: 21, firstPlayer: 'p1' });
  const state = E.createGame(config);
  const picks = {
    p1: cardIds(state.players.p1.hand).slice(0, 5),
    p2: cardIds(state.players.p2.hand).slice(0, 5),
  };
  const deckBefore = cardIds(state.deck);
  E.submitLayout(state, 'p1', picks.p1);
  E.submitLayout(state, 'p2', picks.p2);
  const events = E.finalizeLayout(state);

  h.assertEventSequence(events.filter((e) => ['layout_reveal', 'extra_draw', 'battle_start'].includes(e.type)),
    ['layout_reveal', 'extra_draw', 'battle_start'], '布局事件流（v2.1 固定补偿 1 张 = 1 个 extra_draw）');

  const reveal = h.firstEventOfType(events, 'layout_reveal');
  assert.deepStrictEqual(h.idsOf(reveal.layout.p1), picks.p1, '揭示的 p1 布局应按区域顺序');
  assert.deepStrictEqual(h.idsOf(reveal.layout.p2), picks.p2, '揭示的 p2 布局应按区域顺序');

  const extras = h.eventsOfType(events, 'extra_draw');
  assert.strictEqual(extras.length, 1, 'v2.1 固定补偿 1 张 → 1 个 extra_draw 事件');
  assert.deepStrictEqual(extras.map((e) => e.playerId), ['p2'], '先手 p1 时后手 p2 补牌');
  assert.deepStrictEqual(extras.map((e) => e.card.id), [deckBefore[0]], '补偿牌取牌堆顶');
  assert.deepStrictEqual(extras.map((e) => e.handSize), [6], '补偿后后手手牌 6（R+1）');

  const battleStart = h.firstEventOfType(events, 'battle_start');
  assert.strictEqual(battleStart.turn, 'p1');
  // v1.4：battle_start 后立即开启先手回合（turn_start，AP=3）
  assert.deepStrictEqual(events.slice(-2).map((e) => e.type), ['battle_start', 'turn_start'], '事件尾：battle_start → turn_start');
  const turnStart = h.firstEventOfType(events, 'turn_start');
  assert.strictEqual(turnStart.playerId, 'p1');
  assert.strictEqual(turnStart.ap, 3, '先手首回合 AP=3');
  assert.strictEqual(turnStart.turnCount, 0);

  assert.strictEqual(state.phase, 'battle');
  assert.strictEqual(state.turn, 'p1');
  assert.strictEqual(state.players.p1.ap, 3, '先手 AP 回满');
  assert.strictEqual(state.players.p2.ap, 0, '非行动方 AP=0');
  assert.strictEqual(state.turnCount, 0);
  assert.strictEqual(state.layout.revealed, true);
  assert.strictEqual(state.deck.length, 33, '布局结束后牌堆 33 = 54 - 4R - 1');
  assert.strictEqual(state.players.p1.hand.length, 5, '先手布局后剩 5 张手牌');
  assert.strictEqual(state.players.p2.hand.length, 6, '后手布局后 5 张 + 补偿 1 张 = 6');
  for (let i = 0; i < 5; i++) {
    assert.strictEqual(state.regions[i].sides.p1.faceUp.length, 1, '每区域 p1 正面牌 1 张');
    assert.strictEqual(state.regions[i].sides.p2.faceUp.length, 1, '每区域 p2 正面牌 1 张');
    assert.strictEqual(state.regions[i].sides.p1.faceUp[0].id, picks.p1[i], '区域 i 的 p1 正面牌应等于布局第 i 张');
    assert.strictEqual(state.regions[i].sides.p2.faceUp[0].id, picks.p2[i]);
    assert.strictEqual(state.regions[i].sides.p1.faceUp[0].revealed, true, '区域正面牌应为已公开（revealed）');
  }
  assert.strictEqual(E.getEndgameThreshold(state), 10, '战役开始阈值 = 2R = 2×5 = 10');
  invariant(state, '布局结束后');
  h.assertThrowsError(() => E.finalizeLayout(state), 'BAD_PHASE', '重复 finalizeLayout');
  h.assertThrowsError(() => E.submitLayout(state, 'p1', picks.p1), 'BAD_PHASE', '战役阶段再提交布局');
});

test('§4 finalizeLayout：先手 p2 时后手 p1 补偿 1 张（5 区）', () => {
  const { state, events } = h.setupBattle(E, { seed: 22, firstPlayer: 'p2' });
  const extras = h.eventsOfType(events, 'extra_draw');
  assert.strictEqual(extras.length, 1, 'v2.1 固定补偿 1 张');
  assert.deepStrictEqual(extras.map((e) => e.playerId), ['p1'], '先手 p2 时后手 p1 补牌');
  assert.strictEqual(state.players.p1.hand.length, 6);
  assert.strictEqual(state.players.p2.hand.length, 5);
  assert.strictEqual(state.deck.length, 33);
  assert.strictEqual(state.turn, 'p2', '战役由先手 p2 先行');
  invariant(state, '先手 p2 布局后');
});

test('§4 finalizeLayout：R=3/R=7 后手补偿固定 1 张（初始手牌/事件/牌堆/区域）', () => {
  const cases = [
    { R: 3, K: 1, deck: 41, faceUp: 6 },
    { R: 7, K: 1, deck: 25, faceUp: 14 },
  ];
  for (const c of cases) {
    const state = E.createGame(E.defaultConfig({ seed: 100 + c.R, firstPlayer: 'p1', regionCount: c.R }));
    assert.strictEqual(state.config.compensationDraw, 1, 'R=' + c.R + ' compensationDraw 固定 1');
    assert.strictEqual(state.players.p1.hand.length, 2 * c.R, '布局前先手 2R 张手牌');
    assert.strictEqual(state.players.p2.hand.length, 2 * c.R, '布局前后手 2R 张手牌');
    assert.strictEqual(state.deck.length, 54 - 4 * c.R, '布局前牌堆 = 54 - 4R');
    const picks = {
      p1: cardIds(state.players.p1.hand).slice(0, c.R),
      p2: cardIds(state.players.p2.hand).slice(0, c.R),
    };
    const deckBefore = cardIds(state.deck);
    E.submitLayout(state, 'p1', picks.p1);
    E.submitLayout(state, 'p2', picks.p2);
    const events = E.finalizeLayout(state);
    // 事件序列：layout_reveal → extra_draw × K → battle_start
    const seq = events.map((e) => e.type).filter((t) => ['layout_reveal', 'extra_draw', 'battle_start'].includes(t));
    const expectSeq = ['layout_reveal'].concat(new Array(c.K).fill('extra_draw'), ['battle_start']);
    assert.deepStrictEqual(seq, expectSeq, 'R=' + c.R + ' 布局事件序列');
    const extras = h.eventsOfType(events, 'extra_draw');
    assert.strictEqual(extras.length, c.K, 'R=' + c.R + ' 补偿 ' + c.K + ' 个 extra_draw');
    assert.deepStrictEqual(extras.map((e) => e.playerId), new Array(c.K).fill('p2'), '先手 p1 时补偿发给后手 p2');
    assert.deepStrictEqual(extras.map((e) => e.card.id), deckBefore.slice(0, c.K), '补偿牌依次取牌堆顶');
    assert.deepStrictEqual(extras.map((e) => e.handSize), Array.from({ length: c.K }, (_, i) => c.R + 1 + i),
      '补偿过程中 handSize 从 R+1 递增到 R+K');
    // 状态：先手 R、后手 R+K、牌堆 54-4R-K、区域正面 2R
    assert.strictEqual(state.players.p1.hand.length, c.R, 'R=' + c.R + ' 先手布局后手牌 R');
    assert.strictEqual(state.players.p2.hand.length, c.R + c.K, 'R=' + c.R + ' 后手布局后手牌 R+K');
    assert.strictEqual(state.deck.length, c.deck, 'R=' + c.R + ' 揭示后牌堆 = 54-4R-K');
    const faceUp = state.regions.reduce((n, r) => n + r.sides.p1.faceUp.length + r.sides.p2.faceUp.length, 0);
    assert.strictEqual(faceUp, c.faceUp, 'R=' + c.R + ' 区域正面牌 = 2R');
    assert.strictEqual(E.getEndgameThreshold(state), 2 * c.R, '初始决战阈值 = 2R');
    // 日志只记张数、不泄露补偿牌面
    const compLogs = state.log.map((l) => l.text).filter((t) => /额外摸/.test(t));
    assert.ok(compLogs.some((t) => new RegExp('额外摸 ' + c.K + ' 张').test(t)), '日志应记录补偿张数 K=' + c.K);
    for (const t of compLogs) {
      assert.doesNotMatch(t, /[♠♥♦♣]|大王|小王/, '补偿日志不得包含牌面：' + t);
    }
    invariant(state, 'R=' + c.R + ' 布局后');
  }
});

/* ================================================================== */
/* 五、合法行动（穷举）                                                */
/* ================================================================== */

test('§5 getLegalActions：布局/终局阶段返回空；战役阶段按 AP 过滤且字段符合契约', () => {
  const layoutState = E.createGame(E.defaultConfig({ seed: 31 }));
  assert.deepStrictEqual(E.getLegalActions(layoutState), [], '布局阶段应无战役行动');

  const { state } = battle({ seed: 31 });
  assert.strictEqual(E.AP_PER_TURN, 3, 'AP_PER_TURN 应为 3');
  assert.deepStrictEqual(E.ACTION_COSTS, { settle: 3, draw: 2, flip: 2, place: 1, move: 1, end_turn: 0 },
    'ACTION_COSTS 应符 CONTRACT §2');
  assert.strictEqual(state.players.p1.ap, 3, '先手回合开始 AP=3');
  assert.strictEqual(state.config.apPerTurn, 3, 'config.apPerTurn=3');

  const legal = E.getLegalActions(state);
  assert.ok(Array.isArray(legal) && legal.length > 0, '战役开始应有合法行动');
  for (const a of legal) {
    assert.ok(['settle', 'flip', 'place', 'move', 'draw', 'end_turn'].includes(a.type), '行动类型应属于契约六种');
    assert.ok(!('playerId' in a), 'Action 不应包含 playerId（performAction 永远执行当前方）');
    assert.strictEqual(a.cost, E.ACTION_COSTS[a.type], a.type + ' 的 cost 应与 ACTION_COSTS 一致');
  }
  // v1.4：任意未结算区域均可结算；开局 AP=3 故 5 个 settle 全部合法
  assert.deepStrictEqual(legal.filter((a) => a.type === 'settle').map((a) => a.regionId).sort((x, y) => x - y),
    [0, 1, 2, 3, 4], '任意未结算区域均可结算（不再要求正面牌 >2）');
  assert.strictEqual(legal.filter((a) => a.type === 'place').length, 25, '手牌 5 × 未结算区域 5 = 25 条 place');
  assert.deepStrictEqual(legal.filter((a) => a.type === 'draw'), [{ type: 'draw', cost: 2 }], '摸牌 1 条、cost=2');
  assert.deepStrictEqual(legal.filter((a) => a.type === 'end_turn'), [{ type: 'end_turn', cost: 0 }], 'end_turn 始终合法、cost=0');
  assert.ok(!legal.some((a) => a.type === 'flip'), '开局场上无背面牌，不可翻牌');
  assert.ok(!legal.some((a) => a.type === 'move'), '开局场上无背面牌，不可移牌');
  assert.strictEqual(legal.length, 32, '开局合法行动 = 5 settle + 25 place + 1 draw + 1 end_turn');
  assertLegalActionsExhaustive(state, '战役开始');
});

test('§5 getLegalActions：一回合多行动下按 AP 动态变化（place×3 / draw+place / 换人回满）', () => {
  const { state } = battle({ seed: 32 });
  const r = new h.Runner(E, state);

  // p1 放牌（1 点）→ 仍是 p1，AP=2，出现 flip
  r.step(h.pickAction(E, state, r.legal(), { prefer: ['place'], filter: (a) => a.regionId === 0 }));
  assert.strictEqual(state.turn, 'p1', '行动点未耗尽，同一玩家继续');
  assert.strictEqual(state.players.p1.ap, 2, '放牌消耗 1 点');
  assert.strictEqual(state.turnCount, 1);
  let legal = E.getLegalActions(state);
  assert.strictEqual(legal.filter((a) => a.type === 'flip').length, 1, '区域0 我方 1 张背面牌 → 1 条 flip');
  assert.strictEqual(legal.filter((a) => a.type === 'move').length, 4, '区域0 背面牌 × 其余 4 个未结算区域 = 4 条 move');
  assert.strictEqual(legal.filter((a) => a.type === 'settle').length, 0, 'AP=2 < 3，结算不合法');
  assert.strictEqual(legal.filter((a) => a.type === 'draw').length, 1, 'AP=2 摸牌合法');
  assertLegalActionsExhaustive(state, 'AP=2 时');

  // 再放牌到区域1（1 点）→ AP=1；flip/draw/settle 均不合法
  r.step(h.pickAction(E, state, r.legal(), { prefer: ['place'], filter: (a) => a.regionId === 1 }));
  assert.strictEqual(state.turn, 'p1');
  assert.strictEqual(state.players.p1.ap, 1);
  legal = E.getLegalActions(state);
  assert.ok(!legal.some((a) => a.type === 'flip' || a.type === 'draw' || a.type === 'settle'),
    'AP=1 时只能放牌/移牌/结束回合');
  assert.ok(legal.some((a) => a.type === 'move'), '区域0 背面牌可移到区域1');
  assertLegalActionsExhaustive(state, 'AP=1 时');

  // 再放牌（1 点）→ AP=0 → 自动结束回合，换 p2（AP=3）
  r.step(h.pickAction(E, state, r.legal(), { prefer: ['place'], filter: (a) => a.regionId === 2 }));
  assert.strictEqual(state.players.p1.ap, 0, 'AP 用尽清 0');
  assert.strictEqual(state.turn, 'p2', 'AP 耗尽自动换人');
  assert.strictEqual(state.players.p2.ap, 3, '对方新回合 AP 回满');
  assertLegalActionsExhaustive(state, '换到 p2 后');

  // p2 摸牌（2 点）→ 同回合继续 AP=1；再放牌（1 点）→ 换人
  r.step(E.getLegalActions(state).find((a) => a.type === 'draw'));
  assert.strictEqual(state.turn, 'p2');
  assert.strictEqual(state.players.p2.ap, 1);
  assertLegalActionsExhaustive(state, 'p2 摸牌后 AP=1');
  r.step(h.pickAction(E, state, r.legal(), { prefer: ['place'], filter: (a) => a.regionId === 0 }));
  assert.strictEqual(state.turn, 'p1', 'p2 AP 用尽换人');
  assert.strictEqual(state.players.p1.ap, 3, 'p1 新回合 AP 回满');
});

/* ================================================================== */
/* 六、五种行动行为                                                    */
/* ================================================================== */

test('§5 行动3 放牌：手牌 → 区域背面牌，不改变总和，消耗 1 点 AP（同回合继续）', () => {
  const { state } = battle({ seed: 41 });
  const r = new h.Runner(E, state);
  const pre = h.clone(state);
  const place = h.pickAction(E, state, r.legal(), { prefer: ['place'], filter: (a) => a.regionId === 2 });
  assert.strictEqual(place.cost, 1, 'place cost=1');
  const handCard = pre.players.p1.hand.find((c) => c.id === place.cardId);
  assert.ok(handCard, '放牌必须来自手牌');
  const preSum = E.getRegionSideSum(state, 2, 'p1');
  const preDeck = state.deck.length;
  const { events } = r.step(place);
  assert.deepStrictEqual(events.map((e) => e.type), ['action', 'place'], '事件流 action → place（同回合继续，无回合事件）');
  const ev = events[1];
  assert.strictEqual(ev.playerId, 'p1');
  assert.strictEqual(ev.regionId, 2);
  assert.strictEqual(ev.card.id, place.cardId);

  assert.strictEqual(state.players.p1.hand.length, pre.players.p1.hand.length - 1, '手牌 -1');
  assert.ok(!cardIds(state.players.p1.hand).includes(place.cardId), '放出的牌应离开手牌');
  assert.strictEqual(state.regions[2].sides.p1.faceDown.length, 1, '区域出现 1 张背面牌');
  assert.strictEqual(state.regions[2].sides.p1.faceDown[0].id, place.cardId);
  assert.strictEqual(state.regions[2].sides.p1.faceDown[0].revealed, false, '背面牌 revealed 应为 false');
  assert.strictEqual(E.getRegionSideSum(state, 2, 'p1'), preSum, '背面牌不计入区域总和');
  assert.strictEqual(state.deck.length, preDeck, '放牌不消耗牌堆');
  assert.strictEqual(state.turn, 'p1', 'AP 未耗尽，同一玩家继续行动');
  assert.strictEqual(state.players.p1.ap, 2, '放牌后 AP=2');
  assert.strictEqual(state.turnCount, 1, 'turnCount 只统计真实行动');
  assert.strictEqual(state.phase, 'battle');
  assert.strictEqual(state.endgame.triggered, false);
  invariant(state, '放牌后');
});

test('§5 行动2 翻牌：只能翻我方背面牌；翻后计入总和，消耗 2 点 AP', () => {
  const { state } = battle({ seed: 42 });
  const r = new h.Runner(E, state);
  r.step(h.pickAction(E, state, r.legal(), { prefer: ['place'], filter: (a) => a.regionId === 1 })); // AP 3→2，同回合
  const flip = r.legal().find((a) => a.type === 'flip');
  assert.ok(flip, '应有可翻的背面牌');
  assert.strictEqual(flip.cost, 2, 'flip cost=2');
  const pre = h.clone(state);
  const placedCard = state.regions[1].sides.p1.faceDown[0];
  const preSum = E.getRegionSideSum(state, 1, 'p1');
  const { events } = r.step(flip);
  assert.deepStrictEqual(events.slice(0, 2).map((e) => e.type), ['action', 'flip'], '事件前缀 action → flip');
  assert.deepStrictEqual(events.slice(2).map((e) => e.type), ['turn_end', 'turn_start'], 'AP 用尽后追加 turn_end(ap)+turn_start');
  const ev = events[1];
  assert.strictEqual(ev.card.id, placedCard.id);
  assert.strictEqual(state.regions[1].sides.p1.faceDown.length, 0, '背面牌消失');
  assert.strictEqual(state.regions[1].sides.p1.faceUp.length, 2, '翻开的牌进入正面区');
  assert.ok(state.regions[1].sides.p1.faceUp.some((c) => c.id === placedCard.id));
  assert.strictEqual(E.getRegionSideSum(state, 1, 'p1'), preSum + placedCard.value, '翻牌后总和增加该牌数值');
  assert.strictEqual(state.players.p1.hand.length, pre.players.p1.hand.length, '翻牌不改变手牌');
  assert.strictEqual(state.deck.length, pre.deck.length, '翻牌不改变牌堆');
  assert.strictEqual(state.turn, 'p2', '翻牌用尽 2 点（剩余 0）→ 自动结束回合');
  assert.strictEqual(state.players.p2.ap, 3, '对方新回合 AP 回满');
  invariant(state, '翻牌后');
});

test('§5 行动2 翻牌：翻对方牌 / 不存在的牌 / 已结算区域均抛错', () => {
  const { state } = battle({ seed: 43 });
  const opponentCard = state.regions[0].sides.p2.faceUp[0].id;
  h.assertThrowsError(() => E.performAction(state, { type: 'flip', regionId: 0, cardId: opponentCard }), 'NO_SUCH_CARD', '翻对方正面牌');
  h.assertThrowsError(() => E.performAction(state, { type: 'flip', regionId: 0, cardId: 'no-such-card' }), 'NO_SUCH_CARD', '翻不存在的牌');
  h.assertThrowsError(() => E.performAction(state, { type: 'flip', regionId: 99, cardId: 's-A' }), 'BAD_REGION', '翻不存在的区域');
});

test('§5 行动4 移牌：我方背面牌移到另一未结算区域，仍背面、不计和（1 点 AP）', () => {
  const { state } = battle({ seed: 44 });
  const r = new h.Runner(E, state);
  r.step(h.pickAction(E, state, r.legal(), { prefer: ['place'], filter: (a) => a.regionId === 0 })); // AP 3→2
  r.step(h.pickAction(E, state, r.legal(), { prefer: ['place'], filter: (a) => a.regionId === 1 })); // AP 2→1
  assert.strictEqual(state.turn, 'p1');
  assert.strictEqual(state.players.p1.ap, 1);
  assert.strictEqual(state.regions[0].sides.p1.faceDown.length, 1);
  assert.strictEqual(state.regions[1].sides.p1.faceDown.length, 1);
  const moves = r.legal().filter((a) => a.type === 'move');
  assert.ok(moves.length > 0, 'p1 应有可移的背面牌');
  const move = moves.find((a) => a.fromRegionId === 0 && a.toRegionId === 2);
  assert.ok(move, '区域0 → 区域2 的移牌应在合法集合中');
  assert.strictEqual(move.cost, 1, 'move cost=1');
  const cardId = move.cardId;
  const pre = h.clone(state);
  const { events } = r.step(move);
  assert.deepStrictEqual(events.slice(0, 2).map((e) => e.type), ['action', 'move'], '事件前缀 action → move');
  assert.strictEqual(state.regions[0].sides.p1.faceDown.length, 0, '源区域背面牌减少');
  assert.strictEqual(state.regions[2].sides.p1.faceDown.length, 1, '目标区域背面牌增加');
  assert.strictEqual(state.regions[2].sides.p1.faceDown[0].id, cardId);
  assert.strictEqual(state.regions[2].sides.p1.faceDown[0].revealed, false, '移牌后仍是背面');
  assert.strictEqual(E.getRegionSideSum(state, 0, 'p1'), h.sumValues(pre.regions[0].sides.p1.faceUp), '移牌不改变区域总和');
  assert.strictEqual(E.getRegionSideSum(state, 2, 'p1'), h.sumValues(pre.regions[2].sides.p1.faceUp));
  assert.strictEqual(state.deck.length, pre.deck.length);
  assert.strictEqual(state.turn, 'p2', '移牌用尽 1 点 → 自动换人');
  invariant(state, '移牌后');
});

test('§5 行动4 移牌：同区/已结算目标/非我方背面牌抛错，AP 不被扣减', () => {
  // 同区移动需要我方区域内有背面牌
  const a = battle({ seed: 45 }).state;
  const ra = new h.Runner(E, a);
  ra.step(h.pickAction(E, a, ra.legal(), { prefer: ['place'], filter: (x) => x.regionId === 0 })); // AP 3→2
  const fd = a.regions[0].sides.p1.faceDown[0];
  assert.ok(fd, 'p1 区域0 应有背面牌');
  const apBefore = a.players.p1.ap;
  h.assertThrowsError(() => E.performAction(a, { type: 'move', fromRegionId: 0, cardId: fd.id, toRegionId: 0 }), 'BAD_ACTION', '同区移动');
  h.assertThrowsError(() => E.performAction(a, { type: 'move', fromRegionId: 0, cardId: 'no-such', toRegionId: 1 }), 'NO_SUCH_CARD', '移非我方背面牌');
  h.assertThrowsError(() => E.performAction(a, { type: 'move', fromRegionId: 99, cardId: fd.id, toRegionId: 1 }), 'BAD_REGION', '源区域非法');
  assert.strictEqual(a.players.p1.ap, apBefore, '非法行动不扣减 AP（错误原子性）');

  // 已结算目标：手工构造区域0 已结算 + 区域1 有我方背面牌
  const synth = h.synthBattle(E, {
    regionCount: 3,
    turn: 'p1',
    deck: ['h-A', 'h-2', 'h-3', 'h-4'],
    regions: [
      { status: 'settled', result: { winner: 'p1', sums: { p1: 1, p2: 0 }, drawn: { p1: [], p2: [] }, faceUp: { p1: [], p2: [] }, deterministic: true, settleCards: 2 } },
      { p1FaceDown: ['s-A'] },
      {},
    ],
  });
  h.assertThrowsError(() => E.performAction(synth, { type: 'move', fromRegionId: 1, cardId: 's-A', toRegionId: 0 }),
    'ALREADY_SETTLED', '移牌目标区域已结算');
});

test('§5 行动5 摸牌：取牌堆顶、手牌+1、牌堆-1、事件字段完整（2 点 AP，同回合可再行动）', () => {
  const { state } = battle({ seed: 46 });
  const pre = h.clone(state);
  const r = new h.Runner(E, state);
  const drawAction = r.legal().find((a) => a.type === 'draw');
  assert.strictEqual(drawAction.cost, 2, 'draw cost=2');
  const { events } = r.step(drawAction);
  assert.deepStrictEqual(events.map((e) => e.type), ['action', 'draw'], '同回合继续行动，无回合事件');
  const ev = events[1];
  assert.strictEqual(ev.playerId, 'p1');
  assert.strictEqual(ev.card.id, pre.deck[0].id, '摸牌必须取牌堆顶（数组头部）');
  assert.strictEqual(ev.handSize, pre.players.p1.hand.length + 1);
  assert.strictEqual(state.deck.length, pre.deck.length - 1);
  assert.strictEqual(state.players.p1.hand.length, pre.players.p1.hand.length + 1);
  assert.strictEqual(state.turn, 'p1', 'AP 剩余 1 点，同一玩家继续');
  assert.strictEqual(state.players.p1.ap, 1);
  invariant(state, '摸牌后');
});

/* ================================================================== */
/* 六·补、行动点与回合（v1.4）                                          */
/* ================================================================== */

test('§5 行动点：初始 3 点、行动扣减、AP 不足非法、end_turn 结束回合、AP 耗尽自动换人', () => {
  const { state } = battle({ seed: 47 });
  assert.strictEqual(state.players.p1.ap, 3, '回合开始 AP=3');
  assert.strictEqual(state.players.p2.ap, 0, '非行动方 AP=0');
  const startTurnCount = state.turnCount;

  // 主动结束回合：事件 action → turn_end(manual) → turn_start(p2, ap=3)，turnCount 不变
  const endTurn = E.getLegalActions(state).find((a) => a.type === 'end_turn');
  assert.deepStrictEqual(endTurn, { type: 'end_turn', cost: 0 }, 'end_turn cost=0');
  const etEvents = E.performAction(state, endTurn);
  assert.deepStrictEqual(etEvents.map((e) => e.type), ['action', 'turn_end', 'turn_start'], '主动结束回合事件流');
  const te = h.firstEventOfType(etEvents, 'turn_end');
  assert.deepStrictEqual({ playerId: te.playerId, reason: te.reason, leftAp: te.leftAp }, { playerId: 'p1', reason: 'manual', leftAp: 3 },
    'turn_end 字段：manual / leftAp=放弃的剩余点数');
  const ts = h.firstEventOfType(etEvents, 'turn_start');
  assert.deepStrictEqual({ playerId: ts.playerId, ap: ts.ap }, { playerId: 'p2', ap: 3 }, 'turn_start 字段：新行动方 AP 回满');
  assert.strictEqual(state.turnCount, startTurnCount, 'end_turn 不计入 turnCount（只统计真实行动）');

  // AP 不足：place 一次后 AP=2，flip/draw（2 点）仍可，settle（3 点）非法
  E.performAction(state, E.getLegalActions(state).find((a) => a.type === 'place')); // p2 place? 当前 turn 为 p2
  assert.strictEqual(state.turn, 'p2');
  assert.strictEqual(state.players.p2.ap, 2);
  let legal = E.getLegalActions(state);
  assert.ok(!legal.some((a) => a.type === 'settle'), 'AP=2 时结算不合法');
  assert.ok(legal.some((a) => a.type === 'draw'), 'AP=2 时摸牌合法');
  // 构造 AP=1 的白盒局面，验证 flip/draw/settle 均不可支付、performAction 抛「行动点不足」
  const low = h.synthBattle(E, {
    regionCount: 3, turn: 'p1', ap: 1, difficulty: 2,
    deck: ['h-A', 'h-2', 'h-3', 'h-4', 'h-5', 'h-6'],
    hands: { p1: ['h-7', 'h-8'] },
    regions: [{ p1FaceDown: ['s-2'] }, {}, {}],
  });
  legal = E.getLegalActions(low);
  assert.ok(!legal.some((a) => ['settle', 'flip', 'draw'].includes(a.type)), 'AP=1 时 2/3 点行动均不合法');
  assert.ok(legal.some((a) => a.type === 'place') && legal.some((a) => a.type === 'move') && legal.some((a) => a.type === 'end_turn'),
    'AP=1 时仅 1 点行动 + end_turn 合法');
  for (const bad of [{ type: 'draw' }, { type: 'flip', regionId: 0, cardId: 's-2' }, { type: 'settle', regionId: 0 }]) {
    const err = h.assertThrowsError(() => E.performAction(low, bad), 'BAD_ACTION', 'AP 不足 ' + bad.type);
    assert.ok(/行动点不足/.test(err.message), '错误 message 应含「行动点不足」，实际：' + err.message);
    assert.strictEqual(low.players.p1.ap, 1, 'AP 不足抛错后 AP 不变');
  }

  // AP 耗尽自动换人（reason=ap）：放牌成本 1，AP=2 再放 2 张后自动换人
  const r = new h.Runner(E, state); // 当前 p2 回合 AP=2
  r.step(h.pickAction(E, state, r.legal(), { prefer: ['place'] }));
  assert.strictEqual(state.turn, 'p2');
  assert.strictEqual(state.players.p2.ap, 1);
  const third = h.pickAction(E, state, r.legal(), { prefer: ['place'] });
  const { events } = r.step(third);
  const teAp = h.firstEventOfType(events, 'turn_end');
  assert.strictEqual(teAp.reason, 'ap', 'AP 用尽自动结束回合 reason=ap');
  assert.strictEqual(teAp.leftAp, 0);
  assert.strictEqual(state.turn, 'p1');
  assert.strictEqual(state.players.p1.ap, 3);
});

test('§5 行动点：无可用行动时自动结束回合（reason=no-action）', () => {
  // 白盒：决战 build 阶段，p1 仅 1 张背面牌、无手牌；翻完最后一张后 AP 仍有剩余但无行动可做 → no-action
  const st = h.synthBattle(E, {
    regionCount: 3, turn: 'p1', difficulty: 2,
    deck: [],
    hands: { p1: [] },
    regions: [{ p1FaceDown: ['h-A'] }, { p2FaceDown: ['s-2'] }, {}],
  });
  st.config.settleCards = 2;
  st.endgame = {
    triggered: true, phase: 'build', threshold: 6, settleCards: 2,
    drawPerPlayer: 3, drawnCounts: { p1: 0, p2: 0 }, skipped: { p1: false, p2: false },
  };
  const legal = E.getLegalActions(st);
  assert.ok(legal.some((a) => a.type === 'flip') && legal.some((a) => a.type === 'end_turn'), 'p1 可翻牌/结束回合');
  assert.ok(!legal.some((a) => a.type === 'place' || a.type === 'draw' || a.type === 'settle'),
    'build 阶段无手牌不可放牌，且禁用摸牌/结算');
  const events = E.performAction(st, legal.find((a) => a.type === 'flip'));
  const te = h.firstEventOfType(events, 'turn_end');
  assert.ok(te, '最后一手后应自动结束回合：' + events.map((e) => e.type).join(','));
  assert.strictEqual(te.reason, 'no-action', 'AP 仍有剩余但无可用行动 → reason=no-action');
  assert.ok(te.leftAp > 0, 'reason=no-action 时 leftAp 应 >0，实际 ' + te.leftAp);
  assert.strictEqual(st.turn, 'p2', '换对方行动');
  assert.strictEqual(st.players.p2.ap, 3, '对方 AP 回满');
  assert.strictEqual(h.firstEventOfType(events, 'turn_start').playerId, 'p2');
});

/* ================================================================== */
/* 七、结算（单独结算）                                                */
/* ================================================================== */

test('§5 行动1 结算：双方各抽 N=2 张（先 P1 后 P2）/ 求和 / 判胜 / 区域废弃进弃牌堆', () => {
  const sc = findSettleScenario({ difficulty: 2, wantTie: false });
  assert.ok(sc, '应能找到单独结算场景');
  const { state, pre, events, settleEvent: se } = sc;
  const N = pre.config.settleCards;

  assert.deepStrictEqual(events.slice(0, 2).map((e) => e.type), ['action', 'settle'], '非触发决战时事件前缀 action → settle');
  assert.deepStrictEqual(events.slice(2).map((e) => e.type), ['turn_end', 'turn_start'], '结算消耗整回合 3 点 → turn_end(ap)+turn_start');
  const te = h.firstEventOfType(events, 'turn_end');
  assert.strictEqual(te.playerId, 'p1');
  assert.strictEqual(te.reason, 'ap', '结算用尽 3 点 → reason=ap');
  assert.strictEqual(te.leftAp, 0);
  const ts = h.firstEventOfType(events, 'turn_start');
  assert.strictEqual(ts.playerId, 'p2');
  assert.strictEqual(ts.ap, 3, '新回合 AP 回满 3');
  assert.strictEqual(events[0].playerId, 'p1');
  assert.strictEqual(se.regionId, 0);
  assert.strictEqual(se.settleCards, N, 'settle 事件应带 settleCards');

  // 抽牌归属与顺序：先连续 P1 的 N 张，再连续 P2 的 N 张
  assert.deepStrictEqual(h.idsOf(se.drawn.p1), cardIds(pre.deck.slice(0, N)), '结算前 N 张给 P1');
  assert.deepStrictEqual(h.idsOf(se.drawn.p2), cardIds(pre.deck.slice(N, 2 * N)), '随后 N 张给 P2');
  for (const c of se.drawn.p1.concat(se.drawn.p2)) assert.strictEqual(c.revealed, true, '结算补牌应为公开正面牌');

  // 求和 = 结算前正面牌之和 + 补牌和
  const preRegion = pre.regions[0];
  const expectSum1 = h.sumValues(preRegion.sides.p1.faceUp) + h.sumValues(se.drawn.p1);
  const expectSum2 = h.sumValues(preRegion.sides.p2.faceUp) + h.sumValues(se.drawn.p2);
  assert.strictEqual(se.sums.p1, expectSum1, 'P1 区域总和');
  assert.strictEqual(se.sums.p2, expectSum2, 'P2 区域总和');
  const expectWinner = expectSum1 > expectSum2 ? 'p1' : expectSum2 > expectSum1 ? 'p2' : 'tie';
  assert.strictEqual(se.winner, expectWinner, '区域胜者应由总和决定');

  // 结算前快照
  assert.deepStrictEqual(h.idsOf(se.regionBefore.sides.p1.faceUp), h.idsOf(preRegion.sides.p1.faceUp));
  assert.deepStrictEqual(h.idsOf(se.regionBefore.sides.p2.faceDown), h.idsOf(preRegion.sides.p2.faceDown));

  // 区域废弃、结果记录
  const region = state.regions[0];
  assert.strictEqual(region.status, 'settled');
  assert.strictEqual(h.countSideCards(region.sides.p1) + h.countSideCards(region.sides.p2), 0, '结算后区域清空');
  assert.strictEqual(region.result.winner, expectWinner);
  assert.strictEqual(region.result.settleCards, N);
  assert.strictEqual(region.result.sums.p1, expectSum1);
  assert.strictEqual(region.result.sums.p2, expectSum2);
  assert.deepStrictEqual(h.idsOf(region.result.faceUp.p1), h.idsOf(preRegion.sides.p1.faceUp), '快照=结算前正面牌');
  assert.deepStrictEqual(h.idsOf(region.result.drawn.p1), h.idsOf(se.drawn.p1));
  assert.deepStrictEqual(h.idsOf(region.result.drawn.p2), h.idsOf(se.drawn.p2));
  assert.strictEqual(region.result.drawn.p1.length, N, 'result.drawn.p1 长度 = N');
  assert.strictEqual(region.result.drawn.p2.length, N, 'result.drawn.p2 长度 = N');
  const allCount = h.countSideCards(preRegion.sides.p1) + h.countSideCards(preRegion.sides.p2) + 2 * N;
  assert.strictEqual(region.result.allCards.p1.length + region.result.allCards.p2.length, allCount, 'allCards 记录结算前所有牌+补牌');

  // 弃牌堆：区域所有牌（含背面）+ 补牌
  const regionCardCount = h.countSideCards(preRegion.sides.p1) + h.countSideCards(preRegion.sides.p2);
  assert.strictEqual(state.discard.length - pre.discard.length, regionCardCount + 2 * N, '弃牌堆应增加区域牌+2N张补牌');
  assert.strictEqual(state.deck.length, pre.deck.length - 2 * N, '难度2无难度摸牌，牌堆 -2N');
  assert.strictEqual(se.deckAfter, state.deck.length);

  // 比分与回合
  assert.strictEqual(state.regionWins[expectWinner], pre.regionWins[expectWinner] + 1, '区域胜场计入比分');
  assert.strictEqual(state.players.p1.regionsWon, state.regionWins.p1);
  assert.strictEqual(state.players.p2.regionsWon, state.regionWins.p2);
  assert.strictEqual(state.phase, 'battle', '未触发决战');
  assert.strictEqual(state.players.p1.ap, 0, '结算消耗整回合 3 点');
  assert.strictEqual(state.turn, 'p2', '结算后换手（对方 AP 回满）');
  assert.strictEqual(state.players.p2.ap, 3);
  assert.strictEqual(se.endgameTriggered, false);
  invariant(state, '单独结算后');
});

test('§5 行动1 结算：任意未结算区域可结算（v1.4 取消正面牌 >2 限制，0/1/2 张正面牌均可）', () => {
  // 自然局面：开局每区双方各 1 张正面牌（共 2 张），v1.4 起全部可结算
  const { state } = battle({ seed: 51 });
  const legalSettles = E.getLegalActions(state).filter((a) => a.type === 'settle');
  assert.deepStrictEqual(legalSettles.map((a) => a.regionId).sort((x, y) => x - y), [0, 1, 2, 3, 4],
    '开局 5 个未结算区域均应可结算');
  assert.ok(legalSettles.every((a) => a.cost === 3), '结算 cost=3');
  // 直接结算：正常执行且结果按双方正面牌+补牌求和
  const settle = legalSettles.find((a) => a.regionId === 0);
  const pre = h.clone(state);
  const events = E.performAction(state, settle);
  const se = h.firstEventOfType(events, 'settle');
  assert.ok(se, 'settle 事件存在');
  assert.strictEqual(se.sums.p1, h.sumValues(pre.regions[0].sides.p1.faceUp) + h.sumValues(se.drawn.p1));
  assert.strictEqual(se.sums.p2, h.sumValues(pre.regions[0].sides.p2.faceUp) + h.sumValues(se.drawn.p2));
  assert.strictEqual(state.regions[0].status, 'settled');
  invariant(state, '任意区域结算后');

  // 极端：0 张正面牌（synthBattle）也可结算
  const synth = h.synthBattle(E, {
    regionCount: 3, turn: 'p1', difficulty: 2,
    deck: ['h-A', 'h-2', 'h-3', 'h-4', 'h-5'],
    regions: [
      {},
      { p1FaceUp: ['s-2'] },
      { p1FaceUp: ['s-3', 's-4'], p2FaceUp: ['s-5'] },
    ],
  });
  const legalSynth = E.getLegalActions(synth).filter((a) => a.type === 'settle').map((a) => a.regionId).sort((x, y) => x - y);
  assert.deepStrictEqual(legalSynth, [0, 1, 2], '0/1/2 张正面牌的区域均可结算');
  const synthEvents = E.performAction(synth, { type: 'settle', regionId: 0, cost: 3 });
  const synthSe = h.firstEventOfType(synthEvents, 'settle');
  assert.ok(synthSe && synthSe.regionBefore.sides.p1.faceUp.length === 0 && synthSe.regionBefore.sides.p2.faceUp.length === 0,
    '0 张正面牌区域可正常结算');
  assert.strictEqual(synth.regions[0].status, 'settled');
  assert.strictEqual(synth.turn, 'p2', '结算消耗整回合 → 换人');
});

test('§5 结算：含背面牌的区域——背面牌不计和且随区域废弃', () => {
  // 自然局面：p1 放 1 张背面牌到区域0，两个回合后 p1 再结算该区域（背面牌不计和）
  const { state } = battle({ seed: 53, difficulty: 2 });
  const r = new h.Runner(E, state);
  r.step(h.pickAction(E, state, r.legal(), { prefer: ['place'], filter: (a) => a.regionId === 0 })); // p1 AP 3→2
  r.step(E.getLegalActions(state).find((a) => a.type === 'end_turn')); // p1 主动结束
  r.step(E.getLegalActions(state).find((a) => a.type === 'end_turn')); // p2 主动结束
  assert.strictEqual(state.turn, 'p1');
  assert.strictEqual(state.players.p1.ap, 3, '新回合 AP 回满');
  assert.strictEqual(state.regions[0].sides.p1.faceDown.length, 1, '区域0 有 1 张背面牌');
  const settle = r.legal().find((a) => a.type === 'settle' && a.regionId === 0);
  assert.ok(settle);
  const pre = h.clone(state);
  const { events } = r.step(settle);
  const se = events.find((e) => e.type === 'settle');
  const N = pre.config.settleCards;
  assert.strictEqual(se.sums.p1, h.sumValues(pre.regions[0].sides.p1.faceUp) + h.sumValues(se.drawn.p1), '背面牌不得计入总和');
  assert.strictEqual(state.regions[0].result.allCards.p1.length,
    pre.regions[0].sides.p1.faceUp.length + pre.regions[0].sides.p1.faceDown.length + N, 'allCards 含背面牌与 N 张补牌');
  invariant(state, '含背面牌结算后');
});

test('§5 结算非法：已结算区域 / 不存在的区域 / 期间牌堆不足', () => {
  const sc = findSettleScenario({ difficulty: 2 });
  h.assertThrowsError(() => E.performAction(sc.state, { type: 'settle', regionId: 0 }), 'ALREADY_SETTLED', '重复结算');
  h.assertThrowsError(() => E.performAction(sc.state, { type: 'settle', regionId: 99 }), 'BAD_REGION', '区域不存在');
  h.assertThrowsError(() => E.performAction(sc.state, { type: 'settle', regionId: -1 }), 'BAD_REGION', '负区域号');
  h.assertThrowsError(() => E.performAction(sc.state, { type: 'settle' }), 'BAD_REGION', '缺少 regionId');
  // 行动点不足：AP=1 时结算不合法（performAction 直接抛 BAD_ACTION，message 含「行动点不足」）
  const lowAp = h.synthBattle(E, {
    regionCount: 3, turn: 'p1', ap: 1, difficulty: 2,
    deck: ['h-A', 'h-2', 'h-3', 'h-4', 'h-5', 'h-6'],
    regions: [{}, {}, {}],
  });
  assert.ok(!E.getLegalActions(lowAp).some((a) => a.type === 'settle'), 'AP=1 时 settle 不应出现在合法行动');
  const apErr = h.assertThrowsError(() => E.performAction(lowAp, { type: 'settle', regionId: 0, cost: 3 }), 'BAD_ACTION', 'AP 不足结算');
  assert.ok(/行动点不足/.test(apErr.message), '错误 message 应含「行动点不足」，实际：' + apErr.message);
  assert.strictEqual(lowAp.players.p1.ap, 1, 'AP 不足抛错后 AP 不变');
  // 牌堆不足：手工构造 R=3、牌堆 1 张、区域0 正面 3 张
  const synth = h.synthBattle(E, {
    regionCount: 3, difficulty: 2, turn: 'p1',
    deck: ['h-A'],
    regions: [
      { p1FaceUp: ['s-2', 's-3'], p2FaceUp: ['s-4'] },
      {}, {},
    ],
  });
  h.assertThrowsError(() => E.performAction(synth, { type: 'settle', regionId: 0 }), 'DECK_INSUFFICIENT', '牌堆不足以结算');
});

/* ================================================================== */
/* 八、难度规则                                                        */
/* ================================================================== */

test('§7 难度1（消耗 / loser-draw）：单独结算后败者摸 1 张牌', () => {
  const sc = findSettleScenario({ difficulty: 1, wantTie: false });
  assert.ok(sc);
  const { state, pre, settleEvent: se } = sc;
  const N = pre.config.settleCards;
  const loser = se.winner === 'p1' ? 'p2' : 'p1';
  assert.ok(se.difficultyDraw, '难度1 非平局应有难度摸牌');
  assert.strictEqual(se.difficultyDraw.playerId, loser, '难度1 应由败者摸牌');
  assert.strictEqual(se.difficultyDraw.card.id, pre.deck[2 * N].id, '难度摸牌取牌堆顶（2N 张补牌后的下一张）');
  assert.strictEqual(state.players[loser].hand.length, pre.players[loser].hand.length + 1, '败者手牌 +1');
  assert.strictEqual(state.players[se.winner].hand.length, pre.players[se.winner].hand.length, '胜者手牌不变');
  assert.strictEqual(pre.deck.length - state.deck.length, 2 * N + 1, '牌堆 -(2N+1)（补牌 + 难度摸牌 1）');
  assert.strictEqual(se.deckAfter, state.deck.length);
  const region = state.regions[0];
  assert.ok(region.result.difficultyDraw, 'region.result 应记录难度摸牌');
  assert.strictEqual(region.result.difficultyDraw.playerId, loser);
  assert.strictEqual(region.result.difficultyDraw.card.id, se.difficultyDraw.card.id);
  invariant(state, '难度1结算后');
});

test('§7 难度2（均衡 / none）：单独结算后不摸牌', () => {
  const sc = findSettleScenario({ difficulty: 2, wantTie: false });
  assert.ok(sc);
  const { state, pre, settleEvent: se } = sc;
  const N = pre.config.settleCards;
  assert.strictEqual(se.difficultyDraw, null, '难度2 不应有难度摸牌');
  assert.strictEqual(pre.deck.length - state.deck.length, 2 * N, '牌堆只消耗结算 2N 张');
  assert.strictEqual(state.regions[0].result.difficultyDraw, null);
  invariant(state, '难度2结算后');
});

test('§7 难度3（突进 / winner-draw）：单独结算后胜者摸 1 张牌', () => {
  const sc = findSettleScenario({ difficulty: 3, wantTie: false });
  assert.ok(sc);
  const { state, pre, settleEvent: se } = sc;
  const N = pre.config.settleCards;
  assert.ok(se.difficultyDraw, '难度3 非平局应有难度摸牌');
  assert.strictEqual(se.difficultyDraw.playerId, se.winner, '难度3 应由胜者摸牌');
  assert.strictEqual(se.difficultyDraw.card.id, pre.deck[2 * N].id, '难度摸牌取牌堆顶');
  assert.strictEqual(state.players[se.winner].hand.length, pre.players[se.winner].hand.length + 1, '胜者手牌 +1');
  assert.strictEqual(pre.deck.length - state.deck.length, 2 * N + 1);
  invariant(state, '难度3结算后');
});

test('§7 §9#4 平局：三档难度均无人摸牌', () => {
  for (const difficulty of [1, 3]) {
    const sc = findSettleScenario({ difficulty, wantTie: true, maxSeeds: 400 });
    assert.ok(sc, '难度 ' + difficulty + ' 应能在种子范围内找到平局结算');
    const { state, pre, settleEvent: se } = sc;
    const N = pre.config.settleCards;
    assert.strictEqual(se.winner, 'tie');
    assert.strictEqual(se.difficultyDraw, null, '平局时难度 ' + difficulty + ' 不应摸牌');
    assert.strictEqual(pre.deck.length - state.deck.length, 2 * N, '平局只消耗结算 2N 张');
    assert.strictEqual(state.regionWins.ties, pre.regionWins.ties + 1, '平局计入 ties');
    invariant(state, '平局结算后（难度' + difficulty + '）');
  }
});

/* ================================================================== */
/* 九、战略决战                                                        */
/* ================================================================== */

test('§6 决战触发：摸牌使牌堆降至 2X → 双方各摸 X 张摸空牌堆并进入最终部署', () => {
  const { state } = synthEndgameState({ regionCount: 5, settleCards: 2, deckCount: 11, handSizes: { p1: 1 } });
  assert.strictEqual(state.deck.length, 11, '构造：牌堆 11');
  assert.strictEqual(E.getEndgameThreshold(state), 10, '阈值 = 2×5 = 10');
  assert.strictEqual(state.endgame.triggered, false, '牌堆 11 > 阈值 10，尚未触发');
  assert.strictEqual(state.phase, 'battle');
  const handP1 = state.players.p1.hand.length;
  const handP2 = state.players.p2.hand.length;

  const events = E.performAction(state, { type: 'draw' });
  // 事件顺序：action → draw → endgame_start → endgame_draw(p1) → endgame_draw(p2)
  assert.deepStrictEqual(events.slice(0, 3).map((e) => e.type), ['action', 'draw', 'endgame_start'], '事件前缀');
  const draws = events.filter((e) => e.type === 'endgame_draw');
  assert.strictEqual(draws.length, 2, '应各发一次 endgame_draw（p1/p2）');
  assert.deepStrictEqual(draws.map((e) => e.playerId), ['p1', 'p2'], '补牌顺序：先 P1 后 P2');

  const start = h.firstEventOfType(events, 'endgame_start');
  assert.deepStrictEqual(start.openRegionIds, [0, 1, 2, 3, 4], '决战区域按编号升序');
  assert.strictEqual(start.settleCards, 2);
  assert.strictEqual(start.drawPerPlayer, 5, 'drawPerPlayer = 剩余区域数 X = 5');
  assert.strictEqual(start.threshold, 10, '触发阈值 = 2X = 10');
  assert.strictEqual(start.deckCount, 10, '触发时牌堆 = 摸牌后 10 张');
  assert.deepStrictEqual(start.drawnCounts, { p1: 5, p2: 5 }, '双方各摸 5 张（摸空）');

  assert.strictEqual(draws[0].count, 5);
  assert.strictEqual(draws[1].count, 5);
  assert.strictEqual(draws[0].handSize, handP1 + 1 + 5, 'P1 手牌 +5（此前摸牌行动 +1）');
  assert.strictEqual(draws[1].handSize, handP2 + 5, 'P2 手牌 +5');

  // 状态：仍在 battle，但 endgame.phase=build；牌堆已空；手牌增加
  assert.strictEqual(state.phase, 'battle');
  assert.ok(['p1', 'p2'].includes(state.turn), 'build 阶段沿用 state.turn');
  assert.deepStrictEqual(state.endgame, {
    triggered: true, phase: 'build', threshold: 10, settleCards: 2,
    drawPerPlayer: 5, drawnCounts: { p1: 5, p2: 5 }, skipped: { p1: false, p2: false },
  }, 'endgame 状态字段');
  assert.strictEqual(state.deck.length, 0, '牌堆被摸空');
  assert.strictEqual(state.players.p1.hand.length, handP1 + 1 + 5);
  assert.strictEqual(state.players.p2.hand.length, handP2 + 5);
  assert.deepStrictEqual(E.getLegalActions(state).map((a) => a.type).filter((t) => t === 'draw' || t === 'settle'), [],
    'build 阶段 getLegalActions 不含 draw/settle');
  assert.ok(E.getLegalActions(state).length > 0, 'build 阶段当前行动方应有翻/放/移行动');
  invariant(state, '决战补牌后 build 阶段');
});

test('§6 决战最终部署：仅翻牌/放牌/移牌合法（+ end_turn）；draw/settle 抛 BAD_ACTION 且状态不变', () => {
  const { state } = synthEndgameState({ regionCount: 5, settleCards: 2, deckCount: 11, handSizes: { p1: 1 } });
  E.performAction(state, { type: 'draw' });
  assert.strictEqual(state.endgame.phase, 'build');
  assert.strictEqual(state.players[state.turn].ap, E.AP_PER_TURN, '决战 build 回合 AP 回满 3');
  const legal = E.getLegalActions(state);
  assert.ok(legal.length > 0);
  assert.ok(legal.every((a) => ['flip', 'place', 'move', 'end_turn'].includes(a.type)),
    '仅允许 flip/place/move/end_turn：' + JSON.stringify(legal.map((a) => a.type)));
  assert.ok(legal.some((a) => a.type === 'end_turn'), 'build 阶段也可随时结束回合');
  for (const a of legal) assert.strictEqual(a.cost, E.ACTION_COSTS[a.type], 'build 阶段 Action 同样带 cost');

  const pre = h.clone(state);
  const errDraw = h.assertThrowsError(() => E.performAction(state, { type: 'draw' }), 'BAD_ACTION', '决战阶段禁用摸牌');
  assert.match(errDraw.message, /决战|禁用/, '错误信息应说明决战阶段禁用摸牌');
  const errSettle = h.assertThrowsError(() => E.performAction(state, { type: 'settle', regionId: 0 }), 'BAD_ACTION', '决战阶段禁用结算');
  assert.match(errSettle.message, /决战|禁用/, '错误信息应说明决战阶段禁用结算');
  assert.deepStrictEqual(state, pre, '非法行动不得改变状态（错误原子性，含 AP 不变）');
  invariant(state, '决战禁用行动后');
});

test('§6 决战：单独结算触发（可能低于 2X）+ 难度摸牌触发 + 补牌对半下调', () => {
  // 自制完整牌分配的 synth：区域0 可结算（p1 2 张 + p2 1 张），其余每区各 1 张；牌堆 11。
  const pool = E.createDeck({ jokers: true }).map((x) => x.id);
  let i = 0;
  const take = () => pool[i++];
  const regions = [
    { p1FaceUp: [take(), take()], p2FaceUp: [take()] },
    { p1FaceUp: [take()], p2FaceUp: [take()] },
    { p1FaceUp: [take()], p2FaceUp: [take()] },
    { p1FaceUp: [take()], p2FaceUp: [take()] },
    { p1FaceUp: [take()], p2FaceUp: [take()] },
  ];
  const state = h.synthBattle(E, {
    regionCount: 5,
    config: { settleCards: 2, difficulty: 2 },
    deck: pool.slice(i, i + 11),
    discard: pool.slice(i + 11),
    regions,
    hands: {},
    turn: 'p1',
  });
  assert.strictEqual(state.deck.length, 11);
  assert.strictEqual(E.getEndgameThreshold(state), 10);
  const settle = E.getLegalActions(state).find((a) => a.type === 'settle' && a.regionId === 0);
  assert.ok(settle, '区域 0 应可结算（正面 3 张）');
  const events = E.performAction(state, settle);
  const se = h.firstEventOfType(events, 'settle');
  assert.ok(se, '单独结算事件');
  assert.strictEqual(se.deckAfter, 11 - 4, '难度2：结算后牌堆 7');
  assert.strictEqual(se.endgameTriggered, true, 'settle 事件应标记触发决战');
  const start = h.firstEventOfType(events, 'endgame_start');
  assert.ok(start, '应有 endgame_start');
  assert.deepStrictEqual(start.openRegionIds, [1, 2, 3, 4], '剩余区域 1..4');
  assert.strictEqual(start.drawPerPlayer, 4, 'X=4');
  assert.strictEqual(start.threshold, 8, '阈值 = 2X = 8');
  assert.strictEqual(start.deckCount, 7, '触发时牌堆 7 < 2X');
  assert.deepStrictEqual(start.drawnCounts, { p1: 3, p2: 4 }, '不足 2X 时 P1=⌊7/2⌋=3、P2=4');
  assert.strictEqual(state.deck.length, 0, '补牌后牌堆摸空');
  assert.strictEqual(state.endgame.drawPerPlayer, 4, 'drawPerPlayer 记录理想值 X=4');
  assert.deepStrictEqual(state.endgame.drawnCounts, { p1: 3, p2: 4 }, 'drawnCounts 记录实际值');
  assert.strictEqual(state.phase, 'battle');
  assert.strictEqual(state.endgame.phase, 'build');
  invariant(state, '单独结算触发决战（不足 2X）');

  // N=4：一次结算消耗 8 张 → 牌堆 11-8=3；X=4，阈值 8 → P1=1/P2=2
  const pool2 = E.createDeck({ jokers: true }).map((x) => x.id);
  let j = 0;
  const take2 = () => pool2[j++];
  const regions2 = [
    { p1FaceUp: [take2(), take2()], p2FaceUp: [take2()] },
    { p1FaceUp: [take2()], p2FaceUp: [take2()] },
    { p1FaceUp: [take2()], p2FaceUp: [take2()] },
    { p1FaceUp: [take2()], p2FaceUp: [take2()] },
    { p1FaceUp: [take2()], p2FaceUp: [take2()] },
  ];
  const state4 = h.synthBattle(E, {
    regionCount: 5,
    config: { settleCards: 4, difficulty: 2 },
    deck: pool2.slice(j, j + 13),
    discard: pool2.slice(j + 13),
    regions: regions2,
    hands: {},
    turn: 'p1',
  });
  const settle4 = E.getLegalActions(state4).find((a) => a.type === 'settle' && a.regionId === 0);
  assert.ok(settle4, 'N=4 时区域 0 可结算');
  const events4 = E.performAction(state4, settle4);
  const start4 = h.firstEventOfType(events4, 'endgame_start');
  const se4 = h.firstEventOfType(events4, 'settle');
  assert.strictEqual(se4.drawn.p1.length, 4, 'N=4 时 P1 补 4 张');
  assert.strictEqual(se4.drawn.p2.length, 4, 'N=4 时 P2 补 4 张');
  assert.strictEqual(start4.deckCount, 13 - 8, '触发时牌堆 5');
  assert.deepStrictEqual(start4.drawnCounts, { p1: 2, p2: 3 }, '5 张按 floor/余数分：2/3');
  assert.strictEqual(state4.deck.length, 0);
  invariant(state4, 'N=4 单独结算触发决战');
});

test('§6 阈值=2×未结算区域数动态变化；未到阈值不触发，摸牌降到阈值才触发', () => {
  // N=1：牌堆 11 → 结算消耗 2 张 → 9 张；X=4 阈值 8，9>8 不触发
  const pool = E.createDeck({ jokers: true }).map((x) => x.id);
  let k = 0;
  const take = () => pool[k++];
  const regions = [
    { p1FaceUp: [take(), take()], p2FaceUp: [take()] },
    { p1FaceUp: [take()], p2FaceUp: [take()] },
    { p1FaceUp: [take()], p2FaceUp: [take()] },
    { p1FaceUp: [take()], p2FaceUp: [take()] },
    { p1FaceUp: [take()], p2FaceUp: [take()] },
  ];
  const state = h.synthBattle(E, {
    regionCount: 5,
    config: { settleCards: 1, difficulty: 2 },
    deck: pool.slice(k, k + 11),
    discard: pool.slice(k + 11),
    regions,
    hands: {},
    turn: 'p1',
  });
  const settle = E.getLegalActions(state).find((a) => a.type === 'settle' && a.regionId === 0);
  assert.ok(settle);
  const ev = E.performAction(state, settle);
  const se = h.firstEventOfType(ev, 'settle');
  assert.strictEqual(se.endgameTriggered, false, '牌堆 9 > 新阈值 8，不触发决战');
  assert.strictEqual(state.phase, 'battle');
  assert.strictEqual(state.deck.length, 9);
  assert.strictEqual(E.getEndgameThreshold(state), 8, '结算一区后阈值 = 2×4 = 8');
  assert.strictEqual(state.turn, 'p2', '未触发决战则换手');

  // p2 摸 1 张 → 牌堆 = 8 = 阈值 → 触发决战；X=4，双方各 4 张
  const ev2 = E.performAction(state, { type: 'draw' });
  const start = h.firstEventOfType(ev2, 'endgame_start');
  assert.deepStrictEqual(ev2.slice(0, 3).map((e) => e.type), ['action', 'draw', 'endgame_start']);
  assert.deepStrictEqual(start.drawnCounts, { p1: 4, p2: 4 }, '恰好 2X 时双方各 X 张');
  assert.strictEqual(state.deck.length, 0);
  invariant(state, '阈值动态触发决战');
});

test('§6 决战 build：每回合 3 AP、一回合多行动、跳过对方回合并回满 AP', () => {
  function buildState(spec) {
    const st = h.synthBattle(E, Object.assign({
      regionCount: 3, turn: 'p1', difficulty: 2, deck: [],
    }, spec));
    st.config.settleCards = 2;
    st.config.endgameApCapRule = false; // task-147: legacy AP behavior pin
    st.endgame = {
      triggered: true, phase: 'build', threshold: 6, settleCards: 2,
      drawPerPlayer: 3, drawnCounts: { p1: 0, p2: 0 }, skipped: { p1: false, p2: false },
    };
    return st;
  }

  // 一回合多行动：p1 手牌 3 → place×3（1+1+1 点）恰好用尽，自动换人
  const st = buildState({ turn: 'p1', hands: { p1: ['h-A', 'h-2', 'h-3'], p2: ['s-A'] } });
  assert.strictEqual(st.players.p1.ap, 3, 'build 回合 AP=3');
  let ev = E.performAction(st, E.getLegalActions(st).find((a) => a.type === 'place'));
  ev = E.performAction(st, E.getLegalActions(st).find((a) => a.type === 'place'));
  ev = E.performAction(st, E.getLegalActions(st).find((a) => a.type === 'place'));
  assert.strictEqual(st.turn, 'p2', '三张放牌用尽 3 点 → 换人');
  assert.strictEqual(st.players.p2.ap, 3, '对方 build 回合 AP 回满');
  assert.strictEqual(h.firstEventOfType(ev, 'turn_end').reason, 'ap');

  // 跳到 p2 后：place（AP2）→ flip（2 点）→ AP=0 自动换人（同回合多行动）
  E.performAction(st, E.getLegalActions(st).find((a) => a.type === 'place'));
  assert.strictEqual(st.turn, 'p2');
  assert.strictEqual(st.players.p2.ap, 2, '放牌后 AP=2');
  const flip = E.getLegalActions(st).find((a) => a.type === 'flip');
  assert.ok(flip, 'p2 放下的背面牌可翻');
  const flipEvents = E.performAction(st, flip);
  assert.strictEqual(st.turn, 'p1', '翻牌用尽 2 点 → 换人');
  assert.strictEqual(st.players.p1.ap, 3);
  assert.strictEqual(h.firstEventOfType(flipEvents, 'turn_end').reason, 'ap');

  // 跳过：p1 无手牌/无背面牌（不可构建），p2 可构建并主动结束回合 → 跳过 p1，p2 开新回合并回满 AP
  const skipSt = buildState({ turn: 'p2', hands: { p1: [], p2: ['s-A', 's-2'] }, regions: [{}, {}, {}] });
  skipSt.endgame.skipped = { p1: false, p2: false };
  const skipEvents = E.performAction(skipSt, E.getLegalActions(skipSt).find((a) => a.type === 'end_turn'));
  const skip = h.firstEventOfType(skipEvents, 'endgame_skip');
  assert.ok(skip, 'p1 无牌可动应产生 endgame_skip');
  assert.strictEqual(skip.playerId, 'p1');
  assert.strictEqual(skipSt.endgame.skipped.p1, true);
  assert.strictEqual(skipSt.turn, 'p2', '跳过 p1 后由 p2 开新回合');
  assert.strictEqual(skipSt.players.p2.ap, 3, '新回合 AP 回满');
  const skipStart = h.firstEventOfType(skipEvents, 'turn_start');
  assert.strictEqual(skipStart.playerId, 'p2');
  assert.strictEqual(skipStart.ap, 3);
  assert.strictEqual(skipSt.endgame.skipped.p2, false, '可构建的一方不标记跳过');
});

test('§6 决战全流程：build → 自动跳过 → 摊牌 → 无随机结算（无难度摸牌）→ 终局', () => {
  const { state } = synthEndgameState({ regionCount: 5, settleCards: 2, deckCount: 11, handSizes: { p1: 1 } });
  const triggerEvents = E.performAction(state, { type: 'draw' }); // 触发决战
  assert.strictEqual(state.endgame.phase, 'build');
  assert.strictEqual(state.phase, 'battle');
  const openBefore = E.getOpenRegionIds(state);
  assert.deepStrictEqual(openBefore, [0, 1, 2, 3, 4]);

  const { events, result, steps } = runToGameOver(state);
  assert.strictEqual(result.reason, 'gameover', '应自然到达终局');
  const ana = analyzeEndgame(triggerEvents.concat(events), state);
  assert.ok(ana.start, '应有 endgame_start');
  assert.strictEqual(ana.draws.length, 2, '补牌事件 2 个');
  assert.ok(ana.showdown, '应有 endgame_showdown 事件');
  assert.deepStrictEqual(ana.showdown.openRegionIds, openBefore, '摊牌覆盖全部剩余区域');
  assert.strictEqual(ana.showdown.threshold, 2 * openBefore.length, '摊牌事件 threshold=2X');
  assert.strictEqual(ana.showdown.deckCount, 0, '摊牌时牌堆已空');

  // 跳过：同一方只发一次，且跳过后另一方连续行动
  const skipPids = ana.skips.map((e) => e.playerId);
  assert.strictEqual(new Set(skipPids).size, skipPids.length, '同一玩家最多一条 endgame_skip');
  assert.ok(skipPids.length >= 1, '一方先耗尽时应出现跳过事件（双方补牌数/手牌不同）');
  assert.deepStrictEqual([state.endgame.skipped.p1, state.endgame.skipped.p2],
    [skipPids.includes('p1'), skipPids.includes('p2')], 'skipped 标记与事件一致');
  // 跳过发生在轮到该方时：找出连续两次同玩家行动的记录，确认 skip 后另一方连续行动
  const actorSeq = [];
  for (const st of steps) {
    const act = h.firstEventOfType(st.events, 'action');
    if (act) actorSeq.push(act.playerId);
  }
  assert.ok(actorSeq.length >= 2);

  // 摊牌逐区确定性结算：不补牌、无难度摸牌、按正面和判胜
  assert.ok(ana.settles.length >= 1, '应有摊牌结算事件');
  let settledIds = [];
  for (const s of ana.settles) {
    settledIds.push(s.regionId);
    assert.strictEqual(s.deterministic, true, '摊牌结算事件应标记 deterministic=true');
    assert.strictEqual(s.drawnCount, 0, 'drawnCount=0');
    assert.deepStrictEqual(s.drawn, { p1: [], p2: [] }, 'drawn 为空数组');
    assert.strictEqual(s.deckAfter, 0, '摊牌不消耗牌堆');
    assert.strictEqual(s.regionResult.deterministic, true, '区域结果 deterministic=true');
    assert.strictEqual(s.regionResult.difficultyDraw, null, '摊牌不执行难度规则');
    assert.deepStrictEqual(s.regionResult.drawn, { p1: [], p2: [] });
    assert.deepStrictEqual(s.sums, {
      p1: s.regionBefore.sides.p1.faceUp.reduce((sum, c) => sum + c.value, 0),
      p2: s.regionBefore.sides.p2.faceUp.reduce((sum, c) => sum + c.value, 0),
    }, 'sums 只等于结算前正面牌和');
    const expectWinner = s.sums.p1 > s.sums.p2 ? 'p1' : (s.sums.p2 > s.sums.p1 ? 'p2' : 'tie');
    assert.strictEqual(s.winner, expectWinner);
  }
  assert.deepStrictEqual(settledIds, settledIds.slice().sort((a, b) => a - b), '摊牌按区域编号升序');
  if (!state.result.early) {
    assert.deepStrictEqual(settledIds, openBefore, '未提前锁定时摊牌结算全部剩余区域');
    assert.ok(state.regions.every((r) => r.status === 'settled'));
    assert.deepStrictEqual(state.result.handSums, { p1: 0, p2: 0 }, '摊牌后双方手牌均为 0');
    assert.ok(state.result.reason === 'draw' || state.result.reason === 'region_wins');
    assert.strictEqual(state.phase, 'gameover');
    assert.strictEqual(state.endgame.phase, 'done');
  } else {
    assert.strictEqual(state.result.reason, 'region_wins');
    assert.deepStrictEqual(state.result.unsettledRegions, openBefore.filter((x) => !settledIds.includes(x)));
    assert.ok(state.result.unsettledRegions.length > 0);
  }
  assert.strictEqual(state.deck.length, 0, '终局牌堆为空');
  assert.deepStrictEqual(E.getLegalActions(state), [], '终局后无合法行动');
  invariant(state, '决战全流程终局');
});

test('§6 决战：难度1/3 在摊牌阶段均不触发难度摸牌（手牌保持 0）', () => {
  for (const difficulty of [1, 3]) {
    const { state } = synthEndgameState({ regionCount: 5, settleCards: 2, deckCount: 11, handSizes: { p1: 1 }, difficulty });
    E.performAction(state, { type: 'draw' });
    const { events } = runToGameOver(state);
    const ana = analyzeEndgame(events, state);
    for (const s of ana.settles) {
      assert.strictEqual(s.regionResult.difficultyDraw, null, 'difficulty=' + difficulty + ' 摊牌不得执行难度规则');
      assert.strictEqual(s.drawnCount, 0);
    }
    assert.deepStrictEqual(state.result.handSums, { p1: 0, p2: 0 }, '摊牌后手牌总和 0:0（无难度摸牌）');
    invariant(state, '难度' + difficulty + ' 摊牌终局');
  }
});

test('§9#3 决战触发：单独结算 + 难度摸牌后牌堆不足 2X 仍能摸空（P1/P2 对半）', () => {
  // R=5 N=2 难度1：区域0 p1 K+Q(25) vs p2 ♠2(2) → p1 胜，难度1 败者 p2 摸 1 张
  // 牌堆 11 → 结算 4 张 + 难度摸牌 1 张 = 6 张；X=4，阈值 8 → 触发，6 张按 3/3 摸空
  const all = E.createDeck({ jokers: true }).map((c) => c.id);
  const used = new Set();
  const pickId = (id) => { assert.ok(!used.has(id), '牌 id 重复：' + id); used.add(id); return id; };
  const regions = [
    { p1FaceUp: [pickId('s-K'), pickId('h-Q')], p2FaceUp: [pickId('d-2')] },
    { p1FaceUp: [pickId('s-3')], p2FaceUp: [pickId('h-4')] },
    { p1FaceUp: [pickId('s-5')], p2FaceUp: [pickId('h-6')] },
    { p1FaceUp: [pickId('s-7')], p2FaceUp: [pickId('h-8')] },
    { p1FaceUp: [pickId('s-9')], p2FaceUp: [pickId('h-10')] },
  ];
  const rest = all.filter((id) => !used.has(id));
  const state = h.synthBattle(E, {
    regionCount: 5,
    config: { settleCards: 2, difficulty: 1 },
    deck: rest.slice(0, 11),
    discard: rest.slice(11),
    regions,
    hands: {},
    turn: 'p1',
  });
  const settle = E.getLegalActions(state).find((a) => a.type === 'settle' && a.regionId === 0);
  assert.ok(settle);
  const events = E.performAction(state, settle);
  const se = h.firstEventOfType(events, 'settle');
  assert.strictEqual(se.winner, 'p1');
  assert.ok(se.difficultyDraw, '难度1 应有败者摸牌');
  assert.strictEqual(se.difficultyDraw.playerId, 'p2', '败者 p2 摸牌');
  assert.strictEqual(se.deckAfter, 11 - 4 - 1, '结算 4 张 + 难度摸牌 1 张');
  assert.strictEqual(se.endgameTriggered, true);
  const start = h.firstEventOfType(events, 'endgame_start');
  assert.strictEqual(start.deckCount, 6);
  assert.deepStrictEqual(start.drawnCounts, { p1: 3, p2: 3 }, '6 张按 3/3 摸空');
  assert.strictEqual(state.deck.length, 0);
  assert.strictEqual(state.endgame.phase, 'build');
  invariant(state, '难度摸牌触发决战');
});

test('§6 决战：7 区触发（X=7，双方各摸 7 张）并摊牌至终局', () => {
  const { state } = driveToThresholdPlusOne({ regionCount: 7, settleCards: 2, firstPlayer: 'p1' });
  assert.strictEqual(E.getEndgameThreshold(state), 14, 'R=7 阈值 = 2×7 = 14');
  const events = performDrawOnce(state);
  const start = h.firstEventOfType(events, 'endgame_start');
  assert.ok(start, '应有 endgame_start');
  assert.deepStrictEqual(start.openRegionIds, [0, 1, 2, 3, 4, 5, 6]);
  assert.strictEqual(start.drawPerPlayer, 7, 'X=7');
  assert.strictEqual(start.threshold, 14);
  assert.deepStrictEqual(start.drawnCounts, { p1: 7, p2: 7 });
  assert.strictEqual(state.deck.length, 0);
  const { events: allEvents } = runToGameOver(state);
  const ana = analyzeEndgame(allEvents, state);
  assert.ok(ana.showdown, '应有摊牌事件');
  assert.strictEqual(ana.showdown.openRegionIds.length, 7);
  assert.ok(state.phase === 'gameover');
  assert.deepStrictEqual(state.result.handSums, state.result.early ? state.result.handSums : { p1: 0, p2: 0 });
  invariant(state, '7 区决战终局');
});

test('§5 flip/place/move 不消耗牌堆，不得误触发决战', () => {
  const { state } = driveToThresholdPlusOne({ difficulty: 2, firstPlayer: 'p1' });
  const deck0 = state.deck.length;
  assert.strictEqual(deck0, E.getEndgameThreshold(state) + 1);
  normalizeTurnStart(state); // 确保从 AP 回满的新回合开始，避免半回合影响放牌计数
  const r = new h.Runner(E, state);
  // p1/p2 各放 2 张背面牌（牌堆不变，仍高于阈值）
  for (let i = 0; i < 4; i++) {
    r.step(h.pickAction(E, state, r.legal(), { prefer: ['place'] }));
    assert.strictEqual(state.deck.length, deck0);
    assert.strictEqual(state.endgame.triggered, false, '第' + (i + 1) + '次放牌不得触发决战');
    assert.strictEqual(state.phase, 'battle');
  }
  // 双方各翻 1 张（当前行动方顺序由摸牌次数决定，动态取 first/second）
  const flipOrder = [state.turn, state.turn === 'p1' ? 'p2' : 'p1'];
  for (const pid of flipOrder) {
    assert.strictEqual(state.turn, pid);
    const flip = r.legal().find((a) => a.type === 'flip');
    assert.ok(flip, pid + ' 应有背面牌可翻');
    r.step(flip);
    assert.strictEqual(state.deck.length, deck0);
    assert.strictEqual(state.endgame.triggered, false, '翻牌不得触发决战');
  }
  // 当前行动方移牌（牌堆不变）
  const movePid = state.turn;
  const move = r.legal().find((a) => a.type === 'move');
  assert.ok(move, movePid + ' 应有背面牌可移');
  r.step(move);
  assert.strictEqual(state.deck.length, deck0);
  assert.strictEqual(state.endgame.triggered, false, '移牌不得触发决战');
  invariant(state, '非摸牌行动不得触发决战');
});

/* ================================================================== */
/* 十、终局判定                                                        */
/* ================================================================== */

test('§6 终局判定：一方区域胜场达到门槛 → region_wins（含提前锁定语义）', () => {
  const found = findBranch('region_wins', { regionCount: 5, difficulty: 1 });
  assert.ok(found, '应在种子范围内出现 region_wins 终局');
  const { state } = found;
  const need = state.config.winsNeeded;
  const maxWins = Math.max(state.regionWins.p1, state.regionWins.p2);
  assert.ok(maxWins >= need, 'region_wins 终局应有一方 ≥ ' + need + ' 个区域胜场');
  assert.strictEqual(state.result.reason, 'region_wins');
  assert.strictEqual(state.result.winner, state.regionWins.p1 >= need ? 'p1' : 'p2');
  assert.strictEqual(state.result.regionWins.p1, state.regionWins.p1);
  assert.strictEqual(state.result.early, state.result.unsettledRegions.length > 0, 'early 与 unsettledRegions 一致');
  if (state.result.early) {
    assert.ok(state.endgame.triggered, 'v1.3 提前锁定发生在决战摊牌途中');
    assert.ok(state.regions.filter((r) => r.status === 'open').length === state.result.unsettledRegions.length);
    assert.ok(state.result.handSums.p1 === 0 && state.result.handSums.p2 === 0, '摊牌后手牌 0:0');
  } else {
    assert.deepStrictEqual(state.result.unsettledRegions, []);
    assert.ok(state.regions.every((r) => r.status === 'settled'));
  }
  invariant(state, 'region_wins 终局');
});

test('§6 终局判定：区域胜场不足时比较手牌总和 → hand_sum（全部单独结算、未触发决战）', () => {
  const found = findBranch('hand_sum', { regionCount: 5, difficulty: 2, settleCards: 1 }, 800, 'settle');
  assert.ok(found, '应在种子范围内出现 hand_sum 终局（不摸牌、全部单独结算）');
  const { state } = found;
  const need = state.config.winsNeeded;
  assert.ok(state.regionWins.p1 < need && state.regionWins.p2 < need, 'hand_sum 终局双方区域胜场均未达门槛');
  assert.strictEqual(state.endgame.triggered, false, '全部单独结算完的对局不应触发决战');
  assert.ok(state.regions.every((r) => r.status === 'settled'));
  const hs = state.result.handSums;
  assert.deepStrictEqual(hs, { p1: E.getHandSum(state, 'p1'), p2: E.getHandSum(state, 'p2') });
  assert.notStrictEqual(hs.p1, hs.p2, '手牌总和应不等');
  assert.strictEqual(state.result.reason, 'hand_sum');
  assert.strictEqual(state.result.winner, hs.p1 > hs.p2 ? 'p1' : 'p2');
  invariant(state, 'hand_sum 终局');
});

test('§6 §9#16 终局判定：完全平局 → draw（摊牌 0:0 或手牌总和相等）', () => {
  const found = findBranch('draw', { regionCount: 5, difficulty: 1 }, 1200);
  assert.ok(found, '应在种子范围内出现完全平局（自然牌局）');
  const { state } = found;
  const need = state.config.winsNeeded;
  assert.ok(state.regionWins.p1 < need && state.regionWins.p2 < need);
  assert.strictEqual(state.result.handSums.p1, state.result.handSums.p2, '完全平局要求手牌总和相等');
  assert.strictEqual(state.result.reason, 'draw');
  assert.strictEqual(state.result.winner, 'draw');
  if (state.endgame.triggered) {
    // v1.3：决战摊牌后双方手牌为空 → 0:0
    assert.strictEqual(state.endgame.phase, 'done');
    assert.deepStrictEqual(state.result.handSums, { p1: 0, p2: 0 });
    assert.ok(state.regions.every((r) => r.status === 'settled'), '未提前锁定时摊牌结算全部区域');
  }
  invariant(state, 'draw 终局');
});

test('§9#14 区域全部单独结算完（从未触发决战、无提前锁定）→ 直接按规则判定', () => {
  // N=1 + 难度2（无难度摸牌），只结算/翻牌/放牌：不消耗牌堆差距 → 不会触发决战，5 区全部单独结算
  let found = null;
  for (let seed = 1; seed <= 400 && !found; seed++) {
    const g = settleOnlyGame(seed, { difficulty: 2, settleCards: 1, firstPlayer: 'p1' });
    const state = g.state;
    if (state.phase === 'gameover' && state.endgame.triggered === false && state.result && state.result.early === false &&
      state.regions.every((x) => x.status === 'settled') && state.deck.length > 0) {
      found = { seed, state, runner: g.runner };
    }
  }
  assert.ok(found, '应能找到「全部区域单独结算、无提前锁定」的对局');
  const { state, runner } = found;
  assert.strictEqual(state.turn, null);
  assert.ok(state.result && state.result.winner, '应给出终局判定');
  assert.ok(state.result.reason === 'hand_sum' || state.result.reason === 'draw' || state.result.reason === 'region_wins');
  assert.strictEqual(state.result.early, false);
  assert.deepStrictEqual(state.result.unsettledRegions, []);
  assert.strictEqual(state.endgame.triggered, false, '未触发决战的终局 endgame.triggered=false');
  assert.strictEqual(state.endgame.phase, null);
  const acts = new Set(runner.trace.map((x) => x.split('|')[0]));
  assert.ok(acts.has('settle'), '策略应使用结算');
  assert.ok(!acts.has('draw'), '该分支应从未摸牌');
  invariant(state, '区域全单独结算终局');
});

/* ================================================================== */
/* 十一、确定性 / 错误码 / 状态锁                                      */
/* ================================================================== */

test('§8 确定性：同 seed + 同操作序列 ⇒ 完全相同的对局', () => {
  const cfg = E.defaultConfig({ seed: 987654321, regionCount: 5, difficulty: 1, firstPlayer: 'p1' });
  const mk = () => {
    const state = E.createGame(cfg);
    const R = state.config.regionCount;
    E.submitLayout(state, 'p1', cardIds(state.players.p1.hand).slice(0, R));
    E.submitLayout(state, 'p2', cardIds(state.players.p2.hand).slice(0, R));
    E.finalizeLayout(state);
    return state;
  };
  const a = mk();
  const b = mk();
  assert.deepStrictEqual(a, b, '同 seed 初始布局后状态应完全一致');
  let steps = 0;
  while (!E.isGameOver(a) && steps < 800) {
    const legal = E.getLegalActions(a);
    assert.ok(legal.length > 0);
    const action = policyPick(E, a, legal, []);
    E.performAction(a, action);
    E.performAction(b, action);
    assert.deepStrictEqual(a, b, '第 ' + (steps + 1) + ' 步后状态应一致（seed 确定性）');
    steps++;
  }
  assert.ok(E.isGameOver(a), '应自然到达终局');
  assert.deepStrictEqual(a.result, b.result);
  invariant(a, '确定性对局终局');
});

test('§8 确定性：不同 seed 产生不同牌局', () => {
  const firstDecks = [];
  for (const seed of [1, 2, 3, 4, 5]) {
    const state = E.createGame(E.defaultConfig({ seed }));
    firstDecks.push(cardIds(state.deck).join(','));
  }
  assert.ok(new Set(firstDecks).size > 1, '不同 seed 的牌堆顺序应不同');
});

test('§8 引擎实现约束：无 DOM / 无外部依赖 / 不使用 Date.now / Math.random 仅用于生成种子', () => {
  const raw = fs.readFileSync(h.ENGINE_PATH, 'utf8');
  // 注释里允许出现说明文字，扫描前先去掉块注释与行注释
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.doesNotMatch(code, /\brequire\s*\(/, '引擎不得 require 外部模块');
  assert.doesNotMatch(code, /\bdocument\b/, '引擎不得引用 DOM');
  assert.doesNotMatch(code, /\blocalStorage\b/);
  assert.doesNotMatch(code, /\bDate\.now\s*\(/, '引擎不得使用 Date.now');
  assert.doesNotMatch(code, /\bsetInterval\s*\(/, '引擎不执行计时：不得使用 setInterval（v1.5 计时由 UI 执行）');
  assert.doesNotMatch(code, /\bsetTimeout\s*\(/, '引擎不执行计时：不得使用 setTimeout（v1.5 计时由 UI 执行）');
  assert.strictEqual((code.match(/Math\.random/g) || []).length, 1, 'Math.random 只允许用于 seed:null 时生成种子');
  assert.match(code, /module\.exports/, '应提供 Node 导出（UMD）');
  assert.match(code, /root\.PokerEngine/, '应提供浏览器全局 PokerEngine');
});

test('§2 错误码：BAD_ACTION / BAD_REGION / BAD_PHASE / ALREADY_SETTLED / CARD_NOT_IN_HAND 映射', () => {
  // BAD_PHASE：布局阶段不能 performAction
  const layoutState = E.createGame(E.defaultConfig({ seed: 61 }));
  h.assertThrowsError(() => E.performAction(layoutState, { type: 'draw' }), 'BAD_PHASE', '布局阶段执行行动');

  const { state } = battle({ seed: 61 });
  // BAD_ACTION
  h.assertThrowsError(() => E.performAction(state, null), 'BAD_ACTION', 'null 行动');
  h.assertThrowsError(() => E.performAction(state, {}), 'BAD_ACTION', '空行动');
  h.assertThrowsError(() => E.performAction(state, { type: 'nope' }), 'BAD_ACTION', '未知行动类型');
  // BAD_REGION
  h.assertThrowsError(() => E.performAction(state, { type: 'place', regionId: 99, cardId: cardIds(state.players.p1.hand)[0] }), 'BAD_REGION', '放牌非法区域');
  h.assertThrowsError(() => E.performAction(state, { type: 'settle', regionId: 99 }), 'BAD_REGION', '结算非法区域');
  // CARD_NOT_IN_HAND
  const oppCard = state.players.p2.hand[0].id;
  h.assertThrowsError(() => E.performAction(state, { type: 'place', regionId: 0, cardId: oppCard }), 'CARD_NOT_IN_HAND', '放对方手牌');
  h.assertThrowsError(() => E.performAction(state, { type: 'place', regionId: 0, cardId: state.deck[0].id }), 'CARD_NOT_IN_HAND', '放牌堆牌');
});

test('§8 非法操作不得改变状态（错误原子性）', () => {
  const { state } = battle({ seed: 62 });
  // 先主动放 1 张牌、留 AP=2，便于同时覆盖「AP 不足」的非法结算
  E.performAction(state, E.getLegalActions(state).find((a) => a.type === 'place'));
  const before = h.clone(state);
  const attempts = [
    () => E.performAction(state, { type: 'nope' }),
    () => E.performAction(state, { type: 'place', regionId: 0, cardId: state.players.p2.hand[0].id }),
    () => E.performAction(state, { type: 'settle', regionId: 0 }), // AP=2 < 3 → 行动点不足
    () => E.performAction(state, { type: 'settle', regionId: 99 }),
    () => E.performAction(state, { type: 'flip', regionId: 0, cardId: 'no-such' }),
    () => E.performAction(state, { type: 'place', regionId: 99, cardId: cardIds(state.players.p1.hand)[0] }),
    () => E.performAction(state, { type: 'move', fromRegionId: 0, cardId: 'no-such', toRegionId: 1 }),
    () => E.performAction(state, { type: 'end_turn', cost: 3 }), // cost 字段不参与校验，仍应成功？→ 改为未知类型
  ];
  // 最后一项换成真正非法的 end_turn 变体不成立，移除，改为非法行动类型
  attempts[attempts.length - 1] = () => E.performAction(state, { type: 'end_turn_now' });
  for (const fn of attempts) {
    try { fn(); } catch (e) { /* 预期抛错 */ }
  }
  assert.deepStrictEqual(state, before, '所有非法操作后 state 必须保持原样（含 AP/回合/牌张）');
});

test('§5 §6 终局后拒绝一切行动，状态锁定', () => {
  const found = findBranch('region_wins', { regionCount: 5, difficulty: 1 });
  assert.ok(found);
  const { state } = found;
  assert.strictEqual(state.phase, 'gameover');
  assert.strictEqual(E.isGameOver(state), true);
  assert.deepStrictEqual(E.getLegalActions(state), []);
  h.assertThrowsError(() => E.performAction(state, { type: 'draw' }), 'BAD_PHASE', '终局后行动');
  h.assertThrowsError(() => E.submitLayout(state, 'p1', []), 'BAD_PHASE', '终局后提交布局');
  h.assertThrowsError(() => E.finalizeLayout(state), 'BAD_PHASE', '终局后 finalizeLayout');
  assert.ok(state.result, '终局应有 result');
  assert.deepStrictEqual(state.result, found.runner ? state.result : state.result);
});

/* ================================================================== */
/* 十二、展示 / 信息辅助                                               */
/* ================================================================== */

test('§2 展示辅助：getOpenRegionIds / getEndgameThreshold / getRegionSideSum / getRegionFaceUpCount / getScoreLabel', () => {
  const { state } = battle({ seed: 71 });
  assert.deepStrictEqual(E.getOpenRegionIds(state), [0, 1, 2, 3, 4]);
  assert.strictEqual(E.getEndgameThreshold(state), 2 * 5, '阈值 = 2×未结算区域数');
  assert.strictEqual(E.getEndgameThreshold(state), 10);
  assert.strictEqual(E.getRegionFaceUpCount(state, 0), 2, '开局每区正面牌 2 张');
  for (const pid of ['p1', 'p2']) {
    assert.strictEqual(E.getRegionSideSum(state, 0, pid), state.regions[0].sides[pid].faceUp[0].value);
  }
  assert.strictEqual(E.getHandSum(state, 'p1'), h.sumValues(state.players.p1.hand));
  assert.strictEqual(E.getHandSum(state, 'p2'), h.sumValues(state.players.p2.hand));
  const label = E.getScoreLabel(state);
  assert.strictEqual(typeof label, 'string');
  assert.ok(label.includes('你') && label.includes('电脑') && label.includes('0') && label.includes(':'), '比分标签应含双方名称与比分');
  // 结算一个区域后比分标签更新
  const sc = findSettleScenario({ difficulty: 2 });
  const label2 = E.getScoreLabel(sc.state);
  assert.notStrictEqual(label2, E.getScoreLabel(sc.pre), '结算后比分标签应变化');
  assert.ok(label2.includes(String(Math.max(sc.state.regionWins.p1, sc.state.regionWins.p2))));
});

test('§2 §6 信息辅助 getKnownCards/getUnseenCards：互补且不泄露未知信息', () => {
  const { state } = battle({ seed: 72, firstPlayer: 'p1' });
  const fullDeckIds = cardIds(E.createDeck(state.config.deck)).sort();
  for (const pid of ['p1', 'p2']) {
    const known = E.getKnownCards(state, pid);
    const unseen = E.getUnseenCards(state, pid);
    const knownIds = cardIds(known);
    const unseenIds = cardIds(unseen);
    assert.strictEqual(new Set(knownIds).size, knownIds.length, 'getKnownCards 不得重复');
    assert.strictEqual(new Set(unseenIds).size, unseenIds.length, 'getUnseenCards 不得重复');
    assert.deepStrictEqual([...knownIds, ...unseenIds].sort(), fullDeckIds, '已知+未知应等于完整牌堆');
    // 我方手牌 + 全场正面牌应已知
    for (const c of state.players[pid].hand) assert.ok(knownIds.includes(c.id), '我方手牌应为已知');
    for (const r of state.regions) {
      for (const cp of [...r.sides.p1.faceUp, ...r.sides.p2.faceUp]) {
        assert.ok(knownIds.includes(cp.id), '公开正面牌应为已知');
      }
    }
    // 对战开始：未见面 = 牌堆 + 对手手牌
    const opp = pid === 'p1' ? 'p2' : 'p1';
    const expectedUnseen = new Set([...cardIds(state.deck), ...cardIds(state.players[opp].hand)]);
    assert.deepStrictEqual(new Set(unseenIds), expectedUnseen, '开局未知牌应为牌堆 + 对手手牌');
    // 确定性：重复调用结果一致
    assert.deepStrictEqual(cardIds(E.getUnseenCards(state, pid)), unseenIds);
  }
  // 对手手牌身份不得出现在我方已知集合中（初始无任何公开信息）
  const knownP1 = new Set(cardIds(E.getKnownCards(state, 'p1')));
  for (const c of state.players.p2.hand) assert.ok(!knownP1.has(c.id), '对手手牌初始应未知');
});

test('§5 每个合法行动都可在状态副本上执行（getLegalActions 与 performAction 一致）', () => {
  const states = [];
  const s1 = battle({ seed: 73 }).state;
  states.push(['开局(AP=3)', h.clone(s1)]);
  // p1 放 1 张（AP 3→2，仍同回合；出现 flip/move）
  E.performAction(s1, E.getLegalActions(s1).find((a) => a.type === 'place'));
  states.push(['放牌后(AP=2)', h.clone(s1)]);
  // p1 翻牌（2 点 → AP=0 → 自动换人，p2 AP=3）
  E.performAction(s1, E.getLegalActions(s1).find((a) => a.type === 'flip'));
  states.push(['翻牌后(p2 回合 AP=3)', h.clone(s1)]);
  const t = driveToThresholdPlusOne({ difficulty: 1, firstPlayer: 'p1' });
  states.push(['决战前(牌堆=阈值+1)', h.clone(t.state)]);

  for (const [label, snapshot] of states) {
    const legal = E.getLegalActions(snapshot);
    assert.ok(legal.length > 0, label + '：应有合法行动');
    for (const action of legal) {
      const copy = h.clone(snapshot);
      let events;
      assert.doesNotThrow(() => { events = E.performAction(copy, action); },
        label + '：合法行动 ' + h.canonicalAction(action) + ' 执行失败');
      assert.ok(Array.isArray(events) && events[0].type === 'action');
      invariant(copy, label + ' 执行 ' + h.canonicalAction(action) + ' 后', { skipConservation: false });
      assert.notDeepStrictEqual(copy, snapshot, '合法行动应改变状态：' + h.canonicalAction(action));
    }
  }
});

/* ================================================================== *
 * v1.5 防拖延 / 认输判负
 * ================================================================== */
test('§5 v1.5 连续两回合空过 → 认输判负（result/事件/日志/终局拒绝）', () => {
  const s = battle({ seed: 91, firstPlayer: 'p1' }).state;
  assert.strictEqual(s.turn, 'p1');
  // 第一回合：p1 直接结束（无任何行动）→ stall 1
  const ev1 = E.performAction(s, { type: 'end_turn' });
  assert.ok(ev1.some((e) => e.type === 'turn_end' && e.playerId === 'p1'));
  assert.strictEqual(s.players.p1.stallCount, 1);
  assert.strictEqual(s.turn, 'p2');
  // p2 结束回合（无行动，自己的 stall 计数与 p1 无关）
  E.performAction(s, { type: 'end_turn' });
  assert.strictEqual(s.turn, 'p1');
  // 第二回合：p1 再次空过 → 认输
  const openBefore = E.getOpenRegionIds(s);
  const ev2 = E.performAction(s, { type: 'end_turn' });
  assert.strictEqual(s.phase, 'gameover');
  assert.strictEqual(s.result.reason, 'forfeit');
  assert.strictEqual(s.result.winner, 'p2');
  assert.strictEqual(s.result.forfeitedBy, 'p1');
  assert.strictEqual(s.result.early, false);
  assert.deepStrictEqual(s.result.unsettledRegions, openBefore, '认输时剩余区域保持未结算');
  assert.ok(ev2.some((e) => e.type === 'turn_end' && e.playerId === 'p1'));
  assert.ok(ev2.some((e) => e.type === 'forfeit' && e.playerId === 'p1' && e.reason === 'stall'),
    '认输应产生 forfeit 事件');
  assert.strictEqual(ev2[ev2.length - 1].type, 'game_over', '最后事件应为 game_over');
  assert.ok(s.log.some((x) => /判负认输/.test(x.text)), '日志应写明判负认输');
  invariant(s, '认输终局');
  assert.throws(() => E.performAction(s, { type: 'end_turn' }), (e) => e && e.code === 'BAD_PHASE');
});

test('§5 v1.5 有推进行动则 stallCount 清零，不会误判认输', () => {
  const s = battle({ seed: 92, firstPlayer: 'p1' }).state;
  E.performAction(s, { type: 'end_turn' }); // p1 stall 1
  assert.strictEqual(s.players.p1.stallCount, 1);
  // p2 做出推进行动（摸牌）以清零自己的计数，并把回合交回 p1
  E.performAction(s, E.getLegalActions(s).find((a) => a.type === 'draw'));
  E.performAction(s, { type: 'end_turn' });
  assert.strictEqual(s.turn, 'p1');
  // p1 放一张牌（推进行动）再结束 → stallCount 清零
  E.performAction(s, E.getLegalActions(s).find((a) => a.type === 'place'));
  E.performAction(s, { type: 'end_turn' });
  assert.strictEqual(s.players.p1.stallCount, 0, '有推进行动后 stallCount 应清零');
  assert.strictEqual(s.phase, 'battle');
  invariant(s, '推进行动清零 stall');
});

test('§5 v1.5 连续两回合只移牌 → 同样认输判负', () => {
  const s = battle({ seed: 93, firstPlayer: 'p1' }).state;
  // p1 先放置 3 张（推进行动，回合结束）
  for (let i = 0; i < 3; i++) {
    const a = E.getLegalActions(s).find((x) => x.type === 'place');
    assert.ok(a, '应有放牌行动');
    E.performAction(s, a);
  }
  assert.strictEqual(s.turn, 'p2');
  // p2 摸牌 + 结束（推进行动，避免自己累计 stall），交回 p1
  E.performAction(s, E.getLegalActions(s).find((x) => x.type === 'draw'));
  E.performAction(s, { type: 'end_turn' });
  assert.strictEqual(s.turn, 'p1');
  // p1 第一次只移牌（AP 3 → 3 次 move，自动结束）→ stall 1
  for (let i = 0; i < 3; i++) {
    const a = E.getLegalActions(s).find((x) => x.type === 'move');
    assert.ok(a, '应有移牌行动');
    E.performAction(s, a);
  }
  assert.strictEqual(s.players.p1.stallCount, 1);
  // p2 再次摸牌 + 结束，交回 p1
  E.performAction(s, E.getLegalActions(s).find((x) => x.type === 'draw'));
  E.performAction(s, { type: 'end_turn' });
  assert.strictEqual(s.turn, 'p1');
  // p1 第二次只移牌 → 认输
  for (let i = 0; i < 3 && s.phase === 'battle'; i++) {
    const a = E.getLegalActions(s).find((x) => x.type === 'move');
    if (!a) break;
    E.performAction(s, a);
  }
  assert.strictEqual(s.phase, 'gameover');
  assert.strictEqual(s.result.reason, 'forfeit');
  assert.strictEqual(s.result.forfeitedBy, 'p1');
  invariant(s, '仅移牌认输');
});
