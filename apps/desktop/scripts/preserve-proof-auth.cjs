const { readFile, writeFile } = require("node:fs/promises");
const lockfile = require("proper-lockfile");

// OAuth refresh can rotate the single-use refresh token. Preserve that refresh in
// the designated source without overwriting a newer login or another provider.
async function preserveProofAuth({ sourcePath, privatePath, provider, initialCredential }) {
  const refreshed = JSON.parse(await readFile(privatePath, "utf8"))[provider];
  if (!refreshed || JSON.stringify(refreshed) === JSON.stringify(initialCredential))
    return "unchanged";
  const release = await lockfile.lock(sourcePath, {
    realpath: false,
    retries: { retries: 10, minTimeout: 50, maxTimeout: 250 },
  });
  try {
    const current = JSON.parse(await readFile(sourcePath, "utf8"));
    if (JSON.stringify(current[provider]) === JSON.stringify(refreshed)) return "unchanged";
    if (JSON.stringify(current[provider]) !== JSON.stringify(initialCredential)) {
      throw new Error(
        "Proof auth source changed during verification; refreshed login retained in the private proof profile.",
      );
    }
    current[provider] = refreshed;
    await writeFile(sourcePath, JSON.stringify(current, null, 2), { mode: 0o600 });
    return "preserved";
  } finally {
    await release();
  }
}

module.exports = { preserveProofAuth };
