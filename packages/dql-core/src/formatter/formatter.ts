import type {
  BlockDeclNode,
  ChartCallNode,
  DashboardBodyItem,
  DashboardNode,
  DecoratorNode,
  ExpressionNode,
  FilterCallNode,
  ImportDeclNode,
  LayoutBlockNode,
  LayoutRowNode,
  BusinessViewDeclNode,
  DomainDeclNode,
  TermDeclNode,
  NamedArgNode,
  DigestNode,
  NarrativeNode,
  PageNode,
  ParamDeclNode,
  ProgramNode,
  SQLQueryNode,
  StatementNode,
  UseDeclNode,
  VariableDeclNode,
  WorkbookNode,
} from '../ast/nodes.js';
import { datasetBlockSectionLines } from '../ast/dataset-sections.js';
import { NodeKind } from '../ast/nodes.js';
import { parse } from '../parser/parser.js';

export interface FormatOptions {
  indent?: string;
  finalNewline?: boolean;
}

export function formatDQL(source: string, options: FormatOptions = {}): string {
  const ast = parse(source);
  return formatProgram(ast, options);
}

export function formatProgram(program: ProgramNode, options: FormatOptions = {}): string {
  const state: FormatState = {
    indentUnit: options.indent ?? '  ',
  };

  const out = program.statements
    .map((stmt) => formatStatement(stmt, 0, state))
    .join('\n\n')
    .trimEnd();

  if (options.finalNewline === false) return out;
  return `${out}\n`;
}

interface FormatState {
  indentUnit: string;
}

function indent(level: number, state: FormatState): string {
  return state.indentUnit.repeat(level);
}

function formatStatement(node: StatementNode, level: number, state: FormatState): string {
  switch (node.kind) {
    case NodeKind.Dashboard:
      return formatDashboard(node, level, state);
    case NodeKind.ChartCall:
      return formatChart(node, level, state);
    case NodeKind.Workbook:
      return formatWorkbook(node, level, state);
    case NodeKind.ImportDecl:
      return formatImport(node, level, state);
    case NodeKind.DomainDecl:
      return formatDomain(node, level, state);
    case NodeKind.BlockDecl:
      return formatBlock(node, level, state);
    case NodeKind.TermDecl:
      return formatTerm(node, level, state);
    case NodeKind.BusinessViewDecl:
      return formatBusinessView(node, level, state);
    case NodeKind.Digest:
      return formatDigest(node, level, state);
    default:
      return '';
  }
}

function formatDashboard(node: DashboardNode, level: number, state: FormatState): string {
  const lines: string[] = [];
  lines.push(...formatDecorators(node.decorators, level, state));
  lines.push(`${indent(level, state)}dashboard ${quote(node.title)} {`);
  for (const item of node.body) {
    lines.push(formatDashboardBodyItem(item, level + 1, state));
  }
  lines.push(`${indent(level, state)}}`);
  return lines.join('\n');
}

function formatDigest(node: DigestNode, level: number, state: FormatState): string {
  const lines: string[] = [];
  lines.push(...formatDecorators(node.decorators, level, state));
  lines.push(`${indent(level, state)}digest ${quote(node.title)} {`);
  if (node.narrative) {
    lines.push(formatNarrative(node.narrative, level + 1, state));
  }
  for (const item of node.body) {
    lines.push(formatDashboardBodyItem(item, level + 1, state));
  }
  lines.push(`${indent(level, state)}}`);
  return lines.join('\n');
}

function formatNarrative(node: NarrativeNode, level: number, state: FormatState): string {
  const lines: string[] = [];
  lines.push(`${indent(level, state)}narrative {`);
  for (const prop of node.properties) {
    lines.push(`${indent(level + 1, state)}${formatNamedArg(prop)}`);
  }
  lines.push(`${indent(level, state)}}`);
  return lines.join('\n');
}

function formatWorkbook(node: WorkbookNode, level: number, state: FormatState): string {
  const lines: string[] = [];
  lines.push(...formatDecorators(node.decorators, level, state));
  lines.push(`${indent(level, state)}workbook ${quote(node.title)} {`);
  for (const page of node.pages) {
    lines.push(formatPage(page, level + 1, state));
  }
  lines.push(`${indent(level, state)}}`);
  return lines.join('\n');
}

function formatPage(node: PageNode, level: number, state: FormatState): string {
  const lines: string[] = [];
  lines.push(`${indent(level, state)}page ${quote(node.title)} {`);
  for (const item of node.body) {
    lines.push(formatDashboardBodyItem(item, level + 1, state));
  }
  lines.push(`${indent(level, state)}}`);
  return lines.join('\n');
}

function formatDashboardBodyItem(node: DashboardBodyItem, level: number, state: FormatState): string {
  switch (node.kind) {
    case NodeKind.VariableDecl:
      return formatVariable(node, level, state);
    case NodeKind.ParamDecl:
      return formatParam(node, level, state);
    case NodeKind.ChartCall:
      return formatChart(node, level, state);
    case NodeKind.FilterCall:
      return formatFilter(node, level, state);
    case NodeKind.UseDecl:
      return formatUse(node, level, state);
    case NodeKind.LayoutBlock:
      return formatLayout(node, level, state);
    default:
      return '';
  }
}

function formatImport(node: ImportDeclNode, level: number, state: FormatState): string {
  return `${indent(level, state)}import { ${node.names.join(', ')} } from ${quote(node.path)}`;
}

function formatUse(node: UseDeclNode, level: number, state: FormatState): string {
  const isIdentifier = /^[A-Za-z_][A-Za-z0-9_]*$/.test(node.name);
  return `${indent(level, state)}use ${isIdentifier ? node.name : quote(node.name)}`;
}

function formatVariable(node: VariableDeclNode, level: number, state: FormatState): string {
  return `${indent(level, state)}let ${node.name} = ${formatExpression(node.initializer)}`;
}

function formatParam(node: ParamDeclNode, level: number, state: FormatState): string {
  const typePart = `: ${node.paramType}`;
  const defaultPart = node.defaultValue ? ` = ${formatExpression(node.defaultValue)}` : '';
  return `${indent(level, state)}param ${node.name}${typePart}${defaultPart}`;
}

function formatDecorators(decorators: DecoratorNode[], level: number, state: FormatState): string[] {
  return decorators.map((dec) => {
    if (dec.arguments.length === 0) return `${indent(level, state)}@${dec.name}`;
    const args = dec.arguments.map((arg) => formatExpression(arg)).join(', ');
    return `${indent(level, state)}@${dec.name}(${args})`;
  });
}

function formatChart(node: ChartCallNode, level: number, state: FormatState): string {
  return formatCall(`chart.${node.chartType}`, node.decorators, node.query, node.args, level, state);
}

function formatFilter(node: FilterCallNode, level: number, state: FormatState): string {
  return formatCall(`filter.${node.filterType}`, [], node.query, node.args, level, state);
}

function formatCall(
  callName: string,
  decorators: DecoratorNode[],
  query: SQLQueryNode | undefined,
  args: NamedArgNode[],
  level: number,
  state: FormatState,
): string {
  const lines: string[] = [];
  lines.push(...formatDecorators(decorators, level, state));
  lines.push(`${indent(level, state)}${callName}(`);

  const parts: string[][] = [];
  if (query) {
    parts.push(formatSQLQuery(query, level + 1, state));
  }
  for (const arg of args) {
    parts.push([`${indent(level + 1, state)}${formatNamedArg(arg)}`]);
  }

  for (let i = 0; i < parts.length; i++) {
    const isLast = i === parts.length - 1;
    const chunk = parts[i];
    for (let j = 0; j < chunk.length; j++) {
      const lastInChunk = j === chunk.length - 1;
      lines.push(lastInChunk && !isLast ? `${chunk[j]},` : chunk[j]);
    }
  }

  lines.push(`${indent(level, state)})`);
  return lines.join('\n');
}

function formatLayout(node: LayoutBlockNode, level: number, state: FormatState): string {
  const lines: string[] = [];
  lines.push(`${indent(level, state)}layout(columns = ${node.columns}) {`);
  for (const row of node.rows) {
    lines.push(formatLayoutRow(row, level + 1, state));
  }
  lines.push(`${indent(level, state)}}`);
  return lines.join('\n');
}

function formatLayoutRow(node: LayoutRowNode, level: number, state: FormatState): string {
  const lines: string[] = [];
  lines.push(`${indent(level, state)}row {`);
  for (const item of node.items) {
    const body = item.node.kind === NodeKind.ChartCall
      ? formatChart(item.node, level + 1, state)
      : formatFilter(item.node, level + 1, state);

    if (item.span == null) {
      lines.push(body);
      continue;
    }

    const parts = body.split('\n');
    parts[parts.length - 1] = `${parts[parts.length - 1]} span ${item.span}`;
    lines.push(parts.join('\n'));
  }
  lines.push(`${indent(level, state)}}`);
  return lines.join('\n');
}

function formatBlock(node: BlockDeclNode, level: number, state: FormatState): string {
  const lines: string[] = [];
  lines.push(...formatDecorators(node.decorators, level, state));
  lines.push(`${indent(level, state)}block ${quote(node.name)} {`);

  if (node.domain) lines.push(`${indent(level + 1, state)}domain = ${quote(node.domain)}`);
  if (node.blockType) lines.push(`${indent(level + 1, state)}type = ${quote(node.blockType)}`);
  if (node.status) lines.push(`${indent(level + 1, state)}status = ${quote(node.status)}`);
  if (node.replacedBy) lines.push(`${indent(level + 1, state)}replacedBy = ${quote(node.replacedBy)}`);
  if (node.deprecatedOn) lines.push(`${indent(level + 1, state)}deprecatedOn = ${quote(node.deprecatedOn)}`);
  if (node.datasetTileProvenance) lines.push(`${indent(level + 1, state)}dataset_tile_provenance = ${quote(JSON.stringify(node.datasetTileProvenance))}`);
  if (node.derivedFrom) lines.push(`${indent(level + 1, state)}derived_from = ${quote(JSON.stringify(node.derivedFrom))}`);
  if (node.semanticTileConversionProvenance) lines.push(`${indent(level + 1, state)}semantic_tile_conversion_provenance = ${quote(JSON.stringify(node.semanticTileConversionProvenance))}`);
  if (node.description) lines.push(`${indent(level + 1, state)}description = ${quote(node.description)}`);
  if (node.tags && node.tags.length > 0) {
    lines.push(`${indent(level + 1, state)}tags = [${node.tags.map(quote).join(', ')}]`);
  }
  if (node.owner) lines.push(`${indent(level + 1, state)}owner = ${quote(node.owner)}`);
  if (node.termRefs && node.termRefs.length > 0) {
    lines.push(`${indent(level + 1, state)}terms = [${node.termRefs.map(quote).join(', ')}]`);
  }
  if (node.pattern) lines.push(`${indent(level + 1, state)}pattern = ${quote(node.pattern)}`);
  if (node.datasetGrain || node.datasetFields?.length || node.datasetMeasures?.length) {
    lines.push(...datasetBlockSectionLines(node, (depth) => indent(level + depth, state), quote));
  }
  if (!node.datasetGrain && node.grain) lines.push(`${indent(level + 1, state)}grain = ${quote(node.grain)}`);
  if (node.entities && node.entities.length > 0) {
    lines.push(`${indent(level + 1, state)}entities = [${node.entities.map(quote).join(', ')}]`);
  }
  if (node.outputs && node.outputs.length > 0) {
    lines.push(`${indent(level + 1, state)}outputs = [${node.outputs.map(quote).join(', ')}]`);
  }
  if (node.blockType !== 'semantic' && node.dimensions && node.dimensions.length > 0) {
    lines.push(`${indent(level + 1, state)}dimensions = [${node.dimensions.map(quote).join(', ')}]`);
  }
  if (node.allowedFilters && node.allowedFilters.length > 0) {
    lines.push(`${indent(level + 1, state)}allowedFilters = [${node.allowedFilters.map(quote).join(', ')}]`);
  }
  if (node.parameterPolicy && node.parameterPolicy.length > 0) {
    lines.push(`${indent(level + 1, state)}parameterPolicy {`);
    for (const entry of node.parameterPolicy) {
      lines.push(`${indent(level + 2, state)}${entry.name} = ${quote(entry.policy)}`);
    }
    lines.push(`${indent(level + 1, state)}}`);
  }
  if (node.filterBindings && node.filterBindings.length > 0) {
    lines.push(`${indent(level + 1, state)}filterBindings {`);
    for (const entry of node.filterBindings) {
      lines.push(`${indent(level + 2, state)}${entry.filter} = ${quote(entry.binding)}`);
    }
    lines.push(`${indent(level + 1, state)}}`);
  }
  if (node.metricMappings && node.metricMappings.length > 0) {
    lines.push(`${indent(level + 1, state)}metricMappings {`);
    for (const entry of node.metricMappings) {
      lines.push(`${indent(level + 2, state)}${entry.output} {`);
      lines.push(`${indent(level + 3, state)}metric = ${quote(entry.metric)}`);
      if (entry.filter) lines.push(`${indent(level + 3, state)}filter = ${quote(entry.filter)}`);
      lines.push(`${indent(level + 2, state)}}`);
    }
    lines.push(`${indent(level + 1, state)}}`);
  }
  if (node.sourceSystems && node.sourceSystems.length > 0) {
    lines.push(`${indent(level + 1, state)}sourceSystems = [${node.sourceSystems.map(quote).join(', ')}]`);
  }
  if (node.replacementFor && node.replacementFor.length > 0) {
    lines.push(`${indent(level + 1, state)}replacementFor = [${node.replacementFor.map(quote).join(', ')}]`);
  }
  if (node.llmContext) lines.push(`${indent(level + 1, state)}llmContext = ${quote(node.llmContext)}`);
  if (node.businessOutcome) lines.push(`${indent(level + 1, state)}businessOutcome = ${quote(node.businessOutcome)}`);
  if (node.businessOwner) lines.push(`${indent(level + 1, state)}businessOwner = ${quote(node.businessOwner)}`);
  if (node.decisionUse) lines.push(`${indent(level + 1, state)}decisionUse = ${quote(node.decisionUse)}`);
  if (node.reviewCadence) lines.push(`${indent(level + 1, state)}reviewCadence = ${quote(node.reviewCadence)}`);
  if (node.businessRules && node.businessRules.length > 0) {
    lines.push(`${indent(level + 1, state)}businessRules = [${node.businessRules.map(quote).join(', ')}]`);
  }
  if (node.caveats && node.caveats.length > 0) {
    lines.push(`${indent(level + 1, state)}caveats = [${node.caveats.map(quote).join(', ')}]`);
  }
  if (node.synonyms && node.synonyms.length > 0) {
    lines.push(`${indent(level + 1, state)}synonyms = [${node.synonyms.map(quote).join(', ')}]`);
  }
  if (node.primaryTerms && node.primaryTerms.length > 0) {
    lines.push(`${indent(level + 1, state)}primaryTerms = [${node.primaryTerms.map(quote).join(', ')}]`);
  }
  if (node.examples && node.examples.length > 0) {
    lines.push(`${indent(level + 1, state)}examples = [${formatBlockExamples(node.examples)}]`);
  }
  if (node.invariants && node.invariants.length > 0) {
    lines.push(`${indent(level + 1, state)}invariants = [${node.invariants.map(quote).join(', ')}]`);
  }
  if (node.blockType === 'semantic') {
    const metrics = node.metricsRef ?? (node.metricRef !== undefined ? [node.metricRef] : []);
    lines.push(`${indent(level + 1, state)}metrics = [${metrics.map(quote).join(', ')}]`);
    lines.push(`${indent(level + 1, state)}dimensions = [${(node.dimensionsRef ?? []).map(quote).join(', ')}]`);
    if (node.timeDimension) {
      lines.push(`${indent(level + 1, state)}time_dimension = ${quote(node.timeDimension)}`);
    }
    if (node.granularity) {
      lines.push(`${indent(level + 1, state)}granularity = ${quote(node.granularity)}`);
    }
    if (node.requestedFilters && node.requestedFilters.length > 0) {
      lines.push(`${indent(level + 1, state)}requested_filters = [${node.requestedFilters.map(quote).join(', ')}]`);
    }
    if (node.orderBy && node.orderBy.length > 0) {
      lines.push(`${indent(level + 1, state)}order_by = [${node.orderBy.map(quote).join(', ')}]`);
    }
    if (node.limit !== undefined) {
      lines.push(`${indent(level + 1, state)}limit = ${node.limit}`);
    }
  }

  if (node.params) {
    lines.push(`${indent(level + 1, state)}params {`);
    for (const entry of node.params.params) {
      const typeSuffix = entry.paramType ? `: ${entry.paramType}` : '';
      const defaultSuffix = entry.initializer ? ` = ${formatExpression(entry.initializer)}` : '';
      lines.push(`${indent(level + 2, state)}${entry.name}${typeSuffix}${defaultSuffix}`);
    }
    lines.push(`${indent(level + 1, state)}}`);
  }

  if (node.query) {
    lines.push(`${indent(level + 1, state)}query = """`);
    lines.push(...formatSQLQuery(node.query, level + 2, state));
    lines.push(`${indent(level + 1, state)}"""`);
  }

  if (node.visualization) {
    lines.push(`${indent(level + 1, state)}visualization {`);
    for (const prop of node.visualization.properties) {
      lines.push(`${indent(level + 2, state)}${formatNamedArg(prop)}`);
    }
    lines.push(`${indent(level + 1, state)}}`);
  }

  if (node.tests && node.tests.length > 0) {
    lines.push(`${indent(level + 1, state)}tests {`);
    for (const test of node.tests) {
      lines.push(
        `${indent(level + 2, state)}assert ${test.field} ${test.operator} ${formatExpression(test.expected)}`,
      );
    }
    lines.push(`${indent(level + 1, state)}}`);
  }

  lines.push(`${indent(level, state)}}`);
  return lines.join('\n');
}

function formatDomain(node: DomainDeclNode, level: number, state: FormatState): string {
  const lines: string[] = [];
  lines.push(...formatDecorators(node.decorators, level, state));
  lines.push(`${indent(level, state)}domain ${quote(node.name)} {`);

  if (node.id) lines.push(`${indent(level + 1, state)}id = ${quote(node.id)}`);
  if (node.parent) lines.push(`${indent(level + 1, state)}parent = ${quote(node.parent)}`);
  if (node.owner) lines.push(`${indent(level + 1, state)}owner = ${quote(node.owner)}`);
  if (node.businessOwner) lines.push(`${indent(level + 1, state)}businessOwner = ${quote(node.businessOwner)}`);
  if (node.boundedContext) lines.push(`${indent(level + 1, state)}boundedContext = ${quote(node.boundedContext)}`);
  if (node.sourceSystems && node.sourceSystems.length > 0) {
    lines.push(`${indent(level + 1, state)}sourceSystems = [${node.sourceSystems.map(quote).join(', ')}]`);
  }
  if (node.primaryTerms && node.primaryTerms.length > 0) {
    lines.push(`${indent(level + 1, state)}primaryTerms = [${node.primaryTerms.map(quote).join(', ')}]`);
  }
  if (node.reviewCadence) lines.push(`${indent(level + 1, state)}reviewCadence = ${quote(node.reviewCadence)}`);
  if (node.tags && node.tags.length > 0) {
    lines.push(`${indent(level + 1, state)}tags = [${node.tags.map(quote).join(', ')}]`);
  }
  if (node.businessOutcome) lines.push(`${indent(level + 1, state)}businessOutcome = ${quote(node.businessOutcome)}`);
  if (node.description) lines.push(`${indent(level + 1, state)}description = ${quote(node.description)}`);
  if (node.inScope?.length) lines.push(`${indent(level + 1, state)}inScope = [${node.inScope.map(quote).join(', ')}]`);
  if (node.outOfScope?.length) lines.push(`${indent(level + 1, state)}outOfScope = [${node.outOfScope.map(quote).join(', ')}]`);
  if (node.dbtGroups?.length) lines.push(`${indent(level + 1, state)}dbtGroups = [${node.dbtGroups.map(quote).join(', ')}]`);
  if (node.dbtPaths?.length) lines.push(`${indent(level + 1, state)}dbtPaths = [${node.dbtPaths.map(quote).join(', ')}]`);
  if (node.dbtTags?.length) lines.push(`${indent(level + 1, state)}dbtTags = [${node.dbtTags.map(quote).join(', ')}]`);
  if (node.semanticDomains?.length) lines.push(`${indent(level + 1, state)}semanticDomains = [${node.semanticDomains.map(quote).join(', ')}]`);
  if (node.semanticTags?.length) lines.push(`${indent(level + 1, state)}semanticTags = [${node.semanticTags.map(quote).join(', ')}]`);
  if (node.exports?.length) lines.push(`${indent(level + 1, state)}exports = [${node.exports.map(quote).join(', ')}]`);

  lines.push(`${indent(level, state)}}`);
  return lines.join('\n');
}

function formatTerm(node: TermDeclNode, level: number, state: FormatState): string {
  const lines: string[] = [];
  lines.push(...formatDecorators(node.decorators, level, state));
  lines.push(`${indent(level, state)}term ${quote(node.name)} {`);

  if (node.domain) lines.push(`${indent(level + 1, state)}domain = ${quote(node.domain)}`);
  if (node.termType) lines.push(`${indent(level + 1, state)}type = ${quote(node.termType)}`);
  if (node.status) lines.push(`${indent(level + 1, state)}status = ${quote(node.status)}`);
  if (node.description) lines.push(`${indent(level + 1, state)}description = ${quote(node.description)}`);
  if (node.tags && node.tags.length > 0) {
    lines.push(`${indent(level + 1, state)}tags = [${node.tags.map(quote).join(', ')}]`);
  }
  if (node.owner) lines.push(`${indent(level + 1, state)}owner = ${quote(node.owner)}`);
  if (node.identifiers && node.identifiers.length > 0) {
    lines.push(`${indent(level + 1, state)}identifiers = [${node.identifiers.map(quote).join(', ')}]`);
  }
  if (node.synonyms && node.synonyms.length > 0) {
    lines.push(`${indent(level + 1, state)}synonyms = [${node.synonyms.map(quote).join(', ')}]`);
  }
  if (node.businessOutcome) lines.push(`${indent(level + 1, state)}businessOutcome = ${quote(node.businessOutcome)}`);
  if (node.businessOwner) lines.push(`${indent(level + 1, state)}businessOwner = ${quote(node.businessOwner)}`);
  if (node.decisionUse) lines.push(`${indent(level + 1, state)}decisionUse = ${quote(node.decisionUse)}`);
  if (node.reviewCadence) lines.push(`${indent(level + 1, state)}reviewCadence = ${quote(node.reviewCadence)}`);
  if (node.businessRules && node.businessRules.length > 0) {
    lines.push(`${indent(level + 1, state)}businessRules = [${node.businessRules.map(quote).join(', ')}]`);
  }
  if (node.caveats && node.caveats.length > 0) {
    lines.push(`${indent(level + 1, state)}caveats = [${node.caveats.map(quote).join(', ')}]`);
  }

  lines.push(`${indent(level, state)}}`);
  return lines.join('\n');
}

function formatBusinessView(node: BusinessViewDeclNode, level: number, state: FormatState): string {
  const lines: string[] = [];
  lines.push(...formatDecorators(node.decorators, level, state));
  lines.push(`${indent(level, state)}business_view ${quote(node.name)} {`);

  if (node.domain) lines.push(`${indent(level + 1, state)}domain = ${quote(node.domain)}`);
  if (node.status) lines.push(`${indent(level + 1, state)}status = ${quote(node.status)}`);
  if (node.description) lines.push(`${indent(level + 1, state)}description = ${quote(node.description)}`);
  if (node.tags && node.tags.length > 0) {
    lines.push(`${indent(level + 1, state)}tags = [${node.tags.map(quote).join(', ')}]`);
  }
  if (node.owner) lines.push(`${indent(level + 1, state)}owner = ${quote(node.owner)}`);
  if (node.termRefs && node.termRefs.length > 0) {
    lines.push(`${indent(level + 1, state)}terms = [${node.termRefs.map(quote).join(', ')}]`);
  }
  if (node.businessOutcome) lines.push(`${indent(level + 1, state)}businessOutcome = ${quote(node.businessOutcome)}`);
  if (node.businessOwner) lines.push(`${indent(level + 1, state)}businessOwner = ${quote(node.businessOwner)}`);
  if (node.decisionUse) lines.push(`${indent(level + 1, state)}decisionUse = ${quote(node.decisionUse)}`);
  if (node.reviewCadence) lines.push(`${indent(level + 1, state)}reviewCadence = ${quote(node.reviewCadence)}`);
  if (node.businessRules && node.businessRules.length > 0) {
    lines.push(`${indent(level + 1, state)}businessRules = [${node.businessRules.map(quote).join(', ')}]`);
  }
  if (node.caveats && node.caveats.length > 0) {
    lines.push(`${indent(level + 1, state)}caveats = [${node.caveats.map(quote).join(', ')}]`);
  }

  lines.push(`${indent(level + 1, state)}includes {`);
  for (const ref of node.includes) {
    lines.push(`${indent(level + 2, state)}${ref.refType} ${quote(ref.name)}`);
  }
  lines.push(`${indent(level + 1, state)}}`);

  lines.push(`${indent(level, state)}}`);
  return lines.join('\n');
}

function formatSQLQuery(query: SQLQueryNode, level: number, state: FormatState): string[] {
  const sql = query.rawSQL.replace(/^\n+|\s+$/g, '');
  if (!sql.trim()) return [`${indent(level, state)}SELECT 1`];
  const rawLines = sql.split('\n').map((line) => line.trimEnd());
  // The first line is often on the same line as the opening delimiter
  // (e.g. `chart.bar(SELECT ...`) and so has no meaningful leading
  // indent. Use indentation from subsequent non-empty lines as the
  // dedent baseline; fall back to the first line only if that's all we have.
  const tail = rawLines.slice(1).filter((l) => l.length > 0);
  const sample = tail.length ? tail : rawLines.filter((l) => l.length > 0);
  const minLeading = sample.length
    ? Math.min(...sample.map((l) => l.match(/^[ \t]*/)![0].length))
    : 0;
  return rawLines.map((line) => {
    if (line.length === 0) return '';
    const stripped = line.startsWith(' '.repeat(minLeading)) || line.startsWith('\t'.repeat(minLeading))
      ? line.slice(minLeading)
      : line.trimStart();
    return `${indent(level, state)}${stripped}`;
  });
}

function formatNamedArg(arg: NamedArgNode): string {
  return `${arg.name} = ${formatExpression(arg.value)}`;
}

function formatBlockExamples(examples: Array<{ question: string; sql?: string }>): string {
  return examples
    .map((example) => {
      const props = [`question = ${quote(example.question)}`];
      if (example.sql) props.push(`sql = ${quote(example.sql)}`);
      return `{ ${props.join(', ')} }`;
    })
    .join(', ');
}

function formatExpression(node: ExpressionNode): string {
  switch (node.kind) {
    case NodeKind.StringLiteral:
      return quote(node.value);
    case NodeKind.NumberLiteral:
      return String(node.value);
    case NodeKind.BooleanLiteral:
      return node.value ? 'true' : 'false';
    case NodeKind.Identifier:
      return node.name;
    case NodeKind.ArrayLiteral:
      return `[${node.elements.map((el) => formatExpression(el)).join(', ')}]`;
    case NodeKind.BinaryExpr:
      return `${formatExpression(node.left)} ${node.operator} ${formatExpression(node.right)}`;
    case NodeKind.IntervalExpr:
      return `INTERVAL ${quote(node.value)}`;
    case NodeKind.FunctionCall:
      return `${node.callee}(${node.arguments.map((arg) => formatExpression(arg)).join(', ')})`;
    case NodeKind.TemplateString:
      return quote(
        node.parts
          .map((part) => (typeof part === 'string' ? part : `{${formatExpression(part)}}`))
          .join(''),
      );
    default:
      return '';
  }
}

function quote(value: string): string {
  return JSON.stringify(value);
}
