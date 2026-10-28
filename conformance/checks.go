package conformance

import (
	"fmt"
	"sort"
	"strings"
)

type checkDef struct {
	CheckInfo
	// order is the run order. Checks that restart the plugin (A3) or need jobs run late.
	order int
	run   func(*runner, *checkCtx)
}

// checkDefs is the catalogue of checks, in id order. The ids and pass conditions are those of the
// specification's conformance section; see conformance/README.md.
var checkDefs = []checkDef{
	{CheckInfo{"A1", "Provider description", TierA, ""}, 10, checkA1},
	{CheckInfo{"A2", "Authentication", TierA, ""}, 20, checkA2},
	{CheckInfo{"A3", "Local security", TierA, "command form"}, 80, checkA3},
	{CheckInfo{"A4", "Catalog format", TierA, ""}, 30, checkA4},
	{CheckInfo{"A5", "Catalog semantics", TierA, ""}, 40, checkA5},
	{CheckInfo{"A6", "Error format", TierA, ""}, 50, checkA6},
	{CheckInfo{"A7", "Artifact upload", TierA, ""}, 60, checkA7},
	{CheckInfo{"A8", "Unknown resources", TierA, ""}, 70, checkA8},
	{CheckInfo{"A9", "Response time", TierA, ""}, 90, checkA9},
	{CheckInfo{"B1", "Submit", TierB, "--live"}, 100, checkB1},
	{CheckInfo{"B2", "Same key, same body", TierB, "--live"}, 110, checkB2},
	{CheckInfo{"B3", "Same key, different body", TierB, "--live"}, 120, checkB3},
	{CheckInfo{"B4", "State machine", TierB, "--live"}, 130, checkB4},
	{CheckInfo{"B5", "Outputs", TierB, "--live"}, 140, checkB5},
	{CheckInfo{"B6", "Interrupted submission", TierB, "--live, command form"}, 190, checkB6},
	{CheckInfo{"B7", "Restart while running", TierB, "--live, command form"}, 200, checkB7},
	{CheckInfo{"B8", "Lost response", TierB, "--live"}, 180, checkB8},
	{CheckInfo{"B9", "Cancel", TierB, "--live, capabilities.cancel"}, 170, checkB9},
	{CheckInfo{"B10", "Usage", TierB, "--live"}, 150, checkB10},
	{CheckInfo{"B11", "Estimate", TierB, "--live, capabilities.estimate"}, 160, checkB11},
	{CheckInfo{"C1", "Transcription", TierC, "--live, capabilities.transcription"}, 210, checkC1},
	{CheckInfo{"C2", "Language detection", TierC, "--live, capabilities.transcription"}, 220, checkC2},
}

func runOrder(selected map[string]bool) []checkDef {
	out := []checkDef{}
	for _, d := range checkDefs {
		if selected[d.ID] {
			out = append(out, d)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].order < out[j].order })
	return out
}

// notApplicable returns why a check does not apply to this target, or "".
func (r *runner) notApplicable(def checkDef) string {
	if def.ID == "A3" && !r.t.command() {
		return "applies to the command form only"
	}
	if def.Tier == TierA {
		return ""
	}
	if !r.opts.Live {
		return "needs --live (tiers B and C create real jobs)"
	}
	if (def.ID == "B6" || def.ID == "B7") && !r.t.command() {
		return "applies to the command form only"
	}
	if r.desc == nil {
		return "" // the check fails: it cannot read the capabilities
	}
	caps := r.desc.Capabilities
	switch {
	case def.ID == "B9" && !caps.Cancel:
		return "capabilities.cancel is not declared"
	case def.ID == "B11" && !caps.Estimate:
		return "capabilities.estimate is not declared"
	case def.Tier == TierC && !caps.Transcription:
		return "capabilities.transcription is not declared"
	case def.Tier == TierB && len(caps.Generation) == 0 && !caps.Transcription:
		return "the service declares neither generation nor transcription"
	}
	return ""
}

// checkAbort ends a check early; the recorded failure explains why.
type checkAbort struct{}

// checkCtx collects the outcome of one check.
type checkCtx struct {
	failures []string
	warnings []string
	notes    []string
	skipped  string
	// notRun is set when the check did not run (see Result.NotRun).
	notRun bool
}

func (c *checkCtx) fail(format string, args ...any) {
	c.failures = append(c.failures, fmt.Sprintf(format, args...))
}

// fatal records a failure and ends the check.
func (c *checkCtx) fatal(format string, args ...any) {
	c.fail(format, args...)
	panic(checkAbort{})
}

// notRunf records that the check did not run, and why, and ends it. The detail starts with "not run: ";
// a second call (the same reason reached twice) adds nothing.
func (c *checkCtx) notRunf(format string, args ...any) {
	if !c.notRun {
		c.notRun = true
		c.failures = append(c.failures, "not run: "+fmt.Sprintf(format, args...))
	}
	panic(checkAbort{})
}

func (c *checkCtx) warn(format string, args ...any) {
	c.warnings = append(c.warnings, fmt.Sprintf(format, args...))
}

func (c *checkCtx) note(format string, args ...any) {
	c.notes = append(c.notes, fmt.Sprintf(format, args...))
}

func (c *checkCtx) skip(format string, args ...any) {
	c.skipped = fmt.Sprintf(format, args...)
}

func (c *checkCtx) failed() bool { return len(c.failures) > 0 }

func (c *checkCtx) outcome() (Status, string) {
	lines := []string{}
	lines = append(lines, c.failures...)
	for _, w := range c.warnings {
		lines = append(lines, "warning: "+w)
	}
	for _, n := range c.notes {
		lines = append(lines, "note: "+n)
	}
	switch {
	case len(c.failures) > 0:
		return StatusFailed, strings.Join(lines, "\n")
	case c.skipped != "":
		return StatusSkipped, c.skipped
	case len(c.warnings) > 0:
		return StatusWarning, strings.Join(lines, "\n")
	default:
		return StatusPassed, strings.Join(lines, "\n")
	}
}
