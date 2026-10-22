// Spec 14 — shared AI Build dialog, mounted once at the app-shell level.
//
// Front doors that live OUTSIDE the notebook (Get Started / Block Studio)
// open Build through the ai-build bus; this modal wraps the clean
// <AiBuildResult> surface so those doors never reach the Q&A answer loop.
//
// target:'cell' results insert a review-required SQL preview into the open notebook
// (if any). target:'block' results open the generated draft in Block Studio.

import React, { useEffect, useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { useNotebook, makeCell } from '../../store/NotebookStore';
import { themes } from '../../themes/notebook-theme';
import { subscribeAiBuild, type AiBuildLaunchRequest } from '../../utils/ai-build-bus';
import { AiBuildResult, useOpenBlockInStudio } from './AiBuildResult';

export function AiBuildDialog(): JSX.Element | null {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const [request, setRequest] = useState<AiBuildLaunchRequest | null>(null);
  const openBlockInStudio = useOpenBlockInStudio();

  useEffect(() => subscribeAiBuild((next) => setRequest(next)), []);

  if (!request) return null;

  const close = () => setRequest(null);

  // target:'cell' — append a fresh SQL preview cell. The shared
  // dialog has no "active cell" of its own, so it inserts a new cell.
  const insertCell = (sql: string) => {
    const trimmed = sql.trim();
    if (!trimmed) return;
    const cell = makeCell('sql', trimmed);
    cell.name = 'ai_sql_preview';
    dispatch({ type: 'ADD_CELL', cell });
  };

  const openBlock = (path: string, name: string) => {
    void openBlockInStudio(path, name).finally(close);
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="Ask AI to build" style={overlayStyle}>
      <div
        style={{
          width: 'min(720px, calc(100vw - 32px))',
          maxHeight: 'min(760px, calc(100vh - 64px))',
          background: t.appBg,
          border: `1px solid ${t.headerBorder}`,
          borderRadius: 12,
          boxShadow: '0 24px 80px rgba(0,0,0,0.34)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '11px 14px',
            borderBottom: `1px solid ${t.headerBorder}`,
          }}
        >
          <div
            style={{
              width: 30,
              height: 30,
              borderRadius: 8,
              background: `${t.accent}16`,
              border: `1px solid ${t.accent}38`,
              color: t.accent,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              flex: '0 0 auto',
            }}
          >
            <Sparkles size={16} strokeWidth={2.2} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 850, color: t.textPrimary, fontFamily: t.font }}>
              {request.mode === 'edit' ? 'Ask AI to modify a saved query' : 'Ask AI to build a saved query'}
            </div>
            <div style={{ fontSize: 11.5, color: t.textMuted, fontFamily: t.font, marginTop: 1 }}>
              {request.sourceLabel
                ?? (request.mode === 'edit'
                  ? 'Describe the change and review a before/after diff. Nothing is certified.'
                  : 'Generate a draft from your dbt + semantic context. Nothing is certified.')}
            </div>
          </div>
          <button
            type="button"
            onClick={close}
            title="Close"
            style={{
              width: 28,
              height: 28,
              borderRadius: 6,
              border: `1px solid ${t.btnBorder}`,
              background: t.btnBg,
              color: t.textSecondary,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
            }}
          >
            <X size={15} strokeWidth={2} />
          </button>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          <AiBuildResult
            key={`${request.target}:${request.mode ?? 'create'}:${request.blockPath ?? ''}:${request.prompt ?? ''}:${request.sourceLabel ?? ''}`}
            themeMode={state.themeMode}
            initialTarget={request.target}
            lockTarget={request.lockTarget}
            initialPrompt={request.prompt}
            context={request.context}
            initialMode={request.mode}
            initialBlockPath={request.blockPath}
            onInsertCell={insertCell}
            onOpenBlock={openBlock}
          />
        </div>
      </div>
    </div>
  );
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 60,
  background: 'rgba(0,0,0,0.32)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 16,
};
