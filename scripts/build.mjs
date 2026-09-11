import { realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createRequire, isBuiltin } from "node:module";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { build } from "esbuild";

const hostModules = {
  "@earendil-works/pi-coding-agent": true,
  "@earendil-works/pi-tui": true,
  "@oh-my-pi/pi-coding-agent": true,
  "@oh-my-pi/pi-tui": true,
  "hunkdiff/extension": true,
};

await rm("dist", { recursive: true, force: true });

const require = createRequire(import.meta.url);
const effectPackageRoot = dirname(realpathSync(require.resolve("effect/package.json")));
const buildRoot = process.cwd();
const resolvedInputs = new Map();

function isEffectInput(input) {
  let resolvedInput = resolvedInputs.get(input);
  if (resolvedInput === undefined) {
    resolvedInput = realpathSync(resolve(buildRoot, input));
    resolvedInputs.set(input, resolvedInput);
  }
  const relativeInput = relative(effectPackageRoot, resolvedInput);
  return (
    relativeInput === "" ||
    (relativeInput !== ".." && !relativeInput.startsWith(`..${sep}`) && !isAbsolute(relativeInput))
  );
}

const result = await build({
  // Hunk reserves the extension id "hunk", derived from the entry's filename.
  entryPoints: { pi: "src/pi.ts", omp: "src/omp.ts", "pi-hunk-review": "src/hunk.ts" },
  outdir: "dist",
  entryNames: "[name]",
  chunkNames: "chunks/[name]-[hash]",
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node22.19",
  minify: true,
  treeShaking: true,
  legalComments: "none",
  sourcemap: false,
  external: Object.keys(hostModules),
  metafile: true,
  logLevel: "info",
});

for (const [output, metadata] of Object.entries(result.metafile.outputs)) {
  for (const dependency of metadata.imports) {
    if (dependency.external && !isBuiltin(dependency.path) && !hostModules[dependency.path]) {
      throw new Error(`${output} requires an unprovided runtime module: ${dependency.path}`);
    }
  }
  for (const [input, contribution] of Object.entries(metadata.inputs)) {
    if (
      contribution.bytesInOutput > 0 &&
      input.includes("node_modules/") &&
      !isEffectInput(input)
    ) {
      throw new Error(`${output} bundles a runtime library other than Effect: ${input}`);
    }
  }
}
