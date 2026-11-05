import type { AskScopeOption } from '../../api/client';
import type { DomainScope } from './domain-scope';

/** Why a saved scope cannot be used, in plain words; undefined when it can (or before the list loads). */
export function scopeProblem(scope: DomainScope | undefined, options: AskScopeOption[] | null): string | undefined {
  if (!scope || !options) return undefined;
  const domain = options.find((option) => option.id === scope.domain);
  if (!domain) return `The domain “${scope.domain}” no longer exists.`;
  if (scope.modelAreaId && !domain.areas.some((area) => area.id === scope.modelAreaId)) return `The area “${scope.modelAreaId.split('::').pop()}” no longer exists in ${domain.label}.`;
  return undefined;
}

/** The scope in plain words: domain, subject area and purpose. */
export function scopeLabel(scope: DomainScope | undefined, options: AskScopeOption[] | null): string {
  if (!scope) return 'All domains';
  const domain = options?.find((option) => option.id === scope.domain);
  const area = scope.modelAreaId ? domain?.areas.find((item) => item.id === scope.modelAreaId)?.name ?? scope.modelAreaId.split('::').pop() : undefined;
  return [domain?.label ?? scope.domain, area, scope.purpose ? `for ${scope.purpose}` : ''].filter(Boolean).join(' · ');
}
