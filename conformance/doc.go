// Package conformance tests a service against the Cuelor Provider API v1.
//
// It implements the conformance tiers of the specification:
//
//   - Tier A (A1–A9): the protocol. It never calls a paid upstream and can run at any time.
//   - Tier B (B1–B11): real jobs. It runs only with [Options.Live] and when the estimated cost of the
//     whole run is within [Options.MaxCost]. Otherwise no job is submitted and every B and C check
//     fails with [Result.NotRun] set.
//   - Tier C (C1–C2): transcription with the suite's own speech samples, under the same conditions.
//
// [Checks] lists every check with its id and name. A check whose capability the service does not
// declare (cancel, estimate, transcription, generation) is reported as skipped; a declared capability
// must pass its checks.
//
// # Targets
//
// The suite tests one of two forms:
//
//   - A command ([Options.Command], or the runtime in [Options.Manifest]). The suite starts the plugin
//     itself, the way the Cuelor app does: in a new process group, with an environment built from
//     scratch, a random token on stdin, and the `cuelor-provider-listening port=N` line on stdout. Only
//     this form runs A3, B6 and B7, which close stdin or kill the process group and restart the plugin
//     with the same data directory. It needs a Unix-like system.
//   - A URL ([Options.URL] and [Options.Token]): a self-hosted or remote service, or a plugin the Cuelor
//     app has already started.
//
// # Use as a library
//
//	report, err := conformance.Run(ctx, conformance.Options{
//		Command: []string{"node", "dist/provider.mjs"},
//		Dir:     "./my-plugin",
//	})
//	if err != nil {
//		return err // invalid options; the target was not tested
//	}
//	if !report.OK() {
//		// report.Checks has the failures, with details
//	}
//
// The JSON form of [Report] is `{status, summary, checks:[{id, name, status, duration_ms, detail}]}`,
// the shape of the repository's CK_TEST_REPORT with `id` and `detail` added. Check statuses are passed,
// failed, skipped and warning. A warning (a SHOULD the service missed, for example a describe call
// slower than 10 seconds) does not fail the run.
//
// The suite embeds a copy of the JSON Schemas in spec/schemas of this repository and the speech and
// video samples in samples/.
package conformance
