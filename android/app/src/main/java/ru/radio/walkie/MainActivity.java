package ru.radio.walkie;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.provider.Settings;
import android.text.InputFilter;
import android.text.InputType;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.widget.EditText;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.webkit.WebViewAssetLoader;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/*
 * Рация для Android — рация с ПК как есть. В WebView открывается та же страница widget.html
 * со всеми скриптами из radio-walkie/web, без правок. Как в ПК-приложении (Electron), страница
 * получает window.radioDesktop — его даёт android/bridge.js вместо preload.js — и считает,
 * что работает в ПК-оболочке: то же меню, та же логика подключения к серверу.
 *
 * Связь с сервером идёт из Java (AirSocket) с тем же Origin, что у ПК-приложения (app://radio).
 */
public class MainActivity extends ComponentActivity {

    private static final String HOST = "appassets.androidplatform.net";
    private static final String PAGE = "https://" + HOST + "/assets/web/widget.html";
    private static final int MIC_REQUEST = 1;
    private static final String PREF_KEEP_SCREEN = "keep_screen";

    private static MainActivity instance; // только с главного потока

    private WebView web;
    private AirSocket air;
    private PermissionRequest pendingMic;
    private ValueCallback<Uri[]> pendingFile;
    private final androidx.activity.result.ActivityResultLauncher<String> pickImage = registerForActivityResult(
        new androidx.activity.result.contract.ActivityResultContracts.GetContent(), (uri) -> {
            if (pendingFile != null) pendingFile.onReceiveValue(uri != null ? new Uri[] { uri } : null);
            pendingFile = null;
        });
    // QR ключа SCR: результат сканера уходит в рацию (__walkieQr), отмена — null
    private final androidx.activity.result.ActivityResultLauncher<com.journeyapps.barcodescanner.ScanOptions> scanQr = registerForActivityResult(
        new com.journeyapps.barcodescanner.ScanContract(), (result) -> {
            String text = result != null ? result.getContents() : null;
            js("window.__walkieQr&&window.__walkieQr(" + (text != null ? JSONObject.quote(text) : "null") + ")");
        });
    private boolean wantBubble;        // включили кнопку поверх — ждём разрешения в настройках Android
    private AlertDialog textDialog;
    private SharedPreferences prefs;
    private Updater updater;
    private final Updater.Listener updateWatch = MainActivity::optionsChanged;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        instance = this;
        prefs = getSharedPreferences(WalkieService.PREFS, MODE_PRIVATE);
        updater = Updater.get(this);
        updater.canInstallNow = () -> !AirState.transmitting(); // посреди передачи не обновляемся
        updater.addListener(updateWatch);
        applyKeepScreen();
        setShowWhenLocked(WalkieService.lockScreenEnabled(this)); // открыть рацию можно поверх блокировки

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xff0d0e10);
        web = new WebView(this);
        web.setBackgroundColor(0xff0d0e10);
        root.addView(web);
        setContentView(root);
        // Рация не лезет под строку состояния и кнопки навигации
        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.ime());
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsetsCompat.CONSUMED;
        });

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);                 // настройки рации — в localStorage, как на ПК
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        // Ассеты рации лежат в APK (быстро) — кэш WebView для них не нужен и вреден: после обновления
        // приложения он мог отдать старые файлы вперемешку с новыми, отчего экран оставался пустым и
        // помогала только очистка данных. Кэш не используем, а при установке новой версии один раз
        // чистим уже накопленный. localStorage (настройки рации) не трогаем — он остаётся.
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        int cacheVer = prefs.getInt("web_cache_ver", -1);
        if (cacheVer != BuildConfig.VERSION_CODE) {
            web.clearCache(true);
            prefs.edit().putInt("web_cache_ver", BuildConfig.VERSION_CODE).apply();
        }

        air = new AirSocket(this, web);
        web.addJavascriptInterface(air, "AirSocket");
        web.addJavascriptInterface(new Shell(), "WalkieShell");

        WebViewAssetLoader assets = new WebViewAssetLoader.Builder()
            .setDomain(HOST)
            .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
            .build();

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (PAGE.equals(url.buildUpon().clearQuery().build().toString())) return page();
                return assets.shouldInterceptRequest(url);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !HOST.equals(request.getUrl().getHost()); // наружу страница не уходит
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> micRequest(request));
            }

            // Картинка для фона или экрана рации — из галереи (Внешний вид → Фон / Экран)
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pendingFile != null) pendingFile.onReceiveValue(null);
                pendingFile = callback;
                pickImage.launch("image/*");
                return true;
            }
        });

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                moveTaskToBack(true); // «Назад» сворачивает рацию: связь с сервером остаётся
            }
        });

        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, 2);
        }

        audio = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        audio.registerAudioDeviceCallback(headsetWatch, null);

        web.loadUrl(PAGE + "?view=widget");
    }

    /* ───────── Наушники во время передачи ─────────
     * Пока микрофон открыт, WebView держит телефон в режиме звонка и сам маршрут не меняет.
     * Подключили или отключили наушники во время передачи — переводим звонок на них (или обратно). */
    private AudioManager audio;
    private final AudioDeviceCallback headsetWatch = new AudioDeviceCallback() {
        @Override
        public void onAudioDevicesAdded(AudioDeviceInfo[] added) {
            routeCall();
        }

        @Override
        public void onAudioDevicesRemoved(AudioDeviceInfo[] removed) {
            routeCall();
        }
    };

    private static boolean isHeadset(AudioDeviceInfo d) {
        switch (d.getType()) {
            case AudioDeviceInfo.TYPE_WIRED_HEADSET:
            case AudioDeviceInfo.TYPE_WIRED_HEADPHONES:
            case AudioDeviceInfo.TYPE_USB_HEADSET:
            case AudioDeviceInfo.TYPE_BLUETOOTH_SCO:
                return true;
            default:
                return false;
        }
    }

    @SuppressWarnings("deprecation")
    private void routeCall() {
        if (audio.getMode() != AudioManager.MODE_IN_COMMUNICATION) return; // не звонок — Android сам разберётся
        AudioDeviceInfo headset = null;
        if (Build.VERSION.SDK_INT >= 31) {
            for (AudioDeviceInfo d : audio.getAvailableCommunicationDevices()) {
                if (isHeadset(d)) headset = d;
            }
            if (headset != null) audio.setCommunicationDevice(headset);
            else audio.clearCommunicationDevice();
        } else {
            for (AudioDeviceInfo d : audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
                if (isHeadset(d)) headset = d;
            }
            audio.setSpeakerphoneOn(headset == null);
        }
    }

    // widget.html как есть + адаптер: bridge.js первым в <head> (до скриптов рации), стили — последними
    private WebResourceResponse page() {
        try (InputStream in = getAssets().open("web/widget.html")) {
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            for (int n; (n = in.read(chunk)) > 0; ) buf.write(chunk, 0, n);
            String html = buf.toString("UTF-8")
                .replaceFirst("<head>", "<head>\n  <script src=\"/assets/android/changelog.js\"></script>\n  <script src=\"/assets/android/bridge.js\"></script>\n  <script src=\"/assets/android/look.js\"></script>\n  <script src=\"/assets/android/voice.js\"></script>\n  <script src=\"/assets/android/privacy.js\"></script>\n  <script src=\"/assets/android/channel.js\"></script>")
                .replaceFirst("</head>", "  <link rel=\"stylesheet\" href=\"/assets/android/android.css\">\n  <link rel=\"stylesheet\" href=\"/assets/android/look.css\">\n  <link rel=\"stylesheet\" href=\"/assets/android/skins.css\">\n</head>");
            return new WebResourceResponse("text/html", "utf-8",
                new ByteArrayInputStream(html.getBytes(StandardCharsets.UTF_8)));
        } catch (IOException e) {
            return null;
        }
    }

    // Микрофон: страница просит его при первой передаче — спрашиваем Android и отвечаем странице
    private void micRequest(PermissionRequest request) {
        boolean wantsMic = false;
        for (String r : request.getResources()) {
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) wantsMic = true;
        }
        if (!wantsMic) {
            request.deny();
            return;
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            request.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
            return;
        }
        if (pendingMic != null) pendingMic.deny();
        pendingMic = request;
        requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, MIC_REQUEST);
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code != MIC_REQUEST || pendingMic == null) return;
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) {
            pendingMic.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
            WalkieService.start(this); // теперь сервис может держать и микрофон
        } else {
            pendingMic.deny();
        }
        pendingMic = null;
    }

    @Override
    protected void onResume() {
        super.onResume();
        // Пока приложение на экране, Android разрешает запустить фоновый сервис (с микрофоном — если разрешён)
        WalkieService.start(this);
        updater.setForeground(this); // и проверка обновлений при каждом входе
        updater.resumed();           // вернулись из «разрешить установку» — ставим (и только тогда)
        // Вернулись из настроек «поверх других приложений»
        if (wantBubble) {
            wantBubble = false;
            if (Settings.canDrawOverlays(this)) WalkieService.setBubbleEnabled(this, true);
            optionsChanged();
        }
    }

    @Override
    protected void onPause() {
        updater.setForeground(null);
        super.onPause();
    }

    @Override
    protected void onStart() {
        super.onStart();
        WalkieService.appVisible(true);
    }

    @Override
    protected void onStop() {
        WalkieService.appVisible(false);
        super.onStop();
    }

    /* ───────── Снаружи: кнопка поверх приложений и уведомление ───────── */

    // Как горячая клавиша на ПК: ptt-down / ptt-up приходят в рацию через radioDesktop.onHotkey
    static void hotkey(String action) {
        MainActivity a = instance;
        if (a != null) a.js("window.__walkieHotkey&&window.__walkieHotkey(" + JSONObject.quote(action) + ")");
    }

    static void quitFromOutside() {
        MainActivity a = instance;
        if (a != null) a.finishAndRemoveTask();
    }

    static void openOverlaySettings(Context context) {
        MainActivity a = instance;
        if (a != null) a.wantBubble = true;
        Intent i = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + context.getPackageName()))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(i);
    }

    // Настройки поменяли не со страницы (из уведомления) — пусть панель настроек покажет новое
    static void optionsChanged() {
        MainActivity a = instance;
        if (a != null) a.js("window.__walkieOptions&&window.__walkieOptions(" + a.options() + ")");
    }

    private void js(String code) {
        web.post(() -> web.evaluateJavascript(code, null));
    }

    private String options() {
        JSONObject o = new JSONObject();
        try {
            o.put("bubble", WalkieService.bubbleEnabled(this) && Settings.canDrawOverlays(this));
            o.put("keepScreen", prefs.getBoolean(PREF_KEEP_SCREEN, false));
            o.put("lockScreen", WalkieService.lockScreenEnabled(this));
            o.put("version", BuildConfig.VERSION_NAME);
            o.put("update", updater.toJson());
        } catch (Exception ignored) {
            // JSONObject.put не бросает для этих значений
        }
        return o.toString();
    }

    private String torchCamera; // камера со вспышкой; "" — вспышки нет
    private boolean torchOn;

    private void setTorch(boolean on) {
        android.hardware.camera2.CameraManager cm =
            (android.hardware.camera2.CameraManager) getSystemService(Context.CAMERA_SERVICE);
        try {
            if (torchCamera == null) {
                torchCamera = "";
                for (String id : cm.getCameraIdList()) {
                    Boolean flash = cm.getCameraCharacteristics(id)
                        .get(android.hardware.camera2.CameraCharacteristics.FLASH_INFO_AVAILABLE);
                    if (Boolean.TRUE.equals(flash)) {
                        torchCamera = id;
                        break;
                    }
                }
            }
            if (torchCamera.isEmpty() || on == torchOn) return;
            cm.setTorchMode(torchCamera, on);
            torchOn = on;
        } catch (Exception ignored) {
            // камеру занял кто-то другой или вспышки нет — фонарик останется только на рации
        }
    }

    private void applyKeepScreen() {
        if (prefs.getBoolean(PREF_KEEP_SCREEN, false)) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    /* ───────── Ввод текста: позывной, адрес сервера, ключ SCR ───────── */

    private void textDialog(String code, String initial) {
        if (textDialog != null) return;
        EditText edit = new EditText(this);
        edit.setSingleLine(true);
        edit.setText(initial);
        edit.setSelectAllOnFocus(true);
        edit.setFilters(new InputFilter[] { new InputFilter.LengthFilter("NAME".equals(code) ? 24 : 64) });
        edit.setImeOptions(EditorInfo.IME_ACTION_DONE);
        String title;
        switch (code) {
            case "NAME":
                title = "Позывной";
                edit.setHint("Как вас слышат в эфире");
                edit.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
                break;
            case "SERVER":
                title = "Адрес сервера";
                edit.setHint("192.168.1.10:8765 или radio.example.ru");
                edit.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
                break;
            case "SCR":
                title = "Ключ шифрования";
                edit.setHint("Фраза из нескольких слов");
                edit.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD);
                break;
            default:
                title = "Ввод";
                edit.setInputType(InputType.TYPE_CLASS_TEXT);
        }
        int pad = Math.round(20 * getResources().getDisplayMetrics().density);
        FrameLayout box = new FrameLayout(this);
        box.setPadding(pad, pad / 2, pad, 0);
        box.addView(edit);

        AlertDialog dialog = new AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
            .setTitle(title)
            .setView(box)
            .setPositiveButton("Готово", (d, w) -> textDone(true, edit.getText().toString()))
            .setNegativeButton("Отмена", (d, w) -> textDone(false, null))
            .setOnCancelListener((d) -> textDone(false, null))
            .create();
        edit.setOnEditorActionListener((v, actionId, event) -> {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).performClick();
            return true;
        });
        dialog.getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE);
        textDialog = dialog;
        dialog.show();
        edit.requestFocus();
    }

    private void textDone(boolean ok, String text) {
        if (textDialog == null) return;
        textDialog = null;
        JSONObject r = new JSONObject();
        try {
            r.put("ok", ok);
            r.put("text", text == null ? "" : text);
        } catch (Exception ignored) {
            // не бросает
        }
        js("window.__walkieText&&window.__walkieText(" + r + ")");
    }

    @Override
    protected void onDestroy() {
        if (instance == this) instance = null;
        updater.removeListener(updateWatch);
        if (textDialog != null) textDialog.dismiss();
        if (audio != null) audio.unregisterAudioDeviceCallback(headsetWatch);
        setTorch(false);
        air.closeAll();
        if (isFinishing()) WalkieService.stop(this);
        web.destroy();
        super.onDestroy();
    }

    /* То, что на ПК делает окно Electron: свернуть, закрыть, клавиатура для ввода текста */
    private class Shell {
        @JavascriptInterface
        public void minimize() {
            runOnUiThread(() -> moveTaskToBack(true));
        }

        @JavascriptInterface
        public void quit() {
            runOnUiThread(() -> {
                WalkieService.stop(MainActivity.this);
                finishAndRemoveTask();
            });
        }

        // Рация начала ввод текста — показываем окно Android с полем ввода
        @JavascriptInterface
        public void editText(String code, String initial) {
            runOnUiThread(() -> textDialog(code, initial));
        }

        // Фонарик рации ☼ — настоящий фонарик телефона
        @JavascriptInterface
        public void torch(boolean on) {
            runOnUiThread(() -> setTorch(on));
        }

        @JavascriptInterface
        public void scanQr() {
            runOnUiThread(() -> {
                com.journeyapps.barcodescanner.ScanOptions o = new com.journeyapps.barcodescanner.ScanOptions();
                o.setDesiredBarcodeFormats(com.journeyapps.barcodescanner.ScanOptions.QR_CODE);
                o.setPrompt("Наведите на QR ключа на экране другой рации");
                o.setBeepEnabled(false);
                o.setOrientationLocked(false);
                scanQr.launch(o);
            });
        }

        @JavascriptInterface
        public void vibrate() {
            Vibrator v = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
            if (v != null && v.hasVibrator()) v.vibrate(VibrationEffect.createOneShot(25, VibrationEffect.DEFAULT_AMPLITUDE));
        }

        // Оповещение от хозяина эфира — в системную шторку уведомлений телефона
        @JavascriptInterface
        public void notify(String title, String text) {
            runOnUiThread(() -> WalkieService.showNotice(MainActivity.this, title, text));
        }

        // Обновления: проверить / скачать / установить — смотря что сейчас можно
        @JavascriptInterface
        public void update() {
            runOnUiThread(() -> {
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
            runOnUiThread(() -> updater.setAuto(on));
        }

        @JavascriptInterface
        public String options() {
            return MainActivity.this.options();
        }

        @JavascriptInterface
        public void setOption(String name, boolean on) {
            runOnUiThread(() -> {
                if ("bubble".equals(name)) {
                    if (on && !Settings.canDrawOverlays(MainActivity.this)) openOverlaySettings(MainActivity.this);
                    else WalkieService.setBubbleEnabled(MainActivity.this, on);
                } else if ("lockScreen".equals(name)) {
                    prefs.edit().putBoolean(WalkieService.PREF_LOCK, on).apply();
                    setShowWhenLocked(on);
                } else if ("keepScreen".equals(name)) {
                    prefs.edit().putBoolean(PREF_KEEP_SCREEN, on).apply();
                    applyKeepScreen();
                }
                optionsChanged();
            });
        }
    }
}
