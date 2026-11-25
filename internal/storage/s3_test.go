package storage

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// s3ForTest connects to the S3-compatible storage named by
// VOCALA_TEST_S3_ENDPOINT / _ACCESS_KEY / _SECRET_KEY (plain HTTP) and
// creates the test bucket. Without them the S3 tests are skipped.
func s3ForTest(t *testing.T, prefix string) *S3 {
	t.Helper()
	endpoint := os.Getenv("VOCALA_TEST_S3_ENDPOINT")
	if endpoint == "" {
		t.Skip("VOCALA_TEST_S3_ENDPOINT not set")
	}
	ak, sk := os.Getenv("VOCALA_TEST_S3_ACCESS_KEY"), os.Getenv("VOCALA_TEST_S3_SECRET_KEY")
	const bucket = "vocala-test"
	ctx := context.Background()
	admin, err := minio.New(endpoint, &minio.Options{Creds: credentials.NewStaticV4(ak, sk, "")})
	if err != nil {
		t.Fatal(err)
	}
	if ok, _ := admin.BucketExists(ctx, bucket); !ok {
		if err := admin.MakeBucket(ctx, bucket, minio.MakeBucketOptions{}); err != nil {
			t.Fatal(err)
		}
	}
	s, err := NewS3(ctx, S3Config{Endpoint: endpoint, Bucket: bucket, Prefix: prefix, AccessKey: ak, SecretKey: sk, Insecure: true})
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestS3PutOpenSeekDelete(t *testing.T) {
	s := s3ForTest(t, fmt.Sprintf("test-%d/", time.Now().UnixNano()))
	ctx := context.Background()
	src := filepath.Join(t.TempDir(), "a.ogg")
	os.WriteFile(src, []byte("0123456789abcdef"), 0o600)

	if err := s.PutFile(ctx, "recordings/1/2.ogg", src); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(src); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("local file still exists after upload")
	}
	rc, err := s.Open(ctx, "recordings/1/2.ogg")
	if err != nil {
		t.Fatal(err)
	}
	rs, ok := rc.(io.ReadSeeker)
	if !ok {
		t.Fatal("S3 object is not an io.ReadSeeker: the player could not seek")
	}
	if _, err := rs.Seek(10, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	tail, _ := io.ReadAll(rs)
	rc.Close()
	if string(tail) != "abcdef" {
		t.Fatalf("after seek = %q, want abcdef", tail)
	}

	if err := s.Delete(ctx, "recordings/1/2.ogg"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Open(ctx, "recordings/1/2.ogg"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Open after Delete: %v, want ErrNotFound", err)
	}
	if err := s.Delete(ctx, "recordings/1/2.ogg"); err != nil {
		t.Fatalf("Delete of a missing object: %v", err)
	}
}

func TestS3MissingBucketFailsAtStart(t *testing.T) {
	endpoint := os.Getenv("VOCALA_TEST_S3_ENDPOINT")
	if endpoint == "" {
		t.Skip("VOCALA_TEST_S3_ENDPOINT not set")
	}
	_, err := NewS3(context.Background(), S3Config{
		Endpoint: endpoint, Bucket: "no-such-bucket-vocala", Insecure: true,
		AccessKey: os.Getenv("VOCALA_TEST_S3_ACCESS_KEY"), SecretKey: os.Getenv("VOCALA_TEST_S3_SECRET_KEY"),
	})
	if err == nil {
		t.Fatal("NewS3 accepted a missing bucket")
	}
}

func TestS3EndpointWithScheme(t *testing.T) {
	endpoint := os.Getenv("VOCALA_TEST_S3_ENDPOINT")
	if endpoint == "" {
		t.Skip("VOCALA_TEST_S3_ENDPOINT not set")
	}
	s3ForTest(t, "") // makes sure the bucket exists
	_, err := NewS3(context.Background(), S3Config{
		Endpoint: "http://" + endpoint + "/", Bucket: "vocala-test",
		AccessKey: os.Getenv("VOCALA_TEST_S3_ACCESS_KEY"), SecretKey: os.Getenv("VOCALA_TEST_S3_SECRET_KEY"),
	})
	if err != nil {
		t.Fatalf("http:// endpoint: %v", err)
	}
}

func TestS3RejectsEscapingKeys(t *testing.T) {
	s := &S3{prefix: "p/"}
	for _, key := range []string{"", "/", "../x", "a/../../x", `a\b`} {
		if _, err := s.object(key); err == nil {
			t.Errorf("key %q accepted", key)
		}
	}
	if got, _ := s.object("recordings/1/2.ogg"); got != "p/recordings/1/2.ogg" {
		t.Errorf("object name = %q", got)
	}
}

// A storage still starting must not turn recording off for good.
func TestS3UnreachableAtStartIsUsable(t *testing.T) {
	s, err := NewS3(context.Background(), S3Config{Endpoint: "127.0.0.1:1", Bucket: "b", Insecure: true})
	if !errors.Is(err, ErrUnreachable) || s == nil {
		t.Fatalf("NewS3 on a closed port = %v, %v; want a usable S3 and ErrUnreachable", s, err)
	}
}
