'use strict';
/*
 * 扑克牌 · 比大小 —— 规则边界测试（零依赖，node:test + node:assert）
 * 运行：node tests/edge.test.js
 *
 * 覆盖 RULES.md v1.3 §5/§6/§9 的边界：
 *  - 战略决战：触发条件 牌堆≤2X；双方各摸 X 张把牌堆摸空（不足时 P1⌊剩余/2⌋、P2 余数）
 *  - 最终部署：禁用摸牌/结算，只翻/放/移；一方无手牌且无背面牌时自动跳过，另一方连续行动；双方耗尽摊牌
 *  - 摊牌结算：无随机补牌（drawn 空数组/deterministic）、不执行难度规则、逐区升序、提前锁定可中断
 *  - 单独结算提前锁定（不进入决战）；结算区域含背面牌不计和
 *  - 自定义牌堆边界：D=6R+K+1 退化配置（K=⌊R/2⌋）、花色子集、牌堆下界
 *
 * 白盒：合成局面来自标准 54 张的完整分配（54 张全部有归属，牌张守恒成立）。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');

const E = h.loadEngine();

function invariant(state, label, opts) {
  h.assertInvariants(E, state, label, Object.assign({ skipConservation: true, skipResult: false }, opts || {}));
}

/** 合成局面后执行行动（事件数组以 action 开头）。 */
function act(state, action, label) {
  const events = E.performAction(state, action);
  assert.ok(Array.isArray(events) && events.length && events[0].type === 'action', (label || '') + '事件数组应以 action 开头');
  return events;
}

function eventTypes(events) {
  return events.map((e) => e.type);
}

const FULL_DECK = E.createDeck({ jokers: true, ranks: E.RANKS.slice(), suits: null });
const CARD_BY_ID = new Map(FULL_DECK.map((c) => [c.id, c]));
function card(id) {
  const c = CARD_BY_ID.get(id);
  if (!c) throw new Error('未知牌 id: ' + id);
  return Object.assign({}, c, { revealed: true });
}
function cardsUp(ids) {
  return (ids || []).map(card);
}

/**
 * 用标准 54 张的完整分配合成 battle 局面（54 张全部落到 deck/discard/hands/regions）。
 * spec: { regionCount=3, settleCards=2, difficulty=2, deckCount, deckIds, handIds:{p1,p2},
 *         regionFaces:[{p1:[ids],p2:[ids],p1Down:[ids],p2Down:[ids]}], regionWins }
 * deckIds 缺省时自动从剩余牌 id 中按顺序取 deckCount 张。
 */
function synth(spec) {
  const R = spec.regionCount || 3;
  const pool = FULL_DECK.map((c) => c.id);
  const used = new Set();
  const use = (id) => {
    assert.ok(!used.has(id), '合成局面牌 id 重复：' + id);
    used.add(id);
    return id;
  };
  const regionFaces = spec.regionFaces || [];
  const regions = [];
  for (let i = 0; i < R; i++) {
    const rf = regionFaces[i] || { p1: [], p2: [] };
    regions.push({
      p1FaceUp: (rf.p1 || []).map(use),
      p2FaceUp: (rf.p2 || []).map(use),
      p1FaceDown: (rf.p1Down || []).map(use),
      p2FaceDown: (rf.p2Down || []).map(use),
    });
  }
  const hands = { p1: [], p2: [] };
  for (const pid of ['p1', 'p2']) {
    hands[pid] = ((spec.handIds || {})[pid] || []).map(use);
  }
  const deck = (spec.deckIds
    ? spec.deckIds.map(use)
    : pool.filter((id) => !used.has(id)).slice(0, spec.deckCount || 0).map(use));
  const discard = pool.filter((id) => !used.has(id));
  const state = h.synthBattle(E, {
    regionCount: R,
    config: { settleCards: spec.settleCards || 2, difficulty: spec.difficulty || 2 },
    deck,
    discard,
    hands,
    regions,
    regionWins: spec.regionWins,
    turn: spec.turn || 'p1',
  });
  return state;
}

/** 挑选指定类型/区域的合法行动。 */
function legalOf(state, pred) {
  return E.getLegalActions(state).filter(pred);
}
function firstSettle(state, regionId) {
  return legalOf(state, (a) => a.type === 'settle' && (regionId == null || a.regionId === regionId))[0];
}

/** 连续行动直到终局，返回全部事件（扁平）与行动序列。 */
function runOut(state, opts) {
  const all = [];
  const actions = [];
  const r = new h.Runner(E, state, Object.assign({
    prefer: ['place', 'flip', 'move'],
    checkInvariants: false,
    maxSteps: 300,
    onStep: (st, action, events) => {
      actions.push(action);
      for (const ev of events) all.push(ev);
    },
  }, opts || {}));
  const res = r.run();
  return { events: all, actions, result: res, runner: r };
}

/* ================================================================== */
/* 一、决战触发与补牌                                                   */
/* ================================================================== */

test('§6 决战触发：单独结算后牌堆≤2X → endgame_start/endgame_draw 字段与牌堆摸空', () => {
  // R=5 N=2 难度2：牌堆 11，区域0 可结算；结算消耗 4 → 7；X=4 阈值 8 → 触发，7 张按 3/4 摸空
  const state = synth({
    regionCount: 5,
    settleCards: 2,
    deckCount: 11,
    regionFaces: [
      { p1: ['d-K', 'h-Q'], p2: ['c-2'] },
      { p1: ['s-3'], p2: ['h-4'] },
      { p1: ['s-5'], p2: ['h-6'] },
      { p1: ['s-7'], p2: ['h-8'] },
      { p1: ['s-9'], p2: ['h-10'] },
    ],
  });
  assert.strictEqual(state.deck.length, 11);
  const settle = firstSettle(state, 0);
  assert.ok(settle, '区域0 应可结算');
  const events = act(state, settle, '决战触发');
  assert.deepStrictEqual(eventTypes(events).slice(0, 3), ['action', 'settle', 'endgame_start'], '单独结算触发决战事件流');
  const se = events.find((e) => e.type === 'settle');
  assert.strictEqual(se.endgameTriggered, true);
  assert.strictEqual(se.deckAfter, 7);
  const es = events.find((e) => e.type === 'endgame_start');
  assert.deepStrictEqual(es.openRegionIds, [1, 2, 3, 4], '剩余区域按编号升序');
  assert.strictEqual(es.drawPerPlayer, 4, 'drawPerPlayer = X = 4');
  assert.strictEqual(es.threshold, 8, 'threshold = 2X');
  assert.strictEqual(es.deckCount, 7, '触发时牌堆 7');
  assert.strictEqual(es.settleCards, 2);
  assert.deepStrictEqual(es.drawnCounts, { p1: 3, p2: 4 }, 'P1=⌊7/2⌋、P2 余数');
  const draws = events.filter((e) => e.type === 'endgame_draw');
  assert.deepStrictEqual(draws.map((e) => e.playerId), ['p1', 'p2'], '先 P1 后 P2');
  assert.strictEqual(draws[0].count, 3);
  assert.strictEqual(draws[1].count, 4);
  assert.strictEqual(state.deck.length, 0, '牌堆摸空');
  assert.strictEqual(state.phase, 'battle');
  assert.strictEqual(state.endgame.phase, 'build');
  assert.strictEqual(state.endgame.threshold, 8);
  assert.strictEqual(state.endgame.drawPerPlayer, 4);
  assert.deepStrictEqual(state.endgame.drawnCounts, { p1: 3, p2: 4 });
  assert.deepStrictEqual(state.endgame.skipped, { p1: false, p2: false });
  invariant(state, '决战 build 阶段');
});

test('§6 决战触发：牌堆恰为 2X（摸牌触发）→ 双方各摸 X 张', () => {
  // R=3：牌堆 7 = 2X+1（X=3）→ 摸 1 张到 6 触发，各摸 3 张
  const state = synth({
    regionCount: 3,
    settleCards: 2,
    deckCount: 7,
    handIds: { p1: ['h-K'], p2: ['c-K'] },
    regionFaces: [
      { p1: ['s-A'], p2: ['s-2'] },
      { p1: ['s-3'], p2: ['s-4'] },
      { p1: ['s-5'], p2: ['s-6'] },
    ],
  });
  const events = act(state, { type: 'draw' }, '摸牌触发决战');
  assert.deepStrictEqual(eventTypes(events).slice(0, 3), ['action', 'draw', 'endgame_start']);
  const es = events.find((e) => e.type === 'endgame_start');
  assert.strictEqual(es.threshold, 6);
  assert.strictEqual(es.deckCount, 6);
  assert.deepStrictEqual(es.drawnCounts, { p1: 3, p2: 3 });
  assert.strictEqual(state.deck.length, 0);
  assert.strictEqual(state.endgame.phase, 'build');
  invariant(state, '摸牌触发决战');
});

test('§6 决战最终部署：getLegalActions 不含 draw/settle；performAction 对二者抛 BAD_ACTION', () => {
  const state = synth({
    regionCount: 5,
    settleCards: 2,
    deckCount: 11,
    regionFaces: [
      { p1: ['d-K', 'h-Q'], p2: ['c-2'] },
      { p1: ['s-3'], p2: ['h-4'] },
      { p1: ['s-5'], p2: ['h-6'] },
      { p1: ['s-7'], p2: ['h-8'] },
      { p1: ['s-9'], p2: ['h-10'] },
    ],
  });
  act(state, firstSettle(state, 0), '触发决战');
  assert.strictEqual(state.endgame.phase, 'build');
  const legal = E.getLegalActions(state);
  assert.ok(legal.length > 0);
  assert.ok(legal.every((a) => ['flip', 'place', 'move', 'end_turn'].includes(a.type)),
    '最终部署只允许 flip/place/move/end_turn，实际 ' + JSON.stringify(legal.map((a) => a.type)));
  const before = h.clone(state);
  const e1 = h.assertThrowsError(() => E.performAction(state, { type: 'draw' }), 'BAD_ACTION', '决战禁用摸牌');
  assert.match(e1.message, /决战|禁用/);
  const e2 = h.assertThrowsError(() => E.performAction(state, { type: 'settle', regionId: 1 }), 'BAD_ACTION', '决战禁用结算');
  assert.match(e2.message, /决战|禁用/);
  assert.deepStrictEqual(state, before, '非法行动不改变状态');
  invariant(state, '决战禁用行动');
});

test('§6 决战全流程：一方先耗尽自动跳过（同方仅一次）→ 另一方连续 → 摊牌 → 确定性结算 → 终局', () => {
  const state = synth({
    regionCount: 3,
    settleCards: 1,
    deckCount: 7,
    regionFaces: [
      { p1: ['d-K', 'h-Q'], p2: ['c-2'] },
      { p1: ['s-3'], p2: ['h-4'] },
      { p1: ['s-5'], p2: ['h-6'] },
    ],
  });
  const preEvents = act(state, firstSettle(state, 0), '先结算一区');
  let pre2 = [];
  if (!state.endgame.triggered) {
    const drawAction = E.getLegalActions(state).find((a) => a.type === 'draw');
    assert.ok(drawAction, '应可摸牌');
    pre2 = act(state, drawAction, '摸牌触发决战');
  }
  assert.strictEqual(state.endgame.phase, 'build');
  const openBefore = E.getOpenRegionIds(state);
  const { events, result } = runOut(state);
  const allEvents = preEvents.concat(pre2, events);
  assert.strictEqual(result.reason, 'gameover', '应到达终局');

  const start = allEvents.find((e) => e.type === 'endgame_start');
  assert.ok(start, '应有 endgame_start');
  const skips = allEvents.filter((e) => e.type === 'endgame_skip');
  assert.ok(skips.length >= 1, '双方手牌/背面数不同，应出现跳过事件');
  const skipPids = skips.map((e) => e.playerId);
  assert.strictEqual(new Set(skipPids).size, skipPids.length, '同一方最多一条 endgame_skip');
  assert.deepStrictEqual([state.endgame.skipped.p1, state.endgame.skipped.p2],
    [skipPids.includes('p1'), skipPids.includes('p2')], 'skipped 标记与事件一致');
  // 跳过后另一方连续行动：行动玩家序列中出现相邻重复
  const actorSeq = [];
  for (const ev of events) if (ev.type === 'action') actorSeq.push(ev.playerId);
  assert.ok(actorSeq.some((pid, i) => i > 0 && pid === actorSeq[i - 1]), '跳过后另一方应连续行动');

  const showdown = events.find((e) => e.type === 'endgame_showdown');
  assert.ok(showdown, '双方耗尽应摊牌');
  assert.deepStrictEqual(showdown.openRegionIds, openBefore);
  assert.strictEqual(showdown.deckCount, 0);
  const settles = events.filter((e) => e.type === 'endgame_settle');
  assert.ok(settles.length >= 1);
  for (const s of settles) {
    assert.strictEqual(s.deterministic, true);
    assert.strictEqual(s.drawnCount, 0);
    assert.deepStrictEqual(s.drawn, { p1: [], p2: [] });
    assert.strictEqual(s.deckAfter, 0);
    assert.strictEqual(s.regionResult.difficultyDraw, null);
    assert.deepStrictEqual(s.sums, {
      p1: s.regionBefore.sides.p1.faceUp.reduce((sum, c) => sum + c.value, 0),
      p2: s.regionBefore.sides.p2.faceUp.reduce((sum, c) => sum + c.value, 0),
    }, '摊牌只按正面牌点数求和');
    const w = s.sums.p1 > s.sums.p2 ? 'p1' : (s.sums.p2 > s.sums.p1 ? 'p2' : 'tie');
    assert.strictEqual(s.winner, w);
  }
  if (!state.result.early) {
    assert.deepStrictEqual(settles.map((s) => s.regionId), openBefore, '摊牌按编号升序结算全部剩余区域');
    assert.deepStrictEqual(state.result.handSums, { p1: 0, p2: 0 }, '摊牌后手牌 0:0');
    assert.strictEqual(state.phase, 'gameover');
    assert.strictEqual(state.endgame.phase, 'done');
  }
  assert.strictEqual(state.deck.length, 0);
  assert.deepStrictEqual(E.getLegalActions(state), [], '终局后无合法行动');
  invariant(state, '决战全流程终局');
});

test('§6 摊牌结算：难度1/3 均无难度摸牌、双方不摸牌、手牌总和 0:0', () => {
  for (const difficulty of [1, 3]) {
    const state = synth({
      regionCount: 5,
      settleCards: 2,
      difficulty,
      deckCount: 11,
      regionFaces: [
        { p1: ['d-K', 'h-Q'], p2: ['c-2'] },
        { p1: ['s-3'], p2: ['h-4'] },
        { p1: ['s-5'], p2: ['h-6'] },
        { p1: ['s-7'], p2: ['h-8'] },
        { p1: ['s-9'], p2: ['h-10'] },
      ],
    });
    act(state, firstSettle(state, 0), '触发决战（难度' + difficulty + '）');
    const { events } = runOut(state);
    const settles = events.filter((e) => e.type === 'endgame_settle');
    assert.ok(settles.length >= 1);
    for (const s of settles) {
      assert.strictEqual(s.regionResult.difficultyDraw, null, '难度' + difficulty + ' 摊牌无难度摸牌');
      assert.strictEqual(s.drawnCount, 0);
    }
    assert.deepStrictEqual(state.result.handSums, { p1: 0, p2: 0 });
    invariant(state, '难度' + difficulty + ' 摊牌终局');
  }
});

/* ================================================================== */
/* 二、提前锁定                                                         */
/* ================================================================== */

test('§6.1 提前锁定：单独结算达到胜场门槛 → 立即终局，不进入决战', () => {
  // R=3 winsNeeded=2；p1 已有 1 胜，区域0 p1 大胜 → 单独结算后 2 胜锁定
  const state = synth({
    regionCount: 3,
    settleCards: 1,
    regionWins: { p1: 1, p2: 0, ties: 0 },
    deckCount: 9,
    regionFaces: [
      { p1: ['d-K', 'h-Q'], p2: ['c-2'] },
      { p1: ['s-3'], p2: ['h-4'] },
      { p1: ['s-5'], p2: ['h-6'] },
    ],
  });
  const events = act(state, firstSettle(state, 0), '单独结算提前锁定');
  assert.deepStrictEqual(eventTypes(events), ['action', 'settle', 'game_over'], '提前锁定：无 endgame_start');
  const last = events[events.length - 1];
  assert.strictEqual(last.type, 'game_over');
  assert.strictEqual(last.result.early, true);
  assert.strictEqual(last.result.reason, 'region_wins');
  assert.strictEqual(last.result.winner, 'p1');
  assert.deepStrictEqual(last.result.unsettledRegions, [1, 2]);
  assert.strictEqual(state.phase, 'gameover');
  assert.strictEqual(state.endgame.triggered, false);
  assert.ok(state.regions[1].status === 'open' && state.regions[2].status === 'open');
  invariant(state, '单独结算提前锁定终局', { skipWins: true });
});

test('§6.1 提前锁定：摊牌结算途中达到门槛 → 立即中断，剩余区域保持 open', () => {
  // R=5 winsNeeded=3；p1 已有 2 胜。设计：
  //  一次性单独结算区域0（补牌后 17:17 平，双方无胜场变化），牌堆恰好 4→0 触发决战；
  //  双方手牌/背面牌均为 0，立即摊牌；摊牌区域1 p1 J vs p2 2 → p1 第 3 胜 → 提前锁定，剩余 2/3/4 保持 open。
  const state = synth({
    regionCount: 5,
    settleCards: 2,
    regionWins: { p1: 2, p2: 0, ties: 0 },
    deckIds: ['s-5', 's-6', 'h-5', 'h-6'], // 区域0：p1 5+11=16、p2 5+11=16 平
    regionFaces: [
      { p1: ['d-A', 'd-4'], p2: ['d-5'] }, // 正面 3 张，可结算；补牌后 16:16 平
      { p1: ['d-J'], p2: ['c-6'] },         // 摊牌 p1 11:6 胜 → 第 3 胜
      { p1: ['d-6'], p2: ['c-7'] },
      { p1: ['d-7'], p2: ['c-8'] },
      { p1: ['d-8'], p2: ['c-9'] },
    ],
  });
  const settle = firstSettle(state, 0);
  assert.ok(settle, '区域0 应可结算（正面 3 张）');
  const events = act(state, settle, '单独结算触发决战');
  assert.strictEqual(state.endgame.triggered, true, '结算后牌堆 0 ≤ 2X 应触发决战');
  assert.deepStrictEqual(state.endgame.drawnCounts, { p1: 0, p2: 0 }, '牌堆已空，双方各摸 0 张');
  if (!E.isGameOver(state)) runOut(state);
  assert.strictEqual(state.phase, 'gameover');
  void events;
  assert.ok(state.result.early, 'result.early=true');
  assert.strictEqual(state.result.reason, 'region_wins');
  assert.strictEqual(state.result.winner, 'p1');
  assert.deepStrictEqual(state.result.unsettledRegions, [2, 3, 4], '摊牌在区域1锁定后中断');
  assert.ok(state.regions.slice(2).every((r) => r.status === 'open'), '剩余区域保持 open');
  assert.strictEqual(state.regions[0].status, 'settled');
  assert.strictEqual(state.regions[1].status, 'settled');
  assert.deepStrictEqual(E.getLegalActions(state), []);
  invariant(state, '摊牌提前锁定终局', { skipWins: true });
});

/* ================================================================== */
/* 三、单独结算 / 弃牌 / 背面牌                                          */
/* ================================================================== */

test('§5 §9#13 结算区域含背面牌：背面牌不计和、随区域废弃进弃牌堆', () => {
  const state = synth({
    regionCount: 3,
    settleCards: 2,
    deckCount: 12,
    regionFaces: [
      { p1: ['d-K', 'd-Q'], p2: ['h-Q'], p1Down: ['s-2', 's-3'], p2Down: ['c-4'] },
      { p1: ['s-5'], p2: ['h-6'] },
      { p1: ['s-7'], p2: ['h-8'] },
    ],
  });
  const preRegion = h.clone(state.regions[0]);
  const discardBefore = state.discard.length;
  const settle = firstSettle(state, 0);
  assert.ok(settle);
  const events = act(state, settle, '含背面牌结算');
  const se = events.find((e) => e.type === 'settle');
  assert.strictEqual(se.sums.p1, preRegion.sides.p1.faceUp.reduce((s, c) => s + c.value, 0) + se.drawn.p1.reduce((s, c) => s + c.value, 0),
    '背面牌不得计入 p1 总和');
  assert.strictEqual(se.sums.p2, preRegion.sides.p2.faceUp.reduce((s, c) => s + c.value, 0) + se.drawn.p2.reduce((s, c) => s + c.value, 0),
    '背面牌不得计入 p2 总和');
  assert.strictEqual(state.regions[0].status, 'settled');
  const allP1 = state.regions[0].result.allCards.p1;
  assert.strictEqual(allP1.length, preRegion.sides.p1.faceUp.length + preRegion.sides.p1.faceDown.length + 2);
  const regionCards = preRegion.sides.p1.faceUp.length + preRegion.sides.p1.faceDown.length +
    preRegion.sides.p2.faceUp.length + preRegion.sides.p2.faceDown.length;
  assert.strictEqual(state.discard.length - discardBefore, regionCards + 4, '区域所有牌 + 2N 补牌进弃牌堆');
  invariant(state, '含背面牌结算后');
});

test('§9#14 全部区域单独结算完（合成精确）：无决战事件，直接判定', () => {
  // R=3 winsNeeded=2；三区事先构造可结算（正面≥3）：
  //   区域0 p1 胜（1:0）、区域1 p2 胜（1:1）、区域2 平 → 无人达到 2 胜；
  //   三个单独结算共消耗 12 张，牌堆 18→6，从未触发决战；手牌 9:9 → draw。
  const state = synth({
    regionCount: 3,
    settleCards: 2,
    difficulty: 2,
    handIds: { p1: ['h-9'], p2: ['c-9'] },
    deckIds: [
      's-A', 's-2', 'h-A', 'h-3',   // 区域0 补牌：p1 3 / p2 4 → p1 18:6 胜
      's-3', 's-4', 'h-8', 'd-9',   // 区域1 补牌：p1 7 / p2 17 → p2 10:34 胜
      's-5', 's-6', 'h-5', 'h-6',   // 区域2 补牌：双方 11 → 22:22 平
    ],
    regionFaces: [
      { p1: ['d-K', 'd-2'], p2: ['h-2'] },
      { p1: ['d-3'], p2: ['h-K', 'h-4'] },
      { p1: ['d-5', 'd-6'], p2: ['c-5', 'c-6'] },
    ],
  });
  let events = [];
  let guard = 0;
  while (!E.isGameOver(state) && guard++ < 10) {
    const settle = firstSettle(state);
    assert.ok(settle, '每一区都应可结算（正面≥3）');
    events = events.concat(act(state, settle, '单独结算'));
  }
  assert.strictEqual(state.phase, 'gameover');
  assert.strictEqual(state.endgame.triggered, false, '全部单独结算完不应触发决战');
  assert.ok(state.regions.every((r) => r.status === 'settled'));
  assert.deepStrictEqual(eventTypes(events).filter((t) => t === 'endgame_start'), [], '无决战事件');
  assert.strictEqual(state.result.early, false);
  assert.strictEqual(state.result.winner, 'draw', '区域 1:1 平 1、手牌 9:9 → 平局');
  assert.strictEqual(state.result.reason, 'draw');
  assert.deepStrictEqual(state.result.handSums, { p1: 9, p2: 9 });
  invariant(state, '全部单独结算终局');
});

/* ================================================================== */
/* 四、自定义牌堆 / 配置边界                                             */
/* ================================================================== */

test('§8 deck.suits 支持：花色子集生成牌堆与 validateConfig.info.suitCount', () => {
  const deck = E.createDeck({ jokers: false, ranks: ['A', 'K'], suits: ['s', 'h'] });
  assert.strictEqual(deck.length, 4);
  assert.deepStrictEqual([...new Set(deck.map((c) => c.rank))].sort(), ['A', 'K'].sort());
  const v = E.validateConfig(E.defaultConfig({ deck: { jokers: true, ranks: ['A', 'K'], suits: ['s', 'h'] } }));
  assert.strictEqual(v.info.deckSize, 6);
  assert.strictEqual(v.info.suitCount, 2);
});

test('§9#15 退化配置 D=6R+K+1（R=3, 20 张）：gap=1 警告，摸牌即触发决战', () => {
  // R=3、K=1、D=20：deckAfterSetup = 20-12-1 = 7 = 2R+1 → 摸 1 张到 6 = 阈值 → 触发
  const deckSpec = { jokers: false, ranks: ['A', '2', '3', '4', '5'] }; // 5 ranks × 4 suits = 20
  const v = E.validateConfig(E.defaultConfig({ regionCount: 3, deck: deckSpec }));
  assert.strictEqual(v.ok, true, '20 张恰好满足 6R+K+1=20');
  assert.strictEqual(v.info.compensationDraw, 1, 'R=3 后手补偿 1 张');
  assert.strictEqual(v.info.deckSize, 20);
  assert.strictEqual(v.info.deckAfterSetup, 7);
  assert.strictEqual(v.info.gapToEndgame, 1);
  assert.ok(v.warnings.length > 0, 'gap=1≤2 应警告');
  const state = E.createGame(E.defaultConfig({ regionCount: 3, deck: deckSpec, seed: 3, firstPlayer: 'p1' }));
  E.submitLayout(state, 'p1', state.players.p1.hand.slice(0, 3).map((c) => c.id));
  E.submitLayout(state, 'p2', state.players.p2.hand.slice(0, 3).map((c) => c.id));
  E.finalizeLayout(state);
  assert.strictEqual(state.deck.length, 7, '布局后牌堆 7 = 2R+1');
  const drawAction = E.getLegalActions(state).find((a) => a.type === 'draw');
  assert.ok(drawAction);
  const events = act(state, drawAction, '退化配置摸牌触发');
  const es = events.find((e) => e.type === 'endgame_start');
  assert.ok(es, '摸牌后应触发决战');
  assert.strictEqual(state.deck.length, 0, '补牌摸空');
  assert.strictEqual(state.endgame.phase, 'build');
  invariant(state, '退化配置决战');
});

test('§8 牌堆下界：D=6R+K+1 合法（gap=1）、D=6R+K 非法（K=⌊R/2⌋）', () => {
  // 合法下界：D ≥ 4R+K（发牌 + 后手补偿）且 D ≥ 6R+K+1（布局后牌堆严格大于初始阈值 2R）。
  // R=3/K=1 时边界为 20；标准 54 对 3/5/7 = 6R+K+1（19/32/46）均满足。
  assert.strictEqual(E.createDeck({ jokers: true, ranks: E.RANKS.slice(), suits: null }).length, 54);
  assert.strictEqual(E.createDeck({ jokers: false, ranks: E.RANKS.slice(), suits: null }).length, 52);
  assert.strictEqual((54 % 2) + (52 % 2), 0, '标准牌堆张数为偶数');

  // R=3 K=1：18 张（< 6R+K+1=20）非法；20 张边界合法且 gap=1
  const below = E.validateConfig(E.defaultConfig({ regionCount: 3, deck: { jokers: true, ranks: ['A', '2', '3', '4'] } }));
  assert.strictEqual(below.ok, false, '18 张 < 6R+K+1 = 20 应非法');
  const boundary = E.validateConfig(E.defaultConfig({ regionCount: 3, deck: { jokers: false, ranks: ['A', '2', '3', '4', '5'] } }));
  assert.strictEqual(boundary.ok, true, '20 张 = 6R+K+1 应合法');
  assert.strictEqual(boundary.info.compensationDraw, 1);
  assert.strictEqual(boundary.info.gapToEndgame, 1, 'D=6R+K+1 时 gap=1');
  // 花色子集牌堆允许任意张数（不要求偶数）；校验只按张数公式
  const oddDeck = E.validateConfig(E.defaultConfig({ regionCount: 3, deck: { jokers: true, ranks: ['A'], suits: ['s'] } }));
  assert.strictEqual(oddDeck.ok, false, '3 张牌堆远小于 6R+K+1 应非法');
  assert.ok(Array.isArray(oddDeck.errors) && oddDeck.errors.length > 0);
});
