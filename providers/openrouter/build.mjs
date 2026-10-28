// Bundles the plugin into one dependency-free file, dist/provider.mjs, next to its manifest. Also builds
// the test tools into dist-test/: the mock OpenRouter (mock-upstream.mjs, which scripts/check-plugins.sh
// starts for tier A when no real key is set) and the deliberately faulty variant (faulty-provider.mjs).
import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  legalComments: "none",
  logLevel: "warning",
};

mkdirSync(join(root, "dist"), { recursive: true });
await build({ ...common, entryPoints: [join(root, "src/main.ts")], outfile: join(root, "dist/provider.mjs") });
copyFileSync(join(root, "cuelor-provider.json"), join(root, "dist/cuelor-provider.json"));

mkdirSync(join(root, "dist-test"), { recursive: true });
await build({ ...common, entryPoints: [join(root, "test/mock-main.ts")], outfile: join(root, "dist-test/mock-upstream.mjs") });
await build({ ...common, entryPoints: [join(root, "test/faulty-provider.ts")], outfile: join(root, "dist-test/faulty-provider.mjs") });
copyFileSync(join(root, "cuelor-provider.json"), join(root, "dist-test/cuelor-provider.json"));
