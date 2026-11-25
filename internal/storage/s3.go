package storage

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"os"
	"path"
	"strings"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// S3Config points to a bucket in any S3-compatible storage (AWS, Yandex
// Object Storage, Selectel, MinIO, SeaweedFS, Garage).
type S3Config struct {
	Endpoint  string // host[:port], without scheme
	Region    string // empty for most non-AWS services
	Bucket    string // must exist
	Prefix    string // optional folder inside the bucket, e.g. "vocala/"
	AccessKey string
	SecretKey string
	Insecure  bool // plain HTTP, for a storage on the local network
}

// ErrUnreachable is wrapped by NewS3 when the storage could not be reached
// at all (still starting, network down). The returned S3 is usable: later
// uploads retry, unlike with a wrong bucket or keys.
var ErrUnreachable = errors.New("storage: s3 unreachable")

// S3 keeps objects in a bucket under Prefix+key.
type S3 struct {
	client *minio.Client
	bucket string
	prefix string
}

// NewS3 connects and checks that the bucket exists and is reachable with
// the given keys, so a misconfiguration shows at startup, not on the first
// recording. A storage that does not answer yet is not a misconfiguration:
// NewS3 then returns a working S3 together with ErrUnreachable.
func NewS3(ctx context.Context, cfg S3Config) (*S3, error) {
	// A URL is a likely mistake for host[:port]; take the scheme from it.
	switch {
	case strings.HasPrefix(cfg.Endpoint, "https://"):
		cfg.Endpoint = strings.TrimPrefix(cfg.Endpoint, "https://")
	case strings.HasPrefix(cfg.Endpoint, "http://"):
		cfg.Endpoint = strings.TrimPrefix(cfg.Endpoint, "http://")
		cfg.Insecure = true
	}
	cfg.Endpoint = strings.TrimRight(cfg.Endpoint, "/")
	if cfg.Endpoint == "" || cfg.Bucket == "" {
		return nil, errors.New("storage: s3 needs endpoint and bucket")
	}
	client, err := minio.New(cfg.Endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(cfg.AccessKey, cfg.SecretKey, ""),
		Secure: !cfg.Insecure,
		Region: cfg.Region,
	})
	if err != nil {
		return nil, fmt.Errorf("storage: s3 client: %w", err)
	}
	prefix := strings.Trim(cfg.Prefix, "/")
	if prefix != "" {
		prefix += "/"
	}
	s := &S3{client: client, bucket: cfg.Bucket, prefix: prefix}
	exists, err := client.BucketExists(ctx, cfg.Bucket)
	switch {
	case err != nil && minio.ToErrorResponse(err).Code == "":
		// No S3 answer at all: a transport error.
		return s, fmt.Errorf("%w: bucket %q: %v", ErrUnreachable, cfg.Bucket, err)
	case err != nil:
		// The storage answered with an error: wrong keys, no access.
		return nil, fmt.Errorf("storage: s3 bucket %q: %w", cfg.Bucket, err)
	case !exists:
		return nil, fmt.Errorf("storage: s3 bucket %q does not exist", cfg.Bucket)
	}
	return s, nil
}

func (s *S3) object(key string) (string, error) {
	clean, err := cleanKey(key)
	if err != nil {
		return "", err
	}
	return s.prefix + clean, nil
}

// PutFile uploads the file and removes it locally once the upload is done.
func (s *S3) PutFile(ctx context.Context, key, localPath string) error {
	name, err := s.object(key)
	if err != nil {
		return err
	}
	opts := minio.PutObjectOptions{ContentType: mime.TypeByExtension(path.Ext(key))}
	if opts.ContentType == "" {
		opts.ContentType = "application/octet-stream"
	}
	if _, err := s.client.FPutObject(ctx, s.bucket, name, localPath, opts); err != nil {
		return fmt.Errorf("storage: upload %s: %w", key, err)
	}
	return os.Remove(localPath)
}

// Open returns the object as an io.ReadSeeker: reads and seeks become
// ranged requests, so the audio player can jump inside a recording.
func (s *S3) Open(ctx context.Context, key string) (io.ReadCloser, error) {
	name, err := s.object(key)
	if err != nil {
		return nil, err
	}
	obj, err := s.client.GetObject(ctx, s.bucket, name, minio.GetObjectOptions{})
	if err != nil {
		return nil, err
	}
	// GetObject is lazy; Stat makes the request and reports a missing key.
	// (A HEAD request cannot tell a missing bucket from a missing key; the
	// bucket is checked at startup.)
	if _, err := obj.Stat(); err != nil {
		obj.Close()
		if minio.ToErrorResponse(err).Code == "NoSuchKey" {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return obj, nil
}

func (s *S3) Delete(ctx context.Context, key string) error {
	name, err := s.object(key)
	if err != nil {
		return err
	}
	err = s.client.RemoveObject(ctx, s.bucket, name, minio.RemoveObjectOptions{})
	if err != nil && minio.ToErrorResponse(err).Code == "NoSuchKey" {
		return nil
	}
	return err
}
