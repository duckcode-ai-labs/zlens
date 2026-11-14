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
