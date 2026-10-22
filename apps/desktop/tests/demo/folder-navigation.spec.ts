import { expect, test } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  chooseThreadGrouping,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  openNewThread,
} from "../helpers/electron-app";

test("Pegasus folders, file inspection and both pane edges work before a chat", async () => {
  test.setTimeout(120_000);
  const evidence = process.env.PI_DEMO_EVIDENCE!;
  await mkdir(evidence, { recursive: true });
  const workspace = await makeWorkspace("demo-project");
  await writeFile(
    join(workspace, "README.md"),
    "# Pegasus project\n\nFile inspection works before a chat.\n",
  );
  const harness = await launchDesktop(await makeUserDataDir(), {
    initialWorkspaces: [workspace],
    testMode: "foreground",
    recordVideoDir: join(evidence, "video"),
  });
  try {
    const page = await harness.firstWindow();
    await openNewThread(page);
    await expect(page).toHaveTitle("Pegasus");
    await expect(page.locator(".sidebar__brand-name")).toHaveText("Pegasus");
    await expect.poll(() => page.locator(".sidebar__brand-mark").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
    await chooseThreadGrouping(page, "workspace");
    const actions = page.locator(".sidebar__folder-actions");
    await expect(actions.getByRole("button", { name: "New folder", exact: true })).toBeVisible();
    await expect(page.getByText("Chats & Folders", { exact: true })).toBeVisible();
    const typography = await page.evaluate(() => {
      const action = getComputedStyle(document.querySelector(".sidebar__folder-actions button")!);
      const nav = getComputedStyle(document.querySelector(".sidebar__nav-item")!);
      return { action: [action.fontSize, action.fontWeight], nav: [nav.fontSize, nav.fontWeight] };
    });
    expect(typography.action).toEqual(typography.nav);
    const left = page.getByRole("separator", { name: "Sidebar width", exact: true });
    const leftBefore = (await page.locator(".sidebar").boundingBox())!.width;
    const leftBox = (await left.boundingBox())!;
    await page.mouse.move(leftBox.x + leftBox.width / 2, leftBox.y + 350);
    await page.mouse.down();
    await page.mouse.move(leftBox.x + leftBox.width / 2 + 70, leftBox.y + 350, { steps: 8 });
    await page.mouse.up();
    await expect(left).toHaveAttribute("data-resizing", "false");
    await expect(left).not.toBeFocused();
    await expect
      .poll(async () => (await page.locator(".sidebar").boundingBox())!.width)
      .toBeGreaterThan(leftBefore + 50);
    await actions.getByRole("button", { name: "Browse files", exact: true }).click();
    const explorer = page.getByTestId("file-explorer");
    await expect(explorer).toBeVisible();
    const right = page.getByRole("separator", { name: "Side panel width", exact: true });
    const rightPane = page.getByRole("complementary", { name: "Project files", exact: true });
    const rightBefore = (await rightPane.boundingBox())!.width;
    const rightBox = (await right.boundingBox())!;
    await page.mouse.move(rightBox.x + rightBox.width / 2, rightBox.y + 350);
    await page.mouse.down();
    await page.mouse.move(rightBox.x + rightBox.width / 2 - 70, rightBox.y + 350, { steps: 8 });
    await page.mouse.up();
    await expect(right).toHaveAttribute("data-resizing", "false");
    await expect(right).not.toBeFocused();
    await expect
      .poll(async () => (await rightPane.boundingBox())!.width)
      .toBeGreaterThan(rightBefore + 50);
    await expect(page.getByTestId("toggle-side-panel")).toBeHidden();
    await page.getByRole("button", { name: "Close files", exact: true }).click();
    await expect(rightPane).toBeHidden();
    await actions.getByRole("button", { name: "Browse files", exact: true }).click();

    await explorer.locator('[data-file-path="README.md"]').click();
    await expect(page.getByTestId("file-workbench-preview")).toContainText(
      "File inspection works before a chat.",
    );
    const state = await getDesktopState(page);
    expect(state.workspaces.flatMap((w) => w.sessions)).toHaveLength(0);
    await page.screenshot({ path: join(evidence, "project-files.png") });
    await page.getByRole("button", { name: "Close files", exact: true }).click();
    // Stub only the native selection: real renderer -> preload -> main -> mkdir -> workspace state.
    const newPath = join(workspace, "Created in Pegasus");
    await harness.electronApp.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    }, newPath);
    await actions.getByRole("button", { name: "New folder", exact: true }).click();
    await expect
      .poll(async () => (await getDesktopState(page)).workspaces.some((w) => w.path === newPath))
      .toBe(true);
    await page.keyboard.press("Escape");
    await writeFile(join(newPath, "keep.txt"), "preserve");
    await harness.electronApp.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    });
    await actions.getByRole("button", { name: "New folder", exact: true }).click();
    await expect.poll(async () => (await getDesktopState(page)).workspaces.length).toBe(2);
    expect(await readFile(join(newPath, "keep.txt"), "utf8")).toBe("preserve");
    await harness.electronApp.evaluate(({ dialog }) => {
      dialog.showSaveDialog = async () => ({ canceled: true, filePath: undefined });
    });
    await actions.getByRole("button", { name: "New folder", exact: true }).click();
    expect((await getDesktopState(page)).workspaces).toHaveLength(2);
    await chooseThreadGrouping(page, "time");
    await expect(actions).toHaveCount(0);
    await page.setViewportSize({ width: 1000, height: 760 });
    await page.screenshot({ path: join(evidence, "demo-sidebar.png") });
    expect(await harness.electronApp.evaluate(({ app }) => app.getName())).toBe("Pegasus");
  } finally {
    await harness.close();
  }
});
