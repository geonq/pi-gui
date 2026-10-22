import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { createEmptyDesktopAppState } from "../../contracts/desktop-state";
import { createWorkspaceFolderService } from "../../electron/remote/workspace-folder-service";

test("Windows folder service registers only contained folders and returns their real app state", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-workspace-folder-service-"));
  const projectsRoot = path.join(temporaryRoot, "projects");
  await mkdir(projectsRoot);
  const registeredPaths: string[] = [];
  const baseState = createEmptyDesktopAppState();
  const service = createWorkspaceFolderService({
    windowsRoots: [
      {
        id: "projects-root",
        label: "Projects",
        workspaceId: "projects-root",
        canCreate: true,
        path: projectsRoot,
      },
    ],
    addWorkspacePath: async (workspacePath) => {
      registeredPaths.push(workspacePath);
      const id = path.basename(workspacePath);
      const workspace = {
        id,
        name: id,
        path: workspacePath,
        lastOpenedAt: "2026-10-21T00:00:00.000Z",
        kind: "primary" as const,
        sessions: [],
      };
      return {
        ...baseState,
        workspaces: [workspace],
        selectedWorkspaceId: id,
      };
    },
  });

  try {
    const roots = await service.adapters.windows.listRoots();
    expect(roots).toEqual([
      { id: "projects-root", label: "Projects", workspaceId: "projects-root", canCreate: true },
    ]);

    const created = await service.adapters.windows.create("projects-root", "", "NextSemis");
    expect(created).toMatchObject({
      device: "windows",
      workspaceId: "NextSemis",
      relativePath: "NextSemis",
      state: { selectedWorkspaceId: "NextSemis" },
    });
    expect((await stat(path.join(projectsRoot, "NextSemis"))).isDirectory()).toBe(true);

    const opened = await service.adapters.windows.open("projects-root", "NextSemis");
    expect(opened).toMatchObject({ device: "windows", workspaceId: "NextSemis" });
    await expect(service.adapters.windows.open("projects-root", "../outside")).rejects.toMatchObject({
      code: "INVALID_PATH",
    });
    expect(registeredPaths).toEqual([
      path.join(projectsRoot, "NextSemis"),
      path.join(projectsRoot, "NextSemis"),
    ]);
  } finally {
    if (path.resolve(temporaryRoot).startsWith(path.resolve(os.tmpdir()))) {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
});
