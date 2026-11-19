package com.printproofer.app;

import android.Manifest;
import android.content.ContentUris;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import android.util.Base64;

import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

@CapacitorPlugin(
    name = "NativeOcr",
    permissions = {
        @Permission(alias = "mediaImages", strings = { Manifest.permission.READ_MEDIA_IMAGES }),
        @Permission(alias = "storage", strings = { Manifest.permission.READ_EXTERNAL_STORAGE }),
    }
)
public class NativeOcrPlugin extends Plugin {

    private static final String WORK_NAME = "screenshot-index";
    private final ExecutorService ocrPool = Executors.newSingleThreadExecutor();
    private final ExecutorService indexPool = Executors.newSingleThreadExecutor();
    private final List<String> pendingShared = new ArrayList<>();

    private String photoAlias() {
        return Build.VERSION.SDK_INT >= 33 ? "mediaImages" : "storage";
    }

    @Override
    public void load() {
        Intent intent = getActivity().getIntent();
        if (intent != null) collectShared(intent, false);
    }

    // ---------- OCR ----------

    @PluginMethod
    public void recognize(PluginCall call) {
        String b64 = call.getString("base64");
        if (b64 == null) {
            call.reject("base64 is required");
            return;
        }
        ocrPool.execute(() -> {
            try {
                byte[] bytes = Base64.decode(b64, Base64.DEFAULT);
                Bitmap bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
                if (bmp == null) {
                    call.reject("Couldn't decode image");
                    return;
                }
                String text = ScreenshotIndex.recognize(bmp);
                bmp.recycle();
                JSObject ret = new JSObject();
                ret.put("text", text);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("Text recognition failed: " + e.getMessage(), e);
            }
        });
    }

    // ---------- screenshot memory ----------

    @PluginMethod
    public void checkPhotoAccess(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", getPermissionState(photoAlias()) == PermissionState.GRANTED);
        call.resolve(ret);
    }

    @PluginMethod
    public void requestPhotoAccess(PluginCall call) {
        if (getPermissionState(photoAlias()) == PermissionState.GRANTED) {
            checkPhotoAccess(call);
            return;
        }
        requestPermissionForAlias(photoAlias(), call, "photoPermCallback");
    }

    @PermissionCallback
    private void photoPermCallback(PluginCall call) {
        checkPhotoAccess(call);
    }

    @PluginMethod
    public void indexScreenshots(PluginCall call) {
        if (getPermissionState(photoAlias()) != PermissionState.GRANTED) {
            call.reject("Photo access not granted");
            return;
        }
        int limit = call.getInt("limit", 200);
        indexPool.execute(() -> {
            try {
                ScreenshotIndex.Result r = ScreenshotIndex.get(getContext()).index(limit, (done, total) -> {
                    JSObject p = new JSObject();
                    p.put("done", done);
                    p.put("total", total);
                    notifyListeners("indexProgress", p);
                });
                JSObject ret = new JSObject();
                ret.put("added", r.added);
                ret.put("total", r.total);
                ret.put("remaining", r.remaining);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("Indexing failed: " + e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void getIndexed(PluginCall call) {
        indexPool.execute(() -> {
            JSArray arr = new JSArray();
            try (Cursor c = ScreenshotIndex.get(getContext()).rows()) {
                while (c.moveToNext()) {
                    JSObject o = new JSObject();
                    o.put("id", c.getLong(0));
                    o.put("name", c.getString(1));
                    o.put("taken", c.getLong(2));
                    o.put("text", c.getString(3));
                    o.put("thumb", c.getString(4));
                    arr.put(o);
                }
            } catch (Exception e) {
                call.reject("Couldn't read the index: " + e.getMessage(), e);
                return;
            }
            JSObject ret = new JSObject();
            ret.put("shots", arr);
            call.resolve(ret);
        });
    }

    @PluginMethod
    public void openImage(PluginCall call) {
        Long id = call.getLong("id");
        if (id == null) {
            call.reject("id is required");
            return;
        }
        Uri uri = ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id);
        Intent view = new Intent(Intent.ACTION_VIEW);
        view.setDataAndType(uri, "image/*");
        view.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(view);
            call.resolve();
        } catch (Exception e) {
            call.reject("No app can open this image", e);
        }
    }

    @PluginMethod
    public void setAutoIndex(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        WorkManager wm = WorkManager.getInstance(getContext());
        if (enabled) {
            Constraints constraints = new Constraints.Builder().setRequiresBatteryNotLow(true).build();
            PeriodicWorkRequest req = new PeriodicWorkRequest.Builder(IndexWorker.class, 1, TimeUnit.HOURS)
                .setConstraints(constraints)
                .build();
            wm.enqueueUniquePeriodicWork(WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, req);
        } else {
            wm.cancelUniqueWork(WORK_NAME);
        }
        call.resolve();
    }

    // ---------- images shared from other apps ----------

    @PluginMethod
    public void getSharedImages(PluginCall call) {
        // Runs on the same queue as the decoding in load(), so a launch share is ready by now.
        ocrPool.execute(() -> {
            JSArray arr = new JSArray();
            synchronized (pendingShared) {
                for (String s : pendingShared) arr.put(s);
                pendingShared.clear();
            }
            JSObject ret = new JSObject();
            ret.put("images", arr);
            call.resolve(ret);
        });
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        collectShared(intent, true);
    }

    private void collectShared(Intent intent, boolean notify) {
        String action = intent.getAction();
        String type = intent.getType();
        if (type == null || !type.startsWith("image/")) return;
        List<Uri> uris = new ArrayList<>();
        if (Intent.ACTION_SEND.equals(action)) {
            Uri u = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (u != null) uris.add(u);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (list != null) uris.addAll(list);
        } else {
            return;
        }
        // Don't re-import the same share if the activity is recreated.
        intent.setAction(Intent.ACTION_MAIN);

        ocrPool.execute(() -> {
            JSArray images = new JSArray();
            for (Uri u : uris) {
                try {
                    Bitmap bmp = ScreenshotIndex.decode(getContext().getContentResolver(), u, 2400);
                    if (bmp == null) continue;
                    ByteArrayOutputStream out = new ByteArrayOutputStream();
                    bmp.compress(Bitmap.CompressFormat.JPEG, 90, out);
                    bmp.recycle();
                    images.put(Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
                } catch (Exception ignored) {}
            }
            if (notify) {
                JSObject ev = new JSObject();
                ev.put("images", images);
                notifyListeners("sharedImages", ev);
            } else {
                synchronized (pendingShared) {
                    for (int i = 0; i < images.length(); i++) pendingShared.add(images.optString(i));
                }
            }
        });
    }
}
