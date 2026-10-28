package conformance

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

type runner struct {
	ctx     context.Context
	opts    Options
	t       target
	cmd     commandControl // nil for the URL form
	client  *http.Client
	schemas *schemaSet

	ownedDirs []string
	selected  map[string]bool

	manifest *manifest

	desc    *description
	descErr error
	cat     *catalog
	catErr  error
	// catUnchecked is a catalog that decoded but does not match the schema; only A5 looks at it.
	catUnchecked *catalog

	mu      sync.Mutex
	timings map[string][]time.Duration
	jobIDs  map[string]bool

	budgetOnce sync.Once
	budgetErr  error
	budgetNote string

	planOnce sync.Once
	plan     *livePlan
	planErr  error

	primaryOnce sync.Once
	primary     *primaryRun
}

func newRunner(ctx context.Context, opts Options) (*runner, error) {
	schemas, err := loadSchemas()
	if err != nil {
		return nil, fmt.Errorf("loading the embedded schemas: %w", err)
	}
	r := &runner{
		ctx:     ctx,
		opts:    opts,
		schemas: schemas,
		timings: map[string][]time.Duration{},
		jobIDs:  map[string]bool{},
		client: &http.Client{
			// Every request sets its own deadline through its context. Only downloads follow
			// redirects.
			CheckRedirect: checkRedirect,
		},
	}
	if opts.Manifest != "" {
		m, err := r.loadManifest(opts.Manifest)
		if err != nil {
			return nil, optionsError("manifest %s: %v", opts.Manifest, err)
		}
		r.manifest = m
	}
	if opts.URL != "" {
		r.t = &urlTarget{url: opts.URL, tok: opts.Token}
		return r, nil
	}

	argv := opts.Command
	if len(argv) == 0 {
		switch r.manifest.Runtime.Kind {
		case "node":
			node := opts.NodePath
			if node == "" {
				node = "node"
			}
			argv = []string{node, r.manifest.Runtime.Entry}
		case "exec":
			argv = r.manifest.Runtime.Command
		default:
			return nil, optionsError("the manifest has no runtime the suite can start")
		}
	}
	dir := opts.Dir
	if dir == "" {
		dir = "."
	}
	if dir, err = filepath.Abs(dir); err != nil {
		return nil, err
	}
	if argv, err = resolveArgv0(argv, dir); err != nil {
		return nil, optionsError("%v", err)
	}
	tmp, err := os.MkdirTemp("", "cuelor-provider-test-")
	if err != nil {
		return nil, err
	}
	r.ownedDirs = append(r.ownedDirs, tmp)
	dataDir := opts.DataDir
	if dataDir == "" {
		dataDir = filepath.Join(tmp, "data")
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, err
	}
	tmpDir := filepath.Join(tmp, "tmp")
	if err := os.MkdirAll(tmpDir, 0o700); err != nil {
		return nil, err
	}
	cmd, err := newCommandTarget(commandSpec{
		argv: argv, dir: dir, dataDir: dataDir, tmpDir: tmpDir, extra: opts.Env,
		output: opts.PluginOutput, timeout: opts.StartTimeout,
	})
	if err != nil {
		return nil, optionsError("%v", err)
	}
	r.t, r.cmd = cmd, cmd
	return r, nil
}

func (r *runner) loadManifest(path string) (*manifest, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
	if err != nil {
		return nil, fmt.Errorf("invalid JSON: %w", err)
	}
	if err := r.schemas.validate("manifest", doc); err != nil {
		return nil, err
	}
	var m manifest
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, err
	}
	return &m, nil
}

// start starts the target and reads the description and the catalog once, for the checks that
// depend on them. Problems with either are reported by A1 and A4.
func (r *runner) start() error {
	if err := r.t.start(r.ctx); err != nil {
		return err
	}
	r.refreshDescription()
	return nil
}

func (r *runner) refreshDescription() {
	r.desc, r.descErr = nil, nil
	resp, err := r.send(request{method: "GET", path: "/v1/provider", class: "describe"})
	if err == nil && resp.status == 200 && resp.json != nil {
		var d description
		if json.Unmarshal(resp.body, &d) == nil {
			r.desc = &d
		}
	}
	if r.desc == nil {
		r.descErr = describeFailure(resp, err)
	}
	r.cat, r.catUnchecked, r.catErr = nil, nil, nil
	resp, err = r.send(request{method: "GET", path: "/v1/models", class: "catalog"})
	if err == nil && resp.status == 200 {
		var c catalog
		if json.Unmarshal(resp.body, &c) == nil {
			if verr := r.schemas.validate("catalog", resp.json); verr != nil {
				r.catUnchecked, r.catErr = &c, verr
			} else {
				r.cat = &c
			}
		}
	}
	if r.cat == nil && r.catErr == nil {
		r.catErr = describeFailure(resp, err)
	}
}

func describeFailure(resp *response, err error) error {
	if err != nil {
		return err
	}
	return fmt.Errorf("HTTP %d: %s", resp.status, snippet(resp.body))
}

func (r *runner) close() {
	if r.t != nil {
		r.t.close()
	}
	for _, d := range r.ownedDirs {
		_ = os.RemoveAll(d)
	}
}

// sleep waits for d and reports true, or returns false as soon as the run is cancelled.
func (r *runner) sleep(d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return true
	case <-r.ctx.Done():
		return false
	}
}

func (r *runner) logf(format string, args ...any) {
	fmt.Fprintf(r.opts.Log, format+"\n", args...)
}

// request is one HTTP request of the suite.
type request struct {
	method, path string
	body         []byte
	bodyReader   io.Reader // used instead of body when set
	contentLen   int64
	contentType  string
	headers      map[string]string
	noAuth       bool
	authHeader   string // replaces the Authorization header when set
	host         string // overrides the Host header
	download     bool   // follows redirects (GET /v1/artifacts/{id}/content)
	timeout      time.Duration
	class        string // timing class for A9: describe, catalog, query
}

type response struct {
	status  int
	header  http.Header
	body    []byte
	json    any // decoded for schema validation, nil when the body is not JSON
	elapsed time.Duration
}

func (r *runner) send(req request) (*response, error) {
	timeout := req.timeout
	if timeout == 0 {
		timeout = r.opts.RequestTimeout
	}
	ctx, cancel := context.WithTimeout(r.ctx, timeout)
	defer cancel()
	if req.download {
		ctx = context.WithValue(ctx, downloadKey{}, true)
	}
	var body io.Reader
	if req.bodyReader != nil {
		body = req.bodyReader
	} else if req.body != nil {
		body = bytes.NewReader(req.body)
	}
	hreq, err := http.NewRequestWithContext(ctx, req.method, r.t.baseURL()+req.path, body)
	if err != nil {
		return nil, err
	}
	if req.bodyReader != nil {
		hreq.ContentLength = req.contentLen
	}
	hreq.Header.Set("Cuelor-Protocol", ProtocolVersion)
	hreq.Header.Set("Accept", "application/json")
	if req.contentType != "" {
		hreq.Header.Set("Content-Type", req.contentType)
	}
	switch {
	case req.authHeader != "":
		hreq.Header.Set("Authorization", req.authHeader)
	case !req.noAuth:
		hreq.Header.Set("Authorization", "Bearer "+r.t.token())
	}
	for k, v := range req.headers {
		hreq.Header.Set(k, v)
	}
	if req.host != "" {
		hreq.Host = req.host
	}
	started := time.Now()
	hresp, err := r.client.Do(hreq)
	if err != nil {
		r.recordTiming(req.class, time.Since(started))
		return nil, fmt.Errorf("%s %s: %w", req.method, req.path, err)
	}
	defer hresp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(hresp.Body, 1<<30))
	elapsed := time.Since(started)
	if err != nil {
		return nil, fmt.Errorf("%s %s: reading the response: %w", req.method, req.path, err)
	}
	r.recordTiming(req.class, elapsed)
	resp := &response{status: hresp.StatusCode, header: hresp.Header, body: data, elapsed: elapsed}
	if strings.Contains(hresp.Header.Get("Content-Type"), "json") || looksLikeJSON(data) {
		if v, err := jsonschema.UnmarshalJSON(bytes.NewReader(data)); err == nil {
			resp.json = v
		}
	}
	return resp, nil
}

func (r *runner) recordTiming(class string, d time.Duration) {
	if class == "" {
		return
	}
	r.mu.Lock()
	r.timings[class] = append(r.timings[class], d)
	r.mu.Unlock()
}

func looksLikeJSON(b []byte) bool {
	t := bytes.TrimSpace(b)
	return len(t) > 0 && (t[0] == '{' || t[0] == '[')
}

// mustSend sends a request and ends the check when it fails at the transport level.
func (r *runner) mustSend(c *checkCtx, req request) *response {
	resp, err := r.send(req)
	if err != nil {
		c.fatal("%v", err)
	}
	return resp
}

// sendJSON sends a JSON body.
func (r *runner) sendJSON(method, path string, body any, headers map[string]string) (*response, error) {
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	return r.send(request{method: method, path: path, body: raw, contentType: "application/json", headers: headers})
}

// expectError checks a response is an error with the given status and code (code "" accepts any)
// and the standard body. It returns the decoded error, or nil after recording a failure.
func (r *runner) expectError(c *checkCtx, what string, resp *response, status int, code string) *errorObj {
	if resp.status != status {
		c.fail("%s: expected HTTP %d, got %d (%s)", what, status, resp.status, snippet(resp.body))
		return nil
	}
	return r.checkErrorBody(c, what, resp, code)
}

// checkErrorBody checks the standard error body and that the message leaks nothing.
func (r *runner) checkErrorBody(c *checkCtx, what string, resp *response, code string) *errorObj {
	if resp.json == nil {
		c.fail("%s: HTTP %d without a JSON error body (%s)", what, resp.status, snippet(resp.body))
		return nil
	}
	if err := r.schemas.validate("error", resp.json); err != nil {
		c.fail("%s: the error body %v", what, err)
		return nil
	}
	var body struct {
		Error errorObj `json:"error"`
	}
	_ = json.Unmarshal(resp.body, &body)
	if code != "" && body.Error.Code != code {
		c.fail("%s: expected error code %q, got %q", what, code, body.Error.Code)
	}
	if leak := r.leakedSecret(body.Error.Message); leak != "" {
		c.fail("%s: the error message contains %s", what, leak)
	}
	return &body.Error
}

// leakedSecret reports whether text contains the bearer token or a long part of it.
func (r *runner) leakedSecret(text string) string {
	tok := r.t.token()
	if tok == "" || text == "" {
		return ""
	}
	if strings.Contains(text, tok) {
		return "the bearer token"
	}
	const window = 12
	for i := 0; i+window <= len(tok); i++ {
		if strings.Contains(text, tok[i:i+window]) {
			return "a fragment of the bearer token"
		}
	}
	return ""
}

// upload sends one file to POST /v1/artifacts.
func (r *runner) upload(data []byte, mediaType, filename string) (*response, error) {
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	h := textproto.MIMEHeader{}
	h.Set("Content-Disposition", fmt.Sprintf(`form-data; name="file"; filename="%s"`, filename))
	h.Set("Content-Type", mediaType)
	part, err := mw.CreatePart(h)
	if err != nil {
		return nil, err
	}
	_, _ = part.Write(data)
	_ = mw.Close()
	return r.send(request{
		method: "POST", path: "/v1/artifacts", body: buf.Bytes(),
		contentType: mw.FormDataContentType(), timeout: 5 * time.Minute,
	})
}

// mustUpload uploads and decodes the artifact, ending the check on failure.
func (r *runner) mustUpload(c *checkCtx, data []byte, mediaType, filename string) artifact {
	resp, err := r.upload(data, mediaType, filename)
	if err != nil {
		c.fatal("uploading %s: %v", filename, err)
	}
	if resp.status != 200 && resp.status != 201 {
		c.fatal("uploading %s: HTTP %d (%s)", filename, resp.status, snippet(resp.body))
	}
	if err := r.schemas.validate("artifact", resp.json); err != nil {
		c.fatal("uploading %s: the response %v", filename, err)
	}
	var a artifact
	_ = json.Unmarshal(resp.body, &a)
	return a
}

// rememberJob records a job id the suite has seen, for B11.
func (r *runner) rememberJob(id string) {
	r.mu.Lock()
	r.jobIDs[id] = true
	r.mu.Unlock()
}

func (r *runner) seenJob(id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.jobIDs[id]
}

func (r *runner) maxTiming(class string) (time.Duration, int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var max time.Duration
	for _, d := range r.timings[class] {
		if d > max {
			max = d
		}
	}
	return max, len(r.timings[class])
}

// requireDescription ends the check when GET /v1/provider could not be read.
func (r *runner) requireDescription(c *checkCtx) *description {
	if r.desc == nil {
		c.fatal("GET /v1/provider failed, so the capabilities are unknown: %v", r.descErr)
	}
	return r.desc
}

// requireCatalog ends the check when GET /v1/models could not be read or is invalid.
func (r *runner) requireCatalog(c *checkCtx) *catalog {
	if r.cat == nil {
		if r.desc != nil && r.desc.Account.Status != "ready" {
			c.fatal("GET /v1/models failed (%v); the account is %s, and the catalog and job endpoints only work once it is ready: set up the upstream key first", r.catErr, r.desc.Account.Status)
		}
		c.fatal("GET /v1/models failed or does not match the schema: %v", r.catErr)
	}
	return r.cat
}

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// snippet shortens a response body for a detail line.
func snippet(b []byte) string {
	s := strings.TrimSpace(string(b))
	s = strings.Map(func(r rune) rune {
		if r < 0x20 {
			return ' '
		}
		return r
	}, s)
	if len(s) > 200 {
		s = s[:200] + "…"
	}
	if s == "" {
		return "empty body"
	}
	return s
}

func lastLines(s string, n int) string {
	lines := strings.Split(strings.TrimRight(s, "\n"), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}

// newKey returns a fresh Idempotency-Key for the given purpose.
func newKey(purpose string) string {
	return "conformance-" + purpose + "-" + randomToken(16)
}

func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// maxRedirects is how many redirects a download may take (spec/v1.md section 3.4).
const maxRedirects = 5

type downloadKey struct{}

// checkRedirect follows redirects only for downloads, which mark their context; every other
// endpoint is answered by its first response.
func checkRedirect(req *http.Request, via []*http.Request) error {
	if req.Context().Value(downloadKey{}) == nil {
		return noRedirect(req, via)
	}
	return followDownloadRedirect(req, via)
}

func noRedirect(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

// followDownloadRedirect applies the download rules of spec/v1.md section 3.4 to the next request:
// at most 5 redirects, never from https to http, and no Authorization to another origin. Go's own
// rule keeps the header for another port of the same host, so the origin is compared here. A
// loopback target is allowed: the services the suite tests are often on 127.0.0.1 themselves.
func followDownloadRedirect(req *http.Request, via []*http.Request) error {
	if len(via) > maxRedirects {
		return fmt.Errorf("the download took more than %d redirects", maxRedirects)
	}
	if prev := via[len(via)-1]; prev.URL.Scheme == "https" && req.URL.Scheme != "https" {
		return fmt.Errorf("a download redirected from https to %s (%s)", req.URL.Scheme, req.URL.Redacted())
	}
	if !sameOrigin(via[0].URL, req.URL) {
		req.Header.Del("Authorization")
	}
	return nil
}

// sameOrigin compares scheme, host and port, with the scheme's default port filled in.
func sameOrigin(a, b *url.URL) bool {
	port := func(u *url.URL) string {
		if p := u.Port(); p != "" {
			return p
		}
		if strings.EqualFold(u.Scheme, "https") {
			return "443"
		}
		return "80"
	}
	return strings.EqualFold(a.Scheme, b.Scheme) && strings.EqualFold(a.Hostname(), b.Hostname()) && port(a) == port(b)
}
