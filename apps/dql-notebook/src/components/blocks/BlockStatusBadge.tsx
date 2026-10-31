import React from 'react';
import { AlertTriangle, Archive, CheckCircle2, Clock, Eye, FilePen, Loader2, ShieldCheck } from 'lucide-react';
import type { Theme } from '../../themes/notebook-theme';
import { STATUS_COLORS } from './block-types';

/**
 * Per-block status shown across the block surfaces — draft-first. Covers both the
 * governed lifecycle (draft/review/certified/…) and live generation states
 * (queued/generating/ready/blocked/…), so the library, Block Studio, and every
 * generation flow show one consistent, icon-led badge. Certification is never the
 * lead — a fresh/generated block reads as "Draft".
 */
export type BlockGenerationStatus =
  | 'queued' | 'generating' | 'running' | 'saving' | 'saved' | 'ready' | 'blocked' | 'needs_attention';

const GEN_COLOR: Record<BlockGenerationStatus, string> = {
  queued: '#8b949e', generating: '#4c8dff', running: '#4c8dff', saving: '#4c8dff',
  saved: '#2ea043', ready: '#2ea043', blocked: '#f85149', needs_attention: '#d29922',
};

const GEN_LABEL: Record<string, string> = {
  queued: 'Queued', generating: 'Generating', running: 'Running', saving: 'Saving',
  saved: 'Saved', ready: 'Ready', blocked: 'Blocked', needs_attention: 'Needs review',
  draft: 'Draft', review: 'In review', certified: 'Certified', deprecated: 'Deprecated',
  pending_recertification: 'Recertify', proposed: 'Certification proposed',
};

const ICONS: Record<string, React.ComponentType<any>> = {
  draft: FilePen, queued: Clock, generating: Loader2, running: Loader2, saving: Loader2,
  ready: CheckCircle2, saved: CheckCircle2, blocked: AlertTriangle, needs_attention: AlertTriangle,
  review: Eye, certified: ShieldCheck, deprecated: Archive, pending_recertification: AlertTriangle, proposed: Eye,
};

const SPIN = new Set(['generating', 'running', 'saving']);

/** Resolve a status color from the lifecycle palette, then the generation palette. */
export function blockStatusColor(status: string): string {
  return STATUS_COLORS[status] ?? GEN_COLOR[status as BlockGenerationStatus] ?? '#8b949e';
}

export function blockStatusLabel(status: string): string {
  return GEN_LABEL[status] ?? (status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, ' '));
}

/**
 * The status a person reads for a block. Under a host that certifies through its
 * own review, a certification made on the branch being served is a proposal until
 * a reviewer approves it; everything else reads as its own status.
 */
export function blockDisplayStatus(status: string, block: { certificationProposed?: boolean } | null | undefined, hostProposes: boolean): string {
  return hostProposes && status === 'certified' && block?.certificationProposed ? 'proposed' : status;
}

export function BlockStatusBadge({ status, t, label }: { status: string; t: Theme; label?: string }) {
  const color = blockStatusColor(status);
  const Icon = ICONS[status] ?? FilePen;
  const text = label ?? blockStatusLabel(status);
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, fontWeight: 800,
        color, background: `${color}18`, border: `1px solid ${color}33`, borderRadius: 999,
        padding: '2px 8px', fontFamily: t.font, textTransform: 'uppercase', letterSpacing: '0.03em',
        whiteSpace: 'nowrap',
      }}
    >
      <Icon size={11} strokeWidth={2.2} className={SPIN.has(status) ? 'spin' : undefined} />
      {text}
    </span>
  );
}
