// Lineage analysis — SQL parsing, dependency resolution, graph building, and domain lineage

export {
  analyzeSqlReferences,
  buildSqlAnalyticalSignature,
  buildGeneratedAnalyticalSqlSignature,
  buildSqlOutputExpressionSignature,
  extractTablesFromSql,
  blankStringsAndComments,
  maskExpressionFromKeywords,
  type SqlColumnReference,
  type SqlParseResult,
  type SqlReferenceAnalysis,
  type SqlJoinCondition,
  type SqlAggregateReference,
  type SqlAnalyticalSignature,
  type SqlOutputExpressionSignature,
  type GeneratedAnalyticalSqlSignatureV1,
  type GeneratedAnalyticalOutputSignature,
} from './sql-parser.js';

export {
  extractColumnLineage,
  extractRefColumnUsage,
  type ColumnLineageEntry,
  type ColumnLineageResult,
  type ColumnSource,
  type RefColumnUsage,
} from './column-lineage.js';

export {
  resolveDependencies,
  getUpstream,
  getDownstream,
  type BlockDependencyInfo,
  type DependencyResolutionResult,
} from './dependency-resolver.js';

export {
  LineageGraph,
  getLayerForNodeType,
  isDataFlowEdge,
  type LineageNode,
  type LineageEdge,
  type LineageNodeType,
  type LineageEdgeType,
  type LineageLayer,
  type LineageGraphJSON,
} from './lineage-graph.js';

export {
  buildLineageGraph,
  type LineageBlockInput,
  type LineageMetricInput,
  type LineageDimensionInput,
  type LineageDbtModelInput,
  type LineageDashboardInput,
  type LineageBusinessViewInput,
  type LineageTermInput,
  type LineageBuilderOptions,
} from './builder.js';

export {
  queryLineage,
  queryBusiness360,
  queryCompleteLineagePaths,
  type LineageQuery,
  type LineageQueryResult,
  type Business360Asset,
  type Business360BlockContract,
  type Business360Edge,
  type Business360Gap,
  type Business360Options,
  type Business360Reusability,
  type Business360Result,
  type Business360ResultV2,
  type LineagePath,
  type CompletePathResult,
  type CompletePathOptions,
} from './query.js';

export {
  buildTrustChain,
  analyzeImpact,
  detectDomainFlows,
  getDomainTrustOverview,
  type TrustChain,
  type TrustChainNode,
  type ImpactAnalysis,
  type DomainImpact,
  type DomainFlow,
} from './domain-lineage.js';

export {
  buildDerivationWalk,
  type DerivationWalk,
  type DerivationStep,
  type DerivationStepKind,
  type DerivationFocusBlock,
  type BuildDerivationWalkInput,
} from './derivation.js';

export {
  classifyBlockChange,
  changedBlocksFromDiff,
  computeImpact,
  computeImpactFromDiff,
  renderImpactText,
  type ChangedBlock,
  type SemanticVerdict,
  type ImpactReport,
  type ImpactedNode,
  type CrossDomainImpact,
  type DomainTrustDelta,
  type RecertItem,
  type ComputeImpactOptions,
} from './impact.js';
