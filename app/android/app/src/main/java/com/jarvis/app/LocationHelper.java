package com.jarvis.app;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Bundle;
import android.os.Looper;
import android.os.SystemClock;

import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * 手机定位：优先读系统缓存的最后已知位置；fresh=true 时尝试一次实时定位（最多等 8 秒）。
 * 输出格式：lat=.. lon=.. acc=..m src=gps|network|passive age=..s
 */
final class LocationHelper {
    private static final long FRESH_WAIT_MS = 8000L;
    private static final long CACHE_MAX_AGE_MS = 120_000L;

    private LocationHelper() {}

    static boolean hasPermission(Context context) {
        if (context == null) return false;
        if (context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)
                == PackageManager.PERMISSION_GRANTED) {
            return true;
        }
        return context.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION)
                == PackageManager.PERMISSION_GRANTED;
    }

    static String getLocationText(Context context, boolean fresh) {
        if (context == null) return "error:no_context";
        if (!hasPermission(context)) return "error:permission_denied";
        LocationManager manager = (LocationManager) context.getSystemService(Context.LOCATION_SERVICE);
        if (manager == null) return "error:no_location_service";

        Location best = lastKnown(manager);
        if (fresh && (best == null || ageMs(best) > CACHE_MAX_AGE_MS)) {
            Location updated = requestSingle(context, manager);
            if (updated != null) best = updated;
        }
        if (best == null) return "error:no_location";
        return format(best);
    }

    private static Location lastKnown(LocationManager manager) {
        Location best = null;
        String[] providers = {
                LocationManager.GPS_PROVIDER,
                LocationManager.NETWORK_PROVIDER,
                LocationManager.PASSIVE_PROVIDER,
        };
        for (String provider : providers) {
            try {
                Location loc = manager.getLastKnownLocation(provider);
                if (loc == null) continue;
                if (best == null || loc.getTime() > best.getTime()) best = loc;
            } catch (Exception ignored) {
            }
        }
        return best;
    }

    private static Location requestSingle(Context context, LocationManager manager) {
        final CountDownLatch latch = new CountDownLatch(1);
        final Location[] result = new Location[1];
        LocationListener listener = new LocationListener() {
            @Override
            public void onLocationChanged(Location location) {
                result[0] = location;
                latch.countDown();
            }

            @Override
            public void onStatusChanged(String provider, int status, Bundle extras) {
            }

            @Override
            public void onProviderEnabled(String provider) {
            }

            @Override
            public void onProviderDisabled(String provider) {
            }
        };
        try {
            String provider = null;
            if (manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                provider = LocationManager.NETWORK_PROVIDER;
            } else if (manager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                provider = LocationManager.GPS_PROVIDER;
            }
            if (provider == null) return null;
            manager.requestLocationUpdates(provider, 0, 0, listener, Looper.getMainLooper());
            latch.await(FRESH_WAIT_MS, TimeUnit.MILLISECONDS);
        } catch (Exception ignored) {
        } finally {
            try {
                manager.removeUpdates(listener);
            } catch (Exception ignored) {
            }
        }
        return result[0];
    }

    private static long ageMs(Location location) {
        long elapsed = System.currentTimeMillis() - location.getTime();
        if (elapsed < 0) return 0;
        // 同时参考 elapsedRealtime 的单调时钟，避免系统时间校准带来的误判。
        long monotonic = SystemClock.elapsedRealtimeNanos() - location.getElapsedRealtimeNanos();
        long monotonicMs = monotonic / 1_000_000L;
        if (monotonicMs > 0 && monotonicMs < elapsed) return monotonicMs;
        return elapsed;
    }

    private static String format(Location location) {
        long ageSeconds = Math.max(0, ageMs(location)) / 1000L;
        float accuracy = location.hasAccuracy() ? location.getAccuracy() : -1f;
        String accuracyText = accuracy >= 0
                ? String.format(Locale.US, "acc=%.0fm", accuracy)
                : "acc=?";
        return String.format(Locale.US,
                "lat=%.6f lon=%.6f %s src=%s age=%ds",
                location.getLatitude(), location.getLongitude(),
                accuracyText, location.getProvider(), ageSeconds);
    }
}
