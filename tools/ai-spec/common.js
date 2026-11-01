#!/usr/bin/env node
/* =========================================================================
 * tools/ai-spec/common.js — v2.4 特化 AI 公共骨架（基于 medium 3.3.0）
 *
 * 设计（可审计、信息公平、确定性）：
 *  1) 先取 medium 3.3.0 的决策 base（保证基础强度）；
 *  2) 以确定性 hash（seed|turnCount|pid|NAME）控制的 overrideProb 概率，
 *     尝试改用「特化偏好行动类型」中的最佳候选；
 *  3) 质量门：偏好的候选必须落在「当前所有合法行动的最佳 medium 估值」的 qualityTol 内，
 *     否则放弃覆盖、回退 medium（把强度损失限制在可接受范围，同时保留行为签名）；
 *     估值口径与 medium 同源：AI._internals.hardActionValue（medium 参数）。
 *  4) 结算行动用 war 概率表（Φ 表值 + 无放回修正 + 平局概率，AI 3.3.0）做门槛：
 *       rush  : safe 门槛 minWin=0.5（更积极结算）
 *       turtle: lock-or-safe（锁定 或 胜率≥0.55 才结算）
 *       lockhunter: lock+（直接锁定/一方接近锁定时才积极结算）
 *  5) move 仅在投影提升时进入候选（mover）；默认不允许在无推进行动的回合先移牌，
 *     避免 stall/认输；mover 可配置 allowMoveBeforeProductive。
 *  6) 决战 build 阶段保持 medium 行为（特化签名集中在战役期），不做自定义。
 *
 * 接口（每个特化模块导出）：VERSION / NAME / chooseLayout / chooseAction
 * ========================================================================= */
'use strict';
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const E = require(path.join(ROOT, 'js', 'engine.js'));
const AI = require(path.join(ROOT, 'js', 'ai.js'));
const I = AI._internals;
const VERSION = '2.4.0';

function faceUpSum(state, pid, regionId) {
  let s = 0;
  for (const c of state.regions[regionId].sides[pid].faceUp) s += c.value;
  return s;
}
function warSettleInfo(state, pid, regionId) {
  const N = state.config.settleCards || 2;
  const L = state.deck.length;
  const opp = pid === 'p1' ? 'p2' : 'p1';
  const d = faceUpSum(state, pid, regionId) - faceUpSum(state, opp, regionId);
  try { return I.warSettleProbs(d, N, L); } catch (e) { return { win: 0.5, tie: 0, lose: 0.5 }; }
}

/* 构造与 medium 同口径的估值上下文（makeEvaluator exact + buildBoard + hardActionValue） */
function makeCtx(state, pid) {
  const N = state.config.settleCards || 2;
  const need = state.config.winsNeeded;
  const rule = (E.DIFFICULTIES[state.config.difficulty] || {}).rule || 'none';
  const deckLen = state.deck.length;
  const unseen = E.getUnseenCards(state, pid);
  const vals = unseen.map((c) => c.value);
  const rng = I.deriveRng(state, pid, (state.turnCount || 0) + 1);
  const evaluator = I.makeEvaluator(vals, N, 'medium', rng, true);
  const board = I.buildBoard(state, pid, evaluator);
  const P = I.TRAINED.medium;
  return {
    N, need, rule, deckLen, evaluator, board,
    score: function (a) {
      try { return I.hardActionValue(state, pid, a, board, evaluator, need, rule, deckLen, N, evaluator.mean, P, null); } catch (e) { return -1; }
    }
  };
}

function pickPreferred(state, pid, legal, cfg, ctx) {
  const opp = pid === 'p1' ? 'p2' : 'p1';
  const need = state.config.winsNeeded;
  const myWins = state.regionWins[pid];
  const oppWins = state.regionWins[opp];
  for (const type of cfg.prefer) {
    const acts = legal.filter((a) => a.type === type);
    if (!acts.length) continue;
    const gated = [];
    for (const a of acts) {
      if (type === 'settle') {
        const w = warSettleInfo(state, pid, a.regionId);
        const lockNow = (myWins + 1 >= need || oppWins + 1 >= need);
        const minWin = cfg.settleMinWin != null ? cfg.settleMinWin : 0.6;
        if (cfg.settleGate === 'safe' && !lockNow && w.win < minWin) continue;
        if (cfg.settleGate === 'lock' && !lockNow) continue;
        if (cfg.settleGate === 'lock-or-safe' && !lockNow && w.win < minWin) continue;
        if (cfg.settleGate === 'lock+') {
          const nearMy = myWins >= need - 1;
          const nearOpp = oppWins >= need - 1;
          if (!lockNow && !(nearMy && w.win >= 0.55) && !(nearOpp && w.win >= 0.65)) continue;
        }
        gated.push({ a, w });
      } else if (type === 'move') {
        if (cfg.movesRequireGain) {
          try {
            const unseen = E.getUnseenCards(state, pid);
            const mean = unseen.length ? unseen.reduce((s, c) => s + c.value, 0) / unseen.length : 7.5;
            const base = I.buildEndgameProjection(state, pid, mean, true);
            const baseVal = I.endgameProjectionValue(base, I.TRAINED.medium);
            const np = I.cloneProjection(base);
            if (I.applyProjectionAction(np, a)) {
              const gain = I.endgameProjectionValue(np, I.TRAINED.medium) - baseVal;
              if (gain >= (cfg.moveMinGain != null ? cfg.moveMinGain : 0.0005)) gated.push({ a, gain });
            }
          } catch (e) { /* skip */ }
        } else {
          gated.push({ a });
        }
      } else {
        gated.push({ a });
      }
    }
    if (!gated.length) continue;
    // 偏好类型内按 medium 同口径估值挑最优（确定性 tie-break）
    let best = null, bestScore = -Infinity, bestKey = null;
    for (const g of gated) {
      const v = ctx.score(g.a);
      const key = JSON.stringify(g.a);
      if (v > bestScore + 1e-12 || (Math.abs(v - bestScore) <= 1e-12 && bestKey != null && key < bestKey)) {
        bestScore = v; best = g.a; bestKey = key;
      }
    }
    if (best) return { action: best, score: bestScore };
  }
  return null;
}

function createSpec(cfg) {
  const NAME = cfg.name;
  const overrideProb = cfg.overrideProb != null ? Number(cfg.overrideProb) : 0.4;
  const qualityTol = cfg.qualityTol != null ? Number(cfg.qualityTol) : 0.04;
  return {
    VERSION: VERSION + '-spec-' + NAME,
    NAME: NAME,
    desc: cfg.desc || '',
    chooseLayout: function (state, pid, opts) {
      const o = Object.assign({}, opts || {});
      o.strength = 'medium';
      return AI.chooseLayout(state, pid, o);
    },
    chooseAction: function (state, pid, opts) {
      const o = Object.assign({}, opts || {});
      if (!state || state.phase !== 'battle' || state.turn !== pid) return AI.chooseAction(state, pid, o);
      const legal = E.getLegalActions(state);
      if (!legal.length) return AI.chooseAction(state, pid, o);
      const baseOpts = Object.assign({}, o, { strength: 'medium', battleStrength: 'medium' });
      let base = null;
      try { base = AI.chooseAction(state, pid, baseOpts); } catch (e) { return null; }
      if (!base) return base;
      const inBuild = !!(state.endgame && state.endgame.triggered && state.endgame.phase === 'build');
      if (inBuild) return base; // 决战 build 保持 medium
      const salt = (Number(state.config.seed) >>> 0) + '|' + state.turnCount + '|' + pid + '|' + NAME + '|spec';
      if (I.hashUnit(salt) >= overrideProb) return base;
      let ctx = null;
      try { ctx = makeCtx(state, pid); } catch (e) { return base; }
      const baseScore = ctx.score(base);
      const picked = pickPreferred(state, pid, legal, cfg, ctx);
      if (!picked) return base;
      // 质量门：与「当前所有合法行动的最佳 medium 估值」比较
      let bestLegalScore = baseScore;
      for (const a of legal) {
        if (a.type === 'end_turn') continue;
        const v = ctx.score(a);
        if (v > bestLegalScore + 1e-12) bestLegalScore = v;
      }
      if (bestLegalScore - picked.score > qualityTol) return base;
      const prod = state.turnProgress ? (Number(state.turnProgress.productive) || 0) : 0;
      const stallCount = Number(state.players[pid].stallCount) || 0;
      if (picked.action.type === 'move' && stallCount >= 1) return base;
      if (picked.action.type === 'move' && prod === 0 && !cfg.allowMoveBeforeProductive) return base;
      if (picked.action.type === 'move' && prod === 0 && cfg.allowMoveBeforeProductive) {
        const hasProductive = legal.some((a) => a.type === 'flip' || a.type === 'place' || a.type === 'draw' || a.type === 'settle');
        if (!hasProductive) return base;
      }
      return picked.action;
    }
  };
}

module.exports = { createSpec: createSpec, VERSION: VERSION, pickPreferred: pickPreferred };
