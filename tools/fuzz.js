#!/usr/bin/env node
/* 规则引擎随机对局模糊测试（Lead 工具）
 * 校验：随机合法行动全部可执行、非法行动被拒绝、事件流结构、状态不变量、终局合法性
 * 用法：node tools/fuzz.js [--games=300] [--seed=1]
 */
'use strict';
const path = require('path');
const E = require(path.join(__dirname, '..', 'js', 'engine.js'));
const AI = require(path.join(__dirname, '..', 'js', 'ai.js'));

const arg = (k, d) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith('--' + k + '='));
  return hit ? hit.split('=')[1] : d;
};
const GAMES = Number(arg('games', 300));
const START = Number(arg('seed', 1));

function snapshotTotal(state) {
  let n = state.deck.length + state.discard.length;
  ['p1', 'p2'].forEach((p) => { n += state.players[p].hand.length; });
  state.regions.forEach((r) => {
    n += r.sides.p1.faceUp.length + r.sides.p1.faceDown.length;
    n += r.sides.p2.faceUp.length + r.sides.p2.faceDown.length;
  });
  return n;
}

function assertEventFlow(events, state) {
  if (!Array.isArray(events)) throw new Error('事件流不是数组');
  events.forEach((ev) => {
    if (!ev || typeof ev.type !== 'string') throw new Error('事件缺少 type');
  });
  const hasGameOver = events.some((e) => e.type === 'game_over');
  if (hasGameOver && state.phase !== 'gameover') throw new Error('出现 game_over 但 phase 不是 gameover');
  if (events[0] && events[0].type === 'layout_reveal') {
    if (!events.some((e) => e.type === 'battle_start')) throw new Error('布局事件缺少 battle_start');
  }
  events.forEach((ev) => {
    if (ev.type === 'settle') {
      if (!Array.isArray(ev.drawn.p1) || !Array.isArray(ev.drawn.p2)) throw new Error('settle drawn 应为数组');
      if (ev.drawn.p1.length !== state.config.settleCards || ev.drawn.p2.length !== state.config.settleCards) {
        throw new Error('settle drawn 张数不等于 settleCards');
      }
      if (ev.regionResult && ev.regionResult.deterministic) throw new Error('单独结算不应 deterministic');
      if (ev.regionResult) {
        const fu = (ev.regionResult.faceUp.p1 || []).length + (ev.regionResult.faceUp.p2 || []).length;
        if (fu > 2) { /* 正常 */ }
      }
    }
    if (ev.type === 'turn_start') {
      if (ev.playerId !== 'p1' && ev.playerId !== 'p2') throw new Error('turn_start playerId 非法');
      if (ev.ap !== state.config.apPerTurn) throw new Error('turn_start 行动点未回满');
    }
    if (ev.type === 'turn_end') {
      if (ev.playerId !== 'p1' && ev.playerId !== 'p2') throw new Error('turn_end playerId 非法');
      if (['manual', 'ap', 'no-action'].indexOf(ev.reason) < 0) throw new Error('turn_end reason 非法：' + ev.reason);
      if (typeof ev.leftAp !== 'number') throw new Error('turn_end 缺少 leftAp');
    }
    if (ev.type === 'endgame_start') {
      if (!Array.isArray(ev.openRegionIds) || !ev.openRegionIds.length) throw new Error('endgame_start 缺少 openRegionIds');
      if (ev.drawPerPlayer !== ev.openRegionIds.length) throw new Error('drawPerPlayer 应等于剩余区域数');
      if (ev.threshold !== 2 * ev.openRegionIds.length) throw new Error('endgame threshold 应为 2X');
      if (ev.drawnCounts.p1 + ev.drawnCounts.p2 !== ev.deckCount) throw new Error('决战补牌未摸空牌堆');
    }
    if (ev.type === 'endgame_draw') {
      if (!ev.playerId || typeof ev.count !== 'number' || typeof ev.handSize !== 'number') throw new Error('endgame_draw 字段缺失');
    }
    if (ev.type === 'endgame_skip') {
      if (ev.playerId !== 'p1' && ev.playerId !== 'p2') throw new Error('endgame_skip playerId 非法');
    }
    if (ev.type === 'endgame_showdown') {
      if (!Array.isArray(ev.openRegionIds)) throw new Error('endgame_showdown 缺少 openRegionIds');
    }
    if (ev.type === 'endgame_settle') {
      if (ev.deterministic !== true) throw new Error('摊牌结算应 deterministic:true');
      if (ev.drawnCount !== 0) throw new Error('摊牌结算 drawnCount 应为 0');
      if (!Array.isArray(ev.drawn.p1) || ev.drawn.p1.length || !Array.isArray(ev.drawn.p2) || ev.drawn.p2.length) {
        throw new Error('摊牌结算 drawn 应为空数组');
      }
      if (!ev.regionResult || ev.regionResult.difficultyDraw !== null) throw new Error('摊牌不应有难度摸牌');
    }
  });
  const triggerIdx = events.findIndex((e) => e.type === 'endgame_start');
  if (triggerIdx >= 0) {
    const drawCount = events.filter((e) => e.type === 'endgame_draw').length;
    if (drawCount !== 2) throw new Error('endgame_start 后应有两个 endgame_draw');
  }
  const overIdx = events.findIndex((e) => e.type === 'game_over');
  if (overIdx >= 0) {
    if (overIdx !== events.length - 1) throw new Error('game_over 必须是最后一个事件');
  }
}

function checkIllegal(state) {
  const pid = state.turn;
  const legal = E.getLegalActions(state);
  if (!legal.length) throw new Error('战役/决战阶段无合法行动');
  const costs = E.ACTION_COSTS;
  const ap = state.players[pid].ap;
  if (!legal.some((a) => a.type === 'end_turn')) throw new Error('合法行动缺少 end_turn');
  if (!legal.some((a) => a.type === 'settle') && ap >= costs.settle && E.getOpenRegionIds(state).length && state.deck.length >= 2 * state.config.settleCards) {
    throw new Error('AP 足够且牌堆充足但合法行动缺少 settle');
  }
  const inEndgame = state.endgame.triggered && state.endgame.phase === 'build';
  if (inEndgame) {
    if (legal.some((a) => a.type === 'draw' || a.type === 'settle')) throw new Error('决战 build 阶段出现了 draw/settle 合法行动');
    try {
      E.performAction(state, { type: 'draw' });
      throw new Error('决战阶段摸牌未被拒绝');
    } catch (err) { if (err.message === '决战阶段摸牌未被拒绝') throw err; if (err.code !== 'BAD_ACTION') throw err; }
    try {
      E.performAction(state, { type: 'settle', regionId: 0 });
      throw new Error('决战阶段结算未被拒绝');
    } catch (err) { if (err.message === '决战阶段结算未被拒绝') throw err; if (err.code !== 'BAD_ACTION') throw err; }
  } else if (ap < costs.settle && E.getOpenRegionIds(state).length && state.deck.length >= 2 * state.config.settleCards) {
    try {
      E.performAction(state, { type: 'settle', regionId: E.getOpenRegionIds(state)[0] });
      throw new Error('AP 不足时结算未被拒绝');
    } catch (err) {
      if (err.message === 'AP 不足时结算未被拒绝') throw err;
      if (err.code !== 'BAD_ACTION') throw err;
    }
  }
  const openIds = E.getOpenRegionIds(state);
  for (const rid of openIds) {
    const opp = pid === 'p1' ? 'p2' : 'p1';
    const fd = state.regions[rid].sides[opp].faceDown;
    if (fd.length) {
      try { E.performAction(state, { type: 'flip', regionId: rid, cardId: fd[0].id }); throw new Error('非法翻牌未被拒绝'); }
      catch (err) { if (err.message === '非法翻牌未被拒绝') throw err; }
      break;
    }
  }
  for (const rid of openIds) {
    const fd = state.regions[rid].sides[pid].faceDown;
    if (fd.length) {
      try { E.performAction(state, { type: 'move', fromRegionId: rid, cardId: fd[0].id, toRegionId: rid }); throw new Error('非法移牌未被拒绝'); }
      catch (err) { if (err.message === '非法移牌未被拒绝') throw err; }
      break;
    }
  }
  return legal;
}

function verifyResult(state) {
  const res = state.result;
  if (!res) throw new Error('终局缺少 result');
  if (['p1', 'p2', 'draw'].indexOf(res.winner) < 0) throw new Error('winner 非法：' + res.winner);
  if (['region_wins', 'hand_sum', 'draw'].indexOf(res.reason) < 0) throw new Error('reason 非法：' + res.reason);
  const openIds = E.getOpenRegionIds(state);
  const w = res.regionWins;
  const settled = state.regions.filter((r) => r.status === 'settled').length;
  if (w.p1 + w.p2 + w.ties !== settled) throw new Error('区域胜场计数不等于已结算区域数');
  if (res.early !== (openIds.length > 0)) throw new Error('early 标志与未结算区域不一致');
  if (res.early) {
    if (JSON.stringify(res.unsettledRegions) !== JSON.stringify(openIds)) throw new Error('unsettledRegions 与 open 区域不一致');
    if (res.reason !== 'region_wins') throw new Error('提前锁定 reason 应为 region_wins');
    if (w.p1 < res.winsNeeded && w.p2 < res.winsNeeded) throw new Error('提前锁定但无人达门槛');
  }
  if (!res.early && state.regions.some((r) => r.status !== 'settled')) throw new Error('终局仍有未结算区域');
  if (state.endgame.triggered) {
    if (state.deck.length !== 0) throw new Error('决战触发后牌堆应被摸空');
    if (state.endgame.phase !== 'done') throw new Error('终局 endgame.phase 应为 done，实际 ' + state.endgame.phase);
  }
  if (res.reason === 'draw') {
    if (res.handSums.p1 !== res.handSums.p2) throw new Error('draw 但手牌和不同');
    if (w.p1 >= res.winsNeeded || w.p2 >= res.winsNeeded) throw new Error('draw 但有一方达到胜场门槛');
  }
  if (res.reason === 'region_wins' && w.p1 < res.winsNeeded && w.p2 < res.winsNeeded) {
    throw new Error('region_wins 但无人达门槛');
  }
  if (res.reason === 'hand_sum') {
    if (w.p1 >= res.winsNeeded || w.p2 >= res.winsNeeded) throw new Error('hand_sum 但有人达门槛');
    if (res.handSums.p1 === res.handSums.p2) throw new Error('hand_sum 但手牌和相等');
  }
}

function playRandom(seed) {
  const R = seed % 5 === 0 ? 3 : (seed % 7 === 0 ? 7 : 5);
  const settleCards = [1, 2, 4][seed % 3];
  const st = E.createGame({ seed, regionCount: R, difficulty: (seed % 3) + 1, settleCards });
  const total = snapshotTotal(st);
  const rng = E.makeRng(seed ^ 0xDEADBEEF);
  const l1 = [];
  const l2 = [];
  const h1 = st.players.p1.hand.slice();
  const h2 = st.players.p2.hand.slice();
  for (let i = 0; i < st.config.regionCount; i++) {
    l1.push(h1.splice(rng.int(h1.length), 1)[0].id);
    l2.push(h2.splice(rng.int(h2.length), 1)[0].id);
  }
  E.submitLayout(st, 'p1', l1);
  E.submitLayout(st, 'p2', l2);
  let events = E.finalizeLayout(st);
  assertEventFlow(events, st);
  if (snapshotTotal(st) !== total) throw new Error('布局后牌张不守恒');

  let steps = 0;
  while (!E.isGameOver(st)) {
    if (steps++ > 3000) throw new Error('对局未终止');
    const legal = checkIllegal(st);
    const pid = st.turn;
    const apBefore = st.players[pid].ap;
    let action;
    if (st.endgame.triggered && st.endgame.phase === 'build') {
      // 决战部署：优先 翻/放（消耗牌，保证推进）；没有时 end_turn
      const productive = legal.filter((a) => a.type === 'flip' || a.type === 'place');
      action = productive.length ? productive[rng.int(productive.length)] : legal.find((a) => a.type === 'end_turn') || legal[0];
    } else {
      // 普通战役：随机推进型行动（不使用 move/end_turn，避免无消耗循环）；保留 settle/draw/place/flip
      const pool = legal.filter((a) => a.type !== 'move' && a.type !== 'end_turn');
      action = pool.length ? pool[rng.int(pool.length)] : legal.find((a) => a.type === 'end_turn') || legal[0];
    }
    events = E.performAction(st, action);
    assertEventFlow(events, st);
    const turnStartEv = events.find((e) => e.type === 'turn_start');
    const turnEndEv = events.find((e) => e.type === 'turn_end');
    const samePlayer = st.turn === pid;
    if (action.type === 'end_turn') {
      if (!turnEndEv || turnEndEv.reason !== 'manual') throw new Error('end_turn 未产生 manual 的 turn_end');
    } else if (samePlayer && !turnStartEv) {
      if (st.players[pid].ap !== apBefore - E.ACTION_COSTS[action.type]) {
        throw new Error('同回合行动后 AP 扣减错误：' + action.type + ' before=' + apBefore + ' after=' + st.players[pid].ap);
      }
    } else if (!samePlayer && st.phase === 'battle' && st.turn) {
      if (st.players[st.turn].ap !== st.config.apPerTurn) throw new Error('新回合 AP 未回满');
    }
    if (st.phase === 'battle' && !st.turn) throw new Error('battle 阶段无行动方');
    if (snapshotTotal(st) !== total) throw new Error('行动后牌张不守恒');
    if (st.deck.length < 0) throw new Error('牌堆为负');
  }
  verifyResult(st);
  return { steps, result: st.result, endgame: st.endgame.triggered, early: !!st.result.early };
}

/* AI 信息公平性：打乱对手手牌/背面牌/牌堆/弃牌顺序，同一固定 rng 下决策应完全一致 */
function aiFairness(seed) {
  function mk() {
    const st = E.createGame({ seed, regionCount: 5, difficulty: 1, settleCards: 2 });
    const l1 = AI.chooseLayout(st, 'p1', { layoutStrategy: 'top' });
    const l2 = AI.chooseLayout(st, 'p2', { layoutStrategy: 'balanced' });
    E.submitLayout(st, 'p1', l1);
    E.submitLayout(st, 'p2', l2);
    E.finalizeLayout(st);
    for (let i = 0; i < 8; i++) {
      if (E.isGameOver(st)) break;
      const a = AI.chooseAction(st, st.turn, { strength: 'hard' });
      E.performAction(st, a);
    }
    return st;
  }
  const a = mk();
  const b = mk();
  if (E.isGameOver(a) || E.isGameOver(b)) return true;
  const pid = a.turn;
  const opp = pid === 'p1' ? 'p2' : 'p1';
  const rngA = E.makeRng(123456);
  const rngB = E.makeRng(123456);
  const actA = AI.chooseAction(a, pid, { rng: rngA, strength: 'hard' });
  const shuffle = E.makeRng(777);
  shuffle.shuffle(b.deck);
  shuffle.shuffle(b.players[opp].hand);
  b.regions.forEach((r) => { shuffle.shuffle(r.sides[opp].faceDown); });
  shuffle.shuffle(b.discard);
  const actB = AI.chooseAction(b, pid, { rng: rngB, strength: 'hard' });
  return JSON.stringify(actA) === JSON.stringify(actB);
}

function main() {
  let ok = 0, fail = 0, endgames = 0, earlies = 0, steps = 0;
  const errors = [];
  for (let g = 0; g < GAMES; g++) {
    const seed = START + g;
    try {
      const r = playRandom(seed);
      ok++; steps += r.steps; if (r.endgame) endgames++; if (r.early) earlies++;
    } catch (err) {
      fail++; errors.push('[seed ' + seed + '] ' + err.message);
      if (errors.length > 8) break;
    }
  }
  let fairOk = 0, fairFail = 0;
  for (let s = 1; s <= 20; s++) {
    try { aiFairness(s) ? fairOk++ : fairFail++; } catch (e) { fairFail++; }
  }
  console.log('随机合法行动模糊测试: 完成 ' + ok + '/' + GAMES + '，失败 ' + fail +
    '，触发决战 ' + endgames + ' 局，提前锁定 ' + earlies + ' 局，平均行动数 ' + (steps / Math.max(1, ok)).toFixed(1));
  console.log('AI 信息公平性（打乱对手隐藏信息后决策一致）: ' + fairOk + '/' + (fairOk + fairFail));
  if (errors.length) {
    console.log('失败样例：');
    errors.forEach((e) => console.log('  ' + e));
    process.exitCode = 1;
  }
}

main();
