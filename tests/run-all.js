#!/usr/bin/env node
'use strict';
/*
 * 一键运行全部 Node 测试（零依赖）
 *   node tests/run-all.js              # 单元 + 边界 + AI + 模拟 300 局
 *   node tests/run-all.js --games=2000 # 指定模拟局数
 *   node tests/run-all.js --skip-sim   # 只跑单元/边界/AI
 *
 * 任一子项失败则退出码非 0。使用 stdio:inherit，输出实时可见。
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let games = 300;
let skipSim = false;
let skipLan = false;
for (const raw of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(raw);
  if (!m) continue;
  if (m[1] === 'games') games = Math.max(1, Number(m[2]) || 300);
  if (m[1] === 'skip-sim') skipSim = true;
  if (m[1] === 'skip-lan') skipLan = true;
}

const steps = [
  { name: '单元测试 tests/engine.test.js', file: 'engine.test.js', args: [] },
  { name: '边界测试 tests/edge.test.js', file: 'edge.test.js', args: [] },
  { name: 'AI 测试 tests/ai.test.js', file: 'ai.test.js', args: [] },
  { name: 'AI 行为测试 tests/ai-behavior.test.js（v2.1 提前 end_turn / build 连放）', file: 'ai-behavior.test.js', args: [] },
  { name: '困难档纯学习 bundle tests/ai-pure-hard.test.js（v2.18 H192 gen436）', file: 'ai-pure-hard.test.js', args: [] },
  { name: '终局判定回归 tests/engine-endgame-judgment.test.js（v2.6 胜场优先/真平局）', file: 'engine-endgame-judgment.test.js', args: [] },
  { name: '决战 AP 上限 tests/engine-apcap.test.js', file: 'engine-apcap.test.js', args: [] },
];
// LAN 集成测试：仅当 server.js 存在且未显式跳过时纳入（保证单机旧回归不受影响）
if (!skipLan && fs.existsSync(path.join(ROOT, 'server.js'))) {
  steps.push({ name: 'LAN 集成测试 tests/lan.test.js', file: 'lan.test.js', args: [] });
}
if (!skipSim) steps.push({ name: 'AI 自对弈模拟 tests/sim.js --games=' + games, file: 'sim.js', args: ['--games=' + games] });

let failed = 0;
const t0 = Date.now();
for (const step of steps) {
  console.log('\n━━━━━━━━━━ ' + step.name + ' ━━━━━━━━━━');
  const r = spawnSync(process.execPath, [path.join(__dirname, step.file), ...step.args], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    failed++;
    console.log('✖ 失败：' + step.name + '（exit=' + r.status + (r.signal ? ', signal=' + r.signal : '') + '）');
  } else {
    console.log('✔ 通过：' + step.name);
  }
}
console.log('\n══════════════════════════════════════');
console.log(failed === 0 ? '全部通过 ✔  耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's'
  : '失败 ' + failed + ' 项 ✖  耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
process.exit(failed === 0 ? 0 : 1);
