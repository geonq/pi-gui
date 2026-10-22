import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  createRemoteWorkspaceFolders,
  RemoteWorkspaceFolderError,
} from "../../electron/remote/remote-workspace-folders";

test("remote folder browsing and creation stay inside an explicit root without overwriting", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-remote-workspace-folders-"));
  const projectsRoot = path.join(temporaryRoot, "projects");
  await mkdir(projectsRoot);
  await mkdir(path.join(projectsRoot, "Alpha"));
  await mkdir(path.join(projectsRoot, ".ssh"));
  const folders = createRemoteWorkspaceFolders(new Map([["projects-root", projectsRoot]]));

  try {
    const listing = await folders.list("projects-root");
    expect(listing.folders).toEqual([{ name: "Alpha", relativePath: "Alpha" }]);

    const created = await folders.create("projects-root", "Alpha", "New Project");
    expect(created.relativePath).toBe("Alpha/New Project");
    expect((await stat(created.absolutePath)).isDirectory()).toBe(true);
    await expect(folders.create("projects-root", "Alpha", "New Project")).rejects.toMatchObject({
      code: "CONFLICT",
    });

    await expect(folders.list("projects-root", "../outside")).rejects.toMatchObject({
      code: "INVALID_PATH",
    });
    await expect(folders.resolveExisting("unapproved-root", "Alpha")).rejects.toMatchObject({
      code: "ROOT_UNAVAILABLE",
    });
    await expect(folders.create("projects-root", "Alpha", "CON")).rejects.toMatchObject({
      code: "INVALID_PATH",
    });
  } finally {
    if (path.resolve(temporaryRoot).startsWith(path.resolve(os.tmpdir()))) {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
});
