import { describe, expect, it } from 'vitest';
import { withoutDrafterCap, aggregatesRows, appliedConditions, groupedColumns, joinKeyGroups, joinKeyPairs, questionProper, mentionsColumn, missingRequiredFilters, missingStatedValues, namePartsMatchedByOr, requiredFilterFromText, statedValues, withRowGuard, aggregatesColumnOf } from './sql-checks.js';

describe('the checks an AI-drafted statement passes before it runs', () => {
  const office = 'Lost opportunities count ,Lost Amount by month for fiscal year FY26 and competitor involved is Splunk';

  it('reads the values a question states: a fiscal year and a name, never its analytic words', () => {
    expect(statedValues(office)).toEqual([{ value: 'FY26', kind: 'fiscal_year' }, { value: 'Splunk', kind: 'text' }]);
    expect(statedValues('What share of orders were placed on a weekend in 2017?')).toEqual([{ value: '2017', kind: 'year' }]);
    expect(statedValues('Top customers by "beverage" revenue in Q2')).toEqual([{ value: 'Q2', kind: 'quarter' }, { value: 'beverage', kind: 'text' }]);
    // A flag value the reading chose is not a value the question stated: the
    // statement may apply it as a join or `= 1`. A text literal still counts.
    const reading = { filters: [{ ref: 'dimension:orders.has_refund', op: 'eq', values: ['true'] }, { ref: 'dimension:orders.status', op: 'eq', values: ['shipped'] }], measures: [], unresolved: [] } as unknown as Parameters<typeof statedValues>[1];
    expect(statedValues('What is the average order size of refunded orders?', reading)).toEqual([{ value: 'shipped', kind: 'text' }]);
    expect(statedValues('how many opportunities did we lose to splunk', { version: 1, kind: 'analytics', reading: 'x', measures: [], groupBy: [], display: [], filters: [{ ref: 'column:a.b.c', op: 'eq', values: ['Splunk'], source: 'question' }], unresolved: [], provenance: {}, expectedShape: 'scalar' } as never)).toEqual([{ value: 'Splunk', kind: 'text' }]);
  });

  it('a LIMIT of the size the drafter is told to keep to comes off unless the question asked for it', () => {
    expect(withoutDrafterCap('SELECT id FROM t ORDER BY id\nLIMIT 500;', 500, 'list the invoices')).toBe('SELECT id FROM t ORDER BY id');
    expect(withoutDrafterCap('SELECT id FROM t LIMIT 500', 500, 'top 500 customers')).toBe('SELECT id FROM t LIMIT 500');
    expect(withoutDrafterCap('SELECT id FROM t LIMIT 500', 500, 'the first 500 orders')).toBe('SELECT id FROM t LIMIT 500');
    expect(withoutDrafterCap('SELECT id FROM t LIMIT 100', 500, 'list the invoices')).toBe('SELECT id FROM t LIMIT 100');
    expect(withoutDrafterCap('SELECT id FROM t LIMIT 500 OFFSET 10', 500, 'list the invoices')).toBe('SELECT id FROM t LIMIT 500 OFFSET 10');
    // A number that is not a row count does not keep the cap.
    expect(withoutDrafterCap('SELECT id FROM t LIMIT 500', 500, 'invoices over 500 dollars')).toBe('SELECT id FROM t');
    // T-SQL has no LIMIT: FETCH is left alone, or the guard would add one it can't run.
    expect(withoutDrafterCap('SELECT id FROM t ORDER BY id OFFSET 0 ROWS FETCH NEXT 500 ROWS ONLY', 500, 'list the invoices')).toBe('SELECT id FROM t ORDER BY id OFFSET 0 ROWS FETCH NEXT 500 ROWS ONLY');
    expect(withoutDrafterCap('SELECT id FROM t LIMIT 500', 500, 'show the 500 biggest')).toBe('SELECT id FROM t LIMIT 500');
    // Only the statement's own last LIMIT: a subquery's stays.
    expect(withoutDrafterCap('SELECT * FROM (SELECT id FROM t LIMIT 500) x', 500, 'list')).toBe('SELECT * FROM (SELECT id FROM t LIMIT 500) x');
  });

  it('an instruction word is not a value; every other capitalised word still is', () => {
    expect(statedValues('count customers by state name Return only those fields')).toEqual([]);
    expect(statedValues('count orders marked Return')).toEqual([{ value: 'Return', kind: 'text' }]);
    expect(statedValues('invoices with status Return')).toEqual([{ value: 'Return', kind: 'text' }]);
    expect(statedValues('invoices with status Return or Exchange').map((item) => item.value)).toEqual(['Return', 'Exchange']);
    expect(statedValues('invoices Return last month')).toEqual([{ value: 'Return', kind: 'text' }]);
    for (const question of ['Total excluding Contoso', 'How many Contoso orders', 'orders in the Contoso account', 'pay via Contoso']) {
      expect(statedValues(question).map((item) => item.value), question).toEqual(['Contoso']);
    }
    expect(statedValues('Sales for Acme, Contoso, Fabrikam').map((item) => item.value)).toEqual(['Acme', 'Contoso', 'Fabrikam']);
  });

  it('a statement that leaves a stated value out is caught; a fiscal year stored as its digits or its calendar years passes', () => {
    const stated = statedValues(office);
    expect(missingStatedValues("SELECT COUNT(*) FROM opp WHERE fiscal_year = 2026", stated)).toEqual([{ value: 'Splunk', kind: 'text' }]);
    expect(missingStatedValues("SELECT COUNT(*) FROM opp WHERE fiscal_year = 2026 AND tags ILIKE '%splunk%'", stated)).toEqual([]);
    // A date range that spans a stated year applies it, like the year itself.
    expect(missingStatedValues("SELECT SUM(pts) FROM stats WHERE game_date >= '2016-01-01' AND game_date < '2018-01-01'", [{ value: '2016', kind: 'year' }, { value: '2017', kind: 'year' }])).toEqual([]);
    expect(missingStatedValues("SELECT SUM(pts) FROM stats WHERE game_date >= '2016-01-01' AND game_date <= '2016-12-31'", [{ value: '2017', kind: 'year' }])).toEqual([{ value: '2017', kind: 'year' }]);
    // The two digits the question used, on a fiscal-year field, apply it; the rows decide how it is stored.
    expect(missingStatedValues("SELECT COUNT(*) FROM opp oe WHERE oe.FISCAL_YEAR = 26 AND LOWER(tags) LIKE '%splunk%'", stated)).toEqual([]);
    expect(missingStatedValues("SELECT COUNT(*) FROM opp WHERE amount = 26 AND LOWER(tags) LIKE '%splunk%'", stated)).toEqual([{ value: 'FY26', kind: 'fiscal_year' }]);
    expect(missingStatedValues("SELECT COUNT(*) FROM opp WHERE close_date >= '2025-02-01' AND competitor_c = 'Splunk'", stated)).toEqual([]);
  });

  it('finds a stated name matched by either of its parts, on one table (V12 gate, G3)', () => {
    const stated = statedValues('How many preseason games did the Los Angeles Lakers play in 2019?');
    const either = "SELECT COUNT(*) FROM nba.games t JOIN nba.dim_teams d ON t.team_id = d.team_id WHERE t.season = 2019 AND (d.TEAM_NICKNAME ILIKE '%Lakers%' OR d.CITY ILIKE '%Los Angeles%')";
    expect(namePartsMatchedByOr(either, stated)).toEqual([{ name: 'Los Angeles Lakers', parts: ['Lakers', 'Los Angeles'], conditions: ["TEAM_NICKNAME ILIKE '%Lakers%'", "CITY ILIKE '%Los Angeles%'"], relation: 'nba.dim_teams', text: "d.TEAM_NICKNAME ILIKE '%Lakers%' OR d.CITY ILIKE '%Los Angeles%'" }]);
    expect(namePartsMatchedByOr("SELECT COUNT(*) FROM nba.teams WHERE nickname LIKE '%Lakers%' OR city LIKE '%Los Angeles%'", stated)[0]?.relation).toBe('nba.teams');
    // Both parts required, two different names, or two tables: nothing to ask.
    expect(namePartsMatchedByOr(either.replace(' OR ', ' AND '), stated)).toEqual([]);
    expect(namePartsMatchedByOr("SELECT 1 FROM t WHERE name ILIKE '%Lakers%' OR name ILIKE '%Celtics%'", stated)).toEqual([]);
    expect(namePartsMatchedByOr("SELECT 1 FROM a JOIN b ON a.id = b.id WHERE a.nick ILIKE '%Lakers%' OR b.city ILIKE '%Los Angeles%'", stated)).toEqual([]);
  });

  it('reads a required filter and catches a statement that does not apply it', () => {
    const required = [requiredFilterFromText('is_test = false')!, requiredFilterFromText("region in ('EMEA', 'APAC')")!];
    expect(required[1]).toEqual({ text: "region in ('EMEA', 'APAC')", column: 'region', values: ['EMEA', 'APAC'] });
    expect(missingRequiredFilters('SELECT 1 FROM t WHERE is_test = false AND region IN (\'EMEA\', \'APAC\')', required)).toEqual([]);
    expect(missingRequiredFilters('SELECT 1 FROM t WHERE region IN (\'EMEA\')', required).map((item) => item.text)).toEqual(['is_test = false', "region in ('EMEA', 'APAC')"]);
    expect(missingRequiredFilters('SELECT 1 FROM t WHERE NOT is_test AND region in (\'emea\',\'apac\')', required)).toEqual([]);
  });

  it('says what a statement filters on, in its own words', () => {
    expect(appliedConditions("SELECT COUNT(*) FROM opp WHERE is_won = false AND tags ILIKE '%splunk%' GROUP BY 1 ORDER BY 1")).toBe("is_won = false AND tags ILIKE '%splunk%'");
    expect(appliedConditions('SELECT 1 FROM t')).toBeUndefined();
  });

  it('resolves join keys through aliases and leaves CTEs out', () => {
    expect(joinKeyPairs('SELECT COUNT(*) FROM sales.opportunities o JOIN crm.deal_notes AS d ON d.deal_ref = o.deal_ref')).toEqual([
      { left: { relation: 'crm.deal_notes', column: 'deal_ref', qualifier: 'd' }, right: { relation: 'sales.opportunities', column: 'deal_ref', qualifier: 'o' } },
    ]);
    expect(joinKeyPairs('WITH lost AS (SELECT * FROM sales.opportunities) SELECT COUNT(*) FROM lost l JOIN crm.deal_notes d ON d.deal_ref = l.deal_ref')).toEqual([]);
  });

  it('reads every equality of a composite-key join, grouped into one key per pair of tables', () => {
    const sql = `SELECT b.bowler, SUM(s.runs_scored) AS runs
      FROM main.ball_by_ball AS b
      JOIN main.batsman_scored AS s ON s.ball_id = b.ball_id AND s.innings_no = b.innings_no AND s.match_id = b.match_id AND s.over_id = b.over_id
      LEFT JOIN main.wicket_taken w ON (w.match_id = b.match_id AND w.ball_id = b.ball_id)
      GROUP BY b.bowler`;
    expect(joinKeyPairs(sql).map((pair) => `${pair.left.qualifier}.${pair.left.column}=${pair.right.qualifier}.${pair.right.column}`)).toEqual([
      's.ball_id=b.ball_id', 's.innings_no=b.innings_no', 's.match_id=b.match_id', 's.over_id=b.over_id', 'w.match_id=b.match_id', 'w.ball_id=b.ball_id',
    ]);
    expect(joinKeyGroups(sql)).toEqual([
      { left: { relation: 'main.batsman_scored', qualifier: 's', columns: ['ball_id', 'innings_no', 'match_id', 'over_id'] }, right: { relation: 'main.ball_by_ball', qualifier: 'b', columns: ['ball_id', 'innings_no', 'match_id', 'over_id'] } },
      { left: { relation: 'main.wicket_taken', qualifier: 'w', columns: ['match_id', 'ball_id'] }, right: { relation: 'main.ball_by_ball', qualifier: 'b', columns: ['match_id', 'ball_id'] } },
    ]);
  });

  it('an ON clause ends at the next clause or the parenthesis that closes its query, and a recursive CTE is still a CTE', () => {
    const sql = `WITH RECURSIVE tree(id, root_id) AS (SELECT p.id, p.id FROM packaging p UNION ALL SELECT r.contains_id, t.root_id FROM packaging_relations r JOIN tree t ON r.packaging_id = t.id)
      SELECT COUNT(*) FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.total > 5`;
    expect(joinKeyGroups(sql)).toEqual([
      { left: { relation: 'customers', qualifier: 'c', columns: ['id'] }, right: { relation: 'orders', qualifier: 'o', columns: ['customer_id'] } },
    ]);
  });

  it('a definitions document pasted after the question states no values: its headings are not data', () => {
    const question = 'List each player with their batting average for Mumbai Indians.\n\nReference document (definitions.md):\n# Special Words Definition\n\n## Batting Average\n- Batting Average = Total Runs ÷ Total Dismissals';
    expect(questionProper(question)).toBe('List each player with their batting average for Mumbai Indians.');
    expect(statedValues(question).map((item) => item.value)).toEqual(['Mumbai', 'Indians']);
  });

  it('a name of several words is applied by any of its own words; separate names each still count', () => {
    const stated = statedValues("What was the Golden State Warriors' win-loss record in each of the last 5 seasons?");
    expect(stated.map((item) => [item.value, item.name])).toEqual([['Golden', 'Golden State Warriors'], ['State', 'Golden State Warriors'], ['Warriors', 'Golden State Warriors']]);
    expect(missingStatedValues("SELECT season, SUM(won) FROM team_games WHERE team_nickname ILIKE '%warriors%' GROUP BY season", stated)).toEqual([]);
    expect(missingStatedValues('SELECT season, SUM(won) FROM team_games GROUP BY season', stated).map((item) => item.value)).toEqual(['Golden', 'State', 'Warriors']);
    // Names parted by a comma or a word are separate: each one is still required.
    const several = statedValues('Sales for Acme, Contoso and Fabrikam');
    expect(several.every((item) => item.name === undefined)).toBe(true);
    expect(missingStatedValues("SELECT * FROM s WHERE c IN ('Acme', 'Contoso')", several).map((item) => item.value)).toEqual(['Fabrikam']);
  });

  it('a name the reading wrote in several words is applied by any of its words', () => {
    const reading = { version: 1, kind: 'analytics', reading: 'x', measures: [], groupBy: [], display: [], filters: [{ ref: 'column:t.team.nickname', op: 'eq', values: ['Boston Celtics'], source: 'question' }], unresolved: [], provenance: {}, expectedShape: 'scalar' } as never;
    const stated = statedValues('how many home games did they win in 2008', reading);
    expect(stated.find((item) => item.value === 'Boston Celtics')?.name).toBe('Boston Celtics');
    expect(missingStatedValues("SELECT COUNT(*) FROM g JOIN t ON g.team_id = t.team_id WHERE t.nickname ILIKE '%celtics%' AND g.season = 2008", stated)).toEqual([]);
  });

  it('a ref the reading put where a value goes is a field, not a value the SQL must spell', () => {
    const intent = { version: 1, kind: 'analytics', reading: 'x', measures: [], groupBy: [], display: [], filters: [{ ref: 'column:main.match.team_1', op: 'eq', values: ['column:main.match.match_winner'], source: 'question' }], unresolved: [], provenance: {}, expectedShape: 'grouped' } as never;
    expect(statedValues('which team won', intent)).toEqual([]);
    // A text value beside it is still a value the statement must apply.
    const both = { version: 1, kind: 'analytics', reading: 'x', measures: [{ ref: 'column:main.match.win_margin', aggregation: 'sum', scope: [{ ref: 'column:main.match.venue', op: 'eq', values: ['metric:shop.revenue', 'Eden Gardens'] }] }], groupBy: [], display: [], filters: [{ ref: 'column:main.match.team_1', op: 'eq', values: ['column:main.match.match_winner'], source: 'question' }], unresolved: [], provenance: {}, expectedShape: 'grouped' } as never;
    expect(statedValues('which team won', both).map((item) => item.value)).toEqual(['Eden Gardens']);
  });

  it('guards the rows a statement returns and recognises aggregation', () => {
    expect(withRowGuard('SELECT a FROM t ORDER BY a;', 501)).toBe('SELECT a FROM t ORDER BY a\nLIMIT 501');
    expect(withRowGuard('SELECT a FROM t LIMIT 10', 501)).toBe('SELECT a FROM t LIMIT 10');
    expect(aggregatesRows('SELECT COUNT(*) FROM t')).toBe(true);
    expect(aggregatesRows('SELECT a FROM t')).toBe(false);
  });

  it('adds no row guard to a statement that returns one row: saved, it read as a Top 501 (V8 B5)', () => {
    const wins = "SELECT COUNT(*) AS wins FROM nba.team_games WHERE team = 'GSW' AND game_id LIKE '2%';";
    expect(withRowGuard(wins, 501)).toBe(wins.replace(/;$/, ''));
    expect(withRowGuard('WITH g AS (SELECT * FROM t GROUP BY a) SELECT ROUND(SUM(x) / COUNT(*), 2) AS avg_x FROM g', 501)).not.toMatch(/LIMIT/);
    // One row per group, a window, a union and a scalar subquery per row still get it.
    expect(withRowGuard('SELECT team, COUNT(*) FROM t GROUP BY team', 501)).toMatch(/LIMIT 501$/);
    expect(withRowGuard('SELECT a, SUM(x) OVER () FROM t', 501)).toMatch(/LIMIT 501$/);
    expect(withRowGuard('SELECT COUNT(*) FROM a UNION ALL SELECT COUNT(*) FROM b', 501)).toMatch(/LIMIT 501$/);
    expect(withRowGuard('SELECT a, (SELECT MAX(x) FROM u) AS top FROM t', 501)).toMatch(/LIMIT 501$/);
  });

  it('a column of the one side summed across a join that repeats its key is found; a distinct count and the many side are not', () => {
    const sql = 'SELECT SUM(oi.product_price) - SUM(o.order_cost) AS profit FROM dev.order_items oi JOIN dev.orders o ON oi.order_id = o.order_id';
    expect(joinKeyPairs(sql)[0]).toMatchObject({ left: { relation: 'dev.order_items', column: 'order_id', qualifier: 'oi' }, right: { relation: 'dev.orders', column: 'order_id', qualifier: 'o' } });
    expect(aggregatesColumnOf(sql, 'o')).toBe(true);
    expect(aggregatesColumnOf('SELECT COUNT(DISTINCT o.order_id) FROM dev.order_items oi JOIN dev.orders o ON oi.order_id = o.order_id', 'o')).toBe(false);
    expect(aggregatesColumnOf('SELECT SUM(oi.product_price) FROM dev.order_items oi JOIN dev.orders o ON oi.order_id = o.order_id', 'o')).toBe(false);
  });

  it('reads what a statement groups by: aliases resolved, positions read from the select list, expressions skipped', () => {
    const bare = 'SELECT location_id, SUM(order_total) / COUNT(DISTINCT order_id) AS aov\nFROM "jaffle_shop"."dev"."orders"\nGROUP BY location_id\nORDER BY location_id';
    expect(groupedColumns(bare)).toEqual([{ column: 'location_id', relation: '"jaffle_shop"."dev"."orders"' }]);
    const joined = 'SELECT l.location_name, o.location_id AS store, AVG(o.order_total) FROM dev.orders AS o JOIN dev.locations l ON o.location_id = l.location_id GROUP BY 1, 2';
    expect(groupedColumns(joined)).toEqual([
      { column: 'location_name', relation: 'dev.locations', qualifier: 'l' },
      { column: 'location_id', relation: 'dev.orders', qualifier: 'o' },
    ]);
    // A bare column over several tables names no relation; a CTE is not a relation; an expression is not a column.
    expect(groupedColumns('WITH t AS (SELECT o.customer_id, SUM(o.order_total) AS s FROM dev.orders o GROUP BY o.customer_id) SELECT c.customer_name, t.s FROM t JOIN dev.customers c ON c.customer_id = t.customer_id'))
      .toEqual([{ column: 'customer_id', relation: 'dev.orders', qualifier: 'o' }]);
    expect(groupedColumns("SELECT DATE_TRUNC('month', ordered_at), COUNT(*) FROM dev.orders GROUP BY DATE_TRUNC('month', ordered_at)")).toEqual([]);
    expect(groupedColumns('SELECT location_id, COUNT(*) FROM dev.orders o JOIN dev.locations l ON o.location_id = l.location_id GROUP BY location_id')).toEqual([{ column: 'location_id' }]);
    expect(mentionsColumn(joined, 'location_name')).toBe(true);
    expect(mentionsColumn(bare, 'location_name')).toBe(false);
    expect(mentionsColumn('SELECT "location_name" FROM t', 'location_name')).toBe(true);
  });
});
