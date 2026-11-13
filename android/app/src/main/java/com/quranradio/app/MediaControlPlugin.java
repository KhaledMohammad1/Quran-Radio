package com.quranradio.app;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(
    name = "MediaControl",
    permissions = {
        @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications")
    }
)
public class MediaControlPlugin extends Plugin implements MediaPlaybackService.Listener {

    @Override
    public void load() {
        MediaPlaybackService.listener = this;
        MediaPlaybackService.diag(getContext(), "activity/plugin loaded");
    }

    @Override
    protected void handleOnDestroy() {
        if (MediaPlaybackService.listener == this) {
            MediaPlaybackService.listener = null;
        }
        // NOTE: the service (and the native player) intentionally keeps running when the
        // screen/activity is destroyed; it stops only from the "Close" button.
        MediaPlaybackService.diag(getContext(), "activity destroyed");
    }

    @Override
    public void onAction(String action) {
        JSObject data = new JSObject();
        data.put("action", action);
        notifyListeners("action", data);
    }

    @Override
    public void onEvent(String state, String detail) {
        JSObject data = new JSObject();
        data.put("state", state);
        data.put("detail", detail);
        notifyListeners("state", data);
    }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "permissionResult");
        } else {
            call.resolve();
        }
    }

    @PermissionCallback
    private void permissionResult(PluginCall call) {
        call.resolve();
    }

    private Intent baseIntent(String action, PluginCall call) {
        Intent i = new Intent(getContext(), MediaPlaybackService.class);
        i.setAction(action);
        i.putExtra("title", call.getString("title", ""));
        i.putExtra("subtitle", call.getString("subtitle", ""));
        i.putExtra("lblPlay", call.getString("lblPlay", "Play"));
        i.putExtra("lblPause", call.getString("lblPause", "Pause"));
        i.putExtra("lblNext", call.getString("lblNext", "Next"));
        i.putExtra("lblPrev", call.getString("lblPrev", "Previous"));
        i.putExtra("lblStop", call.getString("lblStop", "Stop"));
        return i;
    }

    /** Notification only (web view plays the audio - fallback mode). */
    @PluginMethod
    public void show(PluginCall call) {
        Intent i = baseIntent(MediaPlaybackService.ACTION_SHOW, call);
        Boolean playing = call.getBoolean("playing", true);
        i.putExtra("playing", playing == null || playing.booleanValue());
        try {
            ContextCompat.startForegroundService(getContext(), i);
            call.resolve();
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()));
        }
    }

    /** Play a live stream natively. The outcome arrives as a "state" event (started / failed). */
    @PluginMethod
    public void playStream(PluginCall call) {
        JSArray arr = call.getArray("urls");
        String[] urls = new String[arr == null ? 0 : arr.length()];
        for (int k = 0; k < urls.length; k++) {
            try {
                urls[k] = arr.getString(k);
            } catch (Exception e) {
                urls[k] = "";
            }
        }
        Float vol = call.getFloat("volume", 1f);

        Intent i = baseIntent(MediaPlaybackService.ACTION_PLAY_STREAM, call);
        i.putExtra("urls", urls);
        i.putExtra("volume", vol == null ? 1f : vol.floatValue());
        try {
            ContextCompat.startForegroundService(getContext(), i);
            call.resolve();
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()));
        }
    }

    @PluginMethod
    public void pauseStream(PluginCall call) {
        if (MediaPlaybackService.running) {
            try {
                Intent i = new Intent(getContext(), MediaPlaybackService.class);
                i.setAction(MediaPlaybackService.ACTION_PAUSE_STREAM);
                getContext().startService(i);
            } catch (Exception ignored) {}
        }
        call.resolve();
    }

    @PluginMethod
    public void setVolume(PluginCall call) {
        if (MediaPlaybackService.running) {
            try {
                Float vol = call.getFloat("volume", 1f);
                Intent i = new Intent(getContext(), MediaPlaybackService.class);
                i.setAction(MediaPlaybackService.ACTION_SET_VOLUME);
                i.putExtra("volume", vol == null ? 1f : vol.floatValue());
                getContext().startService(i);
            } catch (Exception ignored) {}
        }
        call.resolve();
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        JSObject o = new JSObject();
        o.put("running", MediaPlaybackService.running);
        o.put("nativeMode", MediaPlaybackService.sNativeMode);
        o.put("playing", MediaPlaybackService.sPlaying);
        o.put("title", MediaPlaybackService.sTitle);
        o.put("subtitle", MediaPlaybackService.sSubtitle);
        call.resolve(o);
    }

    @PluginMethod
    public void getLog(PluginCall call) {
        JSObject o = new JSObject();
        o.put("log", MediaPlaybackService.readDiag(getContext()));
        call.resolve(o);
    }

    @PluginMethod
    public void hide(PluginCall call) {
        try {
            getContext().stopService(new Intent(getContext(), MediaPlaybackService.class));
        } catch (Exception ignored) {}
        call.resolve();
    }
}
