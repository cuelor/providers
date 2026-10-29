package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/cuelor/providers/conformance/internal/testprovider"
)

func TestJSONOutputShape(t *testing.T) {
	tok := "t0k3nt0k3nt0k3nt0k3nt0k3nt0k3nt0k3n"
	srv := httptest.NewServer(testprovider.New(testprovider.Options{Token: tok}))
	defer srv.Close()
	tokenFile := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenFile, []byte(tok+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var out, errOut bytes.Buffer
	code := run([]string{"--url", srv.URL, "--token-file", tokenFile, "--only", "A1,A4,B1", "--output", "json"}, &out, &errOut)
	if code != 0 {
		t.Fatalf("exit %d: %s %s", code, out.String(), errOut.String())
	}
	var report map[string]any
	if err := json.Unmarshal(out.Bytes(), &report); err != nil {
		t.Fatal(err)
	}
	if keys(report) != "checks,status,summary" {
		t.Errorf("report keys: %s", keys(report))
	}
	checks := report["checks"].([]any)
	if len(checks) != 3 {
		t.Fatalf("%d checks", len(checks))
	}
	for _, c := range checks {
		if keys(c.(map[string]any)) != "detail,duration_ms,id,name,status" {
			t.Errorf("check keys: %s", keys(c.(map[string]any)))
		}
	}
	if report["status"] != "passed" || checks[2].(map[string]any)["status"] != "skipped" {
		t.Errorf("unexpected statuses: %s", out.String())
	}
}

func TestExitCodes(t *testing.T) {
	tok := "t0k3nt0k3nt0k3nt0k3nt0k3nt0k3nt0k3n"
	srv := httptest.NewServer(testprovider.New(testprovider.Options{Token: tok, Faults: map[string]bool{"no-auth": true}}))
	defer srv.Close()
	t.Setenv("CUELOR_PROVIDER_TEST_TOKEN", tok)
	var out, errOut bytes.Buffer
	if code := run([]string{"--url", srv.URL, "--only", "A2"}, &out, &errOut); code != 1 {
		t.Errorf("a failing check: exit %d, want 1", code)
	}
	if !strings.Contains(out.String(), "FAIL A2") {
		t.Errorf("text output: %s", out.String())
	}
	if code := run([]string{"--url", srv.URL, "--live"}, &out, &errOut); code != 2 {
		t.Errorf("--live without --max-cost: exit %d, want 2", code)
	}
	if code := run([]string{"--output", "xml"}, &out, &errOut); code != 2 {
		t.Errorf("bad --output: exit %d, want 2", code)
	}
}

func keys(m map[string]any) string {
	out := []string{}
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return strings.Join(out, ",")
}

// --env NAME copies NAME from the suite's own environment, so a key never has to be on the command line.
func TestEnvByName(t *testing.T) {
	t.Setenv("CUELOR_PROVIDER_TEST_KEY", "value-from-the-environment")
	var env envList
	if err := env.Set("CUELOR_PROVIDER_TEST_KEY"); err != nil {
		t.Fatal(err)
	}
	if err := env.Set("PLAIN=1"); err != nil {
		t.Fatal(err)
	}
	if want := []string{"CUELOR_PROVIDER_TEST_KEY=value-from-the-environment", "PLAIN=1"}; strings.Join(env, "|") != strings.Join(want, "|") {
		t.Errorf("env = %q, want %q", env, want)
	}
	if err := env.Set("CUELOR_PROVIDER_TEST_UNSET_VARIABLE"); err == nil {
		t.Error("--env with an unset name must be an error")
	}
	var out, errOut bytes.Buffer
	if code := run([]string{"--env", "CUELOR_PROVIDER_TEST_UNSET_VARIABLE", "--url", "http://127.0.0.1:1"}, &out, &errOut); code != 2 {
		t.Errorf("--env with an unset name: exit %d, want 2", code)
	}
}

// --model is parsed before the service is contacted: a malformed or repeated value is a usage error
// and no request is sent. A valid one chooses the case the B checks run.
func TestModelFlag(t *testing.T) {
	tok := "t0k3nt0k3nt0k3nt0k3nt0k3nt0k3nt0k3n"
	var requests atomic.Int64
	provider := testprovider.New(testprovider.Options{Token: tok, Faults: map[string]bool{"free-image": true}})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		provider.ServeHTTP(w, r)
	}))
	defer srv.Close()
	t.Setenv("CUELOR_PROVIDER_TEST_TOKEN", tok)
	base := []string{"--url", srv.URL, "--live", "--max-cost", "0"}
	for _, bad := range [][]string{
		{"--model", "image"},
		{"--model", "=test/image"},
		{"--model", "image="},
		{"--model", "image=test/image", "--model", "image=test/image:image2image"},
	} {
		var out, errOut bytes.Buffer
		if code := run(append(append([]string{}, base...), bad...), &out, &errOut); code != 2 {
			t.Errorf("%q: exit %d, want 2", bad, code)
		}
		if !strings.Contains(errOut.String(), "-model") {
			t.Errorf("%q: the error does not name --model: %s", bad, errOut.String())
		}
	}
	if n := requests.Load(); n != 0 {
		t.Fatalf("%d requests were sent for usage errors, want none", n)
	}
	var out, errOut bytes.Buffer
	args := append(append([]string{}, base...), "--only", "B1", "--output", "json", "--model", "image=test/image:free:image2image")
	if code := run(args, &out, &errOut); code != 0 {
		t.Fatalf("exit %d: %s %s", code, out.String(), errOut.String())
	}
	if !strings.Contains(out.String(), "job for image (test/image:free, image2image), from --model image") {
		t.Errorf("B1 does not use the --model case: %s", out.String())
	}
}
