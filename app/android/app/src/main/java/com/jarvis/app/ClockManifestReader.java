package com.jarvis.app;

import android.content.Context;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.PermissionInfo;
import android.content.pm.ProviderInfo;
import android.content.pm.ResolveInfo;
import android.content.pm.ServiceInfo;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * 读取系统时钟 APK 的 AndroidManifest 字符串池，寻找私有 action / 组件线索。
 *
 * 目的：ColorOS 自带语音助手可以静默建闹钟，说明时钟包内存在一条不弹界面的
 * 私有通道（广播 / service / provider）。Android 没有公开 API 能列出某个包的
 * intent-filter，所以这里直接解析 APK 里二进制 AndroidManifest.xml 的字符串池，
 * 把所有疑似 action / provider / 组件名的字符串挑出来。
 */
final class ClockManifestReader {
    static final String CLOCK_PACKAGE = "com.coloros.alarmclock";

    private ClockManifestReader() {}

    static String inspect(Context context) {
        if (context == null) return "error:no_context";
        PackageManager pm = context.getPackageManager();
        String apkPath;
        try {
            ApplicationInfo info = pm.getApplicationInfo(CLOCK_PACKAGE, 0);
            apkPath = info.sourceDir;
        } catch (Exception e) {
            return "error:clock_not_found";
        }
        File apk = new File(apkPath);
        if (!apk.exists() || !apk.canRead()) return "error:apk_not_readable";

        byte[] manifest;
        try {
            manifest = readZipEntry(apkPath, "AndroidManifest.xml");
        } catch (Exception e) {
            return "error:read_failed:" + e.getClass().getSimpleName();
        }
        if (manifest == null || manifest.length == 0) return "error:manifest_missing";

        List<String> strings;
        try {
            strings = parseStringPool(manifest);
        } catch (Exception e) {
            return "error:parse_failed:" + e.getClass().getSimpleName();
        }

        Set<String> candidates = new LinkedHashSet<>();
        for (String s : strings) {
            if (s == null) continue;
            String value = s.trim();
            if (value.length() < 4 || value.length() > 200) continue;
            if (!value.contains(".")) continue;
            String lower = value.toLowerCase();
            if (lower.contains("action") || lower.contains("alarm") || lower.contains("provider")) {
                candidates.add(value);
            }
        }

        StringBuilder sb = new StringBuilder();
        sb.append("apk=").append(apkPath).append(" (").append(apk.length()).append(" bytes)");
        sb.append("\nmanifest=").append(manifest.length).append(" bytes, strings=").append(strings.size());
        sb.append("\n候选 ").append(candidates.size()).append(" 条:");
        for (String candidate : candidates) {
            if (sb.length() > 28000) {
                sb.append("\n...(已截断)");
                break;
            }
            sb.append("\n").append(candidate);
        }
        return sb.toString();
    }

    /** 查询指定 action 的注册情况，并列出具体组件名。 */
    static String queryAction(Context context, String action) {
        if (context == null) return "error:no_context";
        if (action == null || action.trim().isEmpty()) return "error:bad_action";
        String value = action.trim();
        if (value.length() < 4 || value.length() > 200 || !value.contains(".")) return "error:bad_action";
        PackageManager pm = context.getPackageManager();
        try {
            Intent intent = new Intent(value);
            List<ResolveInfo> receivers = pm.queryBroadcastReceivers(intent, 0);
            List<ResolveInfo> services = pm.queryIntentServices(intent, 0);
            List<ResolveInfo> activities = pm.queryIntentActivities(intent, 0);
            StringBuilder sb = new StringBuilder();
            sb.append(value).append(" → recv=").append(receivers.size())
                    .append(" svc=").append(services.size())
                    .append(" act=").append(activities.size());
            appendResolveList(sb, "act", activities);
            appendResolveList(sb, "recv", receivers);
            appendResolveList(sb, "svc", services);
            return sb.toString();
        } catch (Exception e) {
            return "error:query_failed:" + e.getClass().getSimpleName();
        }
    }

    private static void appendResolveList(StringBuilder sb, String tag, List<ResolveInfo> list) {
        if (list == null) return;
        for (ResolveInfo info : list) {
            if (info == null) continue;
            if (info.activityInfo != null) {
                sb.append("\n  ").append(tag).append(": ")
                        .append(info.activityInfo.packageName).append("/").append(info.activityInfo.name);
            } else if (info.serviceInfo != null) {
                sb.append("\n  ").append(tag).append(": ")
                        .append(info.serviceInfo.packageName).append("/").append(info.serviceInfo.name);
            }
        }
    }

    /** 列出时钟包所有组件的导出状态和权限要求（含权限保护级别）。 */
    static String inspectComponents(Context context) {
        if (context == null) return "error:no_context";
        PackageManager pm = context.getPackageManager();
        try {
            PackageInfo info = pm.getPackageInfo(CLOCK_PACKAGE,
                    PackageManager.GET_ACTIVITIES
                            | PackageManager.GET_SERVICES
                            | PackageManager.GET_RECEIVERS
                            | PackageManager.GET_PROVIDERS);
            StringBuilder sb = new StringBuilder();
            sb.append(CLOCK_PACKAGE).append(" 组件清单:");
            if (info.activities != null) {
                for (ActivityInfo activity : info.activities) {
                    if (truncate(sb)) return sb.toString();
                    sb.append("\nact ").append(activity.name);
                    appendComponentPerm(sb, pm, activity.exported, activity.permission);
                }
            }
            if (info.services != null) {
                for (ServiceInfo service : info.services) {
                    if (truncate(sb)) return sb.toString();
                    sb.append("\nsvc ").append(service.name);
                    appendComponentPerm(sb, pm, service.exported, service.permission);
                }
            }
            if (info.receivers != null) {
                for (ActivityInfo receiver : info.receivers) {
                    if (truncate(sb)) return sb.toString();
                    sb.append("\nrcv ").append(receiver.name);
                    appendComponentPerm(sb, pm, receiver.exported, receiver.permission);
                }
            }
            if (info.providers != null) {
                for (ProviderInfo provider : info.providers) {
                    if (truncate(sb)) return sb.toString();
                    sb.append("\nprv ").append(provider.name).append(" authority=").append(provider.authority);
                    appendComponentPerm(sb, pm, provider.exported, provider.readPermission);
                    if (provider.writePermission != null
                            && !provider.writePermission.equals(provider.readPermission)) {
                        sb.append(" write=").append(provider.writePermission);
                    }
                }
            }
            return sb.toString();
        } catch (Exception e) {
            return "error:inspect_failed:" + e.getClass().getSimpleName();
        }
    }

    private static boolean truncate(StringBuilder sb) {
        if (sb.length() <= 26000) return false;
        sb.append("\n...(已截断)");
        return true;
    }

    private static void appendComponentPerm(StringBuilder sb, PackageManager pm, boolean exported, String permission) {
        if (!exported) sb.append(" [internal]");
        if (permission == null || permission.isEmpty()) return;
        sb.append(" perm=").append(permission);
        try {
            PermissionInfo pi = pm.getPermissionInfo(permission, 0);
            sb.append("(level=").append(pi.protectionLevel).append(")");
        } catch (Exception e) {
            sb.append("(?)");
        }
    }

    /** 查询任意权限的保护级别（0=normal，1=dangerous，2=signature，18=signature|privileged）。 */
    static String permissionInfo(Context context, String permission) {
        if (context == null) return "error:no_context";
        if (permission == null || permission.trim().isEmpty()) return "error:bad_permission";
        String value = permission.trim();
        PackageManager pm = context.getPackageManager();
        try {
            PermissionInfo pi = pm.getPermissionInfo(value, 0);
            return value + " level=" + pi.protectionLevel + " definedBy=" + pi.packageName;
        } catch (Exception e) {
            return value + " → 未找到（可能未安装定义者）";
        }
    }

    /** 列出时钟包自定义权限及保护级别（2 = signature，普通 app 拿不到）。 */
    static String inspectPermissions(Context context) {
        if (context == null) return "error:no_context";
        PackageManager pm = context.getPackageManager();
        try {
            PackageInfo info = pm.getPackageInfo(CLOCK_PACKAGE, PackageManager.GET_PERMISSIONS);
            StringBuilder sb = new StringBuilder();
            sb.append(CLOCK_PACKAGE).append(" 自定义权限:");
            if (info.permissions == null || info.permissions.length == 0) {
                sb.append(" (无)");
            } else {
                for (PermissionInfo permission : info.permissions) {
                    sb.append("\n  ").append(permission.name)
                            .append(" level=").append(permission.protectionLevel);
                }
            }
            if (info.requestedPermissions != null) {
                int count = 0;
                sb.append("\n申请的 com.coloros/com.oplus 权限:");
                for (String perm : info.requestedPermissions) {
                    if (perm == null) continue;
                    if (!perm.startsWith("com.coloros") && !perm.startsWith("com.oplus")) continue;
                    sb.append("\n  ").append(perm);
                    if (++count >= 60) {
                        sb.append("\n  ...(已截断)");
                        break;
                    }
                }
            }
            return sb.toString();
        } catch (Exception e) {
            return "error:inspect_failed:" + e.getClass().getSimpleName();
        }
    }

    /** 查询 provider 的导出状态和访问权限，并尝试只读 query。 */
    static String resolveProvider(Context context, String authority) {
        if (context == null) return "error:no_context";
        if (authority == null || authority.trim().isEmpty()) return "error:bad_authority";
        String value = authority.trim();
        PackageManager pm = context.getPackageManager();
        try {
            ProviderInfo info = pm.resolveContentProvider(value, 0);
            if (info == null) return value + " → 未找到（不可见或不存在）";
            StringBuilder sb = new StringBuilder();
            sb.append(value).append(" → ").append(info.packageName).append("/").append(info.name)
                    .append(" exported=").append(info.exported);
            if (info.readPermission != null) sb.append(" read=").append(info.readPermission);
            if (info.writePermission != null) sb.append(" write=").append(info.writePermission);
            try {
                android.database.Cursor cursor = context.getContentResolver()
                        .query(android.net.Uri.parse("content://" + value), null, null, null, null);
                if (cursor == null) {
                    sb.append("\n  query → null");
                } else {
                    sb.append("\n  query → columns=").append(cursor.getColumnCount())
                            .append(" rows=").append(cursor.getCount());
                    cursor.close();
                }
            } catch (Exception e) {
                sb.append("\n  query 失败: ").append(e.getClass().getSimpleName());
            }
            return sb.toString();
        } catch (Exception e) {
            return "error:resolve_failed:" + e.getClass().getSimpleName();
        }
    }

    private static byte[] readZipEntry(String apkPath, String name) throws Exception {
        ZipFile zip = new ZipFile(apkPath);
        try {
            ZipEntry entry = zip.getEntry(name);
            if (entry == null) return null;
            InputStream in = zip.getInputStream(entry);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[16384];
            int n;
            while ((n = in.read(buffer)) > 0) out.write(buffer, 0, n);
            in.close();
            return out.toByteArray();
        } finally {
            zip.close();
        }
    }

    private static List<String> parseStringPool(byte[] data) {
        List<String> result = new ArrayList<>();
        if (data.length < 16) return result;
        int offset = 8; // 跳过 XML 文件头（ResChunk_header）
        while (offset + 8 <= data.length) {
            int type = readU16(data, offset);
            int headerSize = readU16(data, offset + 2);
            int size = (int) readU32(data, offset + 4);
            if (size <= 0 || offset + size > data.length) break;
            if (type == 0x0001) { // RES_STRING_POOL_TYPE
                parseStringChunk(data, offset, headerSize, result);
                break;
            }
            offset += size;
        }
        return result;
    }

    private static void parseStringChunk(byte[] data, int chunkStart, int headerSize, List<String> out) {
        int stringCount = (int) readU32(data, chunkStart + 8);
        int flags = (int) readU32(data, chunkStart + 16);
        boolean utf8 = (flags & 0x100) != 0; // UTF8_FLAG
        int stringsStart = (int) readU32(data, chunkStart + 20);
        int tableStart = chunkStart + headerSize;
        int dataStart = chunkStart + stringsStart;
        for (int i = 0; i < stringCount; i++) {
            int strOffset = (int) readU32(data, tableStart + i * 4);
            int pos = dataStart + strOffset;
            try {
                String value = utf8 ? readUtf8String(data, pos) : readUtf16String(data, pos);
                out.add(value == null ? "" : value);
            } catch (Exception e) {
                out.add("");
            }
        }
    }

    private static String readUtf8String(byte[] data, int pos) {
        // 字符数（1-2 字节变长）
        int len = data[pos] & 0xFF;
        pos++;
        if ((len & 0x80) != 0) {
            len = ((len & 0x7F) << 8) | (data[pos] & 0xFF);
            pos++;
        }
        // 字节数（1-2 字节变长）
        int byteLen = data[pos] & 0xFF;
        pos++;
        if ((byteLen & 0x80) != 0) {
            byteLen = ((byteLen & 0x7F) << 8) | (data[pos] & 0xFF);
            pos++;
        }
        if (byteLen <= 0 || pos + byteLen > data.length) return "";
        return new String(data, pos, byteLen, StandardCharsets.UTF_8);
    }

    private static String readUtf16String(byte[] data, int pos) {
        int len = readU16(data, pos);
        pos += 2;
        if ((len & 0x8000) != 0) {
            len = ((len & 0x7FFF) << 16) | readU16(data, pos);
            pos += 2;
        }
        int byteLen = len * 2;
        if (byteLen <= 0 || pos + byteLen > data.length) return "";
        return new String(data, pos, byteLen, StandardCharsets.UTF_16LE);
    }

    private static int readU16(byte[] data, int offset) {
        if (offset + 2 > data.length) return 0;
        return (data[offset] & 0xFF) | ((data[offset + 1] & 0xFF) << 8);
    }

    private static long readU32(byte[] data, int offset) {
        if (offset + 4 > data.length) return 0;
        return (data[offset] & 0xFFL)
                | ((data[offset + 1] & 0xFFL) << 8)
                | ((data[offset + 2] & 0xFFL) << 16)
                | ((data[offset + 3] & 0xFFL) << 24);
    }
}
