import { describe, expect, it } from 'vitest';
import { certifiedQueryPrompts, neutralPrompts, projectExamplePrompts } from './project-prompts';

const metric = (name: string, label = '') => ({ name, label, description: '', domain: 'claims', sql: '', type: 'sum', table: '', tags: [], owner: null }) as never;
const dimension = (name: string, label = '') => ({ name, label, description: '' }) as never;

describe('example questions from the project', () => {
  it('asks about the project\'s own metrics, by a dimension and over time', () => {
    expect(projectExamplePrompts([metric('claims_paid', 'Claims paid'), metric('claim_count', 'Claim count')], [dimension('region', 'Region'), dimension('reported_date')], [dimension('reported_date')]).map((prompt) => prompt.prompt)).toEqual([
      'What is claims paid?', 'Claims paid by region', 'How has claim count changed over time?', 'What is claim count?',
    ]);
  });

  it('is empty without metrics, so Ask shows general examples', () => {
    expect(projectExamplePrompts([], [dimension('region')], [])).toEqual([]);
  });

  // V12: Notebook AI on NBA data offered revenue, region, customer and order questions.
  it('without metrics, asks the project\'s certified saved queries, never a sample business', () => {
    const prompts = certifiedQueryPrompts([
      { name: 'warriors_ppg_regular_vs_playoffs_2016', status: 'certified', description: 'Warriors points per game, 2016' },
      { name: 'about_2009', status: 'draft', description: '' },
      { name: 'lakers_top_3_rebounders_2009', status: 'certified', description: "Who were the Lakers' top 3 rebounders in 2009?" },
    ]).map((prompt) => prompt.prompt);
    expect(prompts).toEqual(['Warriors ppg regular vs playoffs 2016', "Who were the Lakers' top 3 rebounders in 2009?"]);
    expect(certifiedQueryPrompts([{ name: 'x', status: 'draft' }])).toEqual([]);
    expect(neutralPrompts(true).map((prompt) => prompt.prompt).join(' ')).not.toMatch(/revenue|region|customer|order/i);
  });
});
