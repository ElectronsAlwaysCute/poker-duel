'use strict';
/*
 * qa-dev 测试公共工具（零依赖，仅 Node 内置模块）。
 * 职责：加载引擎/AI、状态不变量校验、合法行动枚举比对、局面驱动、种子搜索、失败复现信息。
 * 规则事实来源：docs/RULES.md；接口契约：docs/CONTRACT.md。禁止在这里放宽规则断言。
 */

const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const ENGINE_PATH = path.join(ROOT, 'js', 'engine.js');
const AI_PATH = path.join(ROOT, 'js', 'ai.js');

/* ------------------------------------------------------------------ */
/* 加载                                                                */
/* ------------------------------------------------------------------ */

function loadEngine() {
  let E;
  try {
    E = require(ENGINE_PATH);
  } catch (err) {
    console.error('\n[qa] 无法加载引擎 ' + ENGINE_PATH);
    console.error('[qa] 原因：' + err.message);
    console.error('[qa] js/engine.js 尚未就绪。请等 Lead 交付后重跑：node tests/engine.test.js\n');
    process.exit(2);
  }
  if (!E || typeof E.createGame !== 'function' || typeof E.performAction !== 'function') {
    console.error('\n[qa] js/engine.js 已存在但导出 API 不完整（需要 createGame/performAction 等，见 CONTRACT §2）。\n');
    process.exit(2);
  }
  return E;
}

function loadAI() {
  let AI;
  try {
    AI = require(AI_PATH);
  } catch (err) {
    console.error('\n[qa] 无法加载 AI ' + AI_PATH + '：' + err.message);
    console.error('[qa] js/ai.js 尚未就绪。\n');
    process.exit(2);
  }
  if (!AI || typeof AI.chooseAction !== 'function' || typeof AI.chooseLayout !== 'function') {
    console.error('\n[qa] js/ai.js 导出 API 不完整（需要 chooseLayout/chooseAction，见 CONTRACT §6）。\n');
    process.exit(2);
  }
  return AI;
}

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function sumValues(cards) {
  return (cards || []).reduce((s, c) => s + ((c && Number(c.value)) || 0), 0);
}

function idsOf(cards) {
  return (cards || []).map((c) => (c && typeof c === 'object' ? c.id : c));
}

function deckSizeOf(E, config) {
  return E.createDeck(config.deck).length;
}

function openRegionIds(state) {
  return state.regions.filter((r) => r.status === 'open').map((r) => r.id);
}

function regionById(state, id) {
  return state.regions.find((r) => r.id === id);
}

/** 收集 state 中所有「活跃」牌（牌堆/弃牌堆/双方手牌/未结算区域正反面）。 */
function collectActiveCards(state) {
  const out = [];
  const add = (arr, zone) => {
    for (const c of arr || []) out.push({ card: c, zone });
  };
  add(state.deck, 'deck');
  add(state.discard, 'discard');
  add(state.players && state.players.p1 && state.players.p1.hand, 'players.p1.hand');
  add(state.players && state.players.p2 && state.players.p2.hand, 'players.p2.hand');
  for (const r of state.regions || []) {
    if (r.status !== 'open') continue;
    for (const pid of ['p1', 'p2']) {
      const side = (r.sides && r.sides[pid]) || {};
      add(side.faceUp, 'regions[' + r.id + '].' + pid + '.faceUp');
      add(side.faceDown, 'regions[' + r.id + '].' + pid + '.faceDown');
    }
  }
  return out;
}

function countSideCards(side) {
  return (((side && side.faceUp) || []).length) + (((side && side.faceDown) || []).length);
}

/* ------------------------------------------------------------------ */
/* 不变量                                                              */
/* ------------------------------------------------------------------ */

const VALID_PHASES = ['layout', 'battle', 'gameover'];
const VALID_TONES = ['info', 'p1', 'p2', 'warn', 'result'];
const VALID_REASONS = ['region_wins', 'hand_sum', 'draw', 'forfeit'];

/**
 * 校验 docs/CONTRACT.md §8 要求的不变量。返回错误字符串数组（空数组=通过）。
 * opts.deckSize    覆盖期望牌张总数（默认按 config.deck 计算）
 * opts.skipConservation       跳过牌张守恒（仅用于手工构造的边界局面）
 * opts.skipResult             跳过终局 result 语义校验
 */
function invariantErrors(E, state, opts) {
  opts = opts || {};
  const errors = [];
  const add = (msg) => errors.push(msg);
  const safe = (fn, label) => {
    try {
      return fn();
    } catch (err) {
      add('调用 ' + label + ' 抛错：' + err.message);
      return undefined;
    }
  };

  if (!state || typeof state !== 'object') return ['state 不是对象'];
  if (typeof state.version !== 'string') add('state.version 缺失');
  if (!state.config) add('缺少 state.config');
  if (!VALID_PHASES.includes(state.phase)) add('非法 phase=' + state.phase);

  const R = (state.config && state.config.regionCount) ||
    (state.regions ? state.regions.length : 0);

  /* --- 基础结构 --- */
  if (!Array.isArray(state.deck)) add('state.deck 不是数组');
  if (!Array.isArray(state.discard)) add('state.discard 不是数组');
  if (!state.players || !state.players.p1 || !state.players.p2) {
    add('state.players 结构缺失');
  } else {
    for (const pid of ['p1', 'p2']) {
      if (!Array.isArray(state.players[pid].hand)) add('players.' + pid + '.hand 不是数组');
      if (typeof state.players[pid].regionsWon !== 'number') add('players.' + pid + '.regionsWon 不是数字');
    }
  }
  if (!Array.isArray(state.regions)) {
    add('state.regions 不是数组');
  } else {
    if (state.regions.length !== R) add('regions 长度 ' + state.regions.length + ' ≠ regionCount ' + R);
    state.regions.forEach((r, i) => {
      if (!r || typeof r !== 'object') { add('regions[' + i + '] 为空'); return; }
      if (r.id !== i) add('regions[' + i + '].id=' + r.id + '，应为 ' + i);
      if (r.status !== 'open' && r.status !== 'settled') add('regions[' + i + '].status 非法：' + r.status);
      if (!r.sides || !r.sides.p1 || !r.sides.p2) { add('regions[' + i + '].sides 结构缺失'); return; }
      for (const pid of ['p1', 'p2']) {
        if (!Array.isArray(r.sides[pid].faceUp)) add('regions[' + i + '].' + pid + '.faceUp 不是数组');
        if (!Array.isArray(r.sides[pid].faceDown)) add('regions[' + i + '].' + pid + '.faceDown 不是数组');
      }
    });
  }

  /* --- 阶段相关 --- */
  if (state.phase === 'layout') {
    if (state.turn !== null && state.turn !== undefined) add('layout 阶段 turn 应为 null，实际 ' + state.turn);
    if (state.result) add('layout 阶段不应有 result');
    if (state.regions && state.regions.some((r) => countSideCards(r.sides && r.sides.p1) + countSideCards(r.sides && r.sides.p2) > 0)) {
      add('layout 阶段区域不应已有牌');
    }
  } else if (state.phase === 'battle') {
    if (state.turn !== 'p1' && state.turn !== 'p2') add('battle 阶段 turn 非法：' + state.turn);
    if (state.result) add('battle 阶段不应有 result');
    if (openRegionIds(state).length === 0) add('battle 阶段但没有未结算区域（应为 gameover）');
    const over = safe(() => E.isGameOver(state), 'isGameOver');
    if (over === true) add('battle 阶段但 isGameOver=true');
    // v1.4 行动点：当前行动方 AP 应为正整数且不超过 apPerTurn，账单与合法行动一致
    const apPerTurn = (state.config && state.config.apPerTurn) || 3;
    if (!state.players || !state.players.p1 || !state.players.p2) {
      // 结构缺失已在上面报告
    } else {
      for (const pid of ['p1', 'p2']) {
        const ap = state.players[pid].ap;
        if (!Number.isInteger(ap) || ap < 0 || ap > apPerTurn) {
          add('players.' + pid + '.ap 非法：' + JSON.stringify(ap) + '（应 0..' + apPerTurn + '）');
        }
      }
      if (state.turn) {
        const ap = state.players[state.turn].ap;
        if (!Number.isInteger(ap) || ap <= 0) add('当前行动方 ' + state.turn + ' 的 ap=' + JSON.stringify(ap) + '，进行中的回合应 >0');
      }
    }
    // 合法行动：cost 与 E.ACTION_COSTS 一致、均可支付、始终包含 end_turn
    const legal = safe(() => E.getLegalActions(state), 'getLegalActions');
    if (Array.isArray(legal)) {
      if (state.turn) {
        const ap = state.players[state.turn].ap;
        for (const a of legal) {
          const cost = E.ACTION_COSTS && E.ACTION_COSTS[a.type];
          if (cost === undefined) add('getLegalActions 返回未知行动类型：' + (a && a.type));
          else if (a.cost !== cost) add('行动 ' + a.type + ' 的 cost=' + JSON.stringify(a.cost) + '，应为 ' + cost);
          if (typeof a.cost === 'number' && Number.isFinite(ap) && a.cost > ap) {
            add('getLegalActions 返回了 AP 不可支付的行动：' + canonicalAction(a) + '（cost=' + a.cost + ' > ap=' + ap + '）');
          }
        }
        if (!legal.some((a) => a && a.type === 'end_turn')) add('getLegalActions 必须始终包含 end_turn');
      }
      // v1.3：战略决战最终部署阶段禁用摸牌/结算
      if (state.endgame && state.endgame.triggered) {
        if (legal.some((a) => a && (a.type === 'draw' || a.type === 'settle'))) {
          add('决战最终部署阶段 getLegalActions 不应包含 draw/settle：' + JSON.stringify(legal.map((a) => a.type)));
        }
        if (openRegionIds(state).length > 0 && legal.length === 0) {
          add('决战最终部署阶段没有合法行动但仍有未结算区域（应自动跳过或摊牌）');
        }
      } else if (state.turn) {
        // v1.4：任意未结算区域均可结算（不再要求正面牌 >2）；仅牌堆 ≥2N 才有 settle
        const N = (state.config && state.config.settleCards) || 2;
        const ap = state.players[state.turn].ap;
        const canSettle = openRegionIds(state).length > 0 && (state.deck || []).length >= 2 * N && ap >= (E.ACTION_COSTS.settle || 3);
        const settleKeys = legal.filter((a) => a && a.type === 'settle').map(canonicalAction).sort();
        const expectSettle = canSettle ? openRegionIds(state).map((rid) => canonicalAction({ type: 'settle', regionId: rid })).sort() : [];
        if (JSON.stringify(settleKeys) !== JSON.stringify(expectSettle)) {
          add('getLegalActions settle 集合=' + JSON.stringify(settleKeys) + '，应为 ' + JSON.stringify(expectSettle));
        }
      }
    }
  } else if (state.phase === 'gameover') {
    if (state.turn !== null) add('gameover 阶段 turn 应为 null，实际 ' + state.turn);
    if (state.players) {
      for (const pid of ['p1', 'p2']) {
        if (state.players[pid] && state.players[pid].ap !== 0) add('gameover 阶段 players.' + pid + '.ap 应清 0，实际 ' + state.players[pid].ap);
      }
    }
    if (!state.result) add('gameover 阶段缺少 result');
    const openAtEnd = openRegionIds(state);
    const early = !!(state.result && state.result.early);
    const forfeitEnd = !!(state.result && state.result.reason === 'forfeit');
    if (openAtEnd.length > 0 && !early && !forfeitEnd) {
      add('gameover 阶段仍有未结算区域（' + openAtEnd.join(',') + '）但 result.early=false 且不是认输');
    }
    if (early) {
      if (!Array.isArray(state.result.unsettledRegions)) add('提前锁定结果缺少 unsettledRegions 数组');
      else if (JSON.stringify(state.result.unsettledRegions) !== JSON.stringify(openAtEnd)) {
        add('result.unsettledRegions=' + JSON.stringify(state.result.unsettledRegions) + '，实际未结算区域=' + JSON.stringify(openAtEnd));
      }
      if (!state.result.regionWins || !state.regionWins) add('提前锁定结果缺少 regionWins');
      else if (state.result.regionWins.p1 !== state.regionWins.p1 || state.result.regionWins.p2 !== state.regionWins.p2) {
        add('提前锁定 result.regionWins 与 state.regionWins 不一致');
      }
      if (state.result.reason !== 'region_wins') add('提前锁定 result.reason 应为 region_wins，实际 ' + state.result.reason);
    } else if (!forfeitEnd && Array.isArray(state.result && state.result.unsettledRegions) && state.result.unsettledRegions.length) {
      add('非提前锁定却 unsettledRegions 非空：' + JSON.stringify(state.result.unsettledRegions));
    }
    const legal = safe(() => E.getLegalActions(state), 'getLegalActions');
    if (Array.isArray(legal) && legal.length > 0) add('gameover 阶段 getLegalActions 应为空，实际 ' + legal.length + ' 个');
    const over = safe(() => E.isGameOver(state), 'isGameOver');
    if (over === false) add('gameover 阶段但 isGameOver=false');
  }

  /* --- 战略决战状态（v1.3） --- */
  if (state.endgame) {
    const eg = state.endgame;
    if (typeof eg.triggered !== 'boolean') add('state.endgame.triggered 应为布尔');
    if (eg.triggered) {
      if (!['build', 'showdown', 'done'].includes(eg.phase)) add('决战已触发但 endgame.phase 非法：' + eg.phase);
      if (typeof eg.threshold !== 'number') add('决战已触发但 endgame.threshold 不是数字');
      if (typeof eg.drawPerPlayer !== 'number') add('决战已触发但 endgame.drawPerPlayer 不是数字');
      if (!eg.drawnCounts || typeof eg.drawnCounts.p1 !== 'number' || typeof eg.drawnCounts.p2 !== 'number') {
        add('决战已触发但 endgame.drawnCounts 非法');
      }
      if (!eg.skipped || typeof eg.skipped.p1 !== 'boolean' || typeof eg.skipped.p2 !== 'boolean') {
        add('决战已触发但 endgame.skipped 非法');
      }
      if (eg.phase === 'build' || eg.phase === 'showdown') {
        const thresholdNow = safe(() => E.getEndgameThreshold(state), 'getEndgameThreshold');
        if (thresholdNow !== 2 * openRegionIds(state).length) {
          add('决战进行中 getEndgameThreshold=' + thresholdNow + '，应为 2×未结算区域数=' + (2 * openRegionIds(state).length));
        }
      }
    } else if (eg.phase != null) {
      add('未触发决战但 endgame.phase 非 null：' + eg.phase);
    }
    if (eg.triggered && state.phase === 'gameover') {
      const rEarly = !!(state.result && state.result.early);
      if (!rEarly && eg.phase !== 'done') add('决战结束但 endgame.phase 应为 done，实际 ' + eg.phase);
      if (rEarly && eg.phase !== 'showdown' && eg.phase !== 'done') {
        add('提前锁定结束但 endgame.phase 应为 showdown/done，实际 ' + eg.phase);
      }
    }
  } else {
    add('state.endgame 缺失');
  }

  /* --- 牌张守恒 / 唯一性 / 牌面数值 --- */
  const active = collectActiveCards(state);
  const seen = new Map();
  for (const item of active) {
    const card = item.card;
    if (!card || typeof card !== 'object') { add('非法牌对象 @' + item.zone); continue; }
    if (typeof card.id !== 'string' || !card.id) { add('牌缺少 id @' + item.zone); continue; }
    if (seen.has(card.id)) add('牌 ' + card.id + ' 重复出现：' + seen.get(card.id) + ' 与 ' + item.zone);
    seen.set(card.id, item.zone);
    const expect = E.RANK_VALUES && E.RANK_VALUES[card.rank];
    if (expect === undefined) add('牌 ' + card.id + ' 的 rank=' + JSON.stringify(card.rank) + ' 不在 RANK_VALUES');
    else if (Number(card.value) !== expect) add('牌 ' + card.id + ' value=' + card.value + '，期望 ' + expect);
    if (typeof card.joker !== 'boolean') add('牌 ' + card.id + ' joker 字段应为布尔');
    if (!('suit' in card)) add('牌 ' + card.id + ' 缺少 suit 字段');
    if (!('suitSymbol' in card)) add('牌 ' + card.id + ' 缺少 suitSymbol 字段');
  }
  if (!opts.skipConservation) {
    const expectDeckSize = opts.deckSize != null ? opts.deckSize : safe(() => deckSizeOf(E, state.config), 'createDeck(config.deck)');
    if (expectDeckSize != null && active.length !== expectDeckSize) {
      add('牌张守恒失败：活跃牌 ' + active.length + ' 张 ≠ 牌堆构成 ' + expectDeckSize + ' 张（deck=' +
        ((state.deck || []).length) + ', discard=' + ((state.discard || []).length) + ', hands=' +
        idsOf(state.players && state.players.p1 && state.players.p1.hand).length + '/' +
        idsOf(state.players && state.players.p2 && state.players.p2.hand).length + '）');
    }
  }

  /* --- 区域结构 / 求和 / API 一致性 --- */
  const settleCards = (state.config && state.config.settleCards) || 2;
  if (Array.isArray(state.regions)) {
    for (const r of state.regions) {
      if (!r || !r.sides) continue;
      if (r.status === 'settled') {
        const left = countSideCards(r.sides.p1) + countSideCards(r.sides.p2);
        if (left > 0) add('区域 ' + r.id + ' 已结算但 sides 仍留 ' + left + ' 张牌（规则要求进弃牌堆）');
        if (!r.result) add('区域 ' + r.id + ' 已结算但缺少 result');
        else {
          const res = r.result;
          const deterministic = res.deterministic === true;
          if (!['p1', 'p2', 'tie'].includes(res.winner)) add('区域 ' + r.id + ' result.winner 非法：' + res.winner);
          if (!deterministic && res.settleCards !== settleCards) add('区域 ' + r.id + ' result.settleCards=' + res.settleCards + '，与 config.settleCards=' + settleCards + ' 不一致');
          if (!res.drawn || !Array.isArray(res.drawn.p1) || !Array.isArray(res.drawn.p2)) {
            add('区域 ' + r.id + ' result.drawn 必须为 {p1:Card[],p2:Card[]} 数组');
          } else if (deterministic) {
            if (res.drawn.p1.length !== 0 || res.drawn.p2.length !== 0) {
              add('区域 ' + r.id + ' 摊牌结算 drawn 应为空数组，实际 ' + res.drawn.p1.length + '/' + res.drawn.p2.length);
            }
            if (res.drawnCount != null && res.drawnCount !== 0) add('区域 ' + r.id + ' 摊牌结算 drawnCount 应为 0');
            if (res.difficultyDraw != null) add('区域 ' + r.id + ' 摊牌结算不应有难度摸牌');
          } else {
            if (res.drawn.p1.length !== settleCards) add('区域 ' + r.id + ' result.drawn.p1 长度=' + res.drawn.p1.length + '，应为 ' + settleCards);
            if (res.drawn.p2.length !== settleCards) add('区域 ' + r.id + ' result.drawn.p2 长度=' + res.drawn.p2.length + '，应为 ' + settleCards);
            const allDrawn = res.drawn.p1.concat(res.drawn.p2);
            for (const c of allDrawn) {
              if (!c || c.revealed !== true) add('区域 ' + r.id + ' 结算补牌应 revealed=true');
            }
          }
          if (!res.faceUp || !Array.isArray(res.faceUp.p1) || !Array.isArray(res.faceUp.p2)) {
            add('区域 ' + r.id + ' result.faceUp 缺失');
          }
          if (!res.sums || typeof res.sums.p1 !== 'number' || typeof res.sums.p2 !== 'number') {
            add('区域 ' + r.id + ' result.sums 非法');
          } else {
            const expectWinner = res.sums.p1 > res.sums.p2 ? 'p1' : (res.sums.p2 > res.sums.p1 ? 'p2' : 'tie');
            if (res.winner !== expectWinner) {
              add('区域 ' + r.id + ' result.winner=' + res.winner + ' 但 sums=' + JSON.stringify(res.sums) + '（期望 ' + expectWinner + '）');
            }
          }
          if (res.faceUp && res.sums && res.drawn && Array.isArray(res.drawn.p1) && Array.isArray(res.drawn.p2)) {
            const v1 = sumValues(res.faceUp.p1) + (deterministic ? 0 : sumValues(res.drawn.p1));
            const v2 = sumValues(res.faceUp.p2) + (deterministic ? 0 : sumValues(res.drawn.p2));
            if (res.sums.p1 !== v1) add('区域 ' + r.id + ' sums.p1=' + res.sums.p1 + ' ≠ 正面牌和+补牌和=' + v1);
            if (res.sums.p2 !== v2) add('区域 ' + r.id + ' sums.p2=' + res.sums.p2 + ' ≠ 正面牌和+补牌和=' + v2);
          }
        }
      } else if (r.status === 'open') {
        if (r.result) add('区域 ' + r.id + ' 未结算却有 result');
        for (const pid of ['p1', 'p2']) {
          const manual = sumValues(r.sides[pid].faceUp);
          const api = safe(() => E.getRegionSideSum(state, r.id, pid), 'getRegionSideSum');
          if (api !== undefined && api !== manual) {
            add('getRegionSideSum(区域 ' + r.id + ',' + pid + ')=' + api + '，实际正面和=' + manual);
          }
        }
        const manualCount = r.sides.p1.faceUp.length + r.sides.p2.faceUp.length;
        const apiCount = safe(() => E.getRegionFaceUpCount(state, r.id), 'getRegionFaceUpCount');
        if (apiCount !== undefined && apiCount !== manualCount) {
          add('getRegionFaceUpCount(区域 ' + r.id + ')=' + apiCount + '，实际 ' + manualCount);
        }
      }
    }
  }

  /* --- 区域胜场 / 打开区域 / 决战阈值 API --- */
  if (Array.isArray(state.regions) && state.regionWins && !opts.skipWins) {
    const expectWins = { p1: 0, p2: 0, ties: 0 };
    for (const r of state.regions) {
      if (r.status !== 'settled' || !r.result) continue;
      if (r.result.winner === 'tie') expectWins.ties += 1;
      else if (r.result.winner === 'p1') expectWins.p1 += 1;
      else if (r.result.winner === 'p2') expectWins.p2 += 1;
    }
    for (const k of ['p1', 'p2', 'ties']) {
      if (state.regionWins[k] !== expectWins[k]) {
        add('regionWins.' + k + '=' + state.regionWins[k] + '，按区域结果应为 ' + expectWins[k]);
      }
    }
    if (state.players && state.players.p1 && state.players.p1.regionsWon !== expectWins.p1) {
      add('players.p1.regionsWon=' + state.players.p1.regionsWon + '，应为 ' + expectWins.p1);
    }
    if (state.players && state.players.p2 && state.players.p2.regionsWon !== expectWins.p2) {
      add('players.p2.regionsWon=' + state.players.p2.regionsWon + '，应为 ' + expectWins.p2);
    }
  }
  if (Array.isArray(state.regions) && E.getOpenRegionIds) {
    const expectOpen = openRegionIds(state);
    const apiOpen = safe(() => E.getOpenRegionIds(state), 'getOpenRegionIds') || [];
    if (JSON.stringify(expectOpen) !== JSON.stringify(apiOpen)) {
      add('getOpenRegionIds=' + JSON.stringify(apiOpen) + '，实际未结算区域=' + JSON.stringify(expectOpen));
    }
    const threshold = safe(() => E.getEndgameThreshold(state), 'getEndgameThreshold');
    const expectedThreshold = 2 * expectOpen.length;
    if (threshold !== undefined && threshold !== expectedThreshold) {
      add('getEndgameThreshold=' + threshold + '，应为 2×' + expectOpen.length + '=' + expectedThreshold);
    }
  }
  if (state.players && E.getHandSum) {
    for (const pid of ['p1', 'p2']) {
      const hand = (state.players[pid] && state.players[pid].hand) || [];
      const manual = sumValues(hand);
      const api = safe(() => E.getHandSum(state, pid), 'getHandSum');
      if (api !== undefined && api !== manual) add('getHandSum(' + pid + ')=' + api + '，实际 ' + manual);
    }
  }

  /* --- 终局判定 --- */
  if (state.phase === 'gameover' && state.result && state.config && !opts.skipResult) {
    const result = state.result;
    const hands = {
      p1: sumValues(state.players && state.players.p1 && state.players.p1.hand),
      p2: sumValues(state.players && state.players.p2 && state.players.p2.hand),
    };
    const wins = state.regionWins || { p1: 0, p2: 0, ties: 0 };
    const need = state.config.winsNeeded;
    const openAtEnd = openRegionIds(state);
    /** 终局判定（v1.5 支持认输 forfeit） */
    const isForfeit = result.reason === 'forfeit';
    if (isForfeit) {
      // 认输：winner 必须是 forfeitedBy 的对手；剩余区域允许未结算；不要求达到胜场门槛
      const fBy = result.forfeitedBy;
      if (fBy !== 'p1' && fBy !== 'p2') add('forfeit 终局 result.forfeitedBy 非法：' + fBy);
      const expectW = fBy === 'p1' ? 'p2' : (fBy === 'p2' ? 'p1' : 'unknown');
      if (!['p1', 'p2', 'draw'].includes(result.winner)) add('result.winner 非法：' + result.winner);
      if (!VALID_REASONS.includes(result.reason)) add('result.reason 非法：' + result.reason);
      if (result.winner !== expectW) add('认输终局 result.winner=' + result.winner + '，应为 forfeitedBy 的对手 ' + expectW);
      if (result.early !== false) add('认输终局 result.early 应为 false，实际 ' + result.early);
      const unsettled = Array.isArray(result.unsettledRegions) ? result.unsettledRegions : [];
      if (JSON.stringify(unsettled) !== JSON.stringify(openAtEnd)) {
        add('认输终局 result.unsettledRegions=' + JSON.stringify(unsettled) + '，实际未结算区域=' + JSON.stringify(openAtEnd));
      }
      if (!opts.skipWins && (!result.regionWins || result.regionWins.p1 !== wins.p1 || result.regionWins.p2 !== wins.p2 || result.regionWins.ties !== wins.ties)) {
        add('result.regionWins=' + JSON.stringify(result.regionWins) + ' ≠ state.regionWins=' + JSON.stringify(wins));
      }
      if (!result.handSums || result.handSums.p1 !== hands.p1 || result.handSums.p2 !== hands.p2) {
        add('result.handSums=' + JSON.stringify(result.handSums) + ' ≠ 实际手牌总和 ' + JSON.stringify(hands));
      }
      if (result.winsNeeded !== need) add('result.winsNeeded=' + result.winsNeeded + ' ≠ config.winsNeeded ' + need);
    } else {
    let expectWinner;
    let expectReason;
    if (wins.p1 >= need) { expectWinner = 'p1'; expectReason = 'region_wins'; }
    else if (wins.p2 >= need) { expectWinner = 'p2'; expectReason = 'region_wins'; }
    else if (openAtEnd.length > 0) {
      add('终局时仍有未结算区域且无人达到胜场门槛：' + openAtEnd.join(','));
      expectWinner = 'unknown'; expectReason = 'unknown';
    }
    // v2.6：无人达到门槛时先比区域胜场（多者胜），再比手牌总和，最后才平局
    else if (wins.p1 > wins.p2) { expectWinner = 'p1'; expectReason = 'region_wins'; }
    else if (wins.p2 > wins.p1) { expectWinner = 'p2'; expectReason = 'region_wins'; }
    else if (hands.p1 > hands.p2) { expectWinner = 'p1'; expectReason = 'hand_sum'; }
    else if (hands.p2 > hands.p1) { expectWinner = 'p2'; expectReason = 'hand_sum'; }
    else { expectWinner = 'draw'; expectReason = 'draw'; }
    if (!['p1', 'p2', 'draw'].includes(result.winner)) add('result.winner 非法：' + result.winner);
    if (!VALID_REASONS.includes(result.reason)) add('result.reason 非法：' + result.reason);
    if (result.winner !== expectWinner) add('终局 result.winner=' + result.winner + '，按规则应为 ' + expectWinner);
    if (result.reason !== expectReason) add('终局 result.reason=' + result.reason + '，按规则应为 ' + expectReason);
    const expectEarly = expectReason === 'region_wins' && openAtEnd.length > 0;
    if (result.early !== expectEarly) add('result.early=' + result.early + '，按未结算区域应为 ' + expectEarly);
    if (expectEarly) {
      if (JSON.stringify(result.unsettledRegions) !== JSON.stringify(openAtEnd)) {
        add('result.unsettledRegions=' + JSON.stringify(result.unsettledRegions) + '，实际未结算区域=' + JSON.stringify(openAtEnd));
      }
    }
    if (!opts.skipWins && (!result.regionWins || result.regionWins.p1 !== wins.p1 || result.regionWins.p2 !== wins.p2 || result.regionWins.ties !== wins.ties)) {
      add('result.regionWins=' + JSON.stringify(result.regionWins) + ' ≠ state.regionWins=' + JSON.stringify(wins));
    }
    if (!result.handSums || result.handSums.p1 !== hands.p1 || result.handSums.p2 !== hands.p2) {
      add('result.handSums=' + JSON.stringify(result.handSums) + ' ≠ 实际手牌总和 ' + JSON.stringify(hands));
    }
    if (result.winsNeeded !== need) add('result.winsNeeded=' + result.winsNeeded + ' ≠ config.winsNeeded ' + need);
    }
    if (!isForfeit && state.endgame && state.endgame.triggered && !result.early && Array.isArray(state.deck) && state.deck.length !== 0) {
      add('决战已触发（未被提前锁定中断）但牌堆仍有 ' + state.deck.length + ' 张（决战补牌应把牌堆摸空）');
    }
    // 摊牌结算后双方手牌均已放空（跳过条件），手牌总和应为 0:0
    if (!isForfeit && state.endgame && state.endgame.triggered && state.endgame.phase === 'done' && !result.early) {
      if (result.handSums.p1 !== 0 || result.handSums.p2 !== 0) {
        add('摊牌结束后手牌总和应为 0:0（双方均无手牌才摊牌），实际 ' + JSON.stringify(result.handSums));
      }
      if (state.players && (state.players.p1.hand.length || state.players.p2.hand.length)) {
        add('摊牌结束后双方手牌应为空，实际 ' + state.players.p1.hand.length + '/' + state.players.p2.hand.length);
      }
    }
  }

  /* --- 日志 --- */
  if (Array.isArray(state.log)) {
    let lastSeq = -Infinity;
    for (const entry of state.log) {
      if (!entry || typeof entry.text !== 'string' || !entry.text) { add('日志条目缺少中文 text'); break; }
      if (typeof entry.seq !== 'number') add('日志条目缺少 seq');
      else if (entry.seq <= lastSeq) add('日志 seq 未递增：' + entry.seq + ' 在 ' + lastSeq + ' 之后');
      else lastSeq = entry.seq;
      if (entry.tone != null && !VALID_TONES.includes(entry.tone)) add('日志 tone 非法：' + entry.tone);
    }
  }

  return errors;
}

/** 校验不变量，失败则抛出带复现信息的错误。 */
function assertInvariants(E, state, label, opts) {
  const errors = invariantErrors(E, state, opts);
  if (errors.length) {
    const err = new Error('[' + (label || '不变量') + '] 校验失败 ' + errors.length + ' 项：\n  - ' + errors.join('\n  - ') +
      '\n' + describeState(state));
    err.invariantErrors = errors;
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* 状态摘要 / 复现信息                                                  */
/* ------------------------------------------------------------------ */

function describeState(state) {
  if (!state || !state.config) return '（state 无效）';
  const hands = state.players ? {
    p1: ((state.players.p1 && state.players.p1.hand) || []).length,
    p2: ((state.players.p2 && state.players.p2.hand) || []).length,
  } : {};
  const eg = state.endgame || null;
  return '局面：seed=' + state.config.seed + ' R=' + state.config.regionCount + ' N=' + state.config.settleCards +
    ' diff=' + state.config.difficulty +
    ' first=' + state.config.firstPlayer + ' phase=' + state.phase + ' turn=' + state.turn +
    ' ap=' + JSON.stringify({ p1: state.players && state.players.p1 ? state.players.p1.ap : null, p2: state.players && state.players.p2 ? state.players.p2.ap : null }) +
    ' turnCount=' + state.turnCount + ' deck=' + ((state.deck || []).length) +
    ' discard=' + ((state.discard || []).length) + ' hands=' + JSON.stringify(hands) +
    ' regions=' + JSON.stringify((state.regions || []).map((r) => r.id + ':' + r.status)) +
    ' wins=' + JSON.stringify(state.regionWins || null) +
    (eg ? ' endgame=' + JSON.stringify({ triggered: eg.triggered, phase: eg.phase, drawPerPlayer: eg.drawPerPlayer, drawnCounts: eg.drawnCounts }) : '') +
    (state.result ? ' result=' + JSON.stringify({ winner: state.result.winner, reason: state.result.reason, early: state.result.early }) : '');
}

function reproInfo(E, state, trace) {
  const lines = [];
  lines.push('可复现信息：');
  lines.push('  seed=' + (state && state.config ? state.config.seed : '?') +
    ' config=' + JSON.stringify(state && state.config ? {
      regionCount: state.config.regionCount,
      difficulty: state.config.difficulty,
      settleCards: state.config.settleCards,
      firstPlayer: state.config.firstPlayer,
      apPerTurn: state.config.apPerTurn,
      deck: state.config.deck,
      aiStrength: state.config.aiStrength,
    } : null));
  lines.push('  actionTrace=' + JSON.stringify(trace || []));
  lines.push('  复现：E.createGame(E.defaultConfig(' + JSON.stringify({
    seed: state && state.config ? state.config.seed : 1,
    regionCount: state && state.config ? state.config.regionCount : 5,
    difficulty: state && state.config ? state.config.difficulty : 1,
    settleCards: state && state.config ? state.config.settleCards : 2,
    firstPlayer: state && state.config ? state.config.firstPlayer : 'p1',
  }) + ')) → submitLayout(前R张) → finalizeLayout → 依次 performAction(actionTrace)');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* Action 规范化 / 合法性                                               */
/* ------------------------------------------------------------------ */

function canonicalAction(action) {
  const t = action && action.type;
  if (t === 'settle') return 'settle|' + action.regionId;
  if (t === 'flip') return 'flip|' + action.regionId + '|' + action.cardId;
  if (t === 'place') return 'place|' + action.regionId + '|' + action.cardId;
  if (t === 'move') return 'move|' + action.fromRegionId + '|' + action.cardId + '|' + action.toRegionId;
  if (t === 'draw') return 'draw';
  if (t === 'end_turn') return 'end_turn';
  return 'unknown|' + JSON.stringify(action);
}

function findLegalEquivalent(action, legalActions) {
  const key = canonicalAction(action);
  for (const a of legalActions || []) {
    if (canonicalAction(a) === key) return a;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 对局搭建 / 驱动                                                     */
/* ------------------------------------------------------------------ */

/** 创建一局并直接自动布局（双方各取手牌前 R 张）进入 battle 阶段。 */
function setupBattle(E, overrides) {
  const config = E.defaultConfig(Object.assign({ seed: 12345 }, overrides || {}));
  const state = E.createGame(config);
  const R = state.config.regionCount;
  const layoutIds = {
    p1: state.players.p1.hand.slice(0, R).map((c) => c.id),
    p2: state.players.p2.hand.slice(0, R).map((c) => c.id),
  };
  E.submitLayout(state, 'p1', layoutIds.p1);
  E.submitLayout(state, 'p2', layoutIds.p2);
  const events = E.finalizeLayout(state);
  return { state, events, layoutIds };
}

/** 创建一局并停在布局阶段（双方各 2R 张手牌）。 */
function setupLayout(E, overrides) {
  const config = E.defaultConfig(Object.assign({ seed: 12345 }, overrides || {}));
  const state = E.createGame(config);
  return { state, config };
}

/**
 * 确定性选行动：
 *  opts.filter(action, state) -> boolean
 *  opts.prefer = ['settle','flip',...] 优先的行动类型（取第一个非空类型，再按 canonical 排序取第一个）
 *  opts.index 在排序后的候选里取第 index 个（用于产生多样性，仍确定性）
 */
function pickAction(E, state, legalActions, opts) {
  opts = opts || {};
  let list = (legalActions || []).slice();
  if (opts.filter) list = list.filter((a) => opts.filter(a, state));
  if (!list.length) throw new Error('pickAction：按策略过滤后无合法行动。' + describeState(state));
  if (opts.prefer) {
    for (const type of opts.prefer) {
      const subset = list.filter((a) => a.type === type);
      if (subset.length) { list = subset; break; }
    }
  }
  list.sort((a, b) => (canonicalAction(a) < canonicalAction(b) ? -1 : canonicalAction(a) > canonicalAction(b) ? 1 : 0));
  const idx = opts.index != null ? opts.index % list.length : 0;
  return list[idx];
}

/**
 * 对局驱动器：自动执行行动并逐步校验不变量/回合交替，记录 trace 便于复现。
 *
 * opts:
 *  filter/prefer/index  透传 pickAction
 *  maxSteps             安全上限（默认 800）
 *  stopWhen(state)      每步行动前判断，true 则停止
 *  onStep(state, action, events, i)  返回 'stop' 可停止
 *  invOpts              透传 assertInvariants
 *  beforeStep(state)    每步行动前钩子
 *  checkInvariants      默认 true
 */
class Runner {
  constructor(E, state, opts) {
    this.E = E;
    this.state = state;
    this.opts = opts || {};
    this.trace = this.opts.trace || [];
    this.steps = 0;
    this.stoppedByHook = false;
  }

  invariants(label, opts) {
    assertInvariants(this.E, this.state, label || '第 ' + this.steps + ' 步', Object.assign({}, this.opts.invOpts, opts));
  }

  fail(message, cause) {
    const e = new Error(message + '\n' + describeState(this.state) + '\n' + reproInfo(this.E, this.state, this.trace) +
      (cause ? '\n原始错误：' + (cause.stack || cause.message) : ''));
    e.cause = cause;
    return e;
  }

  legal() {
    const legal = this.E.getLegalActions(this.state);
    if (!Array.isArray(legal)) throw this.fail('getLegalActions 未返回数组');
    return legal;
  }

  /** 行动后的回合/AP 一致性（v1.4）：事件与 state 必须自洽。 */
  _assertTurnConsistency(prevTurn, prevAp, action, events) {
    const state = this.state;
    const E = this.E;
    const endEv = events.find((e) => e && e.type === 'turn_end') || null;
    const startEv = events.find((e) => e && e.type === 'turn_start') || null;
    const endgameTriggeredNow = events.some((e) => e && e.type === 'endgame_start');
    const over = state.phase === 'gameover';
    if (endEv && startEv) {
      const endIdx = events.indexOf(endEv);
      const startIdx = events.indexOf(startEv);
      const between = events.slice(endIdx + 1, startIdx).map((e) => e && e.type);
      if (startIdx < endIdx || between.some((t) => t !== 'endgame_skip')) {
        throw this.fail('回合事件顺序应为 turn_end →（可选 endgame_skip）→ turn_start，实际：' + events.map((e) => e.type).join(','));
      }
    }
    if (startEv && !endEv && !endgameTriggeredNow) {
      throw this.fail('出现 turn_start 却没有 turn_end（且非决战触发）：' + events.map((e) => e.type).join(','));
    }
    if (state.phase === 'battle') {
      if (!state.turn) throw this.fail('battle 阶段行动后 turn 为空');
      const expectStartAp = state.config.apPerTurn;
      if (state.turn === prevTurn) {
        if (endEv || startEv) {
          // 同一玩家开新回合（对方在决战中被跳过）：turn_end(prevTurn)+turn_start(prevTurn)，AP 回满
          if (!endEv || !startEv) throw this.fail('同一玩家新回合应同时有 turn_end/turn_start');
          if (endEv.playerId !== prevTurn) throw this.fail('turn_end.playerId 应为 ' + prevTurn + '，实际 ' + endEv.playerId);
          if (startEv.playerId !== prevTurn) throw this.fail('turn_start.playerId 应为 ' + prevTurn + '，实际 ' + startEv.playerId);
          if (state.players[state.turn].ap !== expectStartAp) {
            throw this.fail('新回合 AP 应回满 ' + expectStartAp + '，实际 ' + state.players[state.turn].ap);
          }
        } else {
          // 同一回合继续行动：无回合事件，AP 必须按 cost 扣减
          const cost = E.ACTION_COSTS[action.type];
          if (typeof cost !== 'number') throw this.fail('未知行动 cost：' + action.type);
          if (state.players[prevTurn].ap !== prevAp - cost) {
            throw this.fail('同回合继续行动后 ap=' + state.players[prevTurn].ap + '，应为 ' + prevAp + '-' + cost + '=' + (prevAp - cost));
          }
        }
      } else {
        // 换人：应有 turn_end(prevTurn) + turn_start(新行动方, AP 回满)；决战触发路径允许只有 turn_start
        if (!endEv) {
          if (!endgameTriggeredNow) throw this.fail('换人却没有 turn_end 事件：' + events.map((e) => e.type).join(','));
        } else if (endEv.playerId !== prevTurn) {
          throw this.fail('turn_end.playerId 应为 ' + prevTurn + '，实际 ' + endEv.playerId);
        }
        if (!startEv) throw this.fail('换人却没有 turn_start 事件');
        if (startEv.playerId !== state.turn) throw this.fail('turn_start.playerId=' + startEv.playerId + ' 与 state.turn=' + state.turn + ' 不一致');
        if (startEv.ap !== expectStartAp) throw this.fail('turn_start.ap 应回满 ' + expectStartAp + '，实际 ' + startEv.ap);
        if (state.players[state.turn].ap !== expectStartAp) {
          throw this.fail('新行动方 AP 应回满 ' + expectStartAp + '，实际 ' + state.players[state.turn].ap);
        }
      }
    } else if (over) {
      if (state.players.p1.ap !== 0 || state.players.p2.ap !== 0) throw this.fail('终局后双方 AP 应清 0');
    }
  }

  step(action) {
    const E = this.E;
    const prevTurn = this.state.turn;
    const prevPhase = this.state.phase;
    const prevTurnCount = this.state.turnCount;
    const prevAp = prevTurn ? this.state.players[prevTurn].ap : null;
    const legal = this.legal();
    const matched = findLegalEquivalent(action, legal);
    if (!matched) {
      throw this.fail('尝试执行不在合法集合内的行动：' + canonicalAction(action) +
        '\n合法行动：' + legal.map(canonicalAction).join(', '));
    }
    const events = E.performAction(this.state, matched);
    this.trace.push(canonicalAction(matched));
    this.steps += 1;
    if (!Array.isArray(events)) throw this.fail('performAction 未返回事件数组');
    if (!events.length || !events[0] || events[0].type !== 'action') {
      throw this.fail('performAction 首个事件应为 action，实际：' + JSON.stringify((events[0] || {}).type));
    }
    if (events[0].playerId !== prevTurn) throw this.fail('action 事件 playerId=' + events[0].playerId + '，应为 ' + prevTurn);
    if (matched.type === 'end_turn') {
      if (this.state.turnCount !== prevTurnCount) throw this.fail('end_turn 不应增加 turnCount：' + prevTurnCount + ' -> ' + this.state.turnCount);
    } else if (this.state.turnCount !== prevTurnCount + 1) {
      throw this.fail('turnCount 应 +1：' + prevTurnCount + ' -> ' + this.state.turnCount);
    }
    if (prevPhase !== 'battle' && prevPhase !== 'gameover') throw this.fail('行动前 phase 异常：' + prevPhase);
    this._assertTurnConsistency(prevTurn, prevAp, matched, events);
    if (this.opts.checkInvariants !== false) this.invariants();
    if (this.opts.onStep) {
      const r = this.opts.onStep(this.state, matched, events, this.steps);
      if (r === 'stop') this.stoppedByHook = true;
    }
    return { action: matched, events };
  }

  /** 按策略持续行动，直到 stopWhen 命中 / 终局 / 钩子停止。返回 {stopped, reason, steps}。 */
  run() {
    const opts = this.opts;
    const maxSteps = opts.maxSteps || 800;
    this.stoppedByHook = false;
    while (!this.stoppedByHook) {
      if (opts.stopWhen && opts.stopWhen(this.state)) return { stopped: true, reason: 'stopWhen', steps: this.steps };
      if (this.E.isGameOver(this.state)) return { stopped: false, reason: 'gameover', steps: this.steps };
      if (this.steps >= maxSteps) {
        throw this.fail('超过安全步数上限 ' + maxSteps + '，对局可能无法终止（疑似死循环/牌张不消耗）');
      }
      if (opts.beforeStep) opts.beforeStep(this.state, this.steps);
      const legal = this.legal();
      if (!legal.length) throw this.fail('battle 阶段没有合法行动（死锁）');
      const action = this.opts.pick
        ? this.opts.pick(this.state, legal, this.E)
        : pickAction(this.E, this.state, legal, opts);
      this.step(action);
    }
    return { stopped: true, reason: 'hook', steps: this.steps };
  }
}

function makeRunner(E, state, opts) {
  return new Runner(E, state, opts);
}

/* ------------------------------------------------------------------ */
/* 种子搜索                                                            */
/* ------------------------------------------------------------------ */

/** 在 [startSeed, startSeed+maxSeeds) 内寻找满足 predicate(state, seed) 的第一个种子。 */
function findSeed(E, predicate, opts) {
  opts = opts || {};
  const start = opts.startSeed != null ? opts.startSeed : 1;
  const maxSeeds = opts.maxSeeds != null ? opts.maxSeeds : 300;
  const overrides = opts.overrides || {};
  for (let seed = start; seed < start + maxSeeds; seed++) {
    const config = E.defaultConfig(Object.assign({ seed }, overrides));
    let state;
    try {
      state = E.createGame(config);
      if (opts.setup) opts.setup(state);
      if (predicate(state, seed)) return { seed, state, config };
    } catch (err) {
      if (opts.throwOnError) throw err;
      if (opts.collectErrors) opts.collectErrors.push({ seed, error: err });
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 断言辅助                                                            */
/* ------------------------------------------------------------------ */

// CONTRACT §2 错误码；NOT_YOUR_TURN 在 Lead 确认的实现中无使用路径（performAction 永远执行当前方）。
const ERROR_CODES = ['BAD_CONFIG', 'BAD_PHASE', 'NOT_YOUR_TURN', 'BAD_ACTION', 'BAD_REGION',
  'CARD_NOT_IN_HAND', 'NO_SUCH_CARD', 'REGION_NOT_SETTLABLE', 'DECK_INSUFFICIENT', 'ALREADY_SETTLED'];

/** 断言 fn 抛出错误，可指定错误码（字符串或数组），并校验 message 为中文非空。 */
function assertThrowsError(fn, expectedCode, label) {
  let caught = null;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, (label || '非法操作') + '：期望抛出 Error 但未抛出');
  assert.ok(caught instanceof Error, (label || '非法操作') + '：抛出的不是 Error 实例');
  if (expectedCode != null) {
    const allowed = Array.isArray(expectedCode) ? expectedCode : [expectedCode];
    assert.ok(allowed.includes(caught.code),
      (label || '非法操作') + '：错误码应为 ' + allowed.join('/') + '，实际 ' + JSON.stringify(caught.code) + '（message=' + caught.message + '）');
  } else {
    assert.ok(ERROR_CODES.includes(caught.code),
      (label || '非法操作') + '：错误码 ' + JSON.stringify(caught.code) + ' 不在 CONTRACT §2 允许列表（message=' + caught.message + '）');
  }
  assert.strictEqual(typeof caught.message, 'string', (label || '非法操作') + '：错误缺少 message 字符串');
  assert.ok(caught.message.length > 0, (label || '非法操作') + '：错误 message 为空');
  assert.ok(/[\u4e00-\u9fa5]/.test(caught.message), (label || '非法操作') + '：错误 message 应为中文，实际：' + caught.message);
  return caught;
}

function eventsOfType(events, type) {
  return (events || []).filter((e) => e && e.type === type);
}

function firstEventOfType(events, type) {
  return (events || []).find((e) => e && e.type === type) || null;
}

/** 断言事件数组的 type 序列完全等于期望序列。 */
function assertEventSequence(events, expectedTypes, label) {
  const actual = (events || []).map((e) => (e && e.type) || String(e));
  assert.deepStrictEqual(actual, expectedTypes, (label || '事件序列') + ' 不匹配\n实际：' + JSON.stringify(actual) +
    '\n期望：' + JSON.stringify(expectedTypes));
}

/* ------------------------------------------------------------------ */
/* 手工构造战斗局面（边界测试专用，白盒）                               */
/* ------------------------------------------------------------------ */

/**
 * 手工构造 battle 局面，用于无法通过自然操作轻易到达的规则边界。
 * 白盒：从 createGame 得到合法骨架后，直接改写 CONTRACT §4 中 engine 内部可写的字段。
 * 调用方需自己保证 cardIds 来自 createDeck 且全局不重复；该工具不校验牌张守恒（测试时用 skipConservation）。
 */
function synthBattle(E, spec) {
  spec = spec || {};
  const overrides = Object.assign({
    seed: spec.seed != null ? spec.seed : 1,
    regionCount: spec.regionCount || 3,
    difficulty: spec.difficulty || 2,
    firstPlayer: 'p1',
  }, spec.config || {});
  const config = E.defaultConfig(overrides);
  // 白盒构造常用小牌堆/极端配置，可能无法通过 validateConfig；
  // 这里先用标准 54 张的合法骨架 createGame，再改写 config.deck / settleCards。
  const safeRegionCount = config.regionCount;
  const safeSettleCards = [1, 2, 4].includes(config.settleCards) ? config.settleCards : 2;
  const safeConfig = E.defaultConfig(Object.assign({}, overrides, {
    regionCount: safeRegionCount,
    settleCards: safeSettleCards,
    deck: { jokers: true, ranks: E.RANKS.slice(), suits: null },
  }));
  const state = E.createGame(safeConfig);
  state.config.deck = clone(config.deck);
  state.config.settleCards = config.settleCards;
  state.config.settleMode = [1, 2, 4].includes(config.settleCards) ? config.settleCards : state.config.settleMode;
  state.config.difficulty = config.difficulty;
  state.config.regionCount = config.regionCount;
  state.config.winsNeeded = config.winsNeeded;
  state.config.initialDraw = config.initialDraw;
  state.config.layoutCount = config.layoutCount;
  state.config.compensationDraw = config.compensationDraw;
  state.config.firstPlayer = 'p1';
  state.config.secondPlayer = 'p2';
  const R = state.config.regionCount;
  const N = state.config.settleCards;
  const pool = E.createDeck(state.config.deck);
  const byId = new Map(pool.map((c) => [c.id, c]));
  const take = (id) => {
    const card = byId.get(id);
    if (!card) throw new Error('synthBattle：未知牌 id ' + JSON.stringify(id) + '（牌堆构成 ' + JSON.stringify(state.config.deck) + '）');
    return card;
  };
  const cards = (list) => (list || []).map((x) => (typeof x === 'string' ? take(x) : x));
  const markUp = (list) => { for (const c of list || []) c.revealed = true; return list; };
  const markDown = (list) => { for (const c of list || []) c.revealed = false; return list; };

  state.phase = 'battle';
  state.turn = spec.turn || 'p1';
  state.turnCount = spec.turnCount || 0;
  state.deck = markDown(cards(spec.deck));
  state.discard = cards(spec.discard);
  state.players.p1.hand = markDown(cards((spec.hands || {}).p1));
  state.players.p2.hand = markDown(cards((spec.hands || {}).p2));
  state.players.p1.regionsWon = 0;
  state.players.p2.regionsWon = 0;
  // v1.4 行动点：默认当前行动方 AP 回满、对方 0（可用 spec.aps 覆盖，用于 AP 边界场景）
  state.players.p1.ap = 0;
  state.players.p2.ap = 0;
  const synthTurn = spec.turn || 'p1';
  const synthAp = typeof spec.ap === 'number' ? spec.ap : state.config.apPerTurn;
  state.players[synthTurn].ap = synthAp;
  if (spec.aps) {
    state.players.p1.ap = spec.aps.p1 != null ? spec.aps.p1 : state.players.p1.ap;
    state.players.p2.ap = spec.aps.p2 != null ? spec.aps.p2 : state.players.p2.ap;
  }

  state.regions = [];
  for (let i = 0; i < R; i++) {
    const rs = (spec.regions && spec.regions[i]) || {};
    state.regions.push({
      id: i,
      status: rs.status || 'open',
      sides: {
        p1: { faceUp: markUp(cards(rs.p1FaceUp)), faceDown: markDown(cards(rs.p1FaceDown)) },
        p2: { faceUp: markUp(cards(rs.p2FaceUp)), faceDown: markDown(cards(rs.p2FaceDown)) },
      },
      result: rs.result ? clone(rs.result) : null,
    });
  }
  const wins = spec.regionWins || { p1: 0, p2: 0, ties: 0 };
  state.regionWins = { p1: wins.p1, p2: wins.p2, ties: wins.ties };
  state.players.p1.regionsWon = wins.p1;
  state.players.p2.regionsWon = wins.p2;
  state.endgame = {
    triggered: false,
    phase: null,
    threshold: 2 * openRegionIds(state).length,
    settleCards: N,
    drawPerPlayer: 0,
    drawnCounts: { p1: 0, p2: 0 },
    skipped: { p1: false, p2: false },
  };
  state.layout = { submitted: { p1: true, p2: true }, assignments: { p1: null, p2: null }, revealed: true };
  state.result = null;
  state.log = [];
  return state;
}

/** 确定性判断两个状态是否一致（用于同 seed 复现测试）。 */
function statesEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

module.exports = {
  ROOT,
  ENGINE_PATH,
  AI_PATH,
  loadEngine,
  loadAI,
  clone,
  sumValues,
  idsOf,
  deckSizeOf,
  openRegionIds,
  regionById,
  collectActiveCards,
  countSideCards,
  invariantErrors,
  assertInvariants,
  describeState,
  reproInfo,
  canonicalAction,
  findLegalEquivalent,
  setupBattle,
  setupLayout,
  pickAction,
  Runner,
  makeRunner,
  findSeed,
  ERROR_CODES,
  assertThrowsError,
  eventsOfType,
  firstEventOfType,
  assertEventSequence,
  synthBattle,
  statesEqual,
};
