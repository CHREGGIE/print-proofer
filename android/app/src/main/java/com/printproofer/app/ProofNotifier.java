package com.printproofer.app;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import java.util.List;

/** "Possible mistakes in your screenshot" notifications. Tapping one opens it in the Proof tab. */
public final class ProofNotifier {
    static final String CHANNEL = "proof_alerts";
    static final String EXTRA_MEDIA_ID = "proofMediaId";

    private ProofNotifier() {}

    static void notify(Context ctx, List<ScreenshotIndex.Flagged> flagged) {
        if (flagged.isEmpty()) return;
        if (Build.VERSION.SDK_INT >= 33
            && ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return;
        }
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Mistakes in new screenshots", NotificationManager.IMPORTANCE_DEFAULT);
            ch.setDescription("Print Proofer checks new screenshots and tells you when it spots a possible mistake.");
            nm.createNotificationChannel(ch);
        }
        int shown = 0;
        for (ScreenshotIndex.Flagged f : flagged) {
            if (shown++ >= 3) break; // never flood the shade
            Intent open = new Intent(ctx, MainActivity.class)
                .setAction("com.printproofer.app.PROOF")
                .putExtra(EXTRA_MEDIA_ID, f.id)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            PendingIntent pi = PendingIntent.getActivity(ctx, (int) f.id, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            String title = f.problems.size() == 1 ? "1 possible mistake in a screenshot" : f.problems.size() + " possible mistakes in a screenshot";
            StringBuilder body = new StringBuilder();
            for (int i = 0; i < Math.min(4, f.problems.size()); i++) body.append(i > 0 ? "\n" : "").append(f.problems.get(i));
            NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_dialog_alert)
                .setColor(0xFFEC008C)
                .setContentTitle(title)
                .setContentText(f.problems.get(0))
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body.toString() + "\nTap to proof it."))
                .setContentIntent(pi)
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT);
            try {
                NotificationManagerCompat.from(ctx).notify((int) f.id, b.build());
            } catch (SecurityException ignored) {
                // permission withdrawn meanwhile
            }
        }
    }
}
