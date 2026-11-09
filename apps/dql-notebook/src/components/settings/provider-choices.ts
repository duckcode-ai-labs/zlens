import type { ProviderSettings, ProviderSettingsId } from '../../api/client';

/**
 * What this install lets a person choose (ZLENS_MODEL_PROVIDERS). The server marks a provider it does not
 * allow `allowed: false` and never uses it; Settings shows only the rest, and says AI is off when none is left.
 */
export function providerAllowed(providers: readonly Pick<ProviderSettings, 'id' | 'allowed'>[], id: ProviderSettingsId): boolean {
  return providers.find((provider) => provider.id === id)?.allowed !== false;
}

/** No provider may be chosen at all (`ZLENS_MODEL_PROVIDERS=none`). */
export function aiTurnedOff(providers: readonly Pick<ProviderSettings, 'allowed'>[]): boolean {
  return providers.length > 0 && providers.every((provider) => provider.allowed === false);
}

/** Each brand with only its allowed ways in (subscription, API key, local); a brand with none left is dropped. */
export function brandsAllowed<Mode extends string, Brand extends { modes: Partial<Record<Mode, ProviderSettingsId>> }>(
  brands: readonly Brand[],
  providers: readonly Pick<ProviderSettings, 'id' | 'allowed'>[],
): Brand[] {
  return brands
    .map((brand) => ({
      ...brand,
      modes: Object.fromEntries(Object.entries(brand.modes).filter(([, id]) => providerAllowed(providers, id as ProviderSettingsId))) as Brand['modes'],
    }))
    .filter((brand) => Object.keys(brand.modes).length > 0);
}

/**
 * Snowflake Cortex in Settings: where it runs, and when result values may reach it (the server's rule: signed in
 * through the project's own Snowflake connection, it counts as a model on this machine).
 */
export const CORTEX_HELP = [
  'Snowflake Cortex runs Claude inside your Snowflake account and signs in with your Snowflake connection, so there is no API key.',
  'Signed in through this project\'s own Snowflake connection, ZLens treats it like a model on this machine: result values may reach it.',
  'Claude may be processed in another Snowflake region when your account allows cross-region inference.',
];

const CORTEX_METHOD_WORDS: Record<string, string> = {
  key_pair: 'key pair',
  programmatic_access_token: 'programmatic access token',
  oauth: 'OAuth token',
};

/** One line on how Snowflake Cortex signs in: the connection and its method, or the server's reason it cannot. */
export function cortexSignInLine(provider?: Pick<ProviderSettings, 'connectionSignIn'>): { ok: boolean; text: string } {
  const signIn = provider?.connectionSignIn;
  if (!signIn) return { ok: false, text: 'Snowflake Cortex signs in with this project\'s Snowflake connection.' };
  if (signIn.problem) return { ok: false, text: signIn.problem };
  const how = signIn.method ? ` with its ${CORTEX_METHOD_WORDS[signIn.method] ?? signIn.method.replace(/_/g, ' ')}` : '';
  return { ok: true, text: `Signs in through the Snowflake connection “${signIn.connection ?? 'default'}”${how}.` };
}
