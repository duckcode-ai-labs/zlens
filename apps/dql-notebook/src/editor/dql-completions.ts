/**
 * DQL block-DSL autocompletion (IDE-style) for Block Studio.
 *
 * Block Studio edits the full `.dql` source — block metadata fields plus the
 * embedded `query = """ ... """` SQL. This source powers field-name, enum-value,
 * and snippet completion for the METADATA part so authoring a block feels like a
 * real IDE: type `pat` → `pattern`, `chart = "` → bar/line/area…, `pattern = "` →
 * the official block patterns. Inside the `query` body it returns null so the
 * SQL schema/keyword completion (tables + columns) takes over instead.
 */

import type { Completion, CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete';

/** Canonical block field set the parser accepts, with one-line hints. */
const BLOCK_FIELDS: Array<{ name: string; detail: string; snippet?: string }> = [
  { name: 'domain', detail: 'business domain (namespace)' },
  { name: 'owner', detail: 'accountable owner — required to certify' },
  { name: 'description', detail: 'business-facing description' },
  { name: 'status', detail: 'draft | certified' },
  { name: 'pattern', detail: 'reusable block pattern' },
  { name: 'grain', detail: 'row grain, e.g. "one row per customer"' },
  { name: 'outputs', detail: 'declared output column names' },
  { name: 'entities', detail: 'business entities, e.g. ["order"]' },
  { name: 'tags', detail: 'discoverability tags' },
  { name: 'llmContext', detail: 'when an agent should use this block' },
  { name: 'reviewCadence', detail: 'how often to re-review' },
  { name: 'sourceSystems', detail: 'upstream source systems' },
  { name: 'dimensions', detail: 'queryable dimensions' },
  { name: 'allowedFilters', detail: 'filters an app may bind' },
  { name: 'filterBindings', detail: 'filter → column map (app-ready)', snippet: 'filterBindings {\n    $0\n  }' },
  { name: 'parameterPolicy', detail: 'per-parameter reuse policy', snippet: 'parameterPolicy {\n    $0\n  }' },
  { name: 'identifiers', detail: 'identifier columns' },
  { name: 'synonyms', detail: 'alternate names' },
  { name: 'primaryTerms', detail: 'business terms (free text)' },
  { name: 'replacementFor', detail: 'block this supersedes' },
  { name: 'boundedContext', detail: 'bounded context' },
  { name: 'businessOwner', detail: 'business (non-technical) owner' },
  { name: 'businessOutcome', detail: 'outcome this supports' },
  { name: 'businessRules', detail: 'business rules / caveats' },
  { name: 'decisionUse', detail: 'decision this informs' },
  { name: 'caveats', detail: 'known caveats' },
  { name: 'invariants', detail: 'assertions that must hold' },
  { name: 'chart', detail: 'default visualization', snippet: 'chart = "bar"' },
  { name: 'examples', detail: 'example questions block', snippet: 'examples = [\n    { question = "$0" }\n  ]' },
  { name: 'parameters', detail: 'parameters block', snippet: 'parameters {\n    $0\n  }' },
  { name: 'tests', detail: 'test assertions block', snippet: 'tests {\n    assert $0\n  }' },
  { name: 'query', detail: 'the SQL body', snippet: 'query = """\n    $0\n  """' },
];

/** Enum value domains keyed by the field that precedes `= "`. */
const ENUM_VALUES: Record<string, string[]> = {
  chart: ['bar', 'line', 'area', 'column', 'combo', 'pie', 'donut', 'scatter', 'histogram', 'heatmap', 'number', 'single_value', 'table'],
  viz: ['bar', 'line', 'area', 'column', 'combo', 'pie', 'donut', 'scatter', 'histogram', 'heatmap', 'number', 'single_value', 'table'],
  type: ['bar', 'line', 'area', 'column', 'combo', 'pie', 'donut', 'scatter', 'histogram', 'heatmap', 'number', 'single_value', 'table'],
  pattern: ['metric_wrapper', 'entity_profile', 'entity_rollup', 'ranking', 'trend', 'bridge', 'drilldown', 'replacement', 'custom'],
  reviewCadence: ['daily', 'weekly', 'monthly', 'quarterly', 'annually'],
  status: ['draft', 'certified'],
  type_block: ['custom', 'semantic'],
};

/**
 * Whether the cursor sits inside the triple-quoted `query` body. We count `"""`
 * fences before the cursor — an odd count means we're inside a SQL string, where
 * DSL completion should stand down and let SQL schema/keyword completion run.
 */
function insideQueryBody(before: string): boolean {
  const fences = (before.match(/"""/g) ?? []).length;
  return fences % 2 === 1;
}

function fieldCompletion(field: { name: string; detail: string; snippet?: string }): Completion {
  return {
    label: field.name,
    type: 'property',
    detail: field.detail,
    apply: field.snippet
      ? applySnippetFactory(field.snippet)
      : `${field.name} = `,
  };
}

/** Minimal snippet application: `$0` marks the final cursor; other text inserted literally. */
function applySnippetFactory(template: string) {
  return (view: import('@codemirror/view').EditorView, _c: Completion, from: number, to: number) => {
    const cursorMark = template.indexOf('$0');
    const text = template.replace('$0', '');
    const anchor = cursorMark >= 0 ? from + cursorMark : from + text.length;
    view.dispatch({ changes: { from, to, insert: text }, selection: { anchor } });
  };
}

export const dqlBlockCompletionSource: CompletionSource = (context: CompletionContext): CompletionResult | null => {
  const line = context.state.doc.lineAt(context.pos);
  const before = context.state.sliceDoc(0, context.pos);
  const lineBefore = before.slice(line.from);

  // Inside the SQL query body — defer to SQL schema/keyword completion.
  if (insideQueryBody(before)) return null;

  // Enum value: `<field> = "<partial>`  → suggest the field's allowed values.
  const enumMatch = /([a-zA-Z_]+)\s*=\s*"([^"]*)$/.exec(lineBefore);
  if (enumMatch) {
    const values = ENUM_VALUES[enumMatch[1]];
    if (values) {
      const from = context.pos - enumMatch[2].length;
      const query = enumMatch[2].toLowerCase();
      return {
        from,
        options: values
          .filter((v) => !query || v.toLowerCase().includes(query))
          .map((v) => ({ label: v, type: 'enum' })),
        validFor: /^[\w-]*$/,
      };
    }
    return null;
  }

  // Field name: a bare word at the start of a line (whitespace + word only, so we
  // never fire on the right-hand side of `=` or inside an expression).
  const word = context.matchBefore(/[a-zA-Z_]+/);
  if (word && /^\s*[a-zA-Z_]+$/.test(lineBefore)) {
    const query = word.text.toLowerCase();
    return {
      from: word.from,
      options: BLOCK_FIELDS
        .filter((f) => f.name.toLowerCase().startsWith(query) || f.name.toLowerCase().includes(query))
        .map(fieldCompletion),
      validFor: /^[a-zA-Z_]*$/,
    };
  }

  // Explicit invoke (Ctrl-Space) on an empty line inside the block → all fields.
  if (context.explicit && /^\s*$/.test(lineBefore)) {
    return { from: context.pos, options: BLOCK_FIELDS.map(fieldCompletion) };
  }
  return null;
};
