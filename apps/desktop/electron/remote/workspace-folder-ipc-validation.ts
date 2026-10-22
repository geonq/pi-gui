/** The typed list API makes relativePath optional; native IPC must normalize that omission. */
export function expectOptionalWorkspaceFolderListingPath(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 4_096) {
    throw new TypeError("The relative folder path is invalid.");
  }
  return value;
}
