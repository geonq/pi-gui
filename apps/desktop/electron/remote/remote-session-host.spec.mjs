import assert from "node:assert/strict";
import { test } from "node:test";
import { startRemoteSessionHost } from "./remote-session-host.ts";

const WORKSPACES = [
  {
    id: "project-one",
    name: "Project One",
    kind: "primary",
    sessions: [
      {
        id: "thread-one",
        title: "One",
        updatedAt: "2026-10-21T10:00:00.000Z",
        preview: "First thread",
        status: "idle",
        hasUnseenUpdate: false,
      },
    ],
  },
  {
    id: "project-two",
    name: "Project Two",
    kind: "primary",
    sessions: [
      {
        id: "thread-two",
        title: "Two",
        updatedAt: "2026-10-21T10:00:00.000Z",
        preview: "Second thread",
        status: "running",
        hasUnseenUpdate: false,
      },
    ],
  },
];

function makeAdapter(submitted) {
  return {
    async getCatalog() {
      return WORKSPACES;
    },
    async getTranscript() {
      return [];
    },
    async submitPrompt(input) {
      submitted.push({
        clientId: input.clientId,
        workspaceId: input.sessionRef.workspaceId,
        sessionId: input.sessionRef.sessionId,
      });
    },
    async cancelRun() {},
    subscribe() {
      return () => {};
    },
  };
}

const TOKEN_A = "A".repeat(43);
const TOKEN_B = "B".repeat(43);
const ORIGIN = "app://pi-gui";
const CLIENT_A = {
  id: "mac-client",
  token: TOKEN_A,
  workspaceIds: ["project-one", "project-two"],
  initialWorkspaceId: "project-one",
};
const CLIENT_B = {
  id: "windows-client",
  token: TOKEN_B,
  workspaceIds: ["project-one", "project-two"],
  initialWorkspaceId: "project-one",
};

async function readState(origin, token) {
  const response = await fetch(origin + "/v1/state", {
    headers: { Authorization: "Bearer " + token },
  });
  assert.equal(response.status, 200);
  return await response.json();
}

test("remote host requires bearer auth and exact configured origins", async () => {
  const host = await startRemoteSessionHost({
    clients: [CLIENT_A],
    allowedOrigins: [ORIGIN],
    adapter: makeAdapter([]),
  });
  try {
    const unauthenticated = await fetch(host.origin + "/v1/catalog");
    assert.equal(unauthenticated.status, 401);
    const deniedOrigin = await fetch(host.origin + "/v1/catalog", {
      headers: {
        Authorization: "Bearer " + TOKEN_A,
        Origin: "https://untrusted.example",
      },
    });
    assert.equal(deniedOrigin.status, 403);
  } finally {
    await host.close();
  }
});

test("remote host rejects oversized JSON before native prompt dispatch", async () => {
  const submitted = [];
  const host = await startRemoteSessionHost({
    clients: [CLIENT_A],
    allowedOrigins: [ORIGIN],
    adapter: makeAdapter(submitted),
  });
  try {
    const response = await fetch(host.origin + "/v1/session/prompt", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + TOKEN_A,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "x".repeat(300 * 1024) }),
    });
    assert.equal(response.status, 413);
    assert.equal(submitted.length, 0);
  } finally {
    await host.close();
  }
});

test("each authenticated device keeps an independent project and session view", async () => {
  const submitted = [];
  const host = await startRemoteSessionHost({
    clients: [CLIENT_A, CLIENT_B],
    allowedOrigins: [ORIGIN],
    adapter: makeAdapter(submitted),
  });
  try {
    const beforeA = await readState(host.origin, TOKEN_A);
    const beforeB = await readState(host.origin, TOKEN_B);
    assert.deepEqual(beforeA.view, { workspaceId: "project-one", sessionId: "thread-one" });
    assert.deepEqual(beforeB.view, { workspaceId: "project-one", sessionId: "thread-one" });

    const selected = await fetch(host.origin + "/v1/view", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + TOKEN_A,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ workspaceId: "project-two" }),
    });
    assert.equal(selected.status, 200);
    assert.deepEqual((await selected.json()).view, {
      workspaceId: "project-two",
      sessionId: "thread-two",
    });

    const afterA = await readState(host.origin, TOKEN_A);
    const afterB = await readState(host.origin, TOKEN_B);
    assert.equal(afterA.view.workspaceId, "project-two");
    assert.equal(afterB.view.workspaceId, "project-one");

    const prompt = await fetch(host.origin + "/v1/session/prompt", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + TOKEN_A,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "Use the selected native thread." }),
    });
    assert.equal(prompt.status, 202);
    assert.deepEqual(submitted, [
      {
        clientId: "mac-client",
        workspaceId: "project-two",
        sessionId: "thread-two",
      },
    ]);
  } finally {
    await host.close();
  }
});

test("transcripts hide host attachment paths and downloads require the current session view", async () => {
  const reads = [];
  const adapter = makeAdapter([]);
  const hostPath = "C:\\Users\\someone\\private.txt";
  adapter.getTranscript = async () => [
    {
      kind: "message",
      role: "assistant",
      id: "message-one",
      createdAt: "2026-10-21T10:00:00.000Z",
      text: "The result is attached.",
      attachments: [
        {
          kind: "file",
          name: "private.txt",
          mimeType: "text/plain",
          fsPath: hostPath,
          sizeBytes: 6,
        },
      ],
    },
  ];
  adapter.readAttachment = async (sessionRef, attachment) => {
    reads.push({
      workspaceId: sessionRef.workspaceId,
      sessionId: sessionRef.sessionId,
      hostPath: attachment.hostPath,
    });
    return {
      name: attachment.name,
      mimeType: attachment.mimeType,
      bytes: Buffer.from("result"),
    };
  };
  const host = await startRemoteSessionHost({
    clients: [CLIENT_A],
    allowedOrigins: [ORIGIN],
    adapter,
  });
  try {
    const transcriptResponse = await fetch(host.origin + "/v1/transcript", {
      headers: { Authorization: "Bearer " + TOKEN_A },
    });
    assert.equal(transcriptResponse.status, 200);
    const transcriptText = await transcriptResponse.text();
    assert.equal(transcriptText.includes(hostPath), false);
    assert.equal(transcriptText.includes("fsPath"), false);
    const transcript = JSON.parse(transcriptText);
    const attachmentId = transcript.transcript[0].attachments[0].attachmentId;
    assert.match(attachmentId, /^[A-Za-z0-9_-]{32}$/u);

    const download = await fetch(host.origin + "/v1/attachments/" + attachmentId, {
      headers: { Authorization: "Bearer " + TOKEN_A },
    });
    assert.equal(download.status, 200);
    assert.equal(await download.text(), "result");
    assert.deepEqual(reads, [
      {
        workspaceId: "project-one",
        sessionId: "thread-one",
        hostPath,
      },
    ]);

    await fetch(host.origin + "/v1/view", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + TOKEN_A,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ workspaceId: "project-two" }),
    });
    const staleDownload = await fetch(host.origin + "/v1/attachments/" + attachmentId, {
      headers: { Authorization: "Bearer " + TOKEN_A },
    });
    assert.equal(staleDownload.status, 404);
  } finally {
    await host.close();
  }
});
