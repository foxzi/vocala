// Package storage keeps finished files (call recordings, transcripts) behind
// one interface, so the code that produces them does not know whether they
// live on the local disk or in S3.
package storage

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// ErrNotFound is returned by Open when no object exists under the key.
var ErrNotFound = errors.New("storage: object not found")

// Blobs stores immutable objects under slash-separated keys such as
// "recordings/12/34.ogg".
type Blobs interface {
	// PutFile moves a finished local file into storage under key. The
	// source file is gone after a successful call.
	PutFile(ctx context.Context, key, localPath string) error
	// Open returns the object's content. Local objects are *os.File, so
	// callers may type-assert io.ReadSeeker for range requests.
	Open(ctx context.Context, key string) (io.ReadCloser, error)
	// Delete removes the object; a missing object is not an error.
	Delete(ctx context.Context, key string) error
}

// Local keeps objects as files under Dir.
type Local struct {
	Dir string
}

// NewLocal creates the directory if needed.
func NewLocal(dir string) (*Local, error) {
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return nil, fmt.Errorf("storage: create %s: %w", dir, err)
	}
	return &Local{Dir: dir}, nil
}

func (l *Local) PutFile(_ context.Context, key, localPath string) error {
	dst, err := l.path(key)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o750); err != nil {
		return err
	}
	if err := os.Rename(localPath, dst); err == nil {
		return nil
	}
	// Different filesystem: copy, then remove the source.
	if err := copyFile(localPath, dst); err != nil {
		return err
	}
	return os.Remove(localPath)
}

func (l *Local) Open(_ context.Context, key string) (io.ReadCloser, error) {
	p, err := l.path(key)
	if err != nil {
		return nil, err
	}
	f, err := os.Open(p)
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNotFound
	}
	return f, err
}

func (l *Local) Delete(_ context.Context, key string) error {
	p, err := l.path(key)
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	// Drop the now-empty parent directory; failure just means it is not empty.
	_ = os.Remove(filepath.Dir(p))
	return nil
}

// path maps a key to a file under Dir and rejects keys that would escape it.
func (l *Local) path(key string) (string, error) {
	clean := path.Clean("/" + key)
	if key == "" || clean == "/" || strings.Contains(key, "..") || strings.Contains(key, "\\") {
		return "", fmt.Errorf("storage: invalid key %q", key)
	}
	return filepath.Join(l.Dir, filepath.FromSlash(clean)), nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := dst + ".part"
	out, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(tmp)
		return err
	}
	if err := out.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, dst)
}
