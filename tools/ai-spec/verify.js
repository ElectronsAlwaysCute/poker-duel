#!/usr/bin/env node
/* =========================================================================
 * tools/ai-spec/verify.js — v2.4 特化 AI 验证矩阵（canon6 + full27）
 *  1) 强度：每个特化 vs 新 medium（目标 45%~58%）、vs 新 hard（目标 ≥40%）
 *  2) 行为签名：行动占比 / settle 频率与时机 / 提前锁定率（对 medium 的 L1 距离）
 *  3) 安全与性能：0 forfeit / 0 非法 / 0 异常；决策 p95 < 25ms
 *  4) 确定性 + 信息公平（隐藏信息置换后决策不变）
 * 配置集：canon6（3/5 区 × N1/N2/N4，AI 3.x 验收口径）与 full27（3/5/7 区 × N1/N2/N4 × D1/D2/D3）
 * 证据输出：tools/training-logs/ai-v24-spec-verify.json
 * 用法：node tools/ai-spec/verify.js [--games=600] [--json=PATH] [--sets=canon6,full27]
 * ========================================================================= */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const E = require(path.join(ROOT, 'js', 'engine.js'));
const AI = require(path.join(ROOT, 'js', 'ai.js'));
const bench = require(path.join(ROOT, 'tools', 'ai-benchmark.js'));
const idx = require(path.join(ROOT, 'tools', 'ai-spec', 'index.js'));

function parseArgs(argv) {
  const out = {};
  argv.slice(2).forEach((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (!m) return;
    out[m[1]] = m[2] === undefined ? '1' : m[2];
  });
  return out;
}
const args = parseArgs(process.argv);
const GAMES = Number(args.games || 600);
const SETS = String(args.sets || 'canon6,full27').split(',').map((s) => s.trim()).filter(Boolean);
const JSON_PATH = args.json ? (path.isAbsolute(String(args.json)) ? String(args.json) : path.join(ROOT, String(args.json))) : path.join(ROOT, 'tools', 'training-logs', 'ai-v24-spec-verify.json');

function buildFull27() {
  const out = [];
  for (const r of [3, 5, 7]) {
    for (const s of [1, 2, 4]) {
      for (const d of [1, 2, 3]) {
        const cfg = E.defaultConfig({ regionCount: r, settleCards: s, difficulty: d });
        const v = E.validateConfig(cfg);
        if (!v.ok) continue;
        out.push({ key: 'R' + r + 'N' + s + 'D' + d, regionCount: r, settleCards: s, difficulty: d });
      }
    }
  }
  return out;
}
const CONFIG_SETS = {
  canon6: bench.CANON6_CONFIGS.slice(),
  full27: buildFull27()
};

function runVs(specAi, label, oppStrength, configs, games, seed) {
  const rep = bench.runBenchmarkImpl({
    specs: {
      p1: { label, strength: 'medium', ai: specAi },
      p2: { label: 'opp', strength: oppStrength, ai: AI }
    },
    games, startSeed: seed, bidir: true,
    configs, loaded: { current: AI }
  });
  const o = rep.overall;
  const lab = rep.byLabel[label] || {};
  const oppLab = rep.byLabel.opp || {};
  return {
    wr: o.aWinRateDecisive, ci: o.aWinRateDecisiveCI, wins: o.aWins, losses: o.bWins, draws: o.draws,
    forfeits: o.forfeits, errors: o.errors + rep.errors.length, games: o.games,
    byConfig: Object.keys(rep.byConfig).reduce((m, k) => { m[k] = { games: rep.byConfig[k].games, wr: rep.byConfig[k].aWinRateDecisive }; return m; }, {}),
    behavior: {
      actionShare: lab.actionShare || {}, settlePerGame: lab.settlePerGame, settleAvgDeck: lab.settleAvgDeck,
      settleAvgOpen: lab.settleAvgOpen, settleAvgTurnIndex: lab.settleAvgTurnIndex,
      earlyLockRate: lab.earlyLockRate, forfeits: lab.forfeits, stalls: lab.stalls,
      decisions: lab.decisions, turns: lab.turns, decisionMs: lab.decisionMs || null,
      opponentActionShare: oppLab.actionShare || {},
      opponentBehavior: {
        actionShare: oppLab.actionShare || {}, settlePerGame: oppLab.settlePerGame,
        settleAvgDeck: oppLab.settleAvgDeck, settleAvgOpen: oppLab.settleAvgOpen,
        settleAvgTurnIndex: oppLab.settleAvgTurnIndex, earlyLockRate: oppLab.earlyLockRate
      }
    }
  };
}

function signatureDistance(a, b) {
  const keys = ['settle', 'flip', 'place', 'move', 'draw', 'end_turn'];
  let l1 = 0;
  for (const k of keys) l1 += Math.abs((a.actionShare[k] || 0) - (b.actionShare[k] || 0));
  const settleDiff = Math.abs((a.settlePerGame || 0) - (b.settlePerGame || 0));
  const turnDiff = Math.abs((a.settleAvgTurnIndex || 0) - (b.settleAvgTurnIndex || 0)) / 10;
  return { actionShareL1: l1, settlePerGameDiff: settleDiff, settleTurnDiffNorm: turnDiff, score: l1 + 0.15 * settleDiff + 0.1 * turnDiff };
}

/* 行为签名达标判定（task-96）：至少 3 类行动占比差异≥5pt 或 结算率差异≥10pt
 * 结算率差异同时给出两种口径：settle 行动占比差（pt）与 settle 次数/局 的相对差（%）。 */
function signatureAnalysis(a, b) {
  const keys = ['settle', 'flip', 'place', 'move', 'draw', 'end_turn'];
  const diffsPt = {};
  for (const k of keys) diffsPt[k] = 100 * ((a.actionShare[k] || 0) - (b.actionShare[k] || 0));
  const sigKeysAbs5 = keys.filter((k) => Math.abs(diffsPt[k]) >= 5).length;
  const settleShareDiffPt = Math.abs(diffsPt.settle);
  const baseSettle = Math.max(1e-9, b.settlePerGame || 0);
  const settlePerGame = a.settlePerGame != null ? a.settlePerGame : 0;
  const settleRateRelDiff = Math.abs(settlePerGame - baseSettle) / baseSettle;
  return {
    diffsPt, sigKeysAbs5, settleShareDiffPt, settleRateRelDiff,
    pass: sigKeysAbs5 >= 3 || settleShareDiffPt >= 10 || settleRateRelDiff >= 0.10,
    rule: 'sigKeysAbs5>=3 或 settleShareDiffPt>=10 或 settleRateRelDiff>=10%'
  };
}

function scrambleHidden(state, pid) {
  const v = JSON.parse(JSON.stringify(state));
  const opp = pid === 'p1' ? 'p2' : 'p1';
  v.deck.reverse();
  v.players[opp].hand.reverse();
  for (const r of v.regions) r.sides[opp].faceDown.reverse();
  v.discard.reverse();
  return v;
}
function actionKey(a) {
  if (!a) return 'null';
  const t = a.type;
  if (t === 'settle') return 'settle|' + a.regionId;
  if (t === 'flip') return 'flip|' + a.regionId + '|' + a.cardId;
  if (t === 'place') return 'place|' + a.regionId + '|' + a.cardId;
  if (t === 'move') return 'move|' + a.fromRegionId + '|' + a.cardId + '|' + a.toRegionId;
  return t;
}
function determinismFairness(specAi) {
  const state = E.createGame(E.defaultConfig({ regionCount: 5, settleCards: 2, difficulty: 1, firstPlayer: 'p1', seed: 20490001 }));
  E.submitLayout(state, 'p1', AI.chooseLayout(state, 'p1', { strength: 'medium', rng: E.makeRng(1) }));
  E.submitLayout(state, 'p2', AI.chooseLayout(state, 'p2', { strength: 'medium', rng: E.makeRng(2) }));
  E.finalizeLayout(state);
  let checked = 0, detFail = 0, fairFail = 0, illegal = false;
  let steps = 0;
  while (!E.isGameOver(state) && steps < 4000 && checked < 40) {
    const pid = state.turn;
    const legal = E.getLegalActions(state);
    if (!legal.length) break;
    const a1 = specAi.chooseAction(state, pid, {});
    const a2 = specAi.chooseAction(state, pid, {});
    checked++;
    if (actionKey(a1) !== actionKey(a2)) detFail++;
    const scr = scrambleHidden(state, pid);
    const a3 = specAi.chooseAction(scr, pid, {});
    if (actionKey(a1) !== actionKey(a3)) fairFail++;
    const matched = legal.find((x) => actionKey(x) === actionKey(a1));
    if (!matched) { illegal = true; break; }
    E.performAction(state, matched);
    steps++;
  }
  return { checked, detFail, fairFail, illegal };
}

if (require.main === module) {
  (function main() {
  const out = {
    generatedAt: new Date().toISOString(), aiVersion: AI.VERSION, specVersion: idx.VERSION,
    gamesPerOpponent: GAMES, seedStart: 20450000,
    configSets: {}, specModules: {}, signatures: {}, safety: {}
  };
  const seeds = { canon6: 20450000, full27: 20460000 };
  const names = args.names ? String(args.names).split(',').map((s) => s.trim()).filter(Boolean) : idx.NAMES.slice();
  for (const n of names) if (!idx.NAMES.includes(n)) throw new Error('未知特化名：' + n + '（可选：' + idx.NAMES.join(',') + '）');
  for (const setName of SETS) {
    const configs = CONFIG_SETS[setName];
    if (!configs || !configs.length) throw new Error('未知或空配置集：' + setName);
    out.configSets[setName] = { configs: configs.map((c) => c.key), matrix: {}, signatures: {} };
    const mediumSig = {};
    for (const name of names) {
      const ai = idx.get(name);
      const vsMedium = runVs(ai, name, 'medium', configs, GAMES, seeds[setName]);
      const vsHard = runVs(ai, name, 'hard', configs, GAMES, seeds[setName] + 1);
      const det = detFail(ai);
      const sigAna = signatureAnalysis(vsMedium.behavior, vsMedium.behavior.opponentBehavior);
      out.configSets[setName].matrix[name] = {
        vsMedium: { wr: vsMedium.wr, ci: vsMedium.ci, wins: vsMedium.wins, losses: vsMedium.losses, draws: vsMedium.draws, games: vsMedium.games, passes45to58: vsMedium.wr >= 0.45 && vsMedium.wr <= 0.58, byConfig: vsMedium.byConfig },
        vsHard: { wr: vsHard.wr, ci: vsHard.ci, wins: vsHard.wins, losses: vsHard.losses, draws: vsHard.draws, games: vsHard.games, passes40: vsHard.wr >= 0.40, byConfig: vsHard.byConfig },
        forfeits: vsMedium.forfeits + vsHard.forfeits,
        errors: vsMedium.errors + vsHard.errors,
        p95: vsMedium.behavior.decisionMs ? vsMedium.behavior.decisionMs.p95 : null,
        p95Pass: vsMedium.behavior.decisionMs ? vsMedium.behavior.decisionMs.p95 < 25 : null,
        determinismPass: det.detFail === 0 && !det.illegal,
        fairnessPass: det.fairFail === 0,
        signature: sigAna,
        signaturePass: sigAna.pass,
        behavior: vsMedium.behavior
      };
      out.specModules[name] = { VERSION: ai.VERSION, NAME: ai.NAME, desc: ai.desc };
      mediumSig[name] = vsMedium.behavior.opponentBehavior;
    }
    // 行为签名：对 medium 的距离 + 两两距离
    for (const name of names) {
      const b = out.configSets[setName].matrix[name].behavior;
      out.configSets[setName].signatures[name] = signatureDistance(b, mediumSig[name]);
    }
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const A = out.configSets[setName].matrix[names[i]].behavior;
        const B = out.configSets[setName].matrix[names[j]].behavior;
        out.configSets[setName].signatures[names[i] + ' vs ' + names[j]] = signatureDistance(A, B);
      }
    }
    const m = out.configSets[setName].matrix;
    out.safety[setName] = {
      totalForfeits: names.reduce((s, n) => s + m[n].forfeits, 0),
      totalErrors: names.reduce((s, n) => s + m[n].errors, 0),
      allDeterministic: names.every((n) => m[n].determinismPass),
      allFair: names.every((n) => m[n].fairnessPass),
      allP95: names.every((n) => m[n].p95Pass !== false),
      allVsMediumInRange: names.every((n) => m[n].vsMedium.passes45to58),
      allVsHardAtLeast40: names.every((n) => m[n].vsHard.passes40),
      allSignaturePass: names.every((n) => m[n].signaturePass),
      evaluatedSpecs: names.slice()
    };
  }
  fs.writeFileSync(JSON_PATH, JSON.stringify(out, null, 1), 'utf8');
  for (const setName of SETS) {
    console.log('\n== 配置集 ' + setName + '（n=' + GAMES + '/对手，' + out.configSets[setName].configs.length + ' 配置，双向去平） ==');
    console.log('name        vsMedium% [CI]        vsHard%   forfeit err  p95ms  sigKeys settleDiff 签名');
    for (const name of names) {
      const m = out.configSets[setName].matrix[name];
      const sig = out.configSets[setName].signatures[name];
      const sa = m.signature;
      console.log(name.padEnd(11) + (100 * m.vsMedium.wr).toFixed(1).padEnd(9) + ('[' + (100 * m.vsMedium.ci.lo).toFixed(1) + ',' + (100 * m.vsMedium.ci.hi).toFixed(1) + ']').padEnd(17) + (100 * m.vsHard.wr).toFixed(1).padEnd(9) + String(m.forfeits).padEnd(8) + String(m.errors).padEnd(4) + (m.p95 != null ? m.p95.toFixed(2) : '-').padEnd(7) + String(sa.sigKeysAbs5).padEnd(8) + (sa.settleShareDiffPt.toFixed(1) + 'pt/' + (100 * sa.settleRateRelDiff).toFixed(0) + '%').padEnd(12) + (m.signaturePass ? 'PASS' : 'FAIL') + '  L1=' + (sig ? sig.actionShareL1.toFixed(3) : '-'));
    }
    console.log('safety:', JSON.stringify(out.safety[setName]));
  }
  const allPass = SETS.every((s) => {
    const st = out.safety[s];
    return st && st.allDeterministic && st.allFair && st.allP95 && st.allSignaturePass && st.totalForfeits === 0 && st.totalErrors === 0 && st.allVsMediumInRange && st.allVsHardAtLeast40;
  });
  console.log('\n总体:', allPass ? 'PASS' : 'PARTIAL/FAIL');
  console.log('证据：' + JSON_PATH);
  function detFail(ai) { return determinismFairness(ai); }
  if (!allPass) process.exitCode = 1;
  })();
}

module.exports = { runVs, signatureAnalysis, signatureDistance, determinismFairness, buildFull27, CONFIG_SETS };
