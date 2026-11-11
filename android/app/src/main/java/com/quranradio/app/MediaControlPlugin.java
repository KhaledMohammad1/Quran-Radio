package com.quranradio.app;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.core.content.ContextCompat;

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
    }

    @Override
    protected void handleOnDestroy() {
        if (MediaPlaybackService.listener == this) {
            MediaPlaybackService.listener = null;
        }
        // The web view (and the audio with it) is gone, so remove the notification too.
        try {
            getContext().stopService(new Intent(getContext(), MediaPlaybackService.class));
        } catch (Exception ignored) {}
    }

    @Override
    public void onAction(String action) {
        JSObject data = new JSObject();
        data.put("action", action);
        notifyListeners("action", data);
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

    @PluginMethod
    public void show(PluginCall call) {
        Context ctx = getContext();
        Intent i = new Intent(ctx, MediaPlaybackService.class);
        i.setAction(MediaPlaybackService.ACTION_SHOW);
        i.putExtra("title", call.getString("title", ""));
        i.putExtra("subtitle", call.getString("subtitle", ""));
        Boolean playing = call.getBoolean("playing", true);
        i.putExtra("playing", playing == null || playing.booleanValue());
        i.putExtra("lblPlay", call.getString("lblPlay", "Play"));
        i.putExtra("lblPause", call.getString("lblPause", "Pause"));
        i.putExtra("lblNext", call.getString("lblNext", "Next"));
        i.putExtra("lblPrev", call.getString("lblPrev", "Previous"));
        i.putExtra("lblStop", call.getString("lblStop", "Stop"));
        try {
            ContextCompat.startForegroundService(ctx, i);
            call.resolve();
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()));
        }
    }

    @PluginMethod
    public void hide(PluginCall call) {
        try {
            getContext().stopService(new Intent(getContext(), MediaPlaybackService.class));
        } catch (Exception ignored) {}
        call.resolve();
    }
}
