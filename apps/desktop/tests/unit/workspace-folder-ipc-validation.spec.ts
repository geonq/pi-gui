import { expect, test } from "@playwright/test";
import { expectOptionalWorkspaceFolderListingPath } from "../../electron/remote/workspace-folder-ipc-validation";

test("native folder listing accepts the omitted root path and rejects malformed values", () => {
  expect(expectOptionalWorkspaceFolderListingPath(undefined)).toBe("");
  expect(expectOptionalWorkspaceFolderListingPath("")).toBe("");
  expect(expectOptionalWorkspaceFolderListingPath("NextSemis/Research")).toBe("NextSemis/Research");
  expect(() => expectOptionalWorkspaceFolderListingPath(null)).toThrow("relative folder path is invalid");
  expect(() => expectOptionalWorkspaceFolderListingPath(42)).toThrow("relative folder path is invalid");
  expect(() => expectOptionalWorkspaceFolderListingPath("x".repeat(4_097))).toThrow(
    "relative folder path is invalid",
  );
});
