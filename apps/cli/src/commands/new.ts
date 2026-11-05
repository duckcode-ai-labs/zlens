import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { renderSemanticBlockSource, buildTermTemplate, modelingModeOf } from '@zlens/core';
import type { CLIFlags } from '../args.js';
import { findProjectRoot, loadProjectConfig } from '../local-runtime.js';

type ScaffoldKind = 'block' | 'dashboard' | 'workbook' | 'semantic-block' | 'notebook' | 'business-view' | 'term' | 'domain';

export async function runNew(subject: string | null, rest: string[], flags: CLIFlags): Promise<void> {
  const { kind, rawName } = resolveNewTarget(subject, rest);

  const projectRoot = findProjectRoot(process.cwd());
  const title = toTitle(rawName);
  const slug = toSlug(rawName);
  const usingStarterData = existsSync(join(projectRoot, 'data', 'revenue.csv'));
  const domainFirst = existsSync(join(projectRoot, 'domains'));
  // Detect available data files for smarter notebook templates
  const availableDataFiles = detectAvailableDataFiles(projectRoot);

  if (kind === 'semantic-block' && isDbtFirstProject(projectRoot)) {
    throw new Error('DQL_MODELING_DBT_OWNED: dbt-first projects use dbt/MetricFlow as the metric source of truth. Create or edit the metric in dbt, then build a DQL block that references it; local semantic-layer metric scaffolding is disabled.');
  }

  // Notebooks use .dqlnb extension and their own creation path
  if (kind === 'notebook') {
    return runNewNotebook({ projectRoot, title, slug, flags, usingStarterData, availableDataFiles });
  }

  if (kind === 'domain') {
    return runNewDomain({ projectRoot, title, slug, flags });
  }

  const domainSlug = toSlug(flags.domain || 'general');
  const outputDir = resolve(
    projectRoot,
    defaultDirForKind(kind, flags.outDir, domainSlug, domainFirst),
  );
  const filePath = join(outputDir, `${slug}.dql`);

  if (existsSync(filePath)) {
    throw new Error(`${capitalize(kind)} already exists: ${filePath}`);
  }

  mkdirSync(outputDir, { recursive: true });

  const owner = flags.owner || process.env.USER || 'team';
  const domain = flags.domain || 'general';
  const chart = normalizeChart(flags.chart || 'bar');
  const metricName = `${slug}_metric`;

  const content = buildTemplate({
    kind,
    title,
    domain,
    owner,
    chart,
    queryOnly: flags.queryOnly,
    usingStarterData,
    metricName,
    pattern: flags.template,
  });

  writeFileSync(filePath, content, 'utf-8');

  const relatedFiles = kind === 'semantic-block'
    ? writeSemanticCompanionFiles(projectRoot, slug, domain, owner, metricName, domainFirst)
    : [];

  const relativePath = relativeToProject(projectRoot, filePath);
  const nextSteps = nextStepsFor(kind, relativePath, usingStarterData, flags.queryOnly);

  if (flags.format === 'json') {
    console.log(JSON.stringify({
      created: true,
      type: kind,
      name: title,
      path: filePath,
      previewReady: usingStarterData && kind !== 'semantic-block',
      relatedFiles,
      nextSteps,
    }, null, 2));
    return;
  }

  console.log(`\n  ✓ Created DQL ${kind}: ${title}`);
  console.log(`    Path: ${filePath}`);
  if (relatedFiles.length > 0) {
    console.log('    Related files:');
    relatedFiles.forEach((relatedFile) => console.log(`      - ${relatedFile}`));
  }
  console.log('');
  console.log('  Next steps:');
  nextSteps.forEach((step, index) => console.log(`    ${index + 1}. ${step}`));
  console.log('');
}

function resolveNewTarget(subject: string | null, rest: string[]): { kind: ScaffoldKind; rawName: string } {
  if (!subject) {
    throw new Error('Usage: zlens new <domain|block|dashboard|workbook|semantic-block|notebook|view|business-view|term> <name>');
  }

  if (subject === 'business_view' || subject === 'view') {
    subject = 'business-view';
  }

  if (subject === 'domain' || subject === 'block' || subject === 'dashboard' || subject === 'workbook' || subject === 'semantic-block' || subject === 'notebook' || subject === 'business-view' || subject === 'term') {
    const rawName = rest.join(' ').trim();
    if (!rawName) {
      throw new Error(`Missing ${subject} name. Usage: zlens new ${subject} <name>`);
    }
    return { kind: subject, rawName };
  }

  return { kind: 'block', rawName: subject };
}

function buildTemplate(opts: {
  kind: ScaffoldKind;
  title: string;
  domain: string;
  owner: string;
  chart: string;
  queryOnly: boolean;
  usingStarterData: boolean;
  metricName: string;
  pattern: string;
}): string {
  switch (opts.kind) {
    case 'dashboard':
      return buildDashboardTemplate(opts);
    case 'workbook':
      return buildWorkbookTemplate(opts);
    case 'semantic-block':
      return buildSemanticBlockTemplate(opts);
    case 'business-view':
      return buildBusinessViewTemplate(opts);
    case 'term':
      return buildTermTemplate(opts);
    case 'domain':
      return buildDomainTemplate(opts);
    case 'block':
    default:
      return buildBlockTemplate(opts);
  }
}

function buildDomainTemplate(opts: {
  title: string;
  owner: string;
  domain: string;
}): string {
  const domainSlug = toSlug(opts.domain || opts.title).replace(/_/g, '-');
  return `domain "${opts.title}" {
    id = "${domainSlug.replace(/-/g, '_')}"
    owner = "${opts.owner}"
    businessOwner = "${opts.owner}"
    boundedContext = "Describe the business boundary for ${opts.title.toLowerCase()}."
    sourceSystems = []
    primaryTerms = []
    reviewCadence = "monthly"
    tags = ["${domainSlug}"]
}
`;
}

function buildBusinessViewTemplate(opts: {
  title: string;
  domain: string;
  owner: string;
}): string {
  return `business_view "${opts.title}" {
    domain = "${opts.domain}"
    status = "draft"
    description = "Business composition for ${opts.title.toLowerCase()}"
    owner = "${opts.owner}"
    tags = ["business-view", "${opts.domain}"]
    businessOutcome = "Describe the business decision this view supports."
    decisionUse = "Describe when teams should use this view."
    reviewCadence = "weekly"

    includes {
        block "Customer Identity"
        block "Customer Orders Rollup"
        business_view "Customer Service Summary"
    }
}
`;
}

function buildBlockTemplate(opts: {
  title: string;
  domain: string;
  owner: string;
  chart: string;
  queryOnly: boolean;
  usingStarterData: boolean;
  pattern: string;
}): string {
  const pattern = normalizeBlockPattern(opts.pattern);
  const description = opts.usingStarterData
    ? `Starter block for ${opts.title.toLowerCase()} using local sample data`
    : `Starter block for ${opts.title.toLowerCase()}`;

  const query = opts.usingStarterData ? starterBlockQueryForChart(opts.chart) : placeholderBlockQueryForChart(opts.chart);
  const contract = blockContractForPattern(pattern, opts);
  const tags = ['starter', opts.domain, pattern].filter(Boolean);
  const filterBindings = contract.allowedFilters.length > 0
    ? `
    filterBindings {
${contract.allowedFilters.map((filter) => `        ${filter} = "${filter}"`).join('\n')}
    }
`
    : '';
  const params = opts.usingStarterData && (opts.chart === 'bar' || opts.chart === 'kpi')
    ? `
    params {
        period = "current_quarter"
    }
`
    : '';
  const visualization = opts.queryOnly ? '' : blockVisualizationForChart(opts.chart);

  return `block "${opts.title}" {
    domain = "${opts.domain}"
    type = "custom"
    status = "draft"
    description = "${description}"
    owner = "${opts.owner}"
    tags = [${tags.map((tag) => `"${tag}"`).join(', ')}]
    pattern = "${pattern}"
    grain = "${contract.grain}"
    entities = [${contract.entities.map((entity) => `"${entity}"`).join(', ')}]
    terms = []
    outputs = [${contract.outputs.map((output) => `"${output}"`).join(', ')}]
    dimensions = [${contract.dimensions.map((dimension) => `"${dimension}"`).join(', ')}]
    allowedFilters = [${contract.allowedFilters.map((filter) => `"${filter}"`).join(', ')}]
${filterBindings}    sourceSystems = [${contract.sourceSystems.map((sourceSystem) => `"${sourceSystem}"`).join(', ')}]
    replacementFor = []
    reviewCadence = "monthly"${params}

    query = """
${indentBlock(query, 8)}
    """${visualization}

    tests {
        assert row_count > 0
    }
}
`;
}

function buildSemanticBlockTemplate(opts: {
  title: string;
  domain: string;
  owner: string;
  metricName: string;
}): string {
  return renderSemanticBlockSource({
    name: opts.title,
    status: 'draft',
    domain: opts.domain,
    description: `Starter semantic block for ${opts.title.toLowerCase()}`,
    owner: opts.owner,
    tags: ['starter', 'semantic', opts.domain],
    metrics: [opts.metricName],
    dimensions: [],
  });
}

function buildDashboardTemplate(opts: {
  title: string;
  chart: string;
  usingStarterData: boolean;
}): string {
  const starterSource = `read_csv_auto('./data/revenue.csv')`;
  const source = opts.usingStarterData ? starterSource : 'your_table';
  const primaryChart = dashboardChartFor(opts.chart, source, opts.usingStarterData);
  const tableChart = `  chart.table(
    SELECT recognized_at, segment_tier, amount, fiscal_period
    FROM ${source}
    ORDER BY recognized_at DESC,
    title = "Recent Rows"
  )`;

  return `dashboard "${opts.title}" {
${primaryChart}

${tableChart}
}
`;
}

function buildWorkbookTemplate(opts: {
  title: string;
  usingStarterData: boolean;
}): string {
  const source = opts.usingStarterData ? `read_csv_auto('./data/revenue.csv')` : 'your_table';
  return `workbook "${opts.title}" {
  page "Summary" {
    chart.kpi(
      SELECT SUM(amount) AS total_revenue FROM ${source},
      metrics = ["total_revenue"],
      title = "Total Revenue"
    )
  }

  page "Trend" {
    chart.line(
      SELECT recognized_at AS revenue_date, SUM(amount) AS total_revenue
      FROM ${source}
      GROUP BY recognized_at
      ORDER BY recognized_at,
      x = revenue_date,
      y = total_revenue,
      title = "Revenue Trend"
    )
  }
}
`;
}

function starterBlockQueryForChart(chart: string): string {
  switch (chart) {
    case 'kpi':
      return `SELECT SUM(amount) AS total_revenue
FROM read_csv_auto('./data/revenue.csv')
WHERE fiscal_period = \${period}`;
    case 'line':
      return `SELECT recognized_at AS revenue_date, SUM(amount) AS total_revenue
FROM read_csv_auto('./data/revenue.csv')
GROUP BY recognized_at
ORDER BY recognized_at`;
    case 'table':
      return `SELECT recognized_at, segment_tier, amount, fiscal_period
FROM read_csv_auto('./data/revenue.csv')
ORDER BY recognized_at DESC`;
    case 'bar':
    default:
      return `SELECT segment_tier AS segment, SUM(amount) AS revenue
FROM read_csv_auto('./data/revenue.csv')
WHERE fiscal_period = \${period}
GROUP BY segment_tier
ORDER BY revenue DESC`;
  }
}

function placeholderBlockQueryForChart(chart: string): string {
  switch (chart) {
    case 'kpi':
      return `SELECT SUM(measure) AS total_revenue
FROM your_table`;
    case 'line':
      return `SELECT dimension_date AS revenue_date, SUM(measure) AS total_revenue
FROM your_table
GROUP BY dimension_date
ORDER BY dimension_date`;
    case 'table':
      return `SELECT *
FROM your_table
LIMIT 50`;
    case 'bar':
    default:
      return `SELECT dimension AS segment, SUM(measure) AS revenue
FROM your_table
GROUP BY dimension
ORDER BY revenue DESC`;
  }
}

function blockVisualizationForChart(chart: string): string {
  switch (chart) {
    case 'kpi':
      return `

    visualization {
        chart = "kpi"
        y = total_revenue
    }`;
    case 'line':
      return `

    visualization {
        chart = "line"
        x = revenue_date
        y = total_revenue
    }`;
    case 'table':
      return `

    visualization {
        chart = "table"
    }`;
    case 'bar':
    default:
      return `

    visualization {
        chart = "bar"
        x = segment
        y = revenue
    }`;
  }
}

function normalizeBlockPattern(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const allowed = new Set([
    'metric_wrapper',
    'entity_profile',
    'entity_rollup',
    'ranking',
    'trend',
    'bridge',
    'drilldown',
    'replacement',
  ]);
  return allowed.has(normalized) ? normalized : 'custom';
}

function blockContractForPattern(pattern: string, opts: {
  title: string;
  chart: string;
}): {
  grain: string;
  entities: string[];
  outputs: string[];
  dimensions: string[];
  allowedFilters: string[];
  sourceSystems: string[];
} {
  const titleToken = toSlug(opts.title).split('_').filter(Boolean)[0] || 'entity';
  switch (pattern) {
    case 'metric_wrapper':
      return {
        grain: 'metric_time',
        entities: [],
        outputs: ['metric_time', 'metric_value'],
        dimensions: ['metric_time'],
        allowedFilters: ['metric_time'],
        sourceSystems: [],
      };
    case 'entity_profile':
      return {
        grain: `${titleToken}_id`,
        entities: [toTitle(titleToken)],
        outputs: [`${titleToken}_id`, `${titleToken}_name`],
        dimensions: [],
        allowedFilters: [`${titleToken}_id`],
        sourceSystems: [],
      };
    case 'entity_rollup':
      return {
        grain: `${titleToken}_id`,
        entities: [toTitle(titleToken)],
        outputs: [`${titleToken}_id`, 'metric_value'],
        dimensions: [],
        allowedFilters: [`${titleToken}_id`, 'date'],
        sourceSystems: [],
      };
    case 'ranking':
      return {
        grain: titleToken,
        entities: [toTitle(titleToken)],
        outputs: [titleToken, 'metric_value', 'rank'],
        dimensions: [titleToken],
        allowedFilters: ['date'],
        sourceSystems: [],
      };
    case 'trend':
      return {
        grain: 'date',
        entities: [],
        outputs: ['date', 'metric_value'],
        dimensions: ['date'],
        allowedFilters: ['date'],
        sourceSystems: [],
      };
    case 'bridge':
      return {
        grain: 'bridge_key',
        entities: ['Source Entity', 'Target Entity'],
        outputs: ['bridge_key', 'source_entity_id', 'target_entity_id'],
        dimensions: [],
        allowedFilters: ['source_entity_id', 'target_entity_id'],
        sourceSystems: ['source_system', 'target_system'],
      };
    case 'drilldown':
      return {
        grain: 'detail_row',
        entities: [],
        outputs: ['detail_row'],
        dimensions: [],
        allowedFilters: ['date'],
        sourceSystems: [],
      };
    case 'replacement':
      return {
        grain: 'review_required',
        entities: [],
        outputs: ['review_required'],
        dimensions: [],
        allowedFilters: [],
        sourceSystems: [],
      };
    default:
      return contractForChart(opts.chart);
  }
}

function contractForChart(chart: string): {
  grain: string;
  entities: string[];
  outputs: string[];
  dimensions: string[];
  allowedFilters: string[];
  sourceSystems: string[];
} {
  switch (chart) {
    case 'kpi':
      return {
        grain: 'all',
        entities: [],
        outputs: ['total_revenue'],
        dimensions: [],
        allowedFilters: [],
        sourceSystems: [],
      };
    case 'line':
      return {
        grain: 'revenue_date',
        entities: [],
        outputs: ['revenue_date', 'total_revenue'],
        dimensions: ['revenue_date'],
        allowedFilters: ['revenue_date'],
        sourceSystems: [],
      };
    case 'table':
      return {
        grain: 'row',
        entities: [],
        outputs: [],
        dimensions: [],
        allowedFilters: [],
        sourceSystems: [],
      };
    case 'bar':
    default:
      return {
        grain: 'segment',
        entities: [],
        outputs: ['segment', 'revenue'],
        dimensions: ['segment'],
        allowedFilters: ['segment'],
        sourceSystems: [],
      };
  }
}

function dashboardChartFor(chart: string, source: string, usingStarterData: boolean): string {
  switch (chart) {
    case 'kpi':
      return `  chart.kpi(
    SELECT SUM(amount) AS total_revenue FROM ${source},
    metrics = ["total_revenue"],
    title = "Total Revenue"
  )`;
    case 'line':
      return `  chart.line(
    SELECT recognized_at AS revenue_date, SUM(amount) AS total_revenue
    FROM ${source}
    GROUP BY recognized_at
    ORDER BY recognized_at,
    x = revenue_date,
    y = total_revenue,
    title = "Revenue Trend"
  )`;
    case 'table':
      return `  chart.table(
    SELECT recognized_at, segment_tier, amount, fiscal_period
    FROM ${source}
    ORDER BY recognized_at DESC,
    title = "Revenue Table"
  )`;
    case 'bar':
    default:
      return `  chart.bar(
    SELECT segment_tier AS segment, SUM(amount) AS revenue
    FROM ${source}${usingStarterData ? '\n    WHERE fiscal_period = "current_quarter"' : ''}
    GROUP BY segment_tier
    ORDER BY revenue DESC,
    x = segment,
    y = revenue,
    title = "Revenue by Segment"
  )`;
  }
}

function nextStepsFor(kind: ScaffoldKind, relativePath: string, usingStarterData: boolean, queryOnly: boolean): string[] {
  if (kind === 'semantic-block') {
    return [
      `zlens parse ${relativePath}`,
      `zlens info ${relativePath}`,
    ];
  }

  if (kind === 'business-view') {
    return [
      `Edit ${relativePath} to point includes at existing blocks or business views`,
      `zlens compile`,
    ];
  }

  if (kind === 'term') {
    return [
      `Edit ${relativePath} to capture the business definition, identifiers, and rules`,
      `Reference it from blocks or business views with terms = ["${toTitle(basename(relativePath, '.dql'))}"]`,
      `zlens compile`,
    ];
  }

  if (kind === 'domain') {
    const domainSlug = basename(resolve(relativePath, '..'));
    return [
      `Edit ${relativePath} to capture the domain owner, boundary, source systems, and primary terms`,
      `zlens new block --domain ${domainSlug} --pattern entity_profile "Customer Profile"`,
      `zlens compile`,
    ];
  }

  if (!usingStarterData) {
    return [
      `Edit ${relativePath} to replace the placeholder SQL`,
      `zlens parse ${relativePath}`,
    ];
  }

  const steps = [`zlens parse ${relativePath}`];
  if (kind === 'block') {
    steps.push(queryOnly ? `zlens info ${relativePath}` : `zlens preview ${relativePath}`);
  } else {
    steps.push(`zlens preview ${relativePath}`);
  }
  return steps;
}

function defaultDirForKind(kind: ScaffoldKind, outDir: string, domainSlug = 'general', domainFirst = false): string {
  if (outDir) return outDir;
  if (domainFirst) {
    switch (kind) {
      case 'semantic-block':
      case 'block':
        return join('domains', domainSlug, 'blocks');
      case 'business-view':
        return join('domains', domainSlug, 'views');
      case 'term':
        return join('domains', domainSlug, 'terms');
      default:
        break;
    }
  }
  switch (kind) {
    case 'dashboard':
      return 'dashboards';
    case 'semantic-block':
      return 'blocks';
    case 'workbook':
      return 'workbooks';
    case 'notebook':
      return 'notebooks';
    case 'business-view':
      return 'business-views';
    case 'term':
      return 'terms';
    case 'block':
    default:
      return 'blocks';
  }
}

async function runNewDomain(opts: {
  projectRoot: string;
  title: string;
  slug: string;
  flags: CLIFlags;
}): Promise<void> {
  const { projectRoot, title, slug, flags } = opts;
  const domainDir = resolve(projectRoot, flags.outDir || join('domains', slug));
  const filePath = join(domainDir, 'domain.dql');

  if (existsSync(filePath)) {
    throw new Error(`Domain already exists: ${filePath}`);
  }

  mkdirSync(domainDir, { recursive: true });
  const packageFolders = [
    'modeling', 'modeling/layouts', 'terms', 'skills', 'blocks', 'blocks/_drafts',
    'views', 'contracts', 'interfaces', 'evaluations', 'tests',
  ];
  for (const child of packageFolders) {
    mkdirSync(join(domainDir, child), { recursive: true });
  }

  const owner = flags.owner || process.env.USER || 'team';
  const content = buildDomainTemplate({
    title,
    owner,
    domain: slug,
  });
  writeFileSync(filePath, content, 'utf-8');

  const relativePath = relativeToProject(projectRoot, filePath);
  const nextSteps = nextStepsFor('domain', relativePath, false, false);

  if (flags.format === 'json') {
    console.log(JSON.stringify({
      created: true,
      type: 'domain',
      name: title,
      path: filePath,
      folders: packageFolders.map((child) => join(domainDir, child)),
      nextSteps,
    }, null, 2));
    return;
  }

  console.log(`\n  ✓ Created DQL domain: ${title}`);
  console.log(`    Path: ${filePath}`);
  console.log('');
  console.log('  Next steps:');
  nextSteps.forEach((step, index) => console.log(`    ${index + 1}. ${step}`));
  console.log('');
}

async function runNewNotebook(opts: {
  projectRoot: string;
  title: string;
  slug: string;
  flags: CLIFlags;
  usingStarterData: boolean;
  availableDataFiles: string[];
}): Promise<void> {
  const { projectRoot, title, slug, flags, usingStarterData, availableDataFiles } = opts;
  const outputDir = resolve(projectRoot, flags.outDir || 'notebooks');
  const filePath = join(outputDir, `${slug}.dqlnb`);

  if (existsSync(filePath)) {
    throw new Error(`Notebook already exists: ${filePath}`);
  }

  mkdirSync(outputDir, { recursive: true });

  const template = flags.chart || 'blank'; // reuse --chart flag as template selector
  const cells = buildNotebookCells(title, template, usingStarterData, availableDataFiles);
  const ownerDomain = flags.domain.trim() || undefined;
  const content = JSON.stringify({
    dqlnbVersion: 2,
    version: 1,
    title,
    metadata: {
      createdWith: 'dql',
      ...(ownerDomain ? { ownerDomain } : {}),
      usesDomains: ownerDomain ? [ownerDomain] : [],
      requiredExports: [],
    },
    cells,
  }, null, 2);
  writeFileSync(filePath, content, 'utf-8');

  const relativePath = relativeToProject(projectRoot, filePath);

  if (flags.format === 'json') {
    console.log(JSON.stringify({ created: true, type: 'notebook', name: title, path: filePath }, null, 2));
    return;
  }

  console.log(`\n  ✓ Created ZLens notebook: ${title}`);
  console.log(`    Path: ${filePath}`);
  console.log('');
  console.log('  Next steps:');
  console.log(`    1. zlens notebook  (opens the interactive notebook UI)`);
  console.log(`    2. Open "${relativePath}" from the Files panel`);
  console.log('');
}

function buildNotebookCells(
  title: string,
  template: string,
  usingStarterData: boolean,
  availableDataFiles: string[] = [],
): object[] {
  const id = () => Math.random().toString(36).slice(2, 10);

  // Pick the best available data source — prefer template-specific CSVs, fall back to any CSV
  function dataSrc(preferred: string[]): string {
    for (const name of preferred) {
      if (availableDataFiles.includes(name)) return `read_csv_auto('./data/${name}')`;
    }
    if (availableDataFiles.length > 0) return `read_csv_auto('./data/${availableDataFiles[0]}')`;
    return 'your_table';
  }

  if (template === 'revenue') {
    const src = dataSrc(['revenue.csv', 'orders.csv']);
    return [
      { id: id(), type: 'markdown', content: `# ${title}\n\nRevenue analysis using DQL and DuckDB.` },
      { id: id(), type: 'sql', name: 'revenue_summary', content: `SELECT *\nFROM ${src}\nLIMIT 100` },
    ];
  }

  if (template === 'pipeline') {
    const src = dataSrc(['pipeline.csv', 'orders.csv', 'funnel.csv']);
    return [
      { id: id(), type: 'markdown', content: `# ${title}\n\nPipeline health and conversion analysis.` },
      { id: id(), type: 'sql', name: 'pipeline_overview', content: `SELECT *\nFROM ${src}\nLIMIT 100` },
    ];
  }

  if (usingStarterData && availableDataFiles.length > 0) {
    const src = dataSrc(availableDataFiles);
    return [
      { id: id(), type: 'markdown', content: `# ${title}\n\nAdd your analysis here.` },
      { id: id(), type: 'sql', name: 'query_1', content: `SELECT *\nFROM ${src}\nLIMIT 10` },
    ];
  }

  return [
    { id: id(), type: 'markdown', content: `# ${title}\n\nAdd your analysis here.` },
    { id: id(), type: 'sql', name: 'query_1', content: `SELECT 1 AS hello` },
  ];
}

/** List CSV/Parquet/JSON files in the project's data/ directory */
function detectAvailableDataFiles(projectRoot: string): string[] {
  try {
    const dataDir = join(projectRoot, 'data');
    if (!existsSync(dataDir)) return [];
    return readdirSync(dataDir)
      .filter((f) => /\.(csv|parquet|json|jsonl|ndjson|xlsx)$/i.test(f))
      .sort();
  } catch {
    return [];
  }
}

function normalizeChart(value: string): string {
  const normalized = value.trim().toLowerCase();
  return normalized || 'bar';
}

function indentBlock(value: string, spaces: number): string {
  const prefix = ' '.repeat(spaces);
  return value.split('\n').map((line) => `${prefix}${line}`).join('\n');
}

function toSlug(value: string): string {
  return value
    .replace(/\.dql$/i, '')
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase() || 'new_asset';
}

function toTitle(value: string): string {
  const cleaned = value.replace(/\.dql$/i, '').trim();
  if (!cleaned) return 'New Asset';
  if (/[A-Z]/.test(cleaned) || cleaned.includes(' ')) {
    return cleaned.replace(/[_-]+/g, ' ');
  }
  return cleaned
    .split(/[_-]+/g)
    .map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : part)
    .join(' ');
}

function relativeToProject(projectRoot: string, filePath: string): string {
  const normalizedRoot = `${resolve(projectRoot)}/`;
  const normalizedPath = resolve(filePath);
  return normalizedPath.startsWith(normalizedRoot)
    ? normalizedPath.slice(normalizedRoot.length)
    : basename(filePath);
}

function capitalize(value: string): string {
  return `${value[0]?.toUpperCase() || ''}${value.slice(1)}`;
}

function writeSemanticCompanionFiles(
  projectRoot: string,
  slug: string,
  domain: string,
  owner: string,
  metricName: string,
  domainFirst = false,
): string[] {
  const metricDir = join(projectRoot, 'semantic-layer', 'metrics');
  const blockDir = domainFirst
    ? join(projectRoot, 'semantic-layer', 'blocks', toSlug(domain).replace(/_/g, '-'))
    : join(projectRoot, 'semantic-layer', 'blocks');
  mkdirSync(metricDir, { recursive: true });
  mkdirSync(blockDir, { recursive: true });

  const metricPath = join(metricDir, `${metricName}.yaml`);
  const blockPath = join(blockDir, `${slug}.yaml`);

  if (!existsSync(metricPath)) {
    writeFileSync(metricPath, `name: ${metricName}
label: ${toLabel(metricName)}
description: Starter semantic metric for ${toLabel(slug)}
domain: ${domain}
sql: SUM(measure)
type: sum
table: your_table
tags:
  - ${domain}
  - semantic
owner: ${owner}
`, 'utf-8');
  }

  if (!existsSync(blockPath)) {
    writeFileSync(blockPath, `name: ${slug}
block: ${slug}
domain: ${domain}
description: Companion business metadata for ${toLabel(slug)}
owner: ${owner}
tags:
  - ${domain}
  - semantic
semanticMappings:
  measure: ${metricName}
reviewStatus: review
`, 'utf-8');
  }

  return [relativeToProject(projectRoot, metricPath), relativeToProject(projectRoot, blockPath)];
}

function toLabel(value: string): string {
  return value
    .split(/[_-]+/g)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() || ''}${part.slice(1)}`)
    .join(' ');
}

function isDbtFirstProject(projectRoot: string): boolean {
  const config = loadProjectConfig(projectRoot);
  return modelingModeOf(config) === 'dbt-first';
}
