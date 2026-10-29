// Command cuelor-provider-test runs the Cuelor Provider API v1 conformance suite against a plugin
// command or a service URL.
//
//	cuelor-provider-test --command "node dist/provider.mjs" [--live --max-cost 0.50] [--only A3,B2] [--output json]
//	cuelor-provider-test --manifest dist/cuelor-provider.json
//	cuelor-provider-test --url https://provider.example.com --token-file token.txt
//	cuelor-provider-test --url https://provider.example.com --live --max-cost 1 --model image=vendor/model --model video=vendor/clip:text2video
//
// Exit status: 0 when every check that ran passed, 1 when a check failed, 2 for invalid usage.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/cuelor/providers/conformance"
)

type envList []string

func (e *envList) String() string { return strings.Join(*e, ",") }

// Set takes KEY=VALUE, or a bare NAME whose value is copied from the suite's own environment, so that
// a key never has to appear on a command line.
func (e *envList) Set(v string) error {
	if !strings.Contains(v, "=") {
		value, ok := os.LookupEnv(v)
		if !ok {
			return fmt.Errorf("%s is not set in the environment", v)
		}
		v += "=" + value
	}
	*e = append(*e, v)
	return nil
}

// modelList collects --model <capability>=<model>[:<route>]. Splitting the model from the route needs
// the catalog, so the value after "=" is passed on whole.
type modelList map[string]string

func (m modelList) String() string {
	out := []string{}
	for k, v := range m {
		out = append(out, k+"="+v)
	}
	return strings.Join(out, ",")
}

func (m modelList) Set(v string) error {
	capability, choice, ok := strings.Cut(v, "=")
	switch {
	case !ok:
		return fmt.Errorf("%q has no \"=\"; use <capability>=<model>[:<route>]", v)
	case capability == "":
		return fmt.Errorf("%q has no capability before \"=\"", v)
	case choice == "":
		return fmt.Errorf("%q has no model after \"=\"", v)
	}
	if _, dup := m[capability]; dup {
		return fmt.Errorf("the capability %s is given more than once", capability)
	}
	m[capability] = choice
	return nil
}

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("cuelor-provider-test", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var (
		command   = fs.String("command", "", "start the plugin with this command line (no shell; quotes are honoured)")
		dir       = fs.String("dir", "", "the plugin's working directory (default: the manifest's directory, else the current one)")
		manifest  = fs.String("manifest", "", "cuelor-provider.json (default: <dir>/cuelor-provider.json); without --command its runtime is started")
		node      = fs.String("node", "", "node executable for a manifest with runtime node (default: node on PATH)")
		dataDir   = fs.String("data-dir", "", "CUELOR_PROVIDER_DATA_DIR for the plugin (default: a temporary directory)")
		target    = fs.String("url", "", "test a running service at this base URL instead of starting a command")
		tokenFile = fs.String("token-file", "", "file with the bearer token for --url (or set CUELOR_PROVIDER_TEST_TOKEN)")
		live      = fs.Bool("live", false, "also run tiers B and C, which create real jobs and may cost money")
		maxCost   = fs.String("max-cost", "", "with --live: the most the run may cost, in the service's billing unit")
		only      = fs.String("only", "", "comma-separated check ids, for example A3,B2")
		output    = fs.String("output", "text", "text or json")
		timeout   = fs.Duration("timeout", 30*time.Second, "timeout of one request")
		jobTO     = fs.Duration("job-timeout", 10*time.Minute, "how long to wait for one job to end")
		ffprobe   = fs.String("ffprobe", "", `ffprobe for decoding outputs (default: on PATH; "off" to skip)`)
		verbose   = fs.Bool("verbose", false, "print progress and the plugin's output to stderr")
		list      = fs.Bool("list", false, "list the checks and exit")
		version   = fs.Bool("version", false, "print the version and exit")
		env       envList
		models    = modelList{}
	)
	fs.Var(&env, "env", "KEY=VALUE, or NAME to copy NAME from this environment, added to the plugin's environment (repeatable; for development and test keys)")
	fs.Var(models, "model", "the model tiers B and C (and A6) test a capability with, as <capability>=<model>[:<route>], for example\n"+
		"image=vendor/model or video=vendor/model:text2video (repeatable, once per capability; <capability> is a\n"+
		"declared generation capability or transcription). The whole value is looked up as a model id first, since ids\n"+
		"may contain \":\"; only when no model has that id is it split at the last \":\" into model and route. Without a\n"+
		"route the model's first route for the capability whose inputs the suite can provide is used. Comes before\n"+
		"the manifest's test entry, whose parameters are then not sent")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() > 0 {
		fmt.Fprintf(stderr, "unexpected arguments: %s\n", strings.Join(fs.Args(), " "))
		return 2
	}
	if *version {
		fmt.Fprintf(stdout, "cuelor-provider-test %s (protocol %s)\n", conformance.Version, conformance.ProtocolVersion)
		return 0
	}
	if *list {
		for _, c := range conformance.Checks() {
			cond := ""
			if c.Condition != "" {
				cond = " [" + c.Condition + "]"
			}
			fmt.Fprintf(stdout, "%-4s %s%s\n", c.ID, c.Name, cond)
		}
		return 0
	}
	if *output != "text" && *output != "json" {
		fmt.Fprintln(stderr, "--output must be text or json")
		return 2
	}

	opts := conformance.Options{
		Dir: *dir, Manifest: *manifest, NodePath: *node, DataDir: *dataDir, Env: env,
		URL: *target, Live: *live, RequestTimeout: *timeout, JobTimeout: *jobTO, FFprobe: *ffprobe,
	}
	if len(models) > 0 {
		opts.Models = models
	}
	if *command != "" {
		argv, err := conformance.SplitCommand(*command)
		if err != nil {
			fmt.Fprintf(stderr, "--command: %v\n", err)
			return 2
		}
		opts.Command = argv
	}
	if *maxCost != "" {
		v, err := strconv.ParseFloat(*maxCost, 64)
		if err != nil {
			fmt.Fprintf(stderr, "--max-cost: %v\n", err)
			return 2
		}
		opts.MaxCost = &v
	}
	if *only != "" {
		opts.Only = strings.Split(*only, ",")
	}
	if opts.URL != "" {
		tok := os.Getenv("CUELOR_PROVIDER_TEST_TOKEN")
		if *tokenFile != "" {
			raw, err := os.ReadFile(*tokenFile)
			if err != nil {
				fmt.Fprintf(stderr, "--token-file: %v\n", err)
				return 2
			}
			tok = strings.TrimSpace(string(raw))
		}
		opts.Token = tok
	}
	if *verbose {
		opts.Log = stderr
		opts.PluginOutput = prefixWriter{stderr, "plugin: "}
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	report, err := conformance.Run(ctx, opts)
	if err != nil {
		fmt.Fprintln(stderr, err)
		if errors.Is(err, conformance.ErrInvalidOptions) {
			fs.Usage()
		}
		return 2
	}
	if *output == "json" {
		_, _ = stdout.Write(report.JSON())
	} else {
		printText(stdout, report)
	}
	if !report.OK() {
		return 1
	}
	return 0
}

func printText(w io.Writer, report *conformance.Report) {
	labels := map[conformance.Status]string{
		conformance.StatusPassed:  "PASS",
		conformance.StatusFailed:  "FAIL",
		conformance.StatusSkipped: "SKIP",
		conformance.StatusWarning: "WARN",
	}
	for _, c := range report.Checks {
		fmt.Fprintf(w, "%s %-4s %s (%d ms)\n", labels[c.Status], c.ID, c.Name, c.DurationMS)
		if c.Detail != "" && (c.Status != conformance.StatusPassed || len(c.Detail) < 400) {
			for _, line := range strings.Split(c.Detail, "\n") {
				fmt.Fprintf(w, "       %s\n", line)
			}
		}
	}
	fmt.Fprintf(w, "%s: %s\n", strings.ToUpper(string(report.Status)), report.Summary)
}

// prefixWriter prefixes each write, for the plugin's output in --verbose mode.
type prefixWriter struct {
	w      io.Writer
	prefix string
}

func (p prefixWriter) Write(b []byte) (int, error) {
	for _, line := range strings.SplitAfter(string(b), "\n") {
		if line != "" {
			fmt.Fprint(p.w, p.prefix+line)
		}
	}
	return len(b), nil
}
