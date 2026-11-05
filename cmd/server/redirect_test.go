package main

import "testing"

func TestSafeNext(t *testing.T) {
	cases := map[string]string{
		"":                  "/",
		"/channels/general": "/channels/general",
		"//evil.com":        "/",
		"/\\evil.com":       "/",
		"https://evil.com":  "/",
		"evil.com":          "/",
	}
	for in, want := range cases {
		if got := safeNext(in); got != want {
			t.Errorf("safeNext(%q) = %q, want %q", in, got, want)
		}
	}
}
