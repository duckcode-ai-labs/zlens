import type { Domain } from '../../store/types';
import { authoredDomainOptionsWithCurrent, type AuthoredDomainOption } from '../domains/authored-domain-options';

/**
 * The value a block draft stores for "Global / cross-domain" (no Domain page).
 * New blocks are written with it, so it is never a missing Domain page (B10).
 */
export const GLOBAL_BLOCK_DOMAIN = 'uncategorized';

/** A block with no domain, or the global value, belongs to no Domain page. */
export function isGlobalBlockDomain(domain: string | null | undefined): boolean {
  const value = domain?.trim().toLowerCase() ?? '';
  return value === '' || value === GLOBAL_BLOCK_DOMAIN || value === 'global';
}

/** The Domain select's value: "" is the "Global / cross-domain" option. */
export function blockDomainSelectValue(domain: string | null | undefined): string {
  return isGlobalBlockDomain(domain) ? '' : domain!.trim();
}

/** Keep legacy metadata visible, but only human-authored domains selectable. */
export function blockDomainOptions(
  currentDomain: string | null | undefined,
  domains: readonly Domain[],
): AuthoredDomainOption[] {
  return authoredDomainOptionsWithCurrent(isGlobalBlockDomain(currentDomain) ? null : currentDomain, domains);
}
