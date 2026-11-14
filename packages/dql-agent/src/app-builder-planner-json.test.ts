import { describe, expect, it } from 'vitest';
import { closeTruncatedJson, readPlannerJson } from './app-builder-planner-json.js';

/**
 * New-user test V8, item 4: "Describe with AI" failed 3 of 3 times on Cortex
 * through SQL with "did not return valid JSON for the build brief". A model
 * asked for JSON only still answers in several shapes; each is read here.
 */
const brief = {
  frame: { goal: 'Team wins', metrics: ['wins'], dimensions: ['season'], filters: [] },
  requirements: [{ id: 'r1', question: 'Wins by season', role: 'trend', required: true, measures: ['wins'], dimensions: ['season'], filters: [] }],
  components: [{ id: 'c1', title: 'Wins by season', sourceId: 'app:block:nba:wins', requirementIds: ['r1'], role: 'trend', view: 'line', rationale: 'It has wins by season' }],
};
const json = JSON.stringify(brief, null, 2);

describe('reading the App Builder planner reply', () => {
  it('reads the object alone, and in a fence with sentences around it that have braces of their own', () => {
    expect(readPlannerJson(json)).toEqual({ value: brief, truncated: false });
    const fenced = `Here is the build brief for {the NBA app}:\n\n\`\`\`json\n${json}\n\`\`\`\n\nLet me know if you want {more} tiles.`;
    expect(readPlannerJson(fenced)).toEqual({ value: brief, truncated: false });
    const prose = `I picked one source {wins}. ${JSON.stringify(brief)} That covers it {I think}.`;
    expect(readPlannerJson(prose)?.value).toEqual(brief);
  });

  it('reads the brief as a JSON-encoded string, wrapped in a brief key, or with comments and trailing commas', () => {
    expect(readPlannerJson(JSON.stringify(json))?.value).toEqual(brief);
    expect(readPlannerJson(JSON.stringify({ brief }))?.value).toEqual(brief);
    expect(readPlannerJson(JSON.stringify({ result: JSON.stringify(brief) }))?.value).toEqual(brief);
    const loose = '{\n  // the plan\n  "frame": {"goal": "Team wins", "metrics": ["wins",],},\n  "requirements": [{"id": "r1", "question": "Wins", "role": "kpi", "required": true, "measures": [], "dimensions": [], "filters": [],},],\n}';
    expect(readPlannerJson(loose)?.value).toEqual({
      frame: { goal: 'Team wins', metrics: ['wins'] },
      requirements: [{ id: 'r1', question: 'Wins', role: 'kpi', required: true, measures: [], dimensions: [], filters: [] }],
    });
  });

  it('closes a reply cut off at the token limit after its last complete value, and says so', () => {
    const cut = json.slice(0, json.indexOf('"rationale"') + 15);
    const read = readPlannerJson(`\`\`\`json\n${cut}`);
    expect(read?.truncated).toBe(true);
    expect(read?.value.frame).toEqual(brief.frame);
    expect(read?.value.requirements).toEqual(brief.requirements);
    // The partial member is dropped; the rest of the component stays.
    expect((read?.value.components as Array<Record<string, unknown>>)[0]).toMatchObject({ id: 'c1', sourceId: 'app:block:nba:wins' });
    expect((read?.value.components as Array<Record<string, unknown>>)[0]).not.toHaveProperty('rationale');
  });

  it('closes cut-off JSON in arrays and strings without inventing values', () => {
    expect(closeTruncatedJson('{"a": [1, 2, 3')).toBe('{"a": [1, 2]}');
    expect(closeTruncatedJson('{"a": ["x", "y')).toBe('{"a": ["x"]}');
    expect(closeTruncatedJson('{"a": {"b": 1}, "c": "unfinished')).toBe('{"a": {"b": 1}}');
    expect(closeTruncatedJson('{"a": 1, "b":')).toBe('{"a": 1}');
    expect(closeTruncatedJson('not json')).toBeUndefined();
  });

  it('closes a cut-off brief after a sentence with braces and quotes of its own (V12)', () => {
    const full = JSON.stringify(brief, null, 2);
    const cut = `I read the cards {"sales", "nba"} and the request "wins by season" first.\n${full.slice(0, full.indexOf('"rationale"') + 14)}`;
    const read = readPlannerJson(cut);
    expect(read?.truncated).toBe(true);
    expect(read?.value.requirements).toEqual(brief.requirements);
  });

  it('reads nothing from a reply with no object', () => {
    expect(readPlannerJson('')).toBeUndefined();
    expect(readPlannerJson('not json')).toBeUndefined();
    expect(readPlannerJson('I could not plan this app.')).toBeUndefined();
  });
});
