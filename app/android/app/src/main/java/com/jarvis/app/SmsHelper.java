package com.jarvis.app;

import android.Manifest;
import android.content.ContentUris;
import android.content.Context;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.provider.Telephony;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * 短信读取（只读）：列出最近短信、按关键词搜索、读取单条详情。
 * 需要 READ_SMS 权限；不发送、不修改任何短信。
 */
final class SmsHelper {
    private SmsHelper() {}

    static boolean hasPermission(Context context) {
        if (context == null) return false;
        return context.checkSelfPermission(Manifest.permission.READ_SMS)
                == PackageManager.PERMISSION_GRANTED;
    }

    static String list(Context context, int limit, String folder) {
        if (context == null) return "error:no_context";
        if (!hasPermission(context)) return "error:permission_denied";
        int max = Math.min(Math.max(limit, 1), 50);
        Uri uri;
        if ("sent".equals(folder)) {
            uri = Telephony.Sms.Sent.CONTENT_URI;
        } else if ("all".equals(folder)) {
            uri = Telephony.Sms.CONTENT_URI;
        } else {
            uri = Telephony.Sms.Inbox.CONTENT_URI;
        }
        Cursor cursor = null;
        try {
            cursor = context.getContentResolver().query(uri,
                    new String[]{
                            Telephony.Sms._ID, Telephony.Sms.ADDRESS, Telephony.Sms.BODY,
                            Telephony.Sms.DATE, Telephony.Sms.TYPE, Telephony.Sms.READ,
                    },
                    null, null, Telephony.Sms.DATE + " DESC");
            if (cursor == null) return "error:no_cursor";
            int total = cursor.getCount();
            StringBuilder sb = new StringBuilder();
            sb.append("短信共 ").append(total).append(" 条，最近 ")
                    .append(Math.min(max, total)).append(" 条：");
            int count = 0;
            while (cursor.moveToNext() && count < max) {
                long id = cursor.getLong(0);
                String address = cursor.getString(1);
                String body = cursor.getString(2);
                long date = cursor.getLong(3);
                int type = cursor.getInt(4);
                int read = cursor.getInt(5);
                sb.append("\n- id=").append(id)
                        .append(" | ").append(formatDate(date))
                        .append(" | ").append(type == 1 ? "收" : type == 2 ? "发" : "其他")
                        .append(read == 1 ? "" : " 未读")
                        .append(" | ").append(address == null ? "未知号码" : address)
                        .append(" | ").append(truncate(body, 100));
                count++;
            }
            return sb.toString();
        } catch (Exception e) {
            return "error:query_failed:" + e.getClass().getSimpleName();
        } finally {
            if (cursor != null) cursor.close();
        }
    }

    static String search(Context context, String keyword, int limit) {
        if (context == null) return "error:no_context";
        if (!hasPermission(context)) return "error:permission_denied";
        if (keyword == null || keyword.trim().isEmpty()) return "error:bad_keyword";
        int max = Math.min(Math.max(limit, 1), 30);
        String like = "%" + keyword.trim() + "%";
        Cursor cursor = null;
        try {
            cursor = context.getContentResolver().query(Telephony.Sms.CONTENT_URI,
                    new String[]{
                            Telephony.Sms._ID, Telephony.Sms.ADDRESS, Telephony.Sms.BODY,
                            Telephony.Sms.DATE, Telephony.Sms.TYPE,
                    },
                    Telephony.Sms.BODY + " LIKE ? OR " + Telephony.Sms.ADDRESS + " LIKE ?",
                    new String[]{like, like},
                    Telephony.Sms.DATE + " DESC");
            if (cursor == null) return "error:no_cursor";
            int total = cursor.getCount();
            if (total == 0) return "没有找到包含「" + keyword.trim() + "」的短信";
            StringBuilder sb = new StringBuilder();
            sb.append("匹配 ").append(total).append(" 条，展示最近 ")
                    .append(Math.min(max, total)).append(" 条：");
            int count = 0;
            while (cursor.moveToNext() && count < max) {
                long id = cursor.getLong(0);
                String address = cursor.getString(1);
                String body = cursor.getString(2);
                long date = cursor.getLong(3);
                int type = cursor.getInt(4);
                sb.append("\n- id=").append(id)
                        .append(" | ").append(formatDate(date))
                        .append(" | ").append(type == 1 ? "收" : type == 2 ? "发" : "其他")
                        .append(" | ").append(address == null ? "未知号码" : address)
                        .append(" | ").append(truncate(body, 100));
                count++;
            }
            return sb.toString();
        } catch (Exception e) {
            return "error:query_failed:" + e.getClass().getSimpleName();
        } finally {
            if (cursor != null) cursor.close();
        }
    }

    static String read(Context context, long id) {
        if (context == null) return "error:no_context";
        if (!hasPermission(context)) return "error:permission_denied";
        if (id <= 0) return "error:bad_id";
        Uri uri = ContentUris.withAppendedId(Telephony.Sms.CONTENT_URI, id);
        Cursor cursor = null;
        try {
            cursor = context.getContentResolver().query(uri,
                    new String[]{
                            Telephony.Sms._ID, Telephony.Sms.ADDRESS, Telephony.Sms.BODY,
                            Telephony.Sms.DATE, Telephony.Sms.TYPE, Telephony.Sms.PERSON,
                    },
                    null, null, null);
            if (cursor == null || !cursor.moveToFirst()) return "error:not_found";
            String address = cursor.getString(1);
            String body = cursor.getString(2);
            long date = cursor.getLong(3);
            int type = cursor.getInt(4);
            StringBuilder sb = new StringBuilder();
            sb.append("短信详情：\n");
            sb.append("号码：").append(address == null ? "未知" : address).append("\n");
            sb.append("时间：").append(formatDate(date)).append("\n");
            sb.append("方向：").append(type == 1 ? "接收" : type == 2 ? "发送" : "其他").append("\n");
            sb.append("---\n");
            sb.append(body == null ? "(正文为空)" : body);
            return sb.toString();
        } catch (Exception e) {
            return "error:query_failed:" + e.getClass().getSimpleName();
        } finally {
            if (cursor != null) cursor.close();
        }
    }

    private static String formatDate(long millis) {
        try {
            return new SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.CHINA).format(new Date(millis));
        } catch (Exception e) {
            return String.valueOf(millis);
        }
    }

    private static String truncate(String value, int max) {
        if (value == null) return "";
        String clean = value.replace('\n', ' ').replace('\r', ' ').trim();
        return clean.length() <= max ? clean : clean.substring(0, max) + "…";
    }
}
