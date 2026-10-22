import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  createWorkspaceFileTransfers,
  MAX_WORKSPACE_FILE_TRANSFER_BYTES,
} from "../../electron/platform/files/workspace-file-transfers";

async function* bytes(value: Uint8Array): AsyncGenerator<Uint8Array> {
  yield value;
}

async function* text(value: string): AsyncGenerator<Uint8Array> {
  yield Buffer.from(value, "utf8");
}

test("uploads preserve filenames, downloads stream bytes, and replacement requires a matching hash", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-gui-file-transfer-"));
  const workspaceRoot = join(temporaryRoot, "workspace");
  await mkdir(join(workspaceRoot, "reports"), { recursive: true });
  try {
    const transfers = createWorkspaceFileTransfers({
      allowlistedWorkspaces: new Map([["project-1", workspaceRoot]]),
    });
    const uploaded = await transfers.upload({
      workspaceId: "project-1",
      relativePath: "reports/résumé (final).pdf",
      originalName: "résumé (final).pdf",
      source: text("first version"),
    });

    expect(uploaded).toMatchObject({
      fileName: "résumé (final).pdf",
      relativePath: "reports/résumé (final).pdf",
      sizeBytes: 13,
      sha256: createHash("sha256").update("first version").digest("hex"),
    });
    await expect(
      transfers.upload({
        workspaceId: "project-1",
        relativePath: "reports/résumé (final).pdf",
        originalName: "résumé (final).pdf",
        source: text("unapproved replacement"),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await readFile(join(workspaceRoot, "reports", "résumé (final).pdf"), "utf8")).toBe(
      "first version",
    );

    const replaced = await transfers.upload({
      workspaceId: "project-1",
      relativePath: "reports/résumé (final).pdf",
      originalName: "résumé (final).pdf",
      source: text("approved replacement"),
      expectedSha256: uploaded.sha256,
    });
    expect(replaced.sha256).toBe(createHash("sha256").update("approved replacement").digest("hex"));

    const download = await transfers.openDownload({
      workspaceId: "project-1",
      relativePath: "reports/résumé (final).pdf",
    });
    const chunks: Buffer[] = [];
    for await (const chunk of download.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString("utf8")).toBe("approved replacement");
    expect(download.fileName).toBe("résumé (final).pdf");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("rejects traversal, secret paths, unallowlisted workspaces, and uploads over 64 MiB", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-gui-file-transfer-"));
  const workspaceRoot = join(temporaryRoot, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(join(workspaceRoot, ".env"), "private", "utf8");
  try {
    const transfers = createWorkspaceFileTransfers({
      allowlistedWorkspaces: new Map([["project-1", workspaceRoot]]),
    });
    await expect(
      transfers.upload({
        workspaceId: "project-1",
        relativePath: "../outside.txt",
        originalName: "outside.txt",
        source: text("blocked"),
      }),
    ).rejects.toMatchObject({ code: "INVALID_PATH" });
    await expect(
      transfers.openDownload({ workspaceId: "project-1", relativePath: ".env" }),
    ).rejects.toMatchObject({ code: "INVALID_PATH" });
    await expect(
      transfers.openDownload({ workspaceId: "unknown", relativePath: "README.md" }),
    ).rejects.toMatchObject({ code: "WORKSPACE_UNAVAILABLE" });

    await expect(
      transfers.upload({
        workspaceId: "project-1",
        relativePath: "large.pdf",
        originalName: "large.pdf",
        source: bytes(new Uint8Array(MAX_WORKSPACE_FILE_TRANSFER_BYTES + 1)),
      }),
    ).rejects.toMatchObject({ code: "TOO_LARGE" });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("rejects a workspace junction that resolves outside the allowlisted root", async ({}, testInfo) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-gui-file-transfer-"));
  const workspaceRoot = join(temporaryRoot, "workspace");
  const outsideRoot = join(temporaryRoot, "outside");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(outsideRoot, { recursive: true });
  await writeFile(join(outsideRoot, "private.txt"), "outside", "utf8");
  try {
    try {
      await symlink(outsideRoot, join(workspaceRoot, "outside-link"), "junction");
    } catch (error) {
      testInfo.skip(
        true,
        `The platform cannot create a directory junction for this test: ${String(error)}`,
      );
    }

    const transfers = createWorkspaceFileTransfers({
      allowlistedWorkspaces: new Map([["project-1", workspaceRoot]]),
    });
    await expect(
      transfers.openDownload({
        workspaceId: "project-1",
        relativePath: "outside-link/private.txt",
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_FILE" });
    await expect(
      transfers.upload({
        workspaceId: "project-1",
        relativePath: "outside-link/new.txt",
        originalName: "new.txt",
        source: text("outside"),
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_FILE" });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
