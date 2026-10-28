import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { preserveProofAuth } from "./preserve-proof-auth.cjs";

for (const scenario of ["unchanged", "refreshed", "source-changed", "already-preserved"]) {
  test("verification preserves OAuth refresh safely: " + scenario, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-proof-auth-test-"));
    const sourcePath = path.join(root, "source.json"),
      privatePath = path.join(root, "private.json");
    const initialCredential = { type: "oauth", refresh: "synthetic-old" };
    const refreshed = { type: "oauth", refresh: "synthetic-new" };
    const other = { type: "api_key", key: "synthetic-other-provider" };
    const source = {
      openai:
        scenario === "source-changed"
          ? { type: "oauth", refresh: "synthetic-concurrent-login" }
          : scenario === "already-preserved"
            ? refreshed
            : initialCredential,
      other,
    };
    await writeFile(sourcePath, JSON.stringify(source));
    await writeFile(
      privatePath,
      JSON.stringify({ openai: scenario === "unchanged" ? initialCredential : refreshed }),
    );
    const call = preserveProofAuth({
      sourcePath,
      privatePath,
      provider: "openai",
      initialCredential,
    });
    if (scenario === "source-changed") {
      await assert.rejects(call, /source changed/);
      assert.deepEqual(JSON.parse(await readFile(sourcePath, "utf8")), source);
    } else {
      assert.equal(await call, scenario === "refreshed" ? "preserved" : "unchanged");
      const current = JSON.parse(await readFile(sourcePath, "utf8"));
      assert.deepEqual(current.other, other);
      assert.deepEqual(current.openai, scenario === "unchanged" ? initialCredential : refreshed);
    }
  });
}
