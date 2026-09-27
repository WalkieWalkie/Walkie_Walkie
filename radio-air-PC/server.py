#!/usr/bin/env python3
"""
Сервер эфира: отдаёт страницу приёмника и ретранслирует живые станции через WebSocket.

Работает на стандартной библиотеке Python — ничего устанавливать не нужно.
Сервер ничего не записывает. Он знает только, какие станции сейчас в эфире
и на какую частоту настроен каждый приёмник — чтобы слать звук лишь тем, кто рядом.

Запуск:
    python server.py                  # только этот компьютер
    python server.py --host 0.0.0.0   # плюс другие устройства (локальная сеть, белый IP)
    python autostart.py on            # запускать в фоне вместе с Windows
"""

import argparse
import asyncio
import base64
import hashlib
import ipaddress
import json
import socket
import struct
import sys
import time
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parent
WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
BANDS = ((87.5, 108.0), (400.0, 470.0))  # FM-вещание и рации (UHF)
HEAR_RANGE = 0.5          # МГц: дальше этого звук станции приёмнику уже не слышен
LISTEN_RANGE = 0.2        # МГц: кто настроен ближе — считается слушателем (FM)
LISTEN_RANGE_UHF = 0.006  # МГц: у раций каналы узкие — слушатель только на том же канале
MAX_FRAME = 64 * 1024
MAX_BUFFER = 512 * 1024   # если клиент не успевает принимать, звук для него пропускается
NAME_LEN = 24

STATIC_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
}

REASONS = {200: 'OK', 400: 'Bad Request', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed'}


class ProtocolError(Exception):
    pass


# ───────── Эфир ─────────

class Client:
    def __init__(self, cid, writer):
        self.id = cid
        self.writer = writer
        self.freqs = []        # на что настроен приёмник (у рации с двойным прослушиванием — две); пусто — выключен
        self.station = None    # своя станция, если клиент в эфире
        self.listeners = -1    # сколько слушателей ему сообщили в последний раз

    @property
    def alive(self):
        return not self.writer.transport.is_closing()

    def send_json(self, obj):
        if self.alive:
            self.writer.write(encode_frame(0x1, json.dumps(obj, ensure_ascii=False).encode()))

    def send_audio(self, station_id, packet):
        if self.alive and self.writer.transport.get_write_buffer_size() < MAX_BUFFER:
            self.writer.write(encode_frame(0x2, struct.pack('!I', station_id) + packet))

    def hears(self, freq, reach):
        return any(abs(f - freq) <= reach for f in self.freqs)


class Station:
    def __init__(self, sid, owner, freq, name):
        self.id = sid
        self.owner = owner
        self.freq = freq
        self.name = name
        self.monitor = False  # присылать звук и самой станции (ведущий слышит свой эфир)

    def info(self):
        return {'id': self.id, 'freq': self.freq, 'name': self.name}


class Air:
    """Подключённые приёмники и станции в эфире."""

    def __init__(self):
        self.clients = set()
        self.next_id = 1

    def new_id(self):
        self.next_id += 1
        return self.next_id - 1

    def stations(self):
        return [c.station for c in self.clients if c.station]

    def broadcast(self, obj, exclude=None):
        for c in self.clients:
            if c is not exclude:
                c.send_json(obj)

    def update_listeners(self):
        for st in self.stations():
            count = sum(
                1 for c in self.clients
                if c is not st.owner and c.hears(st.freq, listen_range(st.freq))
            )
            if count != st.owner.listeners:
                st.owner.listeners = count
                st.owner.send_json({'type': 'listeners', 'count': count})

    def join(self, client):
        self.clients.add(client)
        client.send_json({'type': 'welcome', 'stations': [st.info() for st in self.stations()]})

    def leave(self, client):
        self.clients.discard(client)
        if client.station:
            self.off_air(client)
        self.update_listeners()

    def on_air(self, client, freq, name, monitor=False):
        if client.station:
            client.station.freq = freq
            client.station.name = name
        else:
            client.station = Station(self.new_id(), client, freq, name)
            client.listeners = -1
        client.station.monitor = monitor
        # О своей станции владелец узнаёт из onair-ok; её звук ему — только с monitor
        self.broadcast({'type': 'station-on', 'station': client.station.info()}, exclude=client)
        client.send_json({'type': 'onair-ok', 'station': client.station.info()})
        self.update_listeners()

    def off_air(self, client):
        st = client.station
        client.station = None
        self.broadcast({'type': 'station-off', 'id': st.id}, exclude=client)

    def relay(self, client, packet):
        # Содержимое пакета сервер не разбирает: шифрованный звук он и не может прочитать
        st = client.station
        if not st or not packet:
            return
        for c in self.clients:
            if (c is not client or st.monitor) and c.hears(st.freq, HEAR_RANGE):
                c.send_audio(st.id, packet)

    def handle_message(self, client, msg):
        kind = msg.get('type')
        if kind == 'tune':
            values = msg.get('freqs')
            if not isinstance(values, list):
                values = [msg.get('freq')]
            client.freqs = [f for f in (parse_freq(v) for v in values[:4] if v is not None) if f is not None]
            self.update_listeners()
        elif kind == 'onair':
            freq = parse_freq(msg.get('freq'))
            if freq is None:
                client.send_json({'type': 'error', 'message': 'Частота должна быть 87.5–108 или 400–470 МГц'})
                return
            self.on_air(client, freq, clean_name(msg.get('name')), msg.get('monitor') is True)
        elif kind == 'offair' and client.station:
            self.off_air(client)
            self.update_listeners()
        elif kind == 'notice':
            # Оповещение хозяина эфира — сервер рассылает его всем подключённым (рациям и станциям).
            # Канал закрыт ключом (SCR), поэтому шлёт только свой; отдельной роли админа тут нет.
            state = msg.get('state')
            if state in ('update', 'restart', 'shutdown', 'live'):
                text = str(msg.get('text') or '').strip()[:120]
                self.broadcast({'type': 'server-notice', 'state': state, 'text': text}, exclude=client)


def parse_freq(value):
    try:
        freq = round(float(value), 5)
    except (TypeError, ValueError):
        return None
    return freq if any(lo <= freq <= hi for lo, hi in BANDS) else None


def listen_range(freq):
    return LISTEN_RANGE if freq < 300 else LISTEN_RANGE_UHF


def clean_name(value):
    text = ''.join(ch for ch in str(value or '') if ch.isprintable())
    return ' '.join(text.split())[:NAME_LEN] or 'БЕЗ ПОЗЫВНОГО'


# ───────── WebSocket (RFC 6455) ─────────

def encode_frame(opcode, payload):
    n = len(payload)
    if n < 126:
        head = struct.pack('!BB', 0x80 | opcode, n)
    elif n < 65536:
        head = struct.pack('!BBH', 0x80 | opcode, 126, n)
    else:
        head = struct.pack('!BBQ', 0x80 | opcode, 127, n)
    return head + payload


def unmask(data, mask):
    n = len(data)
    if not n:
        return data
    key = (mask * (n // 4 + 1))[:n]
    return (int.from_bytes(data, 'little') ^ int.from_bytes(key, 'little')).to_bytes(n, 'little')


async def read_messages(reader):
    """Выдаёт целые сообщения (opcode, payload), собирая фрагменты."""
    frag_op, frag = None, bytearray()
    while True:
        b1, b2 = await reader.readexactly(2)
        fin, opcode = b1 & 0x80, b1 & 0x0F
        masked, length = b2 & 0x80, b2 & 0x7F
        if length == 126:
            (length,) = struct.unpack('!H', await reader.readexactly(2))
        elif length == 127:
            (length,) = struct.unpack('!Q', await reader.readexactly(8))
        if length > MAX_FRAME or not masked:
            raise ProtocolError()
        mask = await reader.readexactly(4)
        payload = unmask(await reader.readexactly(length), mask)

        if opcode >= 0x8:  # управляющие кадры не фрагментируются
            yield opcode, payload
        elif opcode == 0x0:
            if frag_op is None:
                raise ProtocolError()
            frag += payload
            if len(frag) > MAX_FRAME:
                raise ProtocolError()
            if fin:
                yield frag_op, bytes(frag)
                frag_op, frag = None, bytearray()
        elif fin:
            yield opcode, payload
        else:
            frag_op, frag = opcode, bytearray(payload)


async def websocket_session(air, reader, writer, headers):
    key = headers.get('sec-websocket-key')
    if not key or headers.get('sec-websocket-version') != '13':
        await respond(writer, 400, b'Bad WebSocket request')
        return
    # Подключаться можно со страницы этого же сервера или из приложения (у него адрес не http/https)
    origin = headers.get('origin')
    parts = urlsplit(origin) if origin else None
    if parts and parts.scheme in ('http', 'https') and parts.netloc != headers.get('host'):
        await respond(writer, 403, b'Forbidden origin')
        return

    accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
    writer.write((
        'HTTP/1.1 101 Switching Protocols\r\n'
        'Upgrade: websocket\r\n'
        'Connection: Upgrade\r\n'
        f'Sec-WebSocket-Accept: {accept}\r\n\r\n'
    ).encode())

    client = Client(air.new_id(), writer)
    air.join(client)
    try:
        async for opcode, payload in read_messages(reader):
            if opcode == 0x1:
                try:
                    msg = json.loads(payload)
                except ValueError:
                    continue
                if isinstance(msg, dict):
                    air.handle_message(client, msg)
            elif opcode == 0x2:
                air.relay(client, payload)
            elif opcode == 0x9:
                writer.write(encode_frame(0xA, payload))
            elif opcode == 0x8:
                writer.write(encode_frame(0x8, payload[:2]))
                break
    except (asyncio.IncompleteReadError, ConnectionError, ProtocolError):
        pass
    finally:
        air.leave(client)


# ───────── HTTP ─────────

async def respond(writer, status, body, content_type='text/plain; charset=utf-8', length=None):
    head = (
        f'HTTP/1.1 {status} {REASONS[status]}\r\n'
        f'Content-Type: {content_type}\r\n'
        f'Content-Length: {len(body) if length is None else length}\r\n'
        'Cache-Control: no-cache\r\n'
        'Connection: close\r\n\r\n'
    )
    writer.write(head.encode() + body)
    await writer.drain()


async def serve_static(writer, method, path):
    if method not in ('GET', 'HEAD'):
        await respond(writer, 405, b'Method Not Allowed')
        return
    file = (ROOT / (unquote(path).lstrip('/') or 'index.html')).resolve()
    # Наружу — только сам приёмник: страница, стили и скрипты (не приложение, не журналы).
    # Проверяем уже разобранный путь, иначе /js/../что-угодно проскочит
    rel = file.relative_to(ROOT).as_posix() if file.is_relative_to(ROOT) else ''
    if (
        not (rel in ('index.html', 'widget.html') or rel.startswith(('css/', 'js/')))
        or file.suffix not in STATIC_TYPES
        or any(part.startswith('.') for part in file.relative_to(ROOT).parts)
        or not file.is_file()
    ):
        await respond(writer, 404, b'Not Found')
        return
    body = file.read_bytes()
    await respond(writer, 200, body if method == 'GET' else b'', STATIC_TYPES[file.suffix], len(body))


async def handle(air, reader, writer):
    try:
        try:
            head = await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'), timeout=10)
        except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, TimeoutError, ConnectionError):
            return
        lines = head.decode('latin-1').split('\r\n')
        parts = lines[0].split(' ')
        if len(parts) != 3:
            return
        method, target, _ = parts
        headers = {}
        for line in lines[1:]:
            name, sep, value = line.partition(':')
            if sep:
                headers[name.strip().lower()] = value.strip()

        path = urlsplit(target).path
        if path == '/ws' and headers.get('upgrade', '').lower() == 'websocket':
            await websocket_session(air, reader, writer, headers)
        else:
            await serve_static(writer, method, path)
    except ConnectionError:
        pass
    finally:
        writer.close()


HOME_NETWORKS = [ipaddress.ip_network(n) for n in ('192.168.0.0/16', '10.0.0.0/8', '172.16.0.0/12')]


def lan_ips():
    """Адреса компьютера в домашней сети. Адаптеры VPN (например, 198.18.x.x у TUN-режима) пропускаются."""
    try:
        found = {info[4][0] for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)}
    except OSError:
        return []
    home = [ip for ip in map(ipaddress.ip_address, found) if any(ip in net for net in HOME_NETWORKS)]
    return [str(ip) for ip in sorted(home, key=lambda ip: next(i for i, net in enumerate(HOME_NETWORKS) if ip in net))]


def say(message):
    print(f'{time.strftime("%Y-%m-%d %H:%M:%S")}  {message}', flush=True)


def setup_output(log_path):
    # В фоне (pythonw) консоли нет: всё, что сервер пишет, уходит в журнал
    if log_path:
        sys.stdout = sys.stderr = open(log_path, 'a', encoding='utf-8', buffering=1)
    elif sys.stdout is not None:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')


def listen_socket(host, port):
    sock = socket.socket(socket.AF_INET6 if ':' in host else socket.AF_INET, socket.SOCK_STREAM)
    try:
        # Без этого Windows пустит второй сервер на 127.0.0.1, пока первый слушает 0.0.0.0,
        # и эфир незаметно разделится на два
        if hasattr(socket, 'SO_EXCLUSIVEADDRUSE'):
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        sock.bind((host, port))
        sock.listen(128)
        sock.setblocking(False)
    except OSError:
        sock.close()
        raise
    return sock


def quiet_resets(loop, context):
    # Клиент оборвал соединение — обычное дело (закрыли вкладку, пропала сеть), в журнал не пишем
    if isinstance(context.get('exception'), (ConnectionResetError, ConnectionAbortedError)):
        return
    loop.default_exception_handler(context)


async def main(args):
    asyncio.get_running_loop().set_exception_handler(quiet_resets)
    air = Air()
    try:
        server = await asyncio.start_server(lambda r, w: handle(air, r, w), sock=listen_socket(args.host, args.port))
    except OSError as err:
        say(f'Не удалось занять порт {args.port}: {err}')
        say('Скорее всего, сервер уже запущен — например, в фоне через автозапуск.')
        return 1

    say(f'Эфир запущен: http://localhost:{args.port}')
    if args.host == '0.0.0.0':
        for ip in lan_ips():
            say(f'В локальной сети: http://{ip}:{args.port}')
    else:
        say('Чтобы слушать с других устройств: python server.py --host 0.0.0.0')
    async with server:
        await server.serve_forever()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Сервер эфира')
    parser.add_argument('--host', default='127.0.0.1', help='0.0.0.0 — открыть для сети')
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--log', help='писать журнал в этот файл (для работы в фоне)')
    args = parser.parse_args()
    setup_output(args.log)
    try:
        sys.exit(asyncio.run(main(args)))
    except KeyboardInterrupt:
        say('Эфир остановлен.')
