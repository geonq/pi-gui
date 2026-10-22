import { expect, test } from "@playwright/test";
import { parseAntigravityLimits } from "../../electron/usage/antigravity-limits";
import { providerAccountLabel } from "../../../../packages/pi-sdk-driver/src/provider-account-label";

test("account aliases cannot carry across OAuth clients or API-key logins", () => {
  const labels = { openai: { clientId: "login-a", label: "work" } };
  expect(
    providerAccountLabel("openai", labels, { openai: { type: "oauth", clientId: "login-a" } }),
  ).toBe("work");
  expect(
    providerAccountLabel("openai", labels, { openai: { type: "oauth", clientId: "login-b" } }),
  ).toBeUndefined();
  expect(
    providerAccountLabel("openai", labels, { openai: { type: "api_key", clientId: "login-a" } }),
  ).toBeUndefined();
  expect(providerAccountLabel("openai", labels, {})).toBeUndefined();
});

test("AGY quota parsing preserves separate pools and rejects unavailable/invalid data", () => {
  const result = parseAntigravityLimits(
    {
      command: {
        name: "usage",
        data: {
          groups: [
            {
              name: "Gemini Models",
              buckets: [
                { window: "5h", remaining_fraction: 0.25, reset_time: "2026-10-21T15:00:00Z" },
                { window: "weekly", remaining_fraction: 0 },
                { window: "weekly", remaining_fraction: 1.5 },
                { window: "weekly", remaining_fraction: "0.5" },
              ],
            },
            { name: "Gemini 4 Argon", buckets: [{ window: "weekly", remaining_fraction: 0.8 }] },
          ],
        },
      },
    },
    123,
  );
  expect(result?.windows).toHaveLength(3);
  expect(result?.windows[0]).toEqual({
    label: "Gemini Models · 5-hour",
    usedPercent: 75,
    resetsAt: Date.parse("2026-10-21T15:00:00Z"),
  });
  expect(result?.windows[1]?.usedPercent).toBe(100);
  expect(result?.windows[2]?.label).toBe("Gemini 4 Argon · Weekly");
  expect(result?.asOf).toBe(123);
  expect(parseAntigravityLimits({ response: "No quota information" })).toBeNull();
  expect(parseAntigravityLimits({ command: { name: "usage", data: { groups: [] } } })).toBeNull();
});
