import { useEffect, useRef, useState, type ReactNode } from 'react';
import { validateStoryText, type StoryBindingCatalog } from '@zlens/core/apps/story-bindings';
import type { DashboardNarrativeV1 } from '../../../api/client';
import { StoryText } from '../StoryView';

type Block = DashboardNarrativeV1['blocks'][number];

/**
 * Studio's story editor (RFC 0008 step 8). Text can only show figures
 * through `{{bindings}}`: a literal number is flagged as the author types
 * and the block is not saved until it is bound. Values preview from the
 * page's latest run.
 */
export function StoryEditor({
  narrative,
  catalog,
  pageTiles,
  disabled,
  renderTile,
  onChange,
  onDraft,
  drafting,
  draftBlockedReason,
  providerLabel,
}: {
  narrative: DashboardNarrativeV1;
  catalog: StoryBindingCatalog;
  pageTiles: Array<{ tileId: string; title: string }>;
  disabled: boolean;
  renderTile: (tileId: string) => ReactNode;
  onChange: (narrative: DashboardNarrativeV1) => void;
  onDraft: (instruction: string) => void;
  drafting: boolean;
  /** Why drafting is not possible right now, e.g. no complete run. */
  draftBlockedReason?: string | null;
  providerLabel?: string | null;
}): JSX.Element {
  const [blocks, setBlocks] = useState<Block[]>(narrative.blocks);
  const [instruction, setInstruction] = useState('');
  useEffect(() => setBlocks(narrative.blocks), [narrative]);
  const keys = new Set(Object.keys(catalog));
  const options = Object.values(catalog);
  const commit = (next: Block[]) => {
    setBlocks(next);
    const valid = next.every((block) => block.kind !== 'text' || validateStoryText(block.markdown).length === 0);
    if (valid && JSON.stringify(next) !== JSON.stringify(narrative.blocks)) {
      onChange({ ...narrative, blocks: next, generatedBy: 'author' });
    }
  };
  const nextId = () => {
    const taken = new Set(blocks.map((block) => block.id));
    let n = blocks.length + 1;
    while (taken.has(`b${n}`)) n += 1;
    return `b${n}`;
  };
  const move = (index: number, by: number) => {
    const target = index + by;
    if (target < 0 || target >= blocks.length) return;
    const next = [...blocks];
    [next[index], next[target]] = [next[target]!, next[index]!];
    commit(next);
  };
  const embedded = new Set(blocks.flatMap((block) => (block.kind === 'tile' ? [block.tileId] : [])));
  const available = pageTiles.filter((tile) => !embedded.has(tile.tileId));

  return (
    <div className="studio-story-editor">
      <section className="studio-story-draft" aria-label="Draft the report with AI">
        <input
          id="story-draft-instruction"
          aria-label="What should the report focus on?"
          placeholder="Optional: what should the report focus on?"
          value={instruction}
          disabled={disabled || drafting}
          onChange={(event) => setInstruction(event.target.value)}
        />
        <button type="button" className="primary" disabled={disabled || drafting || Boolean(draftBlockedReason)} onClick={() => onDraft(instruction.trim())}>
          {drafting ? 'Drafting…' : blocks.length ? 'Redraft report with AI' : 'Draft report with AI'}
        </button>
        <small className="field-help">
          {draftBlockedReason ?? `${providerLabel ? `${providerLabel} writes` : 'AI writes'} around the page's values; every figure stays bound to the data, and the draft is checked before you see it.`}
        </small>
      </section>
      {blocks.length === 0 ? <p className="studio-story-empty">No report yet. Draft it with AI, or add a paragraph and the tiles it should show.</p> : null}
      {blocks.map((block, index) => (
        <section key={block.id} className={`studio-story-block ${block.kind}`}>
          <header>
            <span>{block.kind === 'text' ? 'Paragraph' : `Tile · ${pageTiles.find((tile) => tile.tileId === block.tileId)?.title ?? block.tileId}`}</span>
            <span className="studio-story-block-tools">
              <button type="button" aria-label="Move up" disabled={disabled || index === 0} onClick={() => move(index, -1)}>↑</button>
              <button type="button" aria-label="Move down" disabled={disabled || index === blocks.length - 1} onClick={() => move(index, 1)}>↓</button>
              <button type="button" aria-label="Remove from report" disabled={disabled} onClick={() => commit(blocks.filter((_, i) => i !== index))}>✕</button>
            </span>
          </header>
          {block.kind === 'text'
            ? <TextBlock block={block} keys={keys} options={options} catalog={catalog} disabled={disabled} onCommit={(markdown) => commit(blocks.map((entry, i) => (i === index ? { ...block, markdown } : entry)))} />
            : <div className="studio-story-tile">{renderTile(block.tileId)}</div>}
        </section>
      ))}
      <div className="studio-story-add">
        <button type="button" disabled={disabled} onClick={() => setBlocks([...blocks, { id: nextId(), kind: 'text', markdown: '' }])}>Add paragraph</button>
        <select
          aria-label="Add a tile to the report"
          disabled={disabled || available.length === 0}
          value=""
          onChange={(event) => { if (event.target.value) commit([...blocks, { id: nextId(), kind: 'tile', tileId: event.target.value }]); }}
        >
          <option value="">{available.length ? 'Add a tile…' : 'Every tile is in the report'}</option>
          {available.map((tile) => <option key={tile.tileId} value={tile.tileId}>{tile.title}</option>)}
        </select>
      </div>
    </div>
  );
}

function TextBlock({ block, keys, options, catalog, disabled, onCommit }: {
  block: Extract<Block, { kind: 'text' }>;
  keys: ReadonlySet<string>;
  options: StoryBindingCatalog[string][];
  catalog: StoryBindingCatalog;
  disabled: boolean;
  onCommit: (markdown: string) => void;
}): JSX.Element {
  const [text, setText] = useState(block.markdown);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setText(block.markdown), [block.markdown]);
  const issues = validateStoryText(text, keys);
  const blocking = issues.filter((issue) => issue.code !== 'UNKNOWN_BINDING');
  const insert = (key: string) => {
    const node = ref.current;
    const at = node ? node.selectionStart : text.length;
    const next = `${text.slice(0, at)}{{${key}}}${text.slice(at)}`;
    setText(next);
    if (validateStoryText(next).length === 0) onCommit(next);
  };
  return (
    <div className="studio-story-text">
      <textarea
        ref={ref}
        rows={3}
        aria-label="Paragraph"
        disabled={disabled}
        value={text}
        placeholder="Write the paragraph. Insert values instead of typing numbers."
        onChange={(event) => setText(event.target.value)}
        onBlur={() => { if (text !== block.markdown && blocking.length === 0) onCommit(text); }}
      />
      <div className="studio-story-text-tools">
        <select aria-label="Insert a value" disabled={disabled || options.length === 0} value="" onChange={(event) => { if (event.target.value) insert(event.target.value); }}>
          <option value="">{options.length ? 'Insert a value…' : 'Run the page to see its values'}</option>
          {options.map((binding) => <option key={binding.key} value={binding.key}>{binding.label} ({binding.display})</option>)}
        </select>
      </div>
      {issues.length ? (
        <ul className="studio-story-issues" role="alert">
          {issues.slice(0, 5).map((issue, index) => <li key={index} className={issue.code === 'UNKNOWN_BINDING' ? 'warn' : ''}>{issue.code === 'UNKNOWN_BINDING' ? `${issue.message} It shows as a dash until the page returns it.` : issue.message}</li>)}
        </ul>
      ) : null}
      {text.trim() ? <div className="studio-story-preview" aria-label="Preview"><StoryText markdown={text} catalog={catalog} /></div> : null}
    </div>
  );
}
