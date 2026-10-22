import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { themes } from '../../themes/notebook-theme';
import { DraftModelsCard, ExistingProjectSyncCard, ModelSourceChooser } from './ModelSourceChooser';
import { existingProjectFromStatus } from './setup-model-source';

const t = themes.paper;
const noop = () => undefined;
const warehouseProject = existingProjectFromStatus(
  { dbt: { configured: false }, modeling: { enabled: true, mode: 'warehouse-first' } },
  { default: 'warehouse', connections: { warehouse: { driver: 'duckdb', filepath: 'jaffle_shop.duckdb' } } },
);

function radios(html: string): Array<{ value: string; checked: boolean; disabled: boolean }> {
  return [...html.matchAll(/<input([^>]*)type="radio"([^>]*)>/g)].map((match) => {
    const attrs = `${match[1]} ${match[2]}`;
    return {
      value: /value="([^"]+)"/.exec(attrs)?.[1] ?? '',
      checked: /\schecked=""/.test(attrs),
      disabled: /\sdisabled=""/.test(attrs),
    };
  });
}

describe('Where does your data model live?', () => {
  it('offers dbt project, Database only, Both and Open an existing ZLens project as one labelled radio group', () => {
    const html = renderToStaticMarkup(<ModelSourceChooser value={null} onChange={noop} existing={null} t={t} />);
    expect(html).toContain('<fieldset');
    expect(html).toContain('<legend');
    expect(html).toContain('Where does your data model live?');
    for (const title of ['dbt project', 'Database only', 'Both', 'Open an existing ZLens project']) expect(html).toContain(title);
    expect(radios(html).map((radio) => radio.value)).toEqual(['dbt', 'warehouse', 'both', 'existing']);
    expect(radios(html).every((radio) => !radio.checked)).toBe(true);
    // Every radio is labelled by its card and described by its body text.
    for (const id of ['dbt', 'warehouse', 'both', 'existing']) {
      expect(html).toContain(`for="zlens-model-source-${id}"`);
      expect(html).toContain(`aria-labelledby="zlens-model-source-${id}-title"`);
      expect(html).toContain(`id="zlens-model-source-${id}-title"`);
      expect(html).toContain(`aria-describedby="zlens-model-source-${id}-body"`);
    }
  });

  it('dbt project: the dbt card is selected', () => {
    const html = renderToStaticMarkup(<ModelSourceChooser value="dbt" onChange={noop} existing={null} t={t} />);
    expect(radios(html).find((radio) => radio.checked)?.value).toBe('dbt');
  });

  it('Database only: says honestly what it does with rows', () => {
    const html = renderToStaticMarkup(<ModelSourceChooser value="warehouse" onChange={noop} existing={null} t={t} />);
    expect(radios(html).find((radio) => radio.checked)?.value).toBe('warehouse');
    expect(html).toContain('counts rows to check keys. Sample rows are shown only to you, on this computer. Nothing is sent anywhere unless you turn on value profiles for AI answers.');
    expect(html).not.toContain('never their rows');
  });

  it('Database only is disabled for a dbt project and explains why on the card', () => {
    const dbtProject = existingProjectFromStatus({ dbt: { configured: true, projectDir: '.' }, modeling: { enabled: true, mode: 'dbt-first' } });
    const html = renderToStaticMarkup(<ModelSourceChooser value="dbt" onChange={noop} existing={dbtProject} t={t} />);
    expect(radios(html).find((radio) => radio.value === 'warehouse')?.disabled).toBe(true);
    expect(radios(html).find((radio) => radio.value === 'both')?.disabled).toBe(false);
    expect(html).toContain('This folder is a dbt project');
    expect(html).toContain('Choose Both');
  });

  it('Database only stays available for a Database only project', () => {
    const html = renderToStaticMarkup(<ModelSourceChooser value="warehouse" onChange={noop} existing={warehouseProject} t={t} />);
    expect(radios(html).find((radio) => radio.value === 'warehouse')?.disabled).toBe(false);
    expect(html).not.toContain('This folder is a dbt project');
  });

  it("Both: dbt plus schemas dbt doesn't cover", () => {
    const html = renderToStaticMarkup(<ModelSourceChooser value="both" onChange={noop} existing={null} t={t} />);
    expect(radios(html).find((radio) => radio.checked)?.value).toBe('both');
    expect(html).toContain('schemas dbt doesn&#x27;t cover');
  });

  it('Open an existing project: disabled without a configured data model, explained', () => {
    const html = renderToStaticMarkup(<ModelSourceChooser value={null} onChange={noop} existing={null} t={t} />);
    expect(radios(html).find((radio) => radio.value === 'existing')?.disabled).toBe(true);
    expect(html).toContain('zlens notebook path/to/project');
  });

  it('Open an existing project: names the mode and connection dql.config.json already sets', () => {
    const html = renderToStaticMarkup(<ModelSourceChooser value="existing" onChange={noop} existing={warehouseProject} t={t} />);
    const existing = radios(html).find((radio) => radio.value === 'existing');
    expect(existing).toEqual({ value: 'existing', checked: true, disabled: false });
    expect(html).toContain('Database only');
    expect(html).toContain('connection &quot;warehouse&quot; (duckdb)');
    expect(html).toContain('no modeling questions');
  });

  it('an update that must reapply dbt offers only the dbt card', () => {
    const html = renderToStaticMarkup(<ModelSourceChooser value="dbt" onChange={noop} existing={warehouseProject} dbtOnly t={t} />);
    expect(radios(html).filter((radio) => !radio.disabled).map((radio) => radio.value)).toEqual(['dbt']);
  });
});

describe('Draft my models card', () => {
  it('waits for Apply and synchronize', () => {
    const html = renderToStaticMarkup(<DraftModelsCard busy={false} canDraft={false} outcome={null} onDraft={noop} t={t} />);
    expect(html).toContain('aria-label="Draft my models"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Draft my models<\/button>/);
    expect(html).toContain('Choose schemas and Apply and synchronize first.');
  });

  it('reports the draft as a status message', () => {
    const html = renderToStaticMarkup(<DraftModelsCard busy={false} canDraft outcome={{ ok: true, proposalId: 'p', message: 'Drafted 2 models and 1 join from 6 tables.' }} onDraft={noop} t={t} />);
    expect(html).toMatch(/<button[^>]*>Draft my models<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Draft my models/);
    expect(html).toContain('role="status"');
    expect(html).toContain('Drafted 2 models and 1 join from 6 tables.');
  });

  it('keeps the drafts: says how many wait for review, the Domain they go in, and offers a rename', () => {
    const waiting = { proposalId: 'p', createdAt: '2026-10-21T00:00:00Z', models: 9, joins: 12, domains: ['Jaffle shop'], stale: false };
    const html = renderToStaticMarkup(<DraftModelsCard busy={false} canDraft outcome={null} waiting={waiting} onDraft={noop} onRename={noop} t={t} />);
    expect(html).toContain('9 drafted models waiting for review in Jaffle shop. They are kept until you save or discard them.');
    expect(html).toContain('Your tables go in the Domain <strong');
    expect(html).toContain('Jaffle shop</strong>, named after your database.');
    expect(html).toMatch(/<button[^>]*>Rename<\/button>/);
  });

  it('says which staging tables it left out, with the Show staging tables toggle', () => {
    const outcome = { ok: true, proposalId: 'p', message: 'Drafted 2 models.', domain: 'Jaffle shop', stagingHidden: [{ relation: 'dev.stg_customers', finalRelation: 'dev.customers' }, { relation: 'dev.stg_orders', finalRelation: 'dev.orders' }] };
    const html = renderToStaticMarkup(<DraftModelsCard busy={false} canDraft outcome={outcome} onDraft={noop} onToggleStaging={noop} t={t} />);
    expect(html).toContain('Left out 2 staging tables (stg_customers, stg_orders): a final table holds the same data.');
    expect(html).toContain('Show staging tables');
    expect(html).toContain('They are kept until you review or discard them in Modeling.');
    // Nothing left out and not asked for: no toggle.
    expect(renderToStaticMarkup(<DraftModelsCard busy={false} canDraft outcome={{ ok: true, proposalId: 'p', message: 'x' }} onDraft={noop} onToggleStaging={noop} t={t} />)).not.toContain('Show staging tables');
  });

  it('reports a failure as an alert', () => {
    const html = renderToStaticMarkup(<DraftModelsCard busy={false} canDraft outcome={{ ok: false, message: 'boom' }} onDraft={noop} t={t} />);
    expect(html).toContain('role="alert"');
  });
});

describe('Synchronize card (existing project)', () => {
  it('says what it reads again and shows each part', () => {
    const html = renderToStaticMarkup(
      <ExistingProjectSyncCard
        project={warehouseProject!}
        busy={false}
        steps={[{ kind: 'warehouse', ok: true, message: 'Warehouse synchronized · 6 tables and views.' }]}
        onSync={noop}
        t={t}
      />,
    );
    expect(html).toContain('Reads the saved warehouse schemas again');
    expect(html).toContain('Warehouse synchronized · 6 tables and views.');
    expect(html).toMatch(/<button[^>]*>Synchronize<\/button>/);
  });

  it('names the environment variables the connection reads and which are missing', () => {
    const html = renderToStaticMarkup(
      <ExistingProjectSyncCard
        project={warehouseProject!}
        busy={false}
        steps={null}
        environment={[{ name: 'PGHOST', set: true }, { name: 'PGPASSWORD', set: false }]}
        onSync={noop}
        t={t}
      />,
    );
    expect(html).toContain('aria-label="Environment variables"');
    expect(html).toMatch(/PGHOST<\/code> · <span[^>]*>set<\/span>/);
    expect(html).toMatch(/PGPASSWORD<\/code> · <span[^>]*>not set<\/span>/);
    expect(html).toContain('Export the missing ones');
  });
});
