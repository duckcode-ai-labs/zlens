import { latestMatch, receiptLines, UNREADABLE_RECORD } from './report-match/status.js';
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import type { CLIFlags } from './args.js';
import {
  applyCompanionCertification,
  buildCertificationReceipt,
  sourceSha256,
  withBlockStatus,
  type CertificationReceipt,
} from './certification-receipt.js';

export interface PromoteResult {
  ok: boolean;
  message: string;
  /** The path the draft moved to (relative to projectRoot). */
  certifiedPath?: string;
  /** The patch the human still needs to apply to datalex-manifest.json. */
  datalexManifestDiff?: string;
  /** What kept the draft from being certified, when the rules did not pass. */
  blockers?: string[];
  /** Companion YAML that now holds the certification receipt. */
  companionPath?: string;
  /** The receipt written for this certification. */
  certification?: CertificationReceipt;
}

/**
 * The certification rules a draft must pass before it is promoted. The CLI
 * runs the same rules Block Studio's Certify runs (the local runtime's
 * certification check: owner, a successful compile and run, passing tests).
 */
export type PromotionGate = (input: { source: string; path: string }) => Promise<{
  ok: boolean;
  blockers: string[];
  checks?: string[];
  warnings?: string[];
  enterprise?: boolean;
}>;

export interface PromoteOptions {
  /** Required: nothing is certified without the certification rules passing. */
  gate: PromotionGate;
  /** Who is certifying (the local git/OS owner by default, set by the caller). */
  certifiedBy?: string;
  now?: Date;
}

/**
 * Promote a Tier-2 draft block from `blocks/_drafts/<slug>.dql` or
 * `domains/<domain>/blocks/_drafts/<slug>.dql` to the canonical block
 * location, flipping `status` to `certified`. When a DataLex contract is
 * supplied, the promoted block is also bound to that contract.
 *
 * Companion to the dql-mcp `query_via_metadata` tool. Together they close
 * the graduated-trust promotion loop:
 *
 *   ask  ->  no Tier-1 hit  ->  a review draft is saved
 *        ->  human reviews / refines
 *        ->  zlens certify --from-draft <path>
 *        ->  next ask hits Tier-1 forever
 *
 * Behavior:
 *   1. Validates the draft exists and has status=draft.
 *   2. Renders the promoted block: `status = "certified"`, optional
 *      `datalex_contract`, `owner` from --owner, Tier-2 proposal metadata
 *      dropped.
 *   3. Runs the certification rules (`options.gate`) against exactly that
 *      source. If they do not pass, nothing is written and the draft stays.
 *   4. Writes the block to domains/<domain>/blocks/<slug>.dql when that domain
 *      layout exists, otherwise blocks/<domain>/<slug>.dql, removes the draft,
 *      and writes the certification receipt (who, when, rules, source hash)
 *      into the block's companion YAML next to `reviewStatus: certified`.
 *   5. Computes the optional patch the human still needs to apply to
 *      datalex-manifest.json when a contract is present.
 *
 * Does NOT auto-modify datalex-manifest.json. That file is hand-curated
 * until the DataLex compiler ships its v1 emitter; this command shows
 * the user the exact diff to apply.
 */
export async function promoteFromDraft(
  projectRoot: string,
  flags: CLIFlags,
  options: PromoteOptions,
): Promise<PromoteResult> {
  const draftPathInput = flags.fromDraft!;
  const draftAbs = resolve(projectRoot, draftPathInput);

  if (!existsSync(draftAbs)) {
    return { ok: false, message: `Draft not found at ${draftPathInput}.` };
  }

  const content = readFileSync(draftAbs, 'utf-8');
  if (!/status\s*=\s*"draft"/.test(content)) {
    return {
      ok: false,
      message:
        `${draftPathInput} does not have status="draft". Use zlens certify <path> (without --from-draft) to evaluate governance rules.`,
    };
  }

  const proposedContractId = pickField(content, 'proposed_contract_id') ?? '';
  const contract = flags.contract || (proposedContractId ? `${proposedContractId}@1` : '');

  const domain = flags.domain || pickField(content, 'proposed_domain') || guessDomain(contract) || pickField(content, 'domain');
  if (!domain) {
    return {
      ok: false,
      message: 'No --domain provided and could not infer one from the draft or contract id.',
    };
  }

  // A draft file keeps a hash so drafts never collide (`monthly-revenue-a9a82c329b13`);
  // the certified file drops it unless that name is already taken.
  const draftSlug = inferSlugFromPath(draftAbs);
  const cleanSlug = draftSlug.replace(/-[0-9a-f]{12,16}$/, '');
  const slug = cleanSlug !== draftSlug && cleanSlug
    && !existsSync(join(projectRoot, resolvePromotedBlockPath(projectRoot, domain, cleanSlug, draftPathInput)))
    ? cleanSlug
    : draftSlug;
  const destRel = resolvePromotedBlockPath(projectRoot, domain, slug, draftPathInput);
  const destAbs = join(projectRoot, destRel);

  if (existsSync(destAbs) && !flags.force) {
    return {
      ok: false,
      message:
        `${shortPath(projectRoot, destAbs)} already exists. ` +
        'Pass --force to overwrite, or rename the draft.',
    };
  }

  const promoted = renderPromoted(content, {
    contract: contract || undefined,
    domain,
    owner: flags.owner || pickField(content, 'owner') || '',
  });

  // Certification is never a plain status flip: the promoted source must pass
  // the same certification rules Block Studio's Certify runs.
  const verdict = await options.gate({ source: promoted, path: destRel });
  if (!verdict.ok) {
    const blockers = verdict.blockers.length > 0 ? verdict.blockers : ['Certification rules did not pass.'];
    return {
      ok: false,
      message: `${shortPath(projectRoot, draftAbs)} was not certified: ${blockers.join(' ')} The draft is unchanged.`,
      blockers,
    };
  }

  mkdirSync(dirname(destAbs), { recursive: true });
  writeFileSync(destAbs, promoted);
  // The draft and the certified copy must not coexist. Drop the draft now
  // that the certified file is on disk.
  unlinkSync(draftAbs);

  // No connection here to compile the query, so a comparison can't count as a passed check.
  const blockName = /^\s*block\s+"([^"]+)"/m.exec(promoted)?.[1];
  const compared = blockName ? latestMatch(projectRoot, 'query', blockName) : undefined;
  const receipt = buildCertificationReceipt({
    source: promoted,
    certifiedBy: options.certifiedBy || pickField(promoted, 'owner'),
    via: 'cli',
    enterprise: verdict.enterprise === true,
    checks: verdict.checks,
    warnings: [...(verdict.warnings ?? []), ...(compared === 'unreadable' ? [UNREADABLE_RECORD] : compared ? receiptLines(compared, undefined).warnings : [])],
    now: options.now,
  });
  const companionPath = writePromotedCompanion(projectRoot, {
    draftPath: draftPathInput,
    blockPath: destRel,
    slug,
    domain,
    source: promoted,
    receipt,
  });

  const datalexManifestDiff = contract
    ? renderDataLexManifestDiff({
      contract,
      domain,
      slug,
      description: pickField(content, 'description') ?? '',
    })
    : undefined;

  return {
    ok: true,
    message: `Promoted ${shortPath(projectRoot, draftAbs)} -> ${shortPath(projectRoot, destAbs)}.`,
    certifiedPath: shortPath(projectRoot, destAbs),
    datalexManifestDiff,
    companionPath,
    certification: receipt,
  };
}

/** `semantic-layer/blocks/...` companion path for the block layouts promotion uses. */
function companionPathFor(blockPath: string): string | null {
  const normalized = blockPath.replaceAll('\\', '/').replace(/^\/+/, '');
  const domainFirst = normalized.match(/^domains\/([^/]+)\/blocks\/(.+)\.dql$/);
  if (domainFirst) {
    const rest = domainFirst[2];
    return rest.startsWith('_drafts/')
      ? `semantic-layer/blocks/_drafts/${domainFirst[1]}/${rest.slice('_drafts/'.length)}.yaml`
      : `semantic-layer/blocks/${domainFirst[1]}/${rest}.yaml`;
  }
  const legacy = normalized.match(/^blocks\/(.+)\.dql$/);
  return legacy ? `semantic-layer/blocks/${legacy[1]}.yaml` : null;
}

/**
 * Write the promoted block's companion YAML with `reviewStatus: certified`
 * and the certification receipt. The draft's companion (if any) carries its
 * description, tags and lineage over and is removed with the draft.
 */
function writePromotedCompanion(
  projectRoot: string,
  input: { draftPath: string; blockPath: string; slug: string; domain: string; source: string; receipt: CertificationReceipt },
): string | undefined {
  const target = companionPathFor(input.blockPath);
  if (!target) return undefined;
  const draftCompanion = companionPathFor(input.draftPath);
  const draftCompanionAbs = draftCompanion ? join(projectRoot, draftCompanion) : null;
  let base: string;
  if (draftCompanionAbs && existsSync(draftCompanionAbs)) {
    base = readFileSync(draftCompanionAbs, 'utf-8').replace(/^domain:.*$/m, `domain: ${input.domain}`);
  } else {
    const owner = pickField(input.source, 'owner');
    const description = pickField(input.source, 'description');
    base = [
      `name: ${input.slug}`,
      `block: ${input.slug}`,
      `domain: ${input.domain}`,
      ...(description ? [`description: ${JSON.stringify(description)}`] : []),
      ...(owner ? [`owner: ${JSON.stringify(owner)}`] : []),
      'source:',
      '  provider: dql',
      '  objectType: block',
      `  objectId: ${input.slug}`,
    ].join('\n');
  }
  const absTarget = join(projectRoot, target);
  mkdirSync(dirname(absTarget), { recursive: true });
  writeFileSync(absTarget, applyCompanionCertification(base, 'certified', { ...input.receipt, sourceSha256: sourceSha256(input.source) }));
  if (draftCompanionAbs && draftCompanionAbs !== absTarget && existsSync(draftCompanionAbs)) rmSync(draftCompanionAbs, { force: true });
  return target;
}

// -- helpers ---------------------------------------------------------------

function pickField(content: string, key: string): string | undefined {
  const m =
    content.match(new RegExp(`${key}\\s*=\\s*"([^"]*)"`)) ||
    content.match(new RegExp(`${key}\\s*=\\s*"""([\\s\\S]*?)"""`));
  return m?.[1]?.trim();
}

function guessDomain(contractId: string): string | null {
  const head = contractId.split('.')[0];
  return head && head !== contractId ? head : null;
}

function inferSlugFromPath(absPath: string): string {
  return absPath.replace(/.*\//, '').replace(/\.dql$/, '');
}

function resolvePromotedBlockPath(projectRoot: string, domain: string, slug: string, draftPathInput: string): string {
  const normalizedDraft = draftPathInput.replaceAll('\\', '/').replace(/^\/+/, '');
  const domainFirstDraft = normalizedDraft.match(/^domains\/([^/]+)\/blocks\/_drafts\/[^/]+\.dql$/);
  if (domainFirstDraft) {
    return `domains/${domainFirstDraft[1]}/blocks/${slug}.dql`;
  }
  const safeDomain = domain
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, '-')
    .replace(/^\/+|\/+$/g, '');
  if (safeDomain && existsSync(join(projectRoot, 'domains', safeDomain))) {
    return `domains/${safeDomain}/blocks/${slug}.dql`;
  }
  return `blocks/${safeDomain || domain}/${slug}.dql`;
}

function shortPath(projectRoot: string, abs: string): string {
  const root = projectRoot.endsWith('/') ? projectRoot : projectRoot + '/';
  return abs.startsWith(root) ? abs.slice(root.length) : abs;
}

function renderPromoted(
  source: string,
  fields: { contract?: string; domain: string; owner: string },
): string {
  let out = source;

  // Flip status.
  out = withBlockStatus(out, 'certified');

  // M4 Dataset tile lineage is durable source provenance. Certification moves
  // the review draft but must not erase where the governed block came from.
  out = out.replace(/^(\s*)dataset_tile_provenance\s*=/m, '$1derived_from =');

  // Set domain (overwrite the existing one).
  out = out.replace(/(domain\s*=\s*)"[^"]*"/, `$1"${fields.domain}"`);

  // Set datalex_contract when DataLex interop is used. Otherwise remove empty
  // placeholders so OSS-only certified blocks do not carry unresolved contracts.
  if (fields.contract) {
    if (/datalex_contract\s*=\s*"[^"]*"/.test(out)) {
      out = out.replace(/datalex_contract\s*=\s*"[^"]*"/, `datalex_contract = "${fields.contract}"`);
    } else {
      out = out.replace(
        /(status\s*=\s*"certified"\s*\n)/,
        `$1    datalex_contract = "${fields.contract}"\n`,
      );
    }
  } else {
    out = out.replace(/\n\s*datalex_contract\s*=\s*""\s*/g, '\n');
  }

  // Set owner if provided + the field exists in the file.
  if (fields.owner) {
    if (/owner\s*=\s*"[^"]*"/.test(out)) {
      out = out.replace(/owner\s*=\s*"[^"]*"/, `owner = "${fields.owner}"`);
    } else {
      // Insert owner right after the status line.
      out = out.replace(
        /(status\s*=\s*"certified"\s*\n)/,
        `$1    owner = "${fields.owner}"\n`,
      );
    }
  }

  // Drop Tier-2 provenance metadata. Its job is done; the certified block is
  // the new source of truth and should not carry capture metadata.
  out = out.replace(/\n\s*_proposed\s*\{[^}]*\}\s*\n/, '\n');
  out = out.replace(/\n\s*(asked_times|first_asked|last_asked|proposed_contract_id|proposed_domain|proposed_entity|upstream_refs|answer_fingerprint|source_run_id|draft_path)\s*=\s*(?:"[^"]*"|"""[\s\S]*?"""|\d+|\[[^\]]*\])\s*/g, '\n');

  return out;
}

function renderDataLexManifestDiff(fields: {
  contract: string;
  domain: string;
  slug: string;
  description: string;
}): string {
  const [contractId, versionStr] = fields.contract.split('@');
  const version = Number.parseInt(versionStr ?? '1', 10) || 1;
  const parts = contractId.split('.');
  const datalexDomain = parts[0] ?? fields.domain;
  const entity = parts[1] ?? 'Unknown';
  const contractName = parts[2] ?? fields.slug;
  const safeDesc = fields.description.replace(/"/g, '\\"').replace(/\n/g, ' ');

  return `Add the following entry under domains[name=${datalexDomain}].entities[name=${entity}].contracts in datalex-manifest.json:

  {
    "id": "${contractId}",
    "name": "${contractName}",
    "version": ${version},
    "description": "${safeDesc}",
    "signature": {
      "inputs": [],
      "outputs": []
    },
    "owner": "<owner>",
    "tags": []
  }

Then re-run \`zlens compile\` to refresh dql-manifest.json. The DataLex compiler
will emit this entry automatically once the v1 manifest emitter ships;
until then, hand-edit \`datalex-manifest.json\` (or its source YAML) so the
DQL block's datalex_contract reference resolves.
`;
}
