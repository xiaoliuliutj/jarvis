package com.jarvis.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.widget.Toast;

/** PackageInstaller 的安装结果回调。 */
public class InstallResultReceiver extends BroadcastReceiver {

    public static final String ACTION_INSTALL_RESULT = "com.jarvis.app.INSTALL_RESULT";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);

        // 普通 App 通过 PackageInstaller 安装时，系统会先返回“等待用户确认”，
        // 必须把 EXTRA_INTENT 拉起来，不能当成失败。
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirm != null) {
                confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                try {
                    context.startActivity(confirm);
                } catch (Exception e) {
                    Toast.makeText(context, "无法打开系统安装器：" + e.getMessage(), Toast.LENGTH_LONG).show();
                }
            }
            return;
        }

        if (status == PackageInstaller.STATUS_SUCCESS) {
            Toast.makeText(context, "Jarvis 更新已开始安装", Toast.LENGTH_SHORT).show();
            return;
        }
        String message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
        Toast.makeText(context, "安装失败(" + status + ")：" +
                (message == null ? "请到系统设置允许 Jarvis 安装未知应用后重试" : message),
                Toast.LENGTH_LONG).show();
    }
}
