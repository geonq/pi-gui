import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import type { SessionDriverEvent } from "@pi-gui/session-driver";
import { PiSdkDriver } from "../dist/pi-sdk-driver.js";
import { createAgentSessionRuntimeWithNpmFallback } from "../dist/npm-package-fallback.js";

type StreamFunction = AgentSessionRuntime["session"]["agent"]["streamFunction"];

function thinkingReply(model: Parameters<StreamFunction>[0]) {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "First, then second.", thinkingSignature: "sig" },
      { type: "text", text: "Done." },
    ],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  stream.push({ type: "start", partial: { ...message, content: [] } });
  stream.push({ type: "thinking_delta", contentIndex: 0, delta: "First, ", partial: message });
  stream.push({ type: "thinking_delta", contentIndex: 0, delta: "then second.", partial: message });
  stream.push({ type: "text_delta", contentIndex: 1, delta: "Done.", partial: message });
  stream.push({ type: "done", reason: "stop", message });
  return stream;
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pi-gui-thinking-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  await mkdir(agentDir);
  await mkdir(cwd);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });
  await writeFile(join(agentDir, "auth.json"), "{}");
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ packages: [], compaction: { enabled: false }, cacheWarming: "off" }),
  );
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "thinking-test": {
          baseUrl: "http://127.0.0.1:9/never-contact",
          apiKey: "LOCAL_TEST_CANARY",
          api: "openai-completions",
          models: [{ id: "scripted", input: ["text"], contextWindow: 128000, maxTokens: 4096 }],
        },
      },
    }),
  );
  const events: SessionDriverEvent[] = [];
  const driver = new PiSdkDriver({
    agentDir,
    catalogFilePath: join(root, "catalogs.json"),
    createAgentSessionRuntimeImpl: async (runtimeOptions) => {
      const runtime = await createAgentSessionRuntimeWithNpmFallback(runtimeOptions);
      runtime.session.agent.streamFunction = (model) => thinkingReply(model);
      return runtime;
    },
  });
  const { ref } = await driver.createSession(
    { workspaceId: "thinking-workspace", path: cwd },
    { initialModel: { provider: "thinking-test", modelId: "scripted" } },
  );
  const unsubscribe = driver.subscribe(ref, (event) => {
    events.push(event);
  });
  t.after(async () => {
    unsubscribe();
    await driver.closeSession(ref);
  });
  return { driver, ref, events };
}

await test("live thinking deltas reach the driver in order before the reply text", async (t) => {
  const h = await fixture(t);
  await h.driver.sendUserMessage(h.ref, { text: "go" });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (h.events.some((event) => event.type === "runCompleted")) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const streamed = h.events.flatMap((event) =>
    event.type === "assistantThinkingDelta" || event.type === "assistantDelta"
      ? [[event.type, event.text]]
      : [],
  );
  assert.deepEqual(streamed, [
    ["assistantThinkingDelta", "First, "],
    ["assistantThinkingDelta", "then second."],
    ["assistantDelta", "Done."],
  ]);
});
