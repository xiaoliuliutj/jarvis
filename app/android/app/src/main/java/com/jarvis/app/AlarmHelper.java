package com.jarvis.app;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.ProviderInfo;
import android.content.pm.ResolveInfo;
import android.provider.AlarmClock;

import java.util.List;

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

    private static final String[] CLOCK_PACKAGES = {
            "com.coloros.alarmclock",
            "com.oppo.alarmclock",
            "com.oneplus.deskclock",
            "com.android.deskclock",
            "com.google.android.deskclock",
    };

    private AlarmHelper() {}

    static String set(Context context, int hour, int minute, String label, boolean vibrate) {
        if (context == null) return "error:no_context";
        if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return "error:invalid_time";

        // 若用户已启用无障碍自动确认，在界面弹出时自动点「保存」。
        AlarmAutoConfirmService.armAutoConfirm();

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
        String resolvedBy = null;
        try {
            ResolveInfo resolved = pm.resolveActivity(intent, PackageManager.MATCH_DEFAULT_ONLY);
            if (resolved != null && resolved.activityInfo != null) {
                resolvedBy = resolved.activityInfo.packageName + "/" + resolved.activityInfo.name;
            }
        } catch (Exception ignored) {
        }

        // 标准入口：声明 SET_ALARM 权限后，ColorOS 会路由到 cts.HandleApiActivity 真正新建闹钟。
        if (tryStart(context, intent)) {
            return markAndReturn(prefs, signature, now, resolvedBy == null ? "implicit" : resolvedBy);
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

    /**
     * 调试探针：列出能响应 SET_ALARM / SHOW_ALARMS 的组件，以及各时钟包内部的 Activity 清单。
     * 用于确认为什么 ColorOS 时钟接住了 Intent 却只打开界面。
     */
    static String probe(Context context) {
        if (context == null) return "error:no_context";
        PackageManager pm = context.getPackageManager();
        StringBuilder sb = new StringBuilder();

        appendResolutions(pm, sb, "SET_ALARM", new Intent(AlarmClock.ACTION_SET_ALARM));
        appendResolutions(pm, sb, "SHOW_ALARMS", new Intent(AlarmClock.ACTION_SHOW_ALARMS));

        for (String pkg : CLOCK_PACKAGES) {
            try {
                PackageInfo info = pm.getPackageInfo(pkg,
                        PackageManager.GET_ACTIVITIES
                                | PackageManager.GET_PROVIDERS
                                | PackageManager.GET_RECEIVERS);
                ActivityInfo[] activities = info.activities;
                sb.append("\n").append(pkg)
                        .append(": versionName=").append(info.versionName)
                        .append(" activities=").append(activities == null ? 0 : activities.length);
                if (activities != null) {
                    for (ActivityInfo activity : activities) {
                        sb.append("\n  ").append(activity.name);
                        if (!activity.exported) sb.append(" [internal]");
                    }
                }
                if (info.providers != null) {
                    for (ProviderInfo provider : info.providers) {
                        sb.append("\n  provider ").append(provider.name)
                                .append(" authority=").append(provider.authority)
                                .append(provider.exported ? "" : " [internal]");
                    }
                }
                if (info.receivers != null) {
                    for (ActivityInfo receiver : info.receivers) {
                        sb.append("\n  receiver ").append(receiver.name)
                                .append(receiver.exported ? "" : " [internal]");
                    }
                }
            } catch (PackageManager.NameNotFoundException e) {
                sb.append("\n").append(pkg).append(": not installed");
            } catch (Exception e) {
                sb.append("\n").append(pkg).append(": query failed ").append(e.getClass().getSimpleName());
            }
        }
        String result = sb.toString().trim();
        return result.isEmpty() ? "ok:empty" : result;
    }

    private static void appendResolutions(PackageManager pm, StringBuilder sb, String tag, Intent intent) {
        sb.append(tag).append(" resolvers:");
        try {
            List<ResolveInfo> list = pm.queryIntentActivities(
                    intent, PackageManager.MATCH_DEFAULT_ONLY | PackageManager.MATCH_ALL);
            if (list == null || list.isEmpty()) {
                sb.append(" none\n");
                return;
            }
            for (ResolveInfo info : list) {
                ActivityInfo ai = info.activityInfo;
                sb.append("\n  ").append(ai.packageName).append("/").append(ai.name);
                if (!ai.exported) sb.append(" [internal]");
            }
        } catch (Exception e) {
            sb.append(" query failed ").append(e.getClass().getSimpleName());
        }
        sb.append("\n");
    }

    /** 调试用：用指定组件直接尝试新建闹钟，跳过 resolve，便于逐个试时钟包里的候选入口。 */
    static String tryAlarmComponent(Context context, String component, String customAction, int hour, int minute,
                                    String label, boolean vibrate, boolean skipUi, String skipUiMode) {
        if (context == null) return "error:no_context";
        if (component == null || !component.contains("/")) return "error:bad_component";
        String pkg = component.substring(0, component.indexOf('/'));
        if (!isClockPackage(pkg)) return "error:not_clock_package";
        if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return "error:invalid_time";

        String action = customAction == null ? "" : customAction.trim();
        if (!action.isEmpty()) {
            String lower = action.toLowerCase();
            boolean allowed = lower.startsWith("com.coloros")
                    || lower.startsWith("com.oplus")
                    || lower.startsWith("com.android")
                    || lower.startsWith("oppo.")
                    || lower.startsWith("android.intent.action");
            if (!allowed || action.length() > 200 || !action.contains(".")) return "error:action_not_allowed";
        }

        String cleanLabel = String.valueOf(label == null ? "" : label).trim();
        if (cleanLabel.length() > 80) cleanLabel = cleanLabel.substring(0, 80);
        if (cleanLabel.isEmpty()) cleanLabel = "Jarvis 闹钟";

        ComponentName target = ComponentName.unflattenFromString(component);
        if (target == null) return "error:bad_component";

        AlarmAutoConfirmService.armAutoConfirm();

        Intent intent = new Intent(action.isEmpty() ? AlarmClock.ACTION_SET_ALARM : action);
        intent.putExtra(AlarmClock.EXTRA_HOUR, hour);
        intent.putExtra(AlarmClock.EXTRA_MINUTES, minute);
        intent.putExtra(AlarmClock.EXTRA_MESSAGE, cleanLabel);
        // 有些厂商实现用 getStringExtra / getIntExtra 读 SKIP_UI，支持三种传法便于排查。
        if ("string".equals(skipUiMode)) {
            intent.putExtra(AlarmClock.EXTRA_SKIP_UI, skipUi ? "true" : "false");
        } else if ("int".equals(skipUiMode)) {
            intent.putExtra(AlarmClock.EXTRA_SKIP_UI, skipUi ? 1 : 0);
        } else {
            intent.putExtra(AlarmClock.EXTRA_SKIP_UI, skipUi);
        }
        intent.putExtra(AlarmClock.EXTRA_VIBRATE, vibrate);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        intent.setComponent(target);
        try {
            context.startActivity(intent);
            return "ok:" + component;
        } catch (Exception e) {
            String msg = e.getMessage() == null ? e.getClass().getSimpleName()
                    : e.getClass().getSimpleName() + ": " + e.getMessage();
            return "error:" + msg;
        }
    }

    /** 调试用：向系统时钟发送自定义广播（带标准闹钟 extras），验证私有静默通道。 */
    static String sendAlarmBroadcast(Context context, String action, int hour, int minute,
                                     String label, boolean vibrate) {
        if (context == null) return "error:no_context";
        if (action == null) return "error:bad_action";
        String act = action.trim();
        String lower = act.toLowerCase();
        boolean allowed = lower.startsWith("com.coloros")
                || lower.startsWith("com.oplus")
                || lower.startsWith("com.android")
                || lower.startsWith("oppo.")
                || lower.startsWith("android.intent.action");
        if (!allowed || act.length() > 200 || !act.contains(".")) return "error:action_not_allowed";
        if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return "error:invalid_time";

        String cleanLabel = String.valueOf(label == null ? "" : label).trim();
        if (cleanLabel.length() > 80) cleanLabel = cleanLabel.substring(0, 80);
        if (cleanLabel.isEmpty()) cleanLabel = "Jarvis 闹钟";

        Intent intent = new Intent(act);
        intent.setPackage(ClockManifestReader.CLOCK_PACKAGE);
        intent.putExtra(AlarmClock.EXTRA_HOUR, hour);
        intent.putExtra(AlarmClock.EXTRA_MINUTES, minute);
        intent.putExtra(AlarmClock.EXTRA_MESSAGE, cleanLabel);
        intent.putExtra(AlarmClock.EXTRA_SKIP_UI, true);
        intent.putExtra(AlarmClock.EXTRA_VIBRATE, vibrate);
        try {
            context.sendBroadcast(intent);
            return "ok:" + act;
        } catch (Exception e) {
            return "error:broadcast_failed:" + e.getClass().getSimpleName();
        }
    }

    private static boolean isClockPackage(String pkg) {
        if (pkg == null) return false;
        for (String p : CLOCK_PACKAGES) {
            if (p.equals(pkg)) return true;
        }
        return false;
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
