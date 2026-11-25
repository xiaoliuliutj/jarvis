package com.jarvis.app;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

/**
 * Jarvis 安卓 Demo 壳：负责服务器地址/令牌配置 + WebView 承载移动端聊天页。
 * 正式的聊天 UI 在 app/web（由 Bridge 的 app adapter 托管）。
 */
public class MainActivity extends Activity {

    private static final int REQ_FILE = 1001;

    private SharedPreferences prefs;
    private LinearLayout toolbar;
    private LinearLayout setupPanel;
    private WebView webView;
    private EditText urlInput;
    private EditText tokenInput;
    private EditText deviceInput;
    private ValueCallback<Uri[]> fileCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("jarvis", MODE_PRIVATE);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.parseColor("#f7f5ef"));

        toolbar = buildToolbar();
        root.addView(toolbar, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        setupPanel = buildSetupPanel();
        setupPanel.setVisibility(View.GONE);
        root.addView(setupPanel, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        webView = buildWebView();
        LinearLayout.LayoutParams webParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0);
        webParams.weight = 1;
        root.addView(webView, webParams);

        setContentView(root);

        if (hasConfig()) {
            loadWeb();
        } else {
            showSetup("");
        }
    }

    private LinearLayout buildToolbar() {
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setBackgroundColor(Color.parseColor("#123b2f"));
        bar.setPadding(dp(16), dp(10), dp(10), dp(10));

        TextView title = new TextView(this);
        title.setText("Jarvis");
        title.setTextColor(Color.parseColor("#f2efe4"));
        title.setTextSize(18);
        title.setTypeface(null, Typeface.BOLD);
        bar.addView(title, new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        Button settings = new Button(this);
        settings.setText("设置");
        settings.setTextColor(Color.parseColor("#f2efe4"));
        settings.setTextSize(14);
        settings.setBackgroundColor(Color.TRANSPARENT);
        settings.setOnClickListener(v -> showSetup(""));
        bar.addView(settings, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        return bar;
    }

    private LinearLayout buildSetupPanel() {
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setBackgroundColor(Color.parseColor("#ffffff"));
        panel.setPadding(dp(18), dp(14), dp(18), dp(16));

        TextView hint = new TextView(this);
        hint.setText("手机先连上 Tailscale，再填入电脑端 Bridge 的 App 地址和访问令牌（token.txt）");
        hint.setTextSize(13);
        hint.setTextColor(Color.parseColor("#6f7a73"));
        panel.addView(hint);

        urlInput = addInput(panel, "服务器地址", "http://100.100.142.113:17779", InputType.TYPE_TEXT_VARIATION_URI);
        tokenInput = addInput(panel, "访问令牌", "userdata/app-adapter/token.txt", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        deviceInput = addInput(panel, "设备标识", "owner", InputType.TYPE_CLASS_TEXT);

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

        view.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView v, String url) {
                super.onPageFinished(v, url);
                // 页面正常加载后隐藏原生工具栏，只保留网页顶部状态栏
                if (toolbar != null) {
                    toolbar.setVisibility(View.GONE);
                }
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView v, android.webkit.WebResourceRequest request) {
                Uri uri = request.getUrl();
                String scheme = uri.getScheme() == null ? "" : uri.getScheme();
                if ("http".equals(scheme) || "https".equals(scheme)) {
                    return false; // 留在应用内
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception ignored) {
                }
                return true;
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
        return !prefs.getString("url", "").isEmpty() && !prefs.getString("token", "").isEmpty();
    }

    private void showSetup(String error) {
        urlInput.setText(prefs.getString("url", "http://100.100.142.113:17779"));
        tokenInput.setText(prefs.getString("token", ""));
        deviceInput.setText(prefs.getString("device", "owner"));
        setupPanel.setVisibility(View.VISIBLE);
        if (error != null && !error.isEmpty()) {
            Toast.makeText(this, error, Toast.LENGTH_SHORT).show();
        }
    }

    private void saveConfig() {
        String url = urlInput.getText().toString().trim().replaceAll("/+$", "");
        String token = tokenInput.getText().toString().trim();
        String device = deviceInput.getText().toString().trim();
        if (device.isEmpty()) {
            device = "owner";
        }
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            Toast.makeText(this, "地址要以 http:// 或 https:// 开头", Toast.LENGTH_SHORT).show();
            return;
        }
        if (token.isEmpty()) {
            Toast.makeText(this, "请填写访问令牌", Toast.LENGTH_SHORT).show();
            return;
        }
        prefs.edit()
                .putString("url", url)
                .putString("token", token)
                .putString("device", device)
                .apply();
        setupPanel.setVisibility(View.GONE);
        loadWeb();
    }

    private void loadWeb() {
        String base = prefs.getString("url", "").replaceAll("/+$", "");
        String token = prefs.getString("token", "");
        String device = prefs.getString("device", "owner");
        if (base.isEmpty() || token.isEmpty()) {
            showSetup("");
            return;
        }
        String target = base + "/?token=" + Uri.encode(token) + "&device=" + Uri.encode(device);
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

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    private int dp(int value) {
        return Math.round(getResources().getDisplayMetrics().density * value);
    }
}
