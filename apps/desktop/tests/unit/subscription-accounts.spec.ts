import { expect, test } from "@playwright/test";
import {
  subscriptionAccount,
  subscriptionGroups,
} from "../../src/features/settings/subscription-accounts";
const provider = (id: string, hasAuth = false, oauthSupported = true) => ({
  id,
  hasAuth,
  oauthSupported,
});

test("adding an account selects the next empty OAuth slot without touching the connected first account", () => {
  const first = provider("anthropic", true);
  const second = provider("anthropic-account-2");
  const group = subscriptionGroups([second, first, provider("anthropic-account-3", true)])[0];
  expect(group.accounts[0]).toBe(first);
  expect(group.next).toBe(second);
  expect(group.connected).toBe(2);
  expect(first.hasAuth).toBe(true);
});

test("complete accounts expose no add target and legacy CLI slots stay outside OAuth groups", () => {
  const records = [
    provider("openai", true),
    ...[2, 3, 4, 5].map((n) => provider(`openai-account-${n}`, true)),
    provider("claude-code-account-1"),
  ];
  const groups = subscriptionGroups(records);
  expect(groups).toHaveLength(1);
  expect(groups[0].connected).toBe(5);
  expect(groups[0].next).toBeUndefined();
  expect(groups[0].accounts).toHaveLength(5);
  expect(subscriptionAccount("openai-account-6")).toBeUndefined();
  expect(subscriptionAccount("claude-code-account-1")).toBeUndefined();
});

test("stock providers without registered account aliases keep their original settings screen", () => {
  expect(subscriptionGroups([provider("openai", true), provider("anthropic", true)])).toEqual([]);
  expect(
    subscriptionGroups([provider("anthropic"), provider("anthropic-account-2", false, false)])[0]
      .next?.id,
  ).toBe("anthropic");
});
