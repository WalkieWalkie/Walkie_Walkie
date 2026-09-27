package ru.radio.walkie;

import android.app.Activity;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import androidx.core.app.NotificationCompat;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Arrays;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import org.json.JSONArray;
import org.json.JSONObject;

/*
 * Обновления из релизов GitHub (WalkieWalkie/Walkie_Walkie).
 *   1. Смотрим релизы: APK вида <PREFIX>1.0.N.apk, где N больше нашего номера сборки.
 *   2. Скачиваем в фоне и проверяем: тот же пакет и тот же ключ подписи — иначе не ставим.
 *   3. Ставим системным установщиком (PackageInstaller). Первый раз Android спросит подтверждение;
 *      дальше приложение — «владелец» своих обновлений, и на Android 12+ они ставятся без вопросов.
 * Ставим, только когда приложению не мешает (canInstallNow): рация не передаёт, станция не в эфире.
 */
public final class Updater {

    public interface Listener {
        void onUpdateChanged();
    }

    private static final String RELEASES = "https://api.github.com/repos/WalkieWalkie/Walkie_Walkie/releases?per_page=20";
    private static final String CHANNEL = "updates";
    // Запасной список релизов: лента страницы GitHub. У API лимит 60 запросов в час на IP, а на мобильном
    // интернете за одним IP сидит пол-города — API отвечает 403, лента — нет
    private static final String FEED = "https://github.com/WalkieWalkie/Walkie_Walkie/releases.atom";
    private static final String DOWNLOAD = "https://github.com/WalkieWalkie/Walkie_Walkie/releases/download/";
    private static final long CHECK_EVERY_MS = TimeUnit.HOURS.toMillis(1);        // в фоне
    private static final long CHECK_ON_OPEN_MS = TimeUnit.MINUTES.toMillis(1);    // при каждом входе (минута — от повторов)
    private static final int NOTIFY_ID = 77;

    private static Updater instance;

    public static synchronized Updater get(Context context) {
        if (instance == null) instance = new Updater(context.getApplicationContext());
        return instance;
    }

    private final Context context;
    private final SharedPreferences prefs;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final CopyOnWriteArrayList<Listener> listeners = new CopyOnWriteArrayList<>();
    private final OkHttpClient http = new OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .build();

    // Что показывать: idle, checking, latest, available, downloading, ready, installing, confirm, error
    public volatile String state = "idle";
    public volatile String latest;   // «1.0.N» — последняя найденная версия
    public volatile String error;
    public volatile int progress;    // % скачивания
    private volatile String assetUrl;
    private volatile File apk;
    private volatile boolean busy;
    private volatile boolean waitingPermission; // ушли в «разрешить установку» — по возвращении ставим
    private volatile boolean cancelled;         // человек отменил установку — сами больше не ставим
    private volatile boolean fallbackTried;     // системная сессия не справилась — пробовали обычный установщик
    private volatile Activity foreground;       // экран приложения, если он сейчас открыт
    private final Pattern assetName = Pattern.compile(Pattern.quote(BuildConfig.UPDATE_PREFIX) + "1\\.0\\.(\\d+)\\.apk");

    // Можно ли ставить прямо сейчас (не в эфире) — задаёт приложение
    public volatile java.util.function.BooleanSupplier canInstallNow = () -> true;

    private Updater(Context context) {
        this.context = context;
        prefs = context.getSharedPreferences("updates", Context.MODE_PRIVATE);
    }

    public int currentBuild() {
        return BuildConfig.VERSION_CODE - 100;
    }

    public boolean auto() {
        return prefs.getBoolean("auto", true);
    }

    public void setAuto(boolean on) {
        prefs.edit().putBoolean("auto", on).apply();
        changed();
        if (on) checkSoon();
    }

    public void addListener(Listener l) {
        listeners.addIfAbsent(l);
    }

    public void removeListener(Listener l) {
        listeners.remove(l);
    }

    private void changed() {
        main.post(() -> {
            for (Listener l : listeners) l.onUpdateChanged();
        });
    }

    public JSONObject toJson() {
        JSONObject o = new JSONObject();
        try {
            o.put("state", state).put("latest", latest).put("error", error).put("progress", progress)
                .put("current", BuildConfig.VERSION_NAME).put("auto", auto())
                .put("canInstall", context.getPackageManager().canRequestPackageInstalls());
        } catch (Exception ignored) {
            // не бросает
        }
        return o;
    }

    // Проверка в фоне — не чаще раза в час
    public void checkSoon() {
        checkIfOlder(CHECK_EVERY_MS);
    }

    private void checkIfOlder(long age) {
        if (midway()) return; // уже скачиваем или ставим — не сбиваем
        long last = prefs.getLong("lastCheck", 0);
        // Проверяем всегда; «Обновлять автоматически» решает только, качать ли и ставить самим
        if (System.currentTimeMillis() - last > age) check(false);
    }

    // Экран приложения открыт / закрыт. Окна установки открываем с экрана: из фона
    // Android (особенно HyperOS/MIUI) их не показывает и отменяет установку
    public void setForeground(Activity activity) {
        foreground = activity;
        if (activity != null) checkIfOlder(CHECK_ON_OPEN_MS);
    }

    private void show(Intent intent) {
        Activity a = foreground;
        main.post(() -> {
            try {
                if (a != null && !a.isFinishing()) a.startActivity(intent);
                else context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } catch (RuntimeException e) {
                // из фона открыть нельзя — остаётся уведомление
            }
        });
    }

    // Обновление уже найдено и в работе (качается, скачано, ставится)
    private boolean midway() {
        String s = state;
        return "downloading".equals(s) || "ready".equals(s) || "installing".equals(s) || "confirm".equals(s);
    }

    public void check(boolean byUser) {
        if (busy || (!byUser && midway())) return;
        busy = true;
        state = "checking";
        error = null;
        changed();
        new Thread(() -> {
            try {
                prefs.edit().putLong("lastCheck", System.currentTimeMillis()).apply();
                int best = currentBuild();
                String url = null;
                String[] found;
                try {
                    found = fromApi(best);
                } catch (Exception apiFailed) {
                    found = fromFeed(best); // API недоступен (лимит, блокировка) — берём ленту релизов
                }
                if (found != null) {
                    best = Integer.parseInt(found[0]);
                    url = found[1];
                }
                if (url == null) {
                    latest = BuildConfig.VERSION_NAME;
                    state = "latest";
                    busy = false;
                    changed();
                    return;
                }
                latest = "1.0." + best;
                assetUrl = url;
                state = "available";
                busy = false;
                changed();
                announce();
                if (auto() || byUser) download();
            } catch (Exception e) {
                fail("не проверить: " + e.getMessage());
            }
        }, "update-check").start();
    }

    // Новее нашей: { номер, ссылка на APK } или null
    private String[] fromApi(int current) throws Exception {
        int best = current;
        String url = null;
        Request req = new Request.Builder().url(RELEASES).header("Accept", "application/vnd.github+json").build();
        try (Response r = http.newCall(req).execute()) {
            if (!r.isSuccessful()) throw new Exception("GitHub ответил " + r.code());
            JSONArray releases = new JSONArray(r.body().string());
            for (int i = 0; i < releases.length(); i++) {
                JSONObject rel = releases.getJSONObject(i);
                if (rel.optBoolean("draft") || rel.optBoolean("prerelease")) continue;
                JSONArray assets = rel.optJSONArray("assets");
                for (int j = 0; assets != null && j < assets.length(); j++) {
                    JSONObject a = assets.getJSONObject(j);
                    Matcher m = assetName.matcher(a.optString("name"));
                    if (m.matches() && Integer.parseInt(m.group(1)) > best) {
                        best = Integer.parseInt(m.group(1));
                        url = a.optString("browser_download_url");
                    }
                }
            }
        }
        return url == null ? null : new String[] { String.valueOf(best), url };
    }

    // Лента релизов: теги walkie-v1.0.N (рация) / station-v1.0.N (станция) — не голый semver, чтобы
    // автообновление ПК-станции (electron-updater) их не путало со своими релизами. APK лежит по
    // постоянному адресу. Основной путь (fromApi) ищет по имени файла APK и от тега не зависит.
    private String[] fromFeed(int current) throws Exception {
        String tagPrefix = "Station-".equals(BuildConfig.UPDATE_PREFIX) ? "station-v" : "walkie-v";
        Request req = new Request.Builder().url(FEED).header("Accept", "application/atom+xml").build();
        String body;
        try (Response r = http.newCall(req).execute()) {
            if (!r.isSuccessful()) throw new Exception("GitHub ответил " + r.code());
            body = r.body().string();
        }
        Matcher m = Pattern.compile("/releases/tag/" + Pattern.quote(tagPrefix) + "1\\.0\\.(\\d+)\"").matcher(body);
        int best = current;
        while (m.find()) best = Math.max(best, Integer.parseInt(m.group(1)));
        if (best == current) return null;
        String tag = tagPrefix + "1.0." + best;
        return new String[] { String.valueOf(best), DOWNLOAD + tag + "/" + BuildConfig.UPDATE_PREFIX + "1.0." + best + ".apk" };
    }

    // Нашли новую версию — одно уведомление на версию: «Доступно обновление»
    private void announce() {
        String v = latest;
        if (v == null || v.equals(prefs.getString("announced", null))) return;
        prefs.edit().putString("announced", v).apply();
        Intent open = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        if (open == null) return;
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        String app = String.valueOf(context.getApplicationInfo().loadLabel(context.getPackageManager()));
        main.post(() -> notifyUser("Доступно обновление: " + app + " " + v,
            auto() ? "Скачиваю и поставлю сам. Нажмите, чтобы открыть" : "Нажмите, чтобы обновить", open));
    }

    private void fail(String why) {
        error = why;
        state = "error";
        busy = false;
        changed();
    }

    public void download() {
        if (busy || assetUrl == null) return;
        busy = true;
        state = "downloading";
        progress = 0;
        cancelled = false;
        fallbackTried = false;
        changed();
        new Thread(() -> {
            File dir = new File(context.getCacheDir(), "updates");
            dir.mkdirs();
            File[] old = dir.listFiles();
            if (old != null) for (File f : old) f.delete();
            File out = new File(dir, "update.apk");
            try (Response r = http.newCall(new Request.Builder().url(assetUrl).build()).execute()) {
                if (!r.isSuccessful()) throw new Exception("GitHub ответил " + r.code());
                long total = r.body().contentLength();
                try (InputStream in = r.body().byteStream(); OutputStream os = new FileOutputStream(out)) {
                    byte[] buf = new byte[64 * 1024];
                    long done = 0;
                    int lastPct = -1;
                    for (int n; (n = in.read(buf)) > 0; ) {
                        os.write(buf, 0, n);
                        done += n;
                        int pct = total > 0 ? (int) (done * 100 / total) : 0;
                        if (pct != lastPct) {
                            lastPct = pct;
                            progress = pct;
                            changed();
                        }
                    }
                }
                verify(out);
                apk = out;
                state = "ready";
                busy = false;
                changed();
                if (auto()) main.post(this::installIfIdle);
            } catch (Exception e) {
                out.delete();
                fail("не скачать: " + e.getMessage());
            }
        }, "update-download").start();
    }

    // Тот же пакет, версия новее, тот же ключ подписи — иначе это не наше обновление
    @SuppressWarnings("deprecation")
    private void verify(File file) throws Exception {
        PackageManager pm = context.getPackageManager();
        int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo theirs = pm.getPackageArchiveInfo(file.getPath(), flags);
        PackageInfo ours = pm.getPackageInfo(context.getPackageName(), flags);
        if (theirs == null || !context.getPackageName().equals(theirs.packageName)) throw new Exception("это не то приложение");
        if (theirs.getLongVersionCode() <= ours.getLongVersionCode()) throw new Exception("версия не новее");
        if (!Arrays.equals(signatures(theirs), signatures(ours))) throw new Exception("подпись не совпадает");
    }

    @SuppressWarnings("deprecation")
    private static Signature[] signatures(PackageInfo p) {
        if (Build.VERSION.SDK_INT >= 28 && p.signingInfo != null) {
            return p.signingInfo.hasMultipleSigners() ? p.signingInfo.getApkContentsSigners() : p.signingInfo.getSigningCertificateHistory();
        }
        return p.signatures;
    }

    // Экран снова на виду: если ходили разрешать установку — продолжаем
    public void resumed() {
        if (waitingPermission && !needsPermission()) {
            waitingPermission = false;
            install();
        }
    }

    public void installIfIdle() {
        if (!"ready".equals(state) || cancelled || waitingPermission) return;
        if (canInstallNow.getAsBoolean()) install();
        else main.postDelayed(this::installIfIdle, TimeUnit.MINUTES.toMillis(1)); // закончат эфир — поставим
    }

    // Нужна галочка «Разрешить установку из этого источника» — один раз
    public boolean needsPermission() {
        return !context.getPackageManager().canRequestPackageInstalls();
    }

    public Intent permissionIntent() {
        return new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + context.getPackageName()))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    }

    // Установка по кнопке — после «Отмены» тоже можно
    public void installByUser() {
        cancelled = false;
        if ("confirm".equals(state)) state = "ready"; // окно Android закрыли без ответа — пробуем заново
        if (needsPermission()) {
            waitingPermission = true;
            show(permissionIntent());
            return;
        }
        if (fallbackTried && apk != null) {
            // Системная сессия на этом телефоне уже не справилась — сразу обычный установщик
            fallbackTried = false;
            fallbackInstall("не установить");
            return;
        }
        install();
    }

    public void install() {
        File file = apk;
        if (file == null || !file.exists()) return;
        if ("installing".equals(state) || "confirm".equals(state)) return; // уже ставим — ждём ответа Android
        if (needsPermission()) {
            waitingPermission = true;
            state = "ready";
            error = "разрешите установку обновлений";
            changed();
            notifyUser("Обновление " + latest + " скачано", "Нажмите и разрешите установку обновлений", permissionIntent());
            return;
        }
        state = "installing";
        error = null;
        changed();
        new Thread(() -> {
            try {
                PackageInstaller pi = context.getPackageManager().getPackageInstaller();
                // Недоделанные прошлые попытки мешают новой — закрываем
                for (PackageInstaller.SessionInfo old : pi.getMySessions()) {
                    try {
                        pi.abandonSession(old.getSessionId());
                    } catch (RuntimeException ignored) {
                        // уже закрыта
                    }
                }
                PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
                params.setAppPackageName(context.getPackageName());
                params.setSize(file.length());
                if (Build.VERSION.SDK_INT >= 31) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
                if (Build.VERSION.SDK_INT >= 34) params.setRequestUpdateOwnership(true);
                int id = pi.createSession(params);
                try (PackageInstaller.Session session = pi.openSession(id)) {
                    try (InputStream in = new java.io.FileInputStream(file);
                         OutputStream os = session.openWrite("app.apk", 0, file.length())) {
                        byte[] buf = new byte[64 * 1024];
                        for (int n; (n = in.read(buf)) > 0; ) os.write(buf, 0, n);
                        session.fsync(os);
                    }
                    int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
                    PendingIntent done = PendingIntent.getBroadcast(context, id,
                        new Intent(context, UpdateReceiver.class).setAction(UpdateReceiver.ACTION_STATUS), flags);
                    session.commit(done.getIntentSender());
                }
            } catch (Exception e) {
                fallbackInstall("не установить: " + e.getMessage());
            }
        }, "update-install").start();
    }

    // Запасной путь — обычный установщик APK, как при установке файла вручную
    private void fallbackInstall(String why) {
        File file = apk;
        if (fallbackTried || file == null || !file.exists()) {
            fail(why);
            return;
        }
        fallbackTried = true;
        Uri uri = androidx.core.content.FileProvider.getUriForFile(context, context.getPackageName() + ".updates", file);
        Intent view = new Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        state = "confirm";
        error = null;
        changed();
        show(view);
        notifyUser("Обновление " + latest + " готово", "Нажмите, чтобы установить", view);
    }

    // Итог установки (из UpdateReceiver)
    void installResult(int status, String message, Intent confirm) {
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION && confirm != null) {
            confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            state = "confirm"; // ждём, что ответят в окне Android, — сами ничего не повторяем
            changed();
            show(confirm);
            notifyUser("Обновление " + latest + " готово", "Нажмите, чтобы установить", confirm);
        } else if (status == PackageInstaller.STATUS_FAILURE_ABORTED && !fallbackTried) {
            // Отмену часто присылает сама система (окно не дали показать) — пробуем обычный установщик
            state = "ready";
            fallbackInstall("Android отменил установку" + (message != null ? " (" + message + ")" : ""));
        } else if (status == PackageInstaller.STATUS_FAILURE_ABORTED) {
            cancelled = true; // сами больше не предлагаем — только по кнопке «Установить»
            state = "ready";
            error = "установку отменили — нажмите «Установить»";
            changed();
        } else if (status != PackageInstaller.STATUS_SUCCESS) {
            state = "ready";
            fallbackInstall("не установить: " + message);
        }
        // STATUS_SUCCESS — Android уже перезапускает приложение новой версией
    }

    void notifyUser(String title, String text, Intent action) {
        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        NotificationChannel ch = new NotificationChannel(CHANNEL, "Обновления", NotificationManager.IMPORTANCE_DEFAULT);
        nm.createNotificationChannel(ch);
        PendingIntent tap = PendingIntent.getActivity(context, NOTIFY_ID, action,
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        nm.notify(NOTIFY_ID, new NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(tap)
            .setAutoCancel(true)
            .build());
    }
}
