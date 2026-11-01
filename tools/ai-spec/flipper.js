#!/usr/bin/env node
/* v2.4 特化 AI：flipper（基于 medium 3.3.0；接口见 common.js） */
'use strict';
const { createSpec } = require('./common.js');
module.exports = createSpec({
 "name": "flipper",
 "desc": "翻牌流：偏好 flip>place>draw>settle，翻高值背面牌；签名=更高 flip 占比/更低结算率",
 "prefer": [
  "flip",
  "place",
  "draw",
  "settle"
 ],
 "settleGate": "safe",
 "settleMinWin": 0.7,
 "overrideProb": 0.4,
 "qualityTol": 0.03
});
