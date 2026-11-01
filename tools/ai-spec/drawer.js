#!/usr/bin/env node
/* v2.4 特化 AI：drawer（基于 medium 3.3.0；接口见 common.js） */
'use strict';
const { createSpec } = require('./common.js');
module.exports = createSpec({
 "name": "drawer",
 "desc": "摸牌流：偏好 draw>flip>place>settle；签名=显著更高 draw 占比、显著更低结算率",
 "prefer": [
  "draw",
  "flip",
  "place",
  "settle"
 ],
 "overrideProb": 0.5,
 "qualityTol": 0.05
});
