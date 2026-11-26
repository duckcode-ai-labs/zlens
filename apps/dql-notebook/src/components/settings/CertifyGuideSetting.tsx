import React, { useEffect, useState } from 'react';
import type { Theme } from '../../themes/notebook-theme';
import { CERTIFY_GOAL, CERTIFY_GUIDE_CHANGED_EVENT, certifyGuideDismissed, setCertifyGuideDismissed } from '../home/certify-first';

/**
 * Settings » Appearance: the certify-first guide on Ask's home. Dismissed from
 * the card, it comes back only from here (kept in this browser, like the theme).
 */
export function CertifyGuideSetting({ t }: { t: Theme }) {
  const [dismissed, setDismissed] = useState(() => certifyGuideDismissed());
  useEffect(() => {
    const changed = () => setDismissed(certifyGuideDismissed());
    window.addEventListener(CERTIFY_GUIDE_CHANGED_EVENT, changed);
    return () => window.removeEventListener(CERTIFY_GUIDE_CHANGED_EVENT, changed);
  }, []);
  return <CertifyGuideSettingView t={t} dismissed={dismissed} onChange={(next) => { setCertifyGuideDismissed(next); setDismissed(next); }} />;
}

/** The setting itself, without storage: what a test renders. */
export function CertifyGuideSettingView({ t, dismissed, onChange }: { t: Theme; dismissed: boolean; onChange: (dismissed: boolean) => void }) {
  return (
    <section aria-label="Certify guide" data-testid="certify-guide-setting" style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8, paddingTop: 16, borderTop: '1px solid var(--border-subtle)' }}>
      <div>
        <div style={{ fontSize: 14, fontWeight: 700, color: t.textPrimary }}>Certify guide</div>
        <div style={{ fontSize: 12.5, color: t.textMuted, marginTop: 3, lineHeight: 1.5 }}>
          The card on Ask&apos;s home that leads you to certify your {CERTIFY_GOAL} most-asked questions. It shows while fewer than {CERTIFY_GOAL} saved queries are certified.
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span role="status" style={{ fontSize: 12.5, color: t.textSecondary }}>{dismissed ? 'Dismissed in this browser.' : 'Shown on Ask’s home.'}</span>
        <button
          type="button"
          onClick={() => onChange(!dismissed)}
          style={{ padding: '6px 12px', borderRadius: 8, border: `1px solid ${dismissed ? t.accent : 'var(--border-default)'}`, background: dismissed ? t.accent : t.cellBg, color: dismissed ? 'var(--accent-fg)' : t.textPrimary, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: t.font }}
        >
          {dismissed ? 'Show it again' : 'Hide it'}
        </button>
      </div>
    </section>
  );
}
