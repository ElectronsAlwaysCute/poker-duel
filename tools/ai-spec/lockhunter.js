#!/usr/bin/env node
/* v2.4 特化 AI：lockhunter（基于 medium 3.3.0；接口见 common.js） */
'use strict';
const { createSpec } = require('./common.js');
module.exports = createSpec({
 "name": "lockhunter",
 "desc": "锁胜流：偏好 settle>draw>place>flip，仅在锁定/接近锁定时结算；签名=更低结算率、更高摸牌",
 "prefer": [
  "settle",
  "draw",
  "place",
  "flip"
 ],
 "settleGate": "lock+",
 "overrideProb": 0.45,
 "qualityTol": 0.04
});
