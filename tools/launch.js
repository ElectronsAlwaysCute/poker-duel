#!/usr/bin/env node
/*
 * 一键启动器（局域网联机）
 * 目的：用户无需手动输入 `node server.js`——双击项目根目录的「启动联机.bat」
 *       即可启动本地权威服务器，并自动打开浏览器进入联机大厅（?lan=1）。
 *
 * 用法：
 *   node tools/launch.js                # 随机空闲端口，自动打开浏览器
 *   node tools/launch.js --port=5200    # 固定端口（被占用时退回随机端口）
 *   node tools/launch.js --no-open      # 只启动服务器，不开浏览器（测试/服务器用）
 *   node tools/launch.js --host=0.0.0.0 # 监听地址（默认 0.0.0.0，局域网设备可访问）
 */
'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { createLanServer } = require(path.join(__dirname, '..', 'server.js'));

function parseArgs(argv) {
  const out = {};
  argv.slice(2).forEach((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (!m) return;
    out[m[1]] = m[2] === undefined ? true : m[2];
  });
  return out;
}
const args = parseArgs(process.argv);
const WANT_PORT = args.port === undefined ? 0 : Number(args.port);
const HOST = args.host === undefined ? '0.0.0.0' : String(args.host);
const OPEN = !args['no-open'];

function openBrowser(url) {
  if (!OPEN) return false;
  try {
    let cmd, cmdArgs;
    if (process.platform === 'win32') {
      cmd = 'cmd';
      cmdArgs = ['/c', 'start', '', url];
    } else if (process.platform === 'darwin') {
      cmd = 'open';
      cmdArgs = [url];
    } else {
      cmd = 'xdg-open';
      cmdArgs = [url];
    }
    const child = spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore' });
    child.on('error', () => { /* 打开浏览器失败不影响服务 */ });
    child.unref();
    return true;
  } catch (err) {
    return false;
  }
}

function listenWithFallback(server, port) {
  const tryPort = (p) => server.listen(p == null ? 0 : p).catch((err) => {
    const msg = String((err && err.message) || err);
    if (/EADDRINUSE|EACCES/i.test(msg) && p !== 0) {
      console.warn('[启动] 端口 ' + p + ' 不可用，改用随机空闲端口…');
      return tryPort(0);
    }
    throw err;
  });
  return tryPort(port);
}

(async () => {
  const lanServer = createLanServer();
  const requested = Number.isInteger(WANT_PORT) && WANT_PORT >= 0 && WANT_PORT <= 65535 ? WANT_PORT : 0;
  const info = await listenWithFallback(lanServer, requested);
  const port = info && info.port;
  const url = 'http://127.0.0.1:' + port + '/?lan=1';
  console.log('====================================================');
  console.log('  扑克牌 · 比大小 —— 局域网联机已启动（无需手动命令）');
  console.log('  本机进入联机大厅：' + url);
  const lanUrls = (info && info.lanUrls) || [];
  lanUrls.forEach((u) => {
    if (u.indexOf('127.0.0.1') < 0 && u.indexOf('localhost') < 0) console.log('  局域网其它设备访问：' + u + '/');
  });
  console.log('  停止服务：关闭本窗口，或按 Ctrl+C');
  console.log('====================================================');
  const opened = openBrowser(url);
  if (opened) console.log('[启动] 已在浏览器中打开联机大厅（若未自动打开，请手动访问上方地址）。');
  else console.log('[提示] 未自动打开浏览器（--no-open 或打开失败），请手动访问上方地址。');
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    console.log('\n[启动] 正在关闭联机服务器…');
    lanServer.close().then(() => process.exit(0)).catch(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
})().catch((err) => {
  console.error('[启动] 启动失败：' + ((err && err.message) || err));
  process.exit(1);
});
