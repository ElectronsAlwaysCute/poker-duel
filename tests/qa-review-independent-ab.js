'use strict';
/* task-115 QA 独立 A/B：自己实现同 seed 双向换座配对（不复用 ai-dev 的 ab-medium.js 统计代码） */
const fs = require('fs');
const path = require('path');
const ROOT = 'D:/GAME/poker-duel';
const E = require(path.join(ROOT, 'js/engine.js'));
const CANON6 = require(path.join(ROOT, 'tools/ai-benchmark.js')).CANON6_CONFIGS;
const A = require(path.join(ROOT, 'tools/tmp-v28/medium/cand-medium-pure-v1.js'));
const B = require(path.join(ROOT, 'tools/tmp-v28/medium/base-ai3.js'));
const PAIRS_PER_CFG = Number(process.env.QA_AB_PAIRS || 100);
const SEED0 = 930000;
function keyOf(a) { return JSON.stringify(a || null); }
function playOne(seed, cfg, aSeat) {
  const st = E.createGame(E.defaultConfig({ regionCount: cfg.regionCount, settleCards: cfg.settleCards, difficulty: cfg.difficulty, firstPlayer: 'random', seed }));
  const pol = (pid) => (pid === aSeat ? A : B);
  try {
    E.submitLayout(st, 'p1', pol('p1').chooseLayout(st, 'p1', { strength: 'hard', rng: E.makeRng(seed ^ 0x1111) }));
    E.submitLayout(st, 'p2', pol('p2').chooseLayout(st, 'p2', { strength: 'hard', rng: E.makeRng(seed ^ 0x2222) }));
    E.finalizeLayout(st);
  } catch (e) { return { err: 'layout' }; }
  let steps = 0;
  while (!E.isGameOver(st) && steps++ < 6000) {
    const legal = E.getLegalActions(st);
    if (!legal.length) return { err: 'no-legal' };
    let act = null;
    try { act = pol(st.turn).chooseAction(st, st.turn, { strength: 'hard' }); } catch (e) { return { err: 'choose' }; }
    const m = legal.find((l) => keyOf(l) === keyOf(act));
    if (!m) return { err: 'illegal' };
    try { E.performAction(st, m); } catch (e) { return { err: 'perform' }; }
  }
  if (!E.isGameOver(st)) return { err: 'unfinished' };
  const w = st.result.winner;
  return { outcome: w === 'draw' ? 'draw' : (w === aSeat ? 'win' : 'loss'), forfeit: st.result.reason === 'forfeit' };
}
const out = { generatedAt: new Date().toISOString(), A: A.VERSION, B: B.VERSION, pairsPerConfig: PAIRS_PER_CFG, seeds: [SEED0, SEED0 + PAIRS_PER_CFG - 1], configs: {}, totals: { games: 0, wins: 0, losses: 0, draws: 0, errors: 0, forfeits: 0, aOnly: 0, bOnly: 0, tie: 0, deltaSum: 0 } };
for (const cfg of CANON6) {
  const pc = { games: 0, aw: 0, al: 0, ad: 0, aOnly: 0, bOnly: 0, tie: 0, deltaSum: 0, errors: 0, forfeits: 0 };
  for (let i = 0; i < PAIRS_PER_CFG; i++) {
    const seed = SEED0 + i;
    const seatWeCallA = i % 2 === 0 ? 'p1' : 'p2';
    const r1 = playOne(seed, cfg, seatWeCallA);
    const r2 = playOne(seed, cfg, seatWeCallA === 'p1' ? 'p2' : 'p1');
    for (const r of [r1, r2]) {
      if (r.err) { pc.errors++; continue; }
      pc.games++; pc.forfeits += r.forfeit ? 1 : 0;
      if (r.outcome === 'win') pc.aw++; else if (r.outcome === 'loss') pc.al++; else pc.ad++;
    }
    if (!r1.err && !r2.err) {
      const s1 = r1.outcome === 'win' ? 1 : (r1.outcome === 'loss' ? 0 : 0.5);
      const s2 = r2.outcome === 'win' ? 1 : (r2.outcome === 'loss' ? 0 : 0.5);
      const delta = s1 + s2 - 1;
      pc.deltaSum += delta;
      if (delta > 0.25) pc.aOnly++; else if (delta < -0.25) pc.bOnly++; else pc.tie++;
    }
  }
  pc.deTied = pc.aw + pc.al ? +(100 * pc.aw / (pc.aw + pc.al)).toFixed(2) : null;
  out.configs[cfg.key] = pc;
  out.totals.games += pc.games; out.totals.wins += pc.aw; out.totals.losses += pc.al; out.totals.draws += pc.ad;
  out.totals.errors += pc.errors; out.totals.forfeits += pc.forfeits;
  out.totals.aOnly += pc.aOnly; out.totals.bOnly += pc.bOnly; out.totals.tie += pc.tie; out.totals.deltaSum += pc.deltaSum;
}
out.totals.deTied = +(100 * out.totals.wins / (out.totals.wins + out.totals.losses)).toFixed(2);
out.totals.deltaPt = +(100 * out.totals.deltaSum / Math.max(1, out.totals.aOnly + out.totals.bOnly + out.totals.tie)).toFixed(2);
fs.writeFileSync(path.join(ROOT, 'tests', 'qa-review-independent-ab-cand-vs-base.json'), JSON.stringify(out, null, 1));
console.log(JSON.stringify({ A: out.A, B: out.B, totals: out.totals, configs: Object.fromEntries(Object.entries(out.configs).map(([k, v]) => [k, { n: v.games, wr: v.deTied, aOnly: v.aOnly, bOnly: v.bOnly, tie: v.tie, ff: v.forfeits }])) }, null, 1));
console.log('QA-REVIEW-INDEPENDENT-AB DONE');
