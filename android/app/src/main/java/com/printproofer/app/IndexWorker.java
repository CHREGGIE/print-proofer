package com.printproofer.app;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.annotation.NonNull;
import androidx.core.content.ContextCompat;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

/** Runs about once an hour (when the battery isn't low) to index new screenshots. */
public class IndexWorker extends Worker {

    public IndexWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        String perm = Build.VERSION.SDK_INT >= 33 ? Manifest.permission.READ_MEDIA_IMAGES : Manifest.permission.READ_EXTERNAL_STORAGE;
        if (ContextCompat.checkSelfPermission(getApplicationContext(), perm) != PackageManager.PERMISSION_GRANTED) {
            return Result.success();
        }
        try {
            ScreenshotIndex.get(getApplicationContext()).index(150, null);
            return Result.success();
        } catch (Exception e) {
            return Result.retry();
        }
    }
}
