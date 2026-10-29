package conformance

import (
	"context"
	"errors"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/cuelor/providers/conformance/internal/testprovider"
)

// The test binary doubles as a plugin: `<test binary> testprovider [faults...]` runs the test
// provider with the command-form handshake.
func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == "testprovider" {
		os.Exit(testprovider.Main(os.Args[2:]))
	}
	os.Exit(m.Run())
}

func zero() *float64 { v := 0.0; return &v }

func urlOptions(t *testing.T, faults ...string) Options {
	t.Helper()
	opts, _ := urlServer(t, faults...)
	return opts
}

// urlServer is urlOptions that also returns the test provider, to look at what the run did to it.
func urlServer(t *testing.T, faults ...string) (Options, *testprovider.Server) {
	t.Helper()
	set := map[string]bool{}
	for _, f := range faults {
		set[f] = true
	}
	tok := randomToken(40)
	provider := testprovider.New(testprovider.Options{Token: tok, Faults: set})
	srv := httptest.NewServer(provider)
	t.Cleanup(srv.Close)
	t.Cleanup(provider.Close)
	return Options{URL: srv.URL, Token: tok, Live: true, MaxCost: zero(), JobTimeout: 30 * time.Second, FFprobe: "off"}, provider
}

func commandOptions(t *testing.T, faults ...string) Options {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	return Options{
		Command: append([]string{exe, "testprovider"}, faults...),
		Dir:     t.TempDir(), Live: true, MaxCost: zero(), JobTimeout: 30 * time.Second, FFprobe: "off",
	}
}

func run(t *testing.T, opts Options) *Report {
	t.Helper()
	report, err := Run(context.Background(), opts)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	return report
}

func result(t *testing.T, report *Report, id string) Result {
	t.Helper()
	for _, c := range report.Checks {
		if c.ID == id {
			return c
		}
	}
	t.Fatalf("no result for %s", id)
	return Result{}
}

func describe(report *Report) string {
	var b strings.Builder
	for _, c := range report.Checks {
		b.WriteString(c.ID + " " + string(c.Status) + ": " + c.Detail + "\n")
	}
	return b.String()
}

func TestCleanProviderURL(t *testing.T) {
	report := run(t, urlOptions(t))
	if !report.OK() {
		t.Fatalf("the clean provider failed:\n%s", describe(report))
	}
	for _, c := range report.Checks {
		want := StatusPassed
		if c.ID == "A3" || c.ID == "B6" || c.ID == "B7" {
			want = StatusSkipped // command form only
		}
		if c.Status != want {
			t.Errorf("%s: %s, want %s (%s)", c.ID, c.Status, want, c.Detail)
		}
	}
	if len(report.Checks) != len(checkDefs) {
		t.Errorf("%d results, want %d", len(report.Checks), len(checkDefs))
	}
}

func TestCleanProviderCommand(t *testing.T) {
	report := run(t, commandOptions(t))
	if !report.OK() {
		t.Fatalf("the clean provider failed:\n%s", describe(report))
	}
	for _, c := range report.Checks {
		if c.Status != StatusPassed {
			t.Errorf("%s: %s (%s)", c.ID, c.Status, c.Detail)
		}
	}
}

func TestWithoutLiveTiersBAndCAreSkipped(t *testing.T) {
	opts := urlOptions(t)
	opts.Live, opts.MaxCost = false, nil
	report := run(t, opts)
	if !report.OK() {
		t.Fatalf("tier A failed:\n%s", describe(report))
	}
	for _, c := range report.Checks {
		if (c.ID[0] == 'B' || c.ID[0] == 'C') && c.Status != StatusSkipped {
			t.Errorf("%s: %s without --live", c.ID, c.Status)
		}
	}
}

// Each fault must make its check fail.
func TestFaultsAreDetected(t *testing.T) {
	cases := []struct {
		fault   string
		check   string
		command bool
	}{
		{"short-binding", "A1", false},
		{"no-auth", "A2", false},
		{"no-host-check", "A3", true},
		{"accept-origin", "A3", true},
		{"ignore-stdin", "A3", true},
		{"listen-all", "A3", true},
		{"invalid-catalog", "A4", false},
		{"bad-default", "A5", false},
		{"bad-widget", "A5", false},
		{"bad-visible-when", "A5", false},
		{"bad-parameter-rule", "A5", false},
		{"unchecked-references", "A6", false},
		{"no-key-ok", "A6", false},
		{"error-leaks-token", "A6", false},
		{"wrong-sha256", "A7", false},
		{"redirect-needs-token", "A7", false},
		{"redirect-needs-token", "B5", false},
		{"redirect-loop", "A7", false},
		{"redirect-describe", "A1", false},
		{"no-413", "A7", false},
		{"unknown-job-500", "A8", false},
		{"new-job-same-key", "B2", false},
		{"no-conflict", "B3", false},
		{"bad-transition", "B4", false},
		{"two-outputs", "B5", false},
		{"wrong-output-sha", "B5", false},
		{"new-job-same-key", "B6", true},
		{"lose-jobs", "B7", true},
		{"new-job-same-key", "B8", false},
		{"cancel-500", "B9", false},
		{"no-usage", "B10", false},
		{"estimate-schema", "B11", false},
		{"garbled-transcript", "C1", false},
		{"overlapping-units", "C1", false},
		{"wrong-language", "C1", false},
		{"wrong-language", "C2", false},
	}
	for _, tc := range cases {
		t.Run(tc.fault+"/"+tc.check, func(t *testing.T) {
			var opts Options
			if tc.command {
				opts = commandOptions(t, tc.fault)
			} else {
				opts = urlOptions(t, tc.fault)
			}
			opts.Only = []string{tc.check}
			report := run(t, opts)
			if res := result(t, report, tc.check); res.Status != StatusFailed {
				t.Fatalf("%s with fault %s: %s, want failed (%s)", tc.check, tc.fault, res.Status, res.Detail)
			}
			if report.OK() {
				t.Fatal("the report is OK although a check failed")
			}
		})
	}
}

// A download may redirect to another origin that needs no token (spec/v1.md section 3.4). The suite
// follows it, without sending the token there, and checks the final response.
func TestDownloadRedirects(t *testing.T) {
	opts, provider := urlServer(t, "redirect-download")
	opts.Only = []string{"A7", "B5"}
	report := run(t, opts)
	for _, id := range opts.Only {
		if res := result(t, report, id); res.Status != StatusPassed {
			t.Errorf("%s with a redirected download: %s (%s)", id, res.Status, res.Detail)
		}
	}
	requests, withAuth := provider.BlobRequests()
	if requests == 0 {
		t.Error("no download reached the redirect target")
	}
	if withAuth != 0 {
		t.Errorf("%d of %d requests to the other origin carried Authorization", withAuth, requests)
	}

	// The command form: a plugin on 127.0.0.1 may redirect to another loopback port.
	copts := commandOptions(t, "redirect-download")
	copts.Only = []string{"A7"}
	if res := result(t, run(t, copts), "A7"); res.Status != StatusPassed {
		t.Errorf("A7 against a plugin that redirects downloads: %s (%s)", res.Status, res.Detail)
	}
}

// A5 names the field whose shape is wrong, although the catalog then also fails the schema (A4).
func TestA5ReportsShapes(t *testing.T) {
	for fault, want := range map[string]string{
		"bad-widget":         "widget must be a string",
		"bad-visible-when":   "visible_when needs equals",
		"bad-parameter-rule": "parameter_rules[0].reject_values must be an array of strings",
	} {
		t.Run(fault, func(t *testing.T) {
			opts := urlOptions(t, fault)
			opts.Only = []string{"A4", "A5"}
			report := run(t, opts)
			if res := result(t, report, "A4"); res.Status != StatusFailed {
				t.Errorf("A4: %s, want failed (%s)", res.Status, res.Detail)
			}
			if res := result(t, report, "A5"); res.Status != StatusFailed || !strings.Contains(res.Detail, want) {
				t.Errorf("A5: %s (%s), want failed with %q", res.Status, res.Detail, want)
			}
		})
	}
}

func TestResponseTimeLimits(t *testing.T) {
	defer func(must, should time.Duration) { responseMust, responseShould = must, should }(responseMust, responseShould)

	responseMust, responseShould = time.Second, 50*time.Millisecond
	opts := urlOptions(t, "slow-describe")
	opts.Only = []string{"A9"}
	if res := result(t, run(t, opts), "A9"); res.Status != StatusWarning {
		t.Fatalf("A9 over the SHOULD limit: %s, want warning (%s)", res.Status, res.Detail)
	}

	responseMust = 80 * time.Millisecond
	if res := result(t, run(t, opts), "A9"); res.Status != StatusFailed {
		t.Fatalf("A9 over the MUST limit: %s, want failed (%s)", res.Status, res.Detail)
	}
}

// Over the budget, or when the cost cannot be estimated, no job is submitted and the run fails: every
// B and C check fails as "not run", saying why, and A6 only leaves out its valid submission.
func TestBudgetIsEnforced(t *testing.T) {
	cases := []struct {
		fault, maxCost string
		want           []string
	}{
		{"expensive", "0.5", []string{"exceeds --max-cost 0.5 USD", "estimated cost of the live run:", "USD"}},
		{"estimate-503", "0", []string{"cannot be estimated", "HTTP 503"}},
	}
	for _, tc := range cases {
		t.Run(tc.fault, func(t *testing.T) {
			opts, provider := urlServer(t, tc.fault)
			limit := 0.5
			if tc.maxCost == "0" {
				limit = 0
			}
			opts.MaxCost = &limit
			opts.Only = []string{"A6", "B1", "B5", "B8", "B9", "B11", "C1", "C2"}
			report := run(t, opts)
			if report.OK() {
				t.Fatalf("a run over the budget must fail:\n%s", describe(report))
			}
			for _, res := range report.Checks {
				if res.ID == "A6" {
					if res.Status != StatusWarning || !strings.Contains(res.Detail, "the valid submission after the invalid ones was not made") {
						t.Errorf("A6: %s (%s), want a warning that the valid submission was left out", res.Status, res.Detail)
					}
					if res.NotRun {
						t.Errorf("A6 ran and must not be marked not_run")
					}
					continue
				}
				if res.Status != StatusFailed || !res.NotRun || !strings.HasPrefix(res.Detail, "not run: ") || !strings.Contains(res.Detail, "no job was submitted") {
					t.Errorf("%s: %s not_run=%v (%s), want failed, not_run, \"not run: ... no job was submitted\"", res.ID, res.Status, res.NotRun, res.Detail)
				}
				for _, w := range tc.want {
					if !strings.Contains(res.Detail, w) {
						t.Errorf("%s: the detail %q does not mention %q", res.ID, res.Detail, w)
					}
				}
			}
			if n := provider.JobCount(); n != 0 {
				t.Errorf("%d jobs were submitted over the budget, want none", n)
			}
		})
	}
}

// B7 must see the job running when it kills the plugin. When every job ends before that, the
// check warns instead of passing.
func TestB7KillsARunningJob(t *testing.T) {
	opts := commandOptions(t)
	opts.Only = []string{"B7"}
	if res := result(t, run(t, opts), "B7"); res.Status != StatusPassed || !strings.Contains(res.Detail, "while the job was running") {
		t.Errorf("B7 against the clean provider: %s (%s), want passed with the job killed while running", res.Status, res.Detail)
	}
	opts = commandOptions(t, "instant-jobs")
	opts.Only = []string{"B7"}
	if res := result(t, run(t, opts), "B7"); res.Status != StatusWarning || !strings.Contains(res.Detail, "never saw a job running") {
		t.Errorf("B7 with jobs that end at once: %s (%s), want a warning", res.Status, res.Detail)
	}
}

// Cancelling the context ends the run within a few seconds, wherever it waits.
func TestCancellationIsPrompt(t *testing.T) {
	cases := map[string]func(t *testing.T) Options{
		"polling a job": func(t *testing.T) Options {
			opts := urlOptions(t, "stuck-jobs")
			opts.JobTimeout = 10 * time.Minute
			opts.Only = []string{"B1"}
			return opts
		},
		"retrying a submission": func(t *testing.T) Options {
			opts := urlOptions(t, "submit-503")
			opts.Only = []string{"B8"}
			return opts
		},
		"waiting for the handshake": func(t *testing.T) Options {
			return Options{Command: []string{"/bin/sh", "-c", "read token; sleep 60"}, StartTimeout: 40 * time.Second, Only: []string{"A1"}}
		},
	}
	for name, build := range cases {
		t.Run(name, func(t *testing.T) {
			opts := build(t)
			ctx, cancel := context.WithCancel(context.Background())
			time.AfterFunc(time.Second, cancel)
			started := time.Now()
			report, err := Run(ctx, opts)
			if err != nil {
				t.Fatalf("Run: %v", err)
			}
			if d := time.Since(started); d > 4*time.Second {
				t.Errorf("Run returned %s after the start, %s after the cancellation", d.Round(time.Millisecond), (d - time.Second).Round(time.Millisecond))
			}
			if report.OK() {
				t.Errorf("a cancelled run must not pass:\n%s", describe(report))
			}
		})
	}
}

func TestHandshakeFailureFailsEveryCheck(t *testing.T) {
	opts := Options{Command: []string{"/bin/sh", "-c", "read token; echo not-the-line; sleep 5"}, StartTimeout: time.Second, Only: []string{"A1", "A4"}}
	report := run(t, opts)
	for _, c := range report.Checks {
		if c.Status != StatusFailed || !strings.Contains(c.Detail, "cuelor-provider-listening") {
			t.Errorf("%s: %s (%s)", c.ID, c.Status, c.Detail)
		}
	}
}

func TestInvalidOptions(t *testing.T) {
	one := 1.0
	cases := map[string]Options{
		"live without max cost":      {URL: "http://127.0.0.1:1", Token: "x", Live: true},
		"command and URL":            {URL: "http://127.0.0.1:1", Token: "x", Command: []string{"true"}},
		"URL without token":          {URL: "http://127.0.0.1:1"},
		"unknown check":              {URL: "http://127.0.0.1:1", Token: "x", Only: []string{"Z9"}},
		"no target":                  {},
		"negative max cost":          {URL: "http://127.0.0.1:1", Token: "x", MaxCost: func() *float64 { v := -one; return &v }()},
		"model without a name":       {URL: "http://127.0.0.1:1", Token: "x", Models: map[string]string{"image": ""}},
		"model without a capability": {URL: "http://127.0.0.1:1", Token: "x", Models: map[string]string{"": "test/image"}},
	}
	for name, opts := range cases {
		if _, err := Run(context.Background(), opts); !errors.Is(err, ErrInvalidOptions) {
			t.Errorf("%s: got %v, want ErrInvalidOptions", name, err)
		}
	}
}

func TestCancelledRun(t *testing.T) {
	opts := urlOptions(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	report, err := Run(ctx, opts)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if report.OK() {
		t.Fatalf("a cancelled run must not pass:\n%s", describe(report))
	}
}
