package ru.radio.station;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import androidx.activity.ComponentActivity;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.documentfile.provider.DocumentFile;
import androidx.webkit.WebViewAssetLoader;
import org.json.JSONObject;

/*
 * Экран станции — страница assets/ui (в стиле ПК-программы «Радио»); всё, что звучит и уходит
 * в эфир, делает Station. Страница зовёт методы Station через window.StationApp, а состояние
 * получает четыре раза в секунду (window.__station), список треков — при изменении (window.__tracks).
 */
public class MainActivity extends ComponentActivity implements Station.Listener {

    private static final String HOST = "appassets.androidplatform.net";
    private static final String PAGE = "https://" + HOST + "/assets/ui/index.html";

    private WebView web;
    private Station station;
    private final Handler main = new Handler(Looper.getMainLooper());
    private Object tracksOf = null;
    private boolean micWanted;
    private Updater updater;
    private final Updater.Listener updateWatch = this::push;

    private final ActivityResultLauncher<Uri> pickFolder = registerForActivityResult(
        new ActivityResultContracts.OpenDocumentTree(), (uri) -> {
            if (uri == null) return;
            getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            DocumentFile dir = DocumentFile.fromTreeUri(this, uri);
            station.setFolder(uri, dir != null && dir.getName() != null ? dir.getName() : "Музыка");
        });

    // Картинка для фона приложения или дисплея — из галереи (🎨 → Фон / Дисплей)
    private ValueCallback<Uri[]> pendingFile;
    private final ActivityResultLauncher<String> pickImage = registerForActivityResult(
        new ActivityResultContracts.GetContent(), (uri) -> {
            if (pendingFile != null) pendingFile.onReceiveValue(uri != null ? new Uri[] { uri } : null);
            pendingFile = null;
        });

    private final ActivityResultLauncher<String> askMic = registerForActivityResult(
        new ActivityResultContracts.RequestPermission(), (granted) -> {
            if (granted && micWanted) {
                station.setMic(true);
                StationService.start(this); // теперь сервису можно держать и микрофон
            }
        });

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            push();
            main.postDelayed(this, 250);
        }
    };

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        station = Station.get(this);
        updater = Updater.get(this);
        updater.canInstallNow = () -> !station.onAir; // в эфире не обновляемся — поставим после

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xff0b0c0f);
        web = new WebView(this);
        web.setBackgroundColor(0xff0b0c0f);
        root.addView(web);
        setContentView(root);
        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.ime());
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsetsCompat.CONSUMED;
        });

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        // Ассеты станции лежат в APK — кэш WebView для них не нужен и после обновления мог отдать
        // старые файлы вперемешку с новыми (пустой экран, лечилось очисткой данных). Кэш не используем,
        // а при установке новой версии один раз чистим накопленный. localStorage (настройки) не трогаем.
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        android.content.SharedPreferences cachePrefs = getSharedPreferences("station_cache", MODE_PRIVATE);
        if (cachePrefs.getInt("web_cache_ver", -1) != BuildConfig.VERSION_CODE) {
            web.clearCache(true);
            cachePrefs.edit().putInt("web_cache_ver", BuildConfig.VERSION_CODE).apply();
        }
        web.addJavascriptInterface(new Bridge(), "StationApp");

        WebViewAssetLoader assets = new WebViewAssetLoader.Builder()
            .setDomain(HOST)
            .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
            .build();
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assets.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !HOST.equals(request.getUrl().getHost());
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pendingFile != null) pendingFile.onReceiveValue(null);
                pendingFile = callback;
                pickImage.launch("image/*");
                return true;
            }
        });

        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, 2);
        }
        web.loadUrl(PAGE);
    }

    @Override
    protected void onResume() {
        super.onResume();
        station.addListener(this);
        updater.addListener(updateWatch);
        updater.setForeground(this); // и проверка обновлений при каждом входе
        updater.resumed();           // вернулись из «разрешить установку» — ставим (и только тогда)
        main.post(tick);
    }

    @Override
    protected void onPause() {
        station.removeListener(this);
        updater.removeListener(updateWatch);
        updater.setForeground(null);
        main.removeCallbacks(tick);
        super.onPause();
    }

    @Override
    public void onStationChanged() {
        push();
    }

    // Состояние — каждый раз, список треков — только когда он поменялся
    private void push() {
        if (station.playlist != tracksOf) {
            tracksOf = station.playlist;
            web.evaluateJavascript("window.__tracks&&window.__tracks(" + station.titles() + ")", null);
        }
        JSONObject st = station.state();
        try {
            st.put("update", updater.toJson());
        } catch (Exception ignored) {
            // не бросает
        }
        web.evaluateJavascript("window.__station&&window.__station(" + st + ")", null);
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }

    private class Bridge {
        @JavascriptInterface
        public String state() {
            return station.state().toString();
        }

        @JavascriptInterface
        public String tracks() {
            return station.titles().toString();
        }

        @JavascriptInterface
        public void setServer(String address) {
            main.post(() -> station.setServer(address));
        }

        @JavascriptInterface
        public void setStation(String json) {
            main.post(() -> {
                try {
                    JSONObject o = new JSONObject(json);
                    station.setStation(o.optString("name"), o.optDouble("freq", station.freq),
                        o.optString("key"), o.optBoolean("rds", station.rds));
                } catch (Exception ignored) {
                    // страница прислала мусор — ничего не меняем
                }
            });
        }

        @JavascriptInterface
        public void pickFolder() {
            main.post(() -> pickFolder.launch(null));
        }

        @JavascriptInterface
        public void rescan() {
            main.post(() -> station.rescan());
        }

        @JavascriptInterface
        public void start() {
            main.post(() -> station.start());
        }

        @JavascriptInterface
        public void stop() {
            main.post(() -> station.stop());
        }

        @JavascriptInterface
        public void next() {
            main.post(() -> station.next());
        }

        @JavascriptInterface
        public void play(int index) {
            main.post(() -> station.play(index));
        }

        @JavascriptInterface
        public void setMode(String mode) {
            main.post(() -> station.setMode(mode));
        }

        @JavascriptInterface
        public void setMusic(int level) {
            main.post(() -> station.setMusicLevel(level));
        }

        @JavascriptInterface
        public void setMonitor(boolean on) {
            main.post(() -> station.setMonitor(on));
        }

        // Обновления: проверить / скачать / установить — смотря что сейчас можно
        @JavascriptInterface
        public void update() {
            main.post(() -> {
                switch (updater.state) {
                    case "available":
                        updater.download();
                        break;
                    case "ready":
                    case "confirm":
                        updater.installByUser();
                        break;
                    default:
                        updater.check(true);
                }
            });
        }

        @JavascriptInterface
        public void setUpdateAuto(boolean on) {
            main.post(() -> updater.setAuto(on));
        }

        // Голос поверх музыки: держите кнопку — говорите
        @JavascriptInterface
        public void mic(boolean on) {
            main.post(() -> {
                micWanted = on;
                if (!station.setMic(on) && on) askMic.launch(Manifest.permission.RECORD_AUDIO);
            });
        }

        // Полный выход: глушим эфир и фоновый сервис, закрываем окно и завершаем процесс,
        // чтобы станция не оставалась висеть в фоне и не занимала память.
        @JavascriptInterface
        public void quit() {
            main.post(() -> {
                try { station.stop(); } catch (Exception ignored) { /* уже */ }
                try { StationService.stop(MainActivity.this); } catch (Exception ignored) { /* уже */ }
                finishAndRemoveTask();
                main.postDelayed(() -> System.exit(0), 200); // добить процесс, удерживаемый сервисом/аудио
            });
        }
    }
}
