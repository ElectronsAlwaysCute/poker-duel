#!/usr/bin/env node
/* =========================================================================
 * tools/ai-spec/index.js — v2.4 特化 AI 注册表
 *   list() → [{name, module, desc}]（module 为已 require 的模块对象，另有 path 字段）
 *   get(name) → 特化 AI 对象（含 VERSION/NAME/chooseLayout/chooseAction）
 * 供 ML 联盟数据采集（collect-world --pool=league）与 eval --opp=spec:<name> 使用。
 * ========================================================================= */
'use strict';
const path = require('path');
const NAMES = ['rush', 'turtle', 'flipper', 'mover', 'drawer', 'lockhunter'];
const DESCS = {
  rush: '强攻：低门槛结算 + 放牌',
  turtle: '龟缩：翻/放建设，避免结算',
  flipper: '翻牌流：优先翻开高值背面牌',
  mover: '移牌流：优先提升投影的弃区/集中',
  drawer: '摸牌流：优先摸牌积累',
  lockhunter: '锁胜流：结算锁定胜场/反锁'
};
const CACHE = {};
function load(name) {
  if (!NAMES.includes(name)) {
    throw new Error('未知特化 AI：' + name + '（可选：' + NAMES.join(', ') + '）');
  }
  if (!CACHE[name]) CACHE[name] = require(path.join(__dirname, name + '.js'));
  return CACHE[name];
}
function list() {
  return NAMES.map((name) => ({ name, module: load(name), path: name + '.js', desc: DESCS[name] || '' }));
}
function get(name) { return load(name); }
module.exports = { list, get, getSpec: get, NAMES: NAMES.slice(), VERSION: '2.4.0' };
