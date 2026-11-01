# 安卓运行方案调研（WebView 离线壳 + 联机客户端）

> 目标：让 `poker-duel` 在安卓手机上运行，并提供可安装的 APK；同时保留**局域网联机**功能。
> 结论：**原生 WebView 壳 + 本地回环 HTTP 资产服务器（单机离线） + 远程服务器 URL（联机）**；不修改产品网页文件。

## 1. 环境探测（本机构建机）

| 项 | 结果 |
|---|---|
| OS | Windows 10/11 x64，C: 剩余 ~116GB |
| JDK | 初始**无**；用 Adoptium Temurin **JDK 17.0.20.1** 便携 zip 解压到 `tools/tmp-v28/android-pack/jdk17`（免安装/免管理员） |
| Android SDK | 初始**无**；下载 `commandlinetools-win-11076708_latest.zip`，`sdkmanager` 安装 `platform-tools`、`platforms;android-34`、`build-tools;34.0.0` |
| 网络 | `dl.google.com` / `services.gradle.org` 可达（HTTP 200） |
| 设备/模拟器 | **无 adb 设备、未安装模拟器**（真机验证受限，见 §6） |
| 构建方式 | 手工组装：`aapt2`(compile/link) + `javac` + `d8` + `zipalign` + `apksigner`，**无需 Gradle/AGP** |

## 2. 方案对比

| 方案 | 说明 | 结论 |
|---|---|---|
| A1. WebView + `file:///android_asset/index.html` | 最简单；但 `file://` origin 的 localStorage/DOM storage 在部分 WebView 版本不可靠（游戏设置持久化依赖它），且 `aapt2 -A` 在 Windows 可能写入反斜杠资产路径导致资源 404 | 否决（已实测到反斜杠路径 bug） |
| **A2. WebView + 本地回环 HTTP 资产服务器**（选定） | 在 APP 内起一个仅监听 `127.0.0.1:<随机端口>` 的极简 HTTP 静态服务器，把 assets 提供给 WebView；origin 为正常 `http://127.0.0.1` → localStorage/音频/资源加载走标准 HTTP 栈，行为与桌面浏览器一致；完全离线 | **采用（单机离线模式）** |
| A3. WebView + 远程服务器 URL（选定） | 加载 PC 上 `node server.js` 提供的 `http://<PC-IP>:5211/index.html`，WebView 作为普通浏览器客户端 → 与桌面 LAN 联机完全同一套协议/界面；手机-手机也可通过同一 PC 服务器联机 | **采用（联机模式）** |
| B. Capacitor / Cordova | 需 npm 依赖链与 Gradle/AGP，构建体积/复杂度高，收益与 A2 相同 | 否决 |
| C. TWA / PWA | 需 HTTPS 在线托管，游戏要求离线可玩 | 否决 |
| D. **手机内嵌权威服务器（v2.11.0 已实现）** | Java 实现 LAN 传输（HTTP 静态资源 + `/api/*` + SSE），权威逻辑移植自 `server.js` 为纯 JS `lan_authority.js`（复用 engine.js），运行在**隐藏 WebView**中，通过 JS 桥与 Java 服务器同步交互；房主手机自己也是普通客户端（从 127.0.0.1 加载游戏） | **已实现（手机当房主）**，无需 PC、无需 Node |

## 3. 选定架构（v2.11.0：三种模式）

```
Android APK
├── MainActivity (Java，无第三方依赖)
│   ├── 模式① 单机离线：内置 AssetServer（仅 127.0.0.1）提供 assets → WebView
│   ├── 模式② 手机当房主：HostServer(0.0.0.0:5211..) + HostAuthority(隐藏 WebView)
│   │     ├── HostServer：静态资源（assets）+ /api/* 转发 + SSE（轮询事件日志）
│   │     ├── HostAuthority：隐藏 WebView 执行 assets/host/authority.html
│   │     │     └── lan_authority.js（移植 server.js 的房间/布阵/行动/镜像脱敏逻辑，复用 engine.js）
│   │     └── 本机 WebView 同时从 http://127.0.0.1:<port>/ 加载游戏 → 房主也是普通客户端
│   └── 模式③ 加入联机：WebView 加载 http://<服务器>:5211/index.html（PC 或房主手机）
└── assets/  ← 构建时只读复制 index.html / js / css / music / sfx + host-overlay
```

- **不修改游戏产品文件**：`js/`、`index.html`、`css/` 原样复制进 assets；手机当房主的权威逻辑是 Android 侧新增文件（`host-overlay/`），产品联机协议保持一致（`js/net.js` 零改动即可连本机/PC 服务器）。
- **构建可复现**：`android/build.ps1` 完成资产复制（含 host-overlay）→ 图标 → aapt2 → javac（3 个 Java 类）→ d8 → 写回 classes.dex/assets（**正斜杠路径**）→ zipalign → apksigner → 校验。
- **权威 JS 可测**：`tools/tmp-v28/android-host/test-authority.js` 在 Node 中用真实 engine 模拟两名客户端走完 API/SSE 全流程（创建/加入/布阵/行动/终局/再来一局/离开、镜像视角、信息脱敏、事件 seq），全部 PASS。

## 4. 已修复的关键问题

1. **aapt2 `-A assets` 在 Windows 写入反斜杠路径**：APK 内出现 `assets/js\engine.js`，WebView 按 `assets/js/engine.js` 请求会 404 → 改为 aapt2 不处理 assets，构建脚本用 .NET ZipArchive 以正斜杠路径逐文件写入（已用 `containsFwd=True` 校验）。
2. **file:// localStorage 风险**：改为本地回环 HTTP origin。
3. **局域网明文 HTTP**：manifest 开 `usesCleartextTraffic=true`（Android 9+ 默认禁明文），并申请 `INTERNET` / `ACCESS_NETWORK_STATE`。

## 5. 验证（构建机无设备）

- `aapt2 dump badging`：`package=com.pokerduel.app versionCode=3 versionName=2.11.0`、`minSdk 23 / targetSdk 34`、launcher activity、屏幕方向 landscape、label/icon 正确；权限 INTERNET/ACCESS_NETWORK_STATE/WAKE_LOCK。
- `apksigner verify --verbose`：v1/v2/v3 签名通过，证书指纹一致。
- `dexdump`：classes.dex 含 `MainActivity`、`HostServer`、`HostAuthority` 及其内部类。
- APK 内 assets 正斜杠路径，含 index.html/js/css/music/sfx + `host/authority.html` / `host/lan_authority.js`。
- **权威 JS Node 全流程测试**：`node tools/tmp-v28/android-host/test-authority.js` —— 28 项全 PASS（创建/加入/布阵/行动/终局/再来一局/离开、镜像视角、信息脱敏、事件日志/seq、坏 token 拒绝），用真实 `js/engine.js` 打完整局。
- **未真机验证**：Java HTTP/SSE 服务器、隐藏 WebView JS 桥、触屏交互需在手机上验证（清单见 `android/README.md` §5）。

## 6. 已知限制/风险

1. **未在真机/模拟器上实测**（本机无 adb 设备、未装模拟器）：Java 传输层/桥接与触屏交互需手机验证；权威逻辑本身已有 Node 全流程测试。
2. 横屏锁定（`sensorLandscape`）：游戏为桌面 1440×900 布局，横屏体验最佳；竖屏未适配。
3. 触屏拖动体验（放牌/移牌/背面牌拖动）依赖 WebView pointer 事件，需真机验证手感。
4. **联机三种形态**：① 手机当房主（v2.11.0，无需 PC，其他设备打开房主地址即可；需同一 Wi-Fi，注意 AP 隔离/防火墙）；② 加入 PC 服务器（PC 运行 `node server.js`）；③ 手机加入另一台房主手机。服务器地址手动输入（无自动发现/二维码）；房主模式端口 5211 起自动顺延。
5. 自签证书安装时需允许「未知来源」；不同签名版本的 APK 不能覆盖安装（需先卸载）。
6. 背景音乐为用户提供的本地文件（项目内使用）；音效为 Kenney CC0（见 `sfx/LICENSES.md`）。若对外分发 APK，请确认音乐素材的再分发授权。
