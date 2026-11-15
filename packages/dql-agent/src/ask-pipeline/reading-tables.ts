/**
 * A READING NAMES ONLY THE TABLES THE ANSWER READ, OR NONE.
 *
 * The AI reads the question before the SQL is written, and its reading sometimes names a table the final SQL
 * did not use: "per the player season facts" above a Source line that names LOCAL_PLAYER_GAME_FACTS, "based on the
 * team-season win totals" over LOCAL_TEAM_GAME_FACTS (new-user test V13, K3 and the Raptors). A reader then cannot
 * tell which table the figures came from. The clause that names another table is taken out of the reading; the
 * Source line says which tables were read.
 *
 * The reading is the model's text, so nothing here backtracks: spaces are made single first, every pattern starts
 * at a word, and the clause around a mention is found word by word.
 */

const PREFIX = /^(?:local|dim|dimension|fct|fact|facts|src|source|raw|int|stg|staging|mart|vw|v|tbl|t)_/i;
/** A word that says a phrase names a table, not a thing: "the player season facts", "his player-season records". */
const TABLE_NOUN = '(?:facts?|tables?|records?|totals?|data|relations?|datasets?|views?|dimensions?|stats|statistics|summary|summaries|rows|entries|model)';
/** Words that end a table's name without naming what it holds. */
const TRAILING = /^(?:facts?|fct|table|data|stats|details|records?|cleansed|clean|totals?|summary|view|dim)$/i;
/** Words that lead into a clause naming where the figures come from, one or two words long. */
const PREPOSITIONS = new Set(['per', 'from', 'in', 'using', 'via', 'with', 'of', 'by', 'on', 'based on', 'according to', 'out of']);
const DETERMINERS = new Set(['the', 'his', 'her', 'their', 'its', 'a', 'an', 'each', 'this', 'that']);

const bare = (relation: string) => (relation.split('.').pop() ?? relation).replace(/["`[\]]/g, '').trim();

/** The words a reading uses for a table: LOCAL_PLAYER_SEASON_FACTS is "player season (facts)". */
export function tableWords(relation: string): string[] {
  let name = bare(relation).toLowerCase();
  for (let index = 0; index < 2 && PREFIX.test(name); index += 1) name = name.replace(PREFIX, '');
  const words = name.split(/[_\s-]+/).filter(Boolean);
  while (words.length > 1 && TRAILING.test(words[words.length - 1]!)) words.pop();
  return words;
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A pattern for a table's mention: its words ("player season", "player-season") followed by a table noun. */
function mentionPattern(relation: string): string | undefined {
  const words = tableWords(relation);
  if (words.length === 0) return undefined;
  const core = words.map((word, index) => (index === words.length - 1 ? `${escape(word.replace(/s$/, ''))}s?` : escape(word))).join('[ _-]');
  // One word ("games") names a table only as "the games table" or "the games relation": "season totals" is a
  // phrase about seasons, not the seasons table. Two or more words may have one word before the noun.
  return words.length === 1
    ? `\\b(?:the|a) ${core} (?:tables?|relations?|datasets?|views?|dimensions?)\\b`
    : `\\b${core}(?: [\\w-]+)? ${TABLE_NOUN}\\b`;
}

/**
 * The reading without the clauses that name a table the answer did not read. `used` are the tables the final SQL
 * read; `known` every table the project lists. A table's own physical name counts as a mention too. A mention
 * that cannot be taken out as a clause is replaced by "the data", so no other table is named.
 */
export function readingWithoutOtherTables(reading: string, used: string[], known: string[]): string {
  // Without the tables the answer read there is nothing to hold the reading to.
  if (used.length === 0) return reading;
  const usedNames = new Set(used.map((relation) => bare(relation).toLowerCase()));
  const usedPatterns = used.map(mentionPattern).filter((pattern): pattern is string => Boolean(pattern));
  const others = [...new Set(known.map(bare).filter((name) => name && !usedNames.has(name.toLowerCase())))];
  let text = reading.replace(/\s+/g, ' ').trim();
  let changed = false;
  for (const other of others) {
    // A physical name is matched as written only when it reads as one (LOCAL_TEAM_SEASON_FACTS): a table named
    // "players" or "games" is an ordinary word in a reading ("Rank players by points across all games").
    const patterns = /_/.test(other) ? [`\\b${escape(other)}\\b`] : [];
    const words = mentionPattern(other);
    // A phrase a table the answer DID read also answers to ("player game" for both) is not another table's.
    if (words && !usedPatterns.some((pattern) => new RegExp(pattern, 'i').test(`${tableWords(other).join(' ')} facts`))) patterns.push(words);
    for (const pattern of patterns) {
      for (let guard = 0; guard < 4; guard += 1) {
        const mention = new RegExp(pattern, 'i').exec(text);
        if (!mention) break;
        text = withoutClause(text, mention.index, mention.index + mention[0].length);
        changed = true;
      }
    }
  }
  return changed ? tidy(text) : reading;
}

/** Take out the clause holding text[start, end): its parentheses, or the phrase that leads into it, or the mention. */
function withoutClause(text: string, start: number, end: number): string {
  // Inside parentheses: the whole parenthetical goes.
  const open = text.lastIndexOf('(', start);
  const close = text.indexOf(')', end);
  if (open >= 0 && close >= 0 && !text.slice(open + 1, start).includes(')') && !text.slice(end, close).includes('(')) {
    return `${text.slice(0, open).trimEnd()}${text.slice(close + 1)}`;
  }
  // Word by word back from the mention: a determiner ("the"), then a preposition ("per", "based on"), then the
  // comma that opens the clause: ", per the player season facts", "from his player-season records".
  const words = text.slice(0, start).trimEnd().split(' ');
  const word = (back: number) => (words[words.length - 1 - back] ?? '').toLowerCase();
  const taken = DETERMINERS.has(word(0)) ? 1 : 0;
  const lead = words.length >= 2 + taken && PREPOSITIONS.has(`${word(taken + 1)} ${word(taken)}`) ? 2 : PREPOSITIONS.has(word(taken)) ? 1 : 0;
  if (lead > 0) {
    let kept = words.slice(0, words.length - taken - lead).join(' ');
    if (kept && ',;:'.includes(kept.charAt(kept.length - 1))) kept = kept.slice(0, -1);
    // The clause runs on to the next comma, semicolon or full stop.
    const rest = text.slice(end);
    let stop = 0;
    while (stop < rest.length && !',;.?!'.includes(rest.charAt(stop))) stop += 1;
    return `${kept}${rest.slice(stop)}`;
  }
  // Anything else: the table is not named, the sentence stays whole.
  const kept = taken ? words.slice(0, -1).join(' ') : text.slice(0, start).trimEnd();
  return `${kept}${kept ? ' ' : ''}the data${text.slice(end)}`;
}

/** Spacing and punctuation after a clause came out, on text whose spaces are already single. */
function tidy(text: string): string {
  return text
    .replace(/\( ?\)/g, '')
    .replace(/ ([,.;:?!])/g, '$1')
    .replace(/([,;:]) ?([.?!])/g, '$2')
    .replace(/, ?,/g, ',')
    .replace(/ {2,}/g, ' ')
    .trim();
}
