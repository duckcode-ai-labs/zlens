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
