package dev.rich.spotifytv

import android.annotation.SuppressLint
import android.app.Activity
import android.os.Bundle
import android.util.Log
import android.view.KeyEvent
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat

/**
 * A thin native shell: one full-screen WebView that serves the bundled web app from
 * https://appassets.androidplatform.net/assets/ (a secure origin, which EME/Widevine requires).
 * Everything interesting lives in assets/.
 */
class MainActivity : Activity() {

    private lateinit var web: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        val assets = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        web = WebView(this).apply {
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true                  // localStorage for tokens
                mediaPlaybackRequiresUserGesture = false
                userAgentString = DESKTOP_UA              // the Spotify SDK sniffs for a desktop browser
                cacheMode = WebSettings.LOAD_DEFAULT
            }
            webViewClient = object : WebViewClientCompat() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                    assets.shouldInterceptRequest(request.url)
            }
            webChromeClient = object : WebChromeClient() {
                // Widevine: Chromium asks the embedder for PROTECTED_MEDIA_ID. Without this grant,
                // requestMediaKeySystemAccess rejects and DRM playback fails with no obvious error.
                override fun onPermissionRequest(request: PermissionRequest) {
                    val drm = request.resources.filter { it == PermissionRequest.RESOURCE_PROTECTED_MEDIA_ID }
                    if (drm.isNotEmpty()) request.grant(drm.toTypedArray()) else request.deny()
                }
                override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                    Log.d(TAG, "${m.message()}  (${m.sourceId().substringAfterLast('/')}:${m.lineNumber()})")
                    return true
                }
            }
        }
        setContentView(web)

        // `adb shell am start -n dev.rich.spotifytv/.MainActivity -e page eme-test.html` for diagnostics.
        val page = intent.getStringExtra("page") ?: "index.html"
        web.loadUrl("$ORIGIN/assets/$page")
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        when (keyCode) {
            // Give the page first refusal on Back; it returns true if it closed a view.
            KeyEvent.KEYCODE_BACK -> {
                web.evaluateJavascript("typeof onTvBack==='function' && onTvBack()") { consumed ->
                    if (consumed != "true") { if (web.canGoBack()) web.goBack() else finish() }
                }
                return true
            }
            // Remote transport keys don't always reach the page as DOM events; forward them explicitly.
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_MEDIA_PLAY, KeyEvent.KEYCODE_MEDIA_PAUSE,
            KeyEvent.KEYCODE_MEDIA_NEXT, KeyEvent.KEYCODE_MEDIA_PREVIOUS, KeyEvent.KEYCODE_MEDIA_STOP -> {
                web.evaluateJavascript("typeof onTvKey==='function' && onTvKey(${keyCode})", null)
                return true
            }
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onDestroy() {
        web.destroy()
        super.onDestroy()
    }

    companion object {
        private const val TAG = "SpotifyTV"
        const val ORIGIN = "https://appassets.androidplatform.net"
        const val DESKTOP_UA =
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
    }
}
