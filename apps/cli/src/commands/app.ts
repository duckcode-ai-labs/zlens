/**
 * `zlens app` — manage Apps (consumption-layer artifacts).
 *
 * New Apps live at `apps/<id>/dql.app.json` and bundle dashboards/notebooks plus
 * declarative members, roles, policies, RLS bindings, and schedules. They're
 * compiled into the `apps[]` and `dashboards[]` records of `dql-manifest.json`
 * and read by both the desktop UI and the CLI.
 *
 * Subcommands:
 *   zlens app new <id> --domain <domain> [--owner <user>]
 *   zlens app generate "<prompt>" [--domain <domain>] [--owner <user>] [--ai-layout]
 *   zlens app ls [path]
 *   zlens app show <id> [path]
 *   zlens app build [path]
 *   zlens app reindex [path]
 *   zlens app verify <snapshot.html> [--trust-key <public.pem>] [--format json]
 *   zlens app key
 *   zlens app diff [base] [head] [--html <file>] [--markdown <file>] [--check] [--format json]
 *   zlens app check <id> [--format json]
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { resolveDbtManifestPath } from "@zlens/core";
import {
  buildManifest,
  loadAppDocument,
  findAppDocuments,
  loadDashboardDocument,
  findDashboardsForApp,
  suggestAppId,
  applyAppBuildDraftOperations,
  type AppDocument,
  type DashboardDocument,
  type ManifestApp,
} from "@zlens/core";
import type { CLIFlags } from "../args.js";
import { readSnapshotPublicKey, verifySnapshot, type SnapshotVerification } from "../snapshot/app-snapshot.js";
import { runAppDiff } from "./app-diff.js";
import { findProjectRoot } from "../local-runtime.js";
import {
  checkAppPublication,
  createStoredAppBuildDraft,
  proposeAppBuildDraftOperations,
  writeStoredAppBuildDraft,
} from "../apps-api.js";

const APPS_ROOT = "apps";

export async function runApp(
  sub: string | null,
  rest: string[],
  flags: CLIFlags,
): Promise<void> {
  switch (sub) {
    case "new":
      return runAppNew(rest, flags);
    case "generate":
      return runAppGenerate(rest, flags);
    case "ls":
    case "list":
      return runAppList(rest[0] ?? null, flags);
    case "show":
      return runAppShow(rest, flags);
    case "build":
      return runAppBuild(rest[0] ?? null, flags);
    case "reindex":
      return runAppReindex(rest[0] ?? null, flags);
    case "verify":
      return runAppVerify(rest, flags);
    case "key":
      return runAppKey(flags);
    case "diff":
      return runAppDiff(rest, flags);
    case "check":
      return runAppCheck(rest, flags);
    default:
      throw new Error(
        "Usage: zlens app <new|ls|show|build|reindex|verify|key|diff|check> [args]\n" +
          "  zlens app new <id> --domain <domain> [--owner <user>]\n" +
          '  zlens app generate "<prompt>" [--domain <domain>] [--owner <user>] [--ai-layout]\n' +
          "  zlens app ls [path]\n" +
          "  zlens app show <id> [path]\n" +
          "  zlens app build [path]        builds every App in the project (path defaults to .)\n" +
          "  zlens app reindex [path]\n" +
          "  zlens app verify <snapshot.html> [--trust-key <public.pem>] [--format json]\n" +
          "  zlens app key\n" +
          "  zlens app diff [base] [head] [--html <file>] [--markdown <file>] [--check]\n" +
          "  zlens app check <id> [--format json]",
      );
  }
}

// ---- new ----

async function runAppNew(rest: string[], flags: CLIFlags): Promise<void> {
  const rawId = rest[0];
  if (!rawId) {
    throw new Error(
      "Usage: zlens app new <id> --domain <domain> [--owner <user>]",
    );
  }
  const domain = (flags as { domain?: string }).domain?.trim();
  if (!domain) throw new Error('--domain is required for "zlens app new"');

  const id = suggestAppId(rawId);
  const projectRoot = findProjectRoot(process.cwd());
  const appDir = resolveAppDir(projectRoot, id);

  if (existsSync(appDir)) {
    throw new Error(
      `App already exists at ${relFromRoot(projectRoot, appDir)}`,
    );
  }

  const owner = (flags as { owner?: string }).owner?.trim() || `${process.env.USER ?? "owner"}@local`;
  const displayName = humanise(id);
  const draft = createStoredAppBuildDraft(projectRoot, {
    appId: id,
    name: displayName,
    goal: `Create ${displayName} for ${domain}`,
    audience: owner,
    domain,
    authoringMode: "manual",
    template: "blank",
  });

  if ((flags as { format?: string }).format === "json") {
    console.log(JSON.stringify({ created: true, id, draft, projectSourceWritten: false }, null, 2));
    return;
  }
  console.log(`\n  ✓ Created local App draft: ${displayName}`);
  console.log(`    Draft id: ${draft.id}`);
  console.log(`    Domain: ${domain}   Owner: ${owner}`);
  console.log("    Project source: unchanged");
  console.log("");
  console.log("  Next steps:");
  console.log("    1. Run zlens notebook and open Apps");
  console.log("    2. Resume the local draft and add governed sources, components, and filters");
  console.log("    3. Run preflight and explicitly Publish to Project when ready");
  console.log("");
}

// ---- generate ----

async function runAppGenerate(rest: string[], flags: CLIFlags): Promise<void> {
  const prompt = await readPrompt(rest, flags);
  if (!prompt) {
    throw new Error(
      'Usage: zlens app generate "<prompt>" [--domain <domain>] [--owner <user>] [--ai-layout]',
    );
  }
  const projectRoot = findProjectRoot(process.cwd());
  const domain = cleanOptional((flags as { domain?: string }).domain);
  const owner = cleanOptional((flags as { owner?: string }).owner);
  const draft = createStoredAppBuildDraft(projectRoot, {
    goal: prompt,
    audience: owner,
    domain,
    authoringMode: "ai",
    template: "operational_dashboard",
  });
  const proposal = await proposeAppBuildDraftOperations(projectRoot, draft, { prompt });
  const revised = applyAppBuildDraftOperations(draft, proposal.baseRevision, proposal.operations);
  writeStoredAppBuildDraft(projectRoot, revised, {
    expectedRevision: draft.revision,
    operations: proposal.operations,
  });

  if ((flags as { format?: string }).format === "json") {
    console.log(JSON.stringify({
      ok: true,
      draft: revised,
      proposal: {
        id: proposal.id,
        summary: proposal.summary,
        clarifications: proposal.clarifications,
      },
      projectSourceWritten: false,
    }, null, 2));
    return;
  }

  console.log(`\n  ✓ Created AI-assisted local App draft: ${revised.name}`);
  console.log(`    Draft id: ${revised.id}`);
  console.log(`    Domain: ${domain ?? "automatic"}   Audience: ${owner ?? "stakeholders"}`);
  console.log(`    Covered questions: ${proposal.summary.covered}/${proposal.summary.requirements}`);
  console.log(`    Certified sources: ${proposal.summary.certifiedSources}   Semantic sources: ${proposal.summary.semanticSources}`);
  console.log("    Project source: unchanged");
  if (proposal.clarifications.length > 0) {
    console.log("");
    console.log("  Clarification required:");
    for (const item of proposal.clarifications) {
      console.log(`    - ${item.question}`);
      console.log(`      ${item.choices.map((choice) => choice.label).join(" | ")}`);
    }
  }
  console.log("");
  console.log("  Next steps:");
  console.log("    1. Run zlens notebook and resume this draft in Apps");
  console.log("    2. Review the typed AI changes, resolve clarifications, and run previews");
  console.log("    3. Explicitly Publish to Project after preflight succeeds");
  console.log("");
}

// ---- ls ----

async function runAppList(targetPath: string | null, flags: CLIFlags): Promise<void> {
  const projectRoot = resolveAppProjectRoot(targetPath);
  const apps = collectApps(projectRoot);
  const unloadable = unloadableApps(projectRoot);

  if ((flags as { format?: string }).format === "json") {
    console.log(JSON.stringify({ apps, ...(unloadable.length ? { problems: unloadable } : {}) }, null, 2));
    if (unloadable.length) process.exitCode = 1;
    return;
  }
  for (const item of unloadable) {
    console.error(`Could not load ${item.path}:\n${item.problems.map((problem) => `  ${problem}`).join("\n")}`);
    process.exitCode = 1;
  }
  if (apps.length === 0) {
    console.log(
      "No apps found. Create one with: zlens app new <id> --domain <domain>",
    );
    return;
  }
  for (const a of apps) {
    const member = `${a.members.length} member${a.members.length === 1 ? "" : "s"}`;
    const dash = `${a.dashboards.length} dashboard${a.dashboards.length === 1 ? "" : "s"}`;
    console.log(
      `${a.id.padEnd(28)} domain=${a.domain.padEnd(12)} ${member.padEnd(12)} ${dash}`,
    );
  }
}

// ---- show ----

async function runAppShow(rest: string[], flags: CLIFlags): Promise<void> {
  const id = rest[0];
  if (!id) throw new Error("Usage: zlens app show <id>");
  const projectRoot = resolveAppProjectRoot(rest[1] ?? null);
  const apps = collectApps(projectRoot);
  const app = apps.find((a) => a.id === id);
  if (!app) throw new Error(`No app named "${id}" under apps/ or domains/<domain>/apps/`);

  if ((flags as { format?: string }).format === "json") {
    console.log(JSON.stringify(app, null, 2));
    return;
  }
  console.log(`App: ${app.name} (${app.id})`);
  console.log(`  domain:      ${app.domain}`);
  console.log(`  owners:      ${app.owners.join(", ")}`);
  console.log(`  description: ${app.description ?? "-"}`);
  console.log(`  members:     ${app.members.length}`);
  for (const m of app.members) {
    console.log(`    - ${m.userId} [${m.roles.join(", ")}]`);
  }
  console.log(`  policies:    ${app.policies.length}`);
  console.log(`  schedules:   ${app.schedules.length}`);
  console.log(`  dashboards:  ${app.dashboards.length}`);
  for (const d of app.dashboards) {
    console.log(`    - ${d.id} (${d.title})`);
  }
}

// ---- build ----

async function runAppBuild(targetPath: string | null, flags: CLIFlags): Promise<void> {
  // `zlens app build` builds every App in a project; its argument is a project
  // path, not an App id. An App id used to fall through to the enclosing
  // project silently, so say what the argument means instead.
  if (targetPath && !existsSync(resolve(targetPath))) {
    throw new Error(
      `"${targetPath}" is not a project folder. zlens app build [path] builds every App in the project at path ` +
        `(default: the current folder), e.g. zlens app build . — to look at one App use zlens app show ${targetPath}.`,
    );
  }
  const projectRoot = resolveAppProjectRoot(targetPath);
  // Build the manifest with dbt import resolved the same way `zlens compile`
  // does, so `zlens app build` produces an identical on-disk artifact.
  const dbtManifestPath = resolveDbtManifestPath(projectRoot) ?? undefined;
  const manifest = buildManifest({ projectRoot, dbtManifestPath });

  // Persist the manifest to dql-manifest.json — without this the App + the
  // dashboards never land in the on-disk artifact, so downstream consumers
  // (KG reindex, lineage CLI, the desktop UI) keep reading the previous build.
  const manifestPath = join(projectRoot, "dql-manifest.json");
  writeFileSync(
    manifestPath,
    JSON.stringify(manifest, null, 2) + "\n",
    "utf-8",
  );

  const json = (flags as { format?: string }).format === "json";
  const apps = manifest.apps ?? {};
  const dashboards = manifest.dashboards ?? {};
  const diagnostics = (manifest.diagnostics ?? []).filter((d) => {
    const filePath = d.filePath ?? "";
    return filePath.startsWith("apps/") || filePath.includes("/apps/");
  });

  if (json) {
    console.log(
      JSON.stringify(
        {
          apps: Object.values(apps).map((a) => ({
            id: a.id,
            name: a.name,
            dashboards: a.dashboards,
          })),
          dashboards: Object.values(dashboards).map((d) => ({
            id: d.id,
            appId: d.appId,
            blockIds: d.blockIds,
            unresolvedRefs: d.unresolvedRefs,
          })),
          manifestPath: relative(projectRoot, manifestPath),
          diagnostics,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(
    `\n  ✓ Built ${Object.keys(apps).length} app(s), ${Object.keys(dashboards).length} dashboard(s).`,
  );
  for (const a of Object.values(apps)) {
    console.log(`    - ${a.id}: ${a.dashboards.length} dashboard(s)`);
  }
  console.log(
    `\n  Manifest written to: ${relative(projectRoot, manifestPath)}`,
  );
  if (diagnostics.length > 0) {
    console.log("\n  Diagnostics:");
    for (const d of diagnostics) {
      console.log(`    [${d.severity}] ${d.filePath ?? ""}: ${d.message}`);
    }
  }
  console.log("");
}

// ---- reindex (alias hook for the agent KG package) ----

async function runAppReindex(targetPath: string | null, flags: CLIFlags): Promise<void> {
  const { reindexProject } = await import("@zlens/agent");
  const projectRoot = resolveAppProjectRoot(targetPath);
  const stats = await reindexProject(projectRoot);
  if ((flags as { format?: string }).format === "json") {
    console.log(JSON.stringify({ ok: true, ...stats }, null, 2));
    return;
  }
  const kgStatus = stats.kgRebuilt ? "KG rebuilt" : "KG fresh";
  const catalogStatus = stats.metadataRefreshed ? "metadata refreshed" : "metadata fresh";
  console.log(
    `  ✓ ${kgStatus}; ${catalogStatus} — ${stats.nodes} nodes, ${stats.edges} edges, ${stats.skills} skill(s).`,
  );
}

// ---- helpers ----

async function readPrompt(rest: string[], flags: CLIFlags): Promise<string> {
  const inline = rest.join(" ").trim();
  if (inline) return inline;
  const inputPath = cleanOptional((flags as { input?: string }).input);
  if (inputPath) return readFileSync(inputPath, "utf-8").trim();
  return "";
}

function cleanOptional(value?: string): string | undefined {
  const cleaned = value?.trim();
  return cleaned || undefined;
}

function resolveAppProjectRoot(targetPath: string | null): string {
  return findProjectRoot(resolve(targetPath || process.cwd()));
}

interface ResolvedApp extends Omit<ManifestApp, "dashboards"> {
  dashboards: Array<{ id: string; title: string }>;
}

/** App files that don't load, and why: without this an App with a bad policy just disappears. */
export function unloadableApps(projectRoot: string): Array<{ path: string; problems: string[] }> {
  const out: Array<{ path: string; problems: string[] }> = [];
  for (const appJsonPath of findAppDocuments(projectRoot)) {
    const { document, errors } = loadAppDocument(appJsonPath);
    if (!document) out.push({ path: relative(projectRoot, appJsonPath), problems: errors.map((error) => error.message) });
  }
  return out;
}

function collectApps(projectRoot: string): ResolvedApp[] {
  const out: ResolvedApp[] = [];
  for (const appJsonPath of findAppDocuments(projectRoot)) {
    const { document } = loadAppDocument(appJsonPath);
    if (!document) continue;
    const appDir = appJsonPath.slice(0, -"/dql.app.json".length);
    const dashboardSummaries: Array<{ id: string; title: string }> = [];
    for (const dqldPath of findDashboardsForApp(appDir)) {
      const { document: d } = loadDashboardDocument(dqldPath);
      if (d) dashboardSummaries.push({ id: d.id, title: d.metadata.title });
    }
    out.push({
      id: document.id,
      name: document.name,
      description: document.description,
      domain: document.domain,
      owners: document.owners,
      tags: document.tags ?? [],
      filePath: relative(projectRoot, appDir),
      members: document.members.map((m) => ({
        userId: m.userId,
        displayName: m.displayName,
        roles: m.roles,
        attributes: m.attributes,
      })),
      roles: document.roles,
      policies: document.policies.map((p) => ({
        id: p.id,
        description: p.description,
        domain: p.domain,
        minClassification: p.minClassification,
        allowedRoles: p.allowedRoles,
        allowedUsers: p.allowedUsers,
        accessLevel: p.accessLevel,
        enabled: p.enabled === undefined ? true : Boolean(p.enabled),
      })),
      rlsBindings: document.rlsBindings ?? [],
      schedules: (document.schedules ?? []).map((s) => ({
        id: s.id,
        cron: s.cron,
        dashboard: s.dashboard,
        deliver: s.deliver,
        description: s.description,
        enabled: s.enabled === undefined ? true : Boolean(s.enabled),
      })),
      dashboards: dashboardSummaries,
      homepage: document.homepage,
    } as ResolvedApp);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function relFromRoot(projectRoot: string, p: string): string {
  const prefix = projectRoot.endsWith("/") ? projectRoot : `${projectRoot}/`;
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

function resolveAppDir(projectRoot: string, id: string): string {
  return join(projectRoot, APPS_ROOT, id);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function humanise(id: string): string {
  return (
    id
      .split(/[-_]/)
      .filter(Boolean)
      .map((w) => `${w[0]?.toUpperCase() ?? ""}${w.slice(1)}`)
      .join(" ") || id
  );
}

// Export internal helpers for tests.
export const __test__ = {
  collectApps,
  humanise,
};
// reference unused readdirSync/readFileSync to keep imports stable for future use
void readdirSync;
void readFileSync;

/**
 * `zlens app verify <file>` — check a signed App snapshot offline (RFC 0008
 * step 10): the file is unchanged since signing, the signature matches its
 * manifest, and (with --trust-key, or inside the project that signed it) the
 * key is one you trust. Exits 1 when any check fails.
 */
// ---- check ----

/** Whether an App's tiles would pass publication: each tile's source and trust, and what stops it. */
async function runAppCheck(rest: string[], flags: CLIFlags): Promise<void> {
  const id = rest.find((arg) => !arg.startsWith("-"));
  if (!id) throw new Error("Usage: zlens app check <id> [--format json]");
  const result = checkAppPublication(findProjectRoot(process.cwd()), id);
  if (!result) throw new Error(`No App with id "${id}" in this project.`);
  if (flags.format === "json") {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const tiles = result.pages.flatMap((page) => page.tiles).filter((tile) => tile.check !== "none");
    const passing = tiles.filter((tile) => tile.check === "passes").length;
    const lines = [`${result.ready ? "Ready to publish" : "Not ready to publish"}: ${result.app.title} (${passing} of ${tiles.length} tiles pass)`];
    for (const blocker of result.blockers.filter((item) => item.code === "page_invalid")) lines.push("", `  FAIL  ${blocker.message}`);
    for (const page of result.pages) {
      lines.push("", `  ${page.title}`);
      for (const tile of page.tiles) {
        if (tile.check === "none") continue;
        lines.push(`    ${tile.check === "passes" ? "ok  " : "FAIL"}  ${tile.title ?? tile.id} (${tile.source})`);
        for (const problem of tile.problems) lines.push(`          ${problem}`);
      }
    }
    console.log(lines.join("\n"));
  }
  if (!result.ready) process.exitCode = 1;
}

async function runAppVerify(rest: string[], flags: CLIFlags): Promise<void> {
  const file = rest.find((arg) => !arg.startsWith("-"));
  if (!file) throw new Error("Usage: zlens app verify <snapshot.html> [--trust-key <public.pem>] [--format json]");
  const html = readFileSync(resolve(file), "utf-8");
  const trusted: string[] = [];
  let pinnedBy: string | null = null;
  if (flags.trustKey) {
    trusted.push(readFileSync(resolve(flags.trustKey), "utf-8"));
    pinnedBy = flags.trustKey;
  } else {
    let projectKey: ReturnType<typeof readSnapshotPublicKey> = null;
    try {
      projectKey = readSnapshotPublicKey(findProjectRoot(process.cwd()));
    } catch {
      projectKey = null;
    }
    if (projectKey) {
      trusted.push(projectKey.publicKeyPem);
      pinnedBy = "this project's key";
    }
  }
  const result = verifySnapshot(html, trusted);
  if (flags.format === "json") {
    console.log(JSON.stringify({ file, pinnedBy, ...result }, null, 2));
  } else {
    console.log(renderSnapshotVerification(file, result, pinnedBy));
  }
  if (!result.ok) process.exitCode = 1;
}

export function renderSnapshotVerification(file: string, result: SnapshotVerification, pinnedBy: string | null): string {
  const mark = (ok: boolean | undefined) => (ok ? "ok  " : "FAIL");
  const lines = [`${result.ok ? "Verified" : "Not verified"}: ${file}`, ""];
  lines.push(`  ${mark(result.contentIntact)}  File unchanged since it was signed`);
  lines.push(`  ${mark(result.signatureValid)}  Signature matches the manifest`);
  if (result.trustedKey !== undefined) lines.push(`  ${mark(result.trustedKey)}  Signed by ${pinnedBy ?? "a trusted key"}`);
  else lines.push("  --    Key not pinned (pass --trust-key <public.pem> to require a key)");
  const manifest = result.manifest;
  if (manifest) {
    lines.push("", `  App      ${manifest.app.title} (${manifest.app.id})`);
    lines.push(`  Page     ${manifest.page.title} (${manifest.page.id})`);
    lines.push(`  Signed   ${manifest.createdAt} by key ${manifest.key.id}`);
    lines.push(`  Run      ${manifest.run.id}`);
    lines.push(`  Result   ${manifest.run.resultFingerprint}`);
    lines.push(`  Filters  ${manifest.filters.length ? manifest.filters.map((filter) => `${filter.label}: ${filter.value}`).join("; ") : "none"}`);
    if (manifest.trust.total) lines.push(`  Trust    ${manifest.trust.certified} of ${manifest.trust.total} tiles certified`);
    if (manifest.figures.length) {
      lines.push("", `  ${manifest.figures.length} recorded ${manifest.figures.length === 1 ? "figure" : "figures"}:`);
      for (const figure of manifest.figures.slice(0, 25)) lines.push(`    ${figure.label}: ${figure.display}`);
      if (manifest.figures.length > 25) lines.push(`    … ${manifest.figures.length - 25} more (--format json lists all)`);
    }
  }
  if (result.problems.length) lines.push("", ...result.problems.map((problem) => `  ${problem}`));
  return lines.join("\n");
}

/** `zlens app key` — print this project's snapshot public key, to share with people who verify its snapshots. */
async function runAppKey(flags: CLIFlags): Promise<void> {
  const key = readSnapshotPublicKey(findProjectRoot(process.cwd()));
  if (!key) {
    console.log("This project has not signed a snapshot yet. Export a signed snapshot from an App page to create its key.");
    return;
  }
  if (flags.format === "json") {
    console.log(JSON.stringify({ keyId: key.id, publicKeyPem: key.publicKeyPem }, null, 2));
    return;
  }
  console.log(`Snapshot signing key ${key.id}\n\n${key.publicKeyPem.trim()}\n\nShare this public key; verify with: zlens app verify <snapshot.html> --trust-key <public.pem>`);
}
