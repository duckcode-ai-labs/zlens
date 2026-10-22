import type { ManifestBlock, ManifestDiagnostic, ManifestMetric } from './types.js';

/**
 * `metricMappings` lets a block say which semantic metric an output column
 * answers, so Ask can serve it as the certified answer when its SQL is too
 * complex to compare. A mapping Ask cannot trust must fail the build, not be
 * dropped later: the metric must exist in the semantic layer, the column must
 * be one the block outputs, and the filter must be plain predicates.
 */

const COMPARE = /^[A-Za-z_][A-Za-z0-9_.]*\s*(=|<>|!=|>=|<=|>|<)\s*('[^']*'|true|false|-?[\d.]+)$/i;
const IN_LIST = /^[A-Za-z_][A-Za-z0-9_.]*\s+in\s*\(.+\)$/i;
const BARE = /^(not\s+)?[A-Za-z_][A-Za-z0-9_.]*$/i;

/** The AND-parts of a filter that are not `column op literal`, `column in (...)` or a bare boolean column. */
export function unreadableFilterParts(filter: string): string[] {
  return filter.split(/\s+and\s+/i).map((part) => part.trim()).filter((part) => part && !(COMPARE.test(part) || IN_LIST.test(part) || BARE.test(part)));
}

export function validateBlockMetricMappings(
  blocks: Record<string, ManifestBlock>,
  metrics: Record<string, ManifestMetric>,
  /**
   * False when the project's metrics live in an external semantic provider
   * (dbt/MetricFlow, Cube, Snowflake) that this build does not load: a name
   * cannot be checked here, so Ask checks it against the live metric instead.
   */
  options: { metricsKnown?: boolean } = {},
): ManifestDiagnostic[] {
  const diagnostics: ManifestDiagnostic[] = [];
  const checkNames = options.metricsKnown !== false || Object.keys(metrics).length > 0;
  const metricNames = new Set(Object.values(metrics).map((metric) => metric.name.toLowerCase()));
  for (const block of Object.values(blocks)) {
    if (!block.metricMappings?.length) continue;
    const error = (message: string) => diagnostics.push({ kind: 'semantic', filePath: block.filePath, severity: 'error', message: `Block "${block.name}" metricMappings: ${message}` });
    const outputs = new Set([...(block.declaredOutputs ?? []), ...(block.outputContract ?? []).map((output) => output.name)].map((name) => name.toLowerCase()));
    const seen = new Set<string>();
    let noOutputsReported = false;
    for (const mapping of block.metricMappings) {
      const key = mapping.output.toLowerCase();
      if (seen.has(key)) error(`"${mapping.output}" is mapped more than once.`);
      seen.add(key);
      if (checkNames && !metricNames.has(mapping.metric.toLowerCase())) {
        error(`"${mapping.output}" maps to metric "${mapping.metric}", which is not in the semantic layer${metricNames.size === 0 ? ' (the project has no semantic-layer metrics)' : ''}.`);
      }
      if (!block.declaredOutputs?.length) {
        if (!noOutputsReported) error('the saved query must declare its outputs (outputs = [...]) so Ask can check the rows it returns against the question.');
        noOutputsReported = true;
      } else if (outputs.size > 0 && !outputs.has(key)) error(`"${mapping.output}" is not an output column of the saved query (${[...outputs].join(', ')}).`);
      const unreadable = mapping.filter ? unreadableFilterParts(mapping.filter) : [];
      if (unreadable.length) error(`the filter for "${mapping.output}" has parts that are not "column = value" conditions: ${unreadable.join('; ')}.`);
    }
  }
  return diagnostics;
}
