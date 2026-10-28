package conformance

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime/debug"
	"sort"
	"strings"
	"time"
)

// Version is the version of this suite. It follows the specification's minor version.
const Version = "1.0.0"

// ProtocolVersion is the protocol version the suite sends in the Cuelor-Protocol header.
const ProtocolVersion = "1.0"

// Status is the outcome of one check, or of a whole run (passed or failed only).
type Status string

const (
	StatusPassed  Status = "passed"
	StatusFailed  Status = "failed"
	StatusSkipped Status = "skipped"
	StatusWarning Status = "warning"
)

// Tier groups checks by what they cost.
type Tier string

const (
	// TierA checks the protocol without calling a paid upstream.
	TierA Tier = "A"
	// TierB runs real jobs. It needs Options.Live.
	TierB Tier = "B"
	// TierC runs real transcriptions. It needs Options.Live.
	TierC Tier = "C"
)

// CheckInfo describes one check.
type CheckInfo struct {
	ID   string
	Name string
	Tier Tier
	// Condition says when the check applies, for example "command form" or "capabilities.cancel".
	// Empty means it always applies.
	Condition string
}

// Options configures a run. Set exactly one target: a command (Command, or Manifest with a runtime)
// or a URL.
type Options struct {
	// Command is the plugin command and its arguments, for example {"node", "dist/provider.mjs"}.
	// The first element is resolved with the caller's PATH before the plugin's own environment is
	// built. When Command is empty and Manifest declares a runtime, the suite runs that runtime.
	Command []string
	// Dir is the plugin's working directory (its install directory). Default: the manifest's
	// directory, else the current directory.
	Dir string
	// Manifest is the path of cuelor-provider.json. Default for the command form:
	// <Dir>/cuelor-provider.json when it exists. A1 compares provider.id and provider.version with it,
	// and tiers B and C take their models from its test field.
	Manifest string
	// NodePath is the node executable for a manifest with runtime kind "node". Default: node on PATH.
	NodePath string
	// Env adds variables to the plugin's environment. The host contract builds the environment from
	// scratch; use this only for development.
	Env []string
	// DataDir is CUELOR_PROVIDER_DATA_DIR for the plugin. Default: a new temporary directory that is
	// removed after the run.
	DataDir string

	// URL is the base URL of a running service (without /v1).
	URL string
	// Token is the bearer token for URL.
	Token string

	// Live enables tiers B and C, which create real jobs and may cost money.
	Live bool
	// MaxCost caps the estimated total cost of tiers B and C, in the service's billing unit. It is
	// required when Live is set. When the estimate is above it, or cannot be made, B and C do not run
	// and fail.
	MaxCost *float64
	// Only limits the run to these check ids, for example {"A3", "B2"}.
	Only []string

	// RequestTimeout is the timeout of one request, except uploads and downloads. Default 30 s.
	RequestTimeout time.Duration
	// JobTimeout bounds how long the suite polls one job. Default 10 min.
	JobTimeout time.Duration
	// StartTimeout bounds the handshake of the command form. Default 15 s.
	StartTimeout time.Duration
	// FFprobe is the ffprobe executable for B5's decoding check. Empty: ffprobe on PATH when present.
	// "off": skip the decoding check.
	FFprobe string

	// Log receives progress lines. Nil discards them.
	Log io.Writer
	// PluginOutput receives the plugin's stdout (after the handshake line) and stderr. Nil keeps the
	// last part in memory, for the details of a failed start.
	PluginOutput io.Writer
}

// Result is the outcome of one check.
type Result struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Status     Status `json:"status"`
	DurationMS int64  `json:"duration_ms"`
	Detail     string `json:"detail"`
	// NotRun marks a failed check that did not run: the live run was over --max-cost or its cost
	// could not be estimated, or the run was cancelled. No job was submitted for it. Detail starts
	// with "not run: ". Always false for other statuses.
	NotRun bool `json:"not_run,omitempty"`
}

// Report is the outcome of a run.
type Report struct {
	// Status is passed when no check failed.
	Status  Status   `json:"status"`
	Summary string   `json:"summary"`
	Checks  []Result `json:"checks"`
}

// OK reports whether every check that ran passed (warnings and skipped checks included).
func (r *Report) OK() bool { return r.Status == StatusPassed }

// JSON returns the report as indented JSON.
func (r *Report) JSON() []byte {
	out, _ := json.MarshalIndent(r, "", "  ")
	return append(out, '\n')
}

// Checks lists every check in id order.
func Checks() []CheckInfo {
	out := make([]CheckInfo, 0, len(checkDefs))
	for _, d := range checkDefs {
		out = append(out, d.CheckInfo)
	}
	return out
}

// ErrInvalidOptions wraps every error about Options. The target was not tested.
var ErrInvalidOptions = errors.New("invalid options")

func optionsError(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalidOptions, fmt.Sprintf(format, args...))
}

// Run tests the target described by opts and returns the report. It returns an error only when the
// options are invalid or the run could not be prepared; a service that fails to start or misbehaves
// is reported as failed checks.
func Run(ctx context.Context, opts Options) (*Report, error) {
	if err := opts.normalize(); err != nil {
		return nil, err
	}
	selected, err := selectChecks(opts.Only)
	if err != nil {
		return nil, err
	}
	r, err := newRunner(ctx, opts)
	if err != nil {
		return nil, err
	}
	defer r.close()
	r.selected = selected

	results := map[string]*Result{}
	startErr := r.start()
	for _, def := range runOrder(selected) {
		res := &Result{ID: def.ID, Name: def.Name}
		started := time.Now()
		if startErr != nil {
			res.Status = StatusFailed
			res.Detail = "the service could not be tested: " + startErr.Error()
		} else if ctx.Err() != nil {
			res.Status, res.NotRun = StatusFailed, true
			res.Detail = "not run: the run was cancelled"
		} else {
			r.logf("%s %s", def.ID, def.Name)
			res.Status, res.Detail, res.NotRun = r.runCheck(def)
		}
		res.DurationMS = time.Since(started).Milliseconds()
		results[def.ID] = res
	}

	report := &Report{Status: StatusPassed}
	counts := map[Status]int{}
	for _, def := range checkDefs {
		if res, ok := results[def.ID]; ok {
			report.Checks = append(report.Checks, *res)
			counts[res.Status]++
			if res.Status == StatusFailed {
				report.Status = StatusFailed
			}
		}
	}
	report.Summary = summarize(counts, len(report.Checks))
	return report, nil
}

func summarize(counts map[Status]int, total int) string {
	s := fmt.Sprintf("%d / %d checks passed", counts[StatusPassed]+counts[StatusWarning], total)
	extra := []string{}
	if n := counts[StatusFailed]; n > 0 {
		extra = append(extra, fmt.Sprintf("%d failed", n))
	}
	if n := counts[StatusWarning]; n > 0 {
		extra = append(extra, fmt.Sprintf("%d with warnings", n))
	}
	if n := counts[StatusSkipped]; n > 0 {
		extra = append(extra, fmt.Sprintf("%d skipped", n))
	}
	if len(extra) > 0 {
		s += " (" + strings.Join(extra, ", ") + ")"
	}
	return s
}

func (o *Options) normalize() error {
	if o.RequestTimeout <= 0 {
		o.RequestTimeout = 30 * time.Second
	}
	if o.JobTimeout <= 0 {
		o.JobTimeout = 10 * time.Minute
	}
	if o.StartTimeout <= 0 {
		o.StartTimeout = 15 * time.Second
	}
	if o.Log == nil {
		o.Log = io.Discard
	}
	if o.Live && o.MaxCost == nil {
		return optionsError("Live needs MaxCost (--max-cost)")
	}
	if o.MaxCost != nil && *o.MaxCost < 0 {
		return optionsError("MaxCost must not be negative")
	}
	if o.URL != "" {
		if len(o.Command) > 0 {
			return optionsError("set either a command or a URL, not both")
		}
		if o.Token == "" {
			return optionsError("a URL target needs a token")
		}
		o.URL = strings.TrimRight(o.URL, "/")
		o.URL = strings.TrimSuffix(o.URL, "/v1")
		if !strings.HasPrefix(o.URL, "http://") && !strings.HasPrefix(o.URL, "https://") {
			return optionsError("the URL must start with http:// or https://")
		}
		return nil
	}
	if o.Manifest == "" {
		dir := o.Dir
		if dir == "" {
			dir = "."
		}
		if _, err := os.Stat(filepath.Join(dir, "cuelor-provider.json")); err == nil {
			o.Manifest = filepath.Join(dir, "cuelor-provider.json")
		}
	}
	if o.Dir == "" && o.Manifest != "" {
		o.Dir = filepath.Dir(o.Manifest)
	}
	if len(o.Command) == 0 && o.Manifest == "" {
		return optionsError("set a command, a manifest with a runtime, or a URL")
	}
	return nil
}

func selectChecks(only []string) (map[string]bool, error) {
	selected := map[string]bool{}
	known := map[string]bool{}
	for _, d := range checkDefs {
		known[d.ID] = true
	}
	if len(only) == 0 {
		for id := range known {
			selected[id] = true
		}
		return selected, nil
	}
	for _, id := range only {
		id = strings.ToUpper(strings.TrimSpace(id))
		if id == "" {
			continue
		}
		if !known[id] {
			ids := make([]string, 0, len(known))
			for k := range known {
				ids = append(ids, k)
			}
			sort.Strings(ids)
			return nil, optionsError("unknown check %q (known: %s)", id, strings.Join(ids, ", "))
		}
		selected[id] = true
	}
	return selected, nil
}

// runCheck runs one check and turns panics into failures.
func (r *runner) runCheck(def checkDef) (status Status, detail string, notRun bool) {
	c := &checkCtx{}
	defer func() {
		if p := recover(); p != nil {
			if _, ok := p.(checkAbort); !ok {
				c.fail("internal error in the suite: %v\n%s", p, debug.Stack())
			}
		}
		if r.ctx.Err() != nil && !c.notRun {
			c.fail("the run was cancelled before the check finished")
		}
		status, detail = c.outcome()
		notRun = c.notRun && status == StatusFailed
	}()
	if reason := r.notApplicable(def); reason != "" {
		c.skip("%s", reason)
		return
	}
	def.run(r, c)
	return
}
