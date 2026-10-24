import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Send, Sparkles, X } from 'lucide-react';
import { api } from '../../api/client';
import { runAgent } from '../../llm/client';
import type { AgentTurn, BlockProposal } from '../../llm/types';
import type { QueryResult } from '../../store/types';
import { themes, type Theme, type ThemeMode } from '../../themes/notebook-theme';
import { StructuredAnswerText, extractGovernedAnswer, type AgentAnswerEnvelope } from './AgentAnswerCard';
import { TableOutput } from '../output/TableOutput';

type AiSqlMode = 'notebook' | 'block';
type DraftRunStatus = 'idle' | 'generating' | 'running' | 'ready' | 'error' | 'fixing';

interface SqlDraftDialogCopy {
  ariaLabel: string;
  heading: string;
  subtitle: string;
  draftTitle: string;
  draftSubtitle: string;
  waitingText: string;
  emptyText: string;
  footerText: string;
  generateLabel: string;
  insertLabel: string;
}

export interface AiSqlDraftMeta {
  question: string;
  title?: string;
  description?: string;
  domain?: string;
  owner?: string;
  tags?: string[];
  answer?: AgentAnswerEnvelope | null;
  blockSource?: string;
  previewResult?: QueryResult;
  previewError?: string;
}

interface AiSqlDraftDialogProps {
  mode: AiSqlMode;
  themeMode: ThemeMode;
  contextLabel?: string;
  upstreamSql?: string;
  initialPrompt?: string;
  initialSqlDraft?: string;
  initialError?: string;
  insertLabel?: string;
  onClose: () => void;
  onInsertSql: (sql: string, meta: AiSqlDraftMeta) => void;
}

export function AiSqlDraftDialog({
  mode,
  themeMode,
  contextLabel,
  upstreamSql,
  initialPrompt,
  initialSqlDraft,
  initialError,
  insertLabel,
  onClose,
  onInsertSql,
}: AiSqlDraftDialogProps) {
  const t = themes[themeMode];
  const [question, setQuestion] = useState(initialPrompt ?? '');
  const startsWithReview = Boolean(initialSqlDraft?.trim() || initialError?.trim());
  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<AgentTurn[]>([]);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<BlockProposal | null>(null);
  const [sqlDraft, setSqlDraft] = useState(initialSqlDraft?.trim() ?? '');
  const [sqlEdited, setSqlEdited] = useState(false);
  const [previewResult, setPreviewResult] = useState<QueryResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(initialError?.trim() || null);
  const [runStatus, setRunStatus] = useState<DraftRunStatus>(initialError?.trim() ? 'error' : 'idle');
  const [questionExpanded, setQuestionExpanded] = useState(!startsWithReview);
  const [sqlEditing, setSqlEditing] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const answer = useMemo(() => extractGovernedAnswer(events), [events]);
  const generatedSql = extractSqlDraft(answer, proposal, text);
  const activeSql = sqlDraft || generatedSql;
  const blockMeta = buildBlockDraftMeta(question, answer, proposal, activeSql, text);
  const title = blockMeta.title;
  const isBlockMode = mode === 'block';
  const isRepairMode = Boolean(!isBlockMode && initialSqlDraft?.trim() && initialError?.trim());
  const previewText = isBlockMode ? blockMeta.blockSource : activeSql;
  const hasReturnedDqlArtifact = Boolean(!isBlockMode && answer?.dqlArtifact?.source?.trim());
  const copy = resolveSqlDraftDialogCopy({
    mode,
    isRepairMode,
    hasReturnedDqlArtifact,
  });
  const hasReviewOutput = Boolean(events.length > 0 || text || error || previewText || previewError);
  const showQuestionEditor = questionExpanded || !hasReviewOutput;
  const previewRowCount = previewResult?.rowCount ?? previewResult?.rows.length ?? 0;

  useEffect(() => {
    if (!generatedSql || sqlEdited) return;
    setSqlDraft(generatedSql);
  }, [generatedSql, sqlEdited]);

  const runPreviewForSql = async (value: string, status: DraftRunStatus = 'running') => {
    const trimmed = value.trim();
    if (!trimmed) {
      setPreviewResult(null);
      setPreviewError('No SQL is available to run.');
      setRunStatus('error');
      return;
    }
    setRunStatus(status);
    setPreviewResult(null);
    setPreviewError(null);
    const result = await api.previewGeneratedSql(trimmed);
    if (result.ok) {
      setPreviewResult(result.result);
      setPreviewError(null);
      setRunStatus('ready');
    } else {
      setPreviewResult(null);
      setPreviewError(result.error);
      setRunStatus('error');
    }
  };

  const generate = async () => {
    const trimmed = question.trim();
    if (!trimmed || running) return;
    setRunning(true);
    setEvents([]);
    setText('');
    setError(null);
    setProposal(null);
    setSqlDraft('');
    setSqlEdited(false);
    setPreviewResult(null);
    setPreviewError(null);
    setRunStatus('generating');
    setQuestionExpanded(false);
    setSqlEditing(false);
    const controller = new AbortController();
    abortRef.current = controller;
    const collected: AgentTurn[] = [];
    let output = '';
    let latestProposal: BlockProposal | null = null;
    try {
      const repairError = previewError?.trim() || initialError?.trim();
      // Send the user's actual question — NOT a composed instruction. The governed
      // answer loop applies its own system prompt/rules, and passing the instruction
      // as the "question" leaks it into clarify text and skews intent routing.
      // Block mode still needs the block-structure instruction; SQL mode does not.
      const prompt = isRepairMode && activeSql.trim() && repairError
        ? buildSqlRepairPrompt(trimmed, activeSql.trim(), repairError, mode)
        : mode === 'block'
          ? buildSqlDraftPrompt(trimmed, mode)
          : trimmed;
      await runAgent(
        {
          messages: [{ role: 'user', content: prompt }],
          upstream: (isRepairMode ? activeSql : upstreamSql)?.trim()
            ? { cellId: `ai-sql:${mode}`, sql: (isRepairMode ? activeSql : upstreamSql) ?? '' }
            : undefined,
          signal: controller.signal,
        },
        (turn) => {
          collected.push(turn);
          setEvents([...collected]);
          if (turn.kind === 'text') {
            output += turn.text;
            setText(output);
          }
          if (turn.kind === 'proposal') {
            latestProposal = turn.proposal;
            setProposal(turn.proposal);
          }
          if (turn.kind === 'error') setError(turn.message);
        },
      );
      const finalAnswer = extractGovernedAnswer(collected);
      const nextSql = extractSqlDraft(finalAnswer, latestProposal, output);
      if (nextSql) {
        setSqlDraft(nextSql);
        setSqlEdited(false);
        setSqlEditing(false);
        await runPreviewForSql(nextSql);
      } else {
        setRunStatus('idle');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRunStatus('error');
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  const fixWithAi = async () => {
    const currentSql = activeSql.trim();
    const currentError = previewError?.trim() || error?.trim();
    if (!currentSql || !currentError || running) return;
    setRunning(true);
    setRunStatus('fixing');
    setError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    const collected: AgentTurn[] = [];
    let output = '';
    let latestProposal: BlockProposal | null = null;
    try {
      await runAgent(
        {
          messages: [{ role: 'user', content: buildSqlRepairPrompt(question.trim(), currentSql, currentError, mode) }],
          upstream: { cellId: `ai-sql-repair:${mode}`, sql: currentSql },
          signal: controller.signal,
        },
        (turn) => {
          collected.push(turn);
          setEvents([...collected]);
          if (turn.kind === 'text') {
            output += turn.text;
            setText(output);
          }
          if (turn.kind === 'proposal') {
            latestProposal = turn.proposal;
            setProposal(turn.proposal);
          }
          if (turn.kind === 'error') setError(turn.message);
        },
      );
      const fixedAnswer = extractGovernedAnswer(collected);
      const fixedSql = extractSqlDraft(fixedAnswer, latestProposal, output);
      if (!fixedSql) {
        setPreviewError('AI did not return repaired SQL. Edit the SQL directly and run it again.');
        setRunStatus('error');
        return;
      }
      setSqlDraft(fixedSql);
      setSqlEdited(false);
      setSqlEditing(false);
      await runPreviewForSql(fixedSql);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRunStatus('error');
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  const insert = () => {
    if (!activeSql) return;
    onInsertSql(activeSql, { ...blockMeta, previewResult: previewResult ?? undefined, previewError: previewError ?? undefined });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={copy.ariaLabel}
      style={overlayStyle}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div style={dialogStyle(t)}>
        <div style={headerStyle(t)}>
          <div style={iconWrapStyle(t)}><Sparkles size={17} strokeWidth={2} /></div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 800, color: t.textPrimary }}>
              {copy.heading}
            </div>
            <div style={{ fontSize: 12, color: t.textSecondary, marginTop: 2 }}>
              {copy.subtitle}
            </div>
          </div>
          <button type="button" onClick={onClose} title="Close" style={iconButtonStyle(t)}><X size={15} /></button>
        </div>

        <div style={bodyStyle}>
          {showQuestionEditor ? (
            <label style={labelStyle(t)}>
              Question
              <textarea
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                placeholder={isBlockMode ? 'Example: a saved query for the top 10 players by points per game' : 'Example: show monthly revenue by customer type'}
                rows={hasReviewOutput ? 3 : 4}
                style={textareaStyle(t, hasReviewOutput)}
                autoFocus={!hasReviewOutput}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    void generate();
                  }
                }}
              />
            </label>
          ) : (
            <div style={questionSummaryStyle(t)}>
              <div style={{ minWidth: 0 }}>
                <div style={compactEyebrowStyle(t)}>Question</div>
                <div style={compactQuestionTextStyle(t)}>{question || 'No question provided'}</div>
              </div>
              <button
                type="button"
                onClick={() => setQuestionExpanded(true)}
                style={compactActionButtonStyle(t)}
              >
                Edit question
              </button>
            </div>
          )}

          {showQuestionEditor && !hasReviewOutput ? (
            <div style={suggestionRowStyle}>
              {starterPrompts(mode).map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => setQuestion(prompt)}
                  style={suggestionStyle(t)}
                >
                  <Sparkles size={12} /> {prompt}
                </button>
              ))}
            </div>
          ) : null}

          <div style={contextStyle(t)}>
            <span>{contextLabel ?? (mode === 'block' ? 'Saved queries' : 'Notebook')}</span>
            <b>{upstreamSql?.trim() ? 'Current SQL context included' : 'Project metadata and runtime schema'}</b>
          </div>

          {hasReviewOutput ? (
            <div style={resultShellStyle(t)}>
              <div style={resultHeadStyle(t)}>
                <span>{statusLabel(runStatus, isBlockMode, Boolean(previewText))}</span>
                {answer?.certification && <b>{formatLabel(answer.certification)}</b>}
              </div>
              {error && <div style={errorStyle}>{error}</div>}
              {answer?.text || answer?.answer ? (
                <div style={summaryStyle(t)}><StructuredAnswerText text={answer.answer ?? answer.text ?? ''} t={t} compact /></div>
              ) : text ? (
                <div style={summaryStyle(t)}><StructuredAnswerText text={stripSqlBlock(text)} t={t} compact /></div>
              ) : null}
              {previewText ? (
                <div style={draftPreviewWrapStyle(t)}>
                  {isBlockMode ? <pre style={blockPreviewStyle(t)}>{blockMeta.blockSource}</pre> : null}
                  {hasReturnedDqlArtifact ? (
                    <div style={dqlArtifactReviewStyle(t)}>
                      <div style={draftReviewHeaderStyle(t)}>
                        <div style={{ minWidth: 0 }}>
                          <div style={draftTitleStyle(t)}>DQL artifact</div>
                          <div style={draftSubtitleStyle(t)}>
                            Review this draft source before using the compiled SQL preview.
                          </div>
                        </div>
                      </div>
                      <pre style={blockPreviewStyle(t)}>{blockMeta.blockSource}</pre>
                    </div>
                  ) : null}
                  <div style={draftReviewHeaderStyle(t)}>
                    <div style={{ minWidth: 0 }}>
                      <div style={draftTitleStyle(t)}>{copy.draftTitle}</div>
                      <div style={draftSubtitleStyle(t)}>
                        {copy.draftSubtitle}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setSqlEditing((value) => !value)}
                      style={compactActionButtonStyle(t)}
                    >
                      {sqlEditing ? 'Preview SQL' : 'Edit SQL'}
                    </button>
                  </div>
                  {sqlEditing ? (
                    <textarea
                      value={activeSql}
                      rows={14}
                      spellCheck={false}
                      onChange={(event) => {
                        setSqlDraft(event.target.value);
                        setSqlEdited(true);
                        setPreviewResult(null);
                        setPreviewError(null);
                        setRunStatus('idle');
                      }}
                      style={sqlEditorStyle(t)}
                    />
                  ) : (
                    <pre style={sqlReviewStyle(t)}>{activeSql}</pre>
                  )}
                  <div style={draftActionRowStyle}>
                    <button
                      type="button"
                      onClick={() => void runPreviewForSql(activeSql)}
                      disabled={!activeSql.trim() || running || runStatus === 'running'}
                      style={draftActionButtonStyle(t, Boolean(activeSql.trim()) && !running && runStatus !== 'running')}
                    >
                      {runStatus === 'running' ? 'Running...' : 'Run preview'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void fixWithAi()}
                      disabled={!activeSql.trim() || !previewError || running}
                      style={draftActionButtonStyle(t, Boolean(activeSql.trim() && previewError && !running))}
                    >
                      {runStatus === 'fixing' ? 'Fixing...' : 'Fix with AI'}
                    </button>
                    <span style={runStatusStyle(t, runStatus)}>
                      {runStatusText(runStatus, previewResult, previewError)}
                    </span>
                  </div>
                  {previewError ? <div style={errorStyle}>{previewError}</div> : null}
                  {previewResult ? (
                    <>
                      <div style={previewResultHeaderStyle(t)}>
                        <span>Preview result</span>
                        <b>{previewRowCount} rows</b>
                      </div>
                      <div style={previewTableWrapStyle(t)}>
                        <TableOutput result={previewResult} themeMode={themeMode} />
                      </div>
                    </>
                  ) : null}
                </div>
              ) : (
                <div style={emptySqlStyle(t)}>
                  {running ? copy.waitingText : copy.emptyText}
                </div>
              )}
              {events.some((event) => event.kind === 'thinking') && (
                <div style={eventListStyle(t)}>
                  {events
                    .filter((event): event is Extract<AgentTurn, { kind: 'thinking' }> => event.kind === 'thinking')
                    .slice(-3)
                    .map((event, index) => <span key={`${event.text}-${index}`}>{event.text}</span>)}
                </div>
              )}
            </div>
          ) : null}
        </div>

        <div style={footerStyle(t)}>
          <span style={{ fontSize: 11, color: t.textMuted }}>
            {copy.footerText}
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" onClick={onClose} style={secondaryButtonStyle(t)}>Cancel</button>
            {running ? (
              <button type="button" onClick={() => abortRef.current?.abort()} style={secondaryButtonStyle(t)}>
                Stop
              </button>
            ) : (
              <button type="button" onClick={() => void generate()} disabled={!question.trim()} style={primaryButtonStyle(t, Boolean(question.trim()))}>
                <Send size={13} /> {copy.generateLabel}
              </button>
            )}
            <button type="button" onClick={insert} disabled={!activeSql || running} style={insertButtonStyle(t, Boolean(activeSql) && !running)}>
              <CheckCircle2 size={13} /> {insertLabel ?? copy.insertLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function buildSqlDraftPrompt(question: string, mode: AiSqlMode): string {
  if (mode === 'block') {
    return [
      'Create a complete review-required DQL block for Block Studio.',
      'Use certified DQL blocks, business views, terms, dbt manifest metadata, semantic objects, and runtime schema before guessing.',
      'If a certified block exactly matches, cite or adapt it, but return a new review-required draft only when the user is asking to build new analysis.',
      'The block must include: block name, domain, type = "custom", status = "draft", description, owner, tags, query, visualization, and at least one simple tests block.',
      'The query must be one read-only SELECT/WITH statement with a bounded result size.',
      'Do not generate INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, COPY, MERGE, TRUNCATE, or CALL statements.',
      'Return a short business summary, then exactly one fenced dql block. Put the SQL inside query = """ ... """.',
      '',
      `User request: ${question}`,
    ].join('\n');
  }
  const surface = 'notebook SQL cell';
  return [
    `Create review-required SQL for a ${surface}.`,
    'Use trusted business logic, business views, terms, dbt manifest metadata, semantic objects, and runtime schema before guessing.',
    'If an existing trusted query exactly matches, you may reuse its SQL or cite it, but still return runnable SQL for this notebook cell.',
    'If the requested grain needs new analysis, generate a single read-only SELECT/WITH query with bounded result size.',
    'Do not generate INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, COPY, MERGE, TRUNCATE, or CALL statements.',
    'Do not ask the user to create, certify, or save any reusable block in this response; this modal only reviews SQL and inserts a SQL cell.',
    'Return a short business summary, then one fenced sql block, and mark the SQL as AI-generated/review-required.',
    '',
    `User question: ${question}`,
  ].join('\n');
}

function buildSqlRepairPrompt(question: string, sql: string, error: string, mode: AiSqlMode): string {
  return [
    mode === 'block' ? 'Repair the SQL inside this review-required DQL block draft.' : 'Repair this review-required SQL draft.',
    'Use only read-only SELECT/WITH SQL. Return a short note, then exactly one fenced sql block.',
    'Do not change the business question unless the error proves the current SQL cannot answer it.',
    '',
    `Original question: ${question || '(not provided)'}`,
    '',
    'Current SQL:',
    '```sql',
    sql,
    '```',
    '',
    `Runtime error: ${error}`,
  ].join('\n');
}

export function resolveSqlDraftDialogCopy(input: {
  mode: AiSqlMode;
  isRepairMode?: boolean;
  hasReturnedDqlArtifact?: boolean;
}): SqlDraftDialogCopy {
  if (input.mode === 'block') {
    return {
      ariaLabel: 'Build saved query',
      heading: 'Build saved query',
      subtitle: 'Metadata, dbt, certified saved queries, and schema first. Generated work stays review-required.',
      draftTitle: 'Saved query draft',
      draftSubtitle: 'Review DQL metadata, tests, lineage, grain, and result shape before certification.',
      waitingText: 'Waiting for the agent to produce a saved query...',
      emptyText: 'No saved query was returned. Add more business context or ask for a specific metric/table grain.',
      footerText: 'Use this as a draft saved query. Run, test, save, then certify.',
      generateLabel: 'Generate saved query',
      insertLabel: 'Use draft saved query',
    };
  }
  if (input.isRepairMode) {
    return {
      ariaLabel: 'Fix SQL preview',
      heading: 'Fix SQL preview',
      subtitle: 'Repair the notebook preview SQL, then review it before promoting the logic into DQL.',
      draftTitle: 'SQL preview',
      draftSubtitle: 'Review the repaired SQL and result shape before applying it to the notebook cell.',
      waitingText: 'Waiting for the agent to repair SQL...',
      emptyText: 'No repaired SQL was returned. Edit directly or add more error context.',
      footerText: 'Review the repair, run preview, then apply the fixed SQL to this cell.',
      generateLabel: 'Generate replacement SQL',
      insertLabel: 'Insert SQL preview',
    };
  }
  if (input.hasReturnedDqlArtifact) {
    return {
      ariaLabel: 'Review DQL artifact',
      heading: 'Review DQL artifact',
      subtitle: 'The returned DQL artifact is the review target. SQL is a bounded compiled preview for notebook execution.',
      draftTitle: 'Compiled SQL preview',
      draftSubtitle: 'Review the DQL artifact first; use this SQL only as the executable preview.',
      waitingText: 'Waiting for the agent to produce a DQL artifact...',
      emptyText: 'No compiled SQL preview was returned. Review the DQL artifact or ask for a narrower grain.',
      footerText: 'Review the DQL artifact, run the compiled preview, then insert SQL only when you need a notebook cell.',
      generateLabel: 'Regenerate preview',
      insertLabel: 'Insert SQL preview',
    };
  }
  return {
    ariaLabel: 'Build SQL preview',
    heading: 'Build SQL preview',
    subtitle: 'Metadata, dbt, semantic context, and schema first. SQL stays review-required until promoted into DQL.',
    draftTitle: 'SQL preview',
    draftSubtitle: 'Review grain, joins, filters, and result shape before using this SQL.',
    waitingText: 'Waiting for the agent to produce SQL preview...',
    emptyText: 'No SQL preview was returned. Add more schema context or ask for a specific metric/table grain.',
    footerText: 'Use this as a notebook SQL preview. For reusable analytics, promote the reviewed logic into DQL.',
    generateLabel: 'Generate SQL preview',
    insertLabel: 'Insert SQL preview',
  };
}

function statusLabel(status: DraftRunStatus, isBlockMode: boolean, hasPreviewText: boolean): string {
  if (status === 'generating') return isBlockMode ? 'Generating saved query' : 'Generating SQL preview';
  if (status === 'running') return 'Running preview';
  if (status === 'fixing') return 'Fixing SQL';
  if (status === 'ready') return isBlockMode ? 'Saved query preview ready' : 'SQL preview ready';
  if (status === 'error') return 'Needs fix';
  if (hasPreviewText) return isBlockMode ? 'Saved query draft ready' : 'SQL preview ready';
  return 'AI response';
}

function runStatusText(status: DraftRunStatus, result: QueryResult | null, error: string | null): string {
  if (status === 'generating') return 'Generating draft...';
  if (status === 'running') return 'Running against the active connection...';
  if (status === 'fixing') return 'Repairing with AI...';
  if (error) return 'Preview failed';
  if (result) return `${result.rowCount ?? result.rows.length} rows`;
  return 'Review required';
}

export function buildBlockDraftMeta(
  question: string,
  answer: AgentAnswerEnvelope | null,
  proposal: BlockProposal | null,
  sql: string,
  text: string,
): AiSqlDraftMeta {
  const answerDqlSource = answer?.dqlArtifact?.source?.trim();
  const title = proposal?.name
    ?? answer?.dqlArtifact?.name
    ?? answer?.block?.name
    ?? answer?.result?.blockName
    ?? titleFromQuestion(question);
  const description = proposal?.description
    ?? answer?.answer
    ?? answer?.text
    ?? `AI-generated draft for: ${question.trim() || title}`;
  const domain = proposal?.domain ?? answer?.block?.domain ?? inferDomain(question);
  const owner = proposal?.owner ?? answer?.evidence?.outcome?.owner ?? 'analytics';
  const tags = uniqueList([...(proposal?.tags ?? []), 'ai-generated', 'review-required']);
  const blockSource = proposal?.dqlSource?.trim() || answerDqlSource || extractBlockDraft(text) || buildDqlBlockSource({
    name: title,
    domain,
    owner,
    description,
    tags,
    sql,
  });
  return {
    question: question.trim(),
    title,
    description: firstSentence(description),
    domain,
    owner,
    tags,
    answer,
    blockSource,
  };
}

export function extractSqlDraft(answer: AgentAnswerEnvelope | null, proposal: BlockProposal | null, text: string): string {
  const sql = firstNonEmpty([
    answer?.proposedSql,
    answer?.sql,
    answer?.result?.sql,
    answer?.analysisPlan?.sql,
    proposal?.sql,
    extractQueryFromBlock(answer?.dqlArtifact?.source ?? ''),
    extractQueryFromBlock(extractBlockDraft(text)),
    extractFencedSql(text),
  ]);
  return cleanSql(sql);
}

function extractBlockDraft(text: string): string {
  const fenced = text.match(/```(?:dql|ddl|dqld)\s*([\s\S]*?)```/i);
  if (fenced?.[1] && /^\s*block\s+"/i.test(fenced[1].trim())) return fenced[1].trim();
  const generic = text.match(/```\s*([\s\S]*?)```/);
  if (generic?.[1] && /^\s*block\s+"/i.test(generic[1].trim())) return generic[1].trim();
  const start = text.search(/^\s*block\s+"/im);
  if (start < 0) return '';
  const body = text.slice(start).trim();
  const end = body.lastIndexOf('}');
  return end >= 0 ? body.slice(0, end + 1).trim() : body;
}

function extractFencedSql(text: string): string {
  const sqlMatch = text.match(/```sql\s*([\s\S]*?)```/i);
  if (sqlMatch?.[1]) return sqlMatch[1];
  const genericMatch = text.match(/```[a-zA-Z0-9_-]*\s*([\s\S]*?)```/);
  const body = genericMatch?.[1]?.trim() ?? '';
  if (!body || /^\s*block\s+"/i.test(body)) return '';
  if (/^\s*(select|with)\b/i.test(body)) return body;
  return '';
}

function cleanSql(sql?: string): string {
  return String(sql ?? '').trim().replace(/;\s*$/, '');
}

function firstNonEmpty(values: Array<string | undefined | null>): string {
  return values.find((value) => Boolean(value?.trim())) ?? '';
}

function extractQueryFromBlock(blockSource: string): string {
  return blockSource.match(/query\s*=\s*"""([\s\S]*?)"""/i)?.[1]?.trim() ?? '';
}

function stripSqlBlock(text: string): string {
  return text.replace(/```(?:sql|dql|ddl|dqld)?[\s\S]*?```/gi, '').trim();
}

function starterPrompts(mode: AiSqlMode): string[] {
  return mode === 'block'
    ? ['Top customers by revenue', 'Monthly trend by segment', 'Data quality availability check']
    : ['Build a trend query', 'Break this down by segment', 'Show top movers'];
}

function titleFromQuestion(question: string): string {
  const words = question
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((word) => !/^(show|build|create|make|give|me|the|a|an|by|for|with)$/i.test(word))
    .slice(0, 8);
  const title = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' ');
  return title || 'AI SQL Draft';
}

function formatLabel(value: string): string {
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function buildDqlBlockSource(options: {
  name: string;
  domain: string;
  owner: string;
  description: string;
  tags: string[];
  sql: string;
}): string {
  const sql = cleanSql(options.sql) || 'SELECT 1 AS value';
  const tags = uniqueList(options.tags.length > 0 ? options.tags : ['ai-generated', 'review-required']);
  return [
    `block "${escapeDql(options.name)}" {`,
    `  domain = "${escapeDql(options.domain || 'analytics')}"`,
    '  type = "custom"',
    '  status = "draft"',
    `  description = "${escapeDql(firstSentence(options.description) || options.name)}"`,
    `  owner = "${escapeDql(options.owner || 'analytics')}"`,
    `  tags = [${tags.map((tag) => `"${escapeDql(tag)}"`).join(', ')}]`,
    '',
    '  query = """',
    indentSql(sql, '    '),
    '  """',
    '',
    '  visualization {',
    '    chart = "table"',
    '  }',
    '',
    '  tests {',
    '    assert row_count > 0',
    '  }',
    '}',
  ].join('\n');
}

function inferDomain(question: string): string {
  const lower = question.toLowerCase();
  if (/\b(player|goal|assist|defense|nba|game|team|scoring)\b/.test(lower)) return 'nba';
  if (/\b(customer|account|segment)\b/.test(lower)) return 'customer';
  if (/\b(revenue|sales|arr|booking)\b/.test(lower)) return 'revenue';
  return 'analytics';
}

function firstSentence(value: string): string {
  return value.replace(/\s+/g, ' ').split(/(?<=[.!?])\s/)[0]?.slice(0, 220).trim() || '';
}

function uniqueList(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function escapeDql(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function indentSql(sql: string, indent: string): string {
  return sql.split('\n').map((line) => `${indent}${line}`).join('\n');
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 1400,
  background: 'rgba(0,0,0,0.34)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 24,
};

const bodyStyle: React.CSSProperties = {
  padding: 18,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  flex: 1,
  minHeight: 0,
  overflow: 'auto',
};

const suggestionRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  flexWrap: 'wrap',
};

function dialogStyle(t: Theme): React.CSSProperties {
  return {
    width: 'min(1040px, calc(100vw - 32px))',
    maxHeight: 'min(880px, calc(100vh - 32px))',
    background: t.modalBg,
    color: t.textPrimary,
    border: `1px solid ${t.cellBorder}`,
    borderRadius: 12,
    boxShadow: '0 22px 70px rgba(0,0,0,0.35)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    fontFamily: t.font,
  };
}

function headerStyle(t: Theme): React.CSSProperties {
  return {
    display: 'flex',
    gap: 10,
    alignItems: 'center',
    padding: '14px 16px',
    borderBottom: `1px solid ${t.headerBorder}`,
  };
}

function iconWrapStyle(t: Theme): React.CSSProperties {
  return {
    width: 34,
    height: 34,
    borderRadius: 9,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: t.accent,
    background: `${t.accent}16`,
    border: `1px solid ${t.accent}36`,
    flex: '0 0 auto',
  };
}

function iconButtonStyle(t: Theme): React.CSSProperties {
  return {
    width: 30,
    height: 30,
    border: `1px solid ${t.headerBorder}`,
    borderRadius: 7,
    background: t.appBg,
    color: t.textSecondary,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  };
}

function labelStyle(t: Theme): React.CSSProperties {
  return {
    display: 'flex',
    flexDirection: 'column',
    gap: 7,
    color: t.textSecondary,
    fontSize: 12,
    fontWeight: 700,
  };
}

function textareaStyle(t: Theme, compact = false): React.CSSProperties {
  return {
    resize: 'vertical',
    minHeight: compact ? 70 : 88,
    border: `1px solid ${t.cellBorder}`,
    borderRadius: 8,
    background: t.editorBg,
    color: t.textPrimary,
    fontFamily: t.font,
    fontSize: 13,
    lineHeight: 1.45,
    padding: 10,
    outline: 'none',
  };
}

function questionSummaryStyle(t: Theme): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: '10px 12px',
    border: `1px solid ${t.cellBorder}`,
    borderRadius: 10,
    background: t.editorBg,
  };
}

function compactEyebrowStyle(t: Theme): React.CSSProperties {
  return {
    color: t.textMuted,
    fontSize: 10,
    lineHeight: 1.2,
    textTransform: 'uppercase',
    fontWeight: 800,
    marginBottom: 4,
  };
}

function compactQuestionTextStyle(t: Theme): React.CSSProperties {
  return {
    color: t.textPrimary,
    fontSize: 13,
    lineHeight: 1.35,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  };
}

function compactActionButtonStyle(t: Theme): React.CSSProperties {
  return {
    border: `1px solid ${t.headerBorder}`,
    borderRadius: 7,
    background: t.cellBg,
    color: t.textSecondary,
    cursor: 'pointer',
    padding: '6px 9px',
    fontSize: 11,
    fontFamily: t.font,
    fontWeight: 800,
    flex: '0 0 auto',
  };
}

function suggestionStyle(t: Theme): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    border: `1px solid ${t.headerBorder}`,
    borderRadius: 999,
    background: t.appBg,
    color: t.textSecondary,
    cursor: 'pointer',
    padding: '5px 9px',
    fontSize: 11,
    fontFamily: t.font,
  };
}

function contextStyle(t: Theme): React.CSSProperties {
  return {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 10,
    padding: '8px 10px',
    borderRadius: 8,
    background: `${t.accent}0d`,
    border: `1px solid ${t.headerBorder}`,
    color: t.textMuted,
    fontSize: 11,
  };
}

function resultShellStyle(t: Theme): React.CSSProperties {
  return {
    border: `1px solid ${t.cellBorder}`,
    borderRadius: 10,
    background: t.cellBg,
    overflow: 'hidden',
  };
}

function resultHeadStyle(t: Theme): React.CSSProperties {
  return {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 10,
    padding: '8px 10px',
    borderBottom: `1px solid ${t.headerBorder}`,
    color: t.textSecondary,
    fontSize: 11,
    fontWeight: 800,
    textTransform: 'uppercase',
  };
}

function draftPreviewWrapStyle(t: Theme): React.CSSProperties {
  return {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    padding: 14,
    borderTop: `1px solid ${t.headerBorder}`,
    background: t.cellBg,
  };
}

function dqlArtifactReviewStyle(t: Theme): React.CSSProperties {
  return {
    display: 'grid',
    gap: 8,
    padding: 10,
    border: `1px solid ${t.accent}38`,
    borderRadius: 8,
    background: `${t.accent}0f`,
  };
}

function draftReviewHeaderStyle(t: Theme): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  };
}

function draftTitleStyle(t: Theme): React.CSSProperties {
  return {
    color: t.textPrimary,
    fontSize: 13,
    fontWeight: 800,
  };
}

function draftSubtitleStyle(t: Theme): React.CSSProperties {
  return {
    color: t.textMuted,
    fontSize: 11,
    marginTop: 2,
  };
}

function blockPreviewStyle(t: Theme): React.CSSProperties {
  return {
    margin: 0,
    maxHeight: 220,
    overflow: 'auto',
    padding: 10,
    background: t.editorBg,
    border: `1px solid ${t.headerBorder}`,
    borderRadius: 8,
    color: t.textSecondary,
    fontFamily: t.fontMono,
    fontSize: 11.5,
    lineHeight: 1.45,
    whiteSpace: 'pre',
  };
}

function sqlEditorStyle(t: Theme): React.CSSProperties {
  return {
    resize: 'vertical',
    minHeight: 280,
    border: `1px solid ${t.cellBorder}`,
    borderRadius: 8,
    background: t.editorBg,
    color: t.textPrimary,
    fontFamily: t.fontMono,
    fontSize: 12,
    lineHeight: 1.5,
    padding: 10,
    outline: 'none',
    whiteSpace: 'pre',
  };
}

function sqlReviewStyle(t: Theme): React.CSSProperties {
  return {
    margin: 0,
    maxHeight: 'min(430px, 44vh)',
    overflow: 'auto',
    padding: 14,
    background: t.editorBg,
    border: `1px solid ${t.cellBorder}`,
    borderRadius: 9,
    color: t.textPrimary,
    fontFamily: t.fontMono,
    fontSize: 12.5,
    lineHeight: 1.55,
    whiteSpace: 'pre',
  };
}

const draftActionRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
};

function draftActionButtonStyle(t: Theme, enabled: boolean): React.CSSProperties {
  return {
    border: `1px solid ${enabled ? t.accent : t.headerBorder}`,
    borderRadius: 7,
    background: enabled ? `${t.accent}14` : t.appBg,
    color: enabled ? t.accent : t.textMuted,
    cursor: enabled ? 'pointer' : 'not-allowed',
    padding: '6px 10px',
    fontSize: 11,
    fontFamily: t.font,
    fontWeight: 800,
  };
}

function runStatusStyle(t: Theme, status: DraftRunStatus): React.CSSProperties {
  return {
    marginLeft: 'auto',
    color: status === 'ready' ? '#3fb950' : status === 'error' ? '#ff7b72' : t.textMuted,
    fontSize: 11,
    fontFamily: t.fontMono,
    fontWeight: 700,
  };
}

function previewTableWrapStyle(t: Theme): React.CSSProperties {
  return {
    maxHeight: 300,
    overflow: 'auto',
    border: `1px solid ${t.headerBorder}`,
    borderRadius: 8,
    background: t.appBg,
  };
}

function previewResultHeaderStyle(t: Theme): React.CSSProperties {
  return {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 10,
    color: t.textSecondary,
    fontSize: 11,
    fontWeight: 800,
    textTransform: 'uppercase',
  };
}

function summaryStyle(t: Theme): React.CSSProperties {
  return {
    padding: '10px 12px',
    color: t.textSecondary,
    fontSize: 12,
    lineHeight: 1.5,
  };
}

function sqlPreviewStyle(t: Theme): React.CSSProperties {
  return {
    margin: 0,
    maxHeight: 280,
    overflow: 'auto',
    padding: 12,
    background: t.editorBg,
    borderTop: `1px solid ${t.headerBorder}`,
    color: t.textPrimary,
    fontFamily: t.fontMono,
    fontSize: 12,
    lineHeight: 1.5,
    whiteSpace: 'pre',
  };
}

function emptySqlStyle(t: Theme): React.CSSProperties {
  return {
    padding: 12,
    color: t.textMuted,
    fontSize: 12,
    borderTop: `1px solid ${t.headerBorder}`,
  };
}

function eventListStyle(t: Theme): React.CSSProperties {
  return {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    padding: '9px 12px',
    borderTop: `1px solid ${t.headerBorder}`,
    color: t.textMuted,
    fontSize: 11,
  };
}

function footerStyle(t: Theme): React.CSSProperties {
  return {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 12,
    alignItems: 'center',
    padding: '12px 16px',
    borderTop: `1px solid ${t.headerBorder}`,
    background: t.appBg,
    flexWrap: 'wrap',
  };
}

function secondaryButtonStyle(t: Theme): React.CSSProperties {
  return {
    border: `1px solid ${t.headerBorder}`,
    borderRadius: 7,
    background: t.cellBg,
    color: t.textSecondary,
    cursor: 'pointer',
    padding: '7px 11px',
    fontSize: 12,
    fontFamily: t.font,
  };
}

function primaryButtonStyle(t: Theme, enabled: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    border: `1px solid ${enabled ? t.accent : t.headerBorder}`,
    borderRadius: 7,
    background: enabled ? `${t.accent}20` : t.cellBg,
    color: enabled ? t.accent : t.textMuted,
    cursor: enabled ? 'pointer' : 'not-allowed',
    padding: '7px 11px',
    fontSize: 12,
    fontFamily: t.font,
  };
}

function insertButtonStyle(t: Theme, enabled: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    border: `1px solid ${enabled ? '#3fb950' : t.headerBorder}`,
    borderRadius: 7,
    background: enabled ? '#3fb95018' : t.cellBg,
    color: enabled ? '#238636' : t.textMuted,
    cursor: enabled ? 'pointer' : 'not-allowed',
    padding: '7px 11px',
    fontSize: 12,
    fontFamily: t.font,
  };
}

const errorStyle: React.CSSProperties = {
  margin: 10,
  padding: '7px 9px',
  borderRadius: 6,
  background: '#ff7b7218',
  color: '#ff7b72',
  fontSize: 12,
};
