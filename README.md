# Vocipher

Self-hosted voice chat server. A lightweight, single-binary alternative to Discord focused on voice communication.

**[vocipher.com](https://vocipher.com)**

## Features

- **WebRTC SFU** -- Low-latency voice powered by [Pion WebRTC](https://github.com/pion/webrtc), using a Selective Forwarding Unit architecture for efficient multi-party audio
- **Built-in TURN server** -- Embedded [Pion TURN](https://github.com/pion/turn) for NAT traversal, no external TURN server needed
- **Voice Activity Detection** -- Real-time VAD with configurable sensitivity threshold and visual audio level meter
- **Push-to-Talk** -- Optional PTT mode activated with spacebar
- **Screen Sharing** -- Share your screen with live preview thumbnails for other users
- **Channels** -- Create and manage voice channels with real-time presence and user counts
- **Authentication** -- Session-based auth with bcrypt password hashing, HTTP-only cookies, and CSRF protection
- **Single Binary** -- No external dependencies. SQLite database, embedded TURN, one process to run
- **Modern UI** -- Dark-themed interface built with HTMX and Tailwind CSS, no frontend build step

## Quick Start

### Binary

```bash
git clone https://github.com/kidandcat/vocipher.git
cd vocipher
make build
./vocipher
```

### Docker

```bash
docker compose up -d
```

The server starts at `http://localhost:8090`. Register a user, create a channel, and start talking.

## Configuration

All configuration is done through environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `VOCIPHER_ADDR` | `:8090` | HTTP listen address |
| `VOCIPHER_DB_PATH` | `vocipher.db` | Path to SQLite database file |
| `VOCIPHER_TURN_IP` | *(disabled)* | Public IP for built-in TURN server |

See [docs/configuration.md](docs/configuration.md) for details.

## Documentation

| Document | Description |
|----------|-------------|
| [Architecture](docs/architecture.md) | System design, SFU, WebSocket protocol, database schema |
| [Configuration](docs/configuration.md) | Environment variables and tuning |
| [Deployment](docs/deployment.md) | Docker, Nginx, HTTPS, TURN setup |
| [Security](docs/security.md) | Authentication, CSRF, rate limiting, hardening |

## Stack

| Component | Technology |
|-----------|------------|
| Backend | Go |
| WebRTC | [Pion WebRTC](https://github.com/pion/webrtc) |
| TURN | [Pion TURN](https://github.com/pion/turn) (embedded) |
| Database | SQLite (WAL mode) |
| WebSocket | [Gorilla WebSocket](https://github.com/gorilla/websocket) |
| Frontend | HTMX + Tailwind CSS + Vanilla JS |
| Auth | bcrypt + session cookies |

## Development

```bash
make run    # Compile and run
make build  # Build binary
make clean  # Remove binary and database files
```

## License

MIT
