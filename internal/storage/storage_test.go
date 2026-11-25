package storage

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestLocalPutOpenDelete(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	l, err := NewLocal(filepath.Join(dir, "blobs"))
	if err != nil {
		t.Fatal(err)
	}
	src := filepath.Join(dir, "src.ogg")
	os.WriteFile(src, []byte("audio"), 0o600)

	if err := l.PutFile(ctx, "recordings/1/2.ogg", src); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(src); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("source file still exists after PutFile")
	}
	rc, err := l.Open(ctx, "recordings/1/2.ogg")
	if err != nil {
		t.Fatal(err)
	}
	data, _ := io.ReadAll(rc)
	rc.Close()
	if string(data) != "audio" {
		t.Fatalf("content = %q", data)
	}
	if err := l.Delete(ctx, "recordings/1/2.ogg"); err != nil {
		t.Fatal(err)
	}
	if _, err := l.Open(ctx, "recordings/1/2.ogg"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Open after Delete: %v, want ErrNotFound", err)
	}
	if err := l.Delete(ctx, "recordings/1/2.ogg"); err != nil {
		t.Fatalf("Delete of a missing object: %v", err)
	}
}

func TestLocalRejectsEscapingKeys(t *testing.T) {
	l, _ := NewLocal(t.TempDir())
	for _, key := range []string{"", "/", "../x", "a/../../x", `a\b`} {
		if _, err := l.Open(context.Background(), key); err == nil || errors.Is(err, ErrNotFound) {
			t.Errorf("key %q: err = %v, want invalid key", key, err)
		}
	}
}
