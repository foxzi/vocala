# Configuration / Конфигурация

## English

Vocala is configured via `config.yaml` file and/or environment variables. Env vars override YAML values.

### YAML Configuration

See `config.yaml.example` for a full documented example. Key sections:

```yaml
server:
  addr: ":8090"             # HTTP listen address
  read_timeout: 15          # seconds
  write_timeout: 30
  idle_timeout: 120

database:
  path: "vocala.db"       # SQLite file path
  chat_retention_days: 30   # Auto-delete old chat messages (0 = keep forever)

webrtc:
  nat_ip: ""                # Public IP for ICE candidates (required in Docker)
  udp_port_min: 40000       # Ephemeral UDP port range
  udp_port_max: 40200

turn:
  enabled: false
  ip: ""                    # Public IP for TURN
  port: 3478                # UDP TURN port
  tls_port: 5349            # TLS TURNS port (0 = disabled)
  tls_host: ""              # Domain for TURNS URI (must match TLS cert)
  cert_file: ""             # TLS certificate
  key_file: ""              # TLS private key

auth:
  session_days: 30
  min_password: 8
  cookie_secure: false      # Set true for HTTPS
  rate_limit_rps: 10
  rate_limit_burst: 20

security:
  allowed_origins: []       # Empty = same-origin only

storage:
  backend: "local"          # "local" or "s3"
  local:
    dir: ""                 # empty = "storage" next to the database file
  s3:                       # any S3-compatible storage; the bucket must exist
    endpoint: ""            # host[:port], no scheme
    region: ""
    bucket: ""
    prefix: "vocala/"
    access_key: ""          # prefer VOCALA_S3_ACCESS_KEY
    secret_key: ""          # prefer VOCALA_S3_SECRET_KEY
    insecure: false         # plain HTTP

recording:
  enabled: false            # server-side call recording, off by default
  tmp_dir: ""               # files being written; default <storage dir>/tmp
  max_hours: 4              # stop a forgotten recording (0 = no limit)
  retention_days: 30        # delete older recordings (0 = keep forever)

transcription:
  url: ""                   # speech service, e.g. http://whisper:8000; empty = off
  model: "Systran/faster-whisper-medium"
  language: "ru"            # empty = detect
```

### Environment Variables

Env vars override YAML settings:

| Variable | Default | Description |
|----------|---------|-------------|
| `VOCALA_ADDR` | `:8090` | HTTP server listen address |
| `VOCALA_DB_PATH` | `vocala.db` | Path to SQLite database file |
| `VOCALA_NAT_IP` | *(disabled)* | Host IP for WebRTC ICE candidates |
| `VOCALA_TURN_IP` | *(disabled)* | Public IP for embedded TURN server |
| `VOCALA_TURN_PORT` | `3478` | TURN UDP port |
| `VOCALA_COOKIE_SECURE` | `false` | Set `true` or `1` for HTTPS |
| `VOCALA_REGISTRATION` | `true` | Set `false` or `0` to disable public registration |
| `VOCALA_STORAGE_DIR` | *(next to the DB)* | Directory for recordings |
| `VOCALA_STORAGE_BACKEND` | `local` | `local` or `s3` |
| `VOCALA_S3_ENDPOINT`, `VOCALA_S3_BUCKET`, `VOCALA_S3_PREFIX`, `VOCALA_S3_REGION` | | S3 location |
| `VOCALA_S3_ACCESS_KEY`, `VOCALA_S3_SECRET_KEY` | | S3 keys |
| `VOCALA_S3_INSECURE` | `false` | `true` for plain HTTP |
| `VOCALA_RECORDING` | `false` | Set `true` or `1` to enable call recording |
| `VOCALA_STT_URL` | *(disabled)* | Speech service for transcripts, e.g. `http://whisper:8000` |
| `VOCALA_STT_MODEL` | `Systran/faster-whisper-medium` | Whisper model |
| `VOCALA_STT_LANGUAGE` | `ru` | Speech language; empty = detect |

### Call Recording

Recording is off by default: turn it on with `recording.enabled: true` or `VOCALA_RECORDING=true`. Then any participant can start recording a call with the record button; everyone in the call sees a "REC" indicator, and people who join later are told the call is being recorded. The server writes each participant's audio to its own Ogg/Opus file without re-encoding. Recording stops when someone presses the button again, when the channel has stayed empty for a minute (whoever comes back sooner, e.g. after a page reload, continues the same recording), or after `max_hours`. Channel members find recordings under **Recordings** in the channel header. Everyone who started a recording or has a track in it also finds it under **My recordings** (the button next to Settings), in any channel; this keeps recordings of group calls reachable after their channel is removed. If the server cannot write a participant's file (e.g. a full disk), it tries again 10 seconds later; the audio in between is lost. Design: [ADR-0001](adr/0001-recording-and-transcription.md).

Regular Android calls use WebRTC like everyone else. An Android client that joined without a microphone and turned it on later sends audio over WebSocket as MediaRecorder chunks instead; that audio is stored as WebM as it arrives (the browser player shows no total length for these files). When a recording starts, the server asks these clients to restart their recorder, because only the start of a stream carries the container header; the client announces each new stream (`ws_media_stream`) before its first chunk.

### Examples

**Development (defaults):**

```bash
make run
# Listens on :8090, DB at ./vocala.db, no TURN
```

**With config file:**

```bash
./vocala -config config.yaml
```

**Docker with HTTPS:**

```bash
cp .env.example .env
# Edit .env: set VOCALA_NAT_IP to your host IP
./nginx/generate-cert.sh ./nginx/certs
docker compose up -d
# Access at https://<your-ip>
```

### TURN Server

The embedded TURN server starts automatically when TURN is enabled and a public IP is configured. `VOCALA_TURN_IP` overrides the configured IP, and `VOCALA_TURN_PORT` overrides the UDP port. If `tls_port`, `tls_host`, `cert_file`, and `key_file` are configured, Vocala also exposes TURNS for TLS-capable clients.

**When to enable TURN:**
- Users are behind corporate firewalls or symmetric NATs
- WebRTC connections fail with "ICE failed" errors
- The server is deployed on the public internet

**When TURN is NOT needed:**
- All users are on the same LAN
- Local development/testing

**TURN credentials** are generated automatically at each startup. A random shared secret is created, and the username `vocala` is used. Credentials are passed to clients through the HTML template -- no manual configuration needed.

### ICE Configuration

The server provides ICE servers to clients via a JavaScript variable injected into the page:

```javascript
// Without TURN:
window.VOCALA_ICE_SERVERS = [
    {"urls": "stun:stun.l.google.com:19302"},
    {"urls": "stun:stun1.l.google.com:19302"}
];

// With TURN:
window.VOCALA_ICE_SERVERS = [
    {"urls": "stun:stun.l.google.com:19302"},
    {"urls": "stun:stun1.l.google.com:19302"},
    {"urls": "turn:203.0.113.1:3478", "username": "vocala", "credential": "<auto-generated>"}
];
```

### Database

SQLite database is created automatically on first run. WAL mode is enabled for concurrent read/write performance. The database file location is controlled by `VOCALA_DB_PATH`.

**Docker:** The database is stored on a named volume (`vocala-data`) at `/app/data/vocala.db`, so data survives container restarts.

### Sessions

- Sessions expire after 30 days
- Expired sessions are cleaned up automatically every hour
- Session tokens are 64-character hex strings (32 bytes of entropy)
- Guest sessions are separate temporary cookies scoped to a single channel and created from `/guest/{token}` links

---

### Storage

Recordings and transcripts go to `storage.backend`: a local directory (default) or any S3-compatible storage — AWS S3, Yandex Object Storage, Selectel, MinIO, SeaweedFS, Garage. The bucket must exist; Vocala checks it at startup. A missing bucket or wrong keys turn recording off with an error in the log, while calls keep working; a storage that does not answer yet (still starting) only gives a warning, and uploads are retried. Files being recorded are written to the local disk first (`recording.tmp_dir`) and uploaded when a participant's track ends. If the storage is down at that moment, the upload is retried for a few minutes; after that the recording is marked failed, the file stays on disk and is uploaded again every 10 minutes until it succeeds. Playback reads the object with range requests, so seeking works. The default prefix is `vocala/`; an endpoint given as a URL (`https://…`) is accepted.

Switching the backend does not move existing recordings: they stay in the old place and are not shown as playable until retention removes their rows. Copy them to the new storage under the same keys (`recordings/<id>/...`) if you need them.

### Transcripts

With `transcription.url` set, every finished recording is transcribed by a self-hosted speech service — [speaches](https://github.com/speaches-ai/speaches) with faster-whisper on the CPU, the same setup as our platform. Each participant's track is recognized separately, so the transcript knows who spoke; the lines are laid out on the call's timeline (`[00:01:23] Ivan: …`). One recording at a time, in the background; when it is done, the channel chat gets a notice and **Recordings** shows the text and a `.md` download.

With Docker: set `VOCALA_STT_URL=http://whisper:8000` in `.env` and run `docker compose --profile stt up -d`. The `whisper` service needs up to 4 CPUs and 4 GB of RAM and downloads the model (1.5 GB for medium) from Hugging Face on first start. Audio does not leave your network.

## Русский

Vocala настраивается через файл `config.yaml` и/или переменные окружения. Переменные окружения перекрывают значения из YAML.

### YAML-конфигурация

Полный пример с комментариями -- `config.yaml.example`. Основные секции:

- `server` -- адрес, таймауты HTTP-сервера
- `database` -- путь к SQLite, `chat_retention_days` (автоочистка чата, 0 = хранить вечно)
- `webrtc` -- NAT IP, диапазон UDP-портов
- `turn` -- встроенный TURN/TURNS сервер, TLS-настройки
- `auth` -- длина сессий, минимальная длина пароля, secure cookie, rate limit
- `security` -- разрешённые origins для WebSocket
- `storage` -- где хранятся записи: `backend` (`local` или `s3`), `local.dir` (по умолчанию `storage` рядом с файлом БД), `s3.*`
- `recording` -- запись звонков: `enabled` (по умолчанию выключена), `max_hours` (предел длины записи), `retention_days` (срок хранения, 0 = вечно)

### Переменные окружения

| Переменная | По умолчанию | Описание |
|------------|-------------|----------|
| `VOCALA_ADDR` | `:8090` | Адрес HTTP-сервера |
| `VOCALA_DB_PATH` | `vocala.db` | Путь к SQLite |
| `VOCALA_NAT_IP` | *(выключен)* | IP хоста для WebRTC ICE candidates |
| `VOCALA_TURN_IP` | *(выключен)* | Публичный IP для TURN-сервера |
| `VOCALA_TURN_PORT` | `3478` | UDP-порт TURN |
| `VOCALA_COOKIE_SECURE` | `false` | `true` или `1` для HTTPS |
| `VOCALA_REGISTRATION` | `true` | `false` или `0`, чтобы отключить публичную регистрацию |
| `VOCALA_STORAGE_DIR` | *(рядом с БД)* | Каталог для записей |
| `VOCALA_STORAGE_BACKEND` | `local` | `local` или `s3` |
| `VOCALA_S3_ENDPOINT`, `VOCALA_S3_BUCKET`, `VOCALA_S3_PREFIX`, `VOCALA_S3_REGION` | | Где лежат записи в S3 |
| `VOCALA_S3_ACCESS_KEY`, `VOCALA_S3_SECRET_KEY` | | Ключи S3 |
| `VOCALA_S3_INSECURE` | `false` | `true` — обычный HTTP |
| `VOCALA_RECORDING` | `false` | `true` или `1`, чтобы включить запись звонков |
| `VOCALA_STT_URL` | *(выключено)* | Сервис распознавания для расшифровок, например `http://whisper:8000` |
| `VOCALA_STT_MODEL` | `Systran/faster-whisper-medium` | Модель Whisper |
| `VOCALA_STT_LANGUAGE` | `ru` | Язык речи; пусто — определять |

### Запись звонков

По умолчанию запись выключена: включите её через `recording.enabled: true` или `VOCALA_RECORDING=true`. Тогда запись включает любой участник кнопкой записи; у всех в звонке горит индикатор «REC», а вошедшим позже сообщается, что идёт запись. Сервер пишет звук каждого участника в свой файл Ogg/Opus без перекодирования. Запись останавливается кнопкой, когда канал пустует минуту (кто вернулся раньше, например после перезагрузки страницы, продолжает ту же запись), или через `max_hours`. Записи канала — кнопка **Recordings** в шапке канала. Кто запустил запись или есть в ней со своей дорожкой, найдёт её и в **My recordings** (кнопка рядом с настройками), в любом канале; так записи групповых звонков остаются доступны после удаления их канала. Если сервер не может записать файл участника (например, кончился диск), он пробует снова через 10 секунд; звук в промежутке теряется. Решение — [ADR-0001](adr/0001-recording-and-transcription.md).

Обычные звонки с Android идут через WebRTC, как у всех. Если Android-клиент вошёл без микрофона и включил его позже, звук идёт кусками MediaRecorder по WebSocket; он сохраняется в WebM как есть (у таких файлов проигрыватель не показывает общую длину). При старте записи сервер просит такие клиенты перезапустить MediaRecorder: заголовок контейнера есть только в начале потока; о каждом новом потоке клиент сообщает (`ws_media_stream`) перед его первым куском.

### Примеры

```bash
make run                           # Дефолты: :8090, ./vocala.db
./vocala -config config.yaml     # С конфигом
```

### TURN-сервер

Встроенный TURN-сервер запускается автоматически, когда TURN включён и задан публичный IP. `VOCALA_TURN_IP` перекрывает IP из конфига, `VOCALA_TURN_PORT` перекрывает UDP-порт. Если заданы `tls_port`, `tls_host`, `cert_file` и `key_file`, Vocala также поднимает TURNS для клиентов с TLS.

**Когда включать TURN:**
- Пользователи за корпоративными файрволами или symmetric NAT
- WebRTC-соединения падают с ошибкой "ICE failed"
- Сервер развёрнут в публичном интернете

**Когда TURN не нужен:**
- Все пользователи в одной локальной сети
- Локальная разработка/тестирование

**Credentials** генерируются автоматически при каждом запуске и передаются клиентам через HTML-шаблон.

### База данных

SQLite создаётся автоматически при первом запуске. WAL-режим включён для конкурентного чтения/записи. В Docker БД хранится в named volume.

### Сессии

- Сессии истекают через 30 дней
- Протухшие сессии автоматически очищаются каждый час
- Токены -- 64-символьные hex-строки (32 байта энтропии)
- Guest-сессии используют отдельную временную cookie, привязаны к одному каналу и создаются из ссылок `/guest/{token}`

### Хранилище

Записи и расшифровки лежат там, где указывает `storage.backend`: в локальном каталоге (по умолчанию) или в любом S3-совместимом хранилище — AWS S3, Yandex Object Storage, Selectel, MinIO, SeaweedFS, Garage. Бакет должен существовать; Vocala проверяет его при старте. Нет бакета или неверные ключи — запись выключается с ошибкой в логе, а звонки работают; хранилище, которое ещё не отвечает (стартует), даёт только предупреждение, и выгрузки повторяются. Пока идёт запись, файлы пишутся на локальный диск (`recording.tmp_dir`) и выгружаются, когда заканчивается дорожка участника. Если хранилище в этот момент недоступно, выгрузка повторяется несколько минут; не вышло — запись помечается как сбойная, файл остаётся на диске и догружается раз в 10 минут, пока не получится. Воспроизведение читает объект запросами с Range, поэтому перемотка работает. Префикс по умолчанию — `vocala/`; endpoint можно указать и как URL (`https://…`).

Смена хранилища не переносит старые записи: они остаются на прежнем месте, и проиграть их нельзя, пока строки не удалит срок хранения. Если они нужны — скопируйте их в новое хранилище под теми же ключами (`recordings/<id>/...`).

### Расшифровки

Если задан `transcription.url`, каждая законченная запись расшифровывается своим сервисом распознавания — [speaches](https://github.com/speaches-ai/speaches) с faster-whisper на процессоре, как в нашей платформе. Дорожка каждого участника распознаётся отдельно, поэтому расшифровка знает, кто говорил; строки раскладываются по времени звонка (`[00:01:23] Иван: …`). По одной записи, в фоне; по готовности в чат канала приходит сообщение, а в **Recordings** — текст и скачивание `.md`.

В Docker: `VOCALA_STT_URL=http://whisper:8000` в `.env` и `docker compose --profile stt up -d`. Сервису `whisper` нужно до 4 процессоров и 4 ГБ памяти; модель (1,5 ГБ для medium) скачивается с Hugging Face при первом запуске. Звук не покидает вашу сеть.
