# ffmpeg вшивается в установщик здесь.
# CI релиза кладёт сюда ffmpeg.exe (win64 static) перед сборкой,
# electron-builder кладёт его в resources рядом с приложением,
# а станция берёт его автоматически (см. relay.js bundledFfmpeg).
# Сам бинарь не коммитим — его качает workflow сборки.
