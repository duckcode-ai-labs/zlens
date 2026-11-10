import { describe, expect, it } from 'vitest';
import { sqlAnswerArtifact } from './dql-artifacts.js';

const descriptionOf = (source: string) => source.match(/description = "([^"]*)"/)?.[1] ?? '';

describe('an AI-written answer as a draft saved query', () => {
  it('cuts its description at a sentence end or a word, never mid-word (V9)', () => {
    const reading = 'Golden State Warriors points per game in the 2016 season, regular season beside playoffs, from the team game facts. '
      + 'Each game type is told apart by its game id: playoff games are the ids that start with 4, and this answer reads them.';
    expect(reading.length).toBeGreaterThan(200);
    expect(descriptionOf(sqlAnswerArtifact('SELECT 1', reading).source))
      .toBe('Golden State Warriors points per game in the 2016 season, regular season beside playoffs, from the team game facts.');
    // One long sentence: cut after a whole word, with an ellipsis.
    const long = descriptionOf(sqlAnswerArtifact('SELECT 1', `Points ${'per game '.repeat(40)}`).source);
    expect(long).toMatch(/ game…$|per…$/);
    expect(long.length).toBeLessThanOrEqual(201);
  });
});
