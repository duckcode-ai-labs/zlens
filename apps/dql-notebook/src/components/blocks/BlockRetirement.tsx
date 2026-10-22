import React from 'react';
import { ArrowRight } from 'lucide-react';
import type { Theme } from '../../themes/notebook-theme';

/**
 * Retirement metadata a deprecated block carries (`replacedBy`,
 * `deprecatedOn`) plus the active block the server resolved it to.
 */
export interface BlockRetirementInfo {
  status?: string;
  replacedBy?: string;
  deprecatedOn?: string;
  /** Active block the replacement resolves to; null when it names no block. */
  replacement?: { name: string; path: string } | null;
}

export interface BlockRetirementSummary {
  /** Name to show after "Replaced by". */
  replacementName?: string;
  /** Path to open, only when the replacement resolved to a block. */
  replacementPath?: string;
  deprecatedOn?: string;
}

/** What a retired block says about itself; undefined for a block that is not deprecated. */
export function blockRetirementSummary(info: BlockRetirementInfo | null | undefined): BlockRetirementSummary | undefined {
  if (!info || (info.status ?? '').toLowerCase() !== 'deprecated') return undefined;
  const replacementName = info.replacement?.name ?? info.replacedBy;
  return {
    ...(replacementName ? { replacementName } : {}),
    ...(info.replacement?.path ? { replacementPath: info.replacement.path } : {}),
    ...(info.deprecatedOn ? { deprecatedOn: info.deprecatedOn } : {}),
  };
}

/**
 * "Replaced by <name>" beside a Deprecated badge, the name a link to the
 * replacement when it resolves. Renders nothing for a block that is not
 * deprecated or names no replacement and no date.
 */
export function BlockReplacementLink({
  info,
  t,
  onOpen,
}: {
  info: BlockRetirementInfo | null | undefined;
  t: Theme;
  onOpen?: (path: string) => void;
}) {
  const summary = blockRetirementSummary(info);
  if (!summary || (!summary.replacementName && !summary.deprecatedOn)) return null;
  const { replacementName, replacementPath, deprecatedOn } = summary;
  return (
    <span
      data-testid="block-replaced-by"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: t.textSecondary, fontFamily: t.font, whiteSpace: 'nowrap' }}
    >
      {replacementName ? (
        <>
          Replaced by{' '}
          {replacementPath && onOpen ? (
            <button
              type="button"
              onClick={(event) => { event.stopPropagation(); onOpen(replacementPath); }}
              title={`Open ${replacementName}`}
              style={{ background: 'transparent', border: 'none', padding: 0, color: t.accent, cursor: 'pointer', fontSize: 11, fontWeight: 600, fontFamily: t.font, textDecoration: 'underline' }}
            >
              {replacementName}
            </button>
          ) : (
            <span style={{ fontWeight: 600, color: t.textPrimary }} title={replacementPath ? undefined : 'This saved query was not found in the project'}>
              {replacementName}
            </span>
          )}
        </>
      ) : null}
      {deprecatedOn ? <span style={{ color: t.textMuted }}>{replacementName ? '· ' : ''}retired {deprecatedOn}</span> : null}
    </span>
  );
}

/** "Open the replacement" — the primary way out of a retired block in Block Studio. */
export function OpenReplacementButton({
  info,
  t,
  onOpen,
}: {
  info: BlockRetirementInfo | null | undefined;
  t: Theme;
  onOpen: (path: string) => void;
}) {
  const summary = blockRetirementSummary(info);
  if (!summary?.replacementPath) return null;
  const path = summary.replacementPath;
  return (
    <button
      type="button"
      onClick={() => onOpen(path)}
      title={`Open ${summary.replacementName}`}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 32, padding: '0 12px', borderRadius: 8, border: `1px solid ${t.btnBorder}`, background: t.btnBg, color: t.accent, fontSize: 12.5, fontWeight: 650, cursor: 'pointer', fontFamily: t.font }}
    >
      Open the replacement <ArrowRight size={13} strokeWidth={1.75} />
    </button>
  );
}
