; Кастомные вставки в установщик NSIS (electron-builder).
;
; Проблема: «Радио» часто работает в фоне (окно спрятано, но процесс жив — держит бота,
; веб-панель, сервер эфира). Штатная попытка установщика «мягко» закрыть приложение по окну
; тогда не срабатывает, и установка падает с «не удалось закрыть Радио». Здесь принудительно
; гасим процесс (вместе с дочерними — ffmpeg и т.п.) до начала записи файлов.

!macro customInit
  ; /t — всё дерево процессов, /f — принудительно. Имя exe даёт electron-builder.
  nsExec::Exec 'taskkill /f /t /im "${APP_EXECUTABLE_FILENAME}"'
  Sleep 800
!macroend

!macro customUnInit
  nsExec::Exec 'taskkill /f /t /im "${APP_EXECUTABLE_FILENAME}"'
  Sleep 800
!macroend
