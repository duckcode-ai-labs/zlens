import type {
  ConnectionMetadataScopeV1,
  ContextAuthoringProposalV1,
  DbtOnboardingStatusResponse,
  WarehouseCatalogSummary,
  WarehouseDiscoveryReport,
  WarehouseMetadataStatus,
} from '../../api/client';

/**
 * Guided Setup step 1, "Where does your data model live?" (RFC 0007 §8,
 * design D2). The answer decides which modeling mode the project uses:
 *   - `dbt`       → today's dbt-first flow, unchanged;
 *   - `warehouse` → warehouse-first: the warehouse's own tables, no dbt;
 *   - `both`      → hybrid: a dbt project plus schemas dbt doesn't cover;
 *   - `existing`  → the folder's dql.config.json already says; Setup asks only
 *                   for credentials, tests the connection and refreshes it.
 */
export type ModelSource = 'dbt' | 'warehouse' | 'both' | 'existing';

/**
 * What ZLens does with a database's rows, said honestly (new-user round 2,
 * Q3). It reads structure, counts rows to check keys, and shows sample rows
 * to the person on this computer. Nothing leaves the computer unless the
 * project turns on value profiles, which send a few column values to the AI
 * provider for its answers.
 */
export const ROWS_PRIVACY = 'ZLens reads table structure and counts rows to check keys. Sample rows are shown only to you, on this computer. Nothing is sent anywhere unless you turn on value profiles for AI answers.';
/** The same meaning where space is tight. */
export const ROWS_PRIVACY_SHORT = 'Reads structure and counts rows to check keys; sample rows stay on this computer. Nothing is sent unless you turn on value profiles.';
/** Said instead of "nothing is sent" when the project has value profiles on. */
export const VALUE_PROFILES_ON = 'Value profiles are on: a few column values are sent to your AI provider.';

/** The rows sentence for this project: with value profiles on, it says what is sent. */
export function rowsPrivacy(valueProfileOn = false, short = false): string {
  if (!valueProfileOn) return short ? ROWS_PRIVACY_SHORT : ROWS_PRIVACY;
  return short
    ? `Reads structure and counts rows to check keys; sample rows stay on this computer. ${VALUE_PROFILES_ON}`
    : `ZLens reads table structure and counts rows to check keys. Sample rows are shown only to you, on this computer. ${VALUE_PROFILES_ON}`;
}

export type ModelingMode = 'dbt-first' | 'warehouse-first' | 'hybrid';

export interface ModelSourceOption {
  id: ModelSource;
  title: string;
  body: string;
}

export const MODEL_SOURCE_OPTIONS: readonly ModelSourceOption[] = [
  {
    id: 'dbt',
    title: 'dbt project',
    body: 'ZLens reads your dbt models, tests and lineage. The dbt project stays yours.',
  },
  {
    id: 'warehouse',
    title: 'Database only',
    body: `No dbt? ZLens drafts models and joins from your tables for you to review. ${ROWS_PRIVACY}`,
  },
  {
    id: 'both',
    title: 'Both',
    body: "A dbt project, plus warehouse schemas dbt doesn't cover.",
  },
];

export const EXISTING_PROJECT_TITLE = 'Open an existing ZLens project';

/**
 * Database only would replace a dbt project's models with warehouse tables,
 * so the runtime refuses it for a folder that already reads dbt
 * (MODELING_MODE_CONFLICT). Setup says so before anyone picks it.
 */
export const DATABASE_ONLY_DBT_PROJECT =
  "This folder is a dbt project, so ZLens keeps its dbt models. Choose Both to add warehouse tables dbt doesn't cover. For a database-only project, run npx create-zlens-app my-analytics --warehouse <driver> in a new folder.";

/** Why Database only is not available for this folder, or null when it is. */
export function databaseOnlyUnavailable(existing: ExistingProject | null | undefined): string | null {
  return existing && existing.mode !== 'warehouse-first' ? DATABASE_ONLY_DBT_PROJECT : null;
}

/** What this folder's dql.config.json already says about its data model. */
export interface ExistingProject {
  mode: ModelingMode;
  /** "dbt project", "Database only" or "dbt project and database". */
  label: string;
  /** One line: where the model comes from and which connection it reads. */
  detail: string;
  dbtConfigured: boolean;
  warehouseModeling: boolean;
}

interface ConnectionsLike {
  default?: string;
  connections?: Record<string, unknown>;
}

function connectionDriver(connections: ConnectionsLike | null | undefined): string | null {
  if (!connections?.default) return null;
  const connection = connections.connections?.[connections.default];
  if (!connection || typeof connection !== 'object') return null;
  const record = connection as Record<string, unknown>;
  const driver = String(record.driver ?? record.type ?? '').trim();
  return driver || null;
}

export function modelingModeLabel(mode: ModelingMode): string {
  if (mode === 'warehouse-first') return 'Database only';
  if (mode === 'hybrid') return 'dbt project and database';
  return 'dbt project';
}

/**
 * The project this folder already is, or null when its dql.config.json does
 * not yet say where the data model lives (a fresh `zlens init`).
 */
export function existingProjectFromStatus(
  status: DbtOnboardingStatusResponse | null | undefined,
  connections?: ConnectionsLike | null,
): ExistingProject | null {
  const configuredMode = status?.modeling?.mode;
  const dbtConfigured = Boolean(status?.dbt?.configured);
  const mode: ModelingMode | null = configuredMode === 'warehouse-first' || configuredMode === 'hybrid' || configuredMode === 'dbt-first'
    ? configuredMode
    : dbtConfigured
      ? 'dbt-first'
      : null;
  if (!mode) return null;
  const warehouseModeling = mode === 'warehouse-first' || mode === 'hybrid';
  const parts: string[] = [];
  if (mode !== 'warehouse-first') {
    const dbtSource = status?.dbt?.repoUrl || status?.dbt?.projectDir;
    parts.push(!dbtSource ? 'dbt project' : dbtSource === '.' || dbtSource === './' ? 'dbt project in this folder' : `dbt project at ${dbtSource}`);
  }
  if (warehouseModeling) parts.push('warehouse tables');
  const driver = connectionDriver(connections);
  if (driver && connections?.default) parts.push(`connection "${connections.default}" (${driver})`);
  return {
    mode,
    label: modelingModeLabel(mode),
    detail: parts.join(' · '),
    dbtConfigured,
    warehouseModeling,
  };
}

/**
 * The card selected when step 1 opens, read from what the folder holds
 * (design D7). An update that must reapply the dbt project keeps the dbt card.
 * A folder whose dql.config.json already configures its data model opens as
 * an existing project: a dbt (or dbt + database) project whose dbt manifest is
 * built, and a Database only project whose model is already written (it has
 * Domains). The Jaffle sample is such a folder; offering "dbt project" there
 * asked people to locate the project they were already in (Codex F01). A dbt
 * project that is configured but not built yet keeps the dbt card (Preview and
 * Apply build it), a new Database only project opens on Database only, a
 * detected dbt project on dbt, a folder whose only data is a database file on
 * Database only. A folder with neither asks.
 */
export function initialModelSource(input: {
  requested?: ModelSource | null;
  requiresDbtReapply?: boolean;
  existing: ExistingProject | null;
  dbtProjectFound?: boolean;
  /** The configured dbt project's manifest exists (`dbt build` or `zlens sync dbt` ran). */
  dbtManifestFound?: boolean;
  /** The project already has Domains (its model is written in the repository). */
  hasDomains?: boolean;
  /** The project's connection is a database file (DuckDB), and there is no dbt project. */
  databaseFileConnection?: boolean;
}): ModelSource | null {
  if (input.requiresDbtReapply) return 'dbt';
  if (input.requested && (input.requested !== 'existing' || input.existing)) return input.requested;
  if (input.existing) {
    if (input.existing.mode === 'warehouse-first') return input.hasDomains ? 'existing' : 'warehouse';
    if (input.existing.dbtConfigured && input.dbtManifestFound) return 'existing';
    if (input.existing.mode === 'hybrid') return 'both';
    return 'dbt';
  }
  if (input.dbtProjectFound) return 'dbt';
  return input.databaseFileConnection ? 'warehouse' : null;
}

/** The modeling mode a choice turns on when the user continues from step 1. */
export function modelingModeForSource(source: ModelSource): 'warehouse-first' | 'hybrid' | null {
  if (source === 'warehouse') return 'warehouse-first';
  if (source === 'both') return 'hybrid';
  return null;
}

/** Why Continue is not available on step 1 yet, or null when it is. */
export function stepOneBlocker(input: {
  source: ModelSource | null;
  requiresDbtReapply: boolean;
  dbtConfigured: boolean;
  existing?: ExistingProject | null;
}): string | null {
  if (input.requiresDbtReapply) return `Preview and Reapply the prefilled dbt project first.`;
  if (!input.source) return 'Choose where your data model lives.';
  if (input.source === 'warehouse') {
    const unavailable = databaseOnlyUnavailable(input.existing);
    if (unavailable) return unavailable;
  }
  if (input.source === 'both' && !input.dbtConfigured) return 'Apply the dbt project first; the next step adds the schemas dbt does not cover.';
  return null;
}

/** Whether this choice drafts models from the warehouse in step 2. An existing project's models are already in its repository, so Setup skips modeling for it. */
export function draftsFromWarehouse(source: ModelSource | null): boolean {
  return source === 'warehouse' || source === 'both';
}

/** Where Setup's last step can send you. */
export type SetupStartTarget = 'domains' | 'ask' | 'notebook' | 'apps';

/**
 * The start card Setup highlights, and so where "Finish setup" goes: the
 * highlighted card and the button never disagree. Drafted models go to
 * Modeling for review first; otherwise Build a dashboard (Apps).
 */
export function setupFinishTarget(input: { drafted: boolean }): { target: SetupStartTarget; action: string } {
  return input.drafted ? { target: 'domains', action: 'Open Modeling' } : { target: 'apps', action: 'Build an App' };
}

export function setupStepTitles(source: ModelSource | null): string {
  if (source === 'existing') return 'Data model → Connection → optional AI → Finish';
  return 'Data model → Database → optional AI → Finish';
}

/**
 * The main action on an existing project's step 2, in plain words: what it
 * reads again. "Synchronize" and "candidate" were engineering words (Codex G2).
 */
export function existingRefreshLabel(project: Pick<ExistingProject, 'mode' | 'dbtConfigured' | 'warehouseModeling'> | null | undefined): string {
  const dbt = !project || (project.mode !== 'warehouse-first' && project.dbtConfigured);
  const warehouse = Boolean(project?.warehouseModeling);
  if (dbt && warehouse) return 'Refresh dbt and warehouse data';
  if (warehouse) return 'Refresh warehouse tables';
  return 'Refresh dbt data';
}

/** The optional line over the extra-schema picker on a dbt project's connection step. */
export const EXTRA_SCHEMAS_HINT = "Optional: add warehouse schemas dbt doesn't cover";

export function stepTwoCopy(source: ModelSource | null, existing: ExistingProject | null, valueProfileOn = false): { title: string; description: string } {
  if (source === 'existing') {
    return {
      title: 'Check the connection',
      description: `This project's data model is already set (${existing?.label ?? 'configured'}). Test the connection — values written as \${NAME} are read from environment variables. Then ${existingRefreshLabel(existing).toLowerCase()} if the project changed since you last ran zlens sync.`,
    };
  }
  if (source === 'warehouse') {
    return {
      title: 'Connect your database',
      description: `Connect and test the database, choose the schemas to model, then Apply and synchronize. Then Draft my models. ${rowsPrivacy(valueProfileOn)}`,
    };
  }
  if (source === 'both') {
    return {
      title: 'Connect your database',
      description: "Connect and test the database. dbt's schemas are included automatically; choose the schemas dbt doesn't cover, then Apply and synchronize, then Draft my models.",
    };
  }
  return {
    title: 'Connect your database',
    description: 'Use the same profile import, enterprise authentication fields, test, and rollback flow available in Settings.',
  };
}

// ── Draft my models ────────────────────────────────────────────────────────

/** sessionStorage key Modeling reads to open a proposal in its review drawer. */
export const PROPOSAL_HANDOFF_KEY = 'dql-context-proposal-handoff';

export interface DraftOutcome {
  ok: boolean;
  message: string;
  proposalId?: string;
  /** The Domain the drafts go in ("Jaffle shop"), when one is new. */
  domain?: string;
  /** Staging copies left out ("Show staging tables" drafts them too). */
  stagingHidden?: Array<{ relation: string; finalRelation: string }>;
}

/** Plain words for what `Draft my models` found (`zlens model discover --validate`). */
export function draftOutcome(result: { report: WarehouseDiscoveryReport; proposal: ContextAuthoringProposalV1 | null }): DraftOutcome {
  const { report, proposal } = result;
  const entities = report.entities.filter((entity) => !entity.existing).length;
  const joins = report.relationships.length;
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
  if (!proposal) {
    return {
      ok: true,
      message: `Nothing new to draft: the ${plural(report.relations, 'table')} in the warehouse catalog and their joins are already modeled.`,
    };
  }
  const domain = report.domains.find((item) => !item.existing)?.name ?? report.domains[0]?.name;
  return {
    ok: true,
    proposalId: proposal.id,
    // Honest about what is written (new-user round 2, problem 4): drafts wait for a Save in Modeling.
    message: `Drafted ${plural(entities, 'model')} and ${plural(joins, 'join')} from ${plural(report.relations, 'table')}${report.validated ? ', each join checked on the data' : ''}. Not saved yet: review and save them in Modeling.`,
    ...(domain ? { domain } : {}),
    ...(report.stagingHidden?.length ? { stagingHidden: report.stagingHidden } : {}),
  };
}

export function draftErrorMessage(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : '';
  if (code === 'WAREHOUSE_CATALOG_MISSING') return 'Choose schemas and Apply and synchronize first; drafting reads the synchronized tables.';
  return error instanceof Error ? error.message : String(error);
}

export function rememberProposalForModeling(proposalId: string, storage: Pick<Storage, 'setItem'> | null | undefined = typeof window === 'undefined' ? null : window.sessionStorage): void {
  try {
    storage?.setItem(PROPOSAL_HANDOFF_KEY, proposalId);
  } catch {
    // best effort: Modeling's own "Draft from warehouse" drafts again
  }
}

// ── Open an existing project: synchronize ──────────────────────────────────

/** Environment variables the connection reads that are not set for this server. */
export function missingEnvironment(environment: Array<{ name: string; set: boolean }> | undefined): string[] {
  return (environment ?? []).filter((reference) => !reference.set).map((reference) => reference.name);
}

export interface ProjectSyncApi {
  previewDbtOnboarding: (payload: Record<string, never>) => Promise<{ fingerprint: string; counts?: Record<string, number> }>;
  refreshDbtOnboarding: (payload: { expectedFingerprint: string }) => Promise<unknown>;
  getConnectionMetadataScope: (connectionId: string) => Promise<{ scope: ConnectionMetadataScopeV1; status: WarehouseMetadataStatus }>;
  refreshConnectionMetadata: (connectionId: string) => Promise<{ status: WarehouseMetadataStatus; warehouseCatalog?: WarehouseCatalogSummary }>;
}

export interface ProjectSyncStep {
  kind: 'dbt' | 'warehouse';
  ok: boolean;
  message: string;
}

/**
 * Synchronize a project whose data model is already set: rebuild the dbt
 * snapshot from its configured project (as Settings → Refresh does) and read
 * its saved warehouse schemas again (as `zlens sync warehouse` does). Each part
 * reports separately, so one failure does not hide the other.
 */
export async function synchronizeExistingProject(
  project: ExistingProject,
  connectionId: string | null | undefined,
  syncApi: ProjectSyncApi,
  environment: Array<{ name: string; set: boolean }> = [],
): Promise<ProjectSyncStep[]> {
  const unset = missingEnvironment(environment);
  if (unset.length) {
    return [{ kind: project.warehouseModeling ? 'warehouse' : 'dbt', ok: false, message: `Set ${unset.join(', ')} in the shell that starts zlens notebook, restart it, then refresh.` }];
  }
  const steps: ProjectSyncStep[] = [];
  if (project.dbtConfigured && project.mode !== 'warehouse-first') {
    try {
      const preview = await syncApi.previewDbtOnboarding({});
      await syncApi.refreshDbtOnboarding({ expectedFingerprint: preview.fingerprint });
      const models = preview.counts?.models;
      steps.push({ kind: 'dbt', ok: true, message: `dbt data refreshed${typeof models === 'number' ? ` · ${models} models` : ''}. Search indexes update in the background.` });
    } catch (error) {
      steps.push({ kind: 'dbt', ok: false, message: `dbt project: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  if (project.warehouseModeling) {
    if (!connectionId) {
      steps.push({ kind: 'warehouse', ok: false, message: 'Add and test a database connection first.' });
      return steps;
    }
    try {
      const saved = await syncApi.getConnectionMetadataScope(connectionId);
      const schemas = (saved.scope.selectedScopes ?? saved.scope.scopes).reduce((count, scope) => count + scope.schemas.length, 0);
      if (saved.scope.mode !== 'dbt_relations' && schemas === 0) {
        steps.push({ kind: 'warehouse', ok: false, message: 'No schemas are saved for this connection yet. Choose them in Metadata scope above, then Apply and synchronize.' });
        return steps;
      }
      const synced = await syncApi.refreshConnectionMetadata(connectionId);
      const catalog = synced.warehouseCatalog;
      if (catalog?.error) {
        steps.push({ kind: 'warehouse', ok: false, message: `Warehouse catalog: ${catalog.error}` });
      } else {
        const tables = catalog?.relations ?? synced.status.relationCount;
        steps.push({ kind: 'warehouse', ok: true, message: `Warehouse tables refreshed · ${tables.toLocaleString()} tables and views.` });
      }
    } catch (error) {
      steps.push({ kind: 'warehouse', ok: false, message: `Warehouse: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return steps;
}
