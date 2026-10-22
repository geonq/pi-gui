import { basename } from "node:path";
import { expect, test } from "@playwright/test";
import {
  assertExists,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

test("supports workspace rename and remove from the sidebar menu", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const workspaceA = await makeWorkspace("workspace-menu-a");
  const workspaceB = await makeWorkspace("workspace-menu-b");
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspaceA, workspaceB],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspaceA);
    await waitForWorkspaceByPath(window, workspaceB);

    const state = await getDesktopState(window);
    const workspace = state.workspaces.find((entry) => entry.path === workspaceA);
    assertExists(workspace, "Expected first workspace");

    await window
      .getByRole("button", { name: `Workspace actions for ${basename(workspaceA)}` })
      .click();
    const workspaceMenu = window.locator(".workspace-menu").last();
    await expect(workspaceMenu.getByRole("menuitem", { name: "Open folder" })).toBeVisible();
    const editItem = workspaceMenu.getByRole("menuitem", { name: "Edit name and description" });
    await expect(editItem).toBeVisible();
    await expect(workspaceMenu.getByRole("menuitem", { name: "Remove" })).toBeVisible();

    await editItem.click();
    const renameInput = window.getByLabel(`Rename ${basename(workspaceA)}`);
    await renameInput.fill("Renamed workspace");
    await window
      .getByLabel(`Description of ${basename(workspaceA)}`)
      .fill("Desktop shell experiments");
    await window.getByRole("button", { name: "Save" }).click();

    await expect
      .poll(async () => {
        const latest = await getDesktopState(window);
        return latest.workspaces.find((entry) => entry.id === workspace.id)?.name;
      })
      .toBe("Renamed workspace");
    await expect
      .poll(async () => (await getDesktopState(window)).workspaceDescriptions[workspace.id])
      .toBe("Desktop shell experiments");

    const acceptRemoval = window.waitForEvent("dialog").then((dialog) => dialog.accept());
    await window.getByRole("button", { name: "Workspace actions for Renamed workspace" }).click();
    await Promise.all([window.getByRole("menuitem", { name: "Remove" }).click(), acceptRemoval]);

    await expect
      .poll(async () => {
        const latest = await getDesktopState(window);
        return latest.workspaces.some((entry) => entry.id === workspace.id);
      })
      .toBe(false);
  } finally {
    await harness.close();
  }
});
