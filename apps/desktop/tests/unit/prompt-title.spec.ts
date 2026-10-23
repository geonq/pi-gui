import { expect, test } from "@playwright/test";
import { promptTitle } from "../../electron/conversation/thread-title-constants";

test("prompt titles read like the task, without machine markup", () => {
  expect(
    promptTitle(
      "Audit preparation coverage for the Berlin hackathon. Read the event brief first.\n\n<!-- PI_NATIVE_CHILD role=planner task=x lease=y -->",
    ),
  ).toBe("Audit preparation coverage for the Berlin…");
  expect(promptTitle("[PI_CHILD_ROLE=reviewer]\nReview this change.")).toBe("Review this change");
  expect(promptTitle("<!-- HERMES_NATIVE_CHILD role=planner task=a lease=b")).toBe("New thread");
  expect(promptTitle("fix the **login** bug in `auth.ts`")).toBe("Fix the login bug in auth.ts");
});
