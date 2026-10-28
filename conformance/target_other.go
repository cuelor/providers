//go:build !unix

package conformance

import "errors"

func newCommandTarget(spec commandSpec) (commandControl, error) {
	return nil, errors.New("the command form needs a Unix-like system; test the plugin with --url instead")
}
