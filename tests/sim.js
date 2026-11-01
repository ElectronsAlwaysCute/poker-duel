#!/usr/bin/env node
'use strict';
/*
 * 扑克牌 · 比大小 —— AI 自对弈大规模模拟（零依赖）
 * 运行：node tests/sim.js [--games=2000] [--seed=1] [--difficulty=all|1,2,3]
 *        [--regions=all|3,5,7] [--decks=all|standard,no-jokers,small34,...]
 *        [--max-actions=3000] [--determinism=20] [--fairness=12] [--random-seeds] [--quiet]
 *
 * 每一步校验：AI 行动合法、牌张守恒、区域和一致、回合交替、牌堆单调、决战触发条件；
 * 每局校验：必终止、终局 result 合法、终局后无合法行动、同 seed 完全复现；
 * 抽样校验：隐藏信息无关性（打乱牌堆顺序/对手手牌顺序/背面牌顺序后 AI 决策不变）。
 * 输出各配置/难度/区域数统计；有异常时打印最小复现并返回非零退出码。
 */

const h = require('./helpers');
const E = h.loadEngine();
const AI = h.loadAI();

/* ------------------------------------------------------------------ */
/* 参数                                                                */
/* ------------------------------------------------------------------ */

function intArg(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : dflt;
}

function parseArgs(argv) {
  const args = {
    games: 2000, seed: 1, difficulty: null, regions: null, decks: null, settleCards: null,
    maxActions: 3000, determinism: 20, fairness: 12, quiet: false, randomSeeds: false,
  };
  for (const raw of argv.slice(2)) {
    if (raw === '--help' || raw === '-h') { printUsage(); process.exit(0); }
    const m = /^--([^=]+)(?:=(.*))?$/.exec(raw);
    if (!m) { console.error('[sim] 未知参数：' + raw); printUsage(); process.exit(2); }
    const k = m[1];
    const v = m[2];
    switch (k) {
      case 'games': args.games = intArg(v, 2000); break;
      case 'seed': args.seed = intArg(v, 1); break;
      case 'max-actions': args.maxActions = intArg(v, 3000); break;
      case 'determinism': args.determinism = intArg(v, 20); break;
      case 'fairness': args.fairness = intArg(v, 12); break;
      case 'difficulty': args.difficulty = v === 'all' ? null : v.split(',').map(Number); break;
      case 'regions': args.regions = v === 'all' ? null : v.split(',').map(Number); break;
      case 'decks': args.decks = v === 'all' ? null : v.split(','); break;
      case 'settle-cards': args.settleCards = v === 'all' ? null : v.split(',').map(Number); break;
      case 'random-seeds': args.randomSeeds = true; break;
      case 'quiet': args.quiet = true; break;
      default: console.error('[sim] 未知参数：--' + k); printUsage(); process.exit(2);
    }
  }
  return args;
}

function printUsage() {
  console.log([
    '用法：node tests/sim.js [选项]',
    '  --games=N         总局数（默认 2000，在配置矩阵上轮转分配）',
    '  --seed=N          基础种子（默认 1；第 i 局 seed = seed+i）',
    '  --difficulty=all|1,2,3   难度筛选',
    '  --regions=all|3,5,7      区域数筛选',
    '  --decks=all|standard,no-jokers,small34,small38,thin41,custom46,custom44  牌堆筛选',
    '  --settle-cards=all|1,2,4 结算随机性（N=双方各补几张）筛选',
    '  --max-actions=N   单局安全行动上限（默认 3000，v1.4 多行动需更大上限）',
    '  --determinism=N   同 seed 复现校验局数（默认 20）',
    '  --fairness=N      隐藏信息无关性抽查次数（默认 12）',
    '  --random-seeds    使用随机种子（默认确定性种子）',
    '  --quiet           只输出汇总',
  ].join('\n'));
}

/* ------------------------------------------------------------------ */
/* 牌堆预设                                                            */
/* ------------------------------------------------------------------ */

const DECK_PRESETS = {
  standard: { label: '标准54', deck: { jokers: true } },
  'no-jokers': { label: '无王52', deck: { jokers: false } },
  small34: { label: '小34', deck: { jokers: true, ranks: ['A', '2', '3', '4', '5', '6', '7', '8'] } },
  small38: { label: '小38', deck: { jokers: true, ranks: ['A', '2', '3', '4', '5', '6', '7', '8', '9'] } },
  thin41: { label: '薄41', deck: { jokers: true, suits: ['s', 'h', 'd'] } },
  custom46: { label: '自定义46', deck: { jokers: true, ranks: ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J'] } },
  custom44: { label: '自定义44', deck: { jokers: false, ranks: ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J'] } },
};

function buildConfigs(args) {
  const regions = args.regions || [3, 5, 7];
  const difficulties = args.difficulty || [1, 2, 3];
  const deckKeys = args.decks || Object.keys(DECK_PRESETS);
  const settleCandidates = args.settleCards || [1, 2, 4];
  const configs = [];
  const skipped = [];
  for (const regionCount of regions) {
    for (const settleCards of settleCandidates) {
      for (const difficulty of difficulties) {
        for (const deckKey of deckKeys) {
          const preset = DECK_PRESETS[deckKey];
          if (!preset) throw new Error('未知牌堆预设：' + deckKey + '（可选：' + Object.keys(DECK_PRESETS).join(',') + '）');
          const overrides = { regionCount, difficulty, settleCards, deck: preset.deck };
          const v = E.validateConfig(E.defaultConfig(overrides));
          if (!v.ok) {
            skipped.push({ regionCount, difficulty, settleCards, deckKey, reason: v.errors.join('；') });
            continue;
          }
          configs.push({
            key: 'R' + regionCount + '-N' + settleCards + '-D' + difficulty + '-' + deckKey,
            regionCount, settleCards, difficulty, deckKey, deckLabel: preset.label,
            deck: preset.deck, deckSize: v.info.deckSize, gap: v.info.gapToEndgame,
          });
        }
      }
    }
  }
  return { configs, skipped };
}

/* ------------------------------------------------------------------ */
/* 统计容器                                                            */
/* ------------------------------------------------------------------ */

function emptyStats() {
  return {
    games: 0, p1: 0, p2: 0, draw: 0, firstPlayerWins: 0, firstP1: 0,
    endgame: 0, individual: 0, early: 0, totalTurns: 0, maxTurns: 0, totalActions: 0,
    actionCounts: { settle: 0, flip: 0, place: 0, move: 0, draw: 0, end_turn: 0 },
    regionWins: 0, regionTies: 0, deckLeftIndividual: 0,
    difficultyDraws: { p1: 0, p2: 0, null: 0 },
  };
}

function mergeStats(target, src) {
  for (const k of ['games', 'p1', 'p2', 'draw', 'firstPlayerWins', 'firstP1', 'endgame', 'individual', 'early',
    'totalTurns', 'totalActions', 'regionWins', 'regionTies', 'deckLeftIndividual']) {
    target[k] += src[k] || 0;
  }
  target.maxTurns = Math.max(target.maxTurns, src.maxTurns || 0);
  for (const t of Object.keys(target.actionCounts)) target.actionCounts[t] += src.actionCounts[t] || 0;
  for (const k of ['p1', 'p2', 'null']) target.difficultyDraws[k] += src.difficultyDraws[k] || 0;
}

/* ------------------------------------------------------------------ */
/* 单局模拟                                                            */
/* ------------------------------------------------------------------ */

function otherPid(pid) { return pid === 'p1' ? 'p2' : 'p1'; }

/** 抽样校验：隐藏信息打乱后 AI 决策必须一致。返回 null 表示通过，否则返回异常描述。 */
function fairnessCheck(state, pid) {
  const variant = h.clone(state);
  const opp = otherPid(pid);
  // 只打乱「隐藏信息」：牌堆顺序、对手手牌顺序、对手背面牌顺序、弃牌堆顺序。
  // 不得改动我方手牌/我方背面牌顺序（它们会影响合法行动枚举顺序，属可见信息，改动会造成假阳性）。
  variant.deck.reverse();
  variant.players[opp].hand.reverse();
  for (const r of variant.regions) {
    r.sides[opp].faceDown.reverse();
  }
  variant.discard.reverse();
  const a = AI.chooseAction(state, pid);
  const b = AI.chooseAction(variant, pid);
  const ka = h.canonicalAction(a);
  const kb = h.canonicalAction(b);
  if (ka !== kb) {
    return 'AI 决策依赖隐藏信息：原=' + ka + ' 打乱后=' + kb;
  }
  return null;
}

/**
 * 玩一局 AI 自对弈。
 * ctx: { maxActions, fairnessBudget:{left}, checkMutation }
 */
function playGame(seed, cfg, ctx) {
  const anomalies = [];
  const config = E.defaultConfig({
    seed,
    regionCount: cfg.regionCount,
    difficulty: cfg.difficulty,
    settleCards: cfg.settleCards,
    firstPlayer: 'random',
    deck: cfg.deck,
  });
  const state = E.createGame(config);
  const trace = [];
  const stats = emptyStats();
  const addAnomaly = (msg) => anomalies.push({ seed, config: cfg.key, msg, trace: trace.slice(), state: h.describeState(state) });
  const mark = (msg) => { addAnomaly(msg); throw new Error(msg); };

  try {
    // ---- 布局（AI） ----
    const p1Layout = AI.chooseLayout(state, 'p1');
    const p2Layout = AI.chooseLayout(state, 'p2');
    for (const [pid, ids] of [['p1', p1Layout], ['p2', p2Layout]]) {
      if (!Array.isArray(ids) || ids.length !== state.config.regionCount || new Set(ids).size !== ids.length) {
        mark('AI 布局非法：' + pid + ' ' + JSON.stringify(ids));
      }
      const hand = new Set(state.players[pid].hand.map((c) => c.id));
      for (const id of ids) if (!hand.has(id)) mark('AI 布局牌不在手牌：' + pid + ' ' + id);
    }
    E.submitLayout(state, 'p1', p1Layout);
    E.submitLayout(state, 'p2', p2Layout);
    E.finalizeLayout(state);

    // ---- 战役 ----
    while (!E.isGameOver(state)) {
      if (trace.length >= ctx.maxActions) mark('超过安全行动上限 ' + ctx.maxActions + '，对局未终止（疑似死循环）');
      const pid = state.turn;
      if (pid !== 'p1' && pid !== 'p2') mark('战役阶段 turn 非法：' + pid);
      const openIds = h.openRegionIds(state);
      const inEndgameBuild = !!(state.endgame && state.endgame.triggered && state.endgame.phase === 'build');
      if (!openIds.length) mark('battle 阶段但无未结算区域');
      if (!inEndgameBuild && state.deck.length <= 2 * openIds.length) {
        mark('battle 阶段牌堆(' + state.deck.length + ') ≤ 阈值(' + 2 * openIds.length + ')，应在上一行动后触发决战');
      }
      const legal = E.getLegalActions(state);
      if (!legal.length) mark('battle 阶段无合法行动（死锁）');
      if (inEndgameBuild) {
        const banned = legal.filter((a) => a.type === 'draw' || a.type === 'settle');
        if (banned.length) mark('决战 build 阶段 getLegalActions 含禁用行动：' + banned.map((a) => a.type).join(','));
      }

      // AI 不修改 state
      if (ctx.checkMutation) {
        const before = JSON.stringify(state);
        AI.chooseAction(state, pid);
        if (JSON.stringify(state) !== before) mark('AI chooseAction 修改了 state');
      }
      // 隐藏信息无关性抽查
      if (ctx.fairnessBudget.left > 0) {
        ctx.fairnessBudget.left--;
        const bad = fairnessCheck(h.clone(state), pid);
        if (bad) mark(bad);
      }

      const action = AI.chooseAction(state, pid);
      if (!action) mark('AI 返回 null 行动');
      if (inEndgameBuild && !['flip', 'place', 'move', 'end_turn'].includes(action.type)) {
        mark('决战 build 阶段 AI 应只选 flip/place/move/end_turn，实际 ' + action.type);
      }
      // v1.5 AI 2.2：默认 medium/hard 允许用 move 弃区/集中背面牌；不再断言「AI 不用 move」，
      // 由上面的行动合法性 + 对局终止性（maxActions）保证不会出现无进展循环。
      const matched = h.findLegalEquivalent(action, legal);
      if (!matched) mark('AI 行动非法：' + h.canonicalAction(action) + '（合法集合 ' + legal.length + ' 条，如 ' +
        legal.slice(0, 6).map(h.canonicalAction).join(', ') + '…）');

      const prevTurn = state.turn;
      const prevAp = state.turn ? state.players[state.turn].ap : null;
      const prevTurnCount = state.turnCount;
      const prevDeck = state.deck.length;
            const events = E.performAction(state, matched);
      trace.push(h.canonicalAction(matched));
      stats.totalActions++;
      stats.actionCounts[matched.type] = (stats.actionCounts[matched.type] || 0) + 1;

      if (!Array.isArray(events) || !events[0] || events[0].type !== 'action') mark('performAction 事件格式错误');
      // v1.4：turnCount 只统计真实行动（end_turn 不计）
      const expectTurnCount = matched.type === 'end_turn' ? prevTurnCount : prevTurnCount + 1;
      if (state.turnCount !== expectTurnCount) mark('turnCount 错误：' + prevTurnCount + ' -> ' + state.turnCount + '（行动 ' + matched.type + '）');
      const nonDraw = matched.type !== 'draw';
      if (nonDraw && matched.type !== 'settle' && state.deck.length !== prevDeck) {
        // 决战触发行动可能在同一事件里把牌堆摸空（endgame_start/endgame_draw），属正常
        if (!events.some((e) => e.type === 'endgame_start')) mark(matched.type + ' 不应改变牌堆');
      }
      if (state.deck.length > prevDeck) mark('牌堆张数增加：' + prevDeck + ' -> ' + state.deck.length);

      // 单独结算：验证 drawn 数组 / settleCards / 难度摸牌对象（RULES §5/§7）
      for (const ev of events) {
        if (ev.type !== 'settle') continue;
        const N = state.config.settleCards;
        if (ev.settleCards !== N) mark('settle 事件 settleCards=' + ev.settleCards + '，应为 ' + N);
        if (!ev.drawn || !Array.isArray(ev.drawn.p1) || !Array.isArray(ev.drawn.p2)) mark('settle 事件 drawn 必须为数组');
        else if (ev.drawn.p1.length !== N || ev.drawn.p2.length !== N) mark('settle 事件 drawn 数组长度≠N=' + N);
        if (ev.regionResult && ev.regionResult.drawn && (ev.regionResult.drawn.p1.length !== N || ev.regionResult.drawn.p2.length !== N)) {
          mark('regionResult.drawn 数组长度≠N');
        }
        const rule = E.DIFFICULTIES[state.config.difficulty].rule;
        let expected = null;
        if (ev.winner !== 'tie') {
          if (rule === 'loser-draw') expected = otherPid(ev.winner);
          else if (rule === 'winner-draw') expected = ev.winner;
        }
        const actual = ev.difficultyDraw ? ev.difficultyDraw.playerId : null;
        // RULES §7：牌堆为空时不摸牌（正常对局不会发生；高消耗 N=4/小牌堆时可能）
        const emptyDeck = expected !== null && actual === null && ev.deckAfter === 0;
        if (actual !== expected && !emptyDeck) {
          mark('难度规则错误（难度' + state.config.difficulty + '，胜者 ' + ev.winner + '）：难度摸牌对象应为 ' +
            expected + '，实际 ' + actual);
        }
        stats.difficultyDraws[actual == null ? 'null' : actual]++;
        if (ev.regionResult && ev.regionResult.difficultyDraw !== ev.difficultyDraw) {
          mark('settle 事件 difficultyDraw 与 regionResult 不一致');
        }
      }

      // ---- 决战事件校验（v1.3：补牌摸空 → build → showdown 确定性结算） ----
      const endgameStart = events.find((e) => e.type === 'endgame_start');
      if (endgameStart) {
        stats.endgameTriggers = (stats.endgameTriggers || 0) + 1;
        const X = endgameStart.openRegionIds.length;
        const N = state.config.settleCards;
        if (endgameStart.settleCards !== N) mark('endgame_start.settleCards 与配置不一致');
        if (endgameStart.drawPerPlayer !== X) mark('endgame_start.drawPerPlayer 应=X=' + X);
        if (endgameStart.threshold !== 2 * X) mark('endgame_start.threshold 应=2X=' + (2 * X));
        if (endgameStart.deckCount > 2 * X) mark('决战触发时牌堆(' + endgameStart.deckCount + ')应≤2X=' + (2 * X));
        if (JSON.stringify(endgameStart.drawnCounts.p1 + endgameStart.drawnCounts.p2) !== JSON.stringify(0) &&
          endgameStart.drawnCounts.p1 + endgameStart.drawnCounts.p2 !== endgameStart.deckCount) {
          mark('endgame_start.drawnCounts 合计应=触发时牌堆=' + endgameStart.deckCount);
        }
        const sortedIds = endgameStart.openRegionIds.slice().sort((a, b) => a - b);
        if (JSON.stringify(sortedIds) !== JSON.stringify(endgameStart.openRegionIds)) mark('决战区域未升序');
        const draws = events.filter((e) => e.type === 'endgame_draw');
        if (draws.length !== 2) mark('应有 2 个 endgame_draw 事件，实际 ' + draws.length);
        else {
          if (draws[0].playerId !== 'p1' || draws[1].playerId !== 'p2') mark('endgame_draw 顺序应为 p1→p2');
          if (draws[0].count !== endgameStart.drawnCounts.p1 || draws[1].count !== endgameStart.drawnCounts.p2) {
            mark('endgame_draw.count 与 drawnCounts 不一致');
          }
        }
        if (state.deck.length !== 0) mark('决战补牌后牌堆应为 0，实际 ' + state.deck.length);
      }

      // build 阶段：跳过事件与确定性摊牌
      const skips = events.filter((e) => e.type === 'endgame_skip');
      for (const sk of skips) {
        stats.endgameSkips = (stats.endgameSkips || 0) + 1;
        if (!state.endgame || !state.endgame.skipped[sk.playerId]) mark('endgame_skip 后 skipped 标记未置真');
      }
      const showdown = events.find((e) => e.type === 'endgame_showdown');
      if (showdown) {
        stats.showdowns = (stats.showdowns || 0) + 1;
        const settles = events.filter((e) => e.type === 'endgame_settle');
        if (showdown.threshold !== 2 * showdown.openRegionIds.length) mark('endgame_showdown.threshold 应=2X');
        if (showdown.deckCount !== 0) mark('endgame_showdown.deckCount 应为 0');
        if (settles.length > showdown.openRegionIds.length) mark('摊牌结算区域数量超出未结算区域数');
        const settleIds = settles.map((e) => e.regionId);
        const expectIds = showdown.openRegionIds.slice(0, settles.length);
        if (JSON.stringify(settleIds) !== JSON.stringify(expectIds)) {
          mark('摊牌结算顺序应从未结算区域升序开始，实际 ' + JSON.stringify(settleIds));
        }
        for (const ev of settles) {
          if (ev.deterministic !== true) mark('摊牌结算事件应 deterministic=true');
          if (ev.drawnCount !== 0) mark('摊牌 drawnCount 应为 0');
          if (!ev.drawn || ev.drawn.p1.length !== 0 || ev.drawn.p2.length !== 0) mark('摊牌 drawn 应为空数组');
          if (ev.deckAfter !== 0) mark('摊牌 deckAfter 应为 0');
          if (ev.regionResult && ev.regionResult.difficultyDraw) mark('摊牌不应执行难度规则');
          const expSums = {
            p1: h.sumValues(ev.regionBefore.sides.p1.faceUp),
            p2: h.sumValues(ev.regionBefore.sides.p2.faceUp),
          };
          if (ev.sums.p1 !== expSums.p1 || ev.sums.p2 !== expSums.p2) mark('摊牌 sums 应只含现有正面牌点数');
          const expWinner = expSums.p1 > expSums.p2 ? 'p1' : (expSums.p2 > expSums.p1 ? 'p2' : 'tie');
          if (ev.winner !== expWinner) mark('摊牌区域胜者与正面点数和不符');
        }
      }

      // 轻量不变量
      const errs = h.invariantErrors(E, state, {});
      if (errs.length) mark('不变量失败：' + errs.join('；'));

      // 回合 / 行动点（v1.4）：同一回合可连续行动；换人必有 turn_start 且 AP 回满
      if (state.phase === 'battle') {
        const hasTurnEnd = events.some((e) => e.type === 'turn_end');
        const hasTurnStart = events.some((e) => e.type === 'turn_start');
        const endgameTriggeredNow = events.some((e) => e.type === 'endgame_start');
        if (state.turn === prevTurn) {
          if (hasTurnEnd || hasTurnStart) {
            if (!hasTurnEnd || !hasTurnStart) {
              // v2.1：endgame_start 会重新 beginTurn（先手按规则重开），原行动方不产生 turn_end 属合法阶段切换
              if (endgameTriggeredNow) {
                if (!hasTurnStart) mark('决战开始后同一玩家新回合缺少 turn_start');
              } else {
                mark('同一玩家开新回合应同时有 turn_end/turn_start');
              }
            }
            if (state.players[prevTurn].ap !== E.AP_PER_TURN) mark('新回合 AP 应回满 3，实际 ' + state.players[prevTurn].ap);
          } else if (matched.type !== 'end_turn') {
            const cost = E.ACTION_COSTS[matched.type];
            if (state.players[prevTurn].ap !== prevAp - cost) {
              mark('同回合 AP 扣减错误：' + prevAp + ' - ' + cost + ' => 实际 ' + state.players[prevTurn].ap);
            }
          }
        } else {
          if (!hasTurnStart) mark('换人但缺少 turn_start 事件');
          if (!hasTurnEnd && !endgameTriggeredNow) mark('换人但缺少 turn_end 事件');
          if (state.players[state.turn].ap !== E.AP_PER_TURN) mark('新行动方 AP 应回满 3，实际 ' + state.players[state.turn].ap);
        }
      }
    }

    // ---- 终局校验 ----
    if (state.phase !== 'gameover') mark('对局结束但 phase=' + state.phase);
    if (state.turn !== null) mark('终局 turn 应为 null，实际 ' + state.turn);
    if (!state.result) mark('终局缺少 result');
    const openAtEnd = h.openRegionIds(state);
    const early = !!(state.result && state.result.early);
    if (early) {
      if (!state.result.unsettledRegions || !state.result.unsettledRegions.length) mark('提前锁定缺少 unsettledRegions');
      const unsettled = (state.result.unsettledRegions || []).slice().sort((a, b) => a - b);
      const openSorted = openAtEnd.slice().sort((a, b) => a - b);
      if (JSON.stringify(unsettled) !== JSON.stringify(openSorted)) mark('unsettledRegions 与 open 区域不一致');
      if (state.result.reason !== 'region_wins') mark('提前锁定 reason 应为 region_wins');
    } else if (openAtEnd.length) {
      mark('非提前锁定但终局仍有未结算区域');
    }
    if (E.getLegalActions(state).length) mark('终局后仍有合法行动');
    if (state.result && state.result.early) stats.early = 1;
    if (state.endgame.triggered) {
      // v1.3：决战触发时补牌把牌堆摸空，之后不再使用牌堆（摊牌不补牌）
      if (state.deck.length !== 0) mark('触发决战但终局牌堆未摸空：' + state.deck.length);
      if (!['done', 'showdown'].includes(state.endgame.phase)) mark('决战终局 endgame.phase 非法：' + state.endgame.phase);
      if (!early && state.endgame.phase !== 'done') mark('非提前锁定决战终局 endgame.phase 应为 done');
      const dc = state.endgame.drawnCounts;
      if (!dc || dc.p1 + dc.p2 > 2 * state.endgame.drawPerPlayer) mark('决战 drawnCounts 超过 2X');
      stats.endgame = 1;
    } else {
      stats.individual = 1;
      stats.deckLeftIndividual = state.deck.length;
    }
    const finalErrs = h.invariantErrors(E, state, {});
    if (finalErrs.length) mark('终局不变量失败：' + finalErrs.join('；'));

    // ---- 统计 ----
    stats.games = 1;
    stats[state.result.winner]++;
    stats.firstPlayerWins = state.result.winner === state.config.firstPlayer ? 1 : 0;
    stats.firstP1 = state.config.firstPlayer === 'p1' ? 1 : 0;
    stats.totalTurns = state.turnCount;
    stats.maxTurns = state.turnCount;
    stats.regionWins = state.regionWins.p1 + state.regionWins.p2;
    stats.regionTies = state.regionWins.ties;
  } catch (err) {
    if (!anomalies.length) addAnomaly('异常：' + err.message);
    if (!('fatal' in err)) err.fatal = true;
    for (const a of anomalies) a.trace = trace.slice();
    return { state, trace, stats: null, anomalies };
  }
  return { state, trace, stats, anomalies };
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

function pct(n, d) { return d ? ((100 * n) / d).toFixed(1) + '%' : '-'; }

function main() {
  const args = parseArgs(process.argv);
  const t0 = Date.now();
  const { configs, skipped } = buildConfigs(args);
  if (!configs.length) {
    console.error('[sim] 没有可运行的配置（全部牌堆不足以支撑所选区域数）。skipped=' + JSON.stringify(skipped));
    process.exit(2);
  }
  const totalGames = Math.max(1, args.games);
  console.log('[sim] 配置：' + configs.length + ' 组（已跳过非法组合 ' + skipped.length + ' 个）· 共 ' + totalGames + ' 局' +
    ' · 基础 seed=' + args.seed + (args.randomSeeds ? '（随机种子）' : ''));
  if (skipped.length && !args.quiet) {
    console.log('[sim] 跳过非法组合（牌堆不足以支撑该区域数/结算随机性）：' +
      skipped.map((s) => s.deckKey + '@R' + s.regionCount + '/N' + s.settleCards).join(', '));
  }

  const ctx = {
    maxActions: args.maxActions,
    checkMutation: true,
    fairnessBudget: { left: args.fairness },
  };
  const perConfig = new Map();
  const anomalies = [];
  const mismatch = [];
  let determinismChecked = 0;
  let determinismFailed = 0;

  const progressEvery = Math.max(1, Math.floor(totalGames / 10));
  for (let i = 0; i < totalGames; i++) {
    const cfg = configs[i % configs.length];
    const seed = args.randomSeeds
      ? Math.floor(Math.random() * 0x7FFFFFFF) + 1
      : args.seed + i;
    const r = playGame(seed, cfg, ctx);
    if (r.anomalies.length) {
      for (const a of r.anomalies) anomalies.push(a);
    } else {
      let st = perConfig.get(cfg.key);
      if (!st) { st = emptyStats(); st.cfg = cfg; perConfig.set(cfg.key, st); }
      mergeStats(st, r.stats);
      // 同 seed 完全复现校验
      if (determinismChecked < args.determinism) {
        determinismChecked++;
        const r2 = playGame(seed, cfg, { maxActions: args.maxActions, checkMutation: false, fairnessBudget: { left: 0 } });
        if (r2.anomalies.length || JSON.stringify(r2.trace) !== JSON.stringify(r.trace) ||
          JSON.stringify(r2.state) !== JSON.stringify(r.state)) {
          determinismFailed++;
          mismatch.push({ seed, config: cfg.key, trace1: r.trace, trace2: r2.trace });
        }
      }
    }
    if (!args.quiet && ((i + 1) % progressEvery === 0 || i + 1 === totalGames)) {
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      process.stdout.write('\r[sim] 进度 ' + (i + 1) + '/' + totalGames + ' 局 · 异常 ' + anomalies.length +
        ' · 复现失败 ' + determinismFailed + ' · ' + secs + 's   ');
    }
  }
  if (!args.quiet) process.stdout.write('\n');

  /* ---------------- 输出统计 ---------------- */
  const global = emptyStats();
  for (const st of perConfig.values()) mergeStats(global, st);

  const rows = [...perConfig.values()].sort((a, b) => {
    const ka = [a.cfg.regionCount, a.cfg.settleCards, a.cfg.difficulty, a.cfg.deckKey].join('-');
    const kb = [b.cfg.regionCount, b.cfg.settleCards, b.cfg.difficulty, b.cfg.deckKey].join('-');
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  if (!args.quiet) {
    console.log('\n=== 分配置统计 ===');
    console.log('区域 N 难度 牌堆      局数  P1胜  P2胜  平  先手胜  决战率  提前锁定率  均行动  均区域胜/平  settle/flip/place/move/draw/end_turn');
    for (const st of rows) {
      const c = st.cfg;
      const g = st.games;
      console.log([
        String(c.regionCount).padEnd(4),
        ('N' + c.settleCards).padEnd(2),
        ('D' + c.difficulty).padEnd(4),
        (c.deckLabel + '(' + c.deckSize + ')').padEnd(14),
        String(g).padStart(4),
        pct(st.p1, g).padStart(6),
        pct(st.p2, g).padStart(6),
        pct(st.draw, g).padStart(5),
        pct(st.firstPlayerWins, g).padStart(6),
        pct(st.endgame, g).padStart(6),
        pct(st.early, g).padStart(10),
        (st.totalActions / g).toFixed(1).padStart(7),
        ((st.regionWins / g).toFixed(1) + '/' + (st.regionTies / g).toFixed(1)).padStart(13),
        [st.actionCounts.settle, st.actionCounts.flip, st.actionCounts.place, st.actionCounts.move, st.actionCounts.draw, st.actionCounts.end_turn]
          .map((n) => pct(n, st.totalActions)).join('/'),
      ].join(' '));
    }
  }

  const byKey = (field) => {
    const m = new Map();
    for (const st of perConfig.values()) {
      const k = field === 'difficulty' ? 'D' + st.cfg.difficulty
        : field === 'regionCount' ? 'R' + st.cfg.regionCount
          : field === 'settleCards' ? 'N' + st.cfg.settleCards
            : st.cfg.deckLabel + '(' + st.cfg.deckSize + ')';
      if (!m.has(k)) m.set(k, emptyStats());
      mergeStats(m.get(k), st);
    }
    return m;
  };
  if (!args.quiet) {
    for (const [title, field] of [['按难度', 'difficulty'], ['按区域数', 'regionCount'], ['按结算随机性', 'settleCards'], ['按牌堆', 'deckKey']]) {
      console.log('\n=== ' + title + ' ===');
      for (const [k, st] of byKey(field)) {
        const g = st.games;
        console.log('  ' + k.padEnd(16) + ' 局数 ' + String(g).padStart(5) +
          ' | P1胜 ' + pct(st.p1, g) + ' P2胜 ' + pct(st.p2, g) + ' 平 ' + pct(st.draw, g) +
          ' | 先手胜 ' + pct(st.firstPlayerWins, g) +
          ' | 决战率 ' + pct(st.endgame, g) +
          ' | 提前锁定 ' + pct(st.early, g) +
          ' | 均行动 ' + (st.totalActions / g).toFixed(1) +
          ' | 均回合 ' + (st.totalTurns / g).toFixed(1));
      }
    }
  }

  const g = global;
  console.log('\n=== 汇总 ===');
  console.log('  总对局        : ' + g.games);
  console.log('  P1 胜 / P2 胜 / 平 : ' + g.p1 + ' / ' + g.p2 + ' / ' + g.draw +
    '  (' + pct(g.p1, g.games) + ' / ' + pct(g.p2, g.games) + ' / ' + pct(g.draw, g.games) + ')');
  console.log('  先手胜率      : ' + pct(g.firstPlayerWins, g.games) + '（先手为 P1 的比例 ' + pct(g.firstP1, g.games) + '）');
  console.log('  决战 / 全单独 : ' + pct(g.endgame, g.games) + ' / ' + pct(g.individual, g.games) +
    '（其中提前锁定 ' + pct(g.early, g.games) + '）');
  console.log('  平均行动 / 回合: ' + (g.totalActions / g.games).toFixed(1) + ' / ' + (g.totalTurns / g.games).toFixed(1) +
    '（最大回合 ' + g.maxTurns + '）');
  console.log('  平均区域胜/平 : ' + (g.regionWins / g.games).toFixed(2) + ' / ' + (g.regionTies / g.games).toFixed(2));
  console.log('  行动占比      : settle ' + pct(g.actionCounts.settle, g.totalActions) +
    ' / flip ' + pct(g.actionCounts.flip, g.totalActions) +
    ' / place ' + pct(g.actionCounts.place, g.totalActions) +
    ' / move ' + pct(g.actionCounts.move, g.totalActions) +
    ' / draw ' + pct(g.actionCounts.draw, g.totalActions) +
    ' / end_turn ' + pct(g.actionCounts.end_turn, g.totalActions));
  console.log('  难度摸牌对象  : p1 ' + g.difficultyDraws.p1 + ' / p2 ' + g.difficultyDraws.p2 + ' / 无 ' + g.difficultyDraws.null);
  console.log('  同 seed 复现  : ' + (determinismChecked - determinismFailed) + '/' + determinismChecked + ' 通过');
  console.log('  隐藏信息抽查  : ' + Math.min(args.fairness, totalGames) + ' 次（预算 ' + args.fairness + '，通过则无异常）');
  console.log('  耗时          : ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');

  if (anomalies.length) {
    console.log('\n=== 异常（' + anomalies.length + '）===');
    for (const a of anomalies.slice(0, 20)) {
      console.log('  ✖ seed=' + a.seed + ' config=' + a.config + '\n    ' + a.msg +
        '\n    复现 trace=' + JSON.stringify(a.trace) + '\n    ' + a.state);
    }
    if (anomalies.length > 20) console.log('  … 其余 ' + (anomalies.length - 20) + ' 条省略');
  }
  if (mismatch.length) {
    console.log('\n=== 同 seed 复现失败（' + mismatch.length + '）===');
    for (const m of mismatch.slice(0, 5)) {
      console.log('  seed=' + m.seed + ' config=' + m.config + '\n    trace1=' + JSON.stringify(m.trace1) + '\n    trace2=' + JSON.stringify(m.trace2));
    }
  }

  const failed = anomalies.length + determinismFailed;
  if (failed) {
    console.log('\n[sim] 结果：失败（异常 ' + anomalies.length + '，复现失败 ' + determinismFailed + '）');
    process.exit(1);
  }
  console.log('\n[sim] 结果：全部通过 ✔');
}

main();
