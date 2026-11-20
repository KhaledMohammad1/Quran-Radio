package com.quranradio.app;

import android.content.Context;
import android.os.Bundle;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(MediaControlPlugin.class);
        super.onCreate(savedInstanceState);
        applyThemeBackground();
    }

    /** Use the saved app theme (dark / light) for the window + web view background, so nothing white flashes. */
    private void applyThemeBackground() {
        try {
            boolean dark = getSharedPreferences("qr_prefs", Context.MODE_PRIVATE).getBoolean("dark", false);
            int color = dark ? 0xFF121212 : 0xFFF4F6F8;
            getWindow().getDecorView().setBackgroundColor(color);
            WebView wv = getBridge() != null ? getBridge().getWebView() : null;
            if (wv != null) wv.setBackgroundColor(color);
        } catch (Exception ignored) {}
    }
}
