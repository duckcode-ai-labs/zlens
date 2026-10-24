import type { SourceSpan } from '../errors/diagnostic.js';
import type { DatasetTileProvenanceV1, SemanticTileConversionProvenanceV1 } from '../datasets/provenance.js';

// ---- Node Kinds ----

export enum NodeKind {
  Program = 'Program',
  Workbook = 'Workbook',
  Page = 'Page',
  Dashboard = 'Dashboard',
  ChartCall = 'ChartCall',
  FilterCall = 'FilterCall',
  VariableDecl = 'VariableDecl',
  ParamDecl = 'ParamDecl',
  ImportDecl = 'ImportDecl',
  UseDecl = 'UseDecl',
  LayoutBlock = 'LayoutBlock',
  LayoutRow = 'LayoutRow',
  Decorator = 'Decorator',
  SQLQuery = 'SQLQuery',
  NamedArg = 'NamedArg',
  StringLiteral = 'StringLiteral',
  NumberLiteral = 'NumberLiteral',
  BooleanLiteral = 'BooleanLiteral',
  ArrayLiteral = 'ArrayLiteral',
  Identifier = 'Identifier',
  BinaryExpr = 'BinaryExpr',
  IntervalExpr = 'IntervalExpr',
  FunctionCall = 'FunctionCall',
  TemplateString = 'TemplateString',
  BlockDecl = 'BlockDecl',
  DomainDecl = 'DomainDecl',
  TermDecl = 'TermDecl',
  BusinessViewDecl = 'BusinessViewDecl',
  BusinessViewInclude = 'BusinessViewInclude',
  BlockParams = 'BlockParams',
  BlockVisualization = 'BlockVisualization',
  BlockTest = 'BlockTest',
  Digest = 'Digest',
  Narrative = 'Narrative',
}

// ---- Base ----

export interface BaseNode {
  kind: NodeKind;
  span: SourceSpan;
}

// ---- Chart Types ----

export type ChartType =
  | 'line'
  | 'bar'
  | 'kpi'
  | 'pie'
  | 'scatter'
  | 'area'
  | 'heatmap'
  | 'table'
  | 'metric'
  | 'stacked_bar'
  | 'grouped_bar'
  | 'combo'
  | 'histogram'
  | 'funnel'
  | 'treemap'
  | 'sankey'
  | 'sparkline'
  | 'small_multiples'
  | 'gauge'
  | 'waterfall'
  | 'boxplot'
  | 'geo';

// ---- Top-level ----

export interface ProgramNode extends BaseNode {
  kind: NodeKind.Program;
  statements: StatementNode[];
}

export type StatementNode =
  | DashboardNode
  | ChartCallNode
  | WorkbookNode
  | ImportDeclNode
  | DomainDeclNode
  | BlockDeclNode
  | TermDeclNode
  | BusinessViewDeclNode
  | DigestNode;

// ---- Dashboard ----

export interface DashboardNode extends BaseNode {
  kind: NodeKind.Dashboard;
  title: string;
  decorators: DecoratorNode[];
  body: DashboardBodyItem[];
}

export type DashboardBodyItem = VariableDeclNode | ParamDeclNode | ChartCallNode | FilterCallNode | UseDeclNode | LayoutBlockNode;

// ---- Digest ----
//
// `digest "Title" { @schedule(...) narrative { prompt: "..." sources: [ref("…")] } chart.line(...) }`
// Parses exactly like a dashboard, with one extra optional child: a single narrative block.

export interface DigestNode extends BaseNode {
  kind: NodeKind.Digest;
  title: string;
  decorators: DecoratorNode[];
  narrative?: NarrativeNode;
  body: DashboardBodyItem[];
}

export interface NarrativeNode extends BaseNode {
  kind: NodeKind.Narrative;
  properties: NamedArgNode[];
}

// ---- Chart ----

export interface ChartCallNode extends BaseNode {
  kind: NodeKind.ChartCall;
  chartType: ChartType;
  query: SQLQueryNode;
  args: NamedArgNode[];
  decorators: DecoratorNode[];
}

// ---- Filter Types ----

export type FilterType = 'dropdown' | 'date_range' | 'text' | 'multi_select' | 'range';

// ---- Filter ----

export interface FilterCallNode extends BaseNode {
  kind: NodeKind.FilterCall;
  filterType: FilterType;
  query?: SQLQueryNode;
  args: NamedArgNode[];
}

// ---- SQL ----

export interface SQLQueryNode extends BaseNode {
  kind: NodeKind.SQLQuery;
  rawSQL: string;
  interpolations: TemplateInterpolation[];
}

export interface TemplateInterpolation {
  variableName: string;
  offsetInSQL: number;
  span: SourceSpan;
}

// ---- Variables ----

export interface VariableDeclNode extends BaseNode {
  kind: NodeKind.VariableDecl;
  name: string;
  initializer: ExpressionNode;
}

// ---- Decorators ----

export interface DecoratorNode extends BaseNode {
  kind: NodeKind.Decorator;
  name: string;
  arguments: ExpressionNode[];
}

// ---- Named Arguments ----

export interface NamedArgNode extends BaseNode {
  kind: NodeKind.NamedArg;
  name: string;
  value: ExpressionNode;
}

// ---- Expressions ----

export type ExpressionNode =
  | StringLiteralNode
  | NumberLiteralNode
  | BooleanLiteralNode
  | ArrayLiteralNode
  | IdentifierNode
  | BinaryExprNode
  | IntervalExprNode
  | FunctionCallNode
  | TemplateStringNode;

export interface StringLiteralNode extends BaseNode {
  kind: NodeKind.StringLiteral;
  value: string;
}

export interface NumberLiteralNode extends BaseNode {
  kind: NodeKind.NumberLiteral;
  value: number;
}

export interface BooleanLiteralNode extends BaseNode {
  kind: NodeKind.BooleanLiteral;
  value: boolean;
}

export interface ArrayLiteralNode extends BaseNode {
  kind: NodeKind.ArrayLiteral;
  elements: ExpressionNode[];
}

export interface IdentifierNode extends BaseNode {
  kind: NodeKind.Identifier;
  name: string;
}

export interface BinaryExprNode extends BaseNode {
  kind: NodeKind.BinaryExpr;
  operator: '+' | '-';
  left: ExpressionNode;
  right: ExpressionNode;
}

export interface IntervalExprNode extends BaseNode {
  kind: NodeKind.IntervalExpr;
  value: string;
}

export interface FunctionCallNode extends BaseNode {
  kind: NodeKind.FunctionCall;
  callee: string;
  arguments: ExpressionNode[];
}

export interface TemplateStringNode extends BaseNode {
  kind: NodeKind.TemplateString;
  parts: Array<string | ExpressionNode>;
}

// ---- Workbook / Page ----

export interface WorkbookNode extends BaseNode {
  kind: NodeKind.Workbook;
  title: string;
  decorators: DecoratorNode[];
  pages: PageNode[];
}

export interface PageNode extends BaseNode {
  kind: NodeKind.Page;
  title: string;
  body: DashboardBodyItem[];
}

// ---- Param Declaration ----

export type ParamType = 'string' | 'number' | 'boolean' | 'date';

export interface ParamDeclNode extends BaseNode {
  kind: NodeKind.ParamDecl;
  name: string;
  paramType: ParamType;
  defaultValue?: ExpressionNode;
}

// ---- Import / Use ----

export interface ImportDeclNode extends BaseNode {
  kind: NodeKind.ImportDecl;
  names: string[];
  path: string;
}

export interface UseDeclNode extends BaseNode {
  kind: NodeKind.UseDecl;
  name: string;
}

// ---- Block Declaration (architecture spec) ----

export interface BlockDeclNode extends BaseNode {
  kind: NodeKind.BlockDecl;
  name: string;
  domain?: string;
  /** Execution routing type. 'semantic' routes to MetricFlow; 'custom' routes to the SQL runtime. Required. */
  blockType: 'semantic' | 'custom';
  /** For blockType 'semantic': the dbt metric name this block references. Must not have a query field. */
  metricRef?: string;
  /** For blockType 'semantic': multiple metric references. Takes precedence over metricRef when present. */
  metricsRef?: string[];
  /** For blockType 'semantic': semantic dimension references used to group the metric query. */
  dimensionsRef?: string[];
  description?: string;
  tags?: string[];
  owner?: string;
  /** Business glossary terms this block implements or depends on. */
  termRefs?: string[];
  /** Enterprise reusable-widget metadata: declared output grain, entities, outputs, filters, and replacement path. */
  pattern?: string;
  /**
   * Field-based App dataset grain. `grain?: string` stays below for legacy
   * manifest consumers; object grain source is represented here instead.
   */
  datasetGrain?: BlockDatasetGrain;
  /** Reviewed physical field declarations for a dataset block. */
  datasetFields?: BlockDatasetFieldEntry[];
  /** Reviewed measures for a dataset block. Physical and measure names may overlap. */
  datasetMeasures?: BlockDatasetMeasureEntry[];
  grain?: string;
  entities?: string[];
  outputs?: string[];
  /** Business dimensions available for grouping/filtering custom reusable blocks. */
  dimensions?: string[];
  allowedFilters?: string[];
  /** Parameter reuse contract: dynamic/static/business/derived review intent per parameter. */
  parameterPolicy?: BlockParameterPolicyEntry[];
  /** Maps business/app filters to the physical column/expression this block accepts. */
  filterBindings?: BlockFilterBindingEntry[];
  /**
   * Which semantic metric an output column answers, and under which filter.
   * Ask uses it to serve this block as the certified answer to a question
   * about that metric when the block's SQL is too complex to compare. The
   * metric must exist in the semantic layer; `zlens compile` checks it.
   */
  metricMappings?: BlockMetricMappingEntry[];
  sourceSystems?: string[];
  replacementFor?: string[];
  params?: BlockParamsNode;
  /** For blockType 'custom': the SQL query. Must not be present on 'semantic' blocks. */
  query?: SQLQueryNode;
  visualization?: BlockVisualizationNode;
  tests?: BlockTestNode[];
  decorators: DecoratorNode[];
  /**
   * v1.2 Track G — agent-facing metadata. All optional, additive.
   * `llmContext` is a one-paragraph NL description MCP surfaces to agents;
   * `examples` are sample (question, sql) pairs chat cells can few-shot on;
   * `invariants` are free-form assertions a block's result should hold.
   */
  llmContext?: string;
  invariants?: string[];
  examples?: Array<{ question: string; sql?: string }>;
  /** Agent evidence metadata surfaced in governed analytics answers. */
  businessOutcome?: string;
  businessOwner?: string;
  decisionUse?: string;
  reviewCadence?: string;
  businessRules?: string[];
  caveats?: string[];
  /** Question aliases: other words people use for what the block answers. Ask matches on them. */
  synonyms?: string[];
  /** Business terms in the block's own words; unlike `terms` they need not name a declared term. */
  primaryTerms?: string[];
  /**
   * v1.4 — block certification status declared in source. Recognised values
   * are 'draft' | 'review' | 'certified' | 'deprecated' | 'pending_recertification'
   * (BlockStatus from dql-project). The manifest builder, certifier, and
   * agent's "block-first" matcher all read this.
   */
  status?: string;
  /**
   * Retirement metadata, meaningful only when `status = "deprecated"`.
   * `replacedBy` names the block that supersedes this one (block name, or a
   * `.dql` path relative to the project); `deprecatedOn` is the ISO date
   * (YYYY-MM-DD) the block was retired. The inverse of `replacementFor`,
   * which the new block may also declare.
   */
  replacedBy?: string;
  deprecatedOn?: string;
  /**
   * v1.6 — DataLex contract reference. Format:
   * `<domain>.<Entity>.<contract_name>` with optional `@<version>` suffix.
   * The compile-time check resolves this against the project's DataLex
   * manifest (see contracts/registry.ts) and emits diagnostics for
   * not_found / version_mismatch / malformed_ref. Required link to the
   * manifest-spec interop pattern; see docs/interop.md.
   */
  datalexContract?: string;
  /** Tier-2 generated draft metadata. These fields are valid only as flat keys. */
  askedTimes?: number;
  firstAsked?: string;
  lastAsked?: string;
  proposedContractId?: string;
  proposedDomain?: string;
  proposedEntity?: string;
  sourceQuestion?: string;
  sourceBlock?: string;
  sourceDqlKind?: string;
  sourceDqlName?: string;
  sourceDqlPath?: string;
  sourceDqlHash?: string;
  sourceDqlMetrics?: string[];
  sourceDqlDimensions?: string[];
  sourceDqlFilters?: string[];
  sourceDqlTimeDimension?: string;
  sourceDqlGranularity?: string;
  sourceDqlOrderBy?: string[];
  sourceDqlLimit?: number;
  followupKind?: string;
  contextPackId?: string;
  routeIntent?: string;
  timeDimension?: string;
  granularity?: string;
  draftPath?: string;
  upstreamRefs?: string[];
  requestedFilters?: string[];
  requestedDimensions?: string[];
  orderBy?: string[];
  limit?: number;
  validationWarnings?: string[];
  /** M4 App Dataset tile lineage retained on a review draft block. */
  datasetTileProvenance?: DatasetTileProvenanceV1;
  /** The same lineage retained after an explicit later certification. */
  derivedFrom?: DatasetTileProvenanceV1;
  /** Exact, user-invoked legacy semantic conversion lineage. */
  semanticTileConversionProvenance?: SemanticTileConversionProvenanceV1;
}

export interface BlockDatasetGrain {
  entities: string[];
  keys: string[];
  /** Reference to a reviewed uniqueness/fanout proof; never inferred from a preview. */
  keyEvidence?: string;
  description?: string;
  timeGrain?: string;
  /** Exact approved physical time bucket emitted by an aggregate Dataset source. */
  timeBucketBy?: string;
  aggregate?: boolean;
}

export interface BlockDatasetFieldEntry {
  name: string;
  role: 'dimension' | 'key' | 'time' | 'attribute';
  type?: 'string' | 'number' | 'boolean' | 'date' | 'timestamp';
  grains?: string[];
  primary?: boolean;
  hierarchy?: string;
  level?: number;
  status?: 'approved' | 'suggested';
}

export interface BlockDatasetMeasureEntry {
  name: string;
  aggregation: 'sum' | 'count' | 'count_distinct' | 'ratio' | 'avg' | 'min' | 'max';
  from?: string;
  numerator?: string;
  denominator?: string;
  /** Canonical bounded aggregate expression for a calculated Dataset measure. */
  expression?: string;
  /**
   * Exact physical time field that supplies a time-additivity assertion for
   * this measure.  It is meaningful for a distinct entity only when a
   * current, full-source proof also binds the Dataset grain.
   */
  timeBucketBy?: string;
  additive: 'additive' | 'semi_additive' | 'non_additive';
  entityAdditive?: 'additive' | 'semi_additive' | 'non_additive';
  allowedAggs?: Array<'sum' | 'count' | 'count_distinct' | 'ratio' | 'avg' | 'min' | 'max'>;
  format?: 'number' | 'currency' | 'percent';
  currency?: string;
  status?: 'approved' | 'suggested';
}

// ---- Domain Declaration ----

export interface DomainDeclNode extends BaseNode {
  kind: NodeKind.DomainDecl;
  name: string;
  /** Stable dot-qualified package id. Falls back to the normalized name for legacy declarations. */
  id?: string;
  /** Stable parent-domain identifier. Domain / subdomain / microdomain are derived from depth. */
  parent?: string;
  owner?: string;
  businessOwner?: string;
  boundedContext?: string;
  sourceSystems?: string[];
  primaryTerms?: string[];
  reviewCadence?: string;
  tags?: string[];
  businessOutcome?: string;
  description?: string;
  inScope?: string[];
  outOfScope?: string[];
  dbtGroups?: string[];
  dbtPaths?: string[];
  dbtTags?: string[];
  semanticDomains?: string[];
  semanticTags?: string[];
  /** Compatibility export ids; structured v3 interfaces are compiled separately. */
  exports?: string[];
  decorators: DecoratorNode[];
}

// ---- Business Term Declaration ----

export interface TermDeclNode extends BaseNode {
  kind: NodeKind.TermDecl;
  name: string;
  domain?: string;
  termType?: string;
  status?: string;
  description?: string;
  tags?: string[];
  owner?: string;
  identifiers?: string[];
  synonyms?: string[];
  /**
   * Governed metrics this term names. Terms could previously only attach to
   * blocks and business views, so a project's own vocabulary had no way to
   * reach the semantic layer and the agent's synonym table had to be hardcoded.
   */
  metricRefs?: string[];
  businessOutcome?: string;
  businessOwner?: string;
  decisionUse?: string;
  reviewCadence?: string;
  businessRules?: string[];
  caveats?: string[];
  decorators: DecoratorNode[];
}

export interface BlockParamsNode extends BaseNode {
  kind: NodeKind.BlockParams;
  params: BlockParamEntry[];
}

/** Runtime-safe value types supported by reusable block parameters. */
export type BlockParamType = 'string' | 'number' | 'boolean' | 'date' | 'string[]' | 'number[]' | 'date[]';

export interface BlockParamEntry {
  name: string;
  /** Explicit type for new blocks. Legacy declarations infer this from the default. */
  paramType?: BlockParamType;
  /** Omitted means the invocation must supply a value. */
  initializer?: ExpressionNode;
  span: SourceSpan;
}

export interface BlockParameterPolicyEntry {
  name: string;
  policy: string;
  span: SourceSpan;
}

export interface BlockFilterBindingEntry {
  filter: string;
  binding: string;
  span: SourceSpan;
}

export interface BlockMetricMappingEntry {
  /** The block's output column. */
  output: string;
  /** The semantic metric that column answers. */
  metric: string;
  /** The rows the metric is read over, as `column = 'value'` predicates joined by AND. */
  filter?: string;
  span: SourceSpan;
}

export interface BlockVisualizationNode extends BaseNode {
  kind: NodeKind.BlockVisualization;
  properties: NamedArgNode[];
}

export interface BlockTestNode extends BaseNode {
  kind: NodeKind.BlockTest;
  field: string;
  operator: '>' | '<' | '>=' | '<=' | '==' | '!=' | 'IN';
  expected: ExpressionNode;
}

// ---- Business View Declaration ----

export interface BusinessViewDeclNode extends BaseNode {
  kind: NodeKind.BusinessViewDecl;
  name: string;
  domain?: string;
  status?: string;
  description?: string;
  tags?: string[];
  owner?: string;
  /** Business glossary terms this composed view represents. */
  termRefs?: string[];
  businessOutcome?: string;
  businessOwner?: string;
  decisionUse?: string;
  reviewCadence?: string;
  businessRules?: string[];
  caveats?: string[];
  includes: BusinessViewIncludeNode[];
  decorators: DecoratorNode[];
}

export interface BusinessViewIncludeNode extends BaseNode {
  kind: NodeKind.BusinessViewInclude;
  refType: 'block' | 'business_view';
  name: string;
}

// ---- Layout ----

export interface LayoutBlockNode extends BaseNode {
  kind: NodeKind.LayoutBlock;
  columns: number;
  rows: LayoutRowNode[];
}

export interface LayoutRowNode extends BaseNode {
  kind: NodeKind.LayoutRow;
  items: LayoutRowItem[];
}

export interface LayoutRowItem {
  node: ChartCallNode | FilterCallNode;
  span?: number;
}
