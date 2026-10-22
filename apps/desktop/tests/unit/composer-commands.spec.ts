import { expect, test } from "@playwright/test";
import type { RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";
import { buildModelOptions, isModelSelectable } from "../../src/features/conversation/composer-commands";

const model = {
  providerId: "openai",
  providerName: "OpenAI",
  modelId: "gpt-6",
  label: "GPT-6",
  available: true,
  authType: "api_key",
  reasoning: true,
  thinkingLevels: [],
  supportsImages: true,
};

function runtime(overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  return {
    workspace: { workspaceId: "workspace", path: "C:/project" },
    providers: [],
    models: [model],
    skills: [],
    extensions: [],
    settings: {
      enableSkillCommands: false,
      enabledModelPatterns: [],
    },
    ...overrides,
  } as RuntimeSnapshot;
}

function expectMatchesOptions(
  value: RuntimeSnapshot | undefined,
  providerId: string | undefined,
  modelId: string | undefined,
): void {
  expect(isModelSelectable(value, providerId, modelId)).toBe(
    buildModelOptions(value).some(
      (option) => option.providerId === providerId && option.modelId === modelId,
    ),
  );
}

test("returns false without a runtime or complete model selection", () => {
  expect(isModelSelectable(undefined, "openai", "gpt-6")).toBe(false);
  expect(isModelSelectable(runtime(), undefined, "gpt-6")).toBe(false);
  expect(isModelSelectable(runtime(), "openai", undefined)).toBe(false);
});

test("selects an available default when enabled patterns are empty", () => {
  const value = runtime();
  expect(isModelSelectable(value, "openai", "gpt-6")).toBe(true);
  expectMatchesOptions(value, "openai", "gpt-6");
});

test("selects a model when its exact provider/model pattern is enabled", () => {
  const value = runtime({
    settings: {
      enableSkillCommands: false,
      enabledModelPatterns: ["openai/gpt-6"],
    },
  });
  expect(isModelSelectable(value, "openai", "gpt-6")).toBe(true);
  expectMatchesOptions(value, "openai", "gpt-6");
});

test("rejects a model omitted from a nonempty enabled-pattern list", () => {
  const value = runtime({
    settings: {
      enableSkillCommands: false,
      enabledModelPatterns: ["openai/gpt-5"],
    },
  });
  expect(isModelSelectable(value, "openai", "gpt-6")).toBe(false);
  expectMatchesOptions(value, "openai", "gpt-6");
});

test("rejects unavailable records and provider/model mismatches", () => {
  const unavailable = runtime({ models: [{ ...model, available: false }] });
  expect(isModelSelectable(unavailable, "openai", "gpt-6")).toBe(false);
  expect(isModelSelectable(runtime(), "anthropic", "gpt-6")).toBe(false);
  expect(isModelSelectable(runtime(), "openai", "other-model")).toBe(false);
  expectMatchesOptions(unavailable, "openai", "gpt-6");
});
