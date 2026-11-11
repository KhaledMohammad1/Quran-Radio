package com.quranradio.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.drawable.Icon;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

/**
 * Foreground "media playback" service. It owns a MediaSession and posts a
 * MediaStyle notification, so Android shows it as a media player in the
 * notification shade AND on the lock screen (play/pause, next, previous, stop).
 * The audio itself is played by the web view; button presses are forwarded to JS.
 */
public class MediaPlaybackService extends Service {

    public interface Listener {
        void onAction(String action);
    }

    public static Listener listener;

    static final String ACTION_SHOW = "com.quranradio.app.SHOW";
    static final String ACTION_PLAY = "com.quranradio.app.PLAY";
    static final String ACTION_PAUSE = "com.quranradio.app.PAUSE";
    static final String ACTION_NEXT = "com.quranradio.app.NEXT";
    static final String ACTION_PREV = "com.quranradio.app.PREV";
    static final String ACTION_STOP = "com.quranradio.app.STOP";
    static final String ACTION_DISMISS = "com.quranradio.app.DISMISS";

    private static final String CHANNEL_ID = "quran_radio_media";
    private static final int NOTIF_ID = 1001;

    private MediaSession session;
    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private Bitmap largeIcon;

    private String title = "";
    private String subtitle = "";
    private boolean playing = false;
    private String lblPlay = "Play", lblPause = "Pause", lblNext = "Next", lblPrev = "Previous", lblStop = "Stop";

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;

        if (action == null || ACTION_SHOW.equals(action)) {
            if (intent != null) {
                title = nz(intent.getStringExtra("title"));
                subtitle = nz(intent.getStringExtra("subtitle"));
                playing = intent.getBooleanExtra("playing", true);
                lblPlay = nz(intent.getStringExtra("lblPlay"), lblPlay);
                lblPause = nz(intent.getStringExtra("lblPause"), lblPause);
                lblNext = nz(intent.getStringExtra("lblNext"), lblNext);
                lblPrev = nz(intent.getStringExtra("lblPrev"), lblPrev);
                lblStop = nz(intent.getStringExtra("lblStop"), lblStop);
            }
            refresh();
            return START_NOT_STICKY;
        }

        if (ACTION_DISMISS.equals(action)) {
            if (!playing) {
                stopSelf();
            }
            return START_NOT_STICKY;
        }

        // Button presses from the notification: forward to the web layer
        String name = null;
        if (ACTION_PLAY.equals(action)) name = "play";
        else if (ACTION_PAUSE.equals(action)) name = "pause";
        else if (ACTION_NEXT.equals(action)) name = "next";
        else if (ACTION_PREV.equals(action)) name = "prev";
        else if (ACTION_STOP.equals(action)) name = "stop";

        // Update the notification right away (the web layer confirms a moment later)
        if (ACTION_PLAY.equals(action) && !playing) {
            playing = true;
            refresh();
        } else if (ACTION_PAUSE.equals(action) && playing) {
            playing = false;
            refresh();
        }

        if (name != null) {
            if (listener != null) {
                listener.onAction(name);
            } else {
                stopSelf();
            }
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        releaseLocks();
        if (session != null) {
            try {
                session.setActive(false);
                session.release();
            } catch (Exception ignored) {}
            session = null;
        }
        try {
            if (Build.VERSION.SDK_INT >= 24) {
                stopForeground(Service.STOP_FOREGROUND_REMOVE);
            } else {
                stopForeground(true);
            }
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.cancel(NOTIF_ID);
        } catch (Exception ignored) {}
        super.onDestroy();
    }

    private void refresh() {
        ensureChannel();
        ensureSession();
        updateSession();
        Notification n = buildNotification();

        try {
            // Must be called right after startForegroundService()
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            } else {
                startForeground(NOTIF_ID, n);
            }
        } catch (Exception e) {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.notify(NOTIF_ID, n);
        }

        if (playing) {
            acquireLocks();
        } else {
            releaseLocks();
            // keep the notification (with a Play button) but let the user swipe it away
            try {
                if (Build.VERSION.SDK_INT >= 24) {
                    stopForeground(Service.STOP_FOREGROUND_DETACH);
                } else {
                    stopForeground(false);
                }
            } catch (Exception ignored) {}
        }
    }

    // ───────────────────────── helpers ─────────────────────────

    private static String nz(String s) {
        return s == null ? "" : s;
    }

    private static String nz(String s, String def) {
        return (s == null || s.isEmpty()) ? def : s;
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null && nm.getNotificationChannel(CHANNEL_ID) == null) {
                NotificationChannel ch = new NotificationChannel(
                        CHANNEL_ID, "Quran Radio", NotificationManager.IMPORTANCE_LOW);
                ch.setDescription("Quran Radio playback controls");
                ch.setShowBadge(false);
                ch.setSound(null, null);
                ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
                nm.createNotificationChannel(ch);
            }
        }
    }

    private void ensureSession() {
        if (session != null) return;
        session = new MediaSession(this, "QuranRadio");
        session.setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS | MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS);
        session.setCallback(new MediaSession.Callback() {
            @Override
            public void onPlay() { forward("play"); }

            @Override
            public void onPause() { forward("pause"); }

            @Override
            public void onSkipToNext() { forward("next"); }

            @Override
            public void onSkipToPrevious() { forward("prev"); }

            @Override
            public void onStop() { forward("stop"); }
        });
        session.setSessionActivity(openAppIntent());
        session.setActive(true);
    }

    private void forward(String name) {
        if (listener != null) listener.onAction(name);
    }

    private Bitmap getLargeIcon() {
        if (largeIcon == null) {
            try {
                largeIcon = BitmapFactory.decodeResource(getResources(), R.mipmap.ic_launcher);
            } catch (Exception ignored) {}
        }
        return largeIcon;
    }

    private void updateSession() {
        if (session == null) return;
        MediaMetadata.Builder md = new MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, title)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, subtitle)
                .putString(MediaMetadata.METADATA_KEY_ALBUM, "Quran Radio");
        Bitmap art = getLargeIcon();
        if (art != null) md.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, art);
        session.setMetadata(md.build());

        long actions = PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE
                | PlaybackState.ACTION_PLAY_PAUSE | PlaybackState.ACTION_STOP
                | PlaybackState.ACTION_SKIP_TO_NEXT | PlaybackState.ACTION_SKIP_TO_PREVIOUS;
        PlaybackState state = new PlaybackState.Builder()
                .setActions(actions)
                .setState(playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED,
                        PlaybackState.PLAYBACK_POSITION_UNKNOWN, 1.0f)
                .build();
        session.setPlaybackState(state);
    }

    private PendingIntent openAppIntent() {
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (launch == null) launch = new Intent(this, MainActivity.class);
        launch.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private PendingIntent serviceIntent(String action, int req) {
        Intent i = new Intent(this, MediaPlaybackService.class);
        i.setAction(action);
        return PendingIntent.getService(this, req, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private Notification.Action action(int iconRes, String label, String action, int req) {
        return new Notification.Action.Builder(
                Icon.createWithResource(this, iconRes), label, serviceIntent(action, req)).build();
    }

    private Notification buildNotification() {
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= 26) {
            b = new Notification.Builder(this, CHANNEL_ID);
        } else {
            b = new Notification.Builder(this);
            b.setPriority(Notification.PRIORITY_LOW);
        }

        b.setSmallIcon(R.drawable.ic_stat_radio)
                .setContentTitle(title)
                .setContentText(subtitle)
                .setContentIntent(openAppIntent())
                .setDeleteIntent(serviceIntent(ACTION_DISMISS, 9))
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setCategory(Notification.CATEGORY_TRANSPORT)
                .setOngoing(playing)
                .setShowWhen(false)
                .setOnlyAlertOnce(true);

        Bitmap art = getLargeIcon();
        if (art != null) b.setLargeIcon(art);

        b.addAction(action(android.R.drawable.ic_media_previous, lblPrev, ACTION_PREV, 1));
        if (playing) {
            b.addAction(action(android.R.drawable.ic_media_pause, lblPause, ACTION_PAUSE, 2));
        } else {
            b.addAction(action(android.R.drawable.ic_media_play, lblPlay, ACTION_PLAY, 3));
        }
        b.addAction(action(android.R.drawable.ic_media_next, lblNext, ACTION_NEXT, 4));
        b.addAction(action(android.R.drawable.ic_menu_close_clear_cancel, lblStop, ACTION_STOP, 5));

        Notification.MediaStyle style = new Notification.MediaStyle()
                .setShowActionsInCompactView(0, 1, 2);
        if (session != null) style.setMediaSession(session.getSessionToken());
        b.setStyle(style);

        return b.build();
    }

    private void acquireLocks() {
        try {
            if (wakeLock == null) {
                PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                if (pm != null) {
                    wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "QuranRadio::Playback");
                    wakeLock.setReferenceCounted(false);
                }
            }
            if (wakeLock != null && !wakeLock.isHeld()) wakeLock.acquire();

            if (wifiLock == null) {
                WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                if (wm != null) {
                    int mode = Build.VERSION.SDK_INT >= 29
                            ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                            : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
                    wifiLock = wm.createWifiLock(mode, "QuranRadio::Wifi");
                    wifiLock.setReferenceCounted(false);
                }
            }
            if (wifiLock != null && !wifiLock.isHeld()) wifiLock.acquire();
        } catch (Exception ignored) {}
    }

    private void releaseLocks() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
            if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        } catch (Exception ignored) {}
    }
}
