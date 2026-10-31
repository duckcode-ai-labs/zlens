export interface CLIFlags {
  format: 'text' | 'json';
  verbose: boolean;
  help: boolean;
  version: boolean;
  check: boolean;
  open: boolean | null;
  input: string;
  outDir: string;
  to?: string;
  dryRun?: boolean;
  /** Explicitly apply a migration plan that otherwise defaults to preview-only. */
  apply?: boolean;
  /** `zlens app verify --trust-key <file>`: a public key PEM the snapshot must be signed by. */
  trustKey?: string;
  /** `zlens app diff --html <file>`: write the visual review report. */
  htmlReport?: string;
  /** `zlens app diff --markdown <file>`: write a PR comment. */
  markdownReport?: string;
  /** `zlens propose --plan` — print the deterministic plan; write nothing. */
  plan?: boolean;
  port: number | null;
  /** HTTP bind host. Defaults to 127.0.0.1; set to 0.0.0.0 inside containers. */
  host?: string | null;
  /** Server-owned Ask rollout mode for `zlens notebook`; validated at launch. */
  askRuntimeMode?: string;
  chart: string;
  domain: string;
  /** Model Area for context/model import authoring. */
  area?: string;
  /** Governed analytical purpose used to authorize exact cross-domain imports. */
  purpose?: string;
  owner: string;
  queryOnly: boolean;
  template: string;
  connection: string;
  skipTests: boolean;
  save?: boolean;
  force?: boolean;
  /** `zlens notebook <folder> --yes`: create a project in a folder that has none, without asking. */
  yes?: boolean;
  /** `zlens init --warehouse-first`: model the warehouse directly, no dbt (RFC 0007). */
  warehouseFirst?: boolean;
  http?: boolean;
  /** `zlens certify --from-draft <path>` — promote a Tier-2 draft to certified. */
  fromDraft?: string;
  /** `zlens certify --from-import <session|latest>` — check, or with --apply certify, an import's drafts. */
  fromImport?: string;
  /** `zlens import sql --no-preview`: make the drafts without running them. */
  preview?: boolean;
  /** `zlens import sql --no-metrics`: make no metric drafts from the BI file's calculations. */
  metrics?: boolean;
  /** `zlens import sql --no-check`: write the metric drafts without running them once on the database. */
  checkMetrics?: boolean;
  /** `zlens semantic approve --all-from <import id|latest>`: approve every metric draft that import wrote and ran. */
  allFrom?: string;
  /** `--contract <id@version>` — DataLex contract id to bind during certify. */
  contract?: string;
  /** Optional path to datalex-manifest.json for datalex_contract validation. */
  datalexManifestPath?: string;
  /** `--open-pr` — push a branch + open a GitHub PR with the promotion diff. */
  openPr?: boolean;
  /** Agent/provider selection, e.g. ollama/openai/claude/gemini. */
  provider?: string;
  /** Optional agent user id for memory/feedback attribution. */
  user?: string;
  /** Local runtime URL for agent block execution. */
  runtimeUrl?: string;
  /** `zlens notebook --no-schedules`: do not run the project's App schedules in the notebook. */
  schedules?: boolean;
  runtime?: string;
  /** Execute generated SQL previews during eval. Default false for route-only eval. */
  execute?: boolean;
  /** Include AI provider, MCP, and metadata checks in `zlens doctor`. */
  ai?: boolean;
  /** Enforce enterprise-ready certification requirements. */
  enterprise?: boolean;
  /** Ask app generation to use the richer GenUI planning mode when available. */
  aiLayout?: boolean;
  /** Agent feedback helpers. */
  block?: string;
  question?: string;
  comment?: string;
  /** `zlens agent ask --thread <id>` — continue a persisted conversation thread. */
  thread?: string;
  /** Local Ask trace commands use an explicit output/profile/mode contract. */
  traceProfile?: 'strict' | 'support';
  traceMode?: 'receipt' | 'compare';
  confirmReviewedIdentifiers?: boolean;
  /** `zlens agent ask/eval --reasoning-effort low|medium|high` — affects provider effort and context depth. */
  reasoningEffort?: string;
  /** `zlens agent ask/eval --analysis-depth quick|deep` — controls context budget. */
  analysisDepth?: string;
  /** `zlens eval --min-route-accuracy <0..1>` — fail CI below this route accuracy. */
  minRouteAccuracy?: number;
  /** `zlens eval --min-candidate-recall <0..1>` — fail CI below this retrieval recall. */
  minCandidateRecall?: number;
  /** `zlens eval --min-refusal <0..1>` — fail CI below this refusal recall. */
  minRefusal?: number;
  /** `zlens eval --min-answer-rate <0..1>` — fail CI below answer rate on non-refusal cases. */
  minAnswerRate?: number;
  /** `zlens agent eval --min-tool-requirement <0..1>` — fail below this tool-observed requirement pass rate. */
  minToolRequirement?: number;
  /** `zlens agent eval --via runtime`: how long one question may take before it is recorded as failed. */
  caseTimeoutMs?: number;
  /** `zlens agent eval --min-execution-match <0..1>` — fail below this execution_match_rate (catches class-B wrong-number regressions on `expected.rows` cases). */
  minExecutionMatch?: number;
  /** `zlens agent eval --min-judge-pass <0..1>` — fail below this LLM-judge pass rate (semantic accuracy). */
  minJudgePass?: number;
  /** `zlens agent eval --max-wrong-certified <n>` — fail if more than n answers were wrongly stamped certified. */
  maxWrongCertified?: number;
  /** `zlens agent eval --via runtime` — drive a running workbench (the only driver). */
  via?: string;
  /** `zlens agent eval --cassette record|replay|live` — cassette mode for the eval process's own provider calls (the judge). */
  cassette?: string;
  /** `zlens agent eval --judge` — score each answer with the LLM judge (feeds `--min-judge-pass`). */
  judge?: boolean;
  /** `zlens agent eval --max-false-refusal <0..1>` — fail above this share of answerable cases refused. */
  maxFalseRefusal?: number;
  /**
   * `zlens agent eval --min-grounded-narration <0..1>` — fail BELOW this share of
   * attempted verified-fact narrations that survived their fact check. Exists
   * because a narration truncation broke every ten-row answer deterministically
   * and no gate could fail on it.
   */
  minGroundedNarration?: number;
  /** `zlens agent eval --min-refusal-recall <0..1>` — fail below this share of must-refuse cases that refused. */
  minRefusalRecall?: number;
  /**
   * `zlens agent eval --max-provider-dispatches <n>` — fail when the worst
   * question needed more physical provider round trips than this. Answer
   * quality bought with extra round trips is not free: on a subscription
   * transport each one is a process spawn and tens of seconds of waiting.
   */
  maxProviderDispatches?: number;
  /** `zlens agent eval --max-latency-p95-ms <ms>` — fail above this p95 for answerable cases. */
  maxLatencyP95Ms?: number;
  /** `zlens eval --no-examples` — skip manifest block examples, score yaml cases only. */
  noExamples?: boolean;
  /** `zlens eval --init` — write a starter eval/golden.yaml template into the project. */
  init?: boolean;
  /** `zlens diff --impact` — compute downstream impact + re-cert gate for changed blocks. */
  impact?: boolean;
  /** `zlens diff --impact --write-recertification` — mark impacted semantic YAML as pending recertification. */
  writeRecertification?: boolean;
  /** Invalid flag values. The CLI prints them and exits 1 before running any command. */
  argErrors?: string[];
}

export interface ParsedArgs {
  command: string | null;
  file: string | null;
  rest: string[];
  flags: CLIFlags;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: CLIFlags = {
    format: 'text',
    verbose: false,
    help: false,
    version: false,
    check: false,
    open: null,
    input: '',
    outDir: '',
    port: null,
    host: null,
    chart: '',
    domain: '',
    purpose: '',
    owner: '',
    queryOnly: false,
    template: '',
    connection: '',
    skipTests: false,
    save: false,
    force: false,
    http: false,
  };

  let command: string | null = null;
  let file: string | null = null;
  const rest: string[] = [];
  const argError = (message: string) => { (flags.argErrors ??= []).push(message); };
  // An out-of-range share must fail loudly: silently dropping
  // `--min-route-accuracy 90` left CI running with no gate at all.
  const share = (flag: string, raw: string | undefined): number | undefined => {
    const value = Number(raw);
    if (raw !== undefined && raw.trim() !== '' && Number.isFinite(value) && value >= 0 && value <= 1) return value;
    argError(`${flag} expects a share between 0 and 1 (for 90% use 0.9), got "${raw ?? ''}".`);
    return undefined;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      flags.help = true;
    } else if (arg === '--version' || arg === '-V') {
      flags.version = true;
    } else if (arg === '--verbose' || arg === '-v') {
      flags.verbose = true;
    } else if (arg === '--open') {
      flags.open = true;
    } else if (arg === '--no-open') {
      flags.open = false;
    } else if (arg === '--no-schedules') {
      flags.schedules = false;
    } else if (arg === '--check') {
      flags.check = true;
    } else if (arg === '--format' && i + 1 < argv.length) {
      const fmt = argv[++i];
      if (fmt === 'json' || fmt === 'text') flags.format = fmt;
    } else if (arg === '--input' && i + 1 < argv.length) {
      flags.input = argv[++i];
    } else if (arg === '--out-dir' && i + 1 < argv.length) {
      flags.outDir = argv[++i];
    } else if (arg === '--to' && i + 1 < argv.length) {
      flags.to = argv[++i];
    } else if (arg === '--dry-run') {
      flags.dryRun = true;
    } else if (arg === '--apply') {
      flags.apply = true;
    } else if (arg === '--plan') {
      flags.plan = true;
    } else if (arg === '--port' && i + 1 < argv.length) {
      const value = Number(argv[++i]);
      if (Number.isFinite(value) && value > 0) {
        flags.port = value;
      }
    } else if (arg === '--host' && i + 1 < argv.length) {
      flags.host = argv[++i];
    } else if (arg === '--ask-runtime-mode') {
      // Preserve an absent/invalid value for the notebook command's strict
      // startup validator instead of silently falling back to another mode.
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        flags.askRuntimeMode = '';
      } else {
        flags.askRuntimeMode = value;
        i += 1;
      }
    } else if (arg === '--chart' && i + 1 < argv.length) {
      flags.chart = argv[++i];
    } else if (arg === '--domain' && i + 1 < argv.length) {
      flags.domain = argv[++i];
    } else if (arg === '--area' && i + 1 < argv.length) {
      flags.area = argv[++i];
    } else if (arg === '--purpose' && i + 1 < argv.length) {
      flags.purpose = argv[++i];
    } else if (arg === '--owner' && i + 1 < argv.length) {
      flags.owner = argv[++i];
    } else if ((arg === '--template' || arg === '--pattern') && i + 1 < argv.length) {
      flags.template = argv[++i];
    } else if (arg === '--connection' && i + 1 < argv.length) {
      flags.connection = argv[++i];
    } else if (arg === '--query-only') {
      flags.queryOnly = true;
    } else if (arg === '--skip-tests') {
      flags.skipTests = true;
    } else if (arg === '--save') {
      flags.save = true;
    } else if (arg === '--yes' || arg === '-y') {
      flags.yes = true;
    } else if (arg === '--warehouse-first') {
      flags.warehouseFirst = true;
    } else if (arg === '--force' || arg === '-f') {
      flags.force = true;
    } else if (arg === '--http') {
      flags.http = true;
    } else if (arg === '--from-draft' && i + 1 < argv.length) {
      flags.fromDraft = argv[++i];
    } else if (arg === '--from-import') {
      const value = argv[i + 1];
      flags.fromImport = value && !value.startsWith('--') ? argv[++i] : 'latest';
    } else if (arg === '--no-preview') {
      flags.preview = false;
    } else if (arg === '--no-metrics') {
      flags.metrics = false;
    } else if (arg === '--no-check') {
      flags.checkMetrics = false;
    } else if (arg === '--all-from') {
      const value = argv[i + 1];
      flags.allFrom = value && !value.startsWith('--') ? argv[++i] : 'latest';
    } else if (arg === '--contract' && i + 1 < argv.length) {
      flags.contract = argv[++i];
    } else if (arg === '--datalex-manifest' && i + 1 < argv.length) {
      flags.datalexManifestPath = argv[++i];
    } else if (arg === '--open-pr') {
      flags.openPr = true;
    } else if (arg === '--provider' && i + 1 < argv.length) {
      flags.provider = argv[++i];
    } else if (arg === '--user' && i + 1 < argv.length) {
      flags.user = argv[++i];
    } else if (arg === '--runtime-url' && i + 1 < argv.length) {
      flags.runtimeUrl = argv[++i];
    } else if (arg === '--runtime' && i + 1 < argv.length) {
      flags.runtime = argv[++i];
    } else if (arg === '--execute') {
      flags.execute = true;
    } else if (arg === '--ai') {
      flags.ai = true;
    } else if (arg === '--enterprise') {
      flags.enterprise = true;
    } else if (arg === '--ai-layout') {
      flags.aiLayout = true;
    } else if (arg === '--block' && i + 1 < argv.length) {
      flags.block = argv[++i];
    } else if (arg === '--question' && i + 1 < argv.length) {
      flags.question = argv[++i];
    } else if (arg === '--comment' && i + 1 < argv.length) {
      flags.comment = argv[++i];
    } else if (arg === '--thread' && i + 1 < argv.length) {
      flags.thread = argv[++i];
    } else if (arg === '--profile' && i + 1 < argv.length) {
      const value = argv[++i];
      if (value === 'strict' || value === 'support') flags.traceProfile = value;
    } else if (arg === '--mode' && i + 1 < argv.length) {
      const value = argv[++i];
      if (value === 'receipt' || value === 'compare') flags.traceMode = value;
    } else if (arg === '--confirm-reviewed-identifiers') {
      flags.confirmReviewedIdentifiers = true;
    } else if (arg === '--out' && i + 1 < argv.length) {
      flags.outDir = argv[++i];
    } else if (arg === '--trust-key' && i + 1 < argv.length) {
      flags.trustKey = argv[++i];
    } else if (arg === '--html' && i + 1 < argv.length) {
      flags.htmlReport = argv[++i];
    } else if (arg === '--markdown' && i + 1 < argv.length) {
      flags.markdownReport = argv[++i];
    } else if (arg === '--reasoning-effort' && i + 1 < argv.length) {
      flags.reasoningEffort = argv[++i];
    } else if ((arg === '--analysis-depth' || arg === '--depth') && i + 1 < argv.length) {
      flags.analysisDepth = argv[++i];
    } else if (arg === '--min-candidate-recall' && i + 1 < argv.length) {
      const value = share(arg, argv[++i]);
      if (value !== undefined) flags.minCandidateRecall = value;
    } else if (arg === '--min-route-accuracy' && i + 1 < argv.length) {
      const value = share(arg, argv[++i]);
      if (value !== undefined) flags.minRouteAccuracy = value;
    } else if (arg === '--min-refusal' && i + 1 < argv.length) {
      const value = share(arg, argv[++i]);
      if (value !== undefined) flags.minRefusal = value;
    } else if (arg === '--min-answer-rate' && i + 1 < argv.length) {
      const value = share(arg, argv[++i]);
      if (value !== undefined) flags.minAnswerRate = value;
    } else if (arg === '--case-timeout-ms' && i + 1 < argv.length) {
      const value = Number(argv[++i]);
      if (Number.isFinite(value) && value > 0) flags.caseTimeoutMs = value;
    } else if (arg === '--min-tool-requirement' && i + 1 < argv.length) {
      const value = share(arg, argv[++i]);
      if (value !== undefined) flags.minToolRequirement = value;
    } else if (arg === '--min-execution-match' && i + 1 < argv.length) {
      const value = share(arg, argv[++i]);
      if (value !== undefined) flags.minExecutionMatch = value;
    } else if (arg === '--min-judge-pass' && i + 1 < argv.length) {
      const value = share(arg, argv[++i]);
      if (value !== undefined) flags.minJudgePass = value;
    } else if (arg === '--max-wrong-certified' && i + 1 < argv.length) {
      const value = Number(argv[++i]);
      if (Number.isFinite(value) && value >= 0) flags.maxWrongCertified = value;
    } else if (arg === '--cassette' && i + 1 < argv.length) {
      const value = String(argv[++i]);
      if (value === 'record' || value === 'replay' || value === 'live') flags.cassette = value;
      else argError(`--cassette expects record, replay or live, got "${value}".`);
    } else if (arg === '--via' && i + 1 < argv.length) {
      // The in-process answer-loop driver (`--via loop`) was removed with the
      // V1 runtime; every case now runs through a running workbench.
      const value = String(argv[++i]);
      if (value === 'runtime') flags.via = value;
      else argError(`--via ${value} is not supported: agent eval drives a running ZLens workbench (--via runtime, the default).`);
    } else if (arg === '--judge') {
      flags.judge = true;
    } else if (arg === '--min-grounded-narration' && i + 1 < argv.length) {
      const value = share(arg, argv[++i]);
      if (value !== undefined) flags.minGroundedNarration = value;
    } else if (arg === '--max-false-refusal' && i + 1 < argv.length) {
      const value = share(arg, argv[++i]);
      if (value !== undefined) flags.maxFalseRefusal = value;
    } else if (arg === '--max-provider-dispatches' && i + 1 < argv.length) {
      const value = Number(argv[++i]);
      if (Number.isFinite(value) && value >= 0) flags.maxProviderDispatches = value;
    } else if (arg === '--max-latency-p95-ms' && i + 1 < argv.length) {
      const value = Number(argv[++i]);
      if (Number.isFinite(value) && value > 0) flags.maxLatencyP95Ms = value;
    } else if (arg === '--min-refusal-recall' && i + 1 < argv.length) {
      const value = share(arg, argv[++i]);
      if (value !== undefined) flags.minRefusalRecall = value;
    } else if (arg === '--no-examples') {
      flags.noExamples = true;
    } else if (arg === '--init') {
      flags.init = true;
    } else if (arg === '--impact') {
      flags.impact = true;
    } else if (arg === '--write-recertification' || arg === '--write-recertification-changeset') {
      flags.writeRecertification = true;
    } else if (!command) {
      command = arg;
    } else if (!file) {
      file = arg;
    } else {
      rest.push(arg);
    }
  }

  return { command, file, rest, flags };
}
