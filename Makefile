.PHONY: run build clean

run:
	CGO_ENABLED=1 go run ./cmd/server/

build:
	CGO_ENABLED=1 go build -o voicechat ./cmd/server/

clean:
	rm -f voicechat voicechat.db voicechat.db-wal voicechat.db-shm
