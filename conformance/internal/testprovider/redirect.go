package testprovider

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// The redirect modes answer downloads with a redirect to a second origin, another port on
// 127.0.0.1, as a service that keeps outputs in object storage would (spec/v1.md section 3.4):
//
//	redirect-download     302 to a signed address that needs no bearer token (correct)
//	redirect-needs-token  the same, but the address asks for the bearer token (a fault: the token
//	                      must not go to another origin, so the download fails)
//	redirect-loop         six redirects before the bytes (a fault: clients follow at most 5)
//	redirect-describe     GET /v1/provider redirects, downloads do not (a fault: only downloads may)
var redirectModes = []string{"redirect-download", "redirect-needs-token", "redirect-loop", "redirect-describe"}

type blobStore struct {
	s      *Server
	base   string
	secret []byte
	srv    *http.Server

	mu       sync.Mutex
	requests int
	withAuth int
}

func newBlobStore(s *Server) *blobStore {
	b := &blobStore{s: s, secret: make([]byte, 32)}
	_, _ = rand.Read(b.secret)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		panic(err)
	}
	b.base = fmt.Sprintf("http://127.0.0.1:%d", ln.Addr().(*net.TCPAddr).Port)
	b.srv = &http.Server{Handler: b}
	go func() { _ = b.srv.Serve(ln) }()
	return b
}

func (b *blobStore) close() { _ = b.srv.Close() }

// BlobRequests reports how many requests the second origin received, and how many of them carried
// an Authorization header.
func (s *Server) BlobRequests() (requests, withAuth int) {
	if s.blob == nil {
		return 0, 0
	}
	s.blob.mu.Lock()
	defer s.blob.mu.Unlock()
	return s.blob.requests, s.blob.withAuth
}

func (b *blobStore) sign(id string, exp int64) string {
	mac := hmac.New(sha256.New, b.secret)
	fmt.Fprintf(mac, "%s\n%d", id, exp)
	return hex.EncodeToString(mac.Sum(nil))
}

// signed is a short-lived address of the artifact's bytes.
func (b *blobStore) signed(id string) string {
	exp := time.Now().Add(5 * time.Minute).Unix()
	return fmt.Sprintf("%s/blob/%s?exp=%d&sig=%s", b.base, id, exp, b.sign(id, exp))
}

func (b *blobStore) redirect(w http.ResponseWriter, r *http.Request, id string) {
	if b.s.fault("redirect-loop") {
		http.Redirect(w, r, fmt.Sprintf("%s/hop/1/%s", b.base, id), http.StatusTemporaryRedirect)
		return
	}
	http.Redirect(w, r, b.signed(id), http.StatusFound)
}

func (b *blobStore) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	b.mu.Lock()
	b.requests++
	if r.Header.Get("Authorization") != "" {
		b.withAuth++
	}
	b.mu.Unlock()
	path := r.URL.Path
	switch {
	case path == "/describe":
		writeJSON(w, 200, b.s.description())
	case strings.HasPrefix(path, "/hop/"):
		// /hop/<n>/<id>: hops 1 to 5 redirect again, so the bytes are six redirects away.
		rest := strings.SplitN(strings.TrimPrefix(path, "/hop/"), "/", 2)
		n, _ := strconv.Atoi(rest[0])
		if len(rest) < 2 {
			http.NotFound(w, r)
		} else if n < 6 {
			http.Redirect(w, r, fmt.Sprintf("%s/hop/%d/%s", b.base, n+1, rest[1]), http.StatusTemporaryRedirect)
		} else {
			http.Redirect(w, r, b.signed(rest[1]), http.StatusFound)
		}
	case strings.HasPrefix(path, "/blob/"):
		b.serveBlob(w, r, strings.TrimPrefix(path, "/blob/"))
	default:
		http.NotFound(w, r)
	}
}

func (b *blobStore) serveBlob(w http.ResponseWriter, r *http.Request, id string) {
	exp, _ := strconv.ParseInt(r.URL.Query().Get("exp"), 10, 64)
	sig := r.URL.Query().Get("sig")
	if time.Now().Unix() > exp || !hmac.Equal([]byte(sig), []byte(b.sign(id, exp))) {
		http.Error(w, "the signature is wrong or has expired", http.StatusForbidden)
		return
	}
	if b.s.fault("redirect-needs-token") {
		want := "Bearer " + b.s.opts.Token
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte(want)) != 1 {
			http.Error(w, "missing bearer token", http.StatusUnauthorized)
			return
		}
	}
	b.s.mu.Lock()
	a := b.s.st.Artifacts[id]
	b.s.mu.Unlock()
	if a == nil {
		http.NotFound(w, r)
		return
	}
	writeContent(w, a)
}
