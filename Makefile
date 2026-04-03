.PHONY: run build clean package deb rpm

run:
	CGO_ENABLED=1 go run ./cmd/server/

build:
	CGO_ENABLED=1 go build -o vocipher ./cmd/server/

clean:
	rm -f vocipher vocipher.db vocipher.db-wal vocipher.db-shm
	rm -rf dist/

deb: build
	mkdir -p dist
	nfpm package --packager deb --target dist/

rpm: build
	mkdir -p dist
	nfpm package --packager rpm --target dist/

package: deb rpm
