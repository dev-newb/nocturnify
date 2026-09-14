package dev.rich.spotifytv

import android.annotation.SuppressLint
import android.app.Activity
import android.net.Uri
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
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject

/**
 * Thin native shell: one full-screen WebView serving the bundled web app from
 * https://appassets.androidplatform.net/assets/ (a secure origin, required by EME/Widevine).
 *
 * Background audio: a MediaSession + foreground service (PlaybackService) keeps the process
 * — and the WebView's audio — alive after the user leaves the app. The page pushes its play
 * state here via a WebMessageListener scoped to our own origin; media buttons flow back the
 * other way, from the session callback into player.* JS calls.
 */
class MainActivity : Activity() {

    private lateinit var web: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        PlaybackService.ensureSession(this)

        val assets = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        web = WebView(this).apply {
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                mediaPlaybackRequiresUserGesture = false
                userAgentString = DESKTOP_UA
                cacheMode = WebSettings.LOAD_DEFAULT
            }
            webViewClient = object : WebViewClientCompat() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                    assets.shouldInterceptRequest(request.url)
            }
            webChromeClient = object : WebChromeClient() {
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

        // Page -> native: playback state, ONLY from our own origin (never accounts.spotify.com).
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(web, "AndroidBridge", setOf(ORIGIN)) { _, message, _, _, _ ->
                try {
                    val o = JSONObject(message.data ?: "{}")
                    PlaybackService.push(this, o.optBoolean("playing"), o.optString("title"), o.optString("artist"))
                } catch (e: Exception) { Log.w(TAG, "bridge parse: ${e.message}") }
            }
        }
        // Session (media buttons) -> page.
        PlaybackService.controlSink = { js -> runOnUiThread { web.evaluateJavascript(js, null) } }

        val page = intent.getStringExtra("page") ?: "index.html"
        web.loadUrl("$ORIGIN/assets/$page")
    }

    override fun onNewIntent(intent: android.content.Intent) {
        super.onNewIntent(intent)
        intent.getStringExtra("page")?.let { web.loadUrl("$ORIGIN/assets/$it") }
    }

    // NB: deliberately no onPause/onStop override that pauses the WebView — audio must keep
    // running in the background. The foreground service keeps the process alive; onStop is the
    // resting state when the user presses Home.

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        when (keyCode) {
            KeyEvent.KEYCODE_BACK -> {
                web.evaluateJavascript("typeof onTvBack==='function' && onTvBack()") { consumed ->
                    if (consumed != "true") { if (web.canGoBack()) web.goBack() else finish() }
                }
                return true
            }
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_MEDIA_PLAY, KeyEvent.KEYCODE_MEDIA_PAUSE,
            KeyEvent.KEYCODE_MEDIA_NEXT, KeyEvent.KEYCODE_MEDIA_PREVIOUS, KeyEvent.KEYCODE_MEDIA_STOP -> {
                web.evaluateJavascript("typeof onTvKey==='function' && onTvKey(${keyCode})", null)
                return true
            }
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onDestroy() {
        // Real teardown only (back-out / task swipe): stop audio and release.
        PlaybackService.controlSink = null
        PlaybackService.push(this, false, "", "")
        stopService(android.content.Intent(this, PlaybackService::class.java))
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
