import { describe, expect, it } from 'vitest';
import {
  namedInRequest,
  namedInRequestFirst,
  namedYears,
  questionGroundedInRequest,
  readableSourceTitle,
  sourceAnswersQuestion,
  sourceEvidenceAnswersQuestion,
  subjectWords,
} from './app-builder-source-match.js';
import type { AppSourceCatalogRecord } from './app-source-catalog.js';

/** A certified saved query as the App source catalog lists it: its name, description and result columns. */
function savedQuery(name: string, description: string, outputs: string[], trust: 'certified' | 'review_required' = 'certified') {
  return {
    name,
    title: name,
    description,
    trust,
    capabilities: { measures: [], dimensions: [], filters: [], outputs, allowedVisualizations: [], parameters: [] },
  } as unknown as AppSourceCatalogRecord;
}

// The tester's certified saved queries (V13 retest, report section 3).
const ppg = savedQuery('warriors_ppg_regular_vs_playoffs_2016', 'Golden State Warriors points per game in 2016, regular season vs playoffs, side by side.', ['GAME_TYPE', 'POINTS_PER_GAME']);
const winsByYear = savedQuery('warriors_regular_season_wins_2014_2018', 'Golden State Warriors regular-season wins per season, 2014-2018 (regular season games only).', ['SEASON', 'WINS']);
const wins2016 = savedQuery('warriors_regular_season_wins_2016', 'Golden State Warriors wins in the 2016 regular season (regular-season games only).', ['WINS']);
const lakers = savedQuery('who_were_the_lakers_top_3_rebounders_in_the_2009', 'Lakers top 3 rebounders in the 2009 regular season (games played).', ['PLAYER_ID', 'PLAYER_NAME', 'TOTAL_REBOUNDS']);

describe('a source\'s own words against a question (V13 retest, Describe with AI)', () => {
  it('reads the words that name a subject, one word for each way a number is said', () => {
    expect(Array.from(subjectWords('Compare how the Golden State Warriors scored per game')).sort()).toEqual(['game', 'golden', 'point', 'state', 'warrior']);
    expect(Array.from(subjectWords('warriors_ppg_regular_vs_playoffs_2016')).sort()).toEqual(['2016', 'game', 'playoff', 'point', 'regular', 'warrior']);
    // "top 3" says how many to show; "rebounders" are rebounds.
    expect(Array.from(subjectWords('Lakers top 3 rebounders')).sort()).toEqual(['laker', 'rebound']);
    expect(namedYears('wins from 2014-2018, and 2016')).toEqual([2014, 2016, 2018]);
  });

  it('finds the certified saved query that answers a question exactly, for exactly its years', () => {
    expect(sourceAnswersQuestion('Compare how the Golden State Warriors scored per game in the 2016 regular season and in the 2016 playoffs', ppg)).toBe('exact');
    expect(sourceAnswersQuestion("What were the Warriors' regular-season wins each season from 2014 to 2018?", winsByYear)).toBe('exact');
    expect(sourceAnswersQuestion('Who led the Los Angeles Lakers in rebounds in the 2009 season?', lakers)).toBe('near');
    // Another year, another number, or a request about something else: no match.
    expect(sourceAnswersQuestion("What were the Warriors' regular-season wins each season from 2014 to 2018?", wins2016)).toBeUndefined();
    expect(sourceAnswersQuestion("What was the Warriors' points per game in 2016, regular season vs playoffs?", wins2016)).toBeUndefined();
    expect(sourceAnswersQuestion('Show the top scorers in the 2016 playoffs and how many points each one scored', ppg)).toBeUndefined();
  });

  it('lets a pick answer a question its own words answer, unless the question names years or a window it lacks', () => {
    expect(sourceEvidenceAnswersQuestion('How did the Golden State Warriors perform in each season?', winsByYear)).toBe(true);
    expect(sourceEvidenceAnswersQuestion('How did the Golden State Warriors perform in 2016?', winsByYear)).toBe(true);
    expect(sourceEvidenceAnswersQuestion('How did the Golden State Warriors perform in 2020?', winsByYear)).toBe(false);
    expect(sourceEvidenceAnswersQuestion('Warriors wins over the last 30 days', winsByYear)).toBe(false);
    // The tile's own fields and their period count: "monthly revenue" by order_date at month.
    const orders = savedQuery('orders', 'Orders', ['ORDER_DATE', 'REVENUE']);
    expect(sourceEvidenceAnswersQuestion('Monthly revenue', orders)).toBe(false);
    expect(sourceEvidenceAnswersQuestion('Monthly revenue', orders, ['REVENUE', 'ORDER_DATE', 'month'])).toBe(true);
    expect(sourceEvidenceAnswersQuestion('Profit margin', orders)).toBe(false);
  });

  it('tells a question the planner made up from the person\'s own', () => {
    const request = 'Show the top scorers in the 2016 playoffs and how many points each one scored';
    expect(questionGroundedInRequest("What was the Golden State Warriors' points per game in the 2016 playoffs?", request)).toBe(false);
    expect(questionGroundedInRequest('Who were the top scorers in the 2016 playoffs?', request)).toBe(true);
    // A name the request gives more briefly still counts ("Warriors" for "the Golden State Warriors").
    expect(questionGroundedInRequest('How did the Golden State Warriors do in each season?', 'Help a Warriors fan see how they did')).toBe(true);
    expect(questionGroundedInRequest('Who led the Los Angeles Lakers in rebounds?', 'show lakers rebounds')).toBe(true);
  });

  it('puts certified data whose name the request names first, and reads a saved query name as a title', () => {
    const request = "Give a coach one page with the Warriors' regular-season wins from 2014 to 2018 and their 2016 points per game in the regular season and the playoffs";
    const tables = [savedQuery('local_team_game_facts', 'Team game facts', ['SEASON', 'WINS'], 'review_required'), lakers, wins2016];
    // "Warriors regular-season wins 2016" is named too (every word of it is in the request), after the names that say more.
    expect(namedInRequestFirst(request, [...tables, ppg, winsByYear]).map((candidate) => candidate.name).slice(0, 3)).toEqual([ppg.name, winsByYear.name, wins2016.name]);
    expect(namedInRequest('Compare how the Golden State Warriors scored per game in the 2016 regular season and in the 2016 playoffs', wins2016)).toBe(false);
    expect(namedInRequest('Show who led the Los Angeles Lakers in rebounds in the 2009 season', lakers)).toBe(true);
    expect(readableSourceTitle('warriors_ppg_regular_vs_playoffs_2016')).toBe('Warriors PPG Regular vs Playoffs 2016');
    expect(readableSourceTitle('Team Wins By Season')).toBe('Team Wins By Season');
  });
});
