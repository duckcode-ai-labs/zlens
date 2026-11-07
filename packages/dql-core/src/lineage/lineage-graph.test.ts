import { describe, it, expect } from 'vitest';
import { LineageGraph, getLayerForNodeType, type LineageLayer } from './lineage-graph.js';
import { buildLineageGraph } from './builder.js';
import { queryLineage, queryBusiness360, queryCompleteLineagePaths } from './query.js';
import {
  buildTrustChain,
  analyzeImpact,
  detectDomainFlows,
  getDomainTrustOverview,
} from './domain-lineage.js';

describe('LineageGraph', () => {
  it('adds and retrieves nodes', () => {
    const graph = new LineageGraph();
    graph.addNode({ id: 'block:revenue', type: 'block', name: 'revenue', domain: 'finance' });
    expect(graph.getNode('block:revenue')?.name).toBe('revenue');
    expect(graph.nodeCount).toBe(1);
  });

  it('visits nodes in insertion order without materializing the graph and can stop early', () => {
    const graph = new LineageGraph();
    graph.addNode({ id: 'block:first', type: 'block', name: 'first' });
    graph.addNode({ id: 'block:second', type: 'block', name: 'second' });
    graph.addNode({ id: 'block:third', type: 'block', name: 'third' });
    const visited: string[] = [];

    const completed = graph.visitNodes((node) => {
      visited.push(node.id);
      return visited.length < 2;
    });

    expect(completed).toBe(false);
    expect(visited).toEqual(['block:first', 'block:second']);
  });

  it('adds edges and queries them', () => {
    const graph = new LineageGraph();
    graph.addNode({ id: 'table:orders', type: 'source_table', name: 'orders' });
    graph.addNode({ id: 'block:revenue', type: 'block', name: 'revenue' });
    graph.addEdge({ source: 'table:orders', target: 'block:revenue', type: 'reads_from' });

    expect(graph.getOutgoingEdges('table:orders')).toHaveLength(1);
    expect(graph.getIncomingEdges('block:revenue')).toHaveLength(1);
    expect(graph.edgeCount).toBe(1);
  });

  it('finds ancestors via BFS', () => {
    const graph = new LineageGraph();
    graph.addNode({ id: 'a', type: 'source_table', name: 'a' });
    graph.addNode({ id: 'b', type: 'block', name: 'b' });
    graph.addNode({ id: 'c', type: 'block', name: 'c' });
    graph.addEdge({ source: 'a', target: 'b', type: 'reads_from' });
    graph.addEdge({ source: 'b', target: 'c', type: 'feeds_into' });

    const ancestors = graph.ancestors('c');
    expect(ancestors.map((n) => n.id)).toContain('a');
    expect(ancestors.map((n) => n.id)).toContain('b');
  });

  it('finds descendants via BFS', () => {
    const graph = new LineageGraph();
    graph.addNode({ id: 'a', type: 'source_table', name: 'a' });
    graph.addNode({ id: 'b', type: 'block', name: 'b' });
    graph.addNode({ id: 'c', type: 'block', name: 'c' });
    graph.addEdge({ source: 'a', target: 'b', type: 'reads_from' });
    graph.addEdge({ source: 'b', target: 'c', type: 'feeds_into' });

    const descendants = graph.descendants('a');
    expect(descendants.map((n) => n.id)).toContain('b');
    expect(descendants.map((n) => n.id)).toContain('c');
  });

  it('finds shortest path between nodes', () => {
    const graph = new LineageGraph();
    graph.addNode({ id: 'a', type: 'source_table', name: 'a' });
    graph.addNode({ id: 'b', type: 'block', name: 'b' });
    graph.addNode({ id: 'c', type: 'block', name: 'c' });
    graph.addEdge({ source: 'a', target: 'b', type: 'reads_from' });
    graph.addEdge({ source: 'b', target: 'c', type: 'feeds_into' });

    expect(graph.pathBetween('a', 'c')).toEqual(['a', 'b', 'c']);
    expect(graph.pathBetween('c', 'a')).toEqual([]); // No reverse path
  });

  it('serializes to and from JSON', () => {
    const graph = new LineageGraph();
    graph.addNode({ id: 'block:test', type: 'block', name: 'test', domain: 'sales' });
    graph.addEdge({ source: 'block:test', target: 'block:test', type: 'certified_by' });

    const json = graph.toJSON();
    const restored = LineageGraph.fromJSON(json);
    expect(restored.nodeCount).toBe(1);
    expect(restored.edgeCount).toBe(1);
    expect(restored.getNode('block:test')?.domain).toBe('sales');
  });

  it('filters nodes by type', () => {
    const graph = new LineageGraph();
    graph.addNode({ id: 'table:a', type: 'source_table', name: 'a' });
    graph.addNode({ id: 'block:b', type: 'block', name: 'b' });
    graph.addNode({ id: 'metric:c', type: 'metric', name: 'c' });

    expect(graph.getNodesByType('block')).toHaveLength(1);
    expect(graph.getNodesByType('source_table')).toHaveLength(1);
  });

  it('extracts a subgraph', () => {
    const graph = new LineageGraph();
    graph.addNode({ id: 'a', type: 'block', name: 'a', domain: 'finance' });
    graph.addNode({ id: 'b', type: 'block', name: 'b', domain: 'sales' });
    graph.addNode({ id: 'c', type: 'block', name: 'c', domain: 'finance' });
    graph.addEdge({ source: 'a', target: 'b', type: 'feeds_into' });
    graph.addEdge({ source: 'a', target: 'c', type: 'feeds_into' });

    const sub = graph.subgraph((n) => n.domain === 'finance');
    expect(sub.nodeCount).toBe(2);
    expect(sub.edgeCount).toBe(1); // a→c only
  });
});

describe('buildLineageGraph', () => {
  it('builds a complete graph from blocks and metrics', () => {
    const graph = buildLineageGraph(
      [
        {
          name: 'raw_orders',
          sql: 'SELECT * FROM orders',
          domain: 'data',
          owner: 'data-team',
          status: 'certified',
          chartType: 'table',
        },
        {
          name: 'revenue_by_segment',
          sql: 'SELECT * FROM ref("raw_orders")',
          domain: 'finance',
          owner: 'finance-team',
          status: 'certified',
          chartType: 'bar',
        },
      ],
      [
        { name: 'total_revenue', table: 'orders', domain: 'finance', type: 'sum' },
      ],
      [
        { name: 'segment', table: 'orders' },
      ],
    );

    // Should have: 2 blocks + 1 metric + 1 dimension + 1 source table + 2 charts + 2 domains
    expect(graph.getNodesByType('block')).toHaveLength(2);
    expect(graph.getNodesByType('metric')).toHaveLength(1);
    expect(graph.getNodesByType('source_table')).toHaveLength(1);
    expect(graph.getNodesByType('chart')).toHaveLength(2);
    expect(graph.getNodesByType('domain')).toHaveLength(2);

    // raw_orders reads from orders table
    const rawEdges = graph.getIncomingEdges('block:raw_orders');
    expect(rawEdges.some((e) => e.source === 'table:orders')).toBe(true);

    // revenue_by_segment depends on raw_orders via ref()
    const revEdges = graph.getIncomingEdges('block:revenue_by_segment');
    expect(revEdges.some((e) => e.source === 'block:raw_orders' && e.type === 'feeds_into')).toBe(true);

    // Cross-domain edge: data → finance
    const crossDomain = graph.getCrossDomainEdges();
    expect(crossDomain.length).toBeGreaterThan(0);
    expect(crossDomain.some((e) => e.sourceDomain === 'data' && e.targetDomain === 'finance')).toBe(true);
  });

  it('connects semantic blocks to their metrics', () => {
    const graph = buildLineageGraph(
      [
        {
          name: 'arr_dashboard',
          sql: '',
          domain: 'executive',
          blockType: 'semantic',
          metricRef: 'arr_growth',
          chartType: 'line',
        },
      ],
      [
        { name: 'arr_growth', table: 'revenue', domain: 'finance', type: 'sum' },
      ],
      [],
    );

    const dashEdges = graph.getIncomingEdges('block:arr_dashboard');
    expect(dashEdges.some((e) => e.source === 'metric:arr_growth')).toBe(true);
  });

  it('bridges blocks to dbt models and adds dashboard containers', () => {
    const graph = buildLineageGraph(
      [
        {
          name: 'customer_summary',
          sql: 'SELECT * FROM dim_customers',
          domain: 'customer',
          chartType: 'table',
        },
      ],
      [],
      [],
      {
        dbtModels: [
          {
            name: 'raw_customers',
            uniqueId: 'source.jaffle_shop.raw_customers',
            type: 'source',
            dependsOn: [],
          },
          {
            name: 'stg_customers',
            uniqueId: 'model.jaffle_shop.stg_customers',
            type: 'model',
            dependsOn: ['source.jaffle_shop.raw_customers'],
          },
          {
            name: 'dim_customers',
            uniqueId: 'model.jaffle_shop.dim_customers',
            type: 'model',
            dependsOn: ['model.jaffle_shop.stg_customers'],
            columns: [{ name: 'customer_id', type: 'integer' }],
          },
        ],
        dashboards: [
          {
            name: 'Customer Notebook',
            blocks: ['customer_summary'],
            charts: ['customer_summary'],
          },
        ],
      },
    );

    expect(graph.getNode('dbt_model:dim_customers')?.columns).toEqual([
      { name: 'customer_id', type: 'integer' },
    ]);
    expect(
      graph.getIncomingEdges('block:customer_summary').some(
        (edge) => edge.source === 'dbt_model:dim_customers' && edge.type === 'reads_from',
      ),
    ).toBe(true);
    expect(
      graph.getIncomingEdges('dbt_model:dim_customers').some(
        (edge) => edge.source === 'dbt_model:stg_customers' && edge.type === 'depends_on',
      ),
    ).toBe(true);
    // Edge direction: block feeds into dashboard (data flows block → dashboard)
    expect(
      graph.getIncomingEdges('dashboard:Customer Notebook').some(
        (edge) => edge.source === 'block:customer_summary' && edge.type === 'contains',
      ),
    ).toBe(true);
    // ancestors of dashboard should include the block
    expect(graph.ancestors('dashboard:Customer Notebook').map((n) => n.id)).toContain('block:customer_summary');
  });

  it('does not create a block self-loop when a block ref()s its own dbt model name (regression)', () => {
    // `zlens propose` names a block after the dbt model it wraps, so a mart block
    // "customers" whose query is `SELECT * FROM ref('customers')` used to depend on
    // itself (block:customers as its own up/downstream), distorting impact analysis.
    const graph = buildLineageGraph(
      [
        {
          name: 'customers',
          sql: "SELECT * FROM ref('customers')",
          domain: 'marts',
          status: 'certified',
          owner: 'analytics',
          chartType: 'table',
        },
      ],
      [],
      [],
      {
        dbtModels: [
          { name: 'customers', uniqueId: 'model.jaffle_shop.customers', type: 'model', dependsOn: [] },
        ],
      },
    );

    const incoming = graph.getIncomingEdges('block:customers');
    const outgoing = graph.getOutgoingEdges('block:customers');
    // No self-loop in either direction.
    expect(incoming.some((edge) => edge.source === 'block:customers')).toBe(false);
    expect(outgoing.some((edge) => edge.target === 'block:customers')).toBe(false);
    // The self-named ref resolves to the wrapped dbt model instead.
    expect(
      incoming.some((edge) => edge.source === 'dbt_model:customers' && edge.type === 'reads_from'),
    ).toBe(true);
  });
});

describe('Domain Lineage', () => {
  function buildTestGraph(): LineageGraph {
    return buildLineageGraph(
      [
        {
          name: 'raw_orders',
          sql: 'SELECT * FROM orders',
          domain: 'engineering',
          status: 'certified',
          owner: 'eng-team',
        },
        {
          name: 'clean_orders',
          sql: 'SELECT * FROM ref("raw_orders")',
          domain: 'data',
          status: 'certified',
          owner: 'data-team',
        },
        {
          name: 'revenue_metric_block',
          sql: 'SELECT * FROM ref("clean_orders")',
          domain: 'finance',
          status: 'draft',
          owner: 'finance-team',
          chartType: 'bar',
        },
      ],
      [],
      [],
    );
  }

  it('builds a trust chain across domains', () => {
    const graph = buildTestGraph();
    const chain = buildTrustChain(graph, 'block:raw_orders', 'block:revenue_metric_block');

    expect(chain).not.toBeNull();
    expect(chain!.nodes).toHaveLength(3);
    expect(chain!.certifiedCount).toBe(2); // raw_orders + clean_orders
    expect(chain!.uncertifiedCount).toBe(1); // revenue_metric_block is draft
    expect(chain!.trustScore).toBeCloseTo(2 / 3);
    expect(chain!.domainCrossings).toHaveLength(2); // engineering→data, data→finance
  });

  it('performs impact analysis across domains', () => {
    const graph = buildTestGraph();
    const impact = analyzeImpact(graph, 'block:raw_orders');

    expect(impact.totalAffected).toBeGreaterThanOrEqual(2);
    expect(impact.domainImpacts.length).toBeGreaterThanOrEqual(2);

    const financeDomain = impact.domainImpacts.find((d) => d.domain === 'finance');
    expect(financeDomain).toBeDefined();
    expect(financeDomain!.affectedNodes.length).toBeGreaterThanOrEqual(1);
  });

  it('detects cross-domain flows', () => {
    const graph = buildTestGraph();
    const flows = detectDomainFlows(graph);

    expect(flows.length).toBeGreaterThan(0);
    const engToData = flows.find((f) => f.from === 'engineering' && f.to === 'data');
    expect(engToData).toBeDefined();
  });

  it('calculates domain trust overview', () => {
    const graph = buildTestGraph();
    const overview = getDomainTrustOverview(graph, 'engineering');

    expect(overview.totalBlocks).toBe(1);
    expect(overview.certified).toBe(1);
    expect(overview.trustScore).toBe(1.0);
  });

  it('returns null trust chain when no path exists', () => {
    const graph = buildTestGraph();
    // These blocks exist but there's no path from finance back to engineering
    const chain = buildTrustChain(graph, 'block:revenue_metric_block', 'block:raw_orders');
    expect(chain).toBeNull();
  });

  it('handles empty domain trust overview', () => {
    const graph = buildTestGraph();
    const overview = getDomainTrustOverview(graph, 'nonexistent');
    expect(overview.totalBlocks).toBe(0);
    expect(overview.trustScore).toBe(0);
  });
});

describe('LineageGraph edge deduplication', () => {
  it('prevents duplicate edges with same source/target/type', () => {
    const graph = new LineageGraph();
    graph.addNode({ id: 'a', type: 'block', name: 'a' });
    graph.addNode({ id: 'b', type: 'block', name: 'b' });
    graph.addEdge({ source: 'a', target: 'b', type: 'feeds_into' });
    graph.addEdge({ source: 'a', target: 'b', type: 'feeds_into' }); // duplicate

    expect(graph.edgeCount).toBe(1);
  });

  it('allows different edge types between same nodes', () => {
    const graph = new LineageGraph();
    graph.addNode({ id: 'a', type: 'block', name: 'a', domain: 'sales' });
    graph.addNode({ id: 'b', type: 'block', name: 'b', domain: 'finance' });
    graph.addEdge({ source: 'a', target: 'b', type: 'feeds_into' });
    graph.addEdge({ source: 'a', target: 'b', type: 'crosses_domain' });

    expect(graph.edgeCount).toBe(2);
  });
});

describe('buildLineageGraph — normalizeTableName', () => {
  it('normalizes read_csv_auto paths to table names', () => {
    const graph = buildLineageGraph(
      [],
      [{ name: 'rev', table: "read_csv_auto('./data/revenue.csv')", domain: 'fin', type: 'sum' }],
      [],
    );
    const tables = graph.getNodesByType('source_table');
    expect(tables).toHaveLength(1);
    expect(tables[0].name).toBe('revenue');
  });

  it('normalizes read_parquet paths to table names', () => {
    const graph = buildLineageGraph(
      [],
      [{ name: 'm', table: "read_parquet('./warehouse/events.parquet')", domain: 'd', type: 'count' }],
      [],
    );
    const tables = graph.getNodesByType('source_table');
    expect(tables[0].name).toBe('events');
  });

  it('names Delta, Iceberg, Excel and partitioned-folder reads after what they read', () => {
    const graph = buildLineageGraph(
      [],
      [
        { name: 'a', table: "delta_scan('./data/customers_delta')", domain: 'd', type: 'count' },
        { name: 'b', table: "iceberg_scan('s3://lake/orders')", domain: 'd', type: 'count' },
        { name: 'c', table: "read_xlsx('./data/targets.xlsx')", domain: 'd', type: 'sum' },
        { name: 'e', table: "read_parquet('./data/events/**/*.parquet')", domain: 'd', type: 'count' },
      ],
      [],
    );
    expect(graph.getNodesByType('source_table').map((node) => node.name).sort()).toEqual(['customers_delta', 'events', 'orders', 'targets']);
  });

  it('leaves plain table names unchanged', () => {
    const graph = buildLineageGraph(
      [],
      [{ name: 'm', table: 'fct_orders', domain: 'd', type: 'sum' }],
      [],
    );
    const tables = graph.getNodesByType('source_table');
    expect(tables[0].name).toBe('fct_orders');
  });
});

describe('buildLineageGraph — business views', () => {
  it('connects blocks and nested business views with composition edges', () => {
    const graph = buildLineageGraph(
      [
        { name: 'Customer Identity', sql: 'SELECT customer_id FROM dim_customer', domain: 'Customer' },
        {
          name: 'Customer Orders Rollup',
          sql: 'SELECT customer_id, COUNT(*) AS orders FROM fct_orders GROUP BY 1',
          domain: 'Customer',
          termRefs: ['Customer'],
        },
      ],
      [],
      [],
      {
        terms: [
          {
            name: 'Customer',
            domain: 'Customer',
            termType: 'entity',
            owner: 'Customer Analytics',
            identifiers: ['customer_id'],
          },
          {
            name: 'Customer Health',
            domain: 'Customer',
            termType: 'concept',
          },
        ],
        businessViews: [
          {
            name: 'Customer 360',
            domain: 'Customer',
            owner: 'Customer Analytics',
            blockRefs: ['Customer Identity', 'Customer Orders Rollup'],
            businessViewRefs: [],
            declaredTermRefs: ['Customer Health'],
          },
          {
            name: 'Customer Health Review',
            domain: 'Customer Success',
            blockRefs: [],
            businessViewRefs: ['Customer 360'],
          },
        ],
      },
    );

    expect(graph.getNode('term:Customer')?.type).toBe('term');
    expect(graph.getNode('term:Customer')?.layer).toBe('answer');
    expect(graph.getNode('business_view:Customer 360')?.type).toBe('business_view');
    expect(graph.getNode('business_view:Customer 360')?.layer).toBe('answer');
    expect(graph.getNode('business_view:Customer 360')?.owner).toBe('Customer Analytics');

    expect(graph.getIncomingEdges('business_view:Customer 360')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'block:Customer Identity', type: 'composes' }),
        expect.objectContaining({ source: 'block:Customer Orders Rollup', type: 'composes' }),
        expect.objectContaining({ source: 'term:Customer Health', type: 'defines' }),
      ]),
    );
    expect(graph.getIncomingEdges('block:Customer Orders Rollup')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'term:Customer', type: 'defines' }),
      ]),
    );
    expect(graph.getIncomingEdges('business_view:Customer Health Review')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'business_view:Customer 360', type: 'composes' }),
      ]),
    );
    expect(graph.getOutgoingEdges('business_view:Customer 360')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: 'business_view:Customer Health Review', type: 'composes' }),
      ]),
    );
  });
});

describe('queryLineage', () => {
  it('returns a focused subgraph with depth limits', () => {
    const graph = buildLineageGraph(
      [
        { name: 'base_orders', sql: 'SELECT * FROM orders', domain: 'finance' },
        { name: 'monthly_revenue', sql: 'SELECT * FROM ref("base_orders")', domain: 'finance' },
      ],
      [{ name: 'revenue', table: 'orders', domain: 'finance', type: 'sum' }],
      [],
      {
        dashboards: [{ name: 'Revenue Dashboard', blocks: ['monthly_revenue'], charts: [] }],
      },
    );

    const result = queryLineage(graph, { focus: 'monthly_revenue', upstreamDepth: 1, downstreamDepth: 1 });

    // A focus that does not resolve must NOT fall through to the whole project.
    // A notebook AI block is transient — never saved under blocks/ — so
    // `block:<name>` is not a node, and this used to return EVERY node, which
    // rendered in the cell as unrelated "demo" lineage.
    const unresolved = queryLineage(graph, { focus: 'block:transient_ai_block', upstreamDepth: 1, downstreamDepth: 1 });
    expect(unresolved.focalNode).toBeUndefined();
    expect(unresolved.graph.nodes).toHaveLength(0);
    expect(unresolved.graph.edges).toHaveLength(0);
    // No focus at all still means the whole graph (the DAG page relies on it).
    expect(queryLineage(graph, {}).graph.nodes.length).toBeGreaterThan(0);

    const ids = new Set(result.graph.nodes.map((node) => node.id));
    expect(ids.has('block:monthly_revenue')).toBe(true);
    expect(ids.has('block:base_orders')).toBe(true);
    expect(ids.has('dashboard:Revenue Dashboard')).toBe(true);
    expect(ids.has('table:orders')).toBe(false);
  });

  it('searches and filters lineage nodes', () => {
    const graph = buildLineageGraph(
      [{ name: 'revenue_by_region', sql: 'SELECT * FROM orders', domain: 'finance' }],
      [{ name: 'revenue', table: 'orders', domain: 'finance', type: 'sum' }],
      [{ name: 'region', table: 'orders' }],
    );

    const result = queryLineage(graph, {
      search: 'revenue',
      types: ['block', 'metric'],
      domain: 'finance',
    });

    expect(result.matches?.map((match) => match.node.id)).toEqual([
      'metric:revenue',
      'block:revenue_by_region',
    ]);
    expect(result.graph.nodes.every((node) => ['block', 'metric'].includes(node.type))).toBe(true);
  });
});

describe('queryBusiness360', () => {
  it('expands terms through definitions before tracing sources and consumers', () => {
    const graph = buildLineageGraph(
      [
        {
          name: 'Customer Identity',
          sql: 'SELECT customer_id FROM dim_customer',
          domain: 'Customer',
          status: 'certified',
          termRefs: ['Customer'],
        },
        {
          name: 'Customer Orders Rollup',
          sql: 'SELECT customer_id, COUNT(*) AS orders FROM fct_orders GROUP BY 1',
          domain: 'Customer',
          termRefs: ['Customer'],
        },
      ],
      [],
      [],
      {
        terms: [
          {
            name: 'Customer',
            domain: 'Customer',
            termType: 'entity',
            description: 'A person or business buying from the company.',
          },
        ],
        businessViews: [
          {
            name: 'Customer 360',
            domain: 'Customer',
            blockRefs: ['Customer Identity', 'Customer Orders Rollup'],
            businessViewRefs: [],
            declaredTermRefs: ['Customer'],
          },
        ],
        dashboards: [
          {
            name: 'Customer Health',
            blocks: ['Customer Orders Rollup'],
            charts: [],
          },
        ],
        apps: [
          {
            id: 'customer-app',
            name: 'Customer App',
            dashboards: ['Customer Health'],
          },
        ],
      },
    );

    const result = queryBusiness360(graph, 'Customer');
    expect(result?.focus.id).toBe('term:Customer');
    expect(result?.businessDefinition.definedArtifacts.map((asset) => asset.id)).toEqual([
      'block:Customer Identity',
      'block:Customer Orders Rollup',
      'business_view:Customer 360',
    ]);
    expect(result?.technicalSources.sourceTables.map((asset) => asset.name)).toEqual([
      'dim_customer',
      'fct_orders',
    ]);
    expect(result?.consumers.dashboards.map((asset) => asset.id)).toEqual(['dashboard:Customer Health']);
    expect(result?.consumers.apps.map((asset) => asset.id)).toEqual(['app:customer-app']);
    expect(result?.gaps.map((gap) => gap.code)).not.toContain('missing_definition');
  });

  it('expands first-class domains to contained terms, blocks, views, and apps', () => {
    const graph = buildLineageGraph(
      [
        {
          name: 'Customer Profile',
          sql: 'SELECT customer_id FROM dim_customer',
          domain: 'Customer',
          termRefs: ['Customer'],
        },
      ],
      [],
      [],
      {
        domains: [
          {
            name: 'Customer',
            owner: 'customer-analytics',
            businessOwner: 'Customer Success',
            boundedContext: 'Customer identity and lifecycle',
            primaryTerms: ['Customer'],
          },
        ],
        terms: [{ name: 'Customer', domain: 'Customer', termType: 'entity' }],
        businessViews: [
          {
            name: 'Customer 360',
            domain: 'Customer',
            blockRefs: ['Customer Profile'],
            businessViewRefs: [],
          },
        ],
        apps: [
          {
            id: 'customer-app',
            name: 'Customer App',
            domain: 'Customer',
            dashboards: [],
          },
        ],
      },
    );

    const result = queryBusiness360(graph, 'domain:Customer');
    expect(result?.focus.id).toBe('domain:Customer');
    expect(result?.focus.owner).toBe('customer-analytics');
    expect(result?.businessDefinition.terms.map((asset) => asset.id)).toEqual(['term:Customer']);
    expect(result?.businessComposition.includedArtifacts.map((asset) => asset.id)).toEqual([
      'block:Customer Profile',
      'business_view:Customer 360',
    ]);
    expect(result?.consumers.apps.map((asset) => asset.id)).toEqual(['app:customer-app']);
    expect(result?.businessDefinition.metadata.boundedContext).toBe('Customer identity and lifecycle');
  });

  it('resolves declared domain aliases for folder-slug and lowercase artifact references', () => {
    const graph = buildLineageGraph(
      [
        {
          name: 'Top Players',
          sql: 'SELECT player_name FROM int_player_stats',
          domain: 'nba',
          termRefs: ['Player'],
        },
      ],
      [],
      [],
      {
        domains: [
          {
            name: 'NBA',
            owner: 'sports-analytics',
            filePath: 'domains/nba/domain.dql',
            boundedContext: 'NBA analysis',
          },
        ],
        terms: [{ name: 'Player', domain: 'nba', termType: 'entity' }],
        businessViews: [
          {
            name: 'NBA 360',
            domain: 'nba',
            blockRefs: ['Top Players'],
            businessViewRefs: [],
          },
        ],
        apps: [
          {
            id: 'nba-app',
            name: 'NBA App',
            domain: 'nba',
            dashboards: [],
          },
        ],
      },
    );

    const result = queryBusiness360(graph, 'domain:NBA');

    expect(graph.getNode('domain:nba')).toBeUndefined();
    expect(graph.getNode('block:Top Players')?.domain).toBe('NBA');
    expect(graph.getNode('term:Player')?.domain).toBe('NBA');
    expect(result?.businessDefinition.terms.map((asset) => asset.id)).toEqual(['term:Player']);
    expect(result?.businessComposition.includedArtifacts.map((asset) => asset.id)).toEqual([
      'block:Top Players',
      'business_view:NBA 360',
    ]);
    expect(result?.consumers.apps.map((asset) => asset.id)).toEqual(['app:nba-app']);
  });

  it('shows business view composition and downstream consumption through included blocks', () => {
    const graph = buildLineageGraph(
      [
        {
          name: 'Customer Identity',
          sql: 'SELECT customer_id FROM dim_customer',
          domain: 'Customer',
        },
      ],
      [],
      [],
      {
        businessViews: [
          {
            name: 'Customer 360',
            domain: 'Customer',
            blockRefs: ['Customer Identity'],
            businessViewRefs: [],
          },
        ],
        dashboards: [
          {
            name: 'Customer Overview',
            blocks: ['Customer Identity'],
            charts: [],
          },
        ],
      },
    );

    const result = queryBusiness360(graph, 'Customer 360');
    expect(result?.focus.id).toBe('business_view:Customer 360');
    expect(result?.businessComposition.includedArtifacts.map((asset) => asset.id)).toEqual([
      'block:Customer Identity',
    ]);
    expect(result?.technicalSources.sourceTables.map((asset) => asset.id)).toEqual(['table:dim_customer']);
    expect(result?.consumers.dashboards.map((asset) => asset.id)).toEqual(['dashboard:Customer Overview']);
  });

  it('surfaces enterprise readiness gaps for block contracts', () => {
    const graph = buildLineageGraph(
      [
        {
          name: 'Revenue By Customer',
          sql: 'SELECT customer_id, SUM(revenue) AS revenue FROM fct_revenue GROUP BY 1',
          domain: 'Revenue',
          status: 'certified',
          reviewCadence: 'annual',
        },
      ],
      [],
      [],
    );

    const result = queryBusiness360(graph, 'Revenue By Customer');
    expect(result?.gaps.map((gap) => gap.code)).toEqual(expect.arrayContaining([
      'missing_owner',
      'missing_terms',
      'missing_grain',
      'missing_tests',
      'stale_review',
    ]));
    expect(result?.technicalSources.sourceTables.map((asset) => asset.id)).toEqual(['table:fct_revenue']);
  });

  it('summarizes reusable parameter and filter contracts for blocks', () => {
    const graph = buildLineageGraph(
      [
        {
          name: 'Top Players By Season',
          sql: 'SELECT player_name, SUM(pts) AS total_points FROM fct_player_stats WHERE season BETWEEN ${season_start} AND ${season_end} GROUP BY 1',
          domain: 'Basketball',
          status: 'certified',
          owner: 'league-analytics',
          pattern: 'ranking',
          grain: 'player_name, season',
          declaredOutputs: ['player_name', 'total_points'],
          allowedFilters: ['season_range', 'team'],
          parameterPolicy: [
            { name: 'season_start', policy: 'dynamic' },
            { name: 'season_end', policy: 'dynamic' },
            { name: 'team', policy: 'optional' },
          ],
          filterBindings: [
            { filter: 'season_range', binding: 'season' },
            { filter: 'team', binding: 'team_name' },
          ],
          sourceSystems: ['nba_stats'],
          replacementFor: ['Top Players 2017 Static'],
          tests: ['row_count > 0'],
          reviewCadence: 'monthly',
          termRefs: ['Player Points'],
        },
      ],
      [],
      [],
      {
        terms: [{ name: 'Player Points', domain: 'Basketball', owner: 'league-analytics', reviewCadence: 'monthly' }],
      },
    );

    const result = queryBusiness360(graph, 'Top Players By Season');
    expect(result?.blockContracts).toEqual([
      expect.objectContaining({
        block: expect.objectContaining({ id: 'block:Top Players By Season' }),
        pattern: 'ranking',
        grain: 'player_name, season',
        outputs: ['player_name', 'total_points'],
        allowedFilters: ['season_range', 'team'],
        parameterPolicy: [
          { name: 'season_start', policy: 'dynamic' },
          { name: 'season_end', policy: 'dynamic' },
          { name: 'team', policy: 'optional' },
        ],
        filterBindings: [
          { filter: 'season_range', binding: 'season' },
          { filter: 'team', binding: 'team_name' },
        ],
        sourceSystems: ['nba_stats'],
        replacementFor: ['Top Players 2017 Static'],
        reusability: 'dynamic',
      }),
    ]);
    expect(result?.gaps.map((gap) => gap.code)).not.toContain('missing_reusable_filters');
  });

  it('reports replacement history in both directions', () => {
    const graph = buildLineageGraph(
      [
        {
          name: 'Legacy Customer Revenue',
          sql: 'SELECT customer_id, revenue FROM fct_revenue',
          domain: 'Revenue',
          owner: 'finance-analytics',
          grain: 'customer_id',
          tests: ['row_count > 0'],
          reviewCadence: 'monthly',
          termRefs: ['Revenue'],
        },
        {
          name: 'Customer Revenue v2',
          sql: 'SELECT customer_id, SUM(revenue) AS revenue FROM fct_revenue GROUP BY 1',
          domain: 'Revenue',
          owner: 'finance-analytics',
          grain: 'customer_id',
          tests: ['row_count > 0'],
          reviewCadence: 'monthly',
          termRefs: ['Revenue'],
          replacementFor: ['Legacy Customer Revenue'],
        },
      ],
      [],
      [],
      {
        terms: [{ name: 'Revenue', domain: 'Revenue', owner: 'finance-analytics', reviewCadence: 'monthly' }],
      },
    );

    const legacy = queryBusiness360(graph, 'Legacy Customer Revenue');
    expect(legacy?.replacementHistory.replacedBy.map((asset) => asset.id)).toEqual(['block:Customer Revenue v2']);

    const current = queryBusiness360(graph, 'Customer Revenue v2');
    expect(current?.replacementHistory.replaces.map((asset) => asset.id)).toEqual(['block:Legacy Customer Revenue']);
    expect(current?.replacementHistory.replacementRefs).toEqual(['Legacy Customer Revenue']);
  });

  it('surfaces useful gaps for disconnected terms', () => {
    const graph = buildLineageGraph(
      [],
      [],
      [],
      {
        terms: [{ name: 'Churn Risk', domain: 'Customer' }],
      },
    );

    const result = queryBusiness360(graph, 'Churn Risk');
    expect(result?.gaps.map((gap) => gap.code)).toEqual([
      'missing_definition',
      'missing_owner',
      'stale_review',
      'missing_sources',
      'missing_consumers',
    ]);
  });
});

describe('LineageGraph layers', () => {
  it('getLayerForNodeType returns correct layers', () => {
    expect(getLayerForNodeType('source_table')).toBe('source');
    expect(getLayerForNodeType('dbt_source')).toBe('source');
    expect(getLayerForNodeType('dbt_model')).toBe('transform');
    expect(getLayerForNodeType('block')).toBe('answer');
    expect(getLayerForNodeType('term')).toBe('answer');
    expect(getLayerForNodeType('business_view')).toBe('answer');
    expect(getLayerForNodeType('metric')).toBe('answer');
    expect(getLayerForNodeType('dashboard')).toBe('consumption');
    expect(getLayerForNodeType('chart')).toBe('consumption');
  });

  it('getNodesByLayer returns nodes filtered by layer', () => {
    const graph = new LineageGraph();
    graph.addNode({ id: 'table:a', type: 'source_table', layer: 'source', name: 'a' });
    graph.addNode({ id: 'dbt:b', type: 'dbt_model', layer: 'transform', name: 'b' });
    graph.addNode({ id: 'block:c', type: 'block', layer: 'answer', name: 'c' });
    graph.addNode({ id: 'term:t', type: 'term', layer: 'answer', name: 't' });
    graph.addNode({ id: 'business_view:e', type: 'business_view', layer: 'answer', name: 'e' });
    graph.addNode({ id: 'dash:d', type: 'dashboard', layer: 'consumption', name: 'd' });

    expect(graph.getNodesByLayer('source')).toHaveLength(1);
    expect(graph.getNodesByLayer('transform')).toHaveLength(1);
    expect(graph.getNodesByLayer('answer')).toHaveLength(3);
    expect(graph.getNodesByLayer('consumption')).toHaveLength(1);
  });

  it('builder assigns layers to all nodes', () => {
    const graph = buildLineageGraph(
      [{ name: 'orders_block', sql: 'SELECT * FROM orders', domain: 'sales', chartType: 'table' }],
      [{ name: 'total_orders', table: 'orders', domain: 'sales', type: 'count' }],
      [],
      {
        dbtModels: [
          { name: 'raw_orders', uniqueId: 'source.shop.raw_orders', type: 'source', dependsOn: [] },
          { name: 'stg_orders', uniqueId: 'model.shop.stg_orders', type: 'model', dependsOn: ['source.shop.raw_orders'] },
        ],
        dashboards: [{ name: 'Sales Dashboard', blocks: ['orders_block'], charts: [] }],
      },
    );

    // Source layer
    expect(graph.getNode('dbt_source:raw_orders')?.layer).toBe('source');
    // Transform layer
    expect(graph.getNode('dbt_model:stg_orders')?.layer).toBe('transform');
    // Answer layer
    expect(graph.getNode('block:orders_block')?.layer).toBe('answer');
    expect(graph.getNode('metric:total_orders')?.layer).toBe('answer');
    // Consumption layer
    expect(graph.getNode('dashboard:Sales Dashboard')?.layer).toBe('consumption');
    expect(graph.getNode('chart:orders_block')?.layer).toBe('consumption');
  });
});

describe('queryCompleteLineagePaths', () => {
  it('computes upstream and downstream paths for a block', () => {
    const graph = buildLineageGraph(
      [
        { name: 'raw_data', sql: 'SELECT * FROM source_table', domain: 'data' },
        { name: 'transformed', sql: 'SELECT * FROM ref("raw_data")', domain: 'analytics' },
      ],
      [],
      [],
      {
        dashboards: [{ name: 'Analytics Dashboard', blocks: ['transformed'], charts: [] }],
      },
    );

    const result = queryCompleteLineagePaths(graph, 'block:transformed');
    expect(result).not.toBeNull();
    expect(result!.focalNode.id).toBe('block:transformed');

    // Upstream paths: source_table → raw_data → transformed
    expect(result!.upstreamPaths.length).toBeGreaterThan(0);
    const upPath = result!.upstreamPaths[0];
    expect(upPath.nodes[0].type).toBe('source_table');
    expect(upPath.nodes[upPath.nodes.length - 1].id).toBe('block:transformed');

    // Downstream paths: transformed → dashboard
    expect(result!.downstreamPaths.length).toBeGreaterThan(0);
    const downPath = result!.downstreamPaths[0];
    expect(downPath.nodes[0].id).toBe('block:transformed');
    expect(downPath.nodes[downPath.nodes.length - 1].type).toBe('dashboard');
  });

  it('returns null for non-existent node', () => {
    const graph = buildLineageGraph([], [], []);
    expect(queryCompleteLineagePaths(graph, 'block:nonexistent')).toBeNull();
  });

  it('includes layer summary', () => {
    const graph = buildLineageGraph(
      [{ name: 'test_block', sql: 'SELECT * FROM raw_table', domain: 'test' }],
      [],
      [],
    );

    const result = queryCompleteLineagePaths(graph, 'block:test_block');
    expect(result).not.toBeNull();
    expect(result!.layerSummary).toHaveProperty('source');
    expect(result!.layerSummary).toHaveProperty('answer');
  });

  it('traverses full dbt chain through to dashboard', () => {
    const graph = buildLineageGraph(
      [{ name: 'customer_report', sql: 'SELECT * FROM dim_customers', domain: 'reports' }],
      [],
      [],
      {
        dbtModels: [
          { name: 'raw_customers', uniqueId: 'source.jaffle.raw_customers', type: 'source', dependsOn: [] },
          { name: 'stg_customers', uniqueId: 'model.jaffle.stg_customers', type: 'model', dependsOn: ['source.jaffle.raw_customers'] },
          { name: 'dim_customers', uniqueId: 'model.jaffle.dim_customers', type: 'model', dependsOn: ['model.jaffle.stg_customers'] },
        ],
        dashboards: [{ name: 'Customer Report', blocks: ['customer_report'], charts: [] }],
      },
    );

    const result = queryCompleteLineagePaths(graph, 'block:customer_report');
    expect(result).not.toBeNull();

    // Should have upstream path through dbt chain: raw_customers → stg_customers → dim_customers → customer_report
    const upPaths = result!.upstreamPaths;
    expect(upPaths.length).toBeGreaterThan(0);

    // Find the longest upstream path (through entire dbt chain)
    const longest = upPaths.reduce((a, b) => (a.nodes.length > b.nodes.length ? a : b));
    expect(longest.nodes.length).toBeGreaterThanOrEqual(4); // source → stg → dim → block

    // First node should be a dbt source
    expect(longest.nodes[0].type).toBe('dbt_source');
    // Last node should be the block
    expect(longest.nodes[longest.nodes.length - 1].id).toBe('block:customer_report');

    // Layers should span source → transform → answer
    expect(longest.layers).toContain('source');
    expect(longest.layers).toContain('transform');
    expect(longest.layers).toContain('answer');

    // Should have downstream path to dashboard
    expect(result!.downstreamPaths.length).toBeGreaterThan(0);
    const downPath = result!.downstreamPaths[0];
    expect(downPath.nodes[downPath.nodes.length - 1].type).toBe('dashboard');
  });
});
