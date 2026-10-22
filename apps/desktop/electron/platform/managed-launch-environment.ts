import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const MAX_OUTPUT_BYTES = 256 * 1024;

const ALLOWED_ENVIRONMENT_KEYS = new Set([
  "PATH",
  "PI_CLAUDE_CODE_COMMAND",
  "PI_CODING_AGENT_DIR",
  "PI_APP_USER_DATA_DIR",
  "PI_APP_INITIAL_WORKSPACES",
  "PI_APP_GENERATE_THREAD_TITLES",
  "PI_APP_CONTEXT_FILES",
  "PI_APP_AUTOMATION_MANIFEST",
  "PI_APP_AUTOMATION_DESCRIPTOR",
  "PI_REMOTE_DESKTOP_HOST_CONFIG",
  "PI_GUI_INTEGRATED_LAUNCH",
]);

export const DENIED_ENVIRONMENT_NAME =
  /^(?:AWS_.*|NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE|DYLD_INSERT_LIBRARIES|DYLD_FRAMEWORK_PATH|DYLD_LIBRARY_PATH|.*(?:API_KEY|API_TOKEN|ACCESS_TOKEN|AUTH_TOKEN|REFRESH_TOKEN|OAUTH_TOKEN|CLIENT_SECRET|SECRET|TOKEN|PASSWORD|PRIVATE_KEY))$/i;

export function applyManagedLaunchEnvironment(
  output: string,
  profile: Readonly<{ userDataDir: string; agentDir: string }>,
): void {
  if (typeof output !== "string" || Buffer.byteLength(output, "utf8") > MAX_OUTPUT_BYTES) {
    throw new Error("Managed launcher environment is invalid.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("Managed launcher environment is invalid.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Managed launcher environment is invalid.");
  }

  // Only allowlisted names are copied (never __proto__), so a plain object is safe.
  const preparedEnvironment: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!ALLOWED_ENVIRONMENT_KEYS.has(name) || typeof value !== "string" || value.includes("\0")) {
      throw new Error("Managed launcher environment is invalid.");
    }
    preparedEnvironment[name] = value;
  }

  if (
    !preparedEnvironment.PATH ||
    preparedEnvironment.PI_GUI_INTEGRATED_LAUNCH !== "1" ||
    preparedEnvironment.PI_APP_USER_DATA_DIR !== profile.userDataDir ||
    preparedEnvironment.PI_CODING_AGENT_DIR !== profile.agentDir
  ) {
    throw new Error("Managed launcher environment is invalid.");
  }

  for (const name of ALLOWED_ENVIRONMENT_KEYS) delete process.env[name];
  for (const name of Object.keys(process.env)) {
    if (DENIED_ENVIRONMENT_NAME.test(name)) delete process.env[name];
  }
  Object.assign(process.env, preparedEnvironment);
}

/** Keeps the failure reason (message only) where the startup dialog says to look. */
export function recordStartupError(ecosystemRoot: string, error: unknown): void {
  try {
    const stateDir = path.join(ecosystemRoot, ".state");
    mkdirSync(stateDir, { recursive: true });
    appendFileSync(
      path.join(stateDir, "pi-gui-startup-error.log"),
      `${new Date().toISOString()} ${String(error)}
`,
    );
  } catch {
    // Logging must never mask the original startup failure.
  }
}
