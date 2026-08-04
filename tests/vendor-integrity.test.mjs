import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WORKSPACE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = readFileSync(resolve(WORKSPACE, "vendor/fflate-0.8.3.js"));
const license = readFileSync(resolve(WORKSPACE, "vendor/fflate-LICENSE.txt"), "utf8");
const notices = readFileSync(resolve(WORKSPACE, "THIRD_PARTY_NOTICES.md"), "utf8");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

assert.equal(
  sha256(runtime),
  "86d12f1b80ed5c9476ea213fbbfddee5fa6366caf6b2c1ea1c8d1f3fdec9fafc",
);
assert.equal(runtime.at(-1), 0x0a);
assert.equal(
  sha256(runtime.subarray(0, -1)),
  "462ef8041fc970e3615a20a9dd2b2e3047a073b2da729ef4f02b634bba8b7b83",
);
assert.match(license, /Copyright \(c\) 2026 Arjun Barrett/);
assert.doesNotMatch(license, /Copyright \(c\) 2023 Arjun Barrett/);
assert.match(notices, /fflate 0\.8\.3/);
assert.match(
  notices,
  /sha512-tbZNuJrLwGUp3zshBtdy4W\+ORxZuIh8a5ilyIEQDC5rY1f3U20JMry0Ll3WBzU58EZKsEuJFXhb5gwv8CsPvgA==/,
);

console.log("vendor integrity tests passed");
