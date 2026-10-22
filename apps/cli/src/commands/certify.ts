import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  DataLexContractRegistry,
  Parser,
  analyze,
  certifiedBlockFileState,
  changedSinceCertifiedMessage,
  resolveDataLexManifestPath,
  resolveSemanticLayerWithDiagnostics,
  type Diagnostic as CoreDiagnostic,
} from '@zlens/core';
import { Certifier, ENTERPRISE_RULES, evaluateInvariants, type InvariantResult } from '@zlens/governance';
import type { BlockRecord, TestResultSummary, TestAssertionResult } from '@zlens/project';
import { QueryExecutor, type ConnectionConfig } from '@zlens/connectors';
import { buildExecutionPlan, type NotebookCell } from '@zlens/notebook';
import { loadProjectConfig, prepareLocalExecution, normalizeProjectConnection, resolveProjectSemanticConfig, resolveSemanticTableMapping } from '../local-runtime.js';
import type { ProjectConfig } from '../local-runtime.js';
import type { CLIFlags } from '../args.js';
import { promoteFromDraft } from '../promote-from-draft.js';
import { localPersonIdentity, passedCheckNames } from '../certification-receipt.js';
import { blockTestAssertionName, evaluateBlockTestAssertion, formatBlockTestExpected } from '../block-test-assertions.js';
import { startProjectRuntime } from './notebook.js';
import { WorkbenchRoutedQueryExecutor } from '../workbench-query-route.js';
import { findRunningNotebook, serverTokenFor } from '../schedule/notebook-runtime.js';

/**
 * Run the same certification rules Block Studio's Certify runs (owner, a
 * successful compile and run on the project connection, passing tests) by
 * asking an ephemeral local runtime for its read-only certification check.
 * Nothing is written by the check itself.
 */
async function runtimeCertificationGate(
  projectRoot: string,
  flags: CLIFlags,
  source: string,
): Promise<{ ok: boolean; blockers: string[]; checks: string[]; warnings: string[]; enterprise: boolean }> {
  const enterprise = flags.enterprise === true;
  const projectConfig = loadProjectConfig(projectRoot);
  // The workbench serving this project runs the check when it is up: it holds
  // the DuckDB file open, so a second runtime could not open it (Block
  // Studio's Certify runs this same check there). Otherwise an ephemeral one.
  const running = flags.connection ? null : await findRunningNotebook(projectRoot).catch(() => null);
  const token = running ? serverTokenFor(running.loopback) : undefined;
  if (running && flags.format !== 'json') console.error(`  Running the certification check through zlens notebook (pid ${running.descriptor.pid}) at ${running.url}.`);
  const handle = running
    ? { url: running.url, close: async () => undefined }
    : await startProjectRuntime(projectRoot, {
      preferredPort: 0,
      ...(flags.connection ? { connection: resolveConnection(flags, projectConfig) } : {}),
    });
  try {
    const response = await fetch(`${handle.url}/api/block-studio/certification-check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ source, enterprise }),
    });
    const body = await response.json().catch(() => ({})) as {
      ok?: boolean;
      blockers?: unknown[];
      error?: string;
      checklist?: unknown;
      certification?: { warnings?: Array<{ rule: string; message: string }> };
    };
    if (!response.ok) {
      return { ok: false, blockers: [body.error ?? `Certification check failed (HTTP ${response.status}).`], checks: [], warnings: [], enterprise };
    }
    return {
      ok: body.ok === true,
      blockers: Array.isArray(body.blockers) ? body.blockers.map(String) : [],
      checks: passedCheckNames(body.checklist),
      warnings: (body.certification?.warnings ?? []).map((warning) => `${warning.rule}: ${warning.message}`),
      enterprise,
    };
  } finally {
    await handle.close();
  }
}

function resolveConnection(flags: CLIFlags, projectConfig: ProjectConfig): ConnectionConfig {
  const conn = flags.connection;
  if (conn && conn !== 'duckdb' && conn !== 'file') {
    return { driver: 'duckdb', filepath: conn };
  }
  if (conn === 'duckdb' || conn === 'file') {
    return { driver: 'file', filepath: ':memory:' };
  }
  if (projectConfig.defaultConnection) {
    return projectConfig.defaultConnection;
  }
  return { driver: 'file', filepath: ':memory:' };
}

function formatDeclaredTest(test: any): string {
  const field = test?.field ?? test?.left?.name ?? test?.name ?? 'assertion';
  const operator = test?.operator ?? 'passes';
  const expected = Object.prototype.hasOwnProperty.call(test ?? {}, 'expected')
    ? ` ${formatBlockTestExpected(test.expected)}`
    : '';
  return `assert ${field} ${operator}${expected}`.trim();
}

function declaredTestAssertions(block: any): string[] {
  return (block.tests ?? []).map((test: any) => formatDeclaredTest(test));
}

function skippedTestSummary(assertions: string[]): TestResultSummary {
  return {
    passed: 0,
    failed: 0,
    skipped: assertions.length,
    duration: 0,
    assertions: [],
    runAt: new Date(),
  };
}

interface BlockRunOutcome {
  testResults: TestResultSummary | null;
  invariantResults: InvariantResult[];
}

async function runBlockTests(
  b: any,
  source: string,
  flags: CLIFlags,
  projectConfig: ProjectConfig,
): Promise<BlockRunOutcome> {
  const tests: any[] = b.tests ?? [];
  const invariants: string[] = Array.isArray(b.invariants) ? b.invariants : [];
  // Nothing to execute when the block declares neither tests nor invariants.
  if (tests.length === 0 && invariants.length === 0) {
    return { testResults: null, invariantResults: [] };
  }

  const projectRoot = process.cwd();
  const connection = resolveConnection(flags, projectConfig);
  // A running workbench holds a DuckDB file open; the block and its tests then run through it.
  const executor = new WorkbenchRoutedQueryExecutor(projectRoot, { onRoute: (via) => { if (flags.format !== 'json') console.error(`  Running the block and its tests through ${via}, which has the DuckDB file open.`); } });
  const start = Date.now();
  const assertions: TestAssertionResult[] = [];
  let invariantResults: InvariantResult[] = [];
  let passed = 0;
  let failed = 0;

  try {
    const cell: NotebookCell = { id: b.name, type: 'dql', source, title: b.name };
    let semanticLayer = undefined;
    const semanticResult = resolveSemanticLayerWithDiagnostics(resolveProjectSemanticConfig(projectConfig, projectRoot), projectRoot);
    if (semanticResult.errors.length === 0) {
      semanticLayer = semanticResult.layer;
    }
    await registerDataViews(executor, connection, projectRoot, projectConfig);
    const tableMapping = await resolveSemanticTableMapping(executor, connection, semanticLayer, projectRoot);
    const plan = buildExecutionPlan(cell, { semanticLayer, driver: connection.driver, tableMapping });
    if (!plan) {
      return {
        testResults: tests.length === 0 ? null : {
          passed: 0,
          failed: tests.length,
          skipped: 0,
          duration: Date.now() - start,
          assertions: tests.map((t: any) => ({
            name: `assert ${t.field} ${t.operator} ${formatBlockTestExpected(t.expected)}`,
            passed: false,
            error: 'Could not build execution plan for block',
          })),
          runAt: new Date(),
        },
        invariantResults: [],
      };
    }

    const prepared = prepareLocalExecution(plan.sql, connection, projectRoot, projectConfig);
    const rawResult = await executor.executeQuery(prepared.sql, plan.sqlParams, plan.variables, prepared.connection);

    const columns = Array.isArray(rawResult?.columns)
      ? rawResult.columns.map((c: any) => typeof c === 'string' ? c : c?.name ?? String(c))
      : [];
    const rows = Array.isArray(rawResult?.rows) ? rawResult.rows : [];

    // Evaluate declared invariants against the same result the tests run on.
    invariantResults = evaluateInvariants(invariants, { columns, rows });

    for (const test of plan.tests) {
      const name = blockTestAssertionName(test);
      const outcome = evaluateBlockTestAssertion(test, { rows, columns });
      if (outcome.passed) {
        assertions.push({ name, passed: true, actual: outcome.actual });
        passed++;
      } else {
        assertions.push({ name, passed: false, actual: outcome.actual, expected: test.expected, error: outcome.error });
        failed++;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    for (const test of tests) {
      assertions.push({
        name: `assert ${test.field} ${test.operator} ${formatBlockTestExpected(test.expected)}`,
        passed: false,
        error: msg,
      });
      failed++;
    }
    // The block did not run, so its invariants are unverified. Surface each as
    // a violation so certification cannot pass on unproven guarantees.
    if (invariants.length > 0 && invariantResults.length === 0) {
      invariantResults = invariants.map((expr) => ({
        expr,
        passed: false,
        detail: `Could not evaluate — block run failed: ${msg}`,
      }));
    }
  }

  return {
    testResults: tests.length === 0 ? null : {
      passed,
      failed,
      skipped: 0,
      duration: Date.now() - start,
      assertions,
      runAt: new Date(),
    },
    invariantResults,
  };
}

async function registerDataViews(
  executor: QueryExecutor,
  connection: ConnectionConfig,
  projectRoot: string,
  projectConfig: ProjectConfig,
): Promise<void> {
  const normalized = normalizeProjectConnection(connection, projectRoot);
  if (normalized.driver !== 'file' && normalized.driver !== 'duckdb') return;
  // The workbench that holds the file registered these views when it started.
  if (executor instanceof WorkbenchRoutedQueryExecutor && await executor.routesTo(normalized)) return;

  const dataDir = projectConfig.dataDir
    ? resolve(projectRoot, projectConfig.dataDir)
    : join(projectRoot, 'data');
  if (!existsSync(dataDir)) return;

  for (const file of readdirSync(dataDir, { withFileTypes: true })) {
    if (!file.isFile() || !/\.(csv|parquet)$/i.test(file.name)) continue;
    const tableName = file.name.replace(/\.(csv|parquet)$/i, '');
    const absPath = join(dataDir, file.name).replaceAll('\\', '/').replace(/'/g, "''");
    const reader = file.name.endsWith('.parquet') ? 'read_parquet' : 'read_csv_auto';
    const ddl = `CREATE OR REPLACE VIEW "${tableName}" AS SELECT * FROM ${reader}('${absPath}')`;
    await executor.executeQuery(ddl, [], {}, normalized);
  }
}

export async function runCertify(filePath: string, flags: CLIFlags): Promise<void> {
  // Tier-2 promotion: `zlens certify --from-draft <path>` moves a draft to its
  // canonical certified location and surfaces the datalex-manifest.json patch.
  if (flags.fromDraft) {
    const projectRoot = process.cwd();
    const result = await promoteFromDraft(projectRoot, flags, {
      gate: (input) => runtimeCertificationGate(projectRoot, flags, input.source),
      // The person certifying, never the project's configured owner (B6).
      certifiedBy: localPersonIdentity(projectRoot),
    });
    if (flags.format === 'json') {
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
      return;
    }
    if (!result.ok) {
      console.error(`\n  ✗ ${result.message}\n`);
      process.exitCode = 1;
      return;
    }
    console.log(`\n  ✓ ${result.message}`);
    if (result.certification) {
      console.log(`    Certified by ${result.certification.certifiedBy} (${result.certification.rules} rules); receipt in ${result.companionPath ?? 'the block companion YAML'}.`);
    }
    if (result.certifiedPath) {
      console.log(`    Run \`zlens compile\` to refresh dql-manifest.json.`);
    }
    if (result.datalexManifestDiff) {
      console.log(`\n  Next: apply this patch to datalex-manifest.json:\n`);
      console.log(result.datalexManifestDiff);
    }
    return;
  }

  const projectConfig = loadProjectConfig(process.cwd());
  const source = readFileSync(filePath, 'utf-8');
  const parser = new Parser(source, filePath);
  const ast = parser.parse();
  const datalexDiagnostics = collectDataLexDiagnostics(ast, process.cwd(), filePath, flags);

  const blocks = ast.statements.filter((s: any) => s.kind === 'BlockDecl');

  if (blocks.length === 0) {
    console.log('\n  ⚠ No block declarations found in file.');
    console.log('');
    return;
  }

  const certifier = flags.enterprise ? new Certifier(ENTERPRISE_RULES) : new Certifier();
  let anyFailed = false;
  const projectRoot = realpathSync(process.cwd());
  const receiptState = certifiedBlockFileState(projectRoot, relative(projectRoot, realpathSync(resolve(filePath))), source);

  for (const block of blocks) {
    const b = block as any;
    const testAssertions = declaredTestAssertions(b);
    const record: BlockRecord = {
      id: 'local',
      name: b.name ?? 'unnamed',
      domain: b.domain ?? '',
      type: b.blockType ?? b.type ?? '',
      version: '0.0.0',
      status: b.status ?? 'draft',
      gitRepo: '',
      gitPath: filePath,
      gitCommitSha: '',
      description: b.description ?? '',
      owner: b.owner ?? '',
      tags: b.tags ?? [],
      dependencies: [],
      usedInCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      llmContext: b.llmContext,
      examples: b.examples,
      invariants: b.invariants,
      pattern: b.pattern,
      metricRef: b.metricRef,
      metricsRef: b.metricsRef,
      dimensionsRef: b.dimensionsRef,
      grain: b.grain,
      entities: b.entities,
      declaredOutputs: b.outputs,
      dimensions: b.dimensions,
      allowedFilters: b.allowedFilters,
      parameterPolicy: b.parameterPolicy,
      filterBindings: b.filterBindings,
      sourceSystems: b.sourceSystems,
      replacementFor: b.replacementFor,
      reviewCadence: b.reviewCadence,
      testAssertions,
    };

    // Run tests unless --skip-tests is set. Invariants run alongside tests on
    // the same block result; a block may declare invariants without tests.
    const declaredInvariants: string[] = Array.isArray(b.invariants) ? b.invariants : [];
    let testResults: TestResultSummary | null = null;
    let invariantResults: InvariantResult[] = [];
    const hasConnection = !!flags.connection || !!projectConfig.defaultConnection;
    if (flags.skipTests && testAssertions.length > 0) {
      testResults = skippedTestSummary(testAssertions);
    } else if (testAssertions.length > 0 || declaredInvariants.length > 0) {
      if (!hasConnection) {
        if (flags.format !== 'json') {
          console.log(`\n  Block: "${record.name}"`);
          const what = testAssertions.length > 0 && declaredInvariants.length > 0
            ? 'Tests and invariants'
            : testAssertions.length > 0 ? 'Tests' : 'Invariants';
          console.log(`  ⚠ ${what} skipped: no database connection. Add defaultConnection to dql.config.json or use --connection.`);
        }
      } else {
        const outcome = await runBlockTests(b, source, flags, projectConfig);
        testResults = outcome.testResults;
        invariantResults = outcome.invariantResults;
      }
    }

    // Tests are optional under OSS rules, as in every other Certify (Block
    // Studio, SQL import, App Dataset, --from-draft): a block that declares none
    // is checked against an empty test run, and "Block has tests" warns
    // (enterprise rules make it an error). Declared tests must run and pass.
    const evaluatedTests = testResults ?? (testAssertions.length === 0 ? skippedTestSummary([]) : undefined);
    const result = certifier.evaluate(record, evaluatedTests, { invariantResults });
    if (record.status === 'certified' && receiptState.state === 'changed') {
      result.warnings.push({
        rule: 'Certification receipt',
        message: changedSinceCertifiedMessage(record.name, receiptState.companionPath),
      });
    }
    const blockDataLexDiagnostics = datalexDiagnostics.filter((diag) =>
      diag.message.includes(`Block "${record.name}"`) || !diag.message.startsWith('Block "'),
    );
    for (const diag of blockDataLexDiagnostics) {
      const entry = { rule: 'DataLex contract', message: diag.message };
      if (diag.severity === 'error') {
        result.errors.push(entry);
        result.certified = false;
      } else {
        result.warnings.push(entry);
      }
    }
    if (!result.certified || (testResults?.failed ?? 0) > 0) {
      anyFailed = true;
    }

    if (flags.format === 'json') {
      console.log(JSON.stringify({ ...result, testResults, invariantResults, datalexDiagnostics: blockDataLexDiagnostics }, null, 2));
      continue;
    }

    console.log(`\n  Block: "${record.name}"`);
    if (result.certified) {
      console.log('  Status: ✓ CERTIFIABLE');
    } else {
      console.log('  Status: ✗ NOT CERTIFIABLE');
    }

    // Print test results
    if (testResults) {
      console.log(`\n  Tests (${testResults.passed + testResults.failed} assertions):`);
      for (const a of testResults.assertions) {
        if (a.passed) {
          const actual = a.actual !== undefined ? ` (actual: ${String(a.actual)})` : '';
          console.log(`    ✓ ${a.name}${actual}`);
        } else {
          console.log(`    ✗ ${a.name}${a.error ? ` — ${a.error}` : ''}`);
          anyFailed = true;
        }
      }
    }

    // Print invariant results
    if (invariantResults.length > 0) {
      console.log(`\n  Invariants (${invariantResults.length}):`);
      for (const inv of invariantResults) {
        if (inv.uncheckable) {
          console.log(`    ⚠ ${inv.expr} — ${inv.detail}`);
        } else if (inv.passed) {
          console.log(`    ✓ ${inv.expr}`);
        } else {
          console.log(`    ✗ ${inv.expr} — ${inv.detail}`);
          anyFailed = true;
        }
      }
    }

    if (result.errors.length > 0) {
      console.log(`\n  Errors (${result.errors.length}):`);
      for (const e of result.errors) {
        console.log(`    ✗ ${e.rule}: ${e.message}`);
      }
    }
    if (result.warnings.length > 0) {
      console.log(`\n  Warnings (${result.warnings.length}):`);
      for (const w of result.warnings) {
        console.log(`    ⚠ ${w.rule}: ${w.message}`);
      }
    }
  }
  console.log('');

  if (anyFailed) {
    process.exitCode = 1;
  }
}

function collectDataLexDiagnostics(
  ast: ReturnType<Parser['parse']>,
  projectRoot: string,
  filePath: string,
  flags: CLIFlags,
): Array<{ file: string; severity: 'error' | 'warning'; message: string; line?: number }> {
  let datalexRegistry: DataLexContractRegistry | undefined;
  const datalexManifestPath = resolveDataLexManifestPath(projectRoot, flags.datalexManifestPath || undefined) ?? undefined;
  const diagnostics: Array<{ file: string; severity: 'error' | 'warning'; message: string; line?: number }> = [];

  if (flags.datalexManifestPath && (!datalexManifestPath || !existsSync(datalexManifestPath))) {
    diagnostics.push({
      file: flags.datalexManifestPath,
      severity: 'error',
      message: `DataLex manifest not found: ${flags.datalexManifestPath}`,
    });
  } else if (datalexManifestPath) {
    datalexRegistry = new DataLexContractRegistry({ manifestPath: datalexManifestPath });
    for (const message of datalexRegistry.loadDiagnostics()) {
      diagnostics.push({
        file: relative(projectRoot, datalexManifestPath),
        severity: 'warning',
        message,
      });
    }
  }

  const semanticDiagnostics: CoreDiagnostic[] = analyze(ast, { datalexRegistry });
  for (const diag of semanticDiagnostics) {
    if (!diag.message.includes('datalex_contract') && !diag.message.includes('DataLex manifest')) continue;
    diagnostics.push({
      file: filePath,
      severity: diag.severity === 'error' ? 'error' : 'warning',
      message: diag.message,
      line: diag.span?.start?.line,
    });
  }

  return diagnostics;
}
