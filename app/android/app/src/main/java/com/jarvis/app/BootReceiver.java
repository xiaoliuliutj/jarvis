package com.jarvis.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * 开机/升级后拉起通知服务；同时作为 AlarmManager 的保活看门狗。
 * 注意：这不是系统推送，强行停止后仍然无效。
 */
public class BootReceiver extends BroadcastReceiver {

    public static final String ACTION_WATCHDOG = "com.jarvis.app.WATCHDOG";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? null : intent.getAction();
        boolean boot = Intent.ACTION_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)
                || "android.intent.action.QUICKBOOT_POWERON".equals(action);
        boolean watchdog = ACTION_WATCHDOG.equals(action);
        if (!boot && !watchdog) return;

        if (!NotifyService.isEnabled(context) || !NotifyService.hasPermission(context)) {
            if (watchdog) NotifyService.cancelWatchdog(context);
            return;
        }
        NotifyService.start(context);
    }
}
