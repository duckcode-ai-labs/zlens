/**
 * A saved connection value as Settings › Database shows it. A value written as an environment template
 * (`${SNOWFLAKE_ACCOUNT}`, as the ZLens app for Snowflake saves its account and host) is said in words, never
 * shown as raw template text: in the app for Snowflake, Snowflake sets it; elsewhere it comes from the
 * environment variable named.
 */
export function connectionValueText(value: unknown, snowflakeApp: boolean): string {
  const text = String(value);
  const template = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(text.trim());
  if (!template) return text;
  return snowflakeApp ? 'Set by Snowflake' : `From ${template[1]} in the environment`;
}

/**
 * How the app for Snowflake signs in is Snowflake's business (the app's own session token): its
 * raw `authMethod oauth` and `tokenFilePath` rows say nothing a person can act on, so they are one
 * plain row there.
 */
const SNOWFLAKE_APP_SIGN_IN_FIELDS = new Set(['authmethod', 'authenticator', 'tokenfilepath', 'token']);

/** A saved connection's rows in Settings › Database, as [label, value]: no driver, secrets masked. */
export function connectionDetailRows(
  cfg: Record<string, unknown> | null | undefined,
  snowflakeApp: boolean,
  sensitive: (field: string) => boolean,
): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  let signIn = false;
  for (const [key, value] of Object.entries(cfg ?? {})) {
    if (key === 'driver' || key === 'type') continue;
    if (snowflakeApp && SNOWFLAKE_APP_SIGN_IN_FIELDS.has(key.toLowerCase())) {
      signIn = true;
      continue;
    }
    rows.push([key, sensitive(key) ? '••••••••' : connectionValueText(value, snowflakeApp)]);
  }
  if (signIn) rows.push(['sign-in', 'Set by Snowflake']);
  return rows;
}
