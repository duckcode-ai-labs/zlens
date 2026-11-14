/**
 * A result column's name as a reader says it. AI-written SQL names its columns in SQL ("PLAYOFF_POINTS_2016",
 * "COUNT(DISTINCT PLAYER_ID)"); an answer's table shows them in words ("Playoff points 2016", "Distinct player
 * ID count") and keeps the raw name for export and the tooltip (new-user test V12).
 */

const ACRONYMS = new Set(['id', 'ids', 'url', 'sku', 'kpi', 'usd', 'eur', 'gbp', 'nba', 'uuid', 'ytd', 'mtd', 'qtd']);

function words(name: string): string[] {
  return name
    .replace(/["`[\]]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase())
    .map((word) => SHORT_WORDS[word] ?? word);
}

/** Short forms a column name uses and a reader does not ("PCT_HOME_TEAM_WINS" reads "Percent home team wins"); the answer text uses the same words. */
const SHORT_WORDS: Record<string, string> = { pct: 'percent', avg: 'average', cnt: 'count', num: 'number', qty: 'quantity' };

function sentence(parts: string[]): string {
  const text = parts.map((word) => (ACRONYMS.has(word) ? word.toUpperCase() : word)).join(' ');
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

const AGGREGATE_WORDS: Record<string, string> = { sum: 'total', avg: 'average', average: 'average', max: 'max', min: 'min', median: 'median' };

/** The column name in words; a name that is already words ("Total points") is kept. */
export function readableColumnLabel(name: string): string {
  const raw = name.trim();
  if (!raw) return name;
  // Already a label: mixed case with spaces and no underscores.
  if (/\s/.test(raw) && !/_/.test(raw) && !/[()]/.test(raw) && /[a-z]/.test(raw)) return raw;
  const call = /^([A-Za-z_]+)\s*\(\s*(distinct\s+)?(.*?)\s*\)$/i.exec(raw);
  if (call) {
    const fn = call[1]!.toLowerCase();
    const inner = call[3]!.trim();
    const innerWords = inner === '*' ? [] : words(inner.split('.').pop() ?? inner);
    if (fn === 'count') {
      if (innerWords.length === 0) return 'Row count';
      return sentence([...(call[2] ? ['distinct'] : []), ...innerWords, 'count']);
    }
    const lead = AGGREGATE_WORDS[fn];
    if (lead && innerWords.length) return sentence([lead, ...innerWords]);
  }
  const parts = words(raw.split('.').pop() ?? raw);
  return parts.length ? sentence(parts) : raw;
}
