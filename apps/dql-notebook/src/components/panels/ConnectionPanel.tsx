import React, { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { CheckCircle2, Database, GitBranch, Settings2, Sparkles } from 'lucide-react';
import { useDispatch, useNotebookStore } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import type { Theme } from '../../themes/notebook-theme';
import {
  api,
  type ConnectionMetadataScopeV1,
  type DbtOnboardingJob,
  type DbtProfileConnectionCandidate,
  type ProviderSettings,
  type WarehouseCatalogSummary,
  type WarehouseMetadataDiscovery,
  type WarehouseMetadataStatus,
} from '../../api/client';
import { PanelFrame } from '@zlens/ui';
import { DriverLogo } from './DriverLogo';
import { isStagingSchema, splitStagingSchemas } from '@zlens/core/staging-tables';
import { EXTRA_SCHEMAS_HINT, rowsPrivacy } from '../modals/setup-model-source';
import {
  CONNECTOR_SCHEMAS,
  CONNECTOR_SCHEMA_BY_DRIVER,
  DRIVER_COLORS,
  DRIVER_LABELS,
  DRIVER_TAGLINES,
  connectionFromFormFields,
  fieldApplies,
  formFieldsFromConnection,
  normalizeDriverName,
  type ConnectorFieldSchema,
} from './connection-forms';
import { ConnectionRuntimeSettings } from '../settings/SettingsPage';
import { DbtProjectEditor } from '../settings/DbtProjectEditor';
import {
  additionalDiscoveredSchemaCount,
  formatMetadataScopeEditor,
  looksLikeGeneratedId,
  metadataScopeIncludes,
  onlyDiscoveredSchema,
  parseMetadataScopeEditor,
  toggleAdditionalMetadataScope,
} from './connection-metadata-scope';
import { AdvancedDisclosure } from '../modals/AdvancedDisclosure';
import { projectDbtCard, projectReadsDbt } from './project-dbt-status';

export interface ConnectionInfo {
  default: string;
  connections: Record<string, any>;
  activeConnection?: { source: 'dql_config' | 'dbt_profile' | 'runtime'; driver: string; profileId?: string } | null;
  dbtProfiles?: DbtProfileConnectionCandidate[];
  connectorStatus?: ConnectorInstallStatus[];
  metadataScope?: ConnectionMetadataScopeV1 | null;
  metadataStatus?: WarehouseMetadataStatus;
  /** The modeling catalog of warehouse-first and hybrid projects (RFC 0007). */
  warehouseCatalog?: WarehouseCatalogSummary;
  modelingMode?: string;
  /** Value profiles are on: a few column values reach the AI provider. */
  valueProfile?: boolean;
}

interface ConnectorInstallStatus {
  driver: string;
  label: string;
  packageName?: string;
  packageSpec?: string;
  installed: boolean;
  builtIn: boolean;
  installPath: string;
  installCommand?: string;
}

const QUICK_CONNECT_PRESETS = [
  {
    name: 'default',
    label: 'Local DuckDB',
    description: 'In-memory DuckDB — no configuration needed',
    config: { driver: 'duckdb', filepath: ':memory:' },
  },
  {
    name: 'snowflake',
    label: 'Snowflake',
    description: 'Connect to your Snowflake data warehouse',
    config: { driver: 'snowflake', account: '', warehouse: '', database: '', schema: 'PUBLIC', username: '', password: '' },
  },
  {
    name: 'databricks',
    label: 'Databricks SQL',
    description: 'Connect to a Databricks SQL warehouse',
    config: { driver: 'databricks', host: '', warehouse: '', schema: 'default', token: '' },
  },
];

function connectionNameFromProfile(profile: DbtProfileConnectionCandidate): string {
  const name = `${profile.profileName}_${profile.targetName}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return name || 'dbt_profile';
}

function connectionFieldsFromProfile(profile: DbtProfileConnectionCandidate): Record<string, string> {
  return formFieldsFromConnection(profile.connection as unknown as Record<string, unknown>);
}

function shortPath(path: string): string {
  const marker = '/.dbt/';
  const markerIndex = path.indexOf(marker);
  if (markerIndex >= 0) return `~${path.slice(markerIndex)}`;
  const parts = path.split('/');
  return parts.slice(-3).join('/');
}

function isSensitiveField(field: string): boolean {
  const key = field.toLowerCase();
  return (
    key.includes('password') ||
    key.includes('token') ||
    key.includes('passphrase') ||
    key.includes('privatekey') ||
    key.includes('serviceaccountjson') ||
    key.includes('secretaccesskey') ||
    key.includes('clientsecret')
  );
}

function saveMessageColor(message: string, theme: Theme): string {
  if (message.startsWith('Error') || message.toLowerCase().includes('failed')) return theme.error;
  if (message.toLowerCase().includes('testing')) return theme.warning;
  return theme.success;
}

function isPlaceholderLocalConnection(cfg: any): boolean {
  const driver = normalizeDriverName(String(cfg?.driver ?? cfg?.type ?? ''));
  if (driver !== 'duckdb' && driver !== 'file') return false;
  // A folder of data files is a real database, read in memory.
  if (driver === 'file' && String(cfg?.dataFolder ?? '').trim()) return false;
  const filepath = cfg?.filepath ?? cfg?.path;
  return !filepath || filepath === ':memory:';
}

function chooseDefaultAfterSave(
  connections: Record<string, any>,
  previousDefault: string,
  savedName: string,
  previousName: string | null,
): string {
  const savedWasDefault = previousName !== null && previousName === previousDefault;
  const defaultStillExists = Boolean(previousDefault && connections[previousDefault]);
  const savedConnection = connections[savedName];

  if (
    previousName === null ||
    savedWasDefault ||
    !defaultStillExists ||
    (
      previousDefault === 'default' &&
      isPlaceholderLocalConnection(connections.default) &&
      !isPlaceholderLocalConnection(savedConnection)
    )
  ) {
    return savedName;
  }

  return previousDefault;
}

function chooseFallbackDefault(connections: Record<string, any>): string | undefined {
  const keys = Object.keys(connections);
  return keys.find((key) => !isPlaceholderLocalConnection(connections[key])) ?? keys[0];
}

export function ConnectionPanel({
  variant = 'panel',
  setupSource = null,
  setupPrimaryAction,
  initialInfo,
  onConfigured,
  onMetadataSynced,
}: {
  variant?: 'panel' | 'page' | 'setup';
  /** Guided Setup's answer to "Where does your data model live?": Database only hides dbt profiles (design D7). */
  setupSource?: 'dbt' | 'warehouse' | 'both' | 'existing' | null;
  /** Guided Setup: the step's main action, shown right under the connection test (an existing project's Refresh). */
  setupPrimaryAction?: React.ReactNode;
  /** Connections to show before the server answers (and in tests). */
  initialInfo?: ConnectionInfo;
  onConfigured?: (detail: string) => void;
  /** Apply and synchronize (or Refresh metadata) finished: Guided Setup can draft models from it. */
  onMetadataSynced?: (result: { status: WarehouseMetadataStatus; warehouseCatalog?: WarehouseCatalogSummary }) => void;
} = {}) {
  const state = useNotebookStore(useShallow((store) => ({
    settingsTab: store.settingsTab,
    themeMode: store.themeMode,
  })));
  const dispatch = useDispatch();
  const t = themes[state.themeMode];
  const isPage = variant === 'page';
  const isSetup = variant === 'setup';

  const [info, setInfo] = useState<ConnectionInfo | null>(initialInfo ?? null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null); // connection key being edited
  const [addingNew, setAddingNew] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [installingDriver, setInstallingDriver] = useState<string | null>(null);
  const [profilePath, setProfilePath] = useState('');
  const [previewingProfiles, setPreviewingProfiles] = useState(false);
  const [profileImportError, setProfileImportError] = useState<string | null>(null);
  const [providerReadiness, setProviderReadiness] = useState<ProviderSettings[]>([]);
  const [dbtConfigured, setDbtConfigured] = useState(false);
  const [dbtPreparation, setDbtPreparation] = useState<DbtOnboardingJob | null>(null);
  const [metadataMode, setMetadataMode] = useState<ConnectionMetadataScopeV1['mode']>(initialInfo?.modelingMode === 'warehouse-first' ? 'selected_scopes' : 'dbt_relations');
  const [metadataScopeText, setMetadataScopeText] = useState('');
  const [metadataSyncing, setMetadataSyncing] = useState(false);
  const [metadataMessage, setMetadataMessage] = useState<string | null>(null);
  const [metadataDiscovery, setMetadataDiscovery] = useState<WarehouseMetadataDiscovery | null>(null);
  // Staging and raw schemas wait behind "Show staging tables" (new-user round 2, Q3).
  const [showStagingSchemas, setShowStagingSchemas] = useState(false);
  const [metadataDiscovering, setMetadataDiscovering] = useState(false);
  // Only the latest connection test may set the result: an older, slower test
  // (or one racing a save on a DuckDB file) never overrides a newer one.
  const testSeqRef = useRef(0);
  const persistingRef = useRef(false);
  // Guided Setup lists the schemas on its own once the test passes, once per connection.
  const autoDiscoveredRef = useRef<string | null>(null);

  // Edit form state (inline editor for the "manage all connections" list)
  const [editName, setEditName] = useState('');
  const [editDriver, setEditDriver] = useState('duckdb');
  const [editFields, setEditFields] = useState<Record<string, string>>({});

  // Prototype primary form: a single always-open editor bound to the default
  // connection (Warehouse select swaps fields → Save connection). Seeded from
  // the default connection and re-seeded whenever its identity changes.
  const [primaryDriver, setPrimaryDriver] = useState('duckdb');
  const [primaryFields, setPrimaryFields] = useState<Record<string, string>>({});
  const seededIdentityRef = useRef<string | null>(null);

  useEffect(() => {
    api.getConnections().then((connInfo) => {
      setInfo(connInfo);
      if (connInfo.metadataScope) {
        setMetadataMode(connInfo.metadataScope.mode);
        setMetadataScopeText(formatMetadataScopeEditor(
          connInfo.metadataScope.selectedScopes ?? connInfo.metadataScope.scopes,
        ));
      } else if ((connInfo as ConnectionInfo).modelingMode === 'warehouse-first') {
        // Without dbt there are no dbt relations to index: the chosen schemas are the model.
        setMetadataMode('selected_scopes');
      }
    });
  }, []);

  const connectionIdentity = info
    ? `${info.default}:${JSON.stringify(info.connections?.[info.default] ?? null)}`
    : '';
  useEffect(() => {
    if (!info || (isPage && state.settingsTab !== 'database')) return;
    if (!Object.values(info.connections).some((candidate) => !isPlaceholderLocalConnection(candidate))) return;
    // A save tests the connection it just wrote; testing it a second time at
    // once could race it on the same database file.
    if (persistingRef.current) return;
    let active = true;
    const seq = ++testSeqRef.current;
    setTesting(true);
    void api.testConnection()
      .then((result) => {
        if (!active || seq !== testSeqRef.current) return;
        setTestResult(result);
        if (result.ok) onConfigured?.(result.message);
      })
      .catch((error) => {
        if (active && seq === testSeqRef.current) setTestResult({ ok: false, message: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => { if (active && seq === testSeqRef.current) setTesting(false); });
    return () => { active = false; };
  }, [connectionIdentity, isPage, state.settingsTab]);

  useEffect(() => {
    if (!isPage) return;
    let alive = true;
    void Promise.all([api.getProviderSettings(), api.getOnboardingStatus(), api.getBlockStudioDbtStatus().catch(() => null)])
      .then(([providerResult, onboarding, dbt]) => {
        if (!alive) return;
        setProviderReadiness(providerResult.providers);
        // The project reads dbt when its dbt artifacts are found, whether or not
        // dql.config.json names the dbt project: that is what lineage, search
        // and Ask use, so it is what this status reports.
        setDbtConfigured(projectReadsDbt(onboarding.dbt, dbt));
        setDbtPreparation(onboarding.preparation ?? null);
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [isPage]);

  useEffect(() => {
    if (!isPage || !dbtPreparation || (dbtPreparation.status !== 'queued' && dbtPreparation.status !== 'running')) return;
    let alive = true;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const onboarding = await api.getOnboardingStatus();
        if (!alive) return;
        setDbtPreparation(onboarding.preparation ?? null);
        setDbtConfigured(onboarding.dbt?.configured === true);
        if (onboarding.preparation?.status === 'queued' || onboarding.preparation?.status === 'running') {
          timer = window.setTimeout(() => void poll(), 700);
        }
      } catch {
        // The project editor retains the actionable error; Overview polling is advisory.
      }
    };
    timer = window.setTimeout(() => void poll(), 500);
    return () => {
      alive = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [dbtPreparation?.id, dbtPreparation?.status, isPage]);

  // Seed the primary form from the default connection. Keyed on the connection's
  // identity so user typing (which only updates primaryFields) never re-seeds,
  // but a save/import/default-change (which refreshes `info`) does.
  useEffect(() => {
    if (!info) return;
    const key = info.default;
    const cfg = key ? info.connections?.[key] : undefined;
    const identity = cfg ? `${key}::${JSON.stringify(cfg)}` : '::none';
    if (seededIdentityRef.current === identity) return;
    seededIdentityRef.current = identity;
    if (cfg) {
      setPrimaryDriver(normalizeDriverName(String(cfg.driver ?? cfg.type ?? 'duckdb')));
      setPrimaryFields(formFieldsFromConnection(cfg));
    } else {
      setPrimaryDriver('duckdb');
      setPrimaryFields({});
    }
  }, [info]);

  const handleTest = async () => {
    if (!info || Object.keys(info.connections ?? {}).length === 0) {
      setTestResult({ ok: false, message: 'Add or import a connection before testing.' });
      return;
    }
    const seq = ++testSeqRef.current;
    setTesting(true);
    setTestResult(null);
    const result = await api.testConnection();
    if (seq !== testSeqRef.current) return;
    setTestResult(result);
    if (result.ok) onConfigured?.(result.message);
    setTesting(false);
  };

  const applyMetadataResponse = (response: {
    scope: ConnectionMetadataScopeV1;
    status: WarehouseMetadataStatus;
    warehouseCatalog?: WarehouseCatalogSummary;
  }) => {
    setInfo((current) => current ? {
      ...current,
      metadataScope: response.scope,
      metadataStatus: response.status,
      ...(response.warehouseCatalog ? { warehouseCatalog: response.warehouseCatalog } : {}),
    } : current);
    setMetadataMode(response.scope.mode);
    setMetadataScopeText(formatMetadataScopeEditor(
      response.scope.selectedScopes ?? response.scope.scopes,
    ));
  };

  const handleMetadataDiscovery = async () => {
    if (!info?.default || !testResult?.ok) return;
    setMetadataDiscovering(true);
    setMetadataMessage('Finding databases/catalogs and schemas visible to this connection…');
    try {
      const discovery = await api.discoverConnectionMetadataScopes(info.default);
      setMetadataDiscovery(discovery);
      setMetadataMessage(discovery.message);
      const only = onlyDiscoveredSchema(discovery);
      if (isSetup && only && parseMetadataScopeEditor(metadataScopeText).length === 0) {
        setMetadataScopeText(formatMetadataScopeEditor([{ catalogOrDatabase: only.catalogOrDatabase, schemas: [only.schema] }]));
        setMetadataMode('selected_scopes');
      }
    } catch (error) {
      setMetadataDiscovery(null);
      setMetadataMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setMetadataDiscovering(false);
    }
  };

  // Guided Setup asks one plain question, "Which schemas should ZLens read?",
  // so it lists the schemas as soon as the connection test passes (design D7);
  // the button stays to list them again.
  useEffect(() => {
    if (!isSetup || !testResult?.ok || !info?.default || metadataDiscovering || metadataDiscovery) return;
    if (autoDiscoveredRef.current === connectionIdentity) return;
    autoDiscoveredRef.current = connectionIdentity;
    void handleMetadataDiscovery();
    // handleMetadataDiscovery reads the same state this effect depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSetup, testResult?.ok, info?.default, connectionIdentity, metadataDiscovering, metadataDiscovery]);

  const setAdditionalMetadataScope = (
    catalogOrDatabase: string,
    schema: string,
    selected: boolean,
  ) => {
    const next = toggleAdditionalMetadataScope(
      parseMetadataScopeEditor(metadataScopeText),
      catalogOrDatabase,
      schema,
      selected,
    );
    setMetadataScopeText(formatMetadataScopeEditor(next));
    setMetadataMode((metadataDiscovery?.dbtScopes.length ?? 0) > 0
      ? 'dbt_plus_selected'
      : 'selected_scopes');
  };

  const handleMetadataApply = async () => {
    if (!info?.default) return;
    const scopes = parseMetadataScopeEditor(metadataScopeText);
    if (metadataMode === 'selected_scopes' && scopes.length === 0) {
      setMetadataMessage('Add at least one line such as ANALYTICS_PROD: SALES, FINANCE.');
      return;
    }
    setMetadataSyncing(true);
    setMetadataMessage('Synchronizing selected metadata into local SQLite…');
    try {
      const response = await api.applyConnectionMetadataScope(info.default, {
        mode: metadataMode,
        ...(metadataMode === 'dbt_relations' ? {} : { scopes }),
      });
      applyMetadataResponse(response);
      onMetadataSynced?.(response);
      setMetadataMessage(isSetup
        ? `Read ${response.status.relationCount.toLocaleString()} table${response.status.relationCount === 1 ? '' : 's'} (${response.status.columnCount.toLocaleString()} columns).`
          + warehouseCatalogMessage(response.warehouseCatalog)
        : `Ready · ${response.status.relationCount.toLocaleString()} relations · `
          + `${response.status.columnCount.toLocaleString()} columns · `
          + `${response.status.queryCount ?? 0} metadata queries`
          + warehouseCatalogMessage(response.warehouseCatalog),
      );
    } catch (error) {
      setMetadataMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setMetadataSyncing(false);
    }
  };

  const handleMetadataRefresh = async () => {
    if (!info?.default) return;
    setMetadataSyncing(true);
    setMetadataMessage('Refreshing the applied metadata scope…');
    try {
      const response = await api.refreshConnectionMetadata(info.default);
      applyMetadataResponse(response);
      onMetadataSynced?.(response);
      setMetadataMessage(
        `Refreshed · ${response.status.relationCount.toLocaleString()} relations · `
        + `${response.status.columnCount.toLocaleString()} columns`
        + warehouseCatalogMessage(response.warehouseCatalog),
      );
    } catch (error) {
      setMetadataMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setMetadataSyncing(false);
    }
  };

  const startEdit = (key: string, cfg: any) => {
    setEditing(key);
    setAddingNew(false);
    setEditName(key);
    setEditDriver(normalizeDriverName(cfg?.driver ?? cfg?.type ?? 'duckdb'));
    setEditFields(formFieldsFromConnection(cfg));
  };

  const startAdd = () => {
    setAddingNew(true);
    setEditing(null);
    setEditName('');
    setEditDriver('duckdb');
    setEditFields({});
  };

  const cancelEdit = () => {
    setEditing(null);
    setAddingNew(false);
  };

  const handleInstallConnector = async (driver: string) => {
    setInstallingDriver(driver);
    setSaveMsg(null);
    try {
      const result = await api.installConnector(driver);
      if (result.connectorStatus && info) {
        setInfo({ ...info, connectorStatus: result.connectorStatus });
      } else {
        const refreshed = await api.getConnections();
        setInfo(refreshed);
      }
      setSaveMsg(result.ok ? 'Connector installed' : `Error: ${result.error ?? 'Install failed'}`);
    } catch (error: any) {
      setSaveMsg(`Error: ${error?.message ?? 'Install failed'}`);
    } finally {
      setInstallingDriver(null);
    }
  };

  // Shared persistence used by both the inline connection editor and the
  // prototype primary form. Builds a typed connection config, writes it, then
  // re-tests the hot-swapped connection.
  const persistConnection = async (opts: {
    name: string;
    driver: string;
    fields: Record<string, string>;
    previousName: string | null;
  }): Promise<boolean> => {
    if (!info) return false;
    persistingRef.current = true;
    setSaving(true);
    setSaveMsg(null);

    const name = opts.name.trim() || (opts.previousName ?? 'default');
    const newConn = connectionFromFormFields(opts.driver, opts.fields);

    const previousConnections = { ...info.connections };
    const previousDefault = info.default;
    const connections = { ...info.connections };
    // If renaming, remove old key
    if (opts.previousName && opts.previousName !== name) delete connections[opts.previousName];
    connections[name] = newConn;
    const nextDefault = chooseDefaultAfterSave(connections, info.default, name, opts.previousName);

    let ok = false;
    try {
      await api.saveConnections(
        connections,
        nextDefault,
        opts.previousName && opts.previousName !== name ? { [name]: opts.previousName } : undefined,
      );
      // Refresh
      const refreshed = await api.getConnections();
      setInfo(refreshed);
      if (refreshed.metadataScope) {
        setMetadataMode(refreshed.metadataScope.mode);
        setMetadataScopeText(formatMetadataScopeEditor(
          refreshed.metadataScope.selectedScopes ?? refreshed.metadataScope.scopes,
        ));
      }
      setMetadataDiscovery(null);
      setSaveMsg('Saved. Testing connection...');
      setEditing(null);
      setAddingNew(false);
      // Re-test the hot-swapped connection and refresh schema
      try {
        testSeqRef.current += 1;
        setTesting(true);
        const result = await api.testConnection();
        setTestResult(result);
        ok = result.ok;
        if (result.ok) {
          setSaveMsg('Test passed. Connection saved and activated.');
          onConfigured?.(result.message);
          setTimeout(() => setSaveMsg(null), 2000);
        } else {
          await api.saveConnections(previousConnections, previousDefault || undefined);
          const rolledBack = await api.getConnections();
          setInfo(rolledBack);
          setSaveMsg(`Test failed. Previous connection preserved: ${result.message}`);
        }
      } catch (e: any) {
        await api.saveConnections(previousConnections, previousDefault || undefined).catch(() => undefined);
        const rolledBack = await api.getConnections().catch(() => null);
        if (rolledBack) setInfo(rolledBack);
        setSaveMsg(`Test failed. Previous connection preserved: ${e.message ?? 'Connection failed'}`);
      } finally { setTesting(false); }
    } catch (e: any) {
      await api.saveConnections(previousConnections, previousDefault || undefined).catch(() => undefined);
      const rolledBack = await api.getConnections().catch(() => null);
      if (rolledBack) setInfo(rolledBack);
      setSaveMsg(`Test or save failed. Previous connection preserved: ${e.message}`);
    } finally {
      persistingRef.current = false;
      setSaving(false);
    }
    return ok;
  };

  const startAddFromDbtProfile = (profile: DbtProfileConnectionCandidate) => {
    const driver = normalizeDriverName(String(profile.connection.driver ?? profile.adapter ?? 'duckdb'));
    const fields = connectionFieldsFromProfile(profile);
    setTestResult(null);

    if (isPage || isSetup) {
      setPrimaryDriver(driver);
      setPrimaryFields(fields);
    }
    setAddingNew(false);
    setEditing(null);
    void persistConnection({
      name: connectionNameFromProfile(profile),
      driver,
      fields,
      previousName: null,
    });
  };

  const previewProfilePath = async () => {
    const path = profilePath.trim();
    if (!path) {
      setProfileImportError('Enter a profiles.yml file or folder path.');
      return;
    }
    setPreviewingProfiles(true);
    setProfileImportError(null);
    try {
      const result = await api.previewDbtProfiles(path);
      setInfo((current) => {
        if (!current) return current;
        const merged = new Map((current.dbtProfiles ?? []).map((profile) => [profile.id, profile]));
        result.dbtProfiles.forEach((profile) => merged.set(profile.id, profile));
        return { ...current, dbtProfiles: [...merged.values()] };
      });
    } catch (error) {
      setProfileImportError(error instanceof Error ? error.message : 'Could not read that profiles.yml path.');
    } finally {
      setPreviewingProfiles(false);
    }
  };

  const handleSave = () => persistConnection({
    name: editName,
    driver: editDriver,
    fields: editFields,
    previousName: editing,
  });

  const handlePrimarySave = () => persistConnection({
    name: (info?.default || 'default'),
    driver: primaryDriver,
    fields: primaryFields,
    previousName: info?.default || null,
  });

  const changePrimaryDriver = (driver: string) => {
    setPrimaryDriver(driver);
    // Switching warehouse type clears the old driver's fields, mirroring the
    // inline editor; a fresh field set avoids leaking incompatible keys.
    setPrimaryFields({});
    setTestResult(null);
  };

  const handleDelete = async (key: string) => {
    if (!info) return;
    const connections = { ...info.connections };
    delete connections[key];
    const nextDefault = key === info.default ? chooseFallbackDefault(connections) : info.default;
    setSaving(true);
    try {
      await api.saveConnections(connections, nextDefault);
      const refreshed = await api.getConnections();
      setInfo(refreshed);
      setEditing(null);
    } finally {
      setSaving(false);
    }
  };

  const handleMakeDefault = async (key: string) => {
    if (!info) return;
    const previousDefault = info.default;
    setSaving(true);
    setSaveMsg(null);
    try {
      await api.saveConnections(info.connections, key);
      const refreshed = await api.getConnections();
      setInfo(refreshed);
      setSaveMsg('Default updated. Testing connection...');
      setTesting(true);
      const result = await api.testConnection();
      setTestResult(result);
      if (result.ok) {
        setSaveMsg('Test passed. Default connection updated.');
        onConfigured?.(result.message);
        setTimeout(() => setSaveMsg(null), 2000);
      } else {
        await api.saveConnections(info.connections, previousDefault || undefined);
        const rolledBack = await api.getConnections();
        setInfo(rolledBack);
        setSaveMsg(`Test failed. Previous default preserved: ${result.message}`);
      }
    } catch (e: any) {
      await api.saveConnections(info.connections, previousDefault || undefined).catch(() => undefined);
      const rolledBack = await api.getConnections().catch(() => null);
      if (rolledBack) setInfo(rolledBack);
      setSaveMsg(`Test or save failed. Previous default preserved: ${e.message}`);
    } finally {
      setTesting(false);
      setSaving(false);
    }
  };

  const sectionLabel = {
    fontSize: 10,
    fontWeight: 600 as const,
    letterSpacing: '0.07em',
    textTransform: 'uppercase' as const,
    color: t.textMuted,
    fontFamily: t.font,
    marginBottom: 6,
  };

  const card = {
    background: t.cellBg,
    border: `1px solid ${t.cellBorder}`,
    borderRadius: 7,
    padding: '10px 12px',
    marginBottom: 10,
  };

  const connections = info?.connections ?? {};
  const defaultKey = info?.default ?? '';
  const dbtProfileCandidates = info?.dbtProfiles ?? [];
  const connectorStatusByDriver = Object.fromEntries(
    (info?.connectorStatus ?? []).map((status) => [status.driver, status]),
  ) as Record<string, ConnectorInstallStatus>;
  const connectionCount = Object.keys(connections).length;
  const canTestConnection = connectionCount > 0;

  const connectionListSection = (
    <>
      <div style={sectionLabel}>Connections</div>
      {info === null ? (
        <div style={{ fontSize: 12, color: t.textMuted, fontFamily: t.font }}>Loading…</div>
      ) : (
        Object.entries(connections).map(([key, cfg]: [string, any]) => {
          const driver: string = cfg?.driver ?? cfg?.type ?? 'unknown';
          const isDefault = key === defaultKey;
          const color = DRIVER_COLORS[driver] ?? t.accent;

          if (editing === key) {
            return <ConnectionForm key={key} t={t} editName={editName} setEditName={setEditName}
              editDriver={editDriver} setEditDriver={setEditDriver} editFields={editFields}
              setEditFields={setEditFields} onSave={handleSave} onCancel={cancelEdit}
              onDelete={() => handleDelete(key)} saving={saving} isNew={false} />;
          }

          return (
            <div
              key={key}
              style={{
                ...card,
                borderLeft: isDefault ? `3px solid ${color}` : `1px solid ${t.cellBorder}`,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <DriverLogo driver={driver} size={18} fallbackColor={color} />
                <span style={{ fontSize: 12, fontWeight: 600, color: t.textPrimary, fontFamily: t.font }}>
                  {DRIVER_LABELS[driver] ?? driver}
                </span>
                <span style={{ fontSize: 11, fontFamily: t.fontMono, color: t.textMuted }}>
                  {key}
                </span>
                {isDefault && testResult?.ok && (
                  <span
                    title="Connected"
                    aria-label="Connected"
                    style={{
                      width: 7, height: 7, borderRadius: '50%',
                      background: t.success, flexShrink: 0,
                      boxShadow: `0 0 0 2px ${t.success}25`,
                    }}
                  />
                )}
                {isDefault && testResult && !testResult.ok && (
                  <span
                    title={testResult.message}
                    aria-label="Disconnected"
                    style={{
                      width: 7, height: 7, borderRadius: '50%',
                      background: t.error, flexShrink: 0,
                      boxShadow: `0 0 0 2px ${t.error}25`,
                    }}
                  />
                )}
                {isDefault && (
                  <span style={{ fontSize: 9, color: t.accent, fontFamily: t.font, fontWeight: 600, letterSpacing: '0.05em' }}>DEFAULT</span>
                )}
                <div style={{ flex: 1 }} />
                {!isDefault && (
                  <button
                    onClick={() => handleMakeDefault(key)}
                    disabled={saving}
                    style={{
                      background: 'transparent', border: `1px solid ${t.btnBorder}`,
                      borderRadius: 3, cursor: saving ? 'not-allowed' : 'pointer', color: t.textMuted,
                      fontSize: 10, fontFamily: t.font, padding: '1px 6px', transition: 'all 0.15s',
                    }}
                  >
                    Use
                  </button>
                )}
                <button
                  onClick={() => startEdit(key, cfg)}
                  style={{
                    background: 'transparent', border: `1px solid ${t.btnBorder}`,
                    borderRadius: 3, cursor: 'pointer', color: t.textMuted,
                    fontSize: 10, fontFamily: t.font, padding: '1px 6px', transition: 'all 0.15s',
                  }}
                >
                  Edit
                </button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                {Object.entries(cfg ?? {})
                  .filter(([k]) => k !== 'driver' && k !== 'type')
                  .map(([k, v]) => (
                    <div key={k} style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
                      <span style={{ fontSize: 11, color: t.textMuted, fontFamily: t.fontMono, minWidth: 70, flexShrink: 0 }}>{k}</span>
                      <span style={{ fontSize: 11, color: t.textSecondary, fontFamily: t.fontMono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
                        {isSensitiveField(k) ? '••••••••' : String(v)}
                      </span>
                    </div>
                  ))}
              </div>
            </div>
          );
        })
      )}
      {info !== null && connectionCount === 0 && (
        <div
          style={{
            ...card,
            color: t.textMuted,
            fontSize: 12,
            fontFamily: t.font,
            lineHeight: 1.45,
          }}
        >
          No saved connections yet. Import a dbt profile target or add one manually.
        </div>
      )}
    </>
  );

  const profilePathSection = (
    <div style={{ ...card, marginBottom: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 650, color: t.textPrimary, fontFamily: t.font }}>Import dbt profiles.yml</div>
      <div style={{ marginTop: 3, fontSize: 10.5, color: t.textMuted, lineHeight: 1.45, fontFamily: t.font }}>
        Load a profiles.yml, profiles.yaml, profile.yml, or profile.yaml file. Targets for every warehouse listed below are supported; secrets stay in the private secrets file.
      </div>
      <div style={{ display: 'flex', gap: 7, marginTop: 9 }}>
        <input
          aria-label="dbt profile file or folder path"
          value={profilePath}
          onChange={(event) => setProfilePath(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void previewProfilePath(); } }}
          placeholder="~/.dbt/profiles.yml or /path/to/profile.yaml"
          style={{ flex: 1, minWidth: 0, border: `1px solid ${t.inputBorder}`, borderRadius: 6, background: t.inputBg, color: t.textPrimary, padding: '7px 9px', fontSize: 11.5, fontFamily: t.fontMono, outline: 'none' }}
        />
        <button
          type="button"
          onClick={() => void previewProfilePath()}
          disabled={previewingProfiles}
          style={{ border: `1px solid ${t.btnBorder}`, borderRadius: 6, background: t.btnBg, color: t.textSecondary, padding: '0 11px', fontSize: 11, fontWeight: 650, fontFamily: t.font, cursor: previewingProfiles ? 'wait' : 'pointer' }}
        >
          {previewingProfiles ? 'Reading…' : 'Find profiles'}
        </button>
      </div>
      {profileImportError ? <div role="alert" style={{ marginTop: 6, color: t.error, fontSize: 10.5, fontFamily: t.font }}>{profileImportError}</div> : null}
    </div>
  );

  const dbtProfilesSection = (
    <>
      {!addingNew && !editing && dbtProfileCandidates.length > 0 && (
        <>
          <div style={{ ...sectionLabel, marginTop: 8 }}>dbt profiles</div>
          <div style={{ display: 'grid', gap: 8, marginBottom: 12 }}>
            {dbtProfileCandidates.map((profile) => {
              const driver = normalizeDriverName(String(profile.connection.driver ?? profile.adapter));
              const color = DRIVER_COLORS[driver] ?? t.accent;
              const ready = profile.missingFields.length === 0;
              const activeFromProfile = info?.activeConnection?.source === 'dbt_profile'
                && info.activeConnection.profileId === profile.id;
              return (
                <div
                  key={profile.id}
                  style={{
                    ...card,
                    marginBottom: 0,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                  }}
                >
                  <DriverLogo driver={driver} size={18} fallbackColor={color} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: t.textPrimary, fontFamily: t.font }}>
                        {profile.profileName}
                      </span>
                      <span style={{ fontSize: 11, color: t.textMuted, fontFamily: t.fontMono }}>
                        {profile.targetName}
                      </span>
                    </div>
                    <div style={{ fontSize: 10, color: t.textMuted, fontFamily: t.font, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {DRIVER_LABELS[driver] ?? profile.adapter} from {shortPath(profile.path)}
                    </div>
                    <div style={{ fontSize: 10, color: ready ? t.success : t.warning, fontFamily: t.font, marginTop: 2 }}>
                      {ready
                        ? activeFromProfile ? 'Active runtime connection · import to save' : 'Ready to import and test'
                        : `Imports now · needs ${profile.missingFields.join(', ')}`}
                    </div>
                  </div>
                  <button
                    onClick={() => startAddFromDbtProfile(profile)}
                    disabled={saving}
                    title={profile.warnings.join(' ') || undefined}
                    style={{
                      background: t.btnBg,
                      border: `1px solid ${t.btnBorder}`,
                      borderRadius: 4,
                      cursor: saving ? 'wait' : 'pointer',
                      color: t.textSecondary,
                      fontSize: 11,
                      fontFamily: t.font,
                      padding: '4px 8px',
                      flexShrink: 0,
                    }}
                  >
                    Import & test
                  </button>
                </div>
              );
            })}
          </div>
        </>
      )}
    </>
  );

  const quickConnectSection = (
    <>
      {!addingNew && !editing && Object.keys(connections).length === 0 && (
        <>
          <div style={{ ...sectionLabel, marginTop: 8 }}>Quick Connect</div>
          <div style={{ display: 'grid', gap: 6, marginBottom: 12 }}>
            {QUICK_CONNECT_PRESETS.map((preset) => (
              <button
                key={preset.name}
                onClick={async () => {
                  setSaving(true);
                  try {
                    const conns = { ...connections, [preset.name]: preset.config };
                    await api.saveConnections(conns, preset.name);
                    const refreshed = await api.getConnections();
                    setInfo(refreshed);
                    // Auto-test
                    setTesting(true);
                    const result = await api.testConnection();
                    setTestResult(result);
                    setTesting(false);
                  } finally {
                    setSaving(false);
                  }
                }}
                disabled={saving}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
                  background: t.cellBg, border: `1px solid ${t.cellBorder}`, borderRadius: 7,
                  cursor: saving ? 'not-allowed' : 'pointer', textAlign: 'left' as const,
                  transition: 'border-color 0.15s',
                }}
              >
                <DriverLogo driver={preset.config.driver} size={18} />
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: t.textPrimary, fontFamily: t.font }}>
                    {preset.label}
                  </div>
                  <div style={{ fontSize: 10, color: t.textMuted, fontFamily: t.font }}>
                    {preset.description}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </>
      )}
    </>
  );

  const addConnectionSection = (
    <>
      {addingNew ? (
        <ConnectionForm t={t} editName={editName} setEditName={setEditName}
          editDriver={editDriver} setEditDriver={setEditDriver} editFields={editFields}
          setEditFields={setEditFields} onSave={handleSave} onCancel={cancelEdit}
          saving={saving} isNew />
      ) : (
        <button
          onClick={startAdd}
          style={{
            width: '100%', padding: '7px 0', borderRadius: 6,
            border: `1px dashed ${t.cellBorder}`, background: 'transparent',
            color: t.textSecondary, fontSize: 12, fontFamily: t.font, fontWeight: 500,
            cursor: 'pointer', marginBottom: 12, display: 'flex', alignItems: 'center',
            justifyContent: 'center', gap: 6, transition: 'border-color 0.15s, color 0.15s',
          }}
        >
          <span style={{ fontSize: 16, lineHeight: 1 }}>+</span>
          Add Connection
        </button>
      )}
    </>
  );

  const saveMessageSection = (
    <>
      {saveMsg && (
        <div style={{
          fontSize: 11, fontFamily: t.font, padding: '4px 10px', borderRadius: 4, marginBottom: 8,
          color: saveMessageColor(saveMsg, t),
          background: `${saveMessageColor(saveMsg, t)}12`,
        }}>
          {saveMsg}
        </div>
      )}
    </>
  );

  const testConnectionSection = (
    <>
      <button
        onClick={handleTest}
        disabled={testing || !canTestConnection}
        style={{
          width: '100%', padding: '7px 0', borderRadius: 6,
          border: `1px solid ${t.btnBorder}`, background: t.btnBg,
          color: t.textSecondary, fontSize: 12, fontFamily: t.font, fontWeight: 500,
          cursor: testing || !canTestConnection ? 'not-allowed' : 'pointer', marginBottom: 8,
          opacity: testing || !canTestConnection ? 0.7 : 1, transition: 'all 0.15s',
        }}
      >
        {testing ? 'Testing...' : canTestConnection ? 'Test Connection' : 'Add connection to test'}
      </button>

      {testResult && (
        <div
          style={{
            fontSize: 12, fontFamily: t.font,
            color: testResult.ok ? t.success : t.error,
            background: testResult.ok ? `${t.success}12` : `${t.error}12`,
            border: `1px solid ${testResult.ok ? t.success : t.error}40`,
            borderRadius: 6, padding: '7px 10px', marginBottom: 12,
          }}
        >
          {testResult.ok ? '✓ ' : '✗ '}{testResult.message}
        </div>
      )}
    </>
  );

  const catalogSection = (
    <>
      <div style={{ ...sectionLabel, marginTop: 4 }}>Catalog</div>
      <div
        className={isPage ? 'dql-connection-catalog-grid' : undefined}
        style={{
          display: 'grid',
          gridTemplateColumns: isPage ? 'repeat(auto-fit, minmax(180px, 1fr))' : 'repeat(auto-fill, minmax(160px, 1fr))',
          gap: 8,
          marginBottom: 12,
        }}
      >
        {CONNECTOR_SCHEMAS.map(({ driver, label }) => {
          const color = DRIVER_COLORS[driver] ?? t.accent;
          const tagline = DRIVER_TAGLINES[driver] ?? '';
          const installStatus = connectorStatusByDriver[driver];
          const installed = installStatus?.installed ?? true;
          const builtIn = installStatus?.builtIn ?? false;
          const installing = installingDriver === driver;
          return (
            <div
              key={driver}
              style={{
                background: t.cellBg,
                border: `1px solid ${t.cellBorder}`,
                borderRadius: 8,
                padding: '10px 12px',
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                minHeight: 76,
                position: 'relative',
                transition: 'border-color 0.15s',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <DriverLogo driver={driver} size={18} fallbackColor={color} />
                <span style={{ fontSize: 12, fontWeight: 600, color: t.textPrimary, fontFamily: t.font }}>
                  {label}
                </span>
              </div>
              <div
                style={{
                  fontSize: 10,
                  color: t.textMuted,
                  fontFamily: t.font,
                  lineHeight: 1.35,
                }}
              >
                {tagline}
              </div>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
                marginTop: 'auto',
              }}>
                <span
                  style={{
                    fontSize: 9,
                    fontFamily: t.font,
                    fontWeight: 600,
                    color: installed ? t.success : t.warning,
                    letterSpacing: '0.05em',
                    textTransform: 'uppercase',
                  }}
                >
                  {builtIn ? 'Built in' : installed ? 'Installed' : 'Install required'}
                </span>
                {!installed && (
                  <button
                    onClick={() => handleInstallConnector(driver)}
                    disabled={Boolean(installingDriver)}
                    title={installStatus?.installCommand}
                    style={{
                      border: `1px solid ${t.btnBorder}`,
                      background: t.btnBg,
                      color: t.textSecondary,
                      borderRadius: 4,
                      padding: '2px 7px',
                      fontSize: 10,
                      fontFamily: t.font,
                      cursor: installingDriver ? 'not-allowed' : 'pointer',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {installing ? 'Installing...' : 'Install'}
                  </button>
                )}
              </div>
              <code style={{ fontSize: 9, color: t.textMuted, fontFamily: t.fontMono }}>
                {driver}
              </code>
            </div>
          );
        })}
      </div>
    </>
  );

  const connected = Boolean(info && Object.values(info.connections ?? {}).some((connection) => !isPlaceholderLocalConnection(connection)));
  const metadataStatus = info?.metadataStatus;
  const selectedAdditionalMetadataScopes = parseMetadataScopeEditor(metadataScopeText);
  // RFC 0007: without dbt, the selected schemas are the whole modeled warehouse.
  const warehouseFirst = info?.modelingMode === 'warehouse-first';
  // Guided Setup asks one plain question; index mode, the typed list and the
  // index details sit under Advanced (design D7).
  // A dbt project (new, or an existing one) reads its own schemas; extra
  // warehouse schemas are optional there and sit under Advanced (Codex F06).
  const setupDbtProject = isSetup && (setupSource === 'dbt' || (setupSource === 'existing' && !warehouseFirst));
  const setupSchemaQuestion = isSetup && !setupDbtProject;
  const observedTarget = metadataStatus?.observedTarget
    ? [
      metadataStatus.observedTarget.accountOrWorkspace,
      metadataStatus.observedTarget.role,
      metadataStatus.observedTarget.warehouse,
      metadataStatus.observedTarget.defaultCatalogOrDatabase,
      metadataStatus.observedTarget.defaultSchema,
    ].filter((value): value is string => Boolean(value) && !looksLikeGeneratedId(String(value)))
    : [];
  const metadataScopeEditor = connected ? (
    <div style={{ maxWidth: 640, border: `1px solid ${t.cellBorder}`, borderRadius: 12, background: t.cellBg, padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div>
        <div style={{ fontSize: 14, fontWeight: 700, color: t.textPrimary, fontFamily: t.font }}>{setupSchemaQuestion ? 'Which schemas should ZLens read?' : 'Metadata scope'}</div>
        <div style={{ fontSize: 11.5, color: t.textMuted, marginTop: 3, lineHeight: 1.5, fontFamily: t.font }}>
          {setupSchemaQuestion
            ? `Tick the schemas that hold your tables. ${rowsPrivacy(info?.valueProfile)}`
            : 'ZLens synchronizes this authorized scope into local SQLite. Warm Ask, Notebook, and Saved queries searches use that index instead of scanning the warehouse.'}
        </div>
      </div>
      <div style={{ border: `1px solid ${t.cellBorder}`, borderRadius: 9, padding: '11px 12px', background: t.editorBg, display: 'flex', flexDirection: 'column', gap: 9 }}>
        <div style={{ fontSize: 11.5, lineHeight: 1.5, color: t.textSecondary, fontFamily: t.font, display: setupSchemaQuestion && warehouseFirst ? 'none' : undefined }}>
          {warehouseFirst ? (
            <>
              <strong style={{ color: t.textPrimary }}>Choose the schemas to model.</strong>
              {' '}{rowsPrivacy(info?.valueProfile)}
            </>
          ) : (
            <>
              <strong style={{ color: t.textPrimary }}>Only add schemas outside the configured dbt project.</strong>
              {' '}Relations already present in the current dbt manifest are indexed automatically and should not be selected again.
            </>
          )}
        </div>
        <div>
          <button
            type="button"
            onClick={() => void handleMetadataDiscovery()}
            disabled={metadataDiscovering || metadataSyncing || !testResult?.ok}
            style={{ height: 31, padding: '0 12px', borderRadius: 8, border: `1px solid ${t.cellBorder}`, background: t.cellBg, color: t.textSecondary, fontSize: 11.5, fontWeight: 650, cursor: metadataDiscovering || metadataSyncing || !testResult?.ok ? 'not-allowed' : 'pointer', opacity: !testResult?.ok ? 0.55 : 1, fontFamily: t.font }}
          >
            {metadataDiscovering ? 'Finding available schemas…' : 'Find available databases & schemas'}
          </button>
        </div>
        {metadataDiscovery ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 10.5, color: t.textMuted, fontFamily: t.font }}>
              {warehouseFirst
                ? <>{additionalDiscoveredSchemaCount(metadataDiscovery).toLocaleString()} schema(s) available</>
                : <>{metadataDiscovery.dbtScopes.reduce((count, scope) => count + scope.schemas.length, 0).toLocaleString()} dbt-covered schema(s)
                  {' · '}{additionalDiscoveredSchemaCount(metadataDiscovery).toLocaleString()} additional schema(s) available</>}
              {setupSchemaQuestion ? null : <>{' · '}{metadataDiscovery.queryCount.toLocaleString()} discovery query(s)</>}
            </div>
            {metadataDiscovery.scopes.map((scope) => {
              const { shown: shownSchemas } = splitStagingSchemas(scope.schemas, {
                show: showStagingSchemas,
                keep: (schema) => schema.inDbtProject || metadataScopeIncludes(selectedAdditionalMetadataScopes, scope.catalogOrDatabase, schema.name),
              });
              return (
              <div key={scope.catalogOrDatabase} style={{ borderTop: `1px solid ${t.cellBorder}`, paddingTop: 7 }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, color: t.textPrimary, fontFamily: t.fontMono, marginBottom: 5 }}>
                  {scope.catalogOrDatabase}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 5 }}>
                  {shownSchemas.map((schema) => {
                    const selected = metadataScopeIncludes(
                      selectedAdditionalMetadataScopes,
                      scope.catalogOrDatabase,
                      schema.name,
                    );
                    return (
                      <label
                        key={`${scope.catalogOrDatabase}.${schema.name}`}
                        style={{ display: 'flex', alignItems: 'flex-start', gap: 7, fontSize: 11, lineHeight: 1.35, color: schema.inDbtProject ? t.textMuted : t.textSecondary, fontFamily: t.font, cursor: schema.inDbtProject ? 'default' : 'pointer' }}
                      >
                        <input
                          type="checkbox"
                          checked={schema.inDbtProject || selected}
                          disabled={schema.inDbtProject || metadataSyncing}
                          onChange={(event) => setAdditionalMetadataScope(
                            scope.catalogOrDatabase,
                            schema.name,
                            event.target.checked,
                          )}
                          style={{ marginTop: 1 }}
                        />
                        <span>
                          <span style={{ fontFamily: t.fontMono }}>{schema.name}</span>
                          {schema.inDbtProject
                            ? ` · in dbt (${schema.dbtRelationCount} relation${schema.dbtRelationCount === 1 ? '' : 's'}), included automatically`
                            : warehouseFirst ? '' : ' · outside dbt, select only if reporting needs it'}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
              );
            })}
            {(() => {
              const staging = metadataDiscovery.scopes.flatMap((scope) => scope.schemas.filter((schema) => isStagingSchema(schema.name) && scope.schemas.some((other) => !isStagingSchema(other.name))).map((schema) => schema.name));
              if (!staging.length) return null;
              const names = [...new Set(staging)].join(', ');
              return (
                <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, color: t.textSecondary, fontFamily: t.font, cursor: 'pointer' }}>
                  <input type="checkbox" checked={showStagingSchemas} onChange={(event) => setShowStagingSchemas(event.target.checked)} />
                  <span>Show staging tables <span style={{ color: t.textMuted }}>· {names} hold{staging.length === 1 ? 's' : ''} staging or raw copies</span></span>
                </label>
              );
            })()}
            {metadataDiscovery.truncated ? (
              <div style={{ fontSize: 10.5, color: 'var(--status-warning)', fontFamily: t.font }}>
                Discovery reached its safety limit. Narrow the connection role or enter another known database/schema manually.
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      <AdvancedDisclosure enabled={isSetup} hint="index mode, typed schema list and index details" t={t}>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontFamily: t.font }}>
        <span style={{ fontSize: 11.5, fontWeight: 650, color: t.textSecondary }}>Index mode</span>
        <select
          value={metadataMode}
          onChange={(event) => setMetadataMode(event.target.value as ConnectionMetadataScopeV1['mode'])}
          disabled={metadataSyncing}
          style={{ height: 34, borderRadius: 7, border: `1px solid ${t.cellBorder}`, background: t.cellBg, color: t.textPrimary, padding: '0 10px', fontFamily: t.font }}
        >
          <option value="dbt_relations">Use exact dbt project relations (recommended)</option>
          <option value="dbt_plus_selected">dbt relations plus selected schemas</option>
          <option value="selected_scopes">Selected databases/catalogs and schemas</option>
        </select>
      </label>
      {metadataMode !== 'dbt_relations' ? (
        <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontFamily: t.font }}>
          <span style={{ fontSize: 11.5, fontWeight: 650, color: t.textSecondary }}>Databases/catalogs and schemas</span>
          <textarea
            value={metadataScopeText}
            onChange={(event) => setMetadataScopeText(event.target.value)}
            disabled={metadataSyncing}
            placeholder={'ANALYTICS_PROD: SALES, FINANCE\nREFERENCE_DATA: SHARED'}
            rows={4}
            style={{ resize: 'vertical', borderRadius: 7, border: `1px solid ${t.cellBorder}`, background: t.cellBg, color: t.textPrimary, padding: '8px 10px', fontFamily: t.fontMono, fontSize: 11.5, lineHeight: 1.5 }}
          />
          <span style={{ fontSize: 10.5, color: t.textMuted }}>
            {warehouseFirst ? 'One line per database: DATABASE: SCHEMA, SCHEMA.' : 'Only additional schemas outside dbt belong here.'} Discovery is explicit and setup-only; Ask AI never scans the warehouse for available schemas.
          </span>
        </label>
      ) : null}
      {metadataStatus ? (
        <div style={{ fontSize: 11.5, color: metadataStatus.state === 'ready' ? 'var(--status-success)' : 'var(--status-warning)', fontFamily: t.font }}>
          {metadataStatus.state === 'ready'
            ? 'Warehouse metadata index ready'
            : metadataStatus.state === 'stale'
              ? 'Warehouse metadata refresh required'
              : dbtConfigured
                ? 'Optional warehouse metadata index not synchronized · dbt project objects remain available'
                : 'Warehouse metadata index not synchronized'}
          {' · '}{metadataStatus.relationCount.toLocaleString()} indexed warehouse relations
          {' · '}{metadataStatus.columnCount.toLocaleString()} indexed warehouse columns
          {metadataStatus.capturedAt ? ` · ${new Date(metadataStatus.capturedAt).toLocaleString()}` : ''}
        </div>
      ) : null}
      {isSetup ? (
        <div>
          <button
            type="button"
            onClick={() => void handleMetadataRefresh()}
            disabled={metadataSyncing || metadataStatus?.state === 'missing'}
            style={{ height: 30, padding: '0 12px', borderRadius: 8, border: `1px solid ${t.cellBorder}`, background: t.cellBg, color: t.textSecondary, fontSize: 11.5, fontWeight: 650, cursor: metadataSyncing ? 'not-allowed' : 'pointer', fontFamily: t.font }}
          >
            Refresh metadata
          </button>
        </div>
      ) : null}
      </AdvancedDisclosure>
      {info?.warehouseCatalog ? (
        <div style={{ fontSize: 11.5, color: info.warehouseCatalog.error ? 'var(--status-error)' : info.warehouseCatalog.relations ? 'var(--status-success)' : 'var(--status-warning)', fontFamily: t.font }}>
          {info.warehouseCatalog.error
            ? `Modeling catalog could not be read · ${info.warehouseCatalog.error}`
            : info.warehouseCatalog.relations
              ? `Modeling catalog · ${info.warehouseCatalog.relations.toLocaleString()} tables and views with their keys and comments${info.warehouseCatalog.capturedAt ? ` · ${new Date(info.warehouseCatalog.capturedAt).toLocaleString()}` : ''}`
              : 'Modeling catalog not synchronized · Apply and synchronize to read tables, keys and comments for Modeling'}
        </div>
      ) : null}
      {!isSetup && observedTarget.length ? (
        <div style={{ fontSize: 10.5, color: t.textMuted, fontFamily: t.fontMono }}>
          {observedTarget.join(' · ')}
        </div>
      ) : null}
      {metadataMessage ? (
        <div style={{ fontSize: 11.5, color: metadataMessage.toLowerCase().includes('failed') || metadataMessage.toLowerCase().includes('error') ? 'var(--status-error)' : t.textSecondary, fontFamily: t.font }}>
          {metadataMessage}
        </div>
      ) : null}
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          onClick={() => void handleMetadataApply()}
          disabled={metadataSyncing || !testResult?.ok}
          style={{ height: 32, padding: '0 13px', borderRadius: 8, border: 'none', background: t.accent, color: 'var(--accent-fg)', fontSize: 12, fontWeight: 700, cursor: metadataSyncing || !testResult?.ok ? 'not-allowed' : 'pointer', opacity: metadataSyncing || !testResult?.ok ? 0.55 : 1, fontFamily: t.font }}
        >
          {metadataSyncing ? 'Synchronizing…' : 'Apply and synchronize'}
        </button>
        {isSetup ? null : (
          <button
            type="button"
            onClick={() => void handleMetadataRefresh()}
            disabled={metadataSyncing || metadataStatus?.state === 'missing'}
            style={{ height: 32, padding: '0 13px', borderRadius: 8, border: `1px solid ${t.cellBorder}`, background: t.cellBg, color: t.textSecondary, fontSize: 12, fontWeight: 650, cursor: metadataSyncing ? 'not-allowed' : 'pointer', fontFamily: t.font }}
          >
            Refresh metadata
          </button>
        )}
      </div>
      {!testResult?.ok ? (
        <div style={{ fontSize: 10.5, color: t.textMuted, fontFamily: t.font }}>Test the active connection before applying its metadata scope.</div>
      ) : null}
    </div>
  ) : null;
  const databaseEditor = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <div style={{ fontSize: 17, fontWeight: 700, color: t.textPrimary, fontFamily: t.font }}>Database connection</div>
        <div style={{ fontSize: 12.5, color: t.textMuted, marginTop: 3, lineHeight: 1.5, fontFamily: t.font }}>
          {isSetup && setupSource === 'warehouse'
            ? 'Connect the database directly. ZLens tests it before it replaces the active connection.'
            : 'Import a dbt profile or enter the warehouse details. A new connection replaces the current one only after its test passes.'}
        </div>
      </div>
      <div style={{ border: `1px solid ${testResult?.ok ? 'var(--status-success-border)' : 'var(--border-subtle)'}`, borderRadius: 12, background: t.cellBg, padding: '16px 18px', display: 'flex', alignItems: 'center', gap: 12, maxWidth: 640 }}>
        <span style={{ width: 36, height: 36, borderRadius: 9, background: connected ? 'var(--status-success-bg)' : 'var(--status-warning-bg)', color: connected ? 'var(--status-success)' : 'var(--status-warning)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <Database size={17} strokeWidth={1.75} />
        </span>
        <div style={{ flex: 1, minWidth: 0, fontFamily: t.font }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: t.textPrimary }}>
            {!info ? 'Reading connection…' : (DRIVER_LABELS[String(info.connections?.[info.default ?? '']?.driver ?? '')] ?? info.connections?.[info.default ?? '']?.driver ?? 'No connection yet')}
            {connected ? ' · configured' : ''}
          </div>
          <div style={{ fontSize: 11.5, marginTop: 2, color: testing ? t.textMuted : testResult ? (testResult.ok ? 'var(--status-success)' : 'var(--status-error)') : t.textMuted }}>
            {testing ? 'Testing…' : testResult ? (testResult.ok ? `Test passed · ${testResult.message}` : `Test failed · ${testResult.message}`) : connected ? 'Configured — run Test connection to verify.' : 'Add a connection below to get started.'}
          </div>
        </div>
        <button type="button" onClick={() => void handleTest()} disabled={testing || !connected} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 30, padding: '0 13px', borderRadius: 8, border: `1px solid ${t.cellBorder}`, background: t.cellBg, color: t.textSecondary, fontSize: 12, fontWeight: 650, cursor: connected ? 'pointer' : 'not-allowed', fontFamily: t.font, flexShrink: 0, opacity: connected ? 1 : 0.55 }}>
          {testing ? 'Testing…' : 'Test connection'}
        </button>
      </div>
      {isSetup && setupPrimaryAction ? setupPrimaryAction : null}
      {/* Database only has no dbt: personal ~/.dbt profiles never show there (design D7). */}
      {isSetup && setupSource === 'warehouse' ? null : (
        <AdvancedDisclosure enabled={isSetup} label="Import from a dbt profile" hint="profiles.yml" t={t}>
          <div style={{ maxWidth: 640 }}>
            {profilePathSection}
            {dbtProfilesSection}
          </div>
        </AdvancedDisclosure>
      )}
      <DatabaseConnectionForm
        t={t}
        driver={primaryDriver}
        fields={primaryFields}
        onDriverChange={changePrimaryDriver}
        onFieldsChange={setPrimaryFields}
        onSave={() => void handlePrimarySave()}
        saving={saving}
        saveMessage={saveMsg}
        connectorStatus={connectorStatusByDriver[primaryDriver]}
        installing={installingDriver === primaryDriver}
        onInstall={() => void handleInstallConnector(primaryDriver)}
      />
      {setupDbtProject && metadataScopeEditor
        ? <AdvancedDisclosure enabled label="Advanced" hint={EXTRA_SCHEMAS_HINT} t={t}>{metadataScopeEditor}</AdvancedDisclosure>
        : metadataScopeEditor}
    </div>
  );

  if (isSetup) return databaseEditor;

  if (isPage) {
    const activeTab = state.settingsTab;
    const aiConfigured = providerReadiness.some((provider) => provider.configured && provider.enabled);
    const navItem = (
      active: boolean,
      label: string,
      onClick: () => void,
      right?: React.ReactNode,
    ) => (
      <button
        key={label}
        type="button"
        onClick={onClick}
        style={{
          display: 'flex', alignItems: 'center', gap: 9, padding: '8px 10px', borderRadius: 7,
          border: 'none', cursor: 'pointer', textAlign: 'left', fontSize: 12.5, fontWeight: 600,
          fontFamily: t.font, width: '100%',
          background: active ? 'var(--accent-dim)' : 'transparent',
          color: active ? t.accent : t.textSecondary,
        }}
      >
        <span style={{ flex: 1 }}>{label}</span>
        {right}
      </button>
    );

    // A warehouse-first project is set up once its warehouse catalog is synced (RFC 0007).
    const projectReady = dbtConfigured || (info?.modelingMode === 'warehouse-first' && Boolean(info.warehouseCatalog?.relations));
    return (
      <>
        <style>{CONNECTION_PAGE_STYLES}</style>
        <div style={{ display: 'flex', gap: 0, alignItems: 'stretch', minHeight: 0 }}>
          <nav aria-label="Settings sections" style={{ width: 'clamp(190px, 17vw, 240px)', flexShrink: 0, borderRight: `1px solid ${t.cellBorder}`, padding: '10px 10px 10px 0', display: 'flex', flexDirection: 'column', gap: 2, alignSelf: 'flex-start', position: 'sticky', top: 0 }}>
            {navItem(activeTab === 'overview', 'Overview', () => dispatch({ type: 'SET_SETTINGS_TAB', tab: 'overview' }))}
            {navItem(activeTab === 'project', 'Project & dbt', () => dispatch({ type: 'SET_SETTINGS_TAB', tab: 'project' }),
              <span style={{ width: 7, height: 7, borderRadius: 999, background: dbtPreparation?.status === 'failed' ? 'var(--status-error)' : dbtPreparation?.status === 'running' || dbtPreparation?.status === 'queued' ? 'var(--status-info)' : projectReady ? 'var(--status-success)' : 'var(--status-warning)' }} title={dbtPreparation?.status === 'failed' ? 'Needs attention' : dbtPreparation?.status === 'running' || dbtPreparation?.status === 'queued' ? 'Preparing' : projectReady ? 'Ready' : 'Missing'} />)}
            {navItem(activeTab === 'database', 'Database', () => dispatch({ type: 'SET_SETTINGS_TAB', tab: 'database' }),
              <span style={{ width: 7, height: 7, borderRadius: 999, background: connected ? 'var(--status-success)' : 'var(--status-warning)' }} title={connected ? 'Configured' : 'Missing'} />)}
            {navItem(activeTab === 'ai', 'AI provider', () => dispatch({ type: 'SET_SETTINGS_TAB', tab: 'ai' }),
              <span style={{ width: 7, height: 7, borderRadius: 999, background: aiConfigured ? 'var(--status-success)' : 'var(--status-warning)' }} title={aiConfigured ? 'Configured' : 'Optional · missing'} />)}
            {navItem(activeTab === 'memory', 'Agent memory', () => dispatch({ type: 'SET_SETTINGS_TAB', tab: 'memory' }))}
            <div style={{ height: 1, background: t.cellBorder, margin: '10px 10px 10px 0' }} />
            {navItem(activeTab === 'advanced', 'Advanced', () => dispatch({ type: 'SET_SETTINGS_TAB', tab: 'advanced' }),
              <span style={{ fontSize: 10, color: t.textMuted }}>Advanced</span>)}
          </nav>
          <div style={{ flex: 1, minWidth: 0, padding: '0 0 24px 20px' }}>
            {activeTab === 'overview' ? (
              <SettingsOverview
                warehouseFirst={info?.modelingMode === 'warehouse-first'}
                warehouseCatalog={info?.warehouseCatalog}
                dbtConfigured={dbtConfigured}
                dbtPreparation={dbtPreparation}
                databaseConfigured={connected}
                databaseTest={testResult}
                providers={providerReadiness}
              />
            ) : activeTab === 'project' ? (
              <DbtProjectEditor onConfigured={() => {
                setDbtConfigured(true);
                void api.getOnboardingStatus().then((onboarding) => setDbtPreparation(onboarding.preparation ?? null)).catch(() => undefined);
              }} />
            ) : activeTab === 'advanced' ? (
              <ConnectionRuntimeSettings embedded section="advanced" />
            ) : activeTab === 'database' ? (
              databaseEditor
            ) : activeTab === 'ai' ? (
              <ConnectionRuntimeSettings embedded section="providers" onProviderConfigured={(provider) => setProviderReadiness((current) => current.map((entry) => entry.id === provider.id ? provider : { ...entry, active: false }))} />
            ) : (
              <ConnectionRuntimeSettings embedded section="memory" />
            )}
          </div>
        </div>
      </>
    );
  }

  return (
    <PanelFrame title="Connections" bodyPadding={12}>
      {connectionListSection}
      {profilePathSection}
      {dbtProfilesSection}
      {quickConnectSection}
      {addConnectionSection}
      {saveMessageSection}
      {testConnectionSection}
      {catalogSection}
    </PanelFrame>
  );
}

function SettingsOverview({
  warehouseFirst = false,
  warehouseCatalog,
  dbtConfigured,
  dbtPreparation,
  databaseConfigured,
  databaseTest,
  providers,
}: {
  /** The project models its warehouse directly, without dbt (RFC 0007). */
  warehouseFirst?: boolean;
  warehouseCatalog?: WarehouseCatalogSummary;
  dbtConfigured: boolean;
  dbtPreparation: DbtOnboardingJob | null;
  databaseConfigured: boolean;
  databaseTest: { ok: boolean; message: string } | null;
  providers: ProviderSettings[];
}) {
  const themeMode = useNotebookStore((state) => state.themeMode);
  const dispatch = useDispatch();
  const t = themes[themeMode];
  const activeProvider = providers.find((provider) => provider.active && provider.configured)
    ?? providers.find((provider) => provider.enabled && provider.configured);
  const cards: Array<{
    title: string;
    detail: string;
    state: 'missing' | 'configured' | 'preparing' | 'passed' | 'failed';
    tab: 'project' | 'database' | 'ai';
    icon: React.ReactNode;
    optional?: boolean;
  }> = [
    warehouseFirst ? {
      title: 'Project',
      detail: warehouseCatalog?.relations
        ? `Warehouse modeling · ${warehouseCatalog.relations.toLocaleString()} tables and views synced. Add a dbt project here any time.`
        : 'Warehouse modeling · sync schema in Database to read your tables, keys and comments.',
      state: warehouseCatalog?.relations ? 'configured' : 'missing',
      tab: 'project',
      icon: <GitBranch size={18} />,
    } : {
      title: 'Project & dbt',
      ...projectDbtCard(dbtConfigured, dbtPreparation),
      tab: 'project',
      icon: <GitBranch size={18} />,
    },
    {
      title: 'Database',
      detail: databaseTest?.ok
        ? databaseTest.message
        : databaseTest
          ? databaseTest.message
          : databaseConfigured
            ? 'Credentials are configured. Run Test to verify reachability.'
            : 'Import a dbt profile or enter warehouse credentials.',
      state: databaseTest ? (databaseTest.ok ? 'passed' : 'failed') : databaseConfigured ? 'configured' : 'missing',
      tab: 'database',
      icon: <Database size={18} />,
    },
    {
      title: 'AI provider',
      detail: activeProvider
        ? `${activeProvider.label}${activeProvider.model ? ` · ${activeProvider.model}` : ''}. Run Test to verify reachability.`
        : 'Optional. Deterministic and non-AI workflows remain available.',
      state: activeProvider ? 'configured' : 'missing',
      tab: 'ai',
      icon: <Sparkles size={18} />,
      optional: true,
    },
  ];
  const stateCopy = {
    missing: 'Missing',
    configured: 'Configured',
    preparing: 'Preparing',
    passed: 'Test passed',
    failed: 'Test failed',
  } as const;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 820 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 750, color: t.textPrimary }}>Settings overview</div>
          <div style={{ fontSize: 12.5, color: t.textMuted, marginTop: 4, lineHeight: 1.5 }}>One place for project, data, AI, memory, and advanced runtime configuration.</div>
        </div>
        <button type="button" onClick={() => dispatch({ type: 'OPEN_SETUP' })} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, height: 34, padding: '0 15px', borderRadius: 8, border: 'none', background: t.accent, color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: t.font, whiteSpace: 'nowrap' }}>
          <Settings2 size={14} /> Guided Setup
        </button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 12 }}>
        {cards.map((card) => {
          const positive = card.state === 'configured' || card.state === 'passed';
          const preparing = card.state === 'preparing';
          const failed = card.state === 'failed';
          const color = failed ? 'var(--status-error)' : preparing ? 'var(--status-info)' : positive ? 'var(--status-success)' : 'var(--status-warning)';
          const bg = failed ? 'var(--status-error-bg)' : preparing ? 'var(--status-info-bg)' : positive ? 'var(--status-success-bg)' : 'var(--status-warning-bg)';
          return (
            <button key={card.title} type="button" onClick={() => dispatch({ type: 'SET_SETTINGS_TAB', tab: card.tab })} style={{ border: '1px solid var(--border-subtle)', borderRadius: 12, background: t.cellBg, padding: 16, textAlign: 'left', cursor: 'pointer', fontFamily: t.font, minHeight: 158, display: 'flex', flexDirection: 'column' }}>
              <span style={{ width: 36, height: 36, borderRadius: 9, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color, background: bg }}>{positive ? <CheckCircle2 size={18} /> : card.icon}</span>
              <span style={{ fontSize: 13.5, fontWeight: 700, color: t.textPrimary, marginTop: 12 }}>{card.title}</span>
              <span style={{ fontSize: 11, fontWeight: 700, color, marginTop: 4 }}>{stateCopy[card.state]}{card.optional ? ' · optional' : ''}</span>
              <span style={{ fontSize: 11.5, color: t.textMuted, lineHeight: 1.45, marginTop: 7 }}>{card.detail}</span>
            </button>
          );
        })}
      </div>
      {!activeProvider ? (
        <div style={{ border: '1px solid var(--status-info-border)', background: 'var(--status-info-bg)', color: t.textSecondary, borderRadius: 10, padding: '11px 13px', fontSize: 11.5, lineHeight: 1.5 }}>
          Limited-AI mode is active: SQL execution, dbt metadata, lineage, deterministic helpers, and other non-AI paths continue to work. Configure a provider when you want governed Ask and AI-assisted authoring.
        </div>
      ) : null}
    </div>
  );
}

const CONNECTION_PAGE_STYLES = `
.dql-connection-page-stack {
  display: grid;
  gap: 16px;
}

.dql-connection-page-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.18fr) minmax(320px, 0.82fr);
  gap: 16px;
  align-items: start;
}

@media (max-width: 920px) {
  .dql-connection-page-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

@keyframes dql-connector-shimmer {
  0% { opacity: 1; }
  50% { opacity: 0.45; }
  100% { opacity: 1; }
}

.dql-connector-installing {
  animation: dql-connector-shimmer 1.4s ease-in-out infinite;
}
`;

function ConnectionForm({
  t, editName, setEditName, editDriver, setEditDriver, editFields, setEditFields,
  onSave, onCancel, onDelete, saving, isNew,
}: {
  t: Theme;
  editName: string; setEditName: (v: string) => void;
  editDriver: string; setEditDriver: (v: string) => void;
  editFields: Record<string, string>; setEditFields: (v: Record<string, string>) => void;
  onSave: () => void; onCancel: () => void;
  onDelete?: () => void;
  saving: boolean; isNew: boolean;
}) {
  const schema = CONNECTOR_SCHEMA_BY_DRIVER[editDriver];
  const fields = (schema?.fields ?? []).filter((field) => fieldApplies(field, editFields));

  const inputStyle = {
    background: t.inputBg,
    border: `1px solid ${t.inputBorder}`,
    borderRadius: 4,
    color: t.textPrimary,
    fontSize: 11,
    fontFamily: t.fontMono,
    padding: '4px 8px',
    outline: 'none',
    width: '100%',
  };

  const labelStyle = {
    fontSize: 9,
    fontWeight: 600 as const,
    color: t.textMuted,
    fontFamily: t.font,
    letterSpacing: '0.05em',
    textTransform: 'uppercase' as const,
    marginBottom: 2,
  };

  return (
    <div style={{
      background: t.cellBg, border: `1px solid ${t.accent}40`, borderRadius: 7,
      padding: '10px 12px', marginBottom: 10,
    }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: t.accent, fontFamily: t.font, marginBottom: 8 }}>
        {isNew ? 'New Connection' : 'Edit Connection'}
      </div>

      {/* Connection name */}
      <div style={{ marginBottom: 6 }}>
        <div style={labelStyle}>Name</div>
        <input style={inputStyle} value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="e.g. production" />
      </div>

      {/* Driver */}
      <div style={{ marginBottom: 6 }}>
        <div style={labelStyle}>Driver</div>
        <select
          style={{ ...inputStyle, fontFamily: t.font }}
          value={editDriver}
          onChange={(e) => { setEditDriver(e.target.value); setEditFields({}); }}
        >
          {CONNECTOR_SCHEMAS.map((schema) => (
            <option key={schema.driver} value={schema.driver}>{schema.label}</option>
          ))}
        </select>
      </div>

      {/* Driver-specific fields */}
      {fields.map((field) => (
        <div key={field.key} style={{ marginBottom: 6 }}>
          <div style={labelStyle}>
            {field.label}
            {field.required ? ' *' : ''}
          </div>
          {field.type === 'select' ? (
            <select
              style={{ ...inputStyle, fontFamily: t.font }}
              value={editFields[field.key] ?? ''}
              onChange={(e) => setEditFields({ ...editFields, [field.key]: e.target.value })}
            >
              <option value="">Default</option>
              {(field.options ?? []).map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          ) : field.type === 'checkbox' ? (
            <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, color: t.textSecondary, fontFamily: t.font }}>
              <input
                type="checkbox"
                checked={editFields[field.key] === 'true'}
                onChange={(e) => setEditFields({ ...editFields, [field.key]: e.target.checked ? 'true' : 'false' })}
              />
              Enabled
            </label>
          ) : field.type === 'textarea' ? (
            <textarea
              style={{ ...inputStyle, minHeight: 72, resize: 'vertical' as const }}
              value={editFields[field.key] ?? ''}
              placeholder={field.placeholder ?? ''}
              onChange={(e) => setEditFields({ ...editFields, [field.key]: e.target.value })}
            />
          ) : (
            <input
              style={inputStyle}
              type={field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text'}
              value={editFields[field.key] ?? ''}
              placeholder={field.placeholder ?? ''}
              onChange={(e) => setEditFields({ ...editFields, [field.key]: e.target.value })}
            />
          )}
          {field.helpText && (
            <div style={{ fontSize: 10, color: t.textMuted, fontFamily: t.font, marginTop: 3, lineHeight: 1.35 }}>
              {field.helpText}
            </div>
          )}
        </div>
      ))}

      {/* Buttons */}
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <button
          onClick={onSave}
          disabled={saving}
          style={{
            flex: 1, padding: '5px 0', borderRadius: 5, border: 'none',
            background: t.accent, color: '#fff', fontSize: 11, fontFamily: t.font,
            fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.6 : 1,
          }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          onClick={onCancel}
          style={{
            padding: '5px 12px', borderRadius: 5, border: `1px solid ${t.btnBorder}`,
            background: 'transparent', color: t.textSecondary, fontSize: 11, fontFamily: t.font,
            cursor: 'pointer',
          }}
        >
          Cancel
        </button>
        {onDelete && !isNew && (
          <button
            onClick={onDelete}
            style={{
              padding: '5px 12px', borderRadius: 5, border: `1px solid ${t.error}40`,
              background: 'transparent', color: t.error, fontSize: 11, fontFamily: t.font,
              cursor: 'pointer',
            }}
          >
            Delete
          </button>
        )}
      </div>
    </div>
  );
}

// Keep the manual enterprise path short: show shared connection context plus
// the credentials for the selected auth method. Everything uncommon remains
// available under Advanced options or is carried through untouched from dbt.
function primaryFieldKeys(driver: string, fields: Record<string, string>): string[] {
  const declared = CONNECTOR_SCHEMA_BY_DRIVER[driver]?.primary;
  if (declared) return declared(fields.authMethod ?? '');
  if (driver === 'duckdb' || driver === 'sqlite') return ['filepath'];
  if (driver === 'file') return ['dataFolder'];
  if (driver === 'databricks') return ['host', 'httpPath', 'database', 'schema', 'authMethod', 'token'];
  if (driver !== 'snowflake') return [];

  const common = ['account', 'warehouse', 'database', 'schema', 'username', 'authMethod'];
  switch (fields.authMethod || 'password') {
    case 'key_pair':
      return [...common, 'privateKeyPath', 'privateKey', 'privateKeyPassphrase'];
    case 'external_browser':
      return common;
    case 'oauth':
    case 'programmatic_access_token':
      return [...common, 'token'];
    case 'oauth_authorization_code':
      return [...common, 'oauthClientId', 'oauthClientSecret'];
    case 'oauth_client_credentials':
      return [...common, 'oauthClientId', 'oauthClientSecret', 'oauthTokenRequestUrl'];
    case 'workload_identity':
      return [...common, 'workloadIdentityProvider', 'token'];
    case 'mfa':
      return [...common, 'password', 'passcode'];
    default:
      return [...common, 'password'];
  }
}

// Fields that should span the full form width rather than sit in the 2-col grid.
const FULL_WIDTH_FIELDS = new Set(['filepath', 'httpPath', 'accessUrl']);

function DatabaseConnectionForm({
  t,
  driver,
  fields,
  onDriverChange,
  onFieldsChange,
  onSave,
  saving,
  saveMessage,
  connectorStatus,
  installing,
  onInstall,
}: {
  t: Theme;
  driver: string;
  fields: Record<string, string>;
  onDriverChange: (driver: string) => void;
  onFieldsChange: (fields: Record<string, string>) => void;
  onSave: () => void;
  saving: boolean;
  saveMessage: string | null;
  connectorStatus?: ConnectorInstallStatus;
  installing: boolean;
  onInstall: () => void;
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const schema = CONNECTOR_SCHEMA_BY_DRIVER[driver];
  const allFields = (schema?.fields ?? []).filter((field) => fieldApplies(field, fields));
  const primaryKeys = primaryFieldKeys(driver, fields);
  const primaryKeySet = new Set(primaryKeys);
  // Preserve the schema's declared order within each group.
  const primaryFields = allFields.filter((f) => primaryKeySet.has(f.key));
  const advancedFields = allFields.filter((f) => !primaryKeySet.has(f.key));
  const setField = (key: string, value: string) => onFieldsChange({ ...fields, [key]: value });

  return (
    <div style={{ border: `1px solid ${t.cellBorder}`, borderRadius: 12, background: t.cellBg, padding: 18, display: 'flex', flexDirection: 'column', gap: 13, maxWidth: 640 }}>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 280 }}>
        <span style={{ fontSize: 11, fontWeight: 650, color: t.textSecondary, fontFamily: t.font }}>Warehouse</span>
        <select
          value={driver}
          onChange={(e) => onDriverChange(e.target.value)}
          style={{ border: `1px solid ${t.cellBorder}`, background: t.cellBg, borderRadius: 8, padding: '8px 9px', fontSize: 12.5, fontFamily: t.font, color: t.textPrimary, outline: 'none' }}
        >
          {CONNECTOR_SCHEMAS.map(({ driver: value, label }) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </label>

      {/* Catalog install status for the selected warehouse's connector. */}
      <ConnectorStatusRow
        t={t}
        driver={driver}
        label={schema?.label ?? driver}
        status={connectorStatus}
        installing={installing}
        onInstall={onInstall}
      />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {primaryFields.map((field) => (
          <StyledField
            key={field.key}
            t={t}
            field={field}
            value={fields[field.key] ?? ''}
            onChange={(v) => setField(field.key, v)}
            fullWidth={FULL_WIDTH_FIELDS.has(field.key)}
          />
        ))}
      </div>

      {advancedFields.length > 0 && (
        <details
          open={advancedOpen}
          onToggle={(e) => setAdvancedOpen((e.target as HTMLDetailsElement).open)}
          style={{ borderTop: `1px solid ${t.headerBorder}`, paddingTop: 12 }}
        >
          <summary style={{ cursor: 'pointer', listStyle: 'none', display: 'flex', alignItems: 'center', gap: 7, fontSize: 11.5, fontWeight: 650, color: t.textSecondary, fontFamily: t.font }}>
            <span style={{ color: t.textMuted, fontSize: 10, transform: advancedOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s', display: 'inline-block' }}>▶</span>
            Advanced options
            <span style={{ fontWeight: 400, color: t.textMuted, fontSize: 10.5 }}>{advancedFields.length} more</span>
          </summary>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
            {advancedFields.map((field) => (
              <StyledField
                key={field.key}
                t={t}
                field={field}
                value={fields[field.key] ?? ''}
                onChange={(v) => setField(field.key, v)}
                fullWidth={FULL_WIDTH_FIELDS.has(field.key) || field.type === 'textarea'}
              />
            ))}
          </div>
        </details>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 4, borderTop: `1px solid ${t.headerBorder}` }}>
        <span style={{ fontSize: 10.5, color: t.textMuted, flex: 1, fontFamily: t.font }}>
          {saveMessage ?? 'Changes apply after a successful test.'}
        </span>
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          style={{ height: 30, padding: '0 15px', borderRadius: 8, border: 'none', background: t.accent, color: '#fff', fontSize: 12, fontWeight: 650, cursor: saving ? 'not-allowed' : 'pointer', fontFamily: t.font, boxShadow: '0 1px 4px rgba(107,93,211,0.25)', opacity: saving ? 0.7 : 1 }}
        >
          {saving ? 'Saving…' : 'Save connection'}
        </button>
      </div>
    </div>
  );
}

/**
 * Catalog install status for the selected warehouse's driver connector.
 * Mirrors the Setup Onboarding "catalog driver row": built-in drivers show
 * ready, installed drivers show a check, and drivers that need their package
 * show an Install action (→ installing shimmer → installed).
 */
function ConnectorStatusRow({
  t,
  driver,
  label,
  status,
  installing,
  onInstall,
}: {
  t: Theme;
  driver: string;
  label: string;
  status?: ConnectorInstallStatus;
  installing: boolean;
  onInstall: () => void;
}) {
  // Absent status = built-in/bundled driver (e.g. DuckDB) — treat as ready.
  const builtIn = status?.builtIn ?? true;
  const installed = status?.installed ?? true;
  const needsInstall = !installed && !builtIn;

  const tone = installing ? t.warning : needsInstall ? t.warning : t.success;
  const toneBg = installing ? 'var(--status-warning-bg)' : needsInstall ? 'var(--status-warning-bg)' : 'var(--status-success-bg)';
  const toneBorder = installing ? 'var(--status-warning-border)' : needsInstall ? 'var(--status-warning-border)' : 'var(--status-success-border)';
  const statusText = installing
    ? 'Installing connector package…'
    : builtIn
      ? 'Built in — no installation needed'
      : installed
        ? 'Connector installed and ready'
        : 'Connector package required before you can connect';

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, border: `1px solid ${toneBorder}`, borderRadius: 9, background: toneBg, padding: '10px 12px' }}>
      <DriverLogo driver={driver} size={18} fallbackColor={DRIVER_COLORS[driver] ?? t.accent} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 650, color: t.textPrimary, fontFamily: t.font }}>{label} connector</div>
        <div
          className={installing ? 'dql-connector-installing' : undefined}
          style={{ fontSize: 11, color: tone, fontFamily: t.font, marginTop: 1 }}
        >
          {statusText}
        </div>
      </div>
      {needsInstall || installing ? (
        <button
          type="button"
          onClick={onInstall}
          disabled={installing}
          title={status?.installCommand}
          style={{ flexShrink: 0, height: 28, padding: '0 12px', borderRadius: 8, border: `1px solid ${t.accent}`, background: 'var(--accent-dim)', color: t.accent, fontSize: 11.5, fontWeight: 650, cursor: installing ? 'not-allowed' : 'pointer', fontFamily: t.font, opacity: installing ? 0.75 : 1 }}
        >
          {installing ? 'Installing…' : 'Install connector'}
        </button>
      ) : (
        <span style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 650, color: tone, fontFamily: t.font }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
          {builtIn ? 'Ready' : 'Installed'}
        </span>
      )}
    </div>
  );
}

/** A single labelled form control styled to the Settings-redesign prototype. */
function StyledField({
  t,
  field,
  value,
  onChange,
  fullWidth,
}: {
  t: Theme;
  field: ConnectorFieldSchema;
  value: string;
  onChange: (value: string) => void;
  fullWidth?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  const borderColor = focused ? t.accent : t.cellBorder;
  const controlBase: React.CSSProperties = {
    border: `1px solid ${borderColor}`,
    background: t.cellBg,
    borderRadius: 8,
    padding: '8px 10px',
    fontSize: 12,
    fontFamily: t.fontMono,
    color: t.textPrimary,
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box',
  };
  const wrapStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    gridColumn: fullWidth ? '1 / -1' : undefined,
  };
  const labelNode = (
    <span style={{ fontSize: 11, fontWeight: 650, color: t.textSecondary, fontFamily: t.font }}>
      {field.label}{field.required ? ' *' : ''}
    </span>
  );

  if (field.type === 'checkbox') {
    return (
      <label style={{ ...wrapStyle, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <input
          type="checkbox"
          checked={value === 'true'}
          onChange={(e) => onChange(e.target.checked ? 'true' : 'false')}
        />
        {labelNode}
      </label>
    );
  }

  return (
    <label style={wrapStyle}>
      {labelNode}
      {field.type === 'select' ? (
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={{ ...controlBase, fontFamily: t.font, fontSize: 12.5, padding: '8px 9px' }}
        >
          <option value="">Default</option>
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      ) : field.type === 'textarea' ? (
        <textarea
          value={value}
          placeholder={field.placeholder ?? ''}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={{ ...controlBase, minHeight: 72, resize: 'vertical' }}
        />
      ) : (
        <input
          type={field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text'}
          value={value}
          placeholder={field.placeholder ?? ''}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={controlBase}
        />
      )}
      {field.helpText && (
        <span style={{ fontSize: 10, color: t.textMuted, fontFamily: t.font, lineHeight: 1.35 }}>{field.helpText}</span>
      )}
    </label>
  );
}

/** The modeling catalog's part of a sync message (warehouse-first and hybrid modeling). */
function warehouseCatalogMessage(catalog: WarehouseCatalogSummary | undefined): string {
  if (!catalog) return '';
  if (catalog.error) return ` · modeling catalog failed: ${catalog.error}`;
  if (catalog.skipped) return ` · modeling catalog unchanged: ${catalog.skipped}`;
  const warnings = catalog.warnings?.length ? ` (${catalog.warnings.length} part${catalog.warnings.length === 1 ? '' : 's'} not read: ${catalog.warnings[0]})` : '';
  const drift = catalog.drift;
  const changes = drift
    ? [
      drift.removedRelations.length ? `${drift.removedRelations.length} table(s) removed` : '',
      drift.removedColumns.length ? `${drift.removedColumns.length} column(s) removed` : '',
      drift.changedColumnTypes.length ? `${drift.changedColumnTypes.length} type change(s)` : '',
      drift.addedRelations.length ? `${drift.addedRelations.length} new table(s)` : '',
      drift.addedColumns.length ? `${drift.addedColumns.length} new column(s)` : '',
    ].filter(Boolean).join(', ')
    : '';
  const review = drift?.affected.length ? `; review ${drift.affected.length} modeled object(s) in Modeling` : '';
  return ` · modeling catalog ${catalog.relations ?? 0} tables and views${warnings}${changes ? ` · changed since last sync: ${changes}${review}` : ''}`;
}

