package ru.radio.walkie;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.provider.Settings;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

/*
 * Рация в фоне. Сам звук — в WebView, как на ПК; сервис:
 *   • держит процессор и Wi-Fi, чтобы Android не усыпил рацию со свёрнутым приложением;
 *   • показывает постоянное уведомление: на связи ли рация, канал, кто говорит;
 *   • показывает кнопку PTT поверх других приложений (PttBubble), когда рация свёрнута.
 */
public class WalkieService extends Service implements AirState.Listener {

    static final String PREFS = "walkie";
    static final String PREF_BUBBLE = "bubble";
    static final String PREF_LOCK = "lock_screen"; // рация и кнопка PTT на экране блокировки

    private static final String CHANNEL = "walkie-status";
    private static final int NOTIFICATION_ID = 1;
    private static final String NOTICE_CHANNEL = "walkie-notice";
    private static final int NOTICE_ID = 42;
    private static final String ACTION_QUIT = "ru.radio.walkie.QUIT";
    private static final String ACTION_BUBBLE = "ru.radio.walkie.BUBBLE";
    private static final String ACTION_TALK = "ru.radio.walkie.TALK";

    private static volatile boolean appVisible = true;
    private static WalkieService instance; // только с главного потока

    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private PttBubble bubble;
    private String shownText = null;
    private final android.os.Handler timers = new android.os.Handler(android.os.Looper.getMainLooper());
    // Рация работает сутками — проверяем обновления и в фоне (сам Updater ходит не чаще раза в 6 ч)
    private final Runnable updateTimer = new Runnable() {
        @Override
        public void run() {
            Updater.get(WalkieService.this).checkSoon();
            timers.postDelayed(this, 30 * 60 * 1000L);
        }
    };

    public static void start(Context context) {
        try {
            ContextCompat.startForegroundService(context, new Intent(context, WalkieService.class));
        } catch (RuntimeException e) {
            // Android не дал запустить сервис (например, приложение уже в фоне) — рация работает, пока на экране
        }
    }

    public static void stop(Context context) {
        context.stopService(new Intent(context, WalkieService.class));
    }

    // Рация на экране — кнопка поверх не нужна; свернули — показываем (вызывать с главного потока)
    public static void appVisible(boolean visible) {
        appVisible = visible;
        if (instance != null) instance.refresh();
    }

    static boolean lockScreenEnabled(Context context) {
        return context.getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean(PREF_LOCK, true);
    }

    // Экран включился на заблокированном телефоне — кнопка PTT поверх блокировки; разблокировали — убираем
    private final android.content.BroadcastReceiver screenWatch = new android.content.BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            String a = intent.getAction();
            if (Intent.ACTION_SCREEN_ON.equals(a)) {
                android.app.KeyguardManager km = (android.app.KeyguardManager) getSystemService(KEYGUARD_SERVICE);
                if (km.isKeyguardLocked() && bubbleEnabled(context) && lockScreenEnabled(context) && Settings.canDrawOverlays(context)) {
                    try {
                        startActivity(new Intent(context, LockPttActivity.class)
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_ANIMATION));
                    } catch (RuntimeException ignored) {
                        // Android не дал открыть окно — остаётся кнопка «Говорить» в уведомлении
                    }
                }
            } else {
                LockPttActivity.close(); // разблокировали или погасили экран
            }
        }
    };

    static boolean bubbleEnabled(Context context) {
        return context.getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean(PREF_BUBBLE, false);
    }

    static void setBubbleEnabled(Context context, boolean on) {
        context.getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean(PREF_BUBBLE, on).apply();
        if (instance != null) instance.refresh();
    }

    @Override
    public void onCreate() {
        super.onCreate();
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "walkie:air");
        wakeLock.setReferenceCounted(false);
        wakeLock.acquire();

        WifiManager wm = (WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
        int mode = Build.VERSION.SDK_INT >= 29 ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
        wifiLock = wm.createWifiLock(mode, "walkie:air");
        wifiLock.setReferenceCounted(false);
        wifiLock.acquire();

        // Уведомлений «вышел в сеть» больше нет — убрать их канал из настроек Android
        ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).deleteNotificationChannel("walkie-joins");
        bubble = new PttBubble(this);
        AirState.addListener(this);
        instance = this;
        updateTimer.run();
        android.content.IntentFilter screen = new android.content.IntentFilter();
        screen.addAction(Intent.ACTION_SCREEN_ON);
        screen.addAction(Intent.ACTION_SCREEN_OFF);
        screen.addAction(Intent.ACTION_USER_PRESENT);
        ContextCompat.registerReceiver(this, screenWatch, screen, ContextCompat.RECEIVER_NOT_EXPORTED); // системные — доходят
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_QUIT.equals(action)) {
            MainActivity.quitFromOutside();
            stopSelf();
            return START_NOT_STICKY;
        }
        if (ACTION_TALK.equals(action)) {
            MainActivity.hotkey("ptt-toggle"); // «Говорить» / «Стоп» из уведомления, в том числе на экране блокировки
            return START_NOT_STICKY;
        }
        if (ACTION_BUBBLE.equals(action)) {
            boolean on = !bubbleEnabled(this);
            if (on && !Settings.canDrawOverlays(this)) {
                MainActivity.openOverlaySettings(this);
            } else {
                getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean(PREF_BUBBLE, on).apply();
                MainActivity.optionsChanged();
            }
        }

        int types = 0;
        if (Build.VERSION.SDK_INT >= 29) {
            types = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK;
            // Микрофон в фоне (кнопка поверх приложений) — только если разрешение уже выдано
            if (Build.VERSION.SDK_INT >= 30 &&
                ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
            }
        }
        try {
            shownText = null;
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(), types);
        } catch (RuntimeException e) {
            stopSelf();
            return START_NOT_STICKY;
        }
        updateBubble();
        return START_NOT_STICKY;
    }

    @Override
    public void onAirChanged() {
        updateBubble();
        String text = statusTitle() + "|" + statusText();
        if (!text.equals(shownText)) notifyStatus();
    }

    // Настройки поменялись (кнопка поверх вкл/выкл, рация свернута/открыта)
    private void refresh() {
        updateBubble();
        notifyStatus();
    }

    private void notifyStatus() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        nm.notify(NOTIFICATION_ID, notification());
    }

    private void updateBubble() {
        boolean show = !appVisible && bubbleEnabled(this) && Settings.canDrawOverlays(this);
        if (show) bubble.show();
        else bubble.hide();
        bubble.refresh();
    }

    private String statusTitle() {
        if (!AirState.online) return AirState.server == null ? "Рация · сервер не выбран" : "Рация · нет связи";
        if (AirState.transmitting()) return "Рация · передача";
        if (AirState.receiving()) return "Рация · приём" + (AirState.rxName != null ? ": " + AirState.rxName : "");
        return "Рация · на связи";
    }

    private String statusText() {
        StringBuilder t = new StringBuilder();
        String ch = AirState.channelText();
        if (ch != null) t.append(ch);
        if (AirState.callsign != null && !AirState.callsign.isEmpty()) t.append(t.length() > 0 ? " · " : "").append(AirState.callsign);
        if (AirState.server != null) t.append(t.length() > 0 ? " · " : "").append(AirState.server);
        return t.length() > 0 ? t.toString() : "Нажмите, чтобы открыть рацию";
    }

    // Оповещение от хозяина эфира — отдельным «всплывающим» уведомлением в шторке телефона,
    // видно, даже если рация свёрнута или экран заблокирован.
    static void showNotice(Context ctx, String title, String text) {
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null) return;
        NotificationChannel channel = new NotificationChannel(NOTICE_CHANNEL, "Оповещения эфира", NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("Сообщения от хозяина сервера: обновление, перезапуск, выключение");
        nm.createNotificationChannel(channel);
        Intent open = new Intent(ctx, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent tap = PendingIntent.getActivity(ctx, 7, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new NotificationCompat.Builder(ctx, NOTICE_CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_walkie)
            .setColor(0xffff9a3c)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(tap)
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .build();
        nm.notify(NOTICE_ID, n);
    }

    private Notification notification() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        NotificationChannel channel = new NotificationChannel(CHANNEL, "Рация работает", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Постоянное уведомление: связь с сервером, канал, кто говорит");
        channel.setShowBadge(false);
        nm.createNotificationChannel(channel);

        String title = statusTitle();
        String text = statusText();
        shownText = title + "|" + text;

        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent tap = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent quit = PendingIntent.getService(this, 1,
            new Intent(this, WalkieService.class).setAction(ACTION_QUIT), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent talk = PendingIntent.getService(this, 3,
            new Intent(this, WalkieService.class).setAction(ACTION_TALK), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent bubbleToggle = PendingIntent.getService(this, 2,
            new Intent(this, WalkieService.class).setAction(ACTION_BUBBLE), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        return new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_walkie)
            .setColor(0xffff9a3c)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(tap)
            .setOngoing(true)
            .setSilent(true)
            .setShowWhen(false)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC) // видно и на экране блокировки
            .addAction(0, AirState.transmitting() ? "■ Стоп" : "🎙 Говорить", talk)
            .addAction(0, bubbleEnabled(this) ? "Убрать PTT" : "PTT поверх", bubbleToggle)
            .addAction(0, "Выключить", quit)
            .build();
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        stopSelf(); // рацию смахнули из недавних — выключаемся
    }

    @Override
    public void onDestroy() {
        AirState.removeListener(this);
        if (instance == this) instance = null;
        timers.removeCallbacks(updateTimer);
        try {
            unregisterReceiver(screenWatch);
        } catch (RuntimeException ignored) {
            // уже снят
        }
        LockPttActivity.close();
        bubble.hide();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
