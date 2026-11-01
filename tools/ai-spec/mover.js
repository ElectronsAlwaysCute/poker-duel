#!/usr/bin/env node
/* v2.4 特化 AI：mover（基于 medium 3.3.0；接口见 common.js） */
'use strict';
const { createSpec } = require('./common.js');
module.exports = createSpec({
 "name": "mover",
 "desc": "移牌流：偏好 move>place>flip>draw（quality 门内选 medium 同口径最优 move）；签名=更高 move 占比/更低结算率",
 "prefer": [
  "move",
  "place",
  "flip",
  "draw"
 ],
 "movesRequireGain": false,
 "overrideProb": 0.35,
 "qualityTol": 0.02
});
