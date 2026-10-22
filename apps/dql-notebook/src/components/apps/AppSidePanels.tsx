import React, { type ReactNode } from 'react';
import { Blocks, BookOpenText, Bot, FileText, LayoutDashboard, ShieldCheck, Workflow } from 'lucide-react';
import type { AppDocumentSummary } from '../../api/client';
import { AppAudienceEditor } from './AppAudienceEditor';
import { useHostUi } from '../../host/host-ui';

/**
 * Read-only side panels for the App workspace (notebooks, pins, drafts,
 * settings) and the small presentational shells they share.
 *
 * Extracted from `AppsView.tsx`; each is a short list renderer with no state.
 */

export function PanelCard({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="dql-app-panel-card">
      <span>{icon}</span>
      <div>{children}</div>
    </div>
  );
}

export function EmptyPanel({ title, detail, compact = false }: { title: string; detail: string; compact?: boolean }) {
  return (
    <div className={`dql-app-empty ${compact ? 'compact' : ''}`}>
      <LayoutDashboard size={compact ? 24 : 34} strokeWidth={1.5} />
      <b>{title}</b>
      <span>{detail}</span>
    </div>
  );
}

export function NotebookListPanel({ appDoc }: { appDoc: AppDocumentSummary | null }) {
  const notebooks = appDoc?.notebooks ?? appDoc?.app.notebooks ?? [];
  if (!notebooks.length) return <EmptyPanel title="No notebooks attached." detail="Attach analysis notebooks in Build mode when this App needs supporting work." />;
  return (
    <div className="dql-app-simple-list">
      {notebooks.map((notebook) => (
        <PanelCard key={notebook.path} icon={<BookOpenText size={16} />}>
          <b>{notebook.title ?? notebook.path.split('/').pop()}</b>
          <span>{notebook.role} / {notebook.visibility} / {notebook.path}</span>
        </PanelCard>
      ))}
    </div>
  );
}

export function AiPinsPanel({ appDoc }: { appDoc: AppDocumentSummary | null }) {
  const pins = appDoc?.aiPins ?? [];
  // With a host an AI pin is its pinner's own: say so where pins are listed.
  const hosted = useHostUi().host;
  if (!pins.length) return <EmptyPanel title="No pinned insights yet." detail={hosted ? 'Pins you make from Copilot are yours alone: only you see them. Keep one as a live tile to share it.' : 'Use Copilot from a dashboard page, create analysis, then add useful reviewed insights to this App.'} />;
  return (
    <div className="dql-app-simple-list">
      {hosted ? <p className="dql-app-panel-note">Only you see these pins. Keep one as a live tile to share it.</p> : null}
      {pins.map((pin) => (
        <PanelCard key={pin.id} icon={<Bot size={16} />}>
          <b>{pin.title}</b>
          <span>{pin.certification} / {pin.reviewStatus}</span>
        </PanelCard>
      ))}
    </div>
  );
}

export function DraftsPanel({ appDoc }: { appDoc: AppDocumentSummary | null }) {
  const drafts = appDoc?.drafts ?? [];
  if (!drafts.length) return <EmptyPanel title="No drafts." detail="Generated and promoted draft saved queries will appear here for review." />;
  return (
    <div className="dql-app-simple-list">
      {drafts.map((draft) => (
        <PanelCard key={draft.path} icon={<FileText size={16} />}>
          <b>{draft.name}</b>
          <span>{draft.reviewStatus ?? 'needs review'} / {draft.path}</span>
        </PanelCard>
      ))}
    </div>
  );
}

export function SettingsPanel({ appDoc, onOpenLink }: { appDoc: AppDocumentSummary | null; onOpenLink?: (label: string, href: string) => void }) {
  if (!appDoc) return <EmptyPanel title="No App selected." detail="Choose an App to inspect its settings." />;
  return (
    <div className="dql-app-settings-grid">
      <AppAudienceEditor key={appDoc.app.id} appId={appDoc.app.id} audience={appDoc.app.audience} groups={appDoc.app.audienceGroups ?? []} {...(onOpenLink ? { onOpenLink } : {})} />
      <PanelCard icon={<ShieldCheck size={16} />}><b>Owners</b><span>{appDoc.app.owners.join(', ')}</span></PanelCard>
      <PanelCard icon={<Workflow size={16} />}><b>Lifecycle</b><span>{appDoc.app.lifecycle ?? 'draft'}</span></PanelCard>
      <PanelCard icon={<Blocks size={16} />}><b>Policies</b><span>{appDoc.app.policies.length} local access policies</span></PanelCard>
      <PanelCard icon={<LayoutDashboard size={16} />}><b>Homepage</b><span>{appDoc.app.homepage?.type ?? 'dashboard'}</span></PanelCard>
    </div>
  );
}

export function PanelHead({ title, meta }: { title: string; meta?: string }) {
  return (
    <div className="dql-app-panel-head">
      <span>{title}</span>
      {meta ? <b>{meta}</b> : null}
    </div>
  );
}

export function StatusSeal({ children, tone = 'certified', title }: { children: ReactNode; tone?: 'certified' | 'draft' | 'agentic'; title?: string }) {
  return <span className={`dql-app-seal ${tone}`} title={title}>{children}</span>;
}
