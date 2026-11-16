import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { readableColumnLabel, readablePhrase } from './column-label';
import { TableOutput } from '../components/output/TableOutput';

// V12: the Ask grid showed "PLAYOFF_POINTS_2016" and "COUNT(DISTINCT PLAYER_ID)" as headers.
describe('result column names in words', () => {
  it('turns SQL names into words and keeps a name that already is words', () => {
    expect(readableColumnLabel('PLAYOFF_POINTS_2016')).toBe('Playoff points 2016');
    expect(readableColumnLabel('TOTAL_POINTS')).toBe('Total points');
    expect(readableColumnLabel('GAME_ID')).toBe('Game ID');
    expect(readableColumnLabel('COUNT(DISTINCT PLAYER_ID)')).toBe('Distinct player ID count');
    expect(readableColumnLabel('COUNT(*)')).toBe('Row count');
    expect(readableColumnLabel('SUM(t.PTS)')).toBe('Total pts');
    expect(readableColumnLabel('totalPoints')).toBe('Total points');
    expect(readableColumnLabel('Total points')).toBe('Total points');
  });

  it('shows words in an Ask table, keeps the raw name in the tooltip, and leaves notebook tables as they are', () => {
    const result = { columns: ['PLAYOFF_POINTS_2016'], rows: [{ PLAYOFF_POINTS_2016: 591 }], rowCount: 1 } as never;
    const ask = renderToStaticMarkup(createElement(TableOutput, { result, themeMode: 'light', readableHeaders: true }));
    expect(ask).toContain('>Playoff points 2016<');
    expect(ask).toContain('title="PLAYOFF_POINTS_2016"');
    const notebook = renderToStaticMarkup(createElement(TableOutput, { result, themeMode: 'light' }));
    expect(notebook).toContain('>PLAYOFF_POINTS_2016<');
  });
});

// V4 tester: Ask's clarification choices read "TOTAL POINTS", "SEASON 2003–2022" and "game_count by SEASON".
describe('column names inside a short phrase, in words', () => {
  it('reads the column names and keeps every other word, number and dash', () => {
    expect(readablePhrase('TOTAL POINTS')).toBe('Total points');
    expect(readablePhrase('SEASON 2003–2022')).toBe('Season 2003–2022');
    expect(readablePhrase('game_count by SEASON')).toBe('Game count by season');
    expect(readablePhrase('TOTAL_POINTS')).toBe('Total points');
    expect(readablePhrase('PLAYER_ID')).toBe('Player ID');
    expect(readablePhrase('sum of TOTAL_POINTS')).toBe('sum of total points');
  });

  it('leaves words, names and short capitals as written', () => {
    for (const text of ['Total points', 'Points for NBA teams', 'Los Angeles Lakers', 'GDP growth', 'Q4 2016', '']) {
      expect(readablePhrase(text)).toBe(text);
    }
  });
});
