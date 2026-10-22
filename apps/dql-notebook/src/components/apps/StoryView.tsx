import type { ReactNode } from 'react';
import { splitStoryText, type StoryBindingCatalog } from '@zlens/core/apps/story-bindings';
import type { DashboardNarrativeV1, StoryEditionV1 } from '../../api/client';
import { NUMBER_RECEIPT_STYLES, ReceiptValue, type NumberReceiptInfo } from './NumberReceipt';

/**
 * A story page (RFC 0008 step 8): prose with every figure bound to a tile
 * result, and the supporting tiles embedded between paragraphs. Values come
 * from the current run's catalog; a binding the run did not return shows as
 * a dash, never an old number.
 */
export function StoryText({ markdown, catalog, receiptFor }: {
  markdown: string;
  catalog: StoryBindingCatalog;
  /** Each bound number explains itself: what it is, its tile, trust and filters (RFC 0009 step 6a). */
  receiptFor?: (key: string) => NumberReceiptInfo | null;
}): JSX.Element {
  const paragraphs = markdown.split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter(Boolean);
  return (
    <>
      {paragraphs.map((paragraph, index) => {
        const heading = /^#{1,3}\s+/.exec(paragraph);
        const body = heading ? paragraph.slice(heading[0].length) : paragraph;
        const content = splitStoryText(body).map((part, partIndex) => {
          if (part.kind === 'text') return <InlineMarkdown key={partIndex} text={part.text} />;
          const binding = catalog[part.key];
          return binding
            ? <ReceiptValue key={partIndex} className="dql-story-value" info={receiptFor?.(part.key) ?? null} fallbackTitle={binding.label}>{binding.display}</ReceiptValue>
            : <span key={partIndex} className="dql-story-value missing" tabIndex={0} title={`{{${part.key}}} is not in this run's results`}>—</span>;
        });
        return heading ? <h3 key={index}>{content}</h3> : <p key={index}>{content}</p>;
      })}
    </>
  );
}

/** Bold and italic only; story text is prose, not a document format. */
function InlineMarkdown({ text }: { text: string }): JSX.Element {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g).filter(Boolean);
  return <>{parts.map((part, index) => (
    part.startsWith('**') ? <strong key={index}>{part.slice(2, -2)}</strong>
      : part.startsWith('*') && part.length > 2 ? <em key={index}>{part.slice(1, -1)}</em>
        : <span key={index}>{part}</span>
  ))}</>;
}

export interface StoryEditionSummary {
  current?: StoryEditionV1;
  previous?: StoryEditionV1;
  changes: Array<{ key: string; label: string; before: string; after: string }>;
}

/**
 * What changed since the last edition in the same filter scope: the bound
 * values this run shows that differ from that edition's.
 */
export function storyEditionSummary(
  editions: StoryEditionV1[],
  run: { runId: string; resultFingerprint: string; filterFingerprint: string; editionScope?: string } | null,
  catalog: StoryBindingCatalog,
): StoryEditionSummary {
  if (!run) return { changes: [] };
  // Editions compare within the page's effective filters. The run's filter
  // fingerprint also changes with how a run was requested, so it is used
  // only by servers that predate the scope.
  const scopeOf = (edition: StoryEditionV1) => edition.scope ?? edition.filterFingerprint;
  const runScope = run.editionScope ?? run.filterFingerprint;
  const scoped = editions
    .filter((edition) => scopeOf(edition) === runScope)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  // Editions are matched by the values the story shows, not by run or
  // result fingerprints, which can differ for the same data.
  const matches = (edition: StoryEditionV1) => Object.entries(edition.values).every(([key, value]) => catalog[key]?.value === value.value);
  const current = scoped.find((edition) => edition.runId === run.runId || matches(edition));
  const previous = scoped.find((edition) => !matches(edition) && (!current || edition.createdAt < current.createdAt));
  const changes = previous
    ? Object.entries(previous.values).flatMap(([key, before]) => {
      const after = catalog[key];
      // Compare values, not formatting, so a display change is not "news".
      return after && after.value !== before.value ? [{ key, label: after.label, before: before.display, after: after.display }] : [];
    })
    : [];
  return { ...(current ? { current } : {}), ...(previous ? { previous } : {}), changes };
}

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

export function StoryView({
  narrative,
  catalog,
  renderTile,
  edition,
  trust,
  receiptFor,
}: {
  narrative: DashboardNarrativeV1;
  catalog: StoryBindingCatalog;
  renderTile: (tileId: string) => ReactNode;
  edition?: StoryEditionSummary | null;
  /** e.g. "All 6 tiles certified". */
  trust?: string | null;
  receiptFor?: (key: string) => NumberReceiptInfo | null;
}): JSX.Element {
  return (
    <article className="dql-story">
      <style>{STORY_STYLES}</style>
      {receiptFor ? <style>{NUMBER_RECEIPT_STYLES}</style> : null}
      {edition !== undefined ? (
        <header className="dql-story-edition" aria-label="Edition">
          <span>{edition?.current ? `Edition of ${when(edition.current.createdAt)}` : 'Current edition'}{trust ? ` · ${trust}` : ''}</span>
          {edition?.previous ? (
            edition.changes.length ? (
              <div className="dql-story-changes">
                <strong>What changed since {when(edition.previous.createdAt)}</strong>
                <ul>
                  {edition.changes.slice(0, 6).map((change) => (
                    <li key={change.key}><span>{change.label}</span> <span className="was">{change.before}</span> → <span className="now">{change.after}</span></li>
                  ))}
                </ul>
              </div>
            ) : <span className="dql-story-quiet">No change in the story’s figures since {when(edition.previous.createdAt)}.</span>
          ) : edition?.current ? <span className="dql-story-quiet">First edition.</span> : null}
        </header>
      ) : null}
      {narrative.blocks.map((block) => (
        block.kind === 'text'
          ? <section key={block.id} className="dql-story-text"><StoryText markdown={block.markdown} catalog={catalog} {...(receiptFor ? { receiptFor } : {})} /></section>
          : <figure key={block.id} className="dql-story-tile">{renderTile(block.tileId)}</figure>
      ))}
      <footer className="dql-story-footer">
        {narrative.generatedBy === 'ai' ? `Drafted with ${narrative.model ?? 'AI'} and checked: every figure is bound to this page's results.` : 'Every figure is bound to this page’s results.'}
      </footer>
    </article>
  );
}

const STORY_STYLES = `
.dql-story { --st-ink: var(--dql-app-ink, var(--text-primary)); --st-muted: var(--dql-app-muted, var(--text-secondary)); --st-line: var(--dql-app-line, var(--border-subtle)); --st-accent: var(--dql-app-accent, var(--accent)); max-width: 760px; margin: 0 auto; display: grid; gap: 18px; color: var(--st-ink); font: 400 16px/1.65 var(--font-ui, inherit); }
.dql-story-edition { display: grid; gap: 8px; padding-bottom: 12px; border-bottom: 1px solid var(--st-line); color: var(--st-muted); font-size: 13px; }
.dql-story-changes strong { display: block; color: var(--st-ink); font-size: 13px; font-weight: 600; margin-bottom: 4px; }
.dql-story-changes ul { margin: 0; padding-left: 18px; display: grid; gap: 2px; }
.dql-story-changes .was { color: var(--st-muted); text-decoration: line-through; }
.dql-story-changes .now { color: var(--st-ink); font-weight: 600; font-variant-numeric: tabular-nums; }
.dql-story-quiet { font-size: 13px; }
.dql-story-text { display: grid; gap: 12px; }
.dql-story-text p { margin: 0; text-wrap: pretty; }
.dql-story-text h3 { margin: 8px 0 0; font: 600 20px/1.3 ui-serif, Georgia, 'Times New Roman', serif; text-wrap: balance; }
.dql-story-value { font-weight: 600; font-variant-numeric: tabular-nums; border-bottom: 1px dotted var(--st-accent); cursor: help; }
.dql-story-value:focus-visible { outline: 2px solid var(--st-accent); outline-offset: 2px; border-radius: 2px; }
.dql-story-value.missing { color: var(--st-muted); border-bottom-style: dashed; }
.dql-story-tile { margin: 0; }
.dql-story-footer { padding-top: 12px; border-top: 1px solid var(--st-line); color: var(--st-muted); font-size: 12px; }
`;
