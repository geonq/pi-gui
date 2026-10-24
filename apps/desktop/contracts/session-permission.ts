/**
 * Pegasus chat permissions, enforced by the Pi extension on every file change and command:
 * `plan` is read-only, `ask` asks before each change and command, `edits` asks only before
 * commands, `full` never asks. The extension reports the chat's permission as an extension status
 * under `sessionPermissionStatusKey`, and `/permissions <level>` changes it.
 */
export const sessionPermissions = ["plan", "ask", "edits", "full"] as const;

export type SessionPermission = (typeof sessionPermissions)[number];

export const sessionPermissionStatusKey = "pi-permission";

export function isSessionPermission(value: unknown): value is SessionPermission {
  return typeof value === "string" && (sessionPermissions as readonly string[]).includes(value);
}
