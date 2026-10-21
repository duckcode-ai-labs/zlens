import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Parser } from '@zlens/core';
import { QueryExecutor, type ConnectionConfig } from '@zlens/connectors';
import { buildExecutionPlan, type NotebookCell } from '@zlens/notebook';
import { loadProjectConfig, prepareLocalExecution } from '../local-runtime.js';
import type { ProjectConfig } from '../local-runtime.js';
import type { CLIFlags } from '../args.js';
import { blockTestAssertionName, evaluateBlockTestAssertion, formatBlockTestExpected } from '../block-test-assertions.js';

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

export async function runTest(filePath: string, flags: CLIFlags): Promise<void> {
  console.log('  ⚠ zlens test is deprecated. Use zlens certify --connection <driver> instead.');
  console.log('    zlens certify runs governance checks AND test assertions together.');
  console.log('');
  const projectConfig = loadProjectConfig(process.cwd());
  const source = readFileSync(filePath, 'utf-8');
  const parser = new Parser(source, filePath);
  const ast = parser.parse();

  const blocks = ast.statements.filter((s: any) => s.kind === 'BlockDecl');

  if (blocks.length === 0) {
    console.log('\n  No block declarations found in file.');
    console.log('');
    return;
  }

  // Dry run mode (no --connection and no defaultConnection in config)
  if (!flags.connection && !projectConfig.defaultConnection) {
    if (flags.format === 'json') {
      console.log(JSON.stringify({
        file: filePath,
        blocks: blocks.map((b: any) => ({
          name: b.name,
          tests: b.tests?.length ?? 0,
        })),
        note: 'Test execution requires a database connection. Use --connection to specify.',
      }, null, 2));
      return;
    }

    console.log(`\n  Found ${blocks.length} block(s) in ${filePath}`);
    for (const block of blocks) {
      const b = block as any;
      const testCount = b.tests?.length ?? 0;
      console.log(`\n  Block: "${b.name}"`);
      console.log(`    Tests: ${testCount} assertion(s)`);
      if (testCount > 0) {
        for (const test of b.tests) {
          console.log(`    -> assert ${test.field} ${test.operator} ${formatBlockTestExpected(test.expected)}`);
        }
      }
      console.log('    Status: Dry run (no database connection)');
      console.log('    Hint: Use --connection duckdb to execute assertions');
    }
    console.log('');
    return;
  }

  // Live execution mode
  const projectRoot = process.cwd();
  const connection = resolveConnection(flags, projectConfig);
  const executor = new QueryExecutor();

  let totalTests = 0;
  let passed = 0;
  let failed = 0;

  for (const block of blocks) {
    const b = block as any;
    const testCount = b.tests?.length ?? 0;
    if (testCount === 0) continue;

    console.log(`\n  Block: "${b.name}"`);

    try {
      // Build execution plan for this block
      const cell: NotebookCell = {
        id: b.name,
        type: 'dql',
        source,
        title: b.name,
      };
      const plan = buildExecutionPlan(cell);
      if (!plan) {
        console.log(`    SKIP: Could not build execution plan`);
        continue;
      }

      // Execute the query
      const prepared = prepareLocalExecution(plan.sql, connection, projectRoot, projectConfig);
      const rawResult = await executor.executeQuery(prepared.sql, plan.sqlParams, plan.variables, prepared.connection);

      const columns = Array.isArray(rawResult?.columns)
        ? rawResult.columns.map((c: any) => typeof c === 'string' ? c : c?.name ?? String(c))
        : [];
      const rows = Array.isArray(rawResult?.rows) ? rawResult.rows : [];

      // Run assertions
      for (const test of plan.tests) {
        totalTests++;
        const name = blockTestAssertionName(test);
        const assertion = evaluateBlockTestAssertion(test, { columns, rows });
        if (assertion.passed) {
          passed++;
          console.log(`    PASS: ${name} (actual: ${String(assertion.actual)})`);
        } else {
          failed++;
          console.log(`    FAIL: ${name} — ${assertion.error ?? 'failed'}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`    ERROR: ${msg}`);
      failed += testCount;
      totalTests += testCount;
    }
  }

  console.log(`\n  Results: ${passed} passed, ${failed} failed, ${totalTests} total\n`);

  if (failed > 0) {
    process.exitCode = 1;
  }
}
