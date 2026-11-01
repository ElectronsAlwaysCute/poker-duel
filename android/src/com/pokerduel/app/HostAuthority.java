package com.pokerduel.app;

import android.app.Activity;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 隐藏 WebView 中的权威 JS（assets/host/authority.html + lan_authority.js）。
 * Java 服务器线程通过本类与 JS 同步交互：
 *   call(method,path,queryJson,bodyJson,headersJson) -> {"status":..,"body":{..}}
 *   poll(code,token,since) -> {"events":[..],"closed":..}
 * 桥接方式：evaluateJavascript -> JS 调用 HostBridge.onResult(callId, json) -> 本类唤醒等待线程。
 */
class HostAuthority {
    private final Activity activity;
    private final WebView webView;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final AtomicInteger ids = new AtomicInteger(1);
    private final ConcurrentHashMap<Integer, Pending> pending = new ConcurrentHashMap<Integer, Pending>();
    private final CountDownLatch ready = new CountDownLatch(1);
    private volatile boolean destroyed = false;

    private static class Pending {
        final CountDownLatch latch = new CountDownLatch(1);
        volatile String result;
    }

    public class Bridge {
        @JavascriptInterface
        public void onResult(int id, String json) {
            Pending p = pending.get(id);
            if (p != null) {
                p.result = json;
                p.latch.countDown();
            }
        }

        @JavascriptInterface
        public void onReady() {
            ready.countDown();
        }
    }

    HostAuthority(Activity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setAllowFileAccess(true);
        webView.getSettings().setDomStorageEnabled(false);
        webView.addJavascriptInterface(new Bridge(), "HostBridge");
        webView.setWebViewClient(new WebViewClient());
        webView.loadUrl("file:///android_asset/host/authority.html");
    }

    boolean awaitReady(long ms) {
        try {
            return ready.await(ms, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    String call(String method, String path, String queryJson, String bodyJson, String headersJson) {
        if (destroyed) return errorJson("STOPPED");
        if (!awaitReady(5000)) return errorJson("NOT_READY");
        int id = ids.getAndIncrement();
        Pending p = new Pending();
        pending.put(Integer.valueOf(id), p);
        String js = "__authorityCall(" + id + ","
                + JSONObject.quote(method) + ","
                + JSONObject.quote(path) + ","
                + JSONObject.quote(queryJson == null ? "{}" : queryJson) + ","
                + JSONObject.quote(headersJson == null ? "{}" : headersJson) + ","
                + JSONObject.quote(bodyJson == null ? "" : bodyJson) + ")";
        postJs(js);
        try {
            if (!p.latch.await(5000, TimeUnit.MILLISECONDS)) {
                pending.remove(Integer.valueOf(id));
                return errorJson("TIMEOUT");
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            pending.remove(Integer.valueOf(id));
            return errorJson("INTERRUPTED");
        }
        pending.remove(Integer.valueOf(id));
        return p.result == null ? errorJson("NO_RESULT") : p.result;
    }

    String poll(String code, String token, long since) {
        if (destroyed) return "{\"events\":[],\"closed\":false}";
        if (!awaitReady(5000)) return "{\"events\":[],\"closed\":false}";
        int id = ids.getAndIncrement();
        Pending p = new Pending();
        pending.put(Integer.valueOf(id), p);
        String js = "__authorityPoll(" + id + "," + JSONObject.quote(code) + ","
                + JSONObject.quote(token) + "," + since + ")";
        postJs(js);
        try {
            if (!p.latch.await(5000, TimeUnit.MILLISECONDS)) {
                // v2.12.8：轮询超时绝不能当作「房间已关闭」——否则 SSE 会被服务端主动断开，
                // 客户端反复重连，表现为游戏内网络抖动/不稳定。返回空事件让流继续。
                pending.remove(Integer.valueOf(id));
                return "{\"events\":[],\"closed\":false}";
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            pending.remove(Integer.valueOf(id));
            return "{\"events\":[],\"closed\":false}";
        }
        pending.remove(Integer.valueOf(id));
        return p.result == null ? "{\"events\":[],\"closed\":false}" : p.result;
    }

    void disconnect(String code, String token) {
        postJs("__authorityDisconnect(" + JSONObject.quote(code) + "," + JSONObject.quote(token) + ")");
    }

    private void postJs(final String js) {
        main.post(new Runnable() {
            @Override
            public void run() {
                if (!destroyed) {
                    try {
                        webView.evaluateJavascript(js, null);
                    } catch (Throwable ignored) {
                    }
                }
            }
        });
    }

    void stop() {
        destroyed = true;
        main.post(new Runnable() {
            @Override
            public void run() {
                try {
                    webView.stopLoading();
                    webView.destroy();
                } catch (Throwable ignored) {
                }
            }
        });
    }

    static String errorJson(String code) {
        return "{\"status\":500,\"body\":{\"ok\":false,\"error\":{\"code\":\"" + code
                + "\",\"message\":\"authority " + code + "\"}}}";
    }
}
