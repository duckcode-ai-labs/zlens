/**
 * Shared presentation text helpers for the Apps surface.
 *
 * Extracted from `AppsView.tsx` so the modules split out of it can reuse them
 * without importing the whole view.
 */

export function tidyTitle(value?: string | null): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .replace(/[\s,;:.–—-]+$/, '')
    .trim();
}

/** The App's name in the reader header: its name, never its slug, unless it has none. */
export function appHeaderTitle(name?: string | null, id?: string | null): string {
  return tidyTitle(name) || id || 'App';
}

export function formatBusinessLabel(value?: string | null): string {
  const clean = String(value ?? '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return 'Business';
  return clean.split(' ').map((word) => {
    const lower = word.toLowerCase();
    if (lower === 'ai') return 'AI';
    if (lower === 'cxo') return 'CXO';
    if (lower === 'kpi') return 'KPI';
    if (lower === 'vs' || lower === 'vs.') return 'vs.';
    return `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
  }).join(' ');
}

export function cleanStakeholderCopy(value: string): string {
  return value
    // Older generated Apps described themselves as certified in static text;
    // whether a page is certified is shown from its tiles' current trust.
    .replace(/\bCertified app surface for ([^.]+)\./gi, 'App for $1. Each tile shows whether its source is certified.')
    .replace(/\bDraft gaps stay in Research until reviewed\.?/gi, 'Follow-up analysis stays out of the stakeholder view until reviewed.')
    .replace(/\bresearch path\b/gi, 'analysis path')
    .replace(/\bresearch suggestions\b/gi, 'analysis suggestions')
    .replace(/\bfollow-up research\b/gi, 'follow-up analysis')
    .replace(/\bevidence chips\b/gi, 'proof chips')
    .replace(/\bevidence, lineage\b/gi, 'proof and lineage')
    .replace(/\bevidence and lineage\b/gi, 'proof and lineage')
    .replace(/\bsource evidence\b/gi, 'source proof')
    .replace(/\bOpen Research\b/g, 'Open Analysis')
    .replace(/\bResearch\b/g, 'Analysis');
}
