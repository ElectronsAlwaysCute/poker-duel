#!/usr/bin/env node
/* v2.4 特化 AI：turtle（基于 medium 3.3.0；接口见 common.js） */
'use strict';
const { createSpec } = require('./common.js');
module.exports = createSpec({
 "name": "turtle",
 "desc": "龟缩囤积：偏好 draw>flip>place>settle，只在锁定或 war.win≥0.70 时结算；签名=更低结算率、更高摸牌/翻牌",
 "prefer": [
  "draw",
  "flip",
  "place",
  "settle"
 ],
 "settleGate": "safe",
 "settleMinWin": 0.7,
 "overrideProb": 0.5,
 "qualityTol": 0.03
});
