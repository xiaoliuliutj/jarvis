package com.jarvis.app;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.content.Context;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityManager;
import android.view.accessibility.AccessibilityNodeInfo;

import java.util.List;

/**
 * 闹钟自动确认无障碍服务。
 *
 * ColorOS 时钟的 CTS 适配层（com.oplus.alarmclock.cts.HandleApiActivity）不遵守
 * EXTRA_SKIP_UI，总会弹出预填好的新建界面。本服务只监听系统时钟窗口：
 * 在 Jarvis 刚发起设置闹钟请求后的短时间窗口内，自动点击「保存/确定/完成」按钮，
 * 把「弹界面 + 手动确认」变成「闪一下自动完成」。
 *
 * 隐私：仅监听 com.coloros.alarmclock，不读取、不上传任何其它应用内容。
 */
public class AlarmAutoConfirmService extends AccessibilityService {
    static final String CLOCK_PACKAGE = "com.coloros.alarmclock";
    private static final long PENDING_WINDOW_MS = 20_000L;
    private static final int MAX_DUMP_LENGTH = 14000;

    private static volatile long pendingUntil = 0L;
    private static volatile boolean clickAttempted = false;
    private static volatile AlarmAutoConfirmService instance;

    /** 在 Jarvis 发起设置闹钟后调用，开启自动确认窗口。 */
    static void armAutoConfirm() {
        pendingUntil = System.currentTimeMillis() + PENDING_WINDOW_MS;
        clickAttempted = false;
    }

    static boolean isArmed() {
        return System.currentTimeMillis() < pendingUntil;
    }

    /** 无障碍服务是否已被用户在系统设置里启用。 */
    static boolean isEnabled(Context context) {
        if (context == null) return false;
        try {
            AccessibilityManager manager = (AccessibilityManager)
                    context.getSystemService(Context.ACCESSIBILITY_SERVICE);
            if (manager == null) return false;
            List<AccessibilityServiceInfo> list =
                    manager.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK);
            if (list == null) return false;
            String serviceName = AlarmAutoConfirmService.class.getName();
            String packageName = context.getPackageName();
            for (AccessibilityServiceInfo info : list) {
                if (info == null || info.getResolveInfo() == null || info.getResolveInfo().serviceInfo == null) {
                    continue;
                }
                String pkg = info.getResolveInfo().serviceInfo.packageName;
                String name = info.getResolveInfo().serviceInfo.name;
                if (packageName.equals(pkg) && serviceName.equals(name)) return true;
            }
        } catch (Exception ignored) {
        }
        return false;
    }

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        instance = this;
    }

    @Override
    public void onDestroy() {
        if (instance == this) instance = null;
        super.onDestroy();
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (event == null || clickAttempted || !isArmed()) return;
        CharSequence pkg = event.getPackageName();
        if (pkg == null || !CLOCK_PACKAGE.equals(pkg.toString())) return;
        int type = event.getEventType();
        if (type != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
                && type != AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED) {
            return;
        }
        AccessibilityNodeInfo root;
        try {
            root = getRootInActiveWindow();
        } catch (Exception e) {
            return;
        }
        if (root == null) return;
        AccessibilityNodeInfo button = findConfirmButton(root, 0);
        if (button == null) return;
        clickAttempted = true;
        try {
            button.performAction(AccessibilityNodeInfo.ACTION_CLICK);
            pendingUntil = 0L;
        } catch (Exception ignored) {
        }
    }

    private AccessibilityNodeInfo findConfirmButton(AccessibilityNodeInfo node, int depth) {
        if (node == null || depth > 30) return null;
        try {
            if (node.isClickable()
                    && (matchesConfirm(node.getText()) || matchesConfirm(node.getContentDescription()))) {
                return node;
            }
            int count = node.getChildCount();
            for (int i = 0; i < count; i++) {
                AccessibilityNodeInfo found = findConfirmButton(node.getChild(i), depth + 1);
                if (found != null) return found;
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    private boolean matchesConfirm(CharSequence value) {
        if (value == null) return false;
        String text = value.toString().trim();
        if (text.isEmpty()) return false;
        if (text.equals("保存") || text.equals("确定") || text.equals("完成") || text.equals("好")) return true;
        String lower = text.toLowerCase();
        return lower.equals("ok") || lower.equals("save") || lower.equals("done");
    }

    /** 调试用：把当前前台窗口的视图树转成文本，供 dump_ui 工具查看界面结构。 */
    static String dumpUi() {
        AlarmAutoConfirmService service = instance;
        if (service == null) return "error:accessibility_not_running";
        AccessibilityNodeInfo root;
        try {
            root = service.getRootInActiveWindow();
        } catch (Exception e) {
            return "error:no_window";
        }
        if (root == null) return "error:no_window";
        StringBuilder sb = new StringBuilder();
        appendNode(sb, root, new StringBuilder(), 0);
        return sb.length() == 0 ? "ok:empty" : sb.toString();
    }

    private static void appendNode(StringBuilder sb, AccessibilityNodeInfo node, StringBuilder indent, int depth) {
        if (node == null || depth > 20 || sb.length() > MAX_DUMP_LENGTH) return;
        sb.append(indent).append(node.getClassName());
        CharSequence text = node.getText();
        if (text != null && text.length() > 0) sb.append(" text=\"").append(text).append("\"");
        CharSequence desc = node.getContentDescription();
        if (desc != null && desc.length() > 0) sb.append(" desc=\"").append(desc).append("\"");
        if (node.isClickable()) sb.append(" clickable");
        if (node.isEditable()) sb.append(" editable");
        String id = node.getViewIdResourceName();
        if (id != null) sb.append(" id=").append(id);
        sb.append("\n");
        indent.append("  ");
        int count = node.getChildCount();
        for (int i = 0; i < count; i++) {
            appendNode(sb, node.getChild(i), indent, depth + 1);
        }
        indent.setLength(indent.length() - 2);
    }

    @Override
    public void onInterrupt() {
    }
}
