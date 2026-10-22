import type { RuntimeProviderRecord } from "@pi-gui/session-driver/runtime-types";

export const SUBSCRIPTION_FAMILIES = [
  { id: "openai", name: "OpenAI / Codex", shortName: "Codex", mark: "O" },
  { id: "anthropic", name: "Claude", shortName: "Claude", mark: "C" },
] as const;

export function subscriptionAccount(
  id: string,
): { family: "openai" | "anthropic"; number: number } | undefined {
  if (id === "openai" || id === "anthropic") return { family: id, number: 1 };
  const match = /^(openai|anthropic)-account-([2-5])$/.exec(id);
  return match
    ? { family: match[1] as "openai" | "anthropic", number: Number(match[2]) }
    : undefined;
}

export function subscriptionGroups<
  T extends Pick<RuntimeProviderRecord, "id" | "hasAuth" | "oauthSupported">,
>(providers: readonly T[]) {
  return SUBSCRIPTION_FAMILIES.flatMap((family) => {
    const accounts = providers
      .filter((provider) => subscriptionAccount(provider.id)?.family === family.id)
      .sort((a, b) => subscriptionAccount(a.id)!.number - subscriptionAccount(b.id)!.number);
    if (!accounts.some((provider) => subscriptionAccount(provider.id)!.number > 1)) return [];
    return [
      {
        ...family,
        accounts,
        connected: accounts.filter((provider) => provider.hasAuth).length,
        next: accounts.find((provider) => !provider.hasAuth && provider.oauthSupported),
      },
    ];
  });
}
