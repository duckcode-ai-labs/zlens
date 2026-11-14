import type { SemanticDimension, SemanticMetric } from '../../store/types';

export interface ProjectPrompt { label: string; prompt: string }

const plain = (value: string) => value.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
const nameOf = (item: { label?: string; name: string }) => plain(item.label || item.name);
const lower = (value: string) => (value.length > 1 && value[1] === value[1].toLowerCase() ? value[0].toLowerCase() + value.slice(1) : value);

/**
 * Example questions from this project's own metrics, so an empty Ask shows
 * what the project can answer ("What is claims paid?", "Claims paid by
 * region", "How has claims paid changed over time?"). Empty when the project
 * has no metrics; callers fall back to general examples.
 */
export function projectExamplePrompts(metrics: SemanticMetric[], dimensions: SemanticDimension[], timeDimensions: SemanticDimension[], limit = 4): ProjectPrompt[] {
  const usable = metrics.filter((metric) => metric.name && !/^_/.test(metric.name));
  if (!usable.length) return [];
  const out: ProjectPrompt[] = [];
  const add = (text: string) => { if (out.length < limit && !out.some((item) => item.prompt === text)) out.push({ label: text, prompt: text }); };
  const [first, second] = usable;
  add(`What is ${lower(nameOf(first))}?`);
  const dimension = dimensions.find((item) => !timeDimensions.some((time) => time.name === item.name));
  if (dimension) add(`${nameOf(first)} by ${lower(nameOf(dimension))}`);
  if (timeDimensions.length) add(`How has ${lower(nameOf(second ?? first))} changed over time?`);
  if (second) add(`What is ${lower(nameOf(second))}?`);
  for (const metric of usable.slice(2)) add(`What is ${lower(nameOf(metric))}?`);
  return out;
}

/** A saved query as the library lists it. */
export interface LibraryQuery { name: string; status: string; description?: string; domain?: string }

/** A saved query's name in words: `warriors_ppg_regular_vs_playoffs_2016` → "Warriors ppg regular vs playoffs 2016". */
function queryWords(name: string): string {
  const text = plain(name.split('/').pop()!.replace(/\.dql$/i, ''));
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/**
 * Example questions from the project's certified saved queries, for a project with no semantic metrics (new-user
 * test V12: Notebook AI on NBA data offered revenue, region, customer and order questions). A description written
 * as a question is asked as written; otherwise the saved query's name is asked, which Ask answers from it.
 */
export function savedQueryPrompts(queries: LibraryQuery[], limit = 4): ProjectPrompt[] {
  const out: ProjectPrompt[] = [];
  for (const query of queries) {
    if (out.length >= limit) break;
    if (query.status !== 'certified' || !query.name) continue;
    const description = query.description?.trim() ?? '';
    const text = description.endsWith('?') && description.length <= 120 ? description : queryWords(query.name);
    if (text && !out.some((item) => item.prompt.toLowerCase() === text.toLowerCase())) out.push({ label: text, prompt: text });
  }
  return out;
}

/** What an empty Ask offers when nothing about the project is known yet: questions about the data, not a sample business. */
export function neutralPrompts(inNotebook: boolean): ProjectPrompt[] {
  return inNotebook
    ? [{ label: 'What does this notebook show?', prompt: 'What does this notebook show?' }, { label: 'What data can I ask about?', prompt: 'What data can I ask about?' }]
    : [{ label: 'What data can I ask about?', prompt: 'What data can I ask about?' }];
}
