# Vocipher

Self-hosted voice chat server. A lightweight, single-binary alternative to Discord focused on voice communication.

**[vocipher.com](https://vocipher.com)**

## Features

- **WebRTC SFU** — Low-latency voice powered by [Pion WebRTC](https://github.com/pion/webrtc), using a Selective Forwarding Unit architecture for efficient multi-party audio
- **Voice Activity Detection** — Real-time VAD with configurable sensitivity threshold and visual audio level meter
- **Push-to-Talk** — Optional PTT mode activated with spacebar
- **Screen Sharing** — Share your screen with live preview thumbnails for other users
- **Channels** — Create and manage voice channels with real-time presence and user counts
- **Authentication** — Session-based auth with bcrypt password hashing, HTTP-only cookies, and CSRF protection
- **Single Binary** — No external dependencies. SQLite database, embedded templates, one process to run
- **Modern UI** — Dark-themed interface built with HTMX and Tailwind CSS, no frontend build step

## Requirements

- Go 1.21+
- C compiler (required for SQLite via cgo)

## Quick Start

```bash
git clone https://github.com/kidandcat/vocipher.git
cd vocipher

# Build
make build

# Run
./vocipher
```

The server starts at `http://localhost:8090`. Register a user, create a channel, and start talking.

For development:

```bash
make run    # Compile and run in one step
make clean  # Remove binary and database files
```

## Stack

| Component | Technology |
|-----------|------------|
| Backend | Go |
| WebRTC | [Pion WebRTC](https://github.com/pion/webrtc) |
| Database | SQLite (WAL mode) |
| WebSocket | [Gorilla WebSocket](https://github.com/gorilla/websocket) |
| Frontend | HTMX + Tailwind CSS + Vanilla JS |
| Auth | bcrypt + session cookies |

## License

MIT
