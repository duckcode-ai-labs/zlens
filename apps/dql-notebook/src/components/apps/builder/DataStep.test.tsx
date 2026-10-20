import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DataStep } from './DataStep';
import { DataPanel } from './DataPanel';
import { appDataItems, appDataSourceFromCandidate } from './app-data';
import { draftWith, orderLinesDataset, topCustomersQuery } from './app-data.fixtures';

const browser = { onAdd: vi.fn(async () => true), onRemove: vi.fn(), onChangePolicy: vi.fn() };

describe('Data step (design D3)', () => {
  it('asks for the App data before the canvas, with Open canvas and Skip', () => {
    const markup = renderToStaticMarkup(<DataStep draft={draftWith()} known={[]} onBack={vi.fn()} onOpenCanvas={vi.fn()} onSkip={vi.fn()} browser={browser} />);
    expect(markup).toContain('Data for this App');
    expect(markup).toContain('Pick the data this App will use. You can add more later from the Data panel.');
    expect(markup).toContain('This App&#x27;s data');
    expect(markup).toContain('No data yet');
    expect(markup).toContain('Skip, start empty');
    expect(markup).toContain('Open canvas');
    expect(markup).not.toContain('Open canvas with');
    expect(markup).toContain('Datasets &amp; Metrics');
  });

  it('lists the App data with type, trust and domain, and counts it on Open canvas', () => {
    const draft = draftWith({ sources: [appDataSourceFromCandidate(orderLinesDataset)] });
    const markup = renderToStaticMarkup(<DataStep draft={draft} known={[orderLinesDataset]} onBack={vi.fn()} onOpenCanvas={vi.fn()} onSkip={vi.fn()} browser={browser} />);
    expect(markup).toContain('Open canvas with 1 source');
    expect(markup).toContain('Dataset · Certified · Commerce');
    expect(markup).toContain('aria-label="Remove Order Lines from this App"');
    expect(markup).toContain('1 source');
  });
});

describe('Data pane: this App data and + Add data (design D5)', () => {
  const draft = draftWith({ sources: [appDataSourceFromCandidate(orderLinesDataset), appDataSourceFromCandidate(topCustomersQuery)] });
  const appData = appDataItems(draft.sources, [orderLinesDataset, topCustomersQuery]);
  const props = {
    appData,
    target: { kind: 'none' as const },
    disabled: false,
    onChoose: vi.fn(),
    onPickField: vi.fn(),
    onAddData: vi.fn(),
    onAddSavedQuery: vi.fn(),
    onAddContent: vi.fn(),
  };

  it('lists the App data first, then + Add data, with no separate table or all-sources entries', () => {
    const markup = renderToStaticMarkup(<DataPanel {...props} active={appData[0]!} defaultPickerOpen />);
    expect(markup).toContain('This App&#x27;s data');
    expect(markup.indexOf('Order Lines')).toBeLessThan(markup.indexOf('+ Add data…'));
    expect(markup.indexOf('Top Customers')).toBeLessThan(markup.indexOf('+ Add data…'));
    expect(markup).toContain('Saved query · Certified');
    expect(markup).not.toContain('Start from a table…');
    expect(markup).not.toContain('Saved queries and all sources…');
    expect(markup).not.toContain('Browse all sources');
    expect(markup).not.toContain('Use a saved query instead');
  });

  it('builds tiles from a Dataset by its fields', () => {
    const markup = renderToStaticMarkup(<DataPanel {...props} active={appData[0]!} />);
    expect(markup).toContain('Measures');
    expect(markup).toContain('Revenue');
    expect(markup).toContain('Click a field to start a new tile.');
  });

  it('adds a saved query whole as a Table, Chart or KPI and says it has no fields', () => {
    const markup = renderToStaticMarkup(<DataPanel {...props} active={appData[1]!} />);
    expect(markup).toContain('aria-label="Add Top Customers as Table"');
    expect(markup).toContain('aria-label="Add Top Customers as Chart"');
    expect(markup).toContain('aria-label="Add Top Customers as KPI"');
    expect(markup).toContain('Saved queries have no fields. Add fields to build tiles by Measures and Dimensions.');
    expect(markup).not.toContain('Search fields');
  });

  it('starts an App with no data from + Add data', () => {
    const markup = renderToStaticMarkup(<DataPanel {...props} appData={[]} active={null} />);
    expect(markup).toContain('This App has no data yet');
    expect(markup).toContain('Add data</button>');
  });
});
