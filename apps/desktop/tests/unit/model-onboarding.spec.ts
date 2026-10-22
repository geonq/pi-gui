import { expect, test } from "@playwright/test";
import type { RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import { deriveModelOnboardingState } from "../../src/features/settings/model-onboarding";

function unavailableDefaultRuntime(modelLabel?: string): RuntimeSnapshot {
  return {
    workspace: { workspaceId: "workspace", path: "C:/project" },
    providers: [
      {
        id: "claude-code-account-1",
        name: "Claude · work",
        hasAuth: true,
        authType: "oauth",
        authSource: "external",
        oauthSupported: true,
        apiKeySetupSupported: false,
      },
      {
        id: "openai",
        name: "OpenAI",
        hasAuth: true,
        authType: "api_key",
        authSource: "api_key",
        oauthSupported: false,
        apiKeySetupSupported: true,
      },
    ],
    models: [
      ...(modelLabel
        ? [
            {
              providerId: "claude-code-account-1",
              providerName: "Claude · work",
              modelId: "claude-haiku-5-5",
              label: modelLabel,
              available: false,
              authType: "oauth",
              reasoning: false,
              thinkingLevels: [],
              supportsImages: false,
            },
          ]
        : []),
      {
        providerId: "openai",
        providerName: "OpenAI",
        modelId: "gpt-4o",
        label: "GPT-4o",
        available: true,
        authType: "api_key",
        reasoning: true,
        thinkingLevels: [],
        supportsImages: true,
      },
    ],
    skills: [],
    extensions: [],
    settings: {
      defaultProvider: "claude-code-account-1",
      defaultModelId: "claude-haiku-5-5",
      enabledModelPatterns: [],
      enableSkillCommands: false,
    },
  } as RuntimeSnapshot;
}

test("unavailable default warnings use readable provider and model metadata", () => {
  const selected = deriveModelOnboardingState(unavailableDefaultRuntime("Haiku 5.5 (saved)"), {
    provider: undefined,
    modelId: undefined,
  });
  expect(selected.notice?.description).toContain("Claude · WORK / Haiku 5.5 (saved)");

  const missing = deriveModelOnboardingState(unavailableDefaultRuntime(), {
    provider: undefined,
    modelId: undefined,
  });
  expect(missing.notice?.description).toContain("Claude · WORK / Claude Haiku 5.5");
  expect(missing.notice?.description).not.toContain("claude-code-account-1:claude-haiku-5-5");
});
