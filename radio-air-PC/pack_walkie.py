"""
Собирает отдельную программу «Рация» из общих исходников «Радио».

    python pack_walkie.py          исходники рации в release/radio-walkie и архив для друзей
    python pack_walkie.py --build  то же и установщик release/Walkie-Setup-<версия>-walkie.0.exe

В архив попадают только файлы из списка ниже — ничего лишнего из папки проекта. Перед упаковкой
всё проверяется на секреты (ключи, токены, пароли) и личные данные (почта, адреса в домашней сети,
имя пользователя и компьютера). Если что-то нашлось, архив не создаётся.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DESKTOP = ROOT / 'desktop'
RELEASE = ROOT / 'release'
OUT = RELEASE / 'radio-walkie'
KEEP = {'node_modules', 'dist'}  # не стираем при пересборке: установка пакетов долгая

NAME = 'radio-walkie'
TITLE = 'Рация'

# Что входит в рацию: куда положить ← откуда взять
FONTS = ['pt-mono-latin-400-normal.woff2', 'pt-mono-cyrillic-400-normal.woff2',
         'jura-latin-700-normal.woff2', 'jura-cyrillic-700-normal.woff2',
         'russo-one-latin-400-normal.woff2', 'russo-one-cyrillic-400-normal.woff2',
         'DSEG7Classic-Bold.woff2', 'LICENSE-FONTS.txt']

FILES = {
    'main.js': DESKTOP / 'main.js',
    'preload.js': DESKTOP / 'preload.js',
    'hotkeys.js': DESKTOP / 'hotkeys.js',
    'air-server.js': DESKTOP / 'air-server.js',
    'upnp.js': DESKTOP / 'upnp.js',
    'build/icon.ico': DESKTOP / 'build' / 'walkie.ico',
    'README.md': DESKTOP / 'walkie-README.md',
    'web/widget.html': ROOT / 'widget.html',
    'web/css/widget.css': ROOT / 'css' / 'widget.css',
    'web/css/look.css': ROOT / 'css' / 'look.css',
    'web/css/skins.css': ROOT / 'css' / 'skins.css',
    'web/css/panel.css': ROOT / 'css' / 'panel.css',
    'web/js/audio-kit.js': ROOT / 'js' / 'audio-kit.js',
    'web/js/stations.js': ROOT / 'js' / 'stations.js',
    'web/js/engine.js': ROOT / 'js' / 'engine.js',
    'web/js/codec.js': ROOT / 'js' / 'codec.js',
    'web/js/crypto.js': ROOT / 'js' / 'crypto.js',
    'web/js/live.js': ROOT / 'js' / 'live.js',
    'web/js/link.js': ROOT / 'js' / 'link.js',
    'web/js/look.js': ROOT / 'js' / 'look.js',
    'web/js/privacy.js': ROOT / 'js' / 'privacy.js',
    'web/js/widget.js': ROOT / 'js' / 'widget.js',
    'web/js/voice.js': ROOT / 'js' / 'voice.js',
    'web/js/voice-worklet.js': ROOT / 'js' / 'voice-worklet.js',
    'web/js/channel.js': ROOT / 'js' / 'channel.js',
    'web/js/changelog.js': ROOT / 'js' / 'changelog.js',
    'web/js/updater-ui.js': ROOT / 'js' / 'updater-ui.js',
    'web/js/pc-panel.js': ROOT / 'js' / 'pc-panel.js',
    'web/js/worklets/capture.js': ROOT / 'js' / 'worklets' / 'capture.js',
    'web/js/worklets/player.js': ROOT / 'js' / 'worklets' / 'player.js',
    **{f'web/fonts/{name}': ROOT / 'fonts' / name for name in FONTS},
    # Фотоскины камуфляжа: готовые рендеры корпуса, кнопок, боковых, ручки (skins/<цвет>_*.png)
    **{f'web/css/skins/{p.name}': p for p in sorted((ROOT / 'css' / 'skins').glob('*.png'))},
}

GITIGNORE = 'node_modules/\ndist/\n'

# Файлы, которым не место в архиве, даже если попадут в список
SECRET_NAMES = re.compile(r'(^\.env)|(\.(pem|key|pfx|p12|crt|keystore|log)$)|(^id_(rsa|ed25519|ecdsa))|(^\.npmrc$)', re.I)

# Секреты в тексте
SECRET_TEXT = [
    ('закрытый ключ', re.compile(r'-----BEGIN [A-Z ]*PRIVATE KEY-----')),
    ('ключ AWS', re.compile(r'\bAKIA[0-9A-Z]{16}\b')),
    ('токен GitHub', re.compile(r'\bgh[pousr]_[A-Za-z0-9]{30,}')),
    ('токен npm', re.compile(r'\bnpm_[A-Za-z0-9]{30,}')),
    ('токен Slack', re.compile(r'\bxox[abprs]-[A-Za-z0-9-]{10,}')),
    ('ключ API', re.compile(r'\bsk-[A-Za-z0-9_-]{20,}')),
    ('пароль или токен', re.compile(
        r'(api[_-]?key|secret|passw(or)?d|token|auth)["\']?\s*[:=]\s*["\'][^"\'\s]{8,}["\']', re.I)),
]


def personal_patterns():
    """Личное: почта, адреса домашней сети, пути и имена этого компьютера."""
    found = [
        ('адрес почты', re.compile(r'[\w.+-]+@[\w-]+\.[\w.-]*[a-z]{2,}', re.I)),
        ('адрес в домашней сети', re.compile(
            # диапазоны сетей в коде (192.168.0.0/16) — не адрес, их пропускаем
            r'\b(192\.168|10\.\d{1,3}|172\.(1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b(?!/\d)')),
        ('путь к профилю Windows', re.compile(r'[A-Za-z]:[\\/]+Users[\\/]+', re.I)),
    ]
    for label, value in (('имя пользователя', os.environ.get('USERNAME')),
                         ('имя компьютера', os.environ.get('COMPUTERNAME'))):
        if value and len(value) >= 3:
            found.append((label, re.compile(r'\b' + re.escape(value) + r'\b', re.I)))
    return found


def walkie_version(base):
    """Версия рации: к версии станции добавляем предрелизный ярлык канала обновлений «walkie»."""
    return base if '-walkie.' in base else f'{base}-walkie.0'


def package_json():
    """package.json рации — на основе приложения «Радио», с другим именем и только нужными файлами."""
    src = json.loads((DESKTOP / 'package.json').read_text(encoding='utf-8'))
    build = src['build']
    return {
        'name': NAME,
        'productName': TITLE,
        # Свой предрелизный канал обновлений: версия рации = версия станции + «-walkie.0».
        # electron-updater по этому суффиксу берёт релизы рации (walkie.yml), не путая со станцией.
        'version': walkie_version(src['version']),
        'description': 'Рация для эфира «Радио»: каналы PMR/LPD, шифрование, полоска поверх игр',
        'author': src['author'],
        'private': True,
        'main': 'main.js',
        'walkieOnly': True,  # main.js: только рация, без большого приёмника
        'webRoot': 'web',    # main.js: где страницы при запуске из исходников
        'scripts': src['scripts'],
        'build': {
            'appId': 'ru.radio.walkie',
            'productName': TITLE,
            # Свой канал обновлений: «Рация» и «Радио» лежат в одних релизах, но манифесты разные
            # (walkie.yml и latest.yml) — приложения не путают версии друг друга.
            'publish': [{'provider': 'github', 'owner': 'WalkieWalkie', 'repo': 'Walkie_Walkie', 'channel': 'walkie', 'releaseType': 'draft'}],
            'directories': build['directories'],
            'files': build['files'],
            'extraResources': [{'from': 'web', 'to': 'web'}],
            'win': {**build['win'], 'icon': 'build/icon.ico'},
            # include (installer.nsh) — только у станции; в staged-сборке рации этого файла нет,
            # поэтому не тащим его в nsis рации, иначе electron-builder падает «cannot find resource».
            'nsis': {**{k: v for k, v in build['nsis'].items() if k != 'include'},
                     'artifactName': 'Walkie-Setup-${version}.exe', 'shortcutName': TITLE},
            'npmRebuild': build['npmRebuild'],
        },
        'dependencies': src['dependencies'],
        'devDependencies': src['devDependencies'],
    }


def package_lock():
    """Те же версии пакетов, что у «Радио», — меняется только имя проекта."""
    lock = json.loads((DESKTOP / 'package-lock.json').read_text(encoding='utf-8'))
    ver = walkie_version(lock.get('version', ''))
    lock['name'] = NAME
    lock['version'] = ver
    lock['packages'][''] = {**lock['packages'][''], 'name': NAME, 'version': ver}
    return lock


def check_web_refs():
    """Всё, что подключает страница рации, должно быть в списке FILES."""
    listed = {k[len('web/'):] for k in FILES if k.startswith('web/')}
    html = (ROOT / 'widget.html').read_text(encoding='utf-8')
    refs = set(re.findall(r'(?:src|href)="((?:css|js)/[^"]+)"', html))
    for name in ('widget.js', 'live.js', 'engine.js', 'link.js'):
        refs |= set(re.findall(r'[\'"`]((?:css|js)/[\w./-]+\.(?:js|css))[\'"`]', (ROOT / 'js' / name).read_text(encoding='utf-8')))
    missing = sorted(refs - listed)
    if missing:
        sys.exit('Рация подключает файлы, которых нет в списке FILES: ' + ', '.join(missing))


def stage():
    """Собирает папку release/radio-walkie заново (кроме node_modules и dist)."""
    OUT.mkdir(parents=True, exist_ok=True)
    for item in OUT.iterdir():
        if item.name in KEEP:
            continue
        shutil.rmtree(item) if item.is_dir() else item.unlink()

    written = []
    for rel, src in FILES.items():
        dst = OUT / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dst)
        written.append(rel)
    for rel, text in (
        ('package.json', json.dumps(package_json(), ensure_ascii=False, indent=2) + '\n'),
        ('package-lock.json', json.dumps(package_lock(), ensure_ascii=False, indent=2) + '\n'),
        ('.gitignore', GITIGNORE),
    ):
        (OUT / rel).write_text(text, encoding='utf-8', newline='\n')
        written.append(rel)
    return sorted(written)


def scan(files, base=OUT):
    """Ищет секреты и личные данные. Возвращает список находок «файл:строка — что»."""
    problems = []
    personal = personal_patterns()
    for rel in files:
        path = base / rel
        if SECRET_NAMES.search(path.name):
            problems.append(f'{rel} — такой файл не должен попадать в архив')
        if path.suffix in ('.ico', '.png', '.woff2'):
            continue
        text = path.read_text(encoding='utf-8')
        for n, line in enumerate(text.splitlines(), 1):
            for label, pattern in SECRET_TEXT + personal:
                # Сообщения npm об устаревших пакетах содержат публичные адреса их авторов
                if label == 'адрес почты' and rel == 'package-lock.json' and '"deprecated":' in line:
                    continue
                if pattern.search(line):
                    problems.append(f'{rel}:{n} — {label}: {line.strip()[:100]}')
    return problems


def make_zip(files, version):
    RELEASE.mkdir(exist_ok=True)
    target = RELEASE / f'{NAME}-{version}-src.zip'
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for rel in files:
            z.write(OUT / rel, f'{NAME}/{rel}')
    return target


def node_env():
    """Окружение с Node.js: из PATH или переносной Node в %LOCALAPPDATA%\\Programs."""
    env = dict(os.environ)
    if shutil.which('npm', path=env.get('PATH')):
        return env
    local = Path(os.environ.get('LOCALAPPDATA', '')) / 'Programs'
    for node in sorted(local.glob('node-v*-win-x64'), reverse=True):
        if (node / 'npm.cmd').exists():
            env['PATH'] = f'{node}{os.pathsep}{env.get("PATH", "")}'
            return env
    sys.exit('Не найден Node.js — установите его с nodejs.org, чтобы собрать установщик.')


def build(version):
    env = node_env()
    npm = shutil.which('npm', path=env['PATH'])
    npx = shutil.which('npx', path=env['PATH'])
    if not (OUT / 'node_modules').exists():
        print('Устанавливаю пакеты (из кэша npm, без скачивания)…')
        subprocess.run([npm, 'ci', '--offline', '--no-audit', '--no-fund'], cwd=OUT, env=env, check=True)
    print('Собираю установщик…')
    subprocess.run([npx, 'electron-builder', '--win'], cwd=OUT, env=env, check=True)
    # electron-builder называет файл по версии из package.json рации — с суффиксом «-walkie.0»
    exe = OUT / 'dist' / f'Walkie-Setup-{walkie_version(version)}.exe'
    shutil.copyfile(exe, RELEASE / exe.name)
    return RELEASE / exe.name


def main():
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    version = json.loads((DESKTOP / 'package.json').read_text(encoding='utf-8'))['version']
    check_web_refs()
    files = stage()
    problems = scan(files)
    if problems:
        print('Найдено то, что не стоит отправлять — архив не создан:')
        for p in problems:
            print('  ' + p)
        sys.exit(1)
    print(f'Проверено файлов: {len(files)} — секретов и личных данных нет.')
    target = make_zip(files, version)
    print(f'Архив исходников: {target} ({target.stat().st_size // 1024} КБ)')
    if '--build' in sys.argv:
        exe = build(version)
        print(f'Установщик: {exe} ({exe.stat().st_size // (1024 * 1024)} МБ)')


if __name__ == '__main__':
    main()
