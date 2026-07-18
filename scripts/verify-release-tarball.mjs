import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const expectedIntegrity = process.argv[2];
if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(expectedIntegrity ?? "")) {
  throw new Error("expected a valid SHA-512 npm integrity");
}

const scratch = mkdtempSync(join(tmpdir(), "pi-hunk-release-verify-"));
try {
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", scratch], {
      encoding: "utf8",
    }),
  )[0];
  if (packed.integrity !== expectedIntegrity) {
    throw new Error(
      `release tarball mismatch: registry=${expectedIntegrity} checkout=${packed.integrity}`,
    );
  }
  console.log(`Verified release tarball integrity: ${expectedIntegrity}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
