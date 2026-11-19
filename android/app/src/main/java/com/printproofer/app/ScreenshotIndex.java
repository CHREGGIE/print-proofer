package com.printproofer.app;

import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;

import com.google.android.gms.tasks.Tasks;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * On-device screenshot memory: finds screenshots in the gallery, reads their text
 * with ML Kit (no network) and stores it in a local SQLite database.
 */
public class ScreenshotIndex extends SQLiteOpenHelper {

    public interface Progress {
        void onProgress(int done, int total);
    }

    public static class Media {
        public final long id;
        public final String name;
        public final long taken;

        Media(long id, String name, long taken) {
            this.id = id;
            this.name = name;
            this.taken = taken;
        }
    }

    public static class Result {
        public int added;
        public int total;
        public int remaining;
    }

    private static ScreenshotIndex instance;
    private final Context context;
    private static final Object LOCK = new Object();

    public static synchronized ScreenshotIndex get(Context ctx) {
        if (instance == null) instance = new ScreenshotIndex(ctx.getApplicationContext());
        return instance;
    }

    private ScreenshotIndex(Context ctx) {
        super(ctx, "screenshots.db", null, 1);
        this.context = ctx;
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE shots (media_id INTEGER PRIMARY KEY, name TEXT, taken INTEGER, text TEXT, thumb TEXT)");
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {}

    /** Text recognition for one bitmap (call off the main thread). */
    public static String recognize(Bitmap bitmap) throws Exception {
        TextRecognizer recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
        try {
            Text result = Tasks.await(recognizer.process(InputImage.fromBitmap(bitmap, 0)));
            StringBuilder sb = new StringBuilder();
            for (Text.TextBlock block : result.getTextBlocks()) {
                for (Text.Line line : block.getLines()) sb.append(line.getText()).append('\n');
                sb.append('\n');
            }
            return sb.toString().trim();
        } finally {
            recognizer.close();
        }
    }

    /** All screenshots in the gallery, newest first. */
    public List<Media> listScreenshots() {
        List<Media> out = new ArrayList<>();
        ContentResolver cr = context.getContentResolver();
        Uri uri = MediaStore.Images.Media.EXTERNAL_CONTENT_URI;
        String pathCol = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ? MediaStore.Images.Media.RELATIVE_PATH : MediaStore.Images.Media.DATA;
        String[] projection = {
            MediaStore.Images.Media._ID,
            MediaStore.Images.Media.DISPLAY_NAME,
            MediaStore.Images.Media.DATE_TAKEN,
            MediaStore.Images.Media.DATE_ADDED,
        };
        String selection = pathCol + " LIKE ? OR " + MediaStore.Images.Media.DISPLAY_NAME + " LIKE ?";
        String[] args = { "%Screenshot%", "Screenshot%" };
        try (Cursor c = cr.query(uri, projection, selection, args, MediaStore.Images.Media.DATE_ADDED + " DESC")) {
            if (c == null) return out;
            while (c.moveToNext()) {
                long taken = c.getLong(2);
                if (taken == 0) taken = c.getLong(3) * 1000L;
                out.add(new Media(c.getLong(0), c.getString(1), taken));
            }
        }
        return out;
    }

    private Set<Long> indexedIds() {
        Set<Long> ids = new HashSet<>();
        try (Cursor c = getReadableDatabase().rawQuery("SELECT media_id FROM shots", null)) {
            while (c.moveToNext()) ids.add(c.getLong(0));
        }
        return ids;
    }

    /** OCR up to {@code limit} screenshots that aren't indexed yet. */
    public Result index(int limit, Progress progress) {
        synchronized (LOCK) {
            List<Media> all = listScreenshots();
            Set<Long> done = indexedIds();
            List<Media> todo = new ArrayList<>();
            for (Media m : all) if (!done.contains(m.id)) todo.add(m);

            Result r = new Result();
            int n = Math.min(limit, todo.size());
            File thumbs = new File(context.getFilesDir(), "thumbs");
            //noinspection ResultOfMethodCallIgnored
            thumbs.mkdirs();
            for (int i = 0; i < n; i++) {
                Media m = todo.get(i);
                String text = "";
                String thumbPath = "";
                try {
                    Uri item = ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, m.id);
                    Bitmap bmp = decode(context.getContentResolver(), item, 2000);
                    if (bmp != null) {
                        text = recognize(bmp);
                        File f = new File(thumbs, m.id + ".jpg");
                        int w = 240;
                        int h = Math.max(1, Math.round(bmp.getHeight() * (w / (float) bmp.getWidth())));
                        Bitmap small = Bitmap.createScaledBitmap(bmp, w, h, true);
                        try (FileOutputStream out = new FileOutputStream(f)) {
                            small.compress(Bitmap.CompressFormat.JPEG, 70, out);
                        }
                        thumbPath = f.getAbsolutePath();
                        small.recycle();
                        bmp.recycle();
                    }
                } catch (Exception ignored) {
                    // Keep a row anyway so a broken image isn't retried forever.
                }
                ContentValues v = new ContentValues();
                v.put("media_id", m.id);
                v.put("name", m.name);
                v.put("taken", m.taken);
                v.put("text", text);
                v.put("thumb", thumbPath);
                getWritableDatabase().insertWithOnConflict("shots", null, v, SQLiteDatabase.CONFLICT_REPLACE);
                r.added++;
                if (progress != null) progress.onProgress(i + 1, n);
            }
            r.total = done.size() + r.added;
            r.remaining = todo.size() - n;
            return r;
        }
    }

    public Cursor rows() {
        return getReadableDatabase().rawQuery("SELECT media_id, name, taken, text, thumb FROM shots ORDER BY taken DESC", null);
    }

    /** Decode an image downsampled so its longest side is about maxEdge pixels. */
    public static Bitmap decode(ContentResolver cr, Uri uri, int maxEdge) throws Exception {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        try (InputStream in = cr.openInputStream(uri)) {
            BitmapFactory.decodeStream(in, null, bounds);
        }
        int longest = Math.max(bounds.outWidth, bounds.outHeight);
        if (longest <= 0) return null;
        BitmapFactory.Options opts = new BitmapFactory.Options();
        opts.inSampleSize = 1;
        while (longest / (opts.inSampleSize * 2) >= maxEdge) opts.inSampleSize *= 2;
        try (InputStream in = cr.openInputStream(uri)) {
            return BitmapFactory.decodeStream(in, null, opts);
        }
    }
}
