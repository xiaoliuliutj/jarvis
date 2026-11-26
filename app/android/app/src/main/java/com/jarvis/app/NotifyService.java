package com.jarvis.app;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.List;

import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * 后台通知服务：保持一条到 Bridge 的 WebSocket，收到 Jarvis 消息时发系统通知。
 *
 * 说明：
 * - Android 8+ 必须使用前台服务才能长期保活，因此会有一条低优先级常驻通知；
 * - 网页在前台时由 App 自己展示消息，本服务不重复通知；
 * - 不依赖 FCM/Google 服务，直接走 Tailscale 上的 Bridge。
 */
public class NotifyService extends Service {

    public static final String ACTION_START = "com.jarvis.app.NOTIFY_START";
    public static final String ACTION_STOP = "com.jarvis.app.NOTIFY_STOP";

    private static final String CHANNEL_MESSAGES = "jarvis_messages";
    private static final String CHANNEL_SERVICE = "jarvis_service";
    private static final int SERVICE_NOTIFICATION_ID = 43001;
    private static final int MESSAGE_NOTIFICATION_ID = 43002;
    private static final int TEST_NOTIFICATION_ID = 43003;
    private static final int WATCHDOG_REQUEST = 43004;
    private static final int CUSTOM_NOTIFICATION_ID = 43005;
    private static final long WATCHDOG_INTERVAL = 15 * 60 * 1000L;
    private static final int MAX_HISTORY = 8;

    private static volatile boolean appVisible = false;
    private static volatile boolean chatVisible = false;
    private static volatile boolean serviceRunning = false;
    private static final List<NotifItem> history = new ArrayList<>();

    private volatile boolean running = false;
    private volatile Socket socket = null;
    private static volatile OutputStream wsOut = null;
    private Thread worker = null;
    private SharedPreferences prefs;

    private static final SecureRandom RANDOM = new SecureRandom();

    private static class NotifItem {
        final String text;
        final long time;

        NotifItem(String text, long time) {
            this.text = text;
            this.time = time;
        }
    }

    public static void start(Context context) {
        try {
            Intent intent = new Intent(context, NotifyService.class);
            intent.setAction(ACTION_START);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
        } catch (Exception ignored) {
        }
    }

    public static void stop(Context context) {
        try {
            context.stopService(new Intent(context, NotifyService.class));
        } catch (Exception ignored) {
        }
    }

    public static boolean isEnabled(Context context) {
        try {
            return context.getSharedPreferences("jarvis", Context.MODE_PRIVATE)
                    .getBoolean("notifyEnabled", false);
        } catch (Exception e) {
            return false;
        }
    }

    public static boolean hasPermission(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true;
        return context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
    }

    /** 网页前台时调用：清掉通知历史和通知栏消息。 */
    public static void setAppVisible(Context context, boolean visible) {
        appVisible = visible;
        if (visible) clearNotification(context);
    }

    /** 只有“App 在前台且正停留在会话页”时才抑制通知；在外层设置/工具页仍然提醒。 */
    public static void setChatVisible(boolean visible) {
        chatVisible = visible;
    }

    public static boolean isRunning() {
        return serviceRunning;
    }

    private void scheduleWatchdog() {
        try {
            AlarmManager manager = (AlarmManager) getSystemService(ALARM_SERVICE);
            if (manager == null) return;
            Intent intent = new Intent(this, BootReceiver.class).setAction(BootReceiver.ACTION_WATCHDOG);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
            PendingIntent pending = PendingIntent.getBroadcast(this, WATCHDOG_REQUEST, intent, flags);
            manager.setInexactRepeating(
                    AlarmManager.ELAPSED_REALTIME_WAKEUP,
                    SystemClock.elapsedRealtime() + WATCHDOG_INTERVAL,
                    WATCHDOG_INTERVAL,
                    pending);
        } catch (Exception ignored) {
        }
    }

    public static void cancelWatchdog(Context context) {
        try {
            AlarmManager manager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
            if (manager == null) return;
            Intent intent = new Intent(context, BootReceiver.class).setAction(BootReceiver.ACTION_WATCHDOG);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
            PendingIntent pending = PendingIntent.getBroadcast(context, WATCHDOG_REQUEST, intent, flags);
            manager.cancel(pending);
            pending.cancel();
        } catch (Exception ignored) {
        }
    }

    public static void clearNotification(Context context) {
        synchronized (history) {
            history.clear();
        }
        try {
            NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager != null) manager.cancel(MESSAGE_NOTIFICATION_ID);
        } catch (Exception ignored) {
        }
    }

    /** 设置页的“发送测试通知”，用来单独确认权限和通知通道是否正常。 */
    public static boolean testNotification(Context context) {
        if (!hasPermission(context)) return false;
        ensureChannels(context);
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(context, CHANNEL_MESSAGES)
                : new Notification.Builder(context);
        builder.setSmallIcon(R.drawable.ic_notification)
                .setContentTitle("Jarvis 测试通知")
                .setContentText("系统通知正常，Jarvis 可以提醒你了")
                .setContentIntent(openAppIntent(context))
                .setAutoCancel(true)
                .setCategory(Notification.CATEGORY_MESSAGE)
                .setPriority(Notification.PRIORITY_HIGH);
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            builder.setDefaults(Notification.DEFAULT_ALL);
        }
        try {
            NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager == null) return false;
            manager.notify(TEST_NOTIFICATION_ID, builder.build());
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /** 原生通知工具：发送一条任意 title/body 的系统通知。 */
    public static boolean sendCustomNotification(Context context, String title, String body) {
        if (!hasPermission(context)) return false;
        String safeBody = body == null ? "" : body.trim();
        if (safeBody.isEmpty()) return false;
        if (safeBody.length() > 500) safeBody = safeBody.substring(0, 500) + "…";
        String safeTitle = title == null ? "" : title.trim();
        if (safeTitle.isEmpty()) safeTitle = "Jarvis";
        if (safeTitle.length() > 80) safeTitle = safeTitle.substring(0, 80) + "…";

        ensureChannels(context);
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(context, CHANNEL_MESSAGES)
                : new Notification.Builder(context);
        builder.setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(safeTitle)
                .setContentText(safeBody)
                .setContentIntent(openAppIntent(context))
                .setAutoCancel(true)
                .setCategory(Notification.CATEGORY_MESSAGE)
                .setPriority(Notification.PRIORITY_HIGH);
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            builder.setDefaults(Notification.DEFAULT_ALL);
        }
        try {
            NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager == null) return false;
            manager.notify(CUSTOM_NOTIFICATION_ID, builder.build());
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        prefs = getSharedPreferences("jarvis", MODE_PRIVATE);
        serviceRunning = true;
        ensureChannels(this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            cancelWatchdog(this);
            stopWorker();
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }

        // startForegroundService() 要求 5 秒内进入前台；即使随后发现配置已关闭，
        // 也先满足这个约束，再干净地停止。
        try {
            startAsForeground();
        } catch (Exception e) {
            stopSelf();
            return START_NOT_STICKY;
        }

        if (!isEnabled(this) || !hasConfig() || !hasPermission(this)) {
            cancelWatchdog(this);
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }

        scheduleWatchdog();
        startWorker();
        return START_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        if (isEnabled(this) && hasPermission(this)) {
            start(this);
        }
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        serviceRunning = false;
        stopWorker();
        try {
            stopForeground(true);
        } catch (Exception ignored) {
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private boolean hasConfig() {
        String url = prefs == null ? "" : prefs.getString("url", "");
        String token = prefs == null ? "" : prefs.getString("token", "");
        return url != null && !url.isEmpty() && token != null && !token.isEmpty();
    }

    private static void ensureChannels(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;

        NotificationChannel messages = new NotificationChannel(
                CHANNEL_MESSAGES, "Jarvis 消息", NotificationManager.IMPORTANCE_HIGH);
        messages.setDescription("Jarvis 新消息、提醒和文件通知");
        messages.enableVibration(true);
        messages.setShowBadge(true);
        manager.createNotificationChannel(messages);

        NotificationChannel service = new NotificationChannel(
                CHANNEL_SERVICE, "Jarvis 后台连接", NotificationManager.IMPORTANCE_MIN);
        service.setDescription("保持与 Jarvis 的连接，以便在后台接收消息");
        service.setShowBadge(false);
        service.setSound(null, null);
        manager.createNotificationChannel(service);
    }

    private void startAsForeground() {
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_SERVICE)
                : new Notification.Builder(this);
        builder.setContentTitle("Jarvis")
                .setContentText("后台通知已开启")
                .setSmallIcon(R.drawable.ic_notification)
                .setOngoing(true)
                .setShowWhen(false)
                .setContentIntent(openAppIntent(this))
                .setPriority(Notification.PRIORITY_MIN);
        Notification notification = builder.build();

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(SERVICE_NOTIFICATION_ID, notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(SERVICE_NOTIFICATION_ID, notification);
        }
    }

    /**
     * 用 HTTP sync 补拉上次之后的新消息；WebSocket 重连丢失的提示由这里兜底。
     * notify=false 时只推进游标，不重复弹通知。
     */
    private synchronized void syncMissed(boolean notify) {
        HttpURLConnection connection = null;
        try {
            String base = prefs.getString("url", "").trim().replaceAll("/+$", "");
            String token = prefs.getString("token", "");
            String device = prefs.getString("device", "owner");
            if (base.isEmpty() || token.isEmpty()) return;

            String sessionId = prefs.getString("syncSessionId", "");
            long cursor = prefs.getLong("syncCursor", -1L);
            long after = cursor < 0 ? 0 : cursor;
            String endpoint = base + "/api/v1/sync?after=" + after + "&limit=100"
                    + "&device=" + URLEncoder.encode(device, "UTF-8");
            URL url = new URL(endpoint);
            connection = (HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(10000);
            connection.setReadTimeout(15000);
            connection.setRequestProperty("Authorization", "Bearer " + token);
            connection.setRequestProperty("Accept", "application/json");
            if (connection.getResponseCode() != 200) return;

            StringBuilder body = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(connection.getInputStream(), "UTF-8"))) {
                String line;
                while ((line = reader.readLine()) != null) body.append(line);
            }
            if (body.length() == 0) return;
            JSONObject data = new JSONObject(body.toString());
            String currentSession = data.optString("sessionId", "");
            long lastSeq = data.optLong("lastSeq", 0);
            long readCursor = data.optLong("readCursor", 0);
            if (currentSession.isEmpty()) return;

            // 第一次运行/切换会话：只记录到最新，不把历史 2000 多条全部弹出来。
            if (sessionId.isEmpty() || !sessionId.equals(currentSession) || cursor < 0) {
                prefs.edit()
                        .putString("syncSessionId", currentSession)
                        .putLong("syncCursor", lastSeq)
                        .apply();
                return;
            }

            JSONArray messages = data.optJSONArray("messages");
            if (notify && messages != null) {
                for (int i = 0; i < messages.length(); i++) {
                    JSONObject msg = messages.optJSONObject(i);
                    if (msg == null) continue;
                    if (!"bot".equals(msg.optString("role"))) continue;
                    long seq = msg.optLong("seq", -1);
                    if (readCursor > 0 && seq >= 0 && seq < readCursor) continue;
                    String text = msg.optString("text", "").trim();
                    if (!text.isEmpty()) notifyText(text);
                }
            }
            long newCursor = data.optLong("cursor", after);
            prefs.edit().putLong("syncCursor", newCursor).apply();
        } catch (Exception ignored) {
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private void startWorker() {
        if (running) return;
        running = true;
        worker = new Thread(() -> {
            int backoff = 3000;
            while (running) {
                try {
                    String url = prefs.getString("url", "");
                    String token = prefs.getString("token", "");
                    String device = prefs.getString("device", "owner");
                    if (url.isEmpty() || token.isEmpty()) break;
                    backoff = 3000;
                    connectAndRead(url, token, device);
                } catch (Exception ignored) {
                    // 网络切换、服务端重启或 App 被切后台都很常见，静默重连。
                }
                if (!running) break;
                try {
                    Thread.sleep(backoff);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                }
                backoff = Math.min(backoff * 2, 30000);
            }
            running = false;
        }, "jarvis-notify-ws");
        worker.setDaemon(true);
        worker.start();
    }

    private void stopWorker() {
        running = false;
        closeSocket();
        Thread current = worker;
        worker = null;
        if (current != null && current != Thread.currentThread()) {
            current.interrupt();
        }
    }

    private void closeSocket() {
        Socket current = socket;
        socket = null;
        if (current != null) {
            try { current.close(); } catch (Exception ignored) {}
        }
    }

    private void connectAndRead(String baseUrl, String token, String device) throws Exception {
        String base = baseUrl.trim().replaceAll("/+$", "");
        URI uri = URI.create(base);
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase();
        boolean tls = scheme.equals("https") || scheme.equals("wss");
        if (!tls && !scheme.equals("http") && !scheme.equals("ws")) {
            throw new IOException("unsupported scheme");
        }
        String host = uri.getHost();
        if (host == null || host.isEmpty()) throw new IOException("missing host");
        int port = uri.getPort();
        if (port <= 0) port = tls ? 443 : 80;
        String path = uri.getPath();
        if (path == null || path.isEmpty()) path = "/";
        if (path.endsWith("/")) path = path.substring(0, path.length() - 1);
        path = path + "/ws";
        String query = "token=" + URLEncoder.encode(token, "UTF-8")
                + "&device=" + URLEncoder.encode(device == null ? "owner" : device, "UTF-8");

        Socket raw = tls
                ? SSLSocketFactory.getDefault().createSocket()
                : new Socket();
        raw.connect(new InetSocketAddress(host, port), 15000);
        raw.setSoTimeout(90000);
        if (tls) {
            SSLSocket ssl = (SSLSocket) raw;
            ssl.startHandshake();
        }
        socket = raw;

        try {
            InputStream in = new BufferedInputStream(raw.getInputStream());
            OutputStream out = raw.getOutputStream();
            wsOut = out;

            byte[] nonce = new byte[16];
            RANDOM.nextBytes(nonce);
            String key = Base64.encodeToString(nonce, Base64.NO_WRAP);
            String hostHeader = host + (port == (tls ? 443 : 80) ? "" : ":" + port);
            String request = "GET " + path + "?" + query + " HTTP/1.1\r\n"
                    + "Host: " + hostHeader + "\r\n"
                    + "Upgrade: websocket\r\n"
                    + "Connection: Upgrade\r\n"
                    + "Sec-WebSocket-Key: " + key + "\r\n"
                    + "Sec-WebSocket-Version: 13\r\n"
                    + "User-Agent: JarvisAndroid/0.2.7\r\n"
                    + "\r\n";
            out.write(request.getBytes(StandardCharsets.UTF_8));
            out.flush();

            String status = readHttpHeaders(in);
            if (!status.contains(" 101 ")) {
                throw new IOException("websocket handshake failed");
            }

            // 连接恢复后先补拉；第一轮只记录游标，不会把全部旧消息弹出来。
            try { syncMissed(true); } catch (Exception ignored) {}

            ByteArrayOutputStream textBuffer = new ByteArrayOutputStream();
            while (running) {
                int b0;
                try {
                    b0 = in.read();
                } catch (SocketTimeoutException timeout) {
                    // 服务端每 25 秒 ping 一次；长时间没有数据说明连接已失效。
                    throw new IOException("websocket idle timeout");
                }
                if (b0 < 0) throw new EOFException();
                int b1 = in.read();
                if (b1 < 0) throw new EOFException();

                boolean fin = (b0 & 0x80) != 0;
                int opcode = b0 & 0x0f;
                boolean masked = (b1 & 0x80) != 0;
                long length = b1 & 0x7f;
                if (length == 126) {
                    length = ((in.read() & 0xff) << 8) | (in.read() & 0xff);
                } else if (length == 127) {
                    length = 0;
                    for (int i = 0; i < 8; i++) {
                        length = (length << 8) | (in.read() & 0xff);
                    }
                }
                if (length < 0 || length > 10 * 1024 * 1024) {
                    throw new IOException("frame too large");
                }

                byte[] mask = null;
                if (masked) {
                    mask = new byte[4];
                    readFully(in, mask);
                }
                byte[] payload = new byte[(int) length];
                readFully(in, payload);
                if (mask != null) {
                    for (int i = 0; i < payload.length; i++) {
                        payload[i] ^= mask[i % 4];
                    }
                }

                if (opcode == 0x8) {
                    sendFrame(out, 0x8, payload);
                    return;
                }
                if (opcode == 0x9) {
                    sendFrame(out, 0xA, payload);
                    continue;
                }
                if (opcode == 0xA) {
                    continue;
                }
                if (opcode == 0x1 || opcode == 0x0) {
                    textBuffer.write(payload);
                    if (fin) {
                        String json = new String(textBuffer.toByteArray(), StandardCharsets.UTF_8);
                        textBuffer.reset();
                        handleMessage(json);
                    }
                }
            }
        } finally {
            wsOut = null;
            closeSocket();
        }
    }

    private static void sendJson(String json) {
        OutputStream out = wsOut;
        if (out == null || json == null) return;
        try {
            sendFrame(out, 0x1, json.getBytes(StandardCharsets.UTF_8));
        } catch (Exception ignored) {
        }
    }

    private void handleMessage(String json) {
        try {
            JSONObject object = new JSONObject(json);
            String type = object.optString("type");
            if ("assistant".equals(type)) {
                String text = object.optString("text", "").trim();
                if (!text.isEmpty()) notifyText(text);
                // WS 已经送达的消息推进 sync 游标，避免下次重连重复通知。
                try { syncMissed(false); } catch (Exception ignored) {}
                return;
            }
            if ("file".equals(type)) {
                String name = object.optString("fileName", "文件");
                String kind = object.optString("kind", "file");
                boolean isImage = object.optBoolean("isImage", false);
                String text;
                if (isImage || "image".equals(kind)) text = "发来了一张图片：" + name;
                else if ("video".equals(kind)) text = "发来了一段视频：" + name;
                else if ("audio".equals(kind)) text = "发来了一段语音：" + name;
                else text = "发来了一个文件：" + name;
                notifyText(text);
                return;
            }
            if ("notice".equals(type) || "error".equals(type)) {
                String text = object.optString("text", "").trim();
                if (!text.isEmpty() && !text.contains("Owner 权限已启用")) notifyText(text);
                return;
            }
            if ("native_tool_call".equals(type)) {
                handleNativeToolCall(object);
            }
        } catch (Exception ignored) {
        }
    }

    /** Bridge -> 手机原生工具调用；当前只实现了系统通知。 */
    private void handleNativeToolCall(JSONObject object) {
        String requestId = object == null ? "" : object.optString("requestId", "");
        String tool = object == null ? "" : object.optString("tool", "");
        JSONObject args = object == null ? null : object.optJSONObject("args");
        boolean ok = false;
        String error = null;
        String outcome = null;
        String resultText = null;

        if ("android_notification".equals(tool)) {
            String title = args == null ? "Jarvis" : args.optString("title", "Jarvis");
            String body = args == null ? "" : args.optString("body", "");
            ok = sendCustomNotification(this, title, body);
            if (!ok) error = hasPermission(this) ? "通知发送失败" : "通知权限未开启";
        } else if ("android_alarm".equals(tool)) {
            int hour = args == null ? -1 : args.optInt("hour", -1);
            int minute = args == null ? -1 : args.optInt("minute", -1);
            String label = args == null ? "" : args.optString("label", "");
            boolean vibrate = args == null || args.optBoolean("vibrate", true);
            outcome = AlarmHelper.set(this, hour, minute, label, vibrate);
            ok = AlarmHelper.isSuccess(outcome);
            if (ok) resultText = AlarmHelper.resultText(outcome);
            else error = AlarmHelper.errorText(outcome);
        } else {
            error = "设备端不支持的原生工具：" + tool;
        }

        try {
            JSONObject result = new JSONObject();
            result.put("type", "native_tool_result");
            result.put("requestId", requestId);
            result.put("ok", ok);
            if (ok) {
                JSONObject data = new JSONObject();
                if (resultText != null) data.put("text", resultText);
                else data.put("delivered", true);
                if ("opened".equals(outcome)) data.put("needsConfirmation", true);
                result.put("result", data);
            } else {
                result.put("error", error == null ? "执行失败" : error);
            }
            sendJson(result.toString());
        } catch (Exception ignored) {
        }
    }

    private boolean screenInteractive() {
        try {
            PowerManager manager = (PowerManager) getSystemService(POWER_SERVICE);
            if (manager == null) return true;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT_WATCH) {
                return manager.isInteractive();
            }
            return manager.isScreenOn();
        } catch (Exception e) {
            return true;
        }
    }

    private void notifyText(String text) {
        if (text == null || text.trim().isEmpty()) return;
        // 只有“App 在前台 + 正停在会话页 + 屏幕亮着”才由聊天页展示；
        // 在设置/工具页、切后台、锁屏时都发系统通知。
        if (appVisible && chatVisible && screenInteractive()) return;
        if (!hasPermission(this)) return;

        String body = text.trim();
        if (body.length() > 500) body = body.substring(0, 500) + "…";
        long now = System.currentTimeMillis();
        int count;
        synchronized (history) {
            history.add(new NotifItem(body, now));
            while (history.size() > MAX_HISTORY) history.remove(0);
            count = history.size();
        }

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_MESSAGES)
                : new Notification.Builder(this);

        Notification.MessagingStyle style = new Notification.MessagingStyle("Jarvis");
        style.setConversationTitle("Jarvis");
        synchronized (history) {
            for (NotifItem item : history) {
                style.addMessage(item.text, item.time, "Jarvis");
            }
        }

        builder.setSmallIcon(R.drawable.ic_notification)
                .setContentTitle("Jarvis")
                .setContentText(body)
                .setStyle(style)
                .setContentIntent(openAppIntent(this))
                .setAutoCancel(true)
                .setCategory(Notification.CATEGORY_MESSAGE)
                .setPriority(Notification.PRIORITY_HIGH)
                .setShowWhen(true)
                .setWhen(now)
                .setNumber(count)
                .setOnlyAlertOnce(false);
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            builder.setDefaults(Notification.DEFAULT_ALL);
        }

        try {
            NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (manager != null) manager.notify(MESSAGE_NOTIFICATION_ID, builder.build());
        } catch (Exception ignored) {
        }
    }

    private static PendingIntent openAppIntent(Context context) {
        Intent intent = new Intent(context, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(context, 1, intent, flags);
    }

    private static String readHttpHeaders(InputStream in) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        int state = 0;
        while (true) {
            int b = in.read();
            if (b < 0) throw new EOFException();
            buffer.write(b);
            if (state == 0 && b == '\r') state = 1;
            else if (state == 1 && b == '\n') state = 2;
            else if (state == 2 && b == '\r') state = 3;
            else if (state == 3 && b == '\n') break;
            else state = 0;
            if (buffer.size() > 16 * 1024) throw new IOException("headers too large");
        }
        return buffer.toString("UTF-8");
    }

    private static void readFully(InputStream in, byte[] target) throws IOException {
        int offset = 0;
        while (offset < target.length) {
            int read = in.read(target, offset, target.length - offset);
            if (read < 0) throw new EOFException();
            offset += read;
        }
    }

    private static void sendFrame(OutputStream out, int opcode, byte[] payload) throws IOException {
        byte[] data = payload == null ? new byte[0] : payload;
        int length = data.length;
        byte[] mask = new byte[4];
        RANDOM.nextBytes(mask);

        ByteArrayOutputStream frame = new ByteArrayOutputStream();
        frame.write(0x80 | (opcode & 0x0f));
        if (length < 126) {
            frame.write(0x80 | length);
        } else if (length <= 0xffff) {
            frame.write(0x80 | 126);
            frame.write((length >> 8) & 0xff);
            frame.write(length & 0xff);
        } else {
            frame.write(0x80 | 127);
            for (int i = 7; i >= 0; i--) {
                frame.write((int) (((long) length >> (8 * i)) & 0xff));
            }
        }
        frame.write(mask, 0, 4);
        for (int i = 0; i < length; i++) {
            frame.write(data[i] ^ mask[i % 4]);
        }
        synchronized (out) {
            out.write(frame.toByteArray());
            out.flush();
        }
    }
}
