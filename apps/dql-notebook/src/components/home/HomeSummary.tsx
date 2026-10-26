import React, { useEffect, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, LayoutDashboard, Star, Sparkles, Inbox } from 'lucide-react';
import { fetchHome, fetchHomeCards, type HomeCard, type HomeSummary as HomeSummaryData } from '../../api/home-api';
import { useDispatch } from '../../store/NotebookStore';
import { hostAllows, useHostPage, useHostUi, type HostUiState } from '../../host/host-ui';

/**
 * A HOME THAT SUMMARISES (RFC 0010, HH-16), above Ask: the Apps this person
 * may open (followed first, then the ones they opened last), what moved on
 * the pages they follow or opened — their own figures, from their own runs —
 * and whatever the host adds (for example "Open requests"). It loads after
 * Ask and shows nothing when there is nothing to show, so a project without
 * Apps looks exactly as before.
 */
export function HomeSummary(): JSX.Element | null {
  const dispatch = useDispatch();
  const hostPage = useHostPage();
  const hostUi = useHostUi();
  const [summary, setSummary] = useState<HomeSummaryData | null>(null);
  const [cards, setCards] = useState<HomeCard[]>([]);
  useEffect(() => {
    let cancelled = false;
    void fetchHome().then((value) => { if (!cancelled) setSummary(value); }).catch(() => undefined);
    void fetchHomeCards().then((value) => { if (!cancelled) setCards(value); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  return (
    <HomeSummaryView
      summary={summary}
      cards={homeCardsFor(hostUi, cards)}
      onOpenApp={(appId, pageId) => dispatch({ type: 'OPEN_APP', appId, ...(pageId ? { dashboardId: pageId } : {}) })}
      onOpenLink={(label, href) => {
        hostPage.openPage({ id: `home-${href}`, label, href });
        dispatch({ type: 'SET_MAIN_VIEW', view: 'host_page' });
      }}
    />
  );
}

/** "Open requests" is for people who may make requests; the host's other cards are shown as it sent them. */
export function homeCardsFor(host: HostUiState, cards: HomeCard[]): HomeCard[] {
  return cards.filter((hostCard) => hostCard.id !== 'requests' || hostAllows(host, 'request.create'));
}

const card: React.CSSProperties = {
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: '12px 14px',
  borderRadius: 10,
  border: '1px solid var(--border-subtle)',
  background: 'var(--bg-2)',
};
const heading: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-tertiary)' };
const rowButton: React.CSSProperties = {
  display: 'flex', alignItems: 'baseline', gap: 8, width: '100%', padding: '5px 6px', margin: '0 -6px',
  border: 'none', borderRadius: 6, background: 'transparent', color: 'var(--text-primary)', textAlign: 'left', cursor: 'pointer', fontSize: 13,
};
const muted: React.CSSProperties = { color: 'var(--text-secondary)', fontSize: 12 };

const ago = (iso: string, now = Date.now()): string => {
  const minutes = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
  if (!Number.isFinite(minutes)) return '';
  if (minutes < 60) return minutes <= 1 ? 'just now' : `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

/** The summary itself, without loading: what a test renders. */
export function HomeSummaryView({ summary, cards, onOpenApp, onOpenLink }: {
  summary: HomeSummaryData | null;
  cards: HomeCard[];
  onOpenApp: (appId: string, pageId?: string) => void;
  onOpenLink: (label: string, href: string) => void;
}): JSX.Element | null {
  const apps = (summary?.apps ?? []).slice(0, 6);
  const moved = summary?.moved ?? [];
  if (!apps.length && !moved.length && !cards.length) return null;
  return (
    <section
      aria-label="Your summary"
      data-testid="home-summary"
      style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12, padding: '16px 20px 4px', maxWidth: 1080, width: '100%', margin: '0 auto', boxSizing: 'border-box' }}
    >
      {apps.length ? (
        <div style={card}>
          <div style={heading}><LayoutDashboard size={12} aria-hidden="true" /> My Apps</div>
          {apps.map((app) => (
            <button key={app.id} type="button" style={rowButton} onClick={() => onOpenApp(app.id, app.homePageId)} title={app.description ?? app.name}>
              {app.following ? <Star size={12} fill="currentColor" aria-label="Following" style={{ color: 'var(--accent)', flexShrink: 0 }} /> : null}
              <span style={{ fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{app.name}</span>
              <span style={{ ...muted, marginLeft: 'auto', flexShrink: 0 }}>{app.lastOpenedAt ? ago(app.lastOpenedAt) : app.domain}</span>
            </button>
          ))}
        </div>
      ) : null}
      {moved.length ? (
        <div style={card}>
          <div style={heading}><Sparkles size={12} aria-hidden="true" /> What moved</div>
          {moved.map((page) => (
            <button key={`${page.appId}/${page.pageId}`} type="button" style={{ ...rowButton, flexDirection: 'column', alignItems: 'stretch', gap: 3 }} onClick={() => onOpenApp(page.appId, page.pageId)}>
              <span style={{ fontWeight: 600 }}>{page.appName} · {page.pageTitle}</span>
              {page.changes.slice(0, 3).map((change) => (
                <span key={change.label} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
                  {change.direction === 'up'
                    ? <ArrowUpRight size={12} aria-hidden="true" style={{ color: 'var(--accent)' }} />
                    : <ArrowDownRight size={12} aria-hidden="true" style={{ color: 'var(--text-secondary)' }} />}
                  <span>{change.label}</span>
                  <span style={{ marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' }}>{change.from} → <b>{change.to}</b> <span style={muted}>({change.change})</span></span>
                </span>
              ))}
              {page.changes.length > 3 ? <span style={muted}>and {page.changes.length - 3} more</span> : null}
              {page.newEditionAt ? <span style={muted}>New edition {ago(page.newEditionAt)} — open it to see your figures</span>
                : page.since ? <span style={muted}>Since your run {ago(page.since)}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
      {cards.map((hostCard) => (
        <div key={hostCard.id} style={card} data-host-card={hostCard.id}>
          <div style={heading}><Inbox size={12} aria-hidden="true" /> {hostCard.title}</div>
          {hostCard.items.length === 0 ? <span style={muted}>{hostCard.emptyText ?? 'Nothing here.'}</span> : null}
          {hostCard.items.map((item) => {
            const body = (
              <>
                <span style={{ fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.title}</span>
                {item.status ? <span style={{ ...muted, marginLeft: 'auto', flexShrink: 0, color: item.tone === 'caution' ? 'var(--text-primary)' : muted.color }}>{item.status}</span> : null}
              </>
            );
            return item.href
              ? <button key={item.id} type="button" style={rowButton} title={item.detail ?? item.title} onClick={() => onOpenLink(hostCard.title, item.href!)}>{body}</button>
              : <div key={item.id} style={{ ...rowButton, cursor: 'default' }} title={item.detail ?? item.title}>{body}</div>;
          })}
          {hostCard.more ? <button type="button" style={{ ...rowButton, color: 'var(--accent)', fontSize: 12 }} onClick={() => onOpenLink(hostCard.more!.label, hostCard.more!.href)}>{hostCard.more.label}</button> : null}
        </div>
      ))}
    </section>
  );
}
