import type { Domain } from '../../store/types';
import { authoredDomainIds, authoredDomainOptionsWithCurrent, type AuthoredDomainOption } from '../domains/authored-domain-options';

/** Keep legacy metadata visible, but only human-authored domains selectable. */
export function blockDomainOptions(
  currentDomain: string | null | undefined,
  domains: readonly Domain[],
): AuthoredDomainOption[] {
  return authoredDomainOptionsWithCurrent(currentDomain, domains);
}

/**
 * A draft Ask saved from an AI answer (it records the question it came from) is
 * certified into a Domain the reviewer chose. When the project has Domain pages
 * and the draft is in none of them, Certify asks for one first.
 */
export function certifyNeedsDomain(
  source: string,
  currentDomain: string | null | undefined,
  domains: readonly Domain[],
): boolean {
  if (!/^\s*(?:source_question\s*=\s*"[^"\s][^"]*"|answer_fingerprint\s*=|asked_times\s*=)/m.test(source)) return false;
  const ids = authoredDomainIds(domains);
  return ids.size > 0 && !ids.has((currentDomain ?? '').trim());
}
