package com.jarvis.app;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.provider.AlarmClock;

/**
 * 通过 Android 标准 AlarmClock Intent 让系统时钟创建闹钟。
 *
 * 这里不自己持有闹钟，响铃、贪睡、关机恢复都由系统时钟 App 负责。
 * 返回码：
 *   ok[:包名]  — 已把新建闹钟请求交给系统时钟
 *   opened     — 系统时钟没有可静默设置的入口，已打开闹钟列表
 *   duplicate  — 刚刚设置过完全相同的闹钟，避免 ColorOS 重复创建
 *   error:xxx  — 失败原因
 */
final class AlarmHelper {
    private static final long DUPLICATE_WINDOW_MS = 60_000L;

    private AlarmHelper() {}

    static String set(Context context, int hour, int minute, String label, boolean vibrate) {
        if (context == null) return "error:no_context";
        if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return "error:invalid_time";

        String cleanLabel = String.valueOf(label == null ? "" : label).trim();
        if (cleanLabel.length() > 80) cleanLabel = cleanLabel.substring(0, 80);
        if (cleanLabel.isEmpty()) cleanLabel = "Jarvis 闹钟";

        String signature = hour + ":" + minute + "|" + cleanLabel + "|" + vibrate;
        SharedPreferences prefs = context.getSharedPreferences("jarvis", Context.MODE_PRIVATE);
        long now = System.currentTimeMillis();
        if (signature.equals(prefs.getString("lastAlarmSignature", ""))
                && now - prefs.getLong("lastAlarmAt", 0) < DUPLICATE_WINDOW_MS) {
            return "duplicate";
        }

        Intent intent = buildIntent(hour, minute, cleanLabel, vibrate);
        PackageManager pm = context.getPackageManager();
        ResolveInfo resolved = pm.resolveActivity(intent, PackageManager.MATCH_DEFAULT_ONLY);

        // 先按标准入口启动；即使 resolveActivity 因包可见性返回 null，也直接试一次 startActivity。
        if (resolved != null) {
            String pkg = resolved.activityInfo != null ? resolved.activityInfo.packageName : "";
            if (tryStart(context, intent)) {
                return markAndReturn(prefs, signature, now, pkg);
            }
        }
        if (tryStart(context, intent)) {
            return markAndReturn(prefs, signature, now, "implicit");
        }

        // ColorOS 时钟包：有些版本不会注册标准 Action，显式指定包名再试。
        Intent coloros = new Intent(intent);
        coloros.setPackage("com.coloros.alarmclock");
        if (tryStart(context, coloros)) {
            return markAndReturn(prefs, signature, now, "com.coloros.alarmclock");
        }

        // 再尝试几个已知时钟组件；存在但未导出时会抛异常，直接跳过。
        String[][] candidates = {
                {"com.coloros.alarmclock", "com.coloros.alarmclock.alarmclock.AlarmClockActivity"},
                {"com.coloros.alarmclock", "com.coloros.alarmclock.alarmclock.AlarmSetActivity"},
                {"com.coloros.alarmclock", "com.coloros.alarmclock.alarmclock.AlarmEditActivity"},
                {"com.coloros.alarmclock", "com.coloros.alarmclock.alarmclock.AlarmCycleActivity"},
                {"com.coloros.alarmclock", "com.coloros.alarmclock.AlarmClock"},
                {"com.coloros.alarmclock", "com.coloros.alarmclock.AlarmClockActivity"},
                {"com.coloros.alarmclock", "com.coloros.alarmclock.SetAlarm"},
                {"com.oppo.alarmclock", "com.oppo.alarmclock.AlarmClock"},
                {"com.oneplus.deskclock", "com.android.deskclock.AlarmClock"},
                {"com.android.deskclock", "com.android.deskclock.AlarmClock"},
                {"com.android.deskclock", "com.android.deskclock.activity.AlarmClockActivity"},
                {"com.android.deskclock", "com.android.deskclock.SetAlarm"},
                {"com.google.android.deskclock", "com.android.deskclock.AlarmClock"},
        };
        for (String[] candidate : candidates) {
            Intent explicit = new Intent(intent);
            explicit.setComponent(new ComponentName(candidate[0], candidate[1]));
            if (tryStart(context, explicit)) {
                return markAndReturn(prefs, signature, now, candidate[0] + "/" + candidate[1]);
            }
        }

        // 没有可用的 SET_ALARM 入口：至少把用户带到闹钟界面。
        if (openAlarmList(context)) return "opened";
        return "error:no_alarm_app";
    }

    private static boolean tryStart(Context context, Intent intent) {
        try {
            context.startActivity(intent);
            return true;
        } catch (Exception ignored) {
            return false;
        }
    }

    private static String markAndReturn(SharedPreferences prefs, String signature, long now, String by) {
        prefs.edit()
                .putString("lastAlarmSignature", signature)
                .putLong("lastAlarmAt", now)
                .apply();
        return by == null || by.isEmpty() ? "ok" : "ok:" + by;
    }

    private static Intent buildIntent(int hour, int minute, String label, boolean vibrate) {
        Intent intent = new Intent(AlarmClock.ACTION_SET_ALARM);
        intent.putExtra(AlarmClock.EXTRA_HOUR, hour);
        intent.putExtra(AlarmClock.EXTRA_MINUTES, minute);
        intent.putExtra(AlarmClock.EXTRA_MESSAGE, label);
        intent.putExtra(AlarmClock.EXTRA_SKIP_UI, true);
        intent.putExtra(AlarmClock.EXTRA_VIBRATE, vibrate);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return intent;
    }

    private static boolean openAlarmList(Context context) {
        try {
            Intent show = new Intent(AlarmClock.ACTION_SHOW_ALARMS);
            show.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(show);
            return true;
        } catch (Exception ignored) {
        }
        try {
            PackageManager pm = context.getPackageManager();
            Intent launch = pm.getLaunchIntentForPackage("com.coloros.alarmclock");
            if (launch == null) launch = pm.getLaunchIntentForPackage("com.oppo.alarmclock");
            if (launch == null) launch = pm.getLaunchIntentForPackage("com.oneplus.deskclock");
            if (launch == null) launch = pm.getLaunchIntentForPackage("com.android.deskclock");
            if (launch != null) {
                launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(launch);
                return true;
            }
        } catch (Exception ignored) {
        }
        return false;
    }

    static boolean isSuccess(String outcome) {
        return outcome != null
                && (outcome.startsWith("ok") || "duplicate".equals(outcome) || "opened".equals(outcome));
    }

    static String resultText(String outcome) {
        if (outcome == null) return "闹钟请求已发送";
        if (outcome.startsWith("ok")) return "已交给系统时钟设置闹钟";
        if ("duplicate".equals(outcome)) return "这个闹钟刚刚已经设置过了";
        if ("opened".equals(outcome)) return "系统时钟不支持静默设置，已打开闹钟界面，请确认";
        return "闹钟请求已处理";
    }

    static String errorText(String outcome) {
        if (outcome == null) return "设置闹钟失败";
        if (outcome.startsWith("error:invalid_time")) return "闹钟时间不合法";
        if (outcome.startsWith("error:no_alarm_app")) return "手机上没有找到可用的系统时钟";
        if (outcome.startsWith("error:no_context")) return "缺少 Android 上下文";
        return "设置闹钟失败：" + outcome.replace("error:", "");
    }
}
