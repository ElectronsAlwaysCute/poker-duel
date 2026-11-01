package com.pokerduel.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.DialogInterface;
import android.content.SharedPreferences;
import android.content.res.AssetManager;
import android.graphics.Color;
import android.net.ConnectivityManager;
import android.net.LinkProperties;
import android.net.Network;
import android.net.RouteInfo;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.util.List;

/**
 * 扑克牌·比大小 —— 安卓壳（v2.11.0）。
 *
 * 三种模式（启动选择 / 右上角 ⚙ 切换）：
 *  1) 单机离线：内置 127.0.0.1 本地 HTTP 资产服务器（localStorage/音频走标准 HTTP）；
 *  2) 手机当房主：本机启动 LAN 权威服务器（HTTP/SSE，静态资源 + /api/*，权威 JS 跑在隐藏 WebView），
 *     其他手机/电脑浏览器打开本机地址即可加入；本机同时作为客户端从 127.0.0.1 加载游戏；
 *  3) 加入联机：输入 PC/房主手机地址（http://<ip>:5211），作为 WebView 浏览器客户端加入。
 *
 * 返回键 2 秒内双击退出；横屏锁定；屏幕常亮；全屏沉浸。
 */
public class MainActivity extends Activity {
    private static final String PREFS = "pokerduel_prefs";
    private static final String KEY_MODE = "mode"; // offline | lan | host
    private static final String KEY_URL = "server_url"; // host:port

    private WebView webView;
    private FrameLayout rootLayout;
    private boolean offlineFallbackTried = false;
    private long lastBackPressedAt = 0L;
    private SharedPreferences prefs;

    private AssetServer assetServer;      // 单机离线
    private HostServer hostServer;        // 手机当房主
    private HostAuthority hostAuthority;  // 房主权威 JS（隐藏 WebView）
    private WebView authorityView;
    private List<String> hostUrls;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WindowManager.LayoutParams lp = getWindow().getAttributes();
            lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(lp);
        }
        hideSystemUi();

        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);

        rootLayout = new FrameLayout(this);
        webView = new WebView(this);
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        // v2.12.6：离线 file:// 兜底时允许本地资源读取（部分机型 loopback 被系统联网权限拦截）
        try {
            s.setAllowFileAccessFromFileURLs(true);
            s.setAllowUniversalAccessFromFileURLs(true);
        } catch (Throwable ignored) {
        }
        webView.setWebContentsDebuggingEnabled(true);
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView view, android.webkit.WebResourceRequest request, android.webkit.WebResourceError error) {
                if (request == null || !request.isForMainFrame()) return;
                String failing = request.getUrl() != null ? request.getUrl().toString() : "";
                // v2.12.6：若本机 127.0.0.1 资源被系统网络权限拒绝（常见于国产 ROM 的「联网控制」），
                // 自动回退到内置 file:// 离线页面，避免直接黑屏报错。
                if (failing.startsWith("http://127.0.0.1:") && !offlineFallbackTried) {
                    offlineFallbackTried = true;
                    Toast.makeText(MainActivity.this,
                            "本机资源被系统联网权限拦截，已切换内置离线模式（建议到手机管家/安全中心→联网控制 允许本应用联网）",
                            Toast.LENGTH_LONG).show();
                    view.loadUrl("file:///android_asset/index.html?drag=0");
                    return;
                }
                if (failing.startsWith("http://127.0.0.1:")) {
                    Toast.makeText(MainActivity.this,
                            "本机离线页面加载被系统拦截：请到 手机管家/安全中心 → 联网控制 → 允许「扑克牌·比大小」联网，或点右上角⚙切换模式",
                            Toast.LENGTH_LONG).show();
                } else {
                    Toast.makeText(MainActivity.this,
                            "加载失败：请检查服务器地址/PC 或房主手机是否启动服务/手机与服务器是否同一 Wi-Fi；可点右上角⚙切换模式",
                            Toast.LENGTH_LONG).show();
                }
            }
        });
        webView.setWebChromeClient(new WebChromeClient());
        webView.setBackgroundColor(0xFF0B0F1A);
        rootLayout.addView(webView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        TextView gear = new TextView(this);
        gear.setText("⚙");
        gear.setTextSize(22f);
        gear.setTextColor(Color.WHITE);
        gear.setGravity(Gravity.CENTER);
        gear.setBackgroundColor(0x66000000);
        gear.setPadding(18, 6, 18, 6);
        FrameLayout.LayoutParams gp = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT);
        gp.gravity = Gravity.TOP | Gravity.END;
        gp.topMargin = 12;
        gp.rightMargin = 12;
        gear.setLayoutParams(gp);
        gear.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                showModeDialog();
            }
        });
        rootLayout.addView(gear);

        setContentView(rootLayout);

        String mode = prefs.getString(KEY_MODE, "");
        if (mode.isEmpty()) {
            showModeDialog();
        } else {
            loadMode(mode);
        }
    }

    private void loadMode(String mode) {
        if ("host".equals(mode)) {
            startHostMode();
            return;
        }
        stopHostMode();
        if ("lan".equals(mode)) {
            String url = normalizeUrl(prefs.getString(KEY_URL, ""));
            if (!url.isEmpty()) {
                webView.loadUrl(url);
                return;
            }
        }
        loadOffline();
    }

    /* ---------------- 单机离线：127.0.0.1 资产服务器 ---------------- */
    private void loadOffline() {
        try {
            if (assetServer == null) {
                assetServer = new AssetServer(getAssets());
                assetServer.start();
            }
            webView.loadUrl("http://127.0.0.1:" + assetServer.getPort() + "/index.html?drag=0");
        } catch (IOException e) {
            Toast.makeText(this, "离线服务器启动失败，尝试 file:// 模式", Toast.LENGTH_LONG).show();
            webView.loadUrl("file:///android_asset/index.html?drag=0");
        }
    }

    /* ---------------- 手机当房主：LAN 权威服务器 ---------------- */
    private void startHostMode() {
        stopHostMode();
        try {
            HostServer hs = new HostServer(getAssets());
            final int p = hs.bind();
            List<String> urls = hs.urls();

            authorityView = new WebView(this);
            authorityView.setVisibility(View.VISIBLE);
            FrameLayout.LayoutParams ap = new FrameLayout.LayoutParams(2, 2);
            authorityView.setTranslationX(10000f);
            authorityView.setTranslationY(10000f);
            rootLayout.addView(authorityView, ap);
            final HostAuthority ha = new HostAuthority(this, authorityView);
            hostAuthority = ha;

            hs.start(ha);
            hostServer = hs;
            hostUrls = urls;

            showHostInfo(false);
            // v2.12.3：等权威 JS 就绪后再打开房主页面，并带 ?lan=1 直接进入联机大厅（避免首屏 /api/info 失败）
            final String hostUrl = "http://127.0.0.1:" + p + "/index.html?lan=1&drag=0";
            Thread t = new Thread(new Runnable() {
                @Override
                public void run() {
                    final boolean ready = ha.awaitReady(10000);
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            if (hostServer == null && hostAuthority == null) return; // 已切换模式
                            if (!ready) {
                                Toast.makeText(MainActivity.this,
                                        "联机服务器初始化较慢，正在尝试打开大厅（若显示离线请稍后在大厅点重试）",
                                        Toast.LENGTH_LONG).show();
                            }
                            webView.loadUrl(hostUrl);
                        }
                    });
                }
            }, "host-authority-wait");
            t.setDaemon(true);
            t.start();
        } catch (IOException e) {
            Toast.makeText(this, "无法启动房主服务器（端口被占用？）：" + e.getMessage(), Toast.LENGTH_LONG).show();
            prefs.edit().putString(KEY_MODE, "offline").apply();
            loadOffline();
        }
    }

    private void stopHostMode() {
        if (hostServer != null) {
            hostServer.stop();
            hostServer = null;
        }
        if (hostAuthority != null) {
            hostAuthority.stop();
            hostAuthority = null;
        }
        if (authorityView != null) {
            rootLayout.removeView(authorityView);
            authorityView = null;
        }
        hostUrls = null;
    }

    private String primaryHostUrl() {
        if (hostUrls == null || hostUrls.isEmpty()) return "";
        // v2.12.3：优先返回手机热点常见网段（其他手机连热点后可直接使用），否则第一个非 loopback
        String[] hotspotPrefixes = {
                "192.168.43.", "192.168.42.", "192.168.137.", "192.168.49.",
                "172.20.10.", "10.42.0.", "10.0.0."
        };
        for (String prefix : hotspotPrefixes) {
            for (String u : hostUrls) {
                if (u.contains(prefix)) return u;
            }
        }
        for (String u : hostUrls) {
            if (!u.contains("127.0.0.1")) return u;
        }
        return hostUrls.get(0);
    }

    private void showHostInfo(boolean allowSwitchOnly) {
        String joinUrl = primaryHostUrl();
        StringBuilder msg = new StringBuilder();
        msg.append("本机已开启联机服务器（手机当房主）。\n\n");
        msg.append("【本机操作】游戏会自动进入「联机大厅」：点「创建房间」，把显示的 5 位房间码告诉对方，等对方加入后开始。\n\n");
        msg.append("【对方操作】连接本机热点后，在 APP 选「加入联机」输入 ").append(joinUrl.replace("http://", "")).append(" （或用浏览器打开 ").append(joinUrl).append("）；进入大厅后输入 5 位房间码「加入房间」。\n\n");
        msg.append("提示：需与加入设备在同一 Wi-Fi/热点；若对方打不开，请确认本机 APP 保持前台、地址填写正确（不要用 https、不要漏 :5211），并检查热点是否开启了设备隔离。\n");
        msg.append("若本机刚打开热点、地址列表未刷新：请点「刷新地址」（常见热点网关见下方 192.168.43.1 等）。\n\n");
        msg.append("本机地址（对方连热点时优先用 192.168.43.x / 172.20.10.x 等热点网段，同一 Wi-Fi 时用局域网 IP）：\n");
        for (String u : hostUrls != null ? hostUrls : java.util.Collections.<String>emptyList()) {
            msg.append("  ").append(u).append("\n");
        }
        AlertDialog.Builder b = new AlertDialog.Builder(this)
                .setTitle("手机当房主 · 服务器已启动")
                .setMessage(msg.toString())
                .setNeutralButton("刷新地址", new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {
                        // v2.12.4：热点可能在本弹窗之后才打开；重新枚举网卡并重开说明
                        if (hostServer != null) hostUrls = hostServer.urls();
                        showHostInfo(allowSwitchOnly);
                    }
                })
                .setNegativeButton(allowSwitchOnly ? "切换模式" : "知道了", new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {
                        if (allowSwitchOnly) showModeDialog();
                    }
                });
        if (joinUrl.length() > 0) {
            b.setPositiveButton("复制加入地址", new DialogInterface.OnClickListener() {
                @Override
                public void onClick(DialogInterface dialog, int which) {
                    String url = primaryHostUrl();
                    ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                    cm.setPrimaryClip(ClipData.newPlainText("join-url", url));
                    Toast.makeText(MainActivity.this, "已复制：" + url, Toast.LENGTH_SHORT).show();
                    if (allowSwitchOnly) showModeDialog();
                }
            });
        }
        b.show();
    }

    /* ---------------- 加入联机地址 ---------------- */
    private String normalizeUrl(String raw) {
        String v = raw == null ? "" : raw.trim();
        if (v.isEmpty()) return "";
        if (!v.startsWith("http://") && !v.startsWith("https://")) {
            v = "http://" + v;
        }
        while (v.endsWith("/")) {
            v = v.substring(0, v.length() - 1);
        }
        String hostPart = v.substring(v.indexOf("://") + 3);
        if (!hostPart.contains(":")) {
            v = v + ":5211";
        }
        if (!v.endsWith("/index.html")) {
            v = v + "/index.html";
        }
        // v2.11.2：Android APP 关闭拖拽（避免与触屏滑动冲突）；桌面浏览器不受影响
        // v2.12.3：加入联机时自动进入联机大厅（?lan=1），避免玩家不知道点「局域网联机」
        v = v + (v.indexOf("?") >= 0 ? "&" : "?") + "lan=1&drag=0";
        return v;
    }

    /* ---------------- 模式选择 ---------------- */
    private void showModeDialog() {
        final String[] items = new String[]{
                "单机（离线，内置资产）",
                "手机当房主（本机开服务器，其他手机加入）",
                "加入联机（输入 PC/房主手机地址）"
        };
        AlertDialog.Builder b = new AlertDialog.Builder(this)
                .setTitle("选择游戏模式")
                .setItems(items, new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {
                        if (which == 0) {
                            prefs.edit().putString(KEY_MODE, "offline").apply();
                            loadMode("offline");
                        } else if (which == 1) {
                            prefs.edit().putString(KEY_MODE, "host").apply();
                            loadMode("host");
                        } else {
                            showServerDialog();
                        }
                    }
                })
                // v2.12.2：返回/退出放在「选择游戏模式」（右上角齿轮）弹窗；设置面板内不再显示
                .setNegativeButton("返回", new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {
                        // 首次启动尚未选择模式时，返回=进入单机离线；否则关闭弹窗、保持当前对局/模式不变
                        if (prefs.getString(KEY_MODE, "").isEmpty()) {
                            prefs.edit().putString(KEY_MODE, "offline").apply();
                            loadMode("offline");
                        }
                    }
                })
                .setPositiveButton("退出", new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {
                        finishAffinity();
                    }
                });
        if ("host".equals(prefs.getString(KEY_MODE, ""))) {
            b.setNeutralButton("查看本机服务器地址", new DialogInterface.OnClickListener() {
                @Override
                public void onClick(DialogInterface dialog, int which) {
                    showHostInfo(true);
                }
            });
        }
        b.setCancelable(false).show();
    }

    /* ---------------- v2.12.5：当前网络网关探测（连热点时通常就是房主地址） ---------------- */
    private String detectGateway() {
        try {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return "";
            Network n = cm.getActiveNetwork();
            if (n == null) return "";
            LinkProperties lp = cm.getLinkProperties(n);
            if (lp == null) return "";
            for (RouteInfo r : lp.getRoutes()) {
                if (r.isDefaultRoute()) {
                    InetAddress gw = r.getGateway();
                    if (gw instanceof java.net.Inet4Address) return gw.getHostAddress();
                }
            }
        } catch (Throwable ignored) {
        }
        return "";
    }

    private void testServerAsync(final String raw) {
        final String url = normalizeUrlForTest(raw);
        if (url.isEmpty()) {
            Toast.makeText(this, "请先输入地址", Toast.LENGTH_SHORT).show();
            return;
        }
        Toast.makeText(this, "正在检测 " + url + " ...", Toast.LENGTH_SHORT).show();
        Thread t = new Thread(new Runnable() {
            @Override
            public void run() {
                String result;
                try {
                    HttpURLConnection conn = (HttpURLConnection) new URL(url + "/api/info").openConnection();
                    conn.setConnectTimeout(4000);
                    conn.setReadTimeout(4000);
                    int code = conn.getResponseCode();
                    result = code == 200
                            ? "服务器可达 ✔（" + url + "/api/info 返回 200）"
                            : "服务器返回 HTTP " + code + "（请确认对方游戏已开房主模式）";
                } catch (Throwable e) {
                    result = "无法连接 " + url + "\n请检查：①地址是否为对方热点网关（如 192.168.43.1）②对方服务器已启动且 APP 在前台 ③手机确实连的是对方热点";
                }
                final String finalResult = result;
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        Toast.makeText(MainActivity.this, finalResult, Toast.LENGTH_LONG).show();
                    }
                });
            }
        }, "lan-server-test");
        t.setDaemon(true);
        t.start();
    }

    private String normalizeUrlForTest(String raw) {
        String v = raw == null ? "" : raw.trim();
        if (v.isEmpty()) return "";
        if (!v.startsWith("http://") && !v.startsWith("https://")) v = "http://" + v;
        while (v.endsWith("/")) v = v.substring(0, v.length() - 1);
        // 去掉可能误粘的 /index.html，测试接口统一到根
        int idx = v.indexOf("/index.html");
        if (idx > 0) v = v.substring(0, idx);
        return v;
    }

    private void showServerDialog() {
        final String gateway = detectGateway();
        final EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setHint("例如 192.168.43.1:5211");
        String saved = prefs.getString(KEY_URL, "");
        if (!saved.isEmpty()) {
            input.setText(saved);
        } else if (!gateway.isEmpty()) {
            // 连热点时，本机网络默认网关通常就是房主地址
            input.setText(gateway + ":5211");
        }
        input.setSelection(input.getText().length());
        String gwHint = gateway.isEmpty()
                ? "未检测到当前网络网关（请先连接房主热点/Wi-Fi）"
                : "检测到当前网络网关：" + gateway + "（连热点时通常就是房主地址，已自动填入:5211）";
        AlertDialog.Builder b = new AlertDialog.Builder(this)
                .setTitle("加入联机 · 服务器地址")
                .setMessage(gwHint + "\n\n输入房主手机或 PC 的服务器地址；热点场景填「网关 IP:5211」，同一 Wi-Fi 场景填对方局域网 IP。")
                .setView(input)
                .setPositiveButton("连接", new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {
                        String raw = input.getText().toString().trim();
                        if (raw.isEmpty()) {
                            Toast.makeText(MainActivity.this, "地址不能为空", Toast.LENGTH_SHORT).show();
                            showModeDialog();
                            return;
                        }
                        prefs.edit().putString(KEY_MODE, "lan").putString(KEY_URL, raw).apply();
                        loadMode("lan");
                    }
                })
                .setNegativeButton("返回", new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {
                        showModeDialog();
                    }
                })
                .setNeutralButton("测试连接", null)
                .setCancelable(false);
        final AlertDialog dlg = b.show();
        // 「测试连接」不关闭弹窗
        dlg.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                testServerAsync(input.getText().toString().trim());
            }
        });
    }

    private void hideSystemUi() {
        View decor = getWindow().getDecorView();
        decor.setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemUi();
    }

    @Override
    protected void onDestroy() {
        stopHostMode();
        if (assetServer != null) {
            assetServer.stop();
            assetServer = null;
        }
        super.onDestroy();
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            long now = System.currentTimeMillis();
            if (now - lastBackPressedAt < 2000L) {
                finish();
                return true;
            }
            lastBackPressedAt = now;
            new AlertDialog.Builder(this)
                    .setTitle("退出游戏")
                    .setMessage("再按一次返回键或点击「退出」关闭游戏。")
                    .setPositiveButton("退出", new DialogInterface.OnClickListener() {
                        @Override
                        public void onClick(DialogInterface dialog, int which) {
                            finish();
                        }
                    })
                    .setNegativeButton("继续游戏", null)
                    .show();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    /**
     * 仅监听 127.0.0.1 的极简静态文件服务器（单机离线模式）。
     */
    static class AssetServer implements Runnable {
        private final AssetManager assets;
        private ServerSocket serverSocket;
        private Thread thread;
        private volatile boolean running = false;

        AssetServer(AssetManager assets) {
            this.assets = assets;
        }

        void start() throws IOException {
            serverSocket = new ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"));
            running = true;
            thread = new Thread(this, "pokerduel-assets");
            thread.setDaemon(true);
            thread.start();
        }

        int getPort() {
            return serverSocket.getLocalPort();
        }

        void stop() {
            running = false;
            try {
                if (serverSocket != null) serverSocket.close();
            } catch (IOException ignored) {
            }
            serverSocket = null;
        }

        @Override
        public void run() {
            while (running) {
                Socket socket = null;
                try {
                    socket = serverSocket.accept();
                    handle(socket);
                } catch (IOException ignored) {
                } finally {
                    if (socket != null) {
                        try {
                            socket.close();
                        } catch (IOException ignored) {
                        }
                    }
                }
            }
        }

        private void handle(Socket socket) {
            try {
                InputStream in = socket.getInputStream();
                StringBuilder head = new StringBuilder();
                int b;
                int count = 0;
                while ((b = in.read()) != -1) {
                    head.append((char) b);
                    count++;
                    if (count > 8192) break;
                    if (head.length() >= 4 && head.substring(head.length() - 4).equals("\r\n\r\n")) break;
                }
                String request = head.toString();
                String firstLine = request.split("\r\n", 2)[0];
                String[] parts = firstLine.split(" ");
                if (parts.length < 2) {
                    writeResponse(socket, 400, "text/plain", "Bad Request".getBytes("UTF-8"));
                    return;
                }
                boolean headOnly = parts[0].equalsIgnoreCase("HEAD");
                String path = parts[1];
                int q = path.indexOf('?');
                if (q >= 0) path = path.substring(0, q);
                while (path.startsWith("/")) path = path.substring(1);
                if (path.isEmpty()) path = "index.html";
                if (path.contains("..")) {
                    writeResponse(socket, 403, "text/plain", "Forbidden".getBytes("UTF-8"));
                    return;
                }
                InputStream file;
                try {
                    file = assets.open(path);
                } catch (IOException e) {
                    writeResponse(socket, 404, "text/plain", ("Not Found: " + path).getBytes("UTF-8"));
                    return;
                }
                byte[] data = readAll(file);
                file.close();
                writeResponse(socket, 200, mimeOf(path), data, headOnly);
            } catch (IOException ignored) {
            }
        }

        private static byte[] readAll(InputStream in) throws IOException {
            ByteArrayOutputStream out = new ByteArrayOutputStream(Math.max(1024, in.available()));
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
            return out.toByteArray();
        }

        private static void writeResponse(Socket socket, int status, String mime, byte[] body) throws IOException {
            writeResponse(socket, status, mime, body, false);
        }

        private static void writeResponse(Socket socket, int status, String mime, byte[] body, boolean headOnly) throws IOException {
            String reason = status == 200 ? "OK" : (status == 403 ? "Forbidden" : "Not Found");
            OutputStream out = socket.getOutputStream();
            String header = "HTTP/1.1 " + status + " " + reason + "\r\n"
                    + "Content-Type: " + mime + "\r\n"
                    + "Content-Length: " + body.length + "\r\n"
                    + "Cache-Control: no-cache\r\n"
                    + "Connection: close\r\n"
                    + "\r\n";
            out.write(header.getBytes("UTF-8"));
            if (!headOnly) out.write(body);
            out.flush();
        }

        private static String mimeOf(String path) {
            String p = path.toLowerCase();
            if (p.endsWith(".html") || p.endsWith(".htm")) return "text/html";
            if (p.endsWith(".js")) return "application/javascript";
            if (p.endsWith(".css")) return "text/css";
            if (p.endsWith(".png")) return "image/png";
            if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
            if (p.endsWith(".svg")) return "image/svg+xml";
            if (p.endsWith(".mp3")) return "audio/mpeg";
            if (p.endsWith(".ogg")) return "audio/ogg";
            if (p.endsWith(".wav")) return "audio/wav";
            if (p.endsWith(".json")) return "application/json";
            return "application/octet-stream";
        }
    }
}
