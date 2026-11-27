package com.jarvis.app;

import android.Manifest;
import android.animation.ObjectAnimator;
import android.app.Activity;
import android.app.DownloadManager;
import android.app.PendingIntent;
import android.content.ComponentName;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.PorterDuff;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.animation.DecelerateInterpolator;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;

/**
 * Jarvis 安卓 Demo 壳：负责服务器地址/令牌配置 + WebView 承载移动端聊天页。
 * 正式的聊天 UI 在 app/web（由 Bridge 的 app adapter 托管）。
 */
public class MainActivity extends Activity {

    private static final int REQ_FILE = 1001;
    private static final int REQ_NOTIFY = 1002;
    private static final int REQ_LOCATION = 1003;
    private static final int REQ_SMS = 1004;

    private SharedPreferences prefs;
    private LinearLayout setupPanel;
    private WebView webView;
    private EditText urlInput;
    private ValueCallback<Uri[]> fileCallback;
    private FrameLayout splashView;
    private ObjectAnimator splashPulse;
    private final Handler uiHandler = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("jarvis", MODE_PRIVATE);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#123b2f"));

        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setBackgroundColor(Color.parseColor("#f7f5ef"));

        setupPanel = buildSetupPanel();
        setupPanel.setVisibility(View.GONE);
        content.addView(setupPanel, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        webView = buildWebView();
        LinearLayout.LayoutParams webParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0);
        webParams.weight = 1;
        content.addView(webView, webParams);

        root.addView(content, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        splashView = buildSplash();
        root.addView(splashView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        setContentView(root);

        if (hasConfig()) {
            loadWeb(false);
        } else {
            showSetup("");
            uiHandler.postDelayed(this::hideSplash, 450);
        }

        requestNotificationPermissionIfNeeded();
        requestLocationPermissionIfNeeded();
        requestSmsPermissionIfNeeded();
    }

    @Override
    protected void onResume() {
        super.onResume();
        NotifyService.setAppVisible(this, true);
    }

    @Override
    protected void onPause() {
        NotifyService.setAppVisible(this, false);
        super.onPause();
    }

    @Override
    protected void onStop() {
        NotifyService.setAppVisible(this, false);
        super.onStop();
    }

    @Override
    protected void onDestroy() {
        NotifyService.setAppVisible(this, false);
        super.onDestroy();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        NotifyService.setAppVisible(this, true);
    }

    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
            startNotifyIfEnabled();
            return;
        }
        requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFY);
    }

    private void startNotifyIfEnabled() {
        if (NotifyService.isEnabled(this) && NotifyService.hasPermission(this)) {
            NotifyService.start(this);
        }
    }

    private void requestLocationPermissionIfNeeded() {
        if (LocationHelper.hasPermission(this)) return;
        requestPermissions(new String[]{
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION,
        }, REQ_LOCATION);
    }

    private void requestSmsPermissionIfNeeded() {
        if (SmsHelper.hasPermission(this)) return;
        requestPermissions(new String[]{Manifest.permission.READ_SMS}, REQ_SMS);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_LOCATION) {
            boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            Toast.makeText(this, granted ? "定位权限已开启" : "未允许定位，Jarvis 无法获取手机位置",
                    Toast.LENGTH_SHORT).show();
            return;
        }
        if (requestCode == REQ_SMS) {
            boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            Toast.makeText(this, granted ? "短信读取权限已开启" : "未允许短信权限，Jarvis 无法读取短信",
                    Toast.LENGTH_SHORT).show();
            return;
        }
        if (requestCode != REQ_NOTIFY) return;
        boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        if (granted) {
            startNotifyIfEnabled();
            Toast.makeText(this, "系统通知已开启", Toast.LENGTH_SHORT).show();
        } else {
            Toast.makeText(this, "未允许通知，Jarvis 无法在后台提醒你", Toast.LENGTH_SHORT).show();
        }
    }

    private FrameLayout buildSplash() {
        FrameLayout splash = new FrameLayout(this);
        splash.setBackgroundColor(Color.parseColor("#123b2f"));
        splash.setClickable(true);

        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        // 内容整体略高于屏幕正中，避免 logo 贴在顶部。
        box.setPadding(0, 0, 0, dp(96));
        splash.addView(box, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        ImageView logo = new ImageView(this);
        logo.setImageResource(R.drawable.icon);
        LinearLayout.LayoutParams logoParams = new LinearLayout.LayoutParams(dp(96), dp(96));
        logoParams.gravity = Gravity.CENTER_HORIZONTAL;
        logo.setAlpha(0f);
        logo.setScaleX(0.82f);
        logo.setScaleY(0.82f);
        box.addView(logo, logoParams);

        TextView title = new TextView(this);
        title.setText("Jarvis");
        title.setTextColor(Color.parseColor("#f2efe4"));
        title.setTextSize(30);
        title.setGravity(Gravity.CENTER);
        title.setLetterSpacing(0.08f);
        title.setAlpha(0f);
        title.setTranslationY(dp(8));
        LinearLayout.LayoutParams titleParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        titleParams.topMargin = dp(18);
        box.addView(title, titleParams);

        TextView subtitle = new TextView(this);
        subtitle.setText("正在唤醒…");
        subtitle.setTextColor(Color.parseColor("#a8b5ae"));
        subtitle.setTextSize(13);
        subtitle.setGravity(Gravity.CENTER);
        subtitle.setAlpha(0f);
        LinearLayout.LayoutParams subtitleParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        subtitleParams.topMargin = dp(10);
        box.addView(subtitle, subtitleParams);

        ProgressBar progress = new ProgressBar(this, null, android.R.attr.progressBarStyleSmall);
        if (progress.getIndeterminateDrawable() != null) {
            progress.getIndeterminateDrawable().setColorFilter(
                    Color.parseColor("#f2efe4"), PorterDuff.Mode.SRC_IN);
        }
        progress.setAlpha(0f);
        LinearLayout.LayoutParams progressParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        progressParams.gravity = Gravity.CENTER_HORIZONTAL;
        progressParams.topMargin = dp(22);
        box.addView(progress, progressParams);

        logo.animate()
                .alpha(1f)
                .scaleX(1f)
                .scaleY(1f)
                .setStartDelay(40)
                .setDuration(300)
                .setInterpolator(new DecelerateInterpolator())
                .start();
        title.animate()
                .alpha(1f)
                .translationY(0)
                .setStartDelay(120)
                .setDuration(280)
                .start();
        subtitle.animate()
                .alpha(1f)
                .setStartDelay(200)
                .setDuration(260)
                .start();
        progress.animate()
                .alpha(1f)
                .setStartDelay(280)
                .setDuration(240)
                .start();

        splashPulse = ObjectAnimator.ofFloat(logo, "alpha", 1f, 0.55f, 1f);
        splashPulse.setDuration(1600);
        splashPulse.setStartDelay(420);
        splashPulse.setRepeatCount(ObjectAnimator.INFINITE);
        splashPulse.start();

        return splash;
    }

    private void hideSplash() {
        if (splashView == null || splashView.getVisibility() != View.VISIBLE) return;
        if (splashPulse != null) {
            splashPulse.cancel();
            splashPulse = null;
        }
        splashView.animate()
                .alpha(0f)
                .setDuration(200)
                .withEndAction(() -> {
                    if (splashView != null) splashView.setVisibility(View.GONE);
                })
                .start();
    }

    private LinearLayout buildSetupPanel() {
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setBackgroundColor(Color.parseColor("#ffffff"));
        panel.setPadding(dp(18), dp(14), dp(18), dp(16));

        TextView hint = new TextView(this);
        hint.setText("手机先连上 Tailscale，再填入电脑端 Bridge 的 App 地址；登录在网页里完成。");
        hint.setTextSize(13);
        hint.setTextColor(Color.parseColor("#6f7a73"));
        panel.addView(hint);

        urlInput = addInput(panel, "服务器地址", "http://100.100.142.113:17779", InputType.TYPE_TEXT_VARIATION_URI);

        Button save = new Button(this);
        save.setText("保存并连接");
        save.setAllCaps(false);
        save.setTextColor(Color.WHITE);
        save.setBackgroundColor(Color.parseColor("#123b2f"));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.topMargin = dp(6);
        panel.addView(save, params);
        save.setOnClickListener(v -> saveConfig());

        return panel;
    }

    private EditText addInput(LinearLayout parent, String label, String hint, int inputType) {
        TextView tv = new TextView(this);
        tv.setText(label);
        tv.setTextSize(13);
        tv.setTextColor(Color.parseColor("#6f7a73"));
        LinearLayout.LayoutParams labelParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        labelParams.topMargin = dp(10);
        parent.addView(tv, labelParams);

        EditText input = new EditText(this);
        input.setHint(hint);
        input.setTextSize(15);
        input.setInputType(inputType);
        input.setSingleLine(true);
        parent.addView(input, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return input;
    }

    private WebView buildWebView() {
        WebView view = new WebView(this);
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);

        view.addJavascriptInterface(new NotifyBridge(), "JarvisNative");

        view.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView v, String url) {
                super.onPageFinished(v, url);
                // 数据加载由页面通过 JarvisNative.pageReady() 通知；这里只做超时兜底。
                uiHandler.postDelayed(MainActivity.this::hideSplash, 2500);
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest request, WebResourceError error) {
                super.onReceivedError(v, request, error);
                if (request != null && request.isForMainFrame()) {
                    hideSplash();
                    showSetup("页面加载失败，请检查服务器地址或网络");
                }
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView v, android.webkit.WebResourceRequest request) {
                Uri uri = request.getUrl();
                String scheme = uri.getScheme() == null ? "" : uri.getScheme();
                if ("http".equals(scheme) || "https".equals(scheme)) {
                    if (isApkUrl(uri.toString(), null)) {
                        downloadAndInstallUpdate(uri.toString(), "");
                        return true;
                    }
                    String base = prefs.getString("url", "");
                    if (!base.isEmpty() && uri.toString().startsWith(base)) {
                        return false; // Jarvis 自身留在应用内
                    }
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, uri));
                    } catch (Exception ignored) {
                    }
                    return true;
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception ignored) {
                }
                return true;
            }
        });

        view.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            if (isApkUrl(url, mimeType)) {
                downloadAndInstallUpdate(url, "");
                return;
            }
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
            } catch (Exception ignored) {
            }
        });

        view.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (fileCallback != null) {
                    fileCallback.onReceiveValue(null);
                }
                fileCallback = callback;
                String[] acceptTypes = params.getAcceptTypes();
                String mimeType = "*/*";
                if (acceptTypes != null) {
                    for (String accept : acceptTypes) {
                        if (accept == null) continue;
                        String first = accept.split(",")[0].trim();
                        if (first.contains("/")) {
                            mimeType = first;
                            break;
                        }
                    }
                }
                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType(mimeType);
                if (params.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) {
                    intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                }
                try {
                    startActivityForResult(Intent.createChooser(intent, "选择文件"), REQ_FILE);
                    return true;
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
            }
        });

        view.setBackgroundColor(Color.parseColor("#f7f5ef"));
        return view;
    }

    private boolean hasConfig() {
        return !prefs.getString("url", "").isEmpty();
    }

    private void showSetup(String error) {
        hideSplash();
        urlInput.setText(prefs.getString("url", "http://100.100.142.113:17779"));
        setupPanel.setVisibility(View.VISIBLE);
        if (error != null && !error.isEmpty()) {
            Toast.makeText(this, error, Toast.LENGTH_SHORT).show();
        }
    }

    private void saveConfig() {
        String url = urlInput.getText().toString().trim().replaceAll("/+$", "");
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            Toast.makeText(this, "地址要以 http:// 或 https:// 开头", Toast.LENGTH_SHORT).show();
            return;
        }
        prefs.edit()
                .putString("url", url)
                .apply();
        setupPanel.setVisibility(View.GONE);
        loadWeb(true);
    }

    private void loadWeb(boolean reset) {
        String base = prefs.getString("url", "").replaceAll("/+$", "");
        if (base.isEmpty()) {
            showSetup("");
            return;
        }
        String target = base + "/" + (reset ? "?reset=1" : "");
        uiHandler.postDelayed(this::hideSplash, 4000);
        webView.loadUrl(target);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_FILE || fileCallback == null) {
            return;
        }
        Uri[] results = null;
        if (resultCode == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                int count = data.getClipData().getItemCount();
                results = new Uri[count];
                for (int i = 0; i < count; i++) {
                    results[i] = data.getClipData().getItemAt(i).getUri();
                }
            } else if (data.getData() != null) {
                results = new Uri[]{data.getData()};
            }
        }
        fileCallback.onReceiveValue(results);
        fileCallback = null;
    }

    private void openInstallPermissionSettings() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        runOnUiThread(() -> {
            try {
                startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + getPackageName())));
            } catch (Exception ignored) {
                try {
                    startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                            Uri.parse("package:" + getPackageName())));
                } catch (Exception ignored2) {
                }
            }
        });
    }

    private boolean isApkUrl(String url, String mimeType) {
        if (mimeType != null && mimeType.contains("android.package-archive")) return true;
        try {
            String path = new URL(url).getPath();
            return path != null && path.toLowerCase().endsWith(".apk");
        } catch (Exception e) {
            return String.valueOf(url).toLowerCase().contains(".apk");
        }
    }

    private void downloadAndInstallUpdate(String targetUrl, String expectedSha256) {
        new Thread(() -> {
            PackageInstaller installer = null;
            int sessionId = -1;
            try {
                URL url = new URL(targetUrl);
                HttpURLConnection connection = (HttpURLConnection) url.openConnection();
                connection.setConnectTimeout(15000);
                connection.setReadTimeout(30000);
                if (connection.getResponseCode() != 200) throw new Exception("下载失败：HTTP " + connection.getResponseCode());

                File apk = new File(getCacheDir(), "jarvis-update.apk");
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                try (InputStream in = connection.getInputStream();
                     FileOutputStream out = new FileOutputStream(apk)) {
                    byte[] buffer = new byte[16 * 1024];
                    int read;
                    while ((read = in.read(buffer)) >= 0) {
                        digest.update(buffer, 0, read);
                        out.write(buffer, 0, read);
                    }
                } finally {
                    connection.disconnect();
                }

                if (!expectedSha256.isEmpty()) {
                    byte[] hash = digest.digest();
                    StringBuilder hex = new StringBuilder();
                    for (byte b : hash) hex.append(String.format("%02x", b));
                    if (!expectedSha256.equalsIgnoreCase(hex.toString())) {
                        throw new Exception("安装包校验失败");
                    }
                }

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                        && !getPackageManager().canRequestPackageInstalls()) {
                    runOnUiThread(() -> {
                        openInstallPermissionSettings();
                        Toast.makeText(this, "请允许 Jarvis 安装未知应用后重试", Toast.LENGTH_LONG).show();
                    });
                    return;
                }

                installer = getPackageManager().getPackageInstaller();
                PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(
                        PackageInstaller.SessionParams.MODE_FULL_INSTALL);
                params.setAppPackageName(getPackageName());
                sessionId = installer.createSession(params);
                Intent resultIntent = new Intent(this, InstallResultReceiver.class)
                        .setAction(InstallResultReceiver.ACTION_INSTALL_RESULT)
                        .setPackage(getPackageName());
                int flags = PendingIntent.FLAG_UPDATE_CURRENT;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    // PackageInstaller 需要在回调 Intent 里写入 EXTRA_STATUS / EXTRA_INTENT。
                    // IMMUTABLE 会把这些 extras 丢掉，结果被误判成安装权限失败。
                    flags |= PendingIntent.FLAG_MUTABLE;
                } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    flags |= PendingIntent.FLAG_IMMUTABLE;
                }
                PendingIntent resultPending = PendingIntent.getBroadcast(this, 11, resultIntent, flags);

                PackageInstaller.Session session = installer.openSession(sessionId);
                try {
                    try (FileInputStream in = new FileInputStream(apk);
                         OutputStream out = session.openWrite("jarvis-update.apk", 0, apk.length())) {
                        byte[] buffer = new byte[16 * 1024];
                        int read;
                        while ((read = in.read(buffer)) >= 0) out.write(buffer, 0, read);
                        session.fsync(out);
                    }
                    session.commit(resultPending.getIntentSender());
                } finally {
                    session.close();
                }
                runOnUiThread(() -> Toast.makeText(this, "正在安装更新…", Toast.LENGTH_SHORT).show());
            } catch (Exception e) {
                if (installer != null && sessionId >= 0) {
                    try { installer.abandonSession(sessionId); } catch (Exception ignored) {}
                }
                String message = e.getMessage() == null ? "更新失败" : e.getMessage();
                runOnUiThread(() -> Toast.makeText(this, "更新失败：" + message, Toast.LENGTH_LONG).show());
            }
        }, "jarvis-updater").start();
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    /**
     * 网页只通过这个桥配置后台通知；令牌留在应用私有 SharedPreferences，
     * 不写日志、不暴露给其他网页。
     */
    private class NotifyBridge {
        @JavascriptInterface
        public boolean isSupported() {
            return true;
        }

        @JavascriptInterface
        public void pageReady() {
            runOnUiThread(MainActivity.this::hideSplash);
        }

        @JavascriptInterface
        public String getVersionName() {
            try {
                return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface
        public boolean installUpdate(String url, String sha256) {
            if (url == null) return false;
            String target = url.trim();
            if (!target.startsWith("http://") && !target.startsWith("https://")) return false;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                    && !getPackageManager().canRequestPackageInstalls()) {
                runOnUiThread(() -> {
                    openInstallPermissionSettings();
                    Toast.makeText(MainActivity.this, "请先允许 Jarvis 安装未知应用", Toast.LENGTH_LONG).show();
                });
                return false;
            }
            downloadAndInstallUpdate(target, sha256 == null ? "" : sha256.trim());
            return true;
        }

        @JavascriptInterface
        public boolean canInstallPackages() {
            return Build.VERSION.SDK_INT < Build.VERSION_CODES.O
                    || getPackageManager().canRequestPackageInstalls();
        }

        @JavascriptInterface
        public void openInstallPermission() {
            openInstallPermissionSettings();
        }

        @JavascriptInterface
        public boolean openExternal(String url) {
            if (url == null) return false;
            String target = url.trim();
            if (!target.startsWith("http://") && !target.startsWith("https://")) return false;
            runOnUiThread(() -> {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(target)));
                } catch (Exception ignored) {
                }
            });
            return true;
        }

        @JavascriptInterface
        public boolean downloadFile(String url, String fileName) {
            if (url == null) return false;
            String target = url.trim();
            if (!target.startsWith("http://") && !target.startsWith("https://")) return false;
            try {
                String name = sanitizeFileName(fileName);
                DownloadManager.Request request = new DownloadManager.Request(Uri.parse(target));
                request.setTitle(name);
                request.setDescription("Jarvis 文件下载");
                request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
                request.setAllowedOverMetered(true);
                DownloadManager manager = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
                if (manager == null) return false;
                manager.enqueue(request);
                runOnUiThread(() -> Toast.makeText(MainActivity.this, "已开始下载", Toast.LENGTH_SHORT).show());
                return true;
            } catch (Exception e) {
                runOnUiThread(() -> Toast.makeText(MainActivity.this, "下载失败：" + e.getMessage(), Toast.LENGTH_LONG).show());
                return false;
            }
        }

        @JavascriptInterface
        public boolean hasPermission() {
            return NotifyService.hasPermission(MainActivity.this);
        }

        @JavascriptInterface
        public boolean isEnabled() {
            return prefs.getBoolean("notifyEnabled", false);
        }

        @JavascriptInterface
        public boolean isServiceRunning() {
            return NotifyService.isRunning();
        }

        @JavascriptInterface
        public void setChatVisible(boolean visible) {
            NotifyService.setChatVisible(visible);
        }

        @JavascriptInterface
        public boolean testNotification() {
            if (!NotifyService.hasPermission(MainActivity.this)) {
                runOnUiThread(MainActivity.this::requestNotificationPermissionIfNeeded);
                return false;
            }
            return NotifyService.testNotification(MainActivity.this);
        }

        /** 网页回退路径：AI 原生工具调用发现没有后台服务连接时，由前台页面执行。 */
        @JavascriptInterface
        public boolean sendNotification(String title, String body) {
            if (!NotifyService.hasPermission(MainActivity.this)) {
                runOnUiThread(MainActivity.this::requestNotificationPermissionIfNeeded);
                return false;
            }
            return NotifyService.sendCustomNotification(MainActivity.this, title, body);
        }

        /** 网页前台通道：调用系统时钟新建闹钟（链路 A）。 */
        @JavascriptInterface
        public String setAlarm(int hour, int minute, String label, boolean vibrate) {
            return AlarmHelper.set(MainActivity.this, hour, minute, label, vibrate);
        }

        /** 网页前台通道：闹钟入口探针（排查 ColorOS 时钟不响应静默设置）。 */
        @JavascriptInterface
        public String probeAlarm() {
            return AlarmHelper.probe(MainActivity.this);
        }

        /** 网页前台通道：是否已获得定位权限。 */
        @JavascriptInterface
        public boolean hasLocationPermission() {
            return LocationHelper.hasPermission(MainActivity.this);
        }

        /** 网页前台通道：获取手机位置（fresh=true 时尝试一次实时刷新）。 */
        @JavascriptInterface
        public String getLocationText(boolean fresh) {
            return LocationHelper.getLocationText(MainActivity.this, fresh);
        }

        /** 网页前台通道：请求定位权限。 */
        @JavascriptInterface
        public void requestLocationPermission() {
            runOnUiThread(MainActivity.this::requestLocationPermissionIfNeeded);
        }

        /** 网页前台通道：是否已获得短信读取权限。 */
        @JavascriptInterface
        public boolean hasSmsPermission() {
            return SmsHelper.hasPermission(MainActivity.this);
        }

        /** 网页前台通道：列出最近短信。 */
        @JavascriptInterface
        public String listSms(int limit, String folder) {
            return SmsHelper.list(MainActivity.this, limit, folder);
        }

        /** 网页前台通道：搜索短信。 */
        @JavascriptInterface
        public String searchSms(String keyword, int limit) {
            return SmsHelper.search(MainActivity.this, keyword, limit);
        }

        /** 网页前台通道：读取单条短信详情。 */
        @JavascriptInterface
        public String readSms(long id) {
            return SmsHelper.read(MainActivity.this, id);
        }

        /** 网页前台通道：请求短信读取权限。 */
        @JavascriptInterface
        public void requestSmsPermission() {
            runOnUiThread(MainActivity.this::requestSmsPermissionIfNeeded);
        }

        /** 网页前台通道：用指定组件尝试新建闹钟。 */
        @JavascriptInterface
        public String tryAlarmComponent(String component, String customAction, int hour, int minute, String label,
                                        boolean vibrate, boolean skipUi, String skipUiMode) {
            return AlarmHelper.tryAlarmComponent(MainActivity.this, component, customAction,
                    hour, minute, label, vibrate, skipUi, skipUiMode);
        }

        /** 网页前台通道：读取时钟包自定义权限的保护级别。 */
        @JavascriptInterface
        public String inspectClockPermissions() {
            return ClockManifestReader.inspectPermissions(MainActivity.this);
        }

        /** 网页前台通道：列出时钟包所有组件的导出状态和权限要求。 */
        @JavascriptInterface
        public String inspectClockComponents() {
            return ClockManifestReader.inspectComponents(MainActivity.this);
        }

        /** 网页前台通道：查询任意权限的保护级别。 */
        @JavascriptInterface
        public String clockPermissionInfo(String permission) {
            return ClockManifestReader.permissionInfo(MainActivity.this, permission);
        }

        /** 网页前台通道：查询时钟 provider 的访问限制。 */
        @JavascriptInterface
        public String resolveClockProvider(String authority) {
            return ClockManifestReader.resolveProvider(MainActivity.this, authority);
        }

        /** 网页前台通道：读取当前前台窗口的视图树（调试闹钟自动确认）。 */
        @JavascriptInterface
        public String dumpAlarmUi() {
            return AlarmAutoConfirmService.dumpUi();
        }

        /** 网页前台通道：读取系统时钟 APK 的 manifest 字符串池（寻找私有通道）。 */
        @JavascriptInterface
        public String inspectClockManifest() {
            return ClockManifestReader.inspect(MainActivity.this);
        }

        /** 网页前台通道：查询某个 action 的注册情况。 */
        @JavascriptInterface
        public String queryClockAction(String action) {
            return ClockManifestReader.queryAction(MainActivity.this, action);
        }

        /** 网页前台通道：向系统时钟发送自定义广播。 */
        @JavascriptInterface
        public String sendAlarmBroadcast(String action, int hour, int minute, String label, boolean vibrate) {
            return AlarmHelper.sendAlarmBroadcast(MainActivity.this, action, hour, minute, label, vibrate);
        }

        /** 无障碍自动确认服务是否已开启。 */
        @JavascriptInterface
        public boolean isAlarmAutoConfirmEnabled() {
            return AlarmAutoConfirmService.isEnabled(MainActivity.this);
        }

        /** 打开系统无障碍设置页，方便用户开启 Jarvis 的闹钟自动确认服务。 */
        @JavascriptInterface
        public void openAccessibilitySettings() {
            runOnUiThread(() -> {
                try {
                    startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS));
                } catch (Exception ignored) {
                }
            });
        }

        @JavascriptInterface
        public boolean isIgnoringBatteryOptimizations() {
            try {
                PowerManager manager = (PowerManager) getSystemService(POWER_SERVICE);
                return manager != null && manager.isIgnoringBatteryOptimizations(getPackageName());
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public void openAppSettings() {
            runOnUiThread(() -> {
                try {
                    startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                            Uri.parse("package:" + getPackageName())));
                } catch (Exception ignored) {
                }
            });
        }

        @JavascriptInterface
        public void openBatterySettings() {
            runOnUiThread(() -> {
                try {
                    PowerManager manager = (PowerManager) getSystemService(POWER_SERVICE);
                    boolean ignoring = manager != null && manager.isIgnoringBatteryOptimizations(getPackageName());
                    Intent intent = ignoring
                            ? new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
                            : new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                                    Uri.parse("package:" + getPackageName()));
                    startActivity(intent);
                } catch (Exception ignored) {
                    openAppSettings();
                }
            });
        }

        @JavascriptInterface
        public void openStartupSettings() {
            runOnUiThread(() -> {
                String[][] targets = {
                        {"com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity"},
                        {"com.oppo.safe", "com.oppo.safe.permission.startup.StartupAppListActivity"},
                        {"com.coloros.safecenter", "com.coloros.safecenter.startupapp.StartupAppListActivity"},
                };
                for (String[] target : targets) {
                    try {
                        Intent intent = new Intent();
                        intent.setComponent(new ComponentName(target[0], target[1]));
                        startActivity(intent);
                        return;
                    } catch (Exception ignored) {
                    }
                }
                openAppSettings();
            });
        }

        @JavascriptInterface
        public void openNotificationSettings() {
            runOnUiThread(() -> {
                try {
                    Intent intent;
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                                .putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName());
                    } else {
                        intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                                Uri.parse("package:" + getPackageName()));
                    }
                    startActivity(intent);
                } catch (Exception ignored) {
                    openAppSettings();
                }
            });
        }

        @JavascriptInterface
        public void configure(String url, String token, String device, boolean enabled) {
            if (url == null || token == null) return;
            String cleanUrl = url.trim().replaceAll("/+$", "");
            String cleanToken = token.trim();
            if (!cleanUrl.startsWith("http://") && !cleanUrl.startsWith("https://")) return;
            if (cleanToken.isEmpty()) return;
            String cleanDevice = sanitizeDevice(device);

            String oldUrl = prefs.getString("url", "");
            String oldToken = prefs.getString("token", "");
            String oldDevice = prefs.getString("device", "");
            boolean changed = !cleanUrl.equals(oldUrl)
                    || !cleanToken.equals(oldToken)
                    || !cleanDevice.equals(oldDevice);

            prefs.edit()
                    .putString("url", cleanUrl)
                    .putString("token", cleanToken)
                    .putString("device", cleanDevice)
                    .putBoolean("notifyEnabled", enabled)
                    .commit();

            if (!enabled) {
                NotifyService.clearNotification(MainActivity.this);
                NotifyService.cancelWatchdog(MainActivity.this);
                NotifyService.stop(MainActivity.this);
                return;
            }
            if (!NotifyService.hasPermission(MainActivity.this)) return;
            if (changed) NotifyService.stop(MainActivity.this);
            NotifyService.start(MainActivity.this);
        }

        @JavascriptInterface
        public void setEnabled(boolean enabled) {
            prefs.edit().putBoolean("notifyEnabled", enabled).commit();
            if (!enabled) {
                NotifyService.clearNotification(MainActivity.this);
                NotifyService.cancelWatchdog(MainActivity.this);
                NotifyService.stop(MainActivity.this);
                return;
            }
            if (!NotifyService.hasPermission(MainActivity.this)) {
                requestNotificationPermissionIfNeeded();
                return;
            }
            NotifyService.start(MainActivity.this);
        }

        @JavascriptInterface
        public void requestPermission() {
            runOnUiThread(MainActivity.this::requestNotificationPermissionIfNeeded);
        }

        @JavascriptInterface
        public void clear() {
            NotifyService.clearNotification(MainActivity.this);
        }
    }

    private String sanitizeDevice(String value) {
        String cleaned = String.valueOf(value == null ? "" : value).replaceAll("[^\\w.-]", "");
        if (cleaned.length() > 64) cleaned = cleaned.substring(0, 64);
        return cleaned.isEmpty() ? "owner" : cleaned;
    }

    private String sanitizeFileName(String value) {
        String cleaned = String.valueOf(value == null ? "" : value)
                .replaceAll("[\\\\/:*?\"<>|\\x00-\\x1f]", "_")
                .trim();
        if (cleaned.length() > 120) cleaned = cleaned.substring(0, 120);
        return cleaned.isEmpty() ? "jarvis-file" : cleaned;
    }

    private int dp(int value) {
        return Math.round(getResources().getDisplayMetrics().density * value);
    }
}
