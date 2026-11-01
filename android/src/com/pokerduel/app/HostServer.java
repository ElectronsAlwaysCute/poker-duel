package com.pokerduel.app;

import android.content.res.AssetManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * 手机当房主的 LAN 权威 HTTP/SSE 服务器。
 * - 静态资源：从 assets 提供游戏文件（客户端浏览器/APP 均从本机加载游戏）
 * - /api/*：转发给隐藏 WebView 中的 JS 权威（HostAuthority）
 * - /api/rooms/:code/stream：SSE 长连接，轮询 JS 权威的事件日志下发
 */
class HostServer {
    private static final int MAX_HEADER = 32768;
    private static final int MAX_BODY = 262144;

    private final AssetManager assets;
    private ServerSocket serverSocket;
    private volatile boolean running = false;
    private HostAuthority authority;
    private int port = -1;
    private final List<Socket> sockets = Collections.synchronizedList(new ArrayList<Socket>());
    private Thread acceptThread;

    HostServer(AssetManager assets) {
        this.assets = assets;
    }

    int bind() throws IOException {
        IOException last = null;
        for (int p = 5211; p <= 5235; p++) {
            try {
                ServerSocket ss = new ServerSocket();
                ss.setReuseAddress(true);
                ss.bind(new InetSocketAddress("0.0.0.0", p), 50);
                serverSocket = ss;
                port = p;
                return p;
            } catch (IOException e) {
                last = e;
            }
        }
        throw last != null ? last : new IOException("无法绑定端口");
    }

    int getPort() {
        return port;
    }

    List<String> urls() {
        List<String> out = new ArrayList<String>();
        out.add("http://127.0.0.1:" + port);
        try {
            Enumeration<NetworkInterface> ifaces = NetworkInterface.getNetworkInterfaces();
            while (ifaces != null && ifaces.hasMoreElements()) {
                NetworkInterface ni = ifaces.nextElement();
                if (!ni.isUp() || ni.isLoopback()) continue;
                Enumeration<InetAddress> addrs = ni.getInetAddresses();
                while (addrs.hasMoreElements()) {
                    InetAddress addr = addrs.nextElement();
                    if (addr instanceof java.net.Inet4Address) {
                        String u = "http://" + addr.getHostAddress() + ":" + port;
                        if (!out.contains(u)) out.add(u);
                    }
                }
            }
        } catch (Throwable ignored) {
        }
        // v2.12.4：部分机型/系统在热点开启后不会把 AP 网卡暴露给 NetworkInterface（或只在开启后才出现）。
        // 追加常见热点网关候选；仅作为对方连热点时的备用地址（以本机实际热点网关为准）。
        String[] hotspotGateways = {
                "192.168.43.1", "192.168.42.1", "192.168.49.1",
                "172.20.10.1", "192.168.137.1"
        };
        for (String gw : hotspotGateways) {
            String u = "http://" + gw + ":" + port;
            if (!out.contains(u)) out.add(u);
        }
        return out;
    }

    void start(HostAuthority authority) {
        this.authority = authority;
        running = true;
        acceptThread = new Thread(new Runnable() {
            @Override
            public void run() {
                acceptLoop();
            }
        }, "pokerduel-hostsrv");
        acceptThread.setDaemon(true);
        acceptThread.start();
    }

    void stop() {
        running = false;
        try {
            if (serverSocket != null) serverSocket.close();
        } catch (IOException ignored) {
        }
        serverSocket = null;
        synchronized (sockets) {
            for (Socket s : sockets) {
                try {
                    s.close();
                } catch (IOException ignored) {
                }
            }
            sockets.clear();
        }
    }

    private void acceptLoop() {
        while (running) {
            Socket socket = null;
            try {
                socket = serverSocket.accept();
            } catch (IOException e) {
                if (!running) break;
                continue;
            }
            sockets.add(socket);
            final Socket s = socket;
            Thread t = new Thread(new Runnable() {
                @Override
                public void run() {
                    try {
                        handleClient(s);
                    } finally {
                        sockets.remove(s);
                        try {
                            s.close();
                        } catch (IOException ignored) {
                        }
                    }
                }
            }, "pokerduel-conn");
            t.setDaemon(true);
            t.start();
        }
    }

    private static class Request {
        String method;
        String path;
        String query;
        Map<String, String> headers = new HashMap<String, String>();
        byte[] body = new byte[0];
    }

    private void handleClient(Socket socket) {
        try {
            socket.setSoTimeout(15000);
            try {
                socket.setTcpNoDelay(true);
            } catch (Throwable ignored) {
            }
            InputStream rawIn = socket.getInputStream();
            BufferedInputStream in = new BufferedInputStream(rawIn);
            Request req = readRequest(in);
            if (req == null) {
                return;
            }
            String pathname = req.path;
            if (pathname.startsWith("/api/")) {
                handleApi(socket, req);
            } else {
                serveStatic(socket, req);
            }
        } catch (Throwable ignored) {
        }
    }

    private Request readRequest(InputStream in) throws IOException {
        Request req = new Request();
        ByteArrayOutputStream line = new ByteArrayOutputStream();
        int b;
        int total = 0;
        // request line
        String requestLine = null;
        while ((b = in.read()) != -1) {
            total++;
            if (total > MAX_HEADER) return null;
            if (b == '\n') break;
            if (b != '\r') line.write(b);
        }
        if (line.size() == 0) return null;
        requestLine = line.toString("UTF-8");
        String[] parts = requestLine.split(" ");
        if (parts.length < 2) return null;
        req.method = parts[0].toUpperCase(Locale.ROOT);
        String target = parts[1];
        int q = target.indexOf('?');
        req.path = q >= 0 ? target.substring(0, q) : target;
        req.query = q >= 0 ? target.substring(q + 1) : "";
        // headers
        while (true) {
            line.reset();
            while ((b = in.read()) != -1) {
                total++;
                if (total > MAX_HEADER) return null;
                if (b == '\n') break;
                if (b != '\r') line.write(b);
            }
            if (line.size() == 0) break;
            String h = line.toString("UTF-8");
            int colon = h.indexOf(':');
            if (colon > 0) {
                req.headers.put(h.substring(0, colon).trim().toLowerCase(Locale.ROOT), h.substring(colon + 1).trim());
            }
        }
        int len = 0;
        String cl = req.headers.get("content-length");
        if (cl != null) {
            try {
                len = Integer.parseInt(cl);
            } catch (NumberFormatException e) {
                len = 0;
            }
        }
        if (len > MAX_BODY) return null;
        if (len > 0) {
            req.body = new byte[len];
            int off = 0;
            while (off < len) {
                int n = in.read(req.body, off, len - off);
                if (n < 0) break;
                off += n;
            }
        }
        return req;
    }

    private void handleApi(Socket socket, Request req) throws IOException {
        if (req.path.equals("/api/info") && req.method.equals("GET")) {
            String res = authority.call("GET", "/api/info", "{}", "", "{}");
            writeApiResult(socket, res);
            return;
        }
        // v2.12.1 修复：创建房间接口（POST /api/rooms）此前未路由，导致房主/客户端都 404、双方卡住
        if (req.path.equals("/api/rooms") && req.method.equals("POST")) {
            String bodyText = req.body.length > 0 ? new String(req.body, "UTF-8") : "";
            String headersJson = "{}";
            if (req.headers.get("authorization") != null) {
                headersJson = "{\"authorization\":" + JSONObject.quote(req.headers.get("authorization")) + "}";
            }
            String res = authority.call("POST", "/api/rooms", "{}", bodyText, headersJson);
            writeApiResult(socket, res);
            return;
        }
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("^/api/rooms/([A-Za-z0-9]{4,12})(?:/(join|stream|layout|action|rematch|leave|snapshot))?$")
                .matcher(req.path);
        if (!m.matches()) {
            writeJson(socket, 404, "{\"ok\":false,\"error\":{\"code\":\"BAD_REQUEST\",\"message\":\"接口不存在\"}}");
            return;
        }
        String code = m.group(1).toUpperCase(Locale.ROOT);
        String action = m.group(2);
        Map<String, String> query = parseQuery(req.query);
        String token = query.get("token");
        if (token == null || token.length() == 0) {
            String auth = req.headers.get("authorization");
            if (auth != null && auth.startsWith("Bearer ")) token = auth.substring(7).trim();
        }
        String bodyText = req.body.length > 0 ? new String(req.body, "UTF-8") : "";
        if (token == null || token.length() == 0) {
            // create/join 的 token 在 body 中；其余接口从 body.token 兜底
            try {
                JSONObject b = bodyText.length() > 0 ? new JSONObject(bodyText) : new JSONObject();
                if (b.has("token") && !b.isNull("token")) token = b.getString("token");
            } catch (Throwable ignored) {
            }
        }

        if ("GET".equals(req.method) && "stream".equals(action)) {
            serveStream(socket, code, token);
            return;
        }

        String queryJson = "{}";
        if (token != null) {
            queryJson = "{\"token\":" + JSONObject.quote(token) + "}";
        }
        String headersJson = "{}";
        if (req.headers.get("authorization") != null) {
            headersJson = "{\"authorization\":" + JSONObject.quote(req.headers.get("authorization")) + "}";
        }
        String res = authority.call(req.method, req.path, queryJson, bodyText, headersJson);
        writeApiResult(socket, res);
    }

    private void serveStream(Socket socket, String code, String token) throws IOException {
        OutputStream out = socket.getOutputStream();
        if (token == null || token.length() == 0) {
            writeJson(socket, 401, "{\"ok\":false,\"error\":{\"code\":\"BAD_TOKEN\",\"message\":\"缺少 token\"}}");
            return;
        }
        String queryJson = "{\"token\":" + JSONObject.quote(token) + "}";
        String snap = authority.call("GET", "/api/rooms/" + code, queryJson, "", "{}");
        JSONObject snapRoot;
        try {
            snapRoot = new JSONObject(snap);
        } catch (Throwable e) {
            writeJson(socket, 500, "{\"ok\":false,\"error\":{\"code\":\"INTERNAL\",\"message\":\"snapshot parse\"}}");
            return;
        }
        int status = snapRoot.optInt("status", 500);
        JSONObject snapBody = snapRoot.optJSONObject("body");
        if (status != 200 || snapBody == null) {
            writeJson(socket, status, snapBody != null ? snapBody.toString() : "{\"ok\":false}");
            return;
        }
        socket.setSoTimeout(0);
        try {
            socket.setTcpNoDelay(true);
        } catch (Throwable ignored) {
        }
        String headers = "HTTP/1.1 200 OK\r\n"
                + "Content-Type: text/event-stream; charset=utf-8\r\n"
                + "Cache-Control: no-store, no-transform\r\n"
                + "Connection: keep-alive\r\n"
                + "X-Accel-Buffering: no\r\n"
                + "\r\n";
        out.write(headers.getBytes("UTF-8"));
        out.write(": connected\n\n".getBytes("UTF-8"));
        out.flush();
        long seq = snapBody.optLong("seq", 0);
        writeSse(out, "update", snapBody.toString(), seq);
        long lastPing = System.currentTimeMillis();
        int consecutiveErrors = 0;
        try {
            while (running && !socket.isClosed()) {
                Thread.sleep(180);
                // v2.12.8：单次轮询超时/JS 桥繁忙不关闭 SSE 流，只发心跳继续，
                // 连续失败过多才断开（避免游戏内网络反复重连的抖动）。
                String pr;
                try {
                    pr = authority.poll(code, token, seq);
                } catch (Throwable pollErr) {
                    pr = null;
                }
                if (pr != null) {
                    try {
                        JSONObject p = new JSONObject(pr);
                        JSONArray evs = p.optJSONArray("events");
                        if (evs != null) {
                            for (int i = 0; i < evs.length(); i++) {
                                JSONObject e = evs.getJSONObject(i);
                                long s = e.optLong("seq", seq);
                                writeSse(out, e.optString("type", "update"), e.toString(), s);
                                if (s > seq) seq = s;
                            }
                        }
                        if (System.currentTimeMillis() - lastPing > 5000) {
                            out.write(": ping\n\n".getBytes("UTF-8"));
                            out.flush();
                            lastPing = System.currentTimeMillis();
                        }
                        if (p.optBoolean("closed", false)) break;
                        consecutiveErrors = 0;
                    } catch (Throwable parseErr) {
                        consecutiveErrors++;
                    }
                } else {
                    consecutiveErrors++;
                }
                if (consecutiveErrors > 20) break;
                if (consecutiveErrors > 0 && System.currentTimeMillis() - lastPing > 5000) {
                    try {
                        out.write(": ping\n\n".getBytes("UTF-8"));
                        out.flush();
                    } catch (IOException ignored) {
                        break;
                    }
                    lastPing = System.currentTimeMillis();
                }
            }
        } catch (Throwable ignored) {
        } finally {
            authority.disconnect(code, token);
            try {
                out.flush();
            } catch (IOException ignored) {
            }
        }
    }

    private static void writeSse(OutputStream out, String type, String data, long seq) throws IOException {
        out.write(("id: " + seq + "\nevent: " + type + "\ndata: " + data + "\n\n").getBytes("UTF-8"));
        out.flush();
    }

    private void writeApiResult(Socket socket, String res) throws IOException {
        JSONObject root;
        try {
            root = new JSONObject(res);
        } catch (Throwable e) {
            writeJson(socket, 500, "{\"ok\":false,\"error\":{\"code\":\"INTERNAL\",\"message\":\"authority response parse\"}}");
            return;
        }
        int status = root.optInt("status", 500);
        JSONObject body = root.optJSONObject("body");
        writeJson(socket, status, body != null ? body.toString() : "{\"ok\":false}");
    }

    private void writeJson(Socket socket, int status, String body) throws IOException {
        byte[] bytes = body.getBytes("UTF-8");
        String reason = status == 200 ? "OK" : (status == 401 ? "Unauthorized" : (status == 404 ? "Not Found" : "Error"));
        OutputStream out = socket.getOutputStream();
        String header = "HTTP/1.1 " + status + " " + reason + "\r\n"
                + "Content-Type: application/json; charset=utf-8\r\n"
                + "Content-Length: " + bytes.length + "\r\n"
                + "Cache-Control: no-store\r\n"
                + "Access-Control-Allow-Origin: *\r\n"
                + "Connection: close\r\n"
                + "\r\n";
        out.write(header.getBytes("UTF-8"));
        out.write(bytes);
        out.flush();
    }

    private void serveStatic(Socket socket, Request req) throws IOException {
        String path = req.path;
        if (path.equals("/") || path.length() == 0) path = "/index.html";
        try {
            path = URLDecoder.decode(path, "UTF-8");
        } catch (Throwable ignored) {
        }
        while (path.startsWith("/")) path = path.substring(1);
        if (path.contains("..")) {
            writeJson(socket, 403, "{\"ok\":false,\"error\":{\"code\":\"FORBIDDEN\"}}");
            return;
        }
        InputStream is;
        try {
            is = assets.open(path);
        } catch (IOException e) {
            writeJson(socket, 404, "{\"ok\":false,\"error\":{\"code\":\"NOT_FOUND\",\"message\":\"Not Found\"}}");
            return;
        }
        byte[] data = readAll(is);
        is.close();
        String mime = mimeOf(path);
        OutputStream out = socket.getOutputStream();
        boolean head = "HEAD".equals(req.method);
        String header = "HTTP/1.1 200 OK\r\n"
                + "Content-Type: " + mime + "\r\n"
                + "Content-Length: " + data.length + "\r\n"
                + "Cache-Control: no-cache\r\n"
                + "Connection: close\r\n"
                + "\r\n";
        out.write(header.getBytes("UTF-8"));
        if (!head) out.write(data);
        out.flush();
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream(Math.max(1024, in.available()));
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
        return out.toByteArray();
    }

    private static Map<String, String> parseQuery(String query) {
        Map<String, String> out = new HashMap<String, String>();
        if (query == null || query.length() == 0) return out;
        String[] parts = query.split("&");
        for (String part : parts) {
            int eq = part.indexOf('=');
            try {
                if (eq < 0) out.put(URLDecoder.decode(part, "UTF-8"), "");
                else out.put(URLDecoder.decode(part.substring(0, eq), "UTF-8"), URLDecoder.decode(part.substring(eq + 1), "UTF-8"));
            } catch (Throwable ignored) {
            }
        }
        return out;
    }

    private static String mimeOf(String path) {
        String p = path.toLowerCase(Locale.ROOT);
        if (p.endsWith(".html") || p.endsWith(".htm")) return "text/html; charset=utf-8";
        if (p.endsWith(".js")) return "application/javascript; charset=utf-8";
        if (p.endsWith(".css")) return "text/css; charset=utf-8";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".mp3")) return "audio/mpeg";
        if (p.endsWith(".ogg")) return "audio/ogg";
        if (p.endsWith(".wav")) return "audio/wav";
        if (p.endsWith(".json")) return "application/json; charset=utf-8";
        return "application/octet-stream";
    }
}
