/** Display aliases belong to a particular OAuth login, never a different CLI/account. */
export function providerAccountLabel(
  providerId: string,
  aliases: unknown,
  credentials: unknown,
): string | undefined {
  if (!aliases || typeof aliases !== "object" || !credentials || typeof credentials !== "object")
    return;
  const alias = (aliases as Record<string, unknown>)[providerId];
  const credential = (credentials as Record<string, unknown>)[providerId];
  if (!alias || typeof alias !== "object" || !credential || typeof credential !== "object") return;
  const saved = alias as Record<string, unknown>;
  const current = credential as Record<string, unknown>;
  if (
    current.type !== "oauth" ||
    typeof current.clientId !== "string" ||
    !current.clientId ||
    saved.clientId !== current.clientId ||
    typeof saved.label !== "string"
  )
    return;
  return (
    saved.label
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .trim()
      .slice(0, 80) || undefined
  );
}
