/**
 * What a DQL cell holds. A DQL cell runs DQL: a `block "…" { … }` declaration
 * (a named, reusable query) or an `@block("…")` reference. Plain SQL belongs in
 * a SQL cell; handed to the DQL parser it fails with an opaque parse error, so
 * the notebook recognizes it and offers the switch instead.
 */

const DQL_STATEMENT = /^\s*(?:@[A-Za-z_]+\s*(?:\([^)]*\))?\s*)*(?:block|term|domain|business_view|dashboard|workbook|chart|digest|import)\b/im;
const SQL_STATEMENT = /^(?:select|with|from|values|table|show|describe|explain|summarize|pivot|unpivot|insert|update|delete|create|drop|alter)\b/i;

function withoutSqlComments(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ').trim();
}

/** True when a DQL cell's content is plain SQL rather than DQL. */
export function dqlCellHoldsPlainSql(content: string): boolean {
  const code = withoutSqlComments(content);
  if (!code) return false;
  if (DQL_STATEMENT.test(code) || /@block\s*\(/i.test(code)) return false;
  return SQL_STATEMENT.test(code);
}

/**
 * The DQL a new, empty DQL cell can start from. It runs as-is on the Jaffle
 * sample project (`dev.orders`, `dev.locations`).
 */
export const DQL_CELL_EXAMPLE = `block "orders_by_store" {
  domain = "commerce"
  type = "custom"
  description = "Orders taken at each store."
  owner = "analytics"

  query = """
    SELECT location_name, COUNT(*) AS orders
    FROM dev.orders JOIN dev.locations USING (location_id)
    GROUP BY 1
    ORDER BY 2 DESC
  """
}
`;

/** The label a query cell's target bar shows: it names the cell's language. */
export function queryCellKindLabel(cell: {
  type: string;
  content: string;
  blockBinding?: unknown;
  executionTarget?: { target?: string };
}): string {
  if (cell.blockBinding) return 'Certified or draft saved query';
  if (/@(?:metric|dim)\s*\(/i.test(cell.content)) return 'Semantic query';
  if (cell.type === 'dql') return 'DQL query';
  return cell.executionTarget?.target === 'local' ? 'Local dataset SQL' : 'Warehouse SQL';
}

export const DQL_CELL_PLAIN_SQL_MESSAGE =
  'This is a DQL cell, and it holds plain SQL. Switch it to a SQL cell to run the query as SQL, or wrap the query in a DQL block.';
