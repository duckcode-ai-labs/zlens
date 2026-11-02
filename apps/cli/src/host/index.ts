/**
 * The supported way to run DQL inside another program (RFC 0010): start the
 * server with host hooks. Import from `@zlens/cli/host`.
 */
export { startLocalServer, type LocalServerOptions } from '../local-runtime.js';
/** The full server with its UI for one project — what `zlens notebook` runs — as a hosted runtime. */
export { startProjectRuntime, type ProjectRuntimeHandle } from '../commands/notebook.js';
export {
  currentPrincipal,
  currentRequestContext,
  type DqlDecision,
  type DqlModelProvider,
  type DqlHostHooks,
  type DqlHostUi,
  type DqlHostBanner,
  type DqlHostNav,
  type DqlAnswerStatus,
  type DqlHostIcon,
  type DqlPrincipal,
  type DqlRequestContext,
  type DqlRunStore,
  type DqlRunStoreLike,
  type DqlMemoryStore,
  type DqlConversationStore,
  type DqlStatementEvent,
  type DqlStatementObserver,
  type DqlSourceRef,
  type DqlKnowledgeServer,
  type DqlDestination,
  type DqlHomeCard,
  type DqlFollow,
  type DqlFollowStore,
  type DqlPageEdition,
  type DqlDirectoryGroup,
} from './request-context.js';
export type { DqlAuditEvent, DqlAuditSink, DqlTraceSink } from './observability.js';
export type { DeliverySink } from '../schedule/notifiers/index.js';
export { snapshotKeyId, verifySnapshot, type SnapshotSigner } from '../snapshot/app-snapshot.js';
export { routeAction, type DqlAction, type DqlResource, type DqlRouteAction } from './route-actions.js';
export {
  CredentialsRefusedError,
  RowPolicyRefusedError,
  WarehouseStatementError,
  checkedGroupRows,
  type DqlCredentialsContext,
  type DqlCredentialsHook,
  type DqlCredentialsResult,
  type DqlQueryContext,
  type DqlRowPolicy,
  type DqlRowPolicyResult,
  type DqlGroupRowsCheck,
} from './row-policy.js';

export { answerFactsFromRun, answerSql, tablesRead, type DqlAnswerFacts } from './answer-facts.js';
/**
 * The statement check ZLens runs on a hosted connection, and the reading of a statement it rests on, for a host that
 * checks a statement before it passes it on (the same rules, the same reading per engine).
 */
export {
  HOSTED_READ_ONLY_REFUSED,
  HOSTED_STATEMENT_REFUSED,
  HOSTED_STATEMENT_UNREADABLE,
  HOSTED_SYSTEM_RELATION_REFUSED,
  hostedStatementRefusal,
  type HostedStatementOptions,
} from './engine-guard.js';
export { UnreadableStatement, knownLexicon, lexStatement, type SqlToken, type SqlTokenKind } from './sql-lexicon.js';
