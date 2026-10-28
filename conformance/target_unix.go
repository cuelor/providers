//go:build unix

package conformance

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"sync"
	"syscall"
	"time"
)

// processTarget starts a plugin the way the host does (spec/plugins.md, section 2).
type processTarget struct {
	spec commandSpec
	logs *tailBuffer

	mu     sync.Mutex
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	tok    string
	prt    int
	pgid   int
	exited chan struct{}
}

func newCommandTarget(spec commandSpec) (commandControl, error) {
	return &processTarget{spec: spec, logs: &tailBuffer{max: 64 * 1024, next: spec.output}}, nil
}

func (p *processTarget) baseURL() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return fmt.Sprintf("http://127.0.0.1:%d", p.prt)
}

func (p *processTarget) token() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.tok
}

func (p *processTarget) port() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.prt
}

func (p *processTarget) command() bool   { return true }
func (p *processTarget) logTail() string { return p.logs.String() }

func (p *processTarget) start(ctx context.Context) error {
	cmd := exec.Command(p.spec.argv[0], p.spec.argv[1:]...)
	cmd.Dir = p.spec.dir
	cmd.Env = p.spec.environment()
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Stderr = p.logs
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("starting %s: %w", p.spec.argv[0], err)
	}
	exited := make(chan struct{})
	go func() {
		_ = cmd.Wait()
		close(exited)
	}()
	tok := randomToken(48)
	if _, err := io.WriteString(stdin, tok+"\n"); err != nil {
		p.killGroup(cmd.Process.Pid, exited)
		return fmt.Errorf("writing the token to stdin: %w", err)
	}
	port, err := readHandshake(ctx, stdout, p.logs, p.spec.timeout)
	if err != nil {
		p.killGroup(cmd.Process.Pid, exited)
		if tail := p.logs.String(); tail != "" {
			err = fmt.Errorf("%w; plugin output:\n%s", err, lastLines(tail, 20))
		}
		return err
	}
	p.mu.Lock()
	p.cmd, p.stdin, p.tok, p.prt, p.pgid, p.exited = cmd, stdin, tok, port, cmd.Process.Pid, exited
	p.mu.Unlock()
	return nil
}

func (p *processTarget) killGroup(pgid int, exited chan struct{}) {
	_ = syscall.Kill(-pgid, syscall.SIGKILL)
	select {
	case <-exited:
	case <-time.After(5 * time.Second):
	}
}

func (p *processTarget) closeStdin(timeout time.Duration) (bool, bool) {
	p.mu.Lock()
	stdin, exited, pgid := p.stdin, p.exited, p.pgid
	p.mu.Unlock()
	if stdin == nil {
		return true, false
	}
	_ = stdin.Close()
	ok := false
	select {
	case <-exited:
		ok = true
	case <-time.After(timeout):
	}
	// Give children a moment to go away with their parent, then look at the process group.
	leftovers := false
	deadline := time.Now().Add(500 * time.Millisecond)
	for {
		err := syscall.Kill(-pgid, 0)
		if errors.Is(err, syscall.ESRCH) {
			break
		}
		if time.Now().After(deadline) {
			leftovers = true
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if !ok || leftovers {
		p.killGroup(pgid, exited)
	}
	p.mu.Lock()
	p.stdin = nil
	p.mu.Unlock()
	return ok, leftovers
}

func (p *processTarget) kill9() {
	p.mu.Lock()
	pgid, exited := p.pgid, p.exited
	p.stdin = nil
	p.mu.Unlock()
	if pgid != 0 {
		p.killGroup(pgid, exited)
	}
}

func (p *processTarget) restart(ctx context.Context) error {
	p.stop()
	return p.start(ctx)
}

// stop ends the plugin as the host does: close stdin, SIGTERM after a while, then SIGKILL.
func (p *processTarget) stop() {
	p.mu.Lock()
	stdin, exited, pgid := p.stdin, p.exited, p.pgid
	p.stdin = nil
	p.mu.Unlock()
	if exited == nil {
		return
	}
	if stdin != nil {
		_ = stdin.Close()
	}
	select {
	case <-exited:
		_ = syscall.Kill(-pgid, syscall.SIGKILL) // leftovers in the group
		return
	case <-time.After(5 * time.Second):
	}
	_ = syscall.Kill(-pgid, syscall.SIGTERM)
	select {
	case <-exited:
		return
	case <-time.After(2 * time.Second):
	}
	p.killGroup(pgid, exited)
}

func (p *processTarget) close() { p.stop() }
