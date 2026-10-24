/**
 * Pegasus chat modes. Each one is a role the Pi extension enforces: it decides which tools the chat
 * may use. The extension reports the active role as an extension status under
 * `sessionModeStatusKey`, and `/mode <role>` switches it while keeping the chat's model.
 */
export const sessionModes = ["planner", "reviewer", "implementer", "orchestrator"] as const;

export type SessionMode = (typeof sessionModes)[number];

export const sessionModeStatusKey = "pi-mode";

export function isSessionMode(value: unknown): value is SessionMode {
  return typeof value === "string" && (sessionModes as readonly string[]).includes(value);
}
