import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Certifier } from '@zlens/governance';
import type { DQLContext } from '../context.js';
import { manifestBlockToRecord } from './util.js';
import { zodInputShapeForTool } from '../tool-schema.js';
import { fetchRuntime, readRuntimeJson, runtimeBaseUrl } from '../runtime-fetch.js';

export const certifyInput = zodInputShapeForTool('certify');

const NOTE =
  'This is a check only: it changes no status and writes nothing. A person certifies in Saved queries (Certify) or with `zlens certify --from-draft <path>`.';

interface CertificationCheckPayload {
  ok?: boolean;
  certification?: { certified?: boolean; errors?: Array<{ rule: string; message: string }>; warnings?: Array<{ rule: string; message: string }>; checkedAt?: string };
  checklist?: Record<string, unknown> & { blockers?: string[]; issues?: unknown[] };
  blockers?: string[];
  testResults?: { passed?: number; failed?: number; skipped?: number; assertions?: Array<{ name?: string; passed?: boolean; actual?: unknown; expected?: unknown; error?: string }> };
  error?: string;
}

/**
 * Check a block against the certification rules.
 *
 * With the workbench running this asks it for the same read-only check Block
 * Studio runs (owner, compile, a bounded run, the block's tests and
 * invariants), so the answer matches what a person sees there. Without it the
 * rules run on the block's declared metadata only: tests cannot run without a
 * warehouse, so the result says they were not run instead of reporting the
 * block as failing them.
 */
export async function certify(ctx: DQLContext, args: { name: string; serverUrl?: string }) {
  const manifestBlock = ctx.manifest.blocks[args.name];
  if (!manifestBlock) {
    const known = Object.keys(ctx.manifest.blocks ?? {});
    return {
      error: `No block named "${args.name}".${known.length ? ` Blocks in this project: ${known.slice(0, 30).join(', ')}.` : ' This project has no blocks yet.'}`,
    };
  }

  let source: string | undefined;
  try {
    source = readFileSync(join(ctx.projectRoot, manifestBlock.filePath), 'utf-8');
  } catch {
    source = undefined;
  }

  const base = runtimeBaseUrl(args.serverUrl);
  if (source) {
    try {
      const response = await fetchRuntime(`${base}/api/block-studio/certification-check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source }),
      });
      if (response.ok) {
        const payload = await readRuntimeJson<CertificationCheckPayload>(response);
        if (payload.certification) {
          const blockers = payload.blockers ?? payload.checklist?.blockers ?? [];
          const tests = payload.testResults;
          return {
            block: args.name,
            path: manifestBlock.filePath,
            status: manifestBlock.status ?? 'draft',
            certified: payload.certification.certified === true && blockers.length === 0,
            checkedBy: 'workbench',
            errors: payload.certification.errors ?? [],
            warnings: payload.certification.warnings ?? [],
            blockers,
            checklist: payload.checklist
              ? Object.fromEntries(Object.entries(payload.checklist).filter(([key]) => !['blockers', 'issues', 'checkedAt'].includes(key)))
              : undefined,
            tests: tests
              ? {
                passed: tests.passed ?? 0,
                failed: tests.failed ?? 0,
                skipped: tests.skipped ?? 0,
                assertions: (tests.assertions ?? []).map((assertion) => ({ name: assertion.name, passed: assertion.passed, ...(assertion.error ? { error: assertion.error } : {}) })),
              }
              : undefined,
            checkedAt: payload.certification.checkedAt ?? new Date().toISOString(),
            note: NOTE,
          };
        }
      }
    } catch {
      // Fall through to the metadata-only check below.
    }
  }

  const record = manifestBlockToRecord(manifestBlock);
  const result = new Certifier().evaluate(record);
  // Without a run there are no test results, which the rules count as a
  // failure. Report that honestly as "not run here" rather than "failed".
  const testsNotRun = result.errors.filter((error) => error.rule === 'All tests pass');
  const errors = result.errors.filter((error) => error.rule !== 'All tests pass');
  return {
    block: args.name,
    path: manifestBlock.filePath,
    status: manifestBlock.status ?? 'draft',
    certified: errors.length === 0 && testsNotRun.length === 0 ? result.certified : false,
    checkedBy: 'metadata-only',
    testsRun: false,
    errors,
    warnings: result.warnings,
    notChecked: [
      `Tests, compile and a run were not checked: the ZLens runtime at ${base} did not answer. Start the workbench (\`zlens notebook ${ctx.projectRoot}\`) and call certify again for the full check.`,
    ],
    checkedAt: result.checkedAt.toISOString(),
    note: NOTE,
  };
}
