package id.posguard.pos;

import android.app.Activity;
import android.app.Presentation;
import android.content.Context;
import android.hardware.display.DisplayManager;
import android.os.Bundle;
import android.view.Display;
import android.view.ViewGroup;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.webkit.WebViewAssetLoader;

/**
 * Layar customer pada layar fisik kedua (POS desktop dual-screen). Memuat halaman yang sama dengan jendela
 * customer di web (`?display=1`) dari aset aplikasi; data tagihan dikirim dari JavaScript utama lewat plugin.
 */
final class CustomerDisplay {
    private final Activity activity;
    private Presentation presentation;
    private WebView webView;
    private boolean loaded = false;
    private String pending = "null";

    CustomerDisplay(Activity activity) {
        this.activity = activity;
    }

    static Display find(Context context) {
        DisplayManager dm = (DisplayManager) context.getSystemService(Context.DISPLAY_SERVICE);
        Display[] displays = dm.getDisplays(DisplayManager.DISPLAY_CATEGORY_PRESENTATION);
        return displays.length > 0 ? displays[0] : null;
    }

    /** Harus dipanggil di thread UI. Mengembalikan false bila tidak ada layar kedua. */
    boolean show(String viewJson) {
        Display display = find(activity);
        if (display == null) return false;
        pending = viewJson == null ? "null" : viewJson;
        if (presentation == null || presentation.getDisplay().getDisplayId() != display.getDisplayId()) {
            dismiss();
            presentation = new Presentation(activity, display) {
                @Override
                protected void onCreate(Bundle savedInstanceState) {
                    super.onCreate(savedInstanceState);
                    webView = build(getContext());
                    setContentView(webView, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                    webView.loadUrl("https://appassets.androidplatform.net/assets/public/index.html?display=1");
                }
            };
            loaded = false;
            presentation.show();
        } else {
            push();
        }
        return true;
    }

    void dismiss() {
        if (presentation != null) {
            presentation.dismiss();
            presentation = null;
            webView = null;
            loaded = false;
        }
    }

    private WebView build(Context context) {
        WebView w = new WebView(context);
        w.getSettings().setJavaScriptEnabled(true);
        w.getSettings().setAllowFileAccess(false);
        w.getSettings().setAllowContentAccess(false);
        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(context))
                .build();
        w.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                loaded = true;
                push();
            }
        });
        return w;
    }

    private void push() {
        if (webView != null && loaded) {
            webView.evaluateJavascript("window.__setDisplayView && window.__setDisplayView(" + pending + ")", null);
        }
    }
}
