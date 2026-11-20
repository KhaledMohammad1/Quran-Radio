package com.quranradio.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.drawable.Icon;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;

import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;

import androidx.core.content.ContextCompat;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.Locale;

/**
 * Foreground "media playback" service.
 *
 * It plays the live stream natively with ExoPlayer (so playback keeps running and
 * reconnects by itself while the screen is off / the web view is throttled), owns a
 * MediaSession and posts a MediaStyle notification (lock screen + quick settings player).
 *
 * If native playback is not used (fallback), the web view plays the audio and this
 * service only shows the notification and forwards button presses to JS.
 */
public class MediaPlaybackService extends Service {

    public interface Listener {
        void onAction(String action);
        void onEvent(String state, String detail);
    }

    public static Listener listener;
    public static volatile boolean running = false;
    public static volatile boolean sPlaying = false;
    public static volatile boolean sNativeMode = false;
    public static volatile String sTitle = "";
    public static volatile String sSubtitle = "";

    /** Tiny persistent event log (shown from the app with a long-press on the ﷽ symbol). */
    public static synchronized void diag(Context ctx, String msg) {
        try {
            SharedPreferences sp = ctx.getApplicationContext().getSharedPreferences("qr_diag", Context.MODE_PRIVATE);
            String old = sp.getString("log", "");
            String line = new SimpleDateFormat("MM-dd HH:mm:ss", Locale.US).format(new Date()) + " " + msg;
            String[] lines = old.isEmpty() ? new String[0] : old.split("\n");
            StringBuilder sb = new StringBuilder();
            for (int i = Math.max(0, lines.length - 59); i < lines.length; i++) sb.append(lines[i]).append('\n');
            sb.append(line);
            sp.edit().putString("log", sb.toString()).apply();
        } catch (Exception ignored) {}
    }

    public static String readDiag(Context ctx) {
        try {
            return ctx.getApplicationContext().getSharedPreferences("qr_diag", Context.MODE_PRIVATE).getString("log", "");
        } catch (Exception e) {
            return "";
        }
    }

    static final String ACTION_SHOW = "com.quranradio.app.SHOW";
    static final String ACTION_PLAY = "com.quranradio.app.PLAY";
    static final String ACTION_PAUSE = "com.quranradio.app.PAUSE";
    static final String ACTION_NEXT = "com.quranradio.app.NEXT";
    static final String ACTION_PREV = "com.quranradio.app.PREV";
    static final String ACTION_STOP = "com.quranradio.app.STOP";
    static final String ACTION_DISMISS = "com.quranradio.app.DISMISS";
    static final String ACTION_PLAY_STREAM = "com.quranradio.app.PLAY_STREAM";
    static final String ACTION_PAUSE_STREAM = "com.quranradio.app.PAUSE_STREAM";
    static final String ACTION_SET_VOLUME = "com.quranradio.app.SET_VOLUME";
    static final String ACTION_UPDATE_META = "com.quranradio.app.UPDATE_META";

    private static final String CHANNEL_ID = "quran_radio_media";
    private static final int NOTIF_ID = 1001;

    private final Handler handler = new Handler(Looper.getMainLooper());

    private MediaSession session;
    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private Bitmap largeIcon;

    private String title = "";
    private String subtitle = "";
    private boolean playing = false;
    private String lblPlay = "Play", lblPause = "Pause", lblNext = "Next", lblPrev = "Previous", lblStop = "Stop";

    // ── native player state ──
    private ExoPlayer player;
    private boolean nativeMode = false;
    private final ArrayList<String> urls = new ArrayList<>();
    private int urlIdx = 0;
    private int failCount = 0;
    private long token = 0;
    private boolean wantPlay = false;
    private boolean startedReported = false;
    private float volume = 1f;
    private Runnable timeoutRunnable, retryRunnable, stallRunnable;
    private boolean buffering = false;
    private Runnable loadingRunnable;
    private long lastUnlock = 0;
    private BroadcastReceiver userPresentReceiver;

    @Override
    public void onCreate() {
        super.onCreate();
        running = true;
        diag(this, "service created");
        userPresentReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                lastUnlock = System.currentTimeMillis();
                diag(MediaPlaybackService.this, "device unlocked (player " + (player != null ? "state=" + player.getPlaybackState() + " pwr=" + player.getPlayWhenReady() : "none") + ")");
                // If the player got paused by an audio-focus grab just before/while unlocking, resume it.
                final long t = token;
                handler.postDelayed(new Runnable() {
                    @Override
                    public void run() {
                        if (t == token && wantPlay && nativeMode && player != null && !player.getPlayWhenReady()) {
                            diag(MediaPlaybackService.this, "resume after unlock (was paused by the system)");
                            player.setPlayWhenReady(true);
                        }
                    }
                }, 900);
            }
        };
        try {
            ContextCompat.registerReceiver(this, userPresentReceiver,
                    new IntentFilter(Intent.ACTION_USER_PRESENT), ContextCompat.RECEIVER_NOT_EXPORTED);
        } catch (Exception ignored) {}
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;

        if (ACTION_UPDATE_META.equals(action)) {
            if (intent != null) readMeta(intent);
            refresh();
            return START_NOT_STICKY;
        }

        if (ACTION_PLAY_STREAM.equals(action)) {
            readMeta(intent);
            nativeMode = true;
            volume = intent.getFloatExtra("volume", 1f);
            playing = true;
            buffering = true;
            refresh();
            startStream(intent.getStringArrayExtra("urls"));
            return START_NOT_STICKY;
        }

        if (ACTION_PAUSE_STREAM.equals(action)) {
            if (nativeMode) {
                pauseStream(false);
            } else if (player == null && !playing) {
                stopSelf();
            }
            return START_NOT_STICKY;
        }

        if (ACTION_SET_VOLUME.equals(action)) {
            volume = intent.getFloatExtra("volume", 1f);
            if (player != null) player.setVolume(volume);
            return START_NOT_STICKY;
        }

        if (action == null || ACTION_SHOW.equals(action)) {
            // Fallback mode: the web view plays the audio, we only show the notification
            if (nativeMode) {
                stopPlayerQuietly();
                nativeMode = false;
            }
            if (intent != null) {
                readMeta(intent);
                playing = intent.getBooleanExtra("playing", true);
            }
            buffering = false;
            refresh();
            return START_NOT_STICKY;
        }

        if (ACTION_DISMISS.equals(action)) {
            if (!playing) {
                stopSelf();
            }
            return START_NOT_STICKY;
        }

        // Button presses from the notification
        String name = null;
        if (ACTION_PLAY.equals(action)) name = "play";
        else if (ACTION_PAUSE.equals(action)) name = "pause";
        else if (ACTION_NEXT.equals(action)) name = "next";
        else if (ACTION_PREV.equals(action)) name = "prev";
        else if (ACTION_STOP.equals(action)) name = "stop";
        if (name != null) handleControl(name);
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        sPlaying = false;
        sNativeMode = false;
        diag(this, "service destroyed");
        try { if (userPresentReceiver != null) unregisterReceiver(userPresentReceiver); } catch (Exception ignored) {}
        cancelTimers();
        handler.removeCallbacksAndMessages(null);
        releasePlayer();
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

    // ───────────────────────── controls (notification / lock screen / headset) ─────────────────────────

    private void handleControl(String name) {
        diag(this, "control: " + name + (nativeMode ? " (native)" : " (web)"));
        if (nativeMode) {
            switch (name) {
                case "play":
                    resumeStream();
                    break;
                case "pause":
                    pauseStream(true);
                    break;
                case "stop":
                    stopAll();
                    forward("stop"); // tells the web layer to close the app
                    break;
                default:
                    forward(name); // next / prev: the web layer knows the station list
            }
            return;
        }

        // Fallback (web view audio): update the notification and let JS do the work
        if ("play".equals(name) && !playing) {
            playing = true;
            refresh();
        } else if ("pause".equals(name) && playing) {
            playing = false;
            refresh();
        }
        if (listener != null) listener.onAction(name);
        else if ("stop".equals(name)) stopSelf();
    }

    private void forward(String name) {
        if (listener != null) listener.onAction(name);
    }

    private void emit(String state) {
        if (listener != null) listener.onEvent(state, "");
    }

    // ───────────────────────── native streaming ─────────────────────────

    private void ensurePlayer() {
        if (player != null) return;

        DefaultHttpDataSource.Factory http = new DefaultHttpDataSource.Factory()
                .setUserAgent("QuranRadio/1.0 (Android)")
                .setAllowCrossProtocolRedirects(true)
                .setConnectTimeoutMs(8000)
                .setReadTimeoutMs(10000);

        AudioAttributes attrs = new AudioAttributes.Builder()
                .setUsage(C.USAGE_MEDIA)
                .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                .build();

        player = new ExoPlayer.Builder(this)
                .setMediaSourceFactory(new DefaultMediaSourceFactory(this).setDataSourceFactory(http))
                .setAudioAttributes(attrs, true)
                .setHandleAudioBecomingNoisy(true)
                .setWakeMode(C.WAKE_MODE_NETWORK)
                .build();

        player.addListener(new Player.Listener() {
            @Override
            public void onPlaybackStateChanged(int state) {
                if (!nativeMode || !wantPlay) return;
                final long t = token;
                if (state == Player.STATE_READY) {
                    handler.removeCallbacks(loadingRunnable != null ? loadingRunnable : noop);
                    setBuffering(false);
                    handler.removeCallbacks(timeoutRunnable != null ? timeoutRunnable : noop);
                    handler.removeCallbacks(stallRunnable != null ? stallRunnable : noop);
                    failCount = 0;
                    if (!startedReported) {
                        startedReported = true;
                        diag(MediaPlaybackService.this, "stream started");
                        emit("started");
                    }
                } else if (state == Player.STATE_BUFFERING) {
                    if (startedReported) {
                        // show "Loading..." only if the buffering lasts a moment (avoids flicker)
                        handler.removeCallbacks(loadingRunnable != null ? loadingRunnable : noop);
                        loadingRunnable = new Runnable() {
                            @Override
                            public void run() {
                                if (t == token && wantPlay && player != null
                                        && player.getPlaybackState() == Player.STATE_BUFFERING) {
                                    setBuffering(true);
                                }
                            }
                        };
                        handler.postDelayed(loadingRunnable, 1500);
                        handler.removeCallbacks(stallRunnable != null ? stallRunnable : noop);
                        stallRunnable = new Runnable() {
                            @Override
                            public void run() {
                                if (t == token && wantPlay && player != null
                                        && player.getPlaybackState() == Player.STATE_BUFFERING) {
                                    handleFailure();
                                }
                            }
                        };
                        handler.postDelayed(stallRunnable, 25000);
                    }
                } else if (state == Player.STATE_ENDED) {
                    handleFailure(); // a live stream should never end -> reconnect
                }
            }

            @Override
            public void onPlayerError(PlaybackException error) {
                if (nativeMode && wantPlay) handleFailure();
            }

            @Override
            public void onPlayWhenReadyChanged(boolean playWhenReady, int reason) {
                if (!nativeMode || !wantPlay) return;
                diag(MediaPlaybackService.this, "playWhenReady=" + playWhenReady + " reason=" + reason);

                if (!playWhenReady && (reason == Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_FOCUS_LOSS
                        || reason == Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_BECOMING_NOISY)) {
                    // Something grabbed the audio (e.g. system sound/lock screen right after an unlock).
                    // If this happens within a few seconds of unlocking, resume by ourselves.
                    final long t = token;
                    boolean justUnlocked = System.currentTimeMillis() - lastUnlock < 15000;
                    if (justUnlocked && reason == Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_FOCUS_LOSS) {
                        handler.postDelayed(new Runnable() {
                            @Override
                            public void run() {
                                if (t == token && wantPlay && nativeMode && player != null && !player.getPlayWhenReady()) {
                                    diag(MediaPlaybackService.this, "auto-resume after unlock");
                                    player.setPlayWhenReady(true);
                                }
                            }
                        }, 1200);
                        return;
                    }
                }

                if (playing != playWhenReady) {
                    playing = playWhenReady;
                    refresh();
                    emit(playWhenReady ? "resumed" : "paused");
                }
            }
        });
    }

    private final Runnable noop = new Runnable() {
        @Override
        public void run() {}
    };

    private void startStream(String[] list) {
        token++;
        cancelTimers();
        urls.clear();
        if (list != null) {
            for (String u : list) {
                if (u != null && !u.isEmpty()) urls.add(u);
            }
        }
        urlIdx = 0;
        failCount = 0;
        startedReported = false;
        wantPlay = true;

        if (urls.isEmpty()) {
            failAll();
            return;
        }
        ensurePlayer();
        player.setVolume(volume);
        tryCurrent();
    }

    private void tryCurrent() {
        if (player == null || urls.isEmpty()) return;
        final long t = token;
        String u = urls.get(urlIdx % urls.size());
        try {
            player.setMediaItem(MediaItem.fromUri(u));
            player.setPlayWhenReady(true);
            player.prepare();
        } catch (Exception e) {
            handleFailure();
            return;
        }
        handler.removeCallbacks(timeoutRunnable != null ? timeoutRunnable : noop);
        timeoutRunnable = new Runnable() {
            @Override
            public void run() {
                if (t == token && wantPlay
                        && (player == null || player.getPlaybackState() != Player.STATE_READY)) {
                    handleFailure();
                }
            }
        };
        handler.postDelayed(timeoutRunnable, startedReported ? 15000 : 9000);
    }

    private void handleFailure() {
        if (!wantPlay) return;
        diag(this, "stream problem (started=" + startedReported + ", fails=" + failCount + ", url#" + urlIdx + ")");
        cancelTimers();

        if (!startedReported) {
            // still connecting: try the next candidate URL
            urlIdx++;
            if (urlIdx < urls.size()) {
                tryCurrent();
            } else {
                failAll();
            }
            return;
        }

        // the stream dropped while playing: reconnect with a growing delay
        failCount++;
        if (failCount > 40) {
            failAll();
            return;
        }
        setBuffering(true);
        long delay = Math.min(30000L, 1500L * failCount);
        final long t = token;
        retryRunnable = new Runnable() {
            @Override
            public void run() {
                if (t == token && wantPlay) {
                    if (failCount % 3 == 0) urlIdx = (urlIdx + 1) % urls.size();
                    tryCurrent();
                }
            }
        };
        handler.postDelayed(retryRunnable, delay);
    }

    private void failAll() {
        diag(this, "gave up");
        buffering = false;
        wantPlay = false;
        token++;
        cancelTimers();
        if (player != null) {
            try { player.stop(); } catch (Exception ignored) {}
        }
        playing = false;
        refresh();
        emit("failed");
    }

    private void pauseStream(boolean notifyJs) {
        buffering = false;
        token++;
        wantPlay = false;
        cancelTimers();
        if (player != null) {
            try { player.stop(); } catch (Exception ignored) {}
        }
        playing = false;
        refresh();
        if (notifyJs) emit("paused");
    }

    private void resumeStream() {
        if (urls.isEmpty()) return;
        playing = true;
        buffering = true;
        refresh();
        emit("resumed");
        startStream(urls.toArray(new String[0]));
    }

    private void stopAll() {
        token++;
        wantPlay = false;
        cancelTimers();
        nativeMode = false;
        releasePlayer();
        stopSelf();
    }

    private void stopPlayerQuietly() {
        token++;
        wantPlay = false;
        cancelTimers();
        if (player != null) {
            try { player.stop(); } catch (Exception ignored) {}
        }
    }

    private void releasePlayer() {
        if (player != null) {
            try { player.release(); } catch (Exception ignored) {}
            player = null;
        }
    }

    private void cancelTimers() {
        if (timeoutRunnable != null) handler.removeCallbacks(timeoutRunnable);
        if (retryRunnable != null) handler.removeCallbacks(retryRunnable);
        if (stallRunnable != null) handler.removeCallbacks(stallRunnable);
        if (loadingRunnable != null) handler.removeCallbacks(loadingRunnable);
    }

    // ───────────────────────── notification + session ─────────────────────────

    private void setBuffering(boolean b) {
        if (buffering == b) return;
        buffering = b;
        if (nativeMode && playing) refresh();
    }

    /** Keep the Arabic station subtitle RTL; isolate the English status tag at the visual left edge. */
    private String displaySubtitle() {
        if (!playing) return subtitle;
        String tag = buffering ? "LOADING" : "LIVE";
        if (subtitle.isEmpty()) return tag;
        // Isolate the LTR status tag so it stays at the visual left edge of RTL text.
        return subtitle + "  \u2066" + tag + "\u2069";
    }

    private void readMeta(Intent intent) {
        title = nz(intent.getStringExtra("title"));
        subtitle = nz(intent.getStringExtra("subtitle"));
        lblPlay = nz(intent.getStringExtra("lblPlay"), lblPlay);
        lblPause = nz(intent.getStringExtra("lblPause"), lblPause);
        lblNext = nz(intent.getStringExtra("lblNext"), lblNext);
        lblPrev = nz(intent.getStringExtra("lblPrev"), lblPrev);
        lblStop = nz(intent.getStringExtra("lblStop"), lblStop);
    }

    private void refresh() {
        sPlaying = playing;
        sNativeMode = nativeMode;
        sTitle = title;
        sSubtitle = subtitle;
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
            public void onPlay() { handleControl("play"); }

            @Override
            public void onPause() { handleControl("pause"); }

            @Override
            public void onSkipToNext() { handleControl("next"); }

            @Override
            public void onSkipToPrevious() { handleControl("prev"); }

            @Override
            public void onStop() { handleControl("stop"); }

            @Override
            public void onCustomAction(String action, Bundle extras) {
                if ("close".equals(action)) handleControl("stop");
            }
        });
        session.setSessionActivity(openAppIntent());
        session.setActive(true);
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
                .putString(MediaMetadata.METADATA_KEY_ARTIST, displaySubtitle())
                .putString(MediaMetadata.METADATA_KEY_ALBUM, "Quran Radio");
        Bitmap art = getLargeIcon();
        if (art != null) md.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, art);
        session.setMetadata(md.build());

        long actions = PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE
                | PlaybackState.ACTION_PLAY_PAUSE | PlaybackState.ACTION_STOP
                | PlaybackState.ACTION_SKIP_TO_NEXT | PlaybackState.ACTION_SKIP_TO_PREVIOUS;
        PlaybackState state = new PlaybackState.Builder()
                .setActions(actions)
                .addCustomAction("close", lblStop, R.drawable.ic_stop_square)
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
                .setContentText(displaySubtitle())
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
        b.addAction(action(R.drawable.ic_stop_square, lblStop, ACTION_STOP, 5));

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
