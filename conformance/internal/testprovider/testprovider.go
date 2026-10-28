// Package testprovider is a small, complete Provider API v1 service used by the suite's own tests.
// It is written against the specification. Faults switch on one deliberate defect each, so the tests
// can prove that every check fails when it should.
package testprovider

import (
	"bufio"
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"mime"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
)

// Options configures a Server.
type Options struct {
	Token   string
	Faults  map[string]bool
	DataDir string // persist state here when set (needed for restarts)
	// Port, when set, makes the server require Host 127.0.0.1:<Port> (the command form).
	Port func() int
	// QueuedFor and RunFor set how long jobs stay queued and running.
	QueuedFor, RunFor time.Duration
}

// Server implements the protocol in memory, optionally persisted to DataDir.
type Server struct {
	opts Options
	mu   sync.Mutex
	st   *state
	blob *blobStore // the second origin downloads redirect to, in the redirect modes
}

type state struct {
	Seq       int                  `json:"seq"`
	Jobs      map[string]*jobRec   `json:"jobs"`
	Keys      map[string]keyRec    `json:"keys"`
	Artifacts map[string]*artifact `json:"artifacts"`
}

type keyRec struct {
	BodyHash string `json:"body_hash"`
	JobID    string `json:"job_id"`
}

type jobRec struct {
	ID          string     `json:"id"`
	Model       string     `json:"model"`
	Route       string     `json:"route"`
	Created     time.Time  `json:"created"`
	CancelledAt *time.Time `json:"cancelled_at,omitempty"`
	Inputs      []string   `json:"inputs"`
	Language    string     `json:"language"`
	OutputID    string     `json:"output_id,omitempty"`
	Polls       int        `json:"polls"`
}

type artifact struct {
	ID        string    `json:"id"`
	MediaType string    `json:"media_type"`
	SHA256    string    `json:"sha256"`
	Data      []byte    `json:"data"`
	Created   time.Time `json:"created"`
}

// New returns a server. It loads persisted state from DataDir unless the lose-jobs fault is set.
func New(opts Options) *Server {
	if opts.Faults == nil {
		opts.Faults = map[string]bool{}
	}
	if opts.QueuedFor == 0 {
		opts.QueuedFor = 100 * time.Millisecond
	}
	if opts.RunFor == 0 {
		opts.RunFor = 300 * time.Millisecond
	}
	s := &Server{opts: opts, st: &state{Jobs: map[string]*jobRec{}, Keys: map[string]keyRec{}, Artifacts: map[string]*artifact{}}}
	if opts.DataDir != "" && !opts.Faults["lose-jobs"] {
		if raw, err := os.ReadFile(filepath.Join(opts.DataDir, "state.json")); err == nil {
			_ = json.Unmarshal(raw, s.st)
		}
	}
	for _, mode := range redirectModes {
		if opts.Faults[mode] {
			s.blob = newBlobStore(s)
			break
		}
	}
	return s
}

// Close stops the second origin of the redirect modes.
func (s *Server) Close() {
	if s.blob != nil {
		s.blob.close()
	}
}

func (s *Server) save() {
	if s.opts.DataDir == "" || s.opts.Faults["lose-jobs"] {
		return
	}
	raw, _ := json.Marshal(s.st)
	tmp := filepath.Join(s.opts.DataDir, "state.json.tmp")
	if f, err := os.Create(tmp); err == nil {
		_, _ = f.Write(raw)
		_ = f.Sync()
		_ = f.Close()
		_ = os.Rename(tmp, filepath.Join(s.opts.DataDir, "state.json"))
	}
}

func (s *Server) fault(name string) bool { return s.opts.Faults[name] }

// JobCount returns the number of jobs created so far.
func (s *Server) JobCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.st.Jobs)
}

type apiError struct {
	status       int
	code, reason string
	message      string
	params       map[string]any
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, e apiError) {
	body := map[string]any{"code": e.code, "message": e.message}
	if e.reason != "" {
		body["reason"] = e.reason
	}
	if e.params != nil {
		body["params"] = e.params
	}
	writeJSON(w, e.status, map[string]any{"error": body})
}

func invalid(reason, format string, args ...any) *apiError {
	return &apiError{status: 400, code: "invalid_request", reason: reason, message: fmt.Sprintf(format, args...)}
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if s.fault("slow-describe") && r.URL.Path == "/v1/provider" {
		time.Sleep(100 * time.Millisecond)
	}
	if s.opts.Port != nil && !s.fault("no-host-check") && r.Host != fmt.Sprintf("127.0.0.1:%d", s.opts.Port()) {
		writeError(w, apiError{status: 403, code: "forbidden", reason: "host_not_allowed", message: "host not allowed"})
		return
	}
	if r.Header.Get("Origin") != "" && !s.fault("accept-origin") {
		writeError(w, apiError{status: 403, code: "forbidden", reason: "origin_not_allowed", message: "requests with an Origin header are not allowed"})
		return
	}
	if !s.fault("no-auth") {
		got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		want := s.opts.Token
		gh, wh := sha256.Sum256([]byte(got)), sha256.Sum256([]byte(want))
		if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") || subtle.ConstantTimeCompare(gh[:], wh[:]) != 1 {
			writeError(w, apiError{status: 401, code: "unauthorized", message: "missing or wrong bearer token"})
			return
		}
	}
	path := r.URL.Path
	switch {
	case r.Method == "GET" && path == "/v1/provider" && s.fault("redirect-describe"):
		http.Redirect(w, r, s.blob.base+"/describe", http.StatusFound)
	case r.Method == "GET" && path == "/v1/provider":
		s.describe(w)
	case r.Method == "GET" && path == "/v1/models":
		s.models(w)
	case r.Method == "POST" && path == "/v1/artifacts":
		s.upload(w, r)
	case r.Method == "POST" && path == "/v1/jobs":
		s.submit(w, r)
	case r.Method == "POST" && path == "/v1/estimates":
		s.estimate(w, r)
	case r.Method == "GET" && strings.HasPrefix(path, "/v1/artifacts/") && strings.HasSuffix(path, "/content"):
		s.content(w, r, strings.TrimSuffix(strings.TrimPrefix(path, "/v1/artifacts/"), "/content"))
	case r.Method == "GET" && strings.HasPrefix(path, "/v1/artifacts/"):
		s.artifactMeta(w, strings.TrimPrefix(path, "/v1/artifacts/"))
	case r.Method == "POST" && strings.HasPrefix(path, "/v1/jobs/") && strings.HasSuffix(path, "/cancel"):
		s.cancel(w, strings.TrimSuffix(strings.TrimPrefix(path, "/v1/jobs/"), "/cancel"))
	case r.Method == "GET" && strings.HasPrefix(path, "/v1/jobs/"):
		s.getJob(w, strings.TrimPrefix(path, "/v1/jobs/"))
	default:
		writeError(w, apiError{status: 404, code: "not_found", message: "no such endpoint"})
	}
}

func (s *Server) describe(w http.ResponseWriter) {
	writeJSON(w, 200, s.description())
}

func (s *Server) description() map[string]any {
	mac := hmac.New(sha256.New, []byte("test-salt"))
	mac.Write([]byte("test-upstream-credential"))
	binding := hex.EncodeToString(mac.Sum(nil))
	if s.fault("short-binding") {
		binding = binding[:16]
	}
	return map[string]any{
		"protocol": map[string]any{"version": "1.0"},
		"provider": map[string]any{"id": "example.test", "name": "Test Provider", "version": "1.0.0"},
		"capabilities": map[string]any{
			"generation": []string{"image"}, "transcription": true, "cancel": true, "estimate": true,
			"webhook": false, "setup": false,
		},
		"account": map[string]any{"status": "ready", "label": "Test key", "binding": binding},
		"billing": map[string]any{"unit": "USD"},
	}
}

func (s *Server) price() float64 {
	if s.fault("expensive") {
		return 1
	}
	return 0
}

func (s *Server) catalog() map[string]any {
	pricing := map[string]any{"basis": "exact", "unit": "job", "amount": s.price(), "currency": "USD"}
	steps := map[string]any{"name": "steps", "kind": "integer", "default": 4, "min": 1, "max": 10, "step": 1, "widget": "slider"}
	if s.fault("bad-default") {
		steps["default"] = 20
	}
	if s.fault("bad-widget") {
		steps["widget"] = map[string]any{"type": "slider"}
	}
	ratio := map[string]any{"name": "ratio", "kind": "enum", "default": "1:1", "enum_values": []string{"1:1", "16:9"},
		"visible_when": map[string]any{"name": "prompt", "equals": nil}}
	if s.fault("bad-visible-when") {
		ratio["visible_when"] = map[string]any{"name": "prompt"}
	}
	rule := map[string]any{"when_name": "ratio", "when_values": []string{"16:9"}, "reject_name": "steps", "reject_values": []string{"10"},
		"message": "10 steps are not available in 16:9"}
	if s.fault("bad-parameter-rule") {
		rule["reject_values"] = []int{10}
	}
	image := map[string]any{
		"id": "test/image", "label": "Test Image", "available": true,
		"output": map[string]any{"modality": "image"},
		"parameters": []any{
			map[string]any{"name": "prompt", "kind": "text", "required": true, "max_length": 500},
			ratio,
			steps,
		},
		"parameter_rules": []any{rule},
		"routes": []any{
			map[string]any{
				"id": "text2image", "input": map[string]any{"slots": []any{}},
				"parameter_names": []string{"prompt", "ratio", "steps"},
				"output":          map[string]any{"media_types": []string{"image/png"}}, "pricing": pricing,
			},
			map[string]any{
				"id": "image2image",
				"input": map[string]any{"slots": []any{map[string]any{
					"id": "reference", "role": "reference", "modality": "image", "min_artifacts": 1, "max_artifacts": 2,
					"media_types": []string{"image/png", "image/jpeg"}, "max_bytes": 1 << 20,
				}}, "max_total_artifacts": 2},
				"parameter_names": []string{"prompt", "ratio"},
				"output":          map[string]any{"media_types": []string{"image/png"}}, "pricing": pricing,
			},
		},
	}
	if s.fault("invalid-catalog") {
		delete(image, "routes")
	}
	asr := map[string]any{
		"id": "test/asr", "label": "Test ASR", "available": true,
		"output": map[string]any{"modality": "text"},
		"parameters": []any{
			map[string]any{"name": "language", "kind": "string", "default": "auto"},
			map[string]any{"name": "timestamps", "kind": "enum", "default": "word", "enum_values": []string{"none", "segment", "word"}},
		},
		"routes": []any{map[string]any{
			"id": "audio2text",
			"input": map[string]any{"slots": []any{map[string]any{
				"id": "audio", "role": "audio", "modality": "audio", "min_artifacts": 1, "max_artifacts": 1,
				"media_types": []string{"audio/wav"}, "max_bytes": 4 << 20,
			}}, "max_total_artifacts": 1},
			"parameter_names": []string{"language", "timestamps"},
			"output":          map[string]any{"media_types": []string{"application/vnd.cuelor.transcript+json"}},
			"pricing":         pricing,
		}},
	}
	return map[string]any{"models": []any{image, asr}}
}

func (s *Server) models(w http.ResponseWriter) { writeJSON(w, 200, s.catalog()) }

var mimeAliases = map[string]string{"audio/x-wav": "audio/wav", "audio/wave": "audio/wav", "image/jpg": "image/jpeg"}

func (s *Server) upload(w http.ResponseWriter, r *http.Request) {
	limit := int64(4 << 20)
	if s.fault("no-413") {
		limit = 1 << 30
	}
	r.Body = http.MaxBytesReader(w, r.Body, limit+64*1024)
	file, header, err := r.FormFile("file")
	if err != nil {
		var mbe *http.MaxBytesError
		if errorsAs(err, &mbe) {
			writeError(w, apiError{status: 413, code: "payload_too_large", message: "the file is too large", params: map[string]any{"max_bytes": limit}})
			return
		}
		writeError(w, *invalid("missing_file", "expected a multipart field named file"))
		return
	}
	data, _ := io.ReadAll(file)
	if int64(len(data)) > limit {
		writeError(w, apiError{status: 413, code: "payload_too_large", message: "the file is too large", params: map[string]any{"max_bytes": limit}})
		return
	}
	mt, _, _ := mime.ParseMediaType(header.Header.Get("Content-Type"))
	if alias, ok := mimeAliases[mt]; ok {
		mt = alias
	}
	a := s.store(data, mt)
	out := artifactJSON(a)
	if s.fault("wrong-sha256") {
		out["sha256"] = strings.Repeat("0", 64)
	}
	writeJSON(w, 201, out)
}

func errorsAs(err error, target **http.MaxBytesError) bool {
	for err != nil {
		if e, ok := err.(*http.MaxBytesError); ok {
			*target = e
			return true
		}
		u, ok := err.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		err = u.Unwrap()
	}
	return false
}

func (s *Server) store(data []byte, mediaType string) *artifact {
	s.mu.Lock()
	defer s.mu.Unlock()
	sum := sha256.Sum256(data)
	digest := hex.EncodeToString(sum[:])
	idSum := sha256.Sum256([]byte(mediaType + "\n" + digest))
	id := "art_" + hex.EncodeToString(idSum[:])[:24]
	if a, ok := s.st.Artifacts[id]; ok {
		return a
	}
	a := &artifact{ID: id, MediaType: mediaType, SHA256: digest, Data: data, Created: time.Now().UTC()}
	s.st.Artifacts[id] = a
	s.save()
	return a
}

func artifactJSON(a *artifact) map[string]any {
	return map[string]any{
		"id": a.ID, "media_type": a.MediaType, "bytes": len(a.Data), "sha256": a.SHA256,
		"created_at": a.Created.Format(time.RFC3339Nano), "expires_at": a.Created.Add(7 * 24 * time.Hour).Format(time.RFC3339Nano),
	}
}

func (s *Server) artifactMeta(w http.ResponseWriter, id string) {
	s.mu.Lock()
	a := s.st.Artifacts[id]
	s.mu.Unlock()
	if a == nil {
		writeError(w, apiError{status: 404, code: "not_found", message: "no such artifact"})
		return
	}
	writeJSON(w, 200, artifactJSON(a))
}

func (s *Server) content(w http.ResponseWriter, r *http.Request, id string) {
	s.mu.Lock()
	a := s.st.Artifacts[id]
	s.mu.Unlock()
	if a == nil {
		writeError(w, apiError{status: 404, code: "not_found", message: "no such artifact"})
		return
	}
	if s.blob != nil && !s.fault("redirect-describe") {
		s.blob.redirect(w, r, id)
		return
	}
	writeContent(w, a)
}

func writeContent(w http.ResponseWriter, a *artifact) {
	w.Header().Set("Content-Type", a.MediaType)
	w.Header().Set("Content-Length", strconv.Itoa(len(a.Data)))
	w.WriteHeader(200)
	_, _ = w.Write(a.Data)
}

type jobRequest struct {
	Model string `json:"model"`
	Route string `json:"route"`
	Input struct {
		Artifacts []struct {
			ArtifactID string `json:"artifact_id"`
			Role       string `json:"role"`
			Position   int    `json:"position"`
		} `json:"artifacts"`
	} `json:"input"`
	Parameters map[string]any `json:"parameters"`
}

var keyPattern = regexp.MustCompile(`^[!-~]{1,128}$`)
var refPattern = regexp.MustCompile(`@(image|video|audio)([1-9][0-9]*)`)

// validate checks a request against the catalog.
func (s *Server) validate(req *jobRequest, r *http.Request) *apiError {
	leak := ""
	if s.fault("error-leaks-token") {
		leak = " (" + r.Header.Get("Authorization") + ")"
	}
	routes := map[string]map[string]bool{
		"test/image": {"text2image": true, "image2image": true},
		"test/asr":   {"audio2text": true},
	}
	rts, ok := routes[req.Model]
	if !ok {
		return invalid("unknown_model", "unknown model %q%s", req.Model, leak)
	}
	if !rts[req.Route] {
		return invalid("unknown_route", "model %s has no route %q", req.Model, req.Route)
	}
	params := req.Parameters
	if steps, ok := params["steps"]; ok {
		f, ok := steps.(float64)
		if !ok || f < 1 || f > 10 || f != float64(int(f)) {
			return invalid("invalid_parameter", "steps must be an integer from 1 to 10")
		}
	}
	if ratio, ok := params["ratio"]; ok && ratio != "1:1" && ratio != "16:9" {
		return invalid("invalid_parameter", "ratio must be 1:1 or 16:9")
	}
	if ts, ok := params["timestamps"]; ok && ts != "none" && ts != "segment" && ts != "word" {
		return invalid("invalid_parameter", "timestamps must be none, segment or word")
	}
	prompt, _ := params["prompt"].(string)
	if req.Model == "test/image" && prompt == "" {
		return invalid("missing_parameter", "prompt is required")
	}
	if len([]rune(prompt)) > 500 {
		return invalid("invalid_parameter", "prompt is longer than 500 characters")
	}
	maxIn := map[string]int{"text2image": 0, "image2image": 2, "audio2text": 1}[req.Route]
	minIn := map[string]int{"text2image": 0, "image2image": 1, "audio2text": 1}[req.Route]
	n := len(req.Input.Artifacts)
	if n > maxIn {
		return invalid("too_many_inputs", "route %s accepts at most %d inputs, got %d", req.Route, maxIn, n)
	}
	if n < minIn {
		return invalid("too_few_inputs", "route %s needs at least %d inputs", req.Route, minIn)
	}
	images := 0
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, in := range req.Input.Artifacts {
		if in.Position != i {
			return invalid("invalid_position", "positions must be 0..n-1 in order")
		}
		a := s.st.Artifacts[in.ArtifactID]
		if a == nil {
			e := invalid("artifact_not_found", "artifact %s does not exist", in.ArtifactID)
			e.params = map[string]any{"artifact_id": in.ArtifactID}
			return e
		}
		if strings.HasPrefix(a.MediaType, "image/") {
			images++
		}
	}
	if !s.fault("unchecked-references") {
		for _, m := range refPattern.FindAllStringSubmatch(prompt, -1) {
			n, _ := strconv.Atoi(m[2])
			if m[1] != "image" || n > images {
				return invalid("prompt_reference_out_of_range", "the prompt references %s but there are not enough inputs", m[0])
			}
		}
	}
	return nil
}

func canonicalHash(raw []byte) string {
	var v any
	_ = json.Unmarshal(raw, &v)
	out, _ := json.Marshal(v) // map keys are sorted
	sum := sha256.Sum256(out)
	return hex.EncodeToString(sum[:])
}

func (s *Server) submit(w http.ResponseWriter, r *http.Request) {
	raw, _ := io.ReadAll(r.Body)
	if s.fault("submit-503") {
		writeError(w, apiError{status: 503, code: "upstream_unavailable", message: "the upstream is unavailable"})
		return
	}
	var req jobRequest
	if err := json.Unmarshal(raw, &req); err != nil || req.Model == "" || req.Route == "" {
		writeError(w, *invalid("invalid_body", "the body must be a job request"))
		return
	}
	key := r.Header.Get("Idempotency-Key")
	if key == "" && !s.fault("no-key-ok") {
		writeError(w, *invalid("missing_idempotency_key", "Idempotency-Key is required"))
		return
	}
	if key != "" && !keyPattern.MatchString(key) {
		writeError(w, *invalid("invalid_idempotency_key", "Idempotency-Key must be 1 to 128 visible ASCII characters"))
		return
	}
	if e := s.validate(&req, r); e != nil {
		writeError(w, *e)
		return
	}
	hash := canonicalHash(raw)
	s.mu.Lock()
	if rec, ok := s.st.Keys[key]; ok && key != "" && !s.fault("new-job-same-key") {
		if rec.BodyHash != hash && !s.fault("no-conflict") {
			s.mu.Unlock()
			writeError(w, apiError{status: 409, code: "idempotency_conflict", message: "this key was used with a different body"})
			return
		}
		j := s.st.Jobs[rec.JobID]
		out := s.jobJSONLocked(j)
		s.mu.Unlock()
		writeJSON(w, 200, out)
		return
	}
	s.st.Seq++
	j := &jobRec{ID: fmt.Sprintf("job_%06d_%d", s.st.Seq, time.Now().UnixNano()%100000), Model: req.Model, Route: req.Route, Created: time.Now().UTC()}
	for _, in := range req.Input.Artifacts {
		j.Inputs = append(j.Inputs, in.ArtifactID)
	}
	j.Language, _ = req.Parameters["language"].(string)
	s.st.Jobs[j.ID] = j
	s.st.Keys[key] = keyRec{BodyHash: hash, JobID: j.ID}
	s.save()
	out := s.jobJSONLocked(j)
	s.mu.Unlock()
	writeJSON(w, 201, out)
}

func (s *Server) estimate(w http.ResponseWriter, r *http.Request) {
	raw, _ := io.ReadAll(r.Body)
	var req jobRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		writeError(w, *invalid("invalid_body", "the body must be a job request"))
		return
	}
	if e := s.validate(&req, r); e != nil {
		writeError(w, *e)
		return
	}
	if s.fault("estimate-503") {
		writeError(w, apiError{status: 503, code: "upstream_unavailable", message: "the upstream is unavailable"})
		return
	}
	if s.fault("estimate-schema") {
		writeJSON(w, 200, map[string]any{"amount": 0})
		return
	}
	writeJSON(w, 200, map[string]any{"estimate": map[string]any{"amount": s.price(), "unit": "USD", "basis": "exact"}})
}

func (s *Server) status(j *jobRec, now time.Time) (string, time.Time) {
	running := j.Created.Add(s.opts.QueuedFor)
	done := running.Add(s.opts.RunFor)
	if j.CancelledAt != nil && j.CancelledAt.Before(done) {
		return "cancelled", *j.CancelledAt
	}
	switch {
	case s.fault("instant-jobs"):
		return "succeeded", j.Created
	case s.fault("stuck-jobs"):
		return "running", j.Created
	case now.Before(running):
		return "queued", j.Created
	case now.Before(done):
		return "running", running
	default:
		return "succeeded", done
	}
}

func (s *Server) jobJSONLocked(j *jobRec) map[string]any {
	status, updated := s.status(j, time.Now())
	if s.fault("bad-transition") && status == "succeeded" {
		j.Polls++
		if j.Polls == 3 {
			status = "running"
		}
	}
	out := map[string]any{
		"id": j.ID, "status": status, "model": j.Model, "route": j.Route,
		"created_at": j.Created.Format(time.RFC3339Nano), "updated_at": updated.Format(time.RFC3339Nano),
		"approval": nil, "error": nil, "usage": nil,
	}
	switch status {
	case "succeeded":
		a := s.outputLocked(j)
		o := map[string]any{"artifact_id": a.ID, "role": "output", "media_type": a.MediaType, "bytes": len(a.Data), "sha256": a.SHA256}
		if j.Route == "audio2text" {
			o["role"] = "transcript"
		}
		if s.fault("wrong-output-sha") {
			o["sha256"] = strings.Repeat("1", 64)
		}
		outputs := []any{o}
		if s.fault("two-outputs") {
			outputs = append(outputs, o)
		}
		out["outputs"] = outputs
	case "cancelled":
		out["error"] = map[string]any{"code": "cancelled", "message": "cancelled"}
	}
	if terminal := status == "succeeded" || status == "cancelled"; terminal && !s.fault("no-usage") {
		out["usage"] = map[string]any{"amount": s.price(), "unit": "USD", "basis": "estimate"}
	}
	return out
}

// outputLocked creates the job's output on first use.
func (s *Server) outputLocked(j *jobRec) *artifact {
	if a := s.st.Artifacts[j.OutputID]; a != nil {
		return a
	}
	var data []byte
	mediaType := "image/png"
	if j.Route == "audio2text" {
		var audio []byte
		if len(j.Inputs) > 0 {
			if a := s.st.Artifacts[j.Inputs[0]]; a != nil {
				audio = a.Data
			}
		}
		data, mediaType = s.transcribe(audio, j.Language), "application/vnd.cuelor.transcript+json"
	} else {
		data = solidPNG(j.ID)
	}
	sum := sha256.Sum256(data)
	a := &artifact{ID: "art_out_" + j.ID, MediaType: mediaType, SHA256: hex.EncodeToString(sum[:]), Data: data, Created: time.Now().UTC()}
	s.st.Artifacts[a.ID] = a
	j.OutputID = a.ID
	s.save()
	return a
}

func solidPNG(seed string) []byte {
	sum := sha256.Sum256([]byte(seed))
	img := image.NewRGBA(image.Rect(0, 0, 8, 8))
	for y := 0; y < 8; y++ {
		for x := 0; x < 8; x++ {
			img.Set(x, y, color.RGBA{sum[0], sum[1], sum[2], 255})
		}
	}
	var buf bytes.Buffer
	_ = png.Encode(&buf, img)
	return buf.Bytes()
}

// transcribe "recognises" a WAV by the JSON in its LIST/INFO/ICMT chunk.
func (s *Server) transcribe(wav []byte, language string) []byte {
	info, durationMS := wavInfo(wav)
	var known struct {
		Language string `json:"language"`
		Text     string `json:"text"`
	}
	_ = json.Unmarshal([]byte(info), &known)
	if known.Text == "" {
		known.Text, known.Language = "unknown audio", "en"
	}
	if language != "" && language != "auto" {
		known.Language = language
	}
	if s.fault("wrong-language") {
		known.Language = "fr"
	}
	if s.fault("garbled-transcript") {
		known.Text = "zzzz qqqq xxxx"
	}
	var words []string
	unit := "word"
	if known.Language == "zh" {
		unit = "character"
		for _, r := range known.Text {
			if !unicode.IsPunct(r) && !unicode.IsSpace(r) {
				words = append(words, string(r))
			}
		}
	} else {
		for _, w := range strings.Fields(known.Text) {
			words = append(words, strings.TrimFunc(w, unicode.IsPunct))
		}
	}
	units := []any{}
	step := durationMS / int64(max(len(words), 1))
	for i, w := range words {
		start, end := int64(i)*step, int64(i+1)*step
		if s.fault("overlapping-units") && i > 0 {
			start -= step / 2
		}
		units = append(units, map[string]any{"text": w, "start_ms": start, "end_ms": end})
	}
	out, _ := json.Marshal(map[string]any{
		"schema_version": 1, "language": known.Language, "unit": unit, "text": known.Text,
		"segments": []any{map[string]any{"text": known.Text, "start_ms": 0, "end_ms": durationMS, "timed_text_units": units}},
		"provider": map[string]any{"name": "test-asr"},
	})
	return out
}

// wavInfo returns the ICMT comment and the duration of a PCM WAV.
func wavInfo(b []byte) (string, int64) {
	if len(b) < 12 || string(b[0:4]) != "RIFF" || string(b[8:12]) != "WAVE" {
		return "", 1000
	}
	var byteRate uint32
	var dataLen uint32
	comment := ""
	for off := 12; off+8 <= len(b); {
		id := string(b[off : off+4])
		size := int(binary.LittleEndian.Uint32(b[off+4 : off+8]))
		body := b[off+8 : min(off+8+size, len(b))]
		switch id {
		case "fmt ":
			if len(body) >= 12 {
				byteRate = binary.LittleEndian.Uint32(body[8:12])
			}
		case "data":
			dataLen = uint32(len(body))
		case "LIST":
			if len(body) >= 4 && string(body[0:4]) == "INFO" {
				for p := 4; p+8 <= len(body); {
					sid := string(body[p : p+4])
					ssz := int(binary.LittleEndian.Uint32(body[p+4 : p+8]))
					if sid == "ICMT" && p+8+ssz <= len(body) {
						comment = strings.TrimRight(string(body[p+8:p+8+ssz]), "\x00")
					}
					p += 8 + ssz + ssz%2
				}
			}
		}
		off += 8 + size + size%2
	}
	if byteRate == 0 {
		return comment, 1000
	}
	return comment, int64(dataLen) * 1000 / int64(byteRate)
}

func (s *Server) getJob(w http.ResponseWriter, id string) {
	s.mu.Lock()
	j := s.st.Jobs[id]
	if j == nil {
		s.mu.Unlock()
		if s.fault("unknown-job-500") {
			writeError(w, apiError{status: 500, code: "internal_error", message: "lookup failed"})
			return
		}
		writeError(w, apiError{status: 404, code: "not_found", message: "no such job"})
		return
	}
	out := s.jobJSONLocked(j)
	s.mu.Unlock()
	writeJSON(w, 200, out)
}

func (s *Server) cancel(w http.ResponseWriter, id string) {
	if s.fault("cancel-500") {
		writeError(w, apiError{status: 500, code: "internal_error", message: "cancel failed"})
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	j := s.st.Jobs[id]
	if j == nil {
		writeError(w, apiError{status: 404, code: "not_found", message: "no such job"})
		return
	}
	if status, _ := s.status(j, time.Now()); status == "queued" || status == "running" {
		now := time.Now().UTC()
		j.CancelledAt = &now
		s.save()
	}
	writeJSON(w, 200, s.jobJSONLocked(j))
}

// Main runs the server as a plugin: it reads the token from stdin, listens on 127.0.0.1:0, prints
// the handshake line and exits when stdin closes. args are fault names.
func Main(args []string) int {
	faults := map[string]bool{}
	for _, a := range args {
		faults[a] = true
	}
	in := bufio.NewReader(os.Stdin)
	line, err := in.ReadString('\n')
	if err != nil {
		fmt.Fprintln(os.Stderr, "no token on stdin")
		return 1
	}
	host := "127.0.0.1:0"
	if faults["listen-all"] {
		host = ":0"
	}
	ln, err := net.Listen("tcp", host)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	port := ln.Addr().(*net.TCPAddr).Port
	srv := New(Options{Token: strings.TrimSpace(line), Faults: faults, DataDir: os.Getenv("CUELOR_PROVIDER_DATA_DIR"), Port: func() int { return port }})
	go func() { _ = http.Serve(ln, srv) }()
	fmt.Printf("cuelor-provider-listening port=%d\n", port)
	_, _ = io.Copy(io.Discard, in)
	if faults["ignore-stdin"] {
		select {}
	}
	return 0
}
