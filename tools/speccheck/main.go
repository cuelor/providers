// Command speccheck validates the specification in spec/:
//
//   - every JSON Schema in spec/schemas compiles against the draft 2020-12 meta-schema;
//   - every file in spec/examples validates against the schema named by its prefix
//     (job.succeeded.json -> schemas/job.json), and every file in spec/examples/invalid fails;
//   - openapi.yaml is a valid OpenAPI 3.1 document, covers every v1 endpoint, and every $ref
//     resolves;
//   - extra files given as schema=path arguments validate (for example the registry index).
//
// Usage: speccheck -spec spec [manifest=examples/fake-provider/cuelor-provider.json ...]
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/pb33f/libopenapi"
	"github.com/pb33f/libopenapi-validator/schema_validation"
	"github.com/pb33f/libopenapi/datamodel"
	"github.com/santhosh-tekuri/jsonschema/v6"
	"gopkg.in/yaml.v3"
)

const schemaBase = "https://cuelor.com/schemas/provider/v1/"

// requiredOperations are the endpoints the specification defines (section 3).
var requiredOperations = []string{
	"GET /v1/provider",
	"GET /v1/models",
	"POST /v1/artifacts",
	"GET /v1/artifacts/{artifact_id}",
	"GET /v1/artifacts/{artifact_id}/content",
	"POST /v1/jobs",
	"GET /v1/jobs/{job_id}",
	"POST /v1/jobs/{job_id}/cancel",
	"POST /v1/estimates",
	"POST /v1/setup",
}

type checker struct {
	failures int
}

func (c *checker) fail(format string, args ...any) {
	c.failures++
	fmt.Fprintf(os.Stderr, "FAIL "+format+"\n", args...)
}

func (c *checker) ok(format string, args ...any) {
	fmt.Printf("ok   "+format+"\n", args...)
}

func main() {
	specDir := flag.String("spec", "spec", "the spec directory")
	flag.Parse()
	c := &checker{}

	schemas := c.compileSchemas(filepath.Join(*specDir, "schemas"))
	if schemas != nil {
		c.checkExamples(schemas, filepath.Join(*specDir, "examples"), true)
		c.checkExamples(schemas, filepath.Join(*specDir, "examples", "invalid"), false)
		for _, arg := range flag.Args() {
			name, path, found := strings.Cut(arg, "=")
			if !found {
				c.fail("argument %q is not schema=path", arg)
				continue
			}
			c.validateFile(schemas, name, path, true)
		}
	}
	c.checkOpenAPI(filepath.Join(*specDir, "openapi.yaml"))

	if c.failures > 0 {
		fmt.Fprintf(os.Stderr, "%d failure(s)\n", c.failures)
		os.Exit(1)
	}
	fmt.Println("spec is valid")
}

// compileSchemas loads every schema under its $id and compiles each one, which also validates
// it against its meta-schema.
func (c *checker) compileSchemas(dir string) map[string]*jsonschema.Schema {
	files, err := filepath.Glob(filepath.Join(dir, "*.json"))
	if err != nil || len(files) == 0 {
		c.fail("no schemas in %s", dir)
		return nil
	}
	compiler := jsonschema.NewCompiler()
	compiler.DefaultDraft(jsonschema.Draft2020)
	compiler.AssertFormat()
	names := []string{}
	for _, file := range files {
		doc, err := readJSON(file)
		if err != nil {
			c.fail("%s: %v", file, err)
			continue
		}
		name := strings.TrimSuffix(filepath.Base(file), ".json")
		obj, _ := doc.(map[string]any)
		if obj["$schema"] != "https://json-schema.org/draft/2020-12/schema" {
			c.fail("%s: $schema must be draft 2020-12", file)
		}
		if obj["$id"] != schemaBase+name+".json" {
			c.fail("%s: $id must be %s", file, schemaBase+name+".json")
		}
		if ap, ok := obj["additionalProperties"]; ok && ap == false {
			c.fail("%s: top-level additionalProperties: false would reject unknown fields", file)
		}
		if err := compiler.AddResource(schemaBase+name+".json", doc); err != nil {
			c.fail("%s: %v", file, err)
			continue
		}
		names = append(names, name)
	}
	out := map[string]*jsonschema.Schema{}
	for _, name := range names {
		s, err := compiler.Compile(schemaBase + name + ".json")
		if err != nil {
			c.fail("schema %s: %v", name, err)
			continue
		}
		out[name] = s
		c.ok("schema %s compiles", name)
	}
	return out
}

func (c *checker) checkExamples(schemas map[string]*jsonschema.Schema, dir string, wantValid bool) {
	files, _ := filepath.Glob(filepath.Join(dir, "*.json"))
	if len(files) == 0 {
		c.fail("no examples in %s", dir)
	}
	for _, file := range files {
		name, _, _ := strings.Cut(filepath.Base(file), ".")
		c.validateFile(schemas, name, file, wantValid)
	}
}

func (c *checker) validateFile(schemas map[string]*jsonschema.Schema, name, file string, wantValid bool) {
	schema, ok := schemas[name]
	if !ok {
		c.fail("%s: no schema %q", file, name)
		return
	}
	doc, err := readJSON(file)
	if err != nil {
		c.fail("%s: %v", file, err)
		return
	}
	err = schema.Validate(doc)
	switch {
	case wantValid && err != nil:
		c.fail("%s does not validate against %s: %v", file, name, err)
	case !wantValid && err == nil:
		c.fail("%s validates against %s but is meant to be invalid", file, name)
	case wantValid:
		c.ok("%s is a valid %s", file, name)
	default:
		c.ok("%s is rejected by %s", file, name)
	}
}

func (c *checker) checkOpenAPI(path string) {
	raw, err := os.ReadFile(path)
	if err != nil {
		c.fail("%v", err)
		return
	}
	var root yaml.Node
	if err := yaml.Unmarshal(raw, &root); err != nil {
		c.fail("%s: %v", path, err)
		return
	}
	var plain map[string]any
	if err := yaml.Unmarshal(raw, &plain); err != nil {
		c.fail("%s: %v", path, err)
		return
	}
	if v, _ := plain["openapi"].(string); !strings.HasPrefix(v, "3.1.") {
		c.fail("%s: openapi must be 3.1.x, got %q", path, v)
	}

	// Required operations.
	paths, _ := plain["paths"].(map[string]any)
	for _, op := range requiredOperations {
		method, p, _ := strings.Cut(op, " ")
		item, _ := paths[p].(map[string]any)
		if _, ok := item[strings.ToLower(method)]; !ok {
			c.fail("%s: missing operation %s", path, op)
		}
	}

	// Every $ref resolves.
	refs := map[string]bool{}
	collectRefs(&root, refs)
	keys := make([]string, 0, len(refs))
	for k := range refs {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, ref := range keys {
		if err := resolveRef(filepath.Dir(path), plain, ref); err != nil {
			c.fail("%s: $ref %s: %v", path, ref, err)
		}
	}

	// The document against the OpenAPI 3.1 meta-schema.
	cfg := datamodel.NewDocumentConfiguration()
	cfg.BasePath = filepath.Dir(path)
	cfg.AllowFileReferences = true
	cfg.SpecFilePath = filepath.Base(path)
	doc, err := libopenapi.NewDocumentWithConfiguration(raw, cfg)
	if err != nil {
		c.fail("%s: %v", path, err)
		return
	}
	if valid, errs := schema_validation.ValidateOpenAPIDocument(doc); !valid {
		for _, e := range errs {
			c.fail("%s: %s", path, e.Error())
			for _, se := range e.SchemaValidationErrors {
				fmt.Fprintf(os.Stderr, "       %s: %s\n", se.FieldPath, se.Reason)
			}
		}
	}
	if _, err := doc.BuildV3Model(); err != nil {
		c.fail("%s: building the model: %v", path, err)
	}
	if c.failures == 0 {
		c.ok("%s is a valid OpenAPI 3.1 document with %d resolved $refs", path, len(keys))
	}
}

func collectRefs(n *yaml.Node, refs map[string]bool) {
	if n.Kind == yaml.MappingNode {
		for i := 0; i+1 < len(n.Content); i += 2 {
			if n.Content[i].Value == "$ref" && n.Content[i+1].Kind == yaml.ScalarNode {
				refs[n.Content[i+1].Value] = true
			}
		}
	}
	for _, child := range n.Content {
		collectRefs(child, refs)
	}
}

func resolveRef(baseDir string, self map[string]any, ref string) error {
	file, fragment, _ := strings.Cut(ref, "#")
	var doc any = self
	if file != "" {
		d, err := readJSON(filepath.Join(baseDir, file))
		if err != nil {
			return err
		}
		doc = d
	}
	if fragment == "" {
		return nil
	}
	cur := doc
	for _, tok := range strings.Split(strings.TrimPrefix(fragment, "/"), "/") {
		tok, _ = url.PathUnescape(tok)
		tok = strings.ReplaceAll(strings.ReplaceAll(tok, "~1", "/"), "~0", "~")
		m, ok := cur.(map[string]any)
		if !ok {
			return fmt.Errorf("pointer %s does not resolve", fragment)
		}
		if cur, ok = m[tok]; !ok {
			return fmt.Errorf("pointer %s does not resolve", fragment)
		}
	}
	return nil
}

func readJSON(path string) (any, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, fmt.Errorf("invalid JSON: %w", err)
	}
	return v, nil
}
