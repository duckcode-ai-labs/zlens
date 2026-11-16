import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { addTileStep } from './add-tile-step';
import { draftRevenueQuery, orderLinesDataset, topCustomersQuery } from './builder/app-data.fixtures';

/**
 * "+ Add tile" (V3 retest): on "Warriors Wins By Season", an App built from saved queries whose fields were not read,
 * two clicks did nothing a person could see. Every click now does something visible.
 */
describe('+ Add tile', () => {
  const step = (input: Partial<Parameters<typeof addTileStep>[0]>) => addTileStep({ appData: [], fieldsSource: null, chosen: null, datasetTilesEnabled: true, ...input });

  it('starts a new tile on data with fields', () => {
    expect(step({ appData: [orderLinesDataset], fieldsSource: orderLinesDataset })).toEqual({ kind: 'build', source: orderLinesDataset });
  });

  it('opens Add data when the App has no data', () => {
    expect(step({})).toEqual({ kind: 'add-data' });
  });

  it('reads a saved query\'s columns as fields when it has none yet, the App\'s only data or the one chosen', () => {
    expect(step({ appData: [topCustomersQuery] })).toEqual({ kind: 'read-fields', source: topCustomersQuery });
    expect(step({ appData: [topCustomersQuery, draftRevenueQuery], chosen: draftRevenueQuery })).toEqual({ kind: 'read-fields', source: draftRevenueQuery });
  });

  it('offers the saved query as a Table, Chart or KPI when its columns could not be read, or field tiles are off', () => {
    expect(step({ appData: [topCustomersQuery], fieldsReadFailed: () => true })).toEqual({ kind: 'add-as-is', source: topCustomersQuery });
    expect(step({ appData: [topCustomersQuery], datasetTilesEnabled: false })).toEqual({ kind: 'add-as-is', source: topCustomersQuery });
    expect(step({ appData: [orderLinesDataset], fieldsSource: orderLinesDataset, chosen: orderLinesDataset, datasetTilesEnabled: false })).toEqual({ kind: 'add-as-is', source: orderLinesDataset });
  });

  it('opens the list of the App\'s data when there are several and none is chosen', () => {
    expect(step({ appData: [topCustomersQuery, draftRevenueQuery] })).toEqual({ kind: 'choose-data' });
  });

  it('is what the Add tile buttons run in App Studio', () => {
    const studio = readFileSync(fileURLToPath(new URL('./AppStudioV2.tsx', import.meta.url)), 'utf8');
    const open = studio.slice(studio.indexOf('const openAddTile = () => {'), studio.indexOf('/** A field click builds the new tile'));
    expect(open).toContain('addTileStep({');
    for (const kind of ["'build'", "'add-data'", "'choose-data'"]) expect(open).toContain(kind);
    expect(open).toContain('setDataPickerRequest');
    expect(open).toContain('chooseDataset(step.source)');
    expect(studio).toContain('className="add-tile" onClick={openAddTile}');
  });
});
