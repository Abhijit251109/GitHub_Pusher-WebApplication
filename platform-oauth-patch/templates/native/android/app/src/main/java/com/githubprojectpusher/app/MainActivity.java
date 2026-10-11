package com.githubprojectpusher.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;

/**
 * Handles the custom-scheme return from the server-mediated GitHub OAuth flow.
 * GitHub authorization and token exchange remain server-side; this Activity only
 * forwards the short-lived, single-use login code to the hosted login page.
 */
public class MainActivity extends BridgeActivity {
    private static final String OAUTH_SCHEME = "com.githubprojectpusher.app";
    private static final String OAUTH_HOST = "auth";
    private static final String OAUTH_PATH = "/callback";
    private String pendingOAuthCode;
    private String pendingOAuthNonce;
    private int bridgeRetryCount;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        handleOAuthReturn(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleOAuthReturn(intent);
    }

    private void handleOAuthReturn(Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) return;

        Uri callback = intent.getData();
        if (callback == null
                || !OAUTH_SCHEME.equals(callback.getScheme())
                || !OAUTH_HOST.equals(callback.getHost())
                || !OAUTH_PATH.equals(callback.getPath())) return;

        String code = callback.getQueryParameter("code");
        String nonce = callback.getQueryParameter("nonce");
        if (code == null || code.isEmpty() || nonce == null || nonce.isEmpty()) return;

        pendingOAuthCode = code;
        pendingOAuthNonce = nonce;
        bridgeRetryCount = 0;
        forwardPendingOAuthReturn();
    }

    private void forwardPendingOAuthReturn() {
        if (pendingOAuthCode == null || pendingOAuthNonce == null) return;

        Bridge bridge = getBridge();
        if (bridge == null || bridge.getWebView() == null) {
            if (bridgeRetryCount++ < 50) {
                new Handler(Looper.getMainLooper()).postDelayed(this::forwardPendingOAuthReturn, 100);
            }
            return;
        }

        WebView webView = bridge.getWebView();
        String baseUrl = bridge.getServerUrl();
        if (baseUrl == null || baseUrl.trim().isEmpty()) {
            String currentUrl = webView.getUrl();
            if (currentUrl != null) {
                Uri current = Uri.parse(currentUrl);
                baseUrl = new Uri.Builder()
                        .scheme(current.getScheme())
                        .authority(current.getAuthority())
                        .build()
                        .toString();
            }
        }
        if (baseUrl == null || baseUrl.trim().isEmpty()) {
            baseUrl = "https://github-pusher-g3ac.onrender.com";
        }
        while (baseUrl.endsWith("/")) baseUrl = baseUrl.substring(0, baseUrl.length() - 1);

        final String destination = baseUrl + "/login.html?code=" + Uri.encode(pendingOAuthCode)
                + "&nonce=" + Uri.encode(pendingOAuthNonce) + "&source=android";
        webView.post(() -> {
            webView.loadUrl(destination);
            pendingOAuthCode = null;
            pendingOAuthNonce = null;
            bridgeRetryCount = 0;
        });
    }
}
