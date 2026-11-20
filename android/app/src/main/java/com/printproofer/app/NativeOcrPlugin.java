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


import com.google.android.gms.tasks.Tasks;
import com.google.mlkit.vision.barcode.BarcodeScanner;
import com.google.mlkit.vision.barcode.BarcodeScanning;
import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.common.InputImage;
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

@CapacitorPlugin(
    name = "NativeOcr",
    permissions = {
        @Permission(alias = "mediaImages", strings = { Manifest.permission.READ_MEDIA_IMAGES }),
        @Permission(alias = "storage", strings = { Manifest.permission.READ_EXTERNAL_STORAGE }),
        @Permission(alias = "notifications", strings = { "android.permission.POST_NOTIFICATIONS" }),
    }
)
public class NativeOcrPlugin extends Plugin {

    private final ExecutorService ocrPool = Executors.newSingleThreadExecutor();
    private final ExecutorService indexPool = Executors.newSingleThreadExecutor();
    private final List<String> pendingShared = new ArrayList<>();

    private String photoAlias() {
        return Build.VERSION.SDK_INT >= 33 ? "mediaImages" : "storage";
    }

    @Override
    public void load() {
        Intent intent = getActivity().getIntent();
        if (intent != null && !collectProofRequest(intent, false)) collectShared(intent, false);
        IndexWorker.armTrigger(getContext()); // make sure the new-screenshot trigger is armed
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

    // ---------- QR codes and barcodes (ML Kit, on-device) ----------

    @PluginMethod
    public void scanCodes(PluginCall call) {
        String b64 = call.getString("base64");
        if (b64 == null) {
            call.reject("base64 is required");
            return;
        }
        ocrPool.execute(() -> {
            BarcodeScanner scanner = BarcodeScanning.getClient();
            try {
                byte[] bytes = Base64.decode(b64, Base64.DEFAULT);
                Bitmap bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
                if (bmp == null) {
                    call.reject("Couldn't decode image");
                    return;
                }
                List<Barcode> found = Tasks.await(scanner.process(InputImage.fromBitmap(bmp, 0)));
                bmp.recycle();
                JSArray arr = new JSArray();
                for (Barcode b : found) {
                    JSObject o = new JSObject();
                    o.put("format", formatName(b.getFormat()));
                    o.put("raw", b.getRawValue() == null ? "" : b.getRawValue());
                    android.graphics.Rect r = b.getBoundingBox();
                    if (r != null) {
                        JSObject box = new JSObject();
                        box.put("x", r.left);
                        box.put("y", r.top);
                        box.put("w", r.width());
                        box.put("h", r.height());
                        o.put("box", box);
                    }
                    arr.put(o);
                }
                JSObject ret = new JSObject();
                ret.put("codes", arr);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("Code scan failed: " + e.getMessage(), e);
            } finally {
                scanner.close();
            }
        });
    }

    private static String formatName(int f) {
        switch (f) {
            case Barcode.FORMAT_QR_CODE: return "QR";
            case Barcode.FORMAT_EAN_13: return "EAN-13";
            case Barcode.FORMAT_EAN_8: return "EAN-8";
            case Barcode.FORMAT_UPC_A: return "UPC-A";
            case Barcode.FORMAT_UPC_E: return "UPC-E";
            case Barcode.FORMAT_CODE_128: return "Code 128";
            case Barcode.FORMAT_CODE_39: return "Code 39";
            case Barcode.FORMAT_DATA_MATRIX: return "Data Matrix";
            case Barcode.FORMAT_PDF417: return "PDF417";
            case Barcode.FORMAT_ITF: return "ITF";
            default: return "Code";
        }
    }

    // ---------- read aloud (Android text-to-speech, works offline) ----------

    private android.speech.tts.TextToSpeech tts;
    private boolean ttsReady = false;
    private final List<Runnable> ttsQueue = new ArrayList<>();

    private void withTts(Runnable r) {
        if (ttsReady) {
            r.run();
            return;
        }
        ttsQueue.add(r);
        if (tts != null) return;
        tts = new android.speech.tts.TextToSpeech(getContext(), status -> {
            ttsReady = status == android.speech.tts.TextToSpeech.SUCCESS;
            if (ttsReady) {
                tts.setLanguage(java.util.Locale.US);
                tts.setOnUtteranceProgressListener(new android.speech.tts.UtteranceProgressListener() {
                    @Override public void onStart(String id) {}
                    @Override public void onDone(String id) { speechEvent("speechDone", id, -1, -1); }
                    @Override public void onError(String id) { speechEvent("speechDone", id, -1, -1); }
                    @Override public void onStop(String id, boolean interrupted) { speechEvent("speechDone", id, -1, -1); }
                    @Override public void onRangeStart(String id, int start, int end, int frame) { speechEvent("speechRange", id, start, end); }
                });
            }
            List<Runnable> q = new ArrayList<>(ttsQueue);
            ttsQueue.clear();
            for (Runnable x : q) x.run();
        });
    }

    private void speechEvent(String name, String id, int start, int end) {
        JSObject e = new JSObject();
        e.put("id", id);
        e.put("start", start);
        e.put("end", end);
        notifyListeners(name, e);
    }

    @PluginMethod
    public void speak(PluginCall call) {
        String text = call.getString("text", "");
        String id = call.getString("id", "u");
        float rate = call.getFloat("rate", 1.0f);
        withTts(() -> {
            if (!ttsReady) {
                call.reject("Text-to-speech isn't available on this phone");
                return;
            }
            tts.setSpeechRate(rate);
            tts.speak(text, android.speech.tts.TextToSpeech.QUEUE_FLUSH, null, id);
            call.resolve();
        });
    }

    @PluginMethod
    public void stopSpeaking(PluginCall call) {
        if (tts != null) tts.stop();
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        if (tts != null) tts.shutdown();
        super.handleOnDestroy();
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
        IndexWorker.prefs(getContext()).edit().putBoolean("autoIndex", enabled).apply();
        IndexWorker.schedulePeriodic(getContext(), enabled || IndexWorker.prefs(getContext()).getBoolean("autoProof", false));
        call.resolve();
    }

    /** Warn about mistakes in new screenshots (notification), checked seconds after each one. */
    @PluginMethod
    public void setAutoProof(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        android.content.SharedPreferences prefs = IndexWorker.prefs(getContext());
        prefs.edit().putBoolean("autoProof", enabled).apply();
        IndexWorker.schedulePeriodic(getContext(), enabled || prefs.getBoolean("autoIndex", false));
        if (enabled) IndexWorker.armTrigger(getContext());
        else IndexWorker.disarmTrigger(getContext());
        call.resolve();
    }

    @PluginMethod
    public void requestNotifications(PluginCall call) {
        if (Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED) {
            JSObject ret = new JSObject();
            ret.put("granted", true);
            call.resolve(ret);
            return;
        }
        requestPermissionForAlias("notifications", call, "notifPermCallback");
    }

    @PermissionCallback
    private void notifPermCallback(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", getPermissionState("notifications") == PermissionState.GRANTED);
        call.resolve(ret);
    }

    /** A screenshot as base64, for the Proof tab. */
    @PluginMethod
    public void getImage(PluginCall call) {
        Long id = call.getLong("id");
        if (id == null) {
            call.reject("id is required");
            return;
        }
        indexPool.execute(() -> {
            try {
                JSObject ret = new JSObject();
                ret.put("base64", ScreenshotIndex.get(getContext()).imageBase64(id));
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("Couldn't open that screenshot: " + e.getMessage(), e);
            }
        });
    }

    private long pendingProof = -1;

    /** The screenshot a tapped notification asked to proof (launch or resume). */
    @PluginMethod
    public void getPendingProof(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("id", pendingProof);
        pendingProof = -1;
        call.resolve(ret);
    }

    private boolean collectProofRequest(Intent intent, boolean notify) {
        long id = intent.getLongExtra(ProofNotifier.EXTRA_MEDIA_ID, -1);
        if (id < 0) return false;
        intent.removeExtra(ProofNotifier.EXTRA_MEDIA_ID);
        if (notify) {
            JSObject e = new JSObject();
            e.put("id", id);
            notifyListeners("proofRequest", e);
        } else {
            pendingProof = id;
        }
        return true;
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
        if (!collectProofRequest(intent, true)) collectShared(intent, true);
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
