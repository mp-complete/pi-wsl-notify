import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const publishWorkflow = readFileSync(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");

test("package manifest exposes only the extension and uses host-provided peers", () => {
  assert.equal(manifest.name, "@mp-complete/pi-wsl-notify");
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
  assert.equal(manifest.license, "MIT");
  assert.equal(manifest.publishConfig.access, "public");
  assert.ok(manifest.keywords.includes("pi-package"));
  assert.deepEqual(manifest.pi, { extensions: ["./extensions/wsl-notify.ts"] });
  assert.equal(manifest.dependencies, undefined);
  assert.deepEqual(manifest.peerDependencies, {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
  });
  for (const hook of ["preinstall", "install", "postinstall", "prepare"]) {
    assert.equal(manifest.scripts[hook], undefined, `no ${hook} lifecycle hook`);
  }
});

test("npm tarball allowlist excludes tests, dependency trees, credentials and local artifacts", () => {
  const packed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
    cwd: root, encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"],
  }));
  assert.equal(packed.length, 1);
  assert.deepEqual(packed[0].files.map((file) => file.path).sort(), [
    "LICENSE", "NOTICE", "README.md", "extensions/wsl-notify.ts", "package.json",
  ]);
  assert.ok(packed[0].size < 20000, "package should remain small and dependency-free");
});

test("publishing uses a version-matched tag and npm trusted publishing", () => {
  assert.match(publishWorkflow, /^on:\n  push:\n    tags:\n      - "v\*"$/m);
  assert.match(publishWorkflow, /environment: npm/);
  assert.match(publishWorkflow, /id-token: write/);
  assert.match(publishWorkflow, /TAG: \$\{\{ github\.ref_name \}\}/);
  assert.match(publishWorkflow, /process\.env\.TAG !==\s+`v\$\{version\}`/);
  assert.match(publishWorkflow, /npm publish --provenance/);
  assert.doesNotMatch(publishWorkflow, /NODE_AUTH_TOKEN|NPM_TOKEN/);
});
