package com.printproofer.app;

import android.Manifest;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.provider.MediaStore;

import androidx.annotation.NonNull;
import androidx.core.content.ContextCompat;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import java.util.concurrent.TimeUnit;

/**
 * Indexes new screenshots in the background. Runs hourly as a safety net, and (with auto-proof on)
 * within seconds of a new picture being saved, via a MediaStore content trigger that re-arms itself.
 */
public class IndexWorker extends Worker {
    static final String PERIODIC = "screenshot-index";
    static final String TRIGGER = "screenshot-trigger";
    static final String PREFS = "print-proofer";

    public IndexWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** Hourly indexing on/off. */
    static void schedulePeriodic(Context ctx, boolean on) {
        WorkManager wm = WorkManager.getInstance(ctx);
        if (!on) {
            wm.cancelUniqueWork(PERIODIC);
            return;
        }
        Constraints c = new Constraints.Builder().setRequiresBatteryNotLow(true).build();
        wm.enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP,
            new PeriodicWorkRequest.Builder(IndexWorker.class, 1, TimeUnit.HOURS).setConstraints(c).build());
    }

    /** Run again as soon as a new image is added to the gallery (Android 7+). */
    static void armTrigger(Context ctx) {
        armTrigger(ctx, ExistingWorkPolicy.REPLACE);
    }

    /**
     * From inside a running trigger worker, re-arm with APPEND_OR_REPLACE so the new request queues
     * behind this one instead of cancelling it; from the app, REPLACE so launches never pile up.
     */
    static void armTrigger(Context ctx, ExistingWorkPolicy policy) {
        if (Build.VERSION.SDK_INT < 24 || !prefs(ctx).getBoolean("autoProof", false)) return;
        Constraints c = new Constraints.Builder()
            .addContentUriTrigger(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, true)
            .setTriggerContentUpdateDelay(3, TimeUnit.SECONDS)
            .setTriggerContentMaxDelay(20, TimeUnit.SECONDS)
            .build();
        WorkManager.getInstance(ctx).enqueueUniqueWork(TRIGGER, policy,
            new OneTimeWorkRequest.Builder(IndexWorker.class).setConstraints(c).addTag(TRIGGER).build());
    }

    static void disarmTrigger(Context ctx) {
        WorkManager.getInstance(ctx).cancelUniqueWork(TRIGGER);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context ctx = getApplicationContext();
        boolean fromTrigger = getTags().contains(TRIGGER);
        try {
            String perm = Build.VERSION.SDK_INT >= 33 ? Manifest.permission.READ_MEDIA_IMAGES : Manifest.permission.READ_EXTERNAL_STORAGE;
            if (ContextCompat.checkSelfPermission(ctx, perm) != PackageManager.PERMISSION_GRANTED) return Result.success();
            ScreenshotIndex.Result r = ScreenshotIndex.get(ctx).index(fromTrigger ? 20 : 150, null);
            if (prefs(ctx).getBoolean("autoProof", false)) ProofNotifier.notify(ctx, r.flagged);
            return Result.success();
        } catch (Exception e) {
            return Result.retry();
        } finally {
            if (fromTrigger) armTrigger(ctx, ExistingWorkPolicy.APPEND_OR_REPLACE); // triggers fire once; re-arm for the next picture
        }
    }
}
