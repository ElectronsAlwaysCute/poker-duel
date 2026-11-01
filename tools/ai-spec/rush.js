#!/usr/bin/env node
/* v2.4 特化 AI：rush（基于 medium 3.3.0；接口见 common.js） */
'use strict';
const { createSpec } = require('./common.js');
module.exports = createSpec({
 "name": "rush",
 "desc": "强攻：settle 门槛 war.win≥0.50 或锁定；偏好 settle>place>flip>draw；签名=更高结算占比/结算率",
 "prefer": [
  "settle",
  "place",
  "flip",
  "draw"
 ],
 "settleGate": "safe",
 "settleMinWin": 0.5,
 "overrideProb": 0.3,
 "qualityTol": 0.03
});
