package conformance

import (
	"bufio"
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// target is the service under test.
type target interface {
	baseURL() string
	token() string
	// command reports whether this is the command form (A3, B6, B7 apply).
	command() bool
	start(ctx context.Context) error
	close()
}

// commandControl is implemented by the command form.
type commandControl interface {
	target
	port() int
	// closeStdin closes the plugin's stdin and waits up to timeout for the process to exit. It reports
	// whether it exited and whether processes were left in its process group.
	closeStdin(timeout time.Duration) (exited bool, leftovers bool)
	// kill9 sends SIGKILL to the process group and waits for the process.
	kill9()
	// restart starts the plugin again with the same data directory and a new token.
	restart(ctx context.Context) error
	logTail() string
}

// urlTarget is a running service at a URL.
type urlTarget struct {
	url, tok string
}

func (u *urlTarget) baseURL() string                 { return u.url }
func (u *urlTarget) token() string                   { return u.tok }
func (u *urlTarget) command() bool                   { return false }
func (u *urlTarget) start(ctx context.Context) error { return nil }
func (u *urlTarget) close()                          {}

// handshakeLine is what a plugin prints on stdout once it listens.
var handshakeLine = regexp.MustCompile(`^cuelor-provider-listening port=([0-9]{1,5})$`)

// commandSpec is what the command form needs to start a plugin.
type commandSpec struct {
	argv    []string
	dir     string
	dataDir string
	tmpDir  string
	extra   []string
	output  io.Writer
	timeout time.Duration
}

// environment builds the plugin's environment from scratch, as the host does.
func (s *commandSpec) environment() []string {
	home, _ := os.UserHomeDir()
	lang := os.Getenv("LANG")
	if lang == "" {
		lang = "en_US.UTF-8"
	}
	env := []string{
		"PATH=/usr/bin:/bin",
		"HOME=" + home,
		"TMPDIR=" + s.tmpDir,
		"LANG=" + lang,
		"CUELOR_PROVIDER_DATA_DIR=" + s.dataDir,
		"CUELOR_PROVIDER_PROTOCOL=1",
	}
	return append(env, s.extra...)
}

// resolveArgv0 finds the executable with the caller's PATH, because the plugin's own PATH is only
// /usr/bin:/bin.
func resolveArgv0(argv []string, dir string) ([]string, error) {
	if len(argv) == 0 {
		return nil, errors.New("empty command")
	}
	out := append([]string(nil), argv...)
	name := out[0]
	if strings.Contains(name, "/") {
		if !filepath.IsAbs(name) {
			name = filepath.Join(dir, name)
		}
		out[0] = name
		return out, nil
	}
	path, err := exec.LookPath(name)
	if err != nil {
		return nil, fmt.Errorf("command %q not found on PATH", name)
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	out[0] = abs
	return out, nil
}

// randomToken returns n random ASCII letters and digits.
func randomToken(n int) string {
	const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		panic(err)
	}
	for i := range buf {
		buf[i] = alphabet[int(buf[i])%len(alphabet)]
	}
	return string(buf)
}

// tailBuffer keeps the last bytes written to it.
type tailBuffer struct {
	mu   sync.Mutex
	buf  []byte
	max  int
	next io.Writer
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.mu.Lock()
	t.buf = append(t.buf, p...)
	if len(t.buf) > t.max {
		t.buf = t.buf[len(t.buf)-t.max:]
	}
	t.mu.Unlock()
	if t.next != nil {
		_, _ = t.next.Write(p)
	}
	return len(p), nil
}

func (t *tailBuffer) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return string(t.buf)
}

// readHandshake reads stdout lines until the handshake line and then keeps copying stdout to log.
func readHandshake(ctx context.Context, stdout io.Reader, log io.Writer, timeout time.Duration) (int, error) {
	type result struct {
		port int
		err  error
	}
	done := make(chan result, 1)
	go func() {
		sc := bufio.NewScanner(stdout)
		sc.Buffer(make([]byte, 64*1024), 1024*1024)
		sent := false
		for sc.Scan() {
			line := sc.Text()
			if !sent {
				if m := handshakeLine.FindStringSubmatch(strings.TrimRight(line, "\r")); m != nil {
					var port int
					fmt.Sscanf(m[1], "%d", &port)
					if port <= 0 || port > 65535 {
						done <- result{err: fmt.Errorf("invalid port in %q", line)}
					} else {
						done <- result{port: port}
					}
					sent = true
					continue
				}
			}
			fmt.Fprintln(log, line)
		}
		if !sent {
			done <- result{err: errors.New("stdout closed before the line \"cuelor-provider-listening port=N\"")}
		}
	}()
	select {
	case res := <-done:
		return res.port, res.err
	case <-time.After(timeout):
		return 0, fmt.Errorf("no line \"cuelor-provider-listening port=N\" on stdout within %s", timeout)
	case <-ctx.Done():
		return 0, fmt.Errorf("waiting for the line \"cuelor-provider-listening port=N\": %w", ctx.Err())
	}
}

// splitCommand splits a command line like a POSIX shell would for simple words and quotes. It does
// not expand variables or globs.
func splitCommand(s string) ([]string, error) {
	var out []string
	var cur strings.Builder
	inWord := false
	quote := rune(0)
	escaped := false
	for _, r := range s {
		switch {
		case escaped:
			cur.WriteRune(r)
			escaped = false
		case r == '\\' && quote != '\'':
			escaped = true
			inWord = true
		case quote != 0:
			if r == quote {
				quote = 0
			} else {
				cur.WriteRune(r)
			}
		case r == '\'' || r == '"':
			quote = r
			inWord = true
		case r == ' ' || r == '\t' || r == '\n':
			if inWord {
				out = append(out, cur.String())
				cur.Reset()
				inWord = false
			}
		default:
			cur.WriteRune(r)
			inWord = true
		}
	}
	if quote != 0 {
		return nil, errors.New("unterminated quote")
	}
	if escaped {
		return nil, errors.New("trailing backslash")
	}
	if inWord {
		out = append(out, cur.String())
	}
	return out, nil
}

// SplitCommand splits a command line into arguments, honouring single quotes, double quotes and
// backslashes. Variables and globs are not expanded. The CLI uses it for --command.
func SplitCommand(s string) ([]string, error) { return splitCommand(s) }
