import { useEffect, useState } from 'react';
import { AlertTriangle, Check, Copy, KeyRound, Link2, ShieldCheck, X } from 'lucide-react';
import { certifiedDateLabel } from '@zlens/core/apps/reader-trust';
import { api, type CertificationByline, type JoinCertifyReview } from '../../../api/client';
import { useHostUi } from '../../../host/host-ui';
import { certifyWords } from './certify-words';
import { messageOf } from './studio-ui';

type ReviewLoader = (sourceId: string, joinId: string) => Promise<{ ok: boolean; review?: JoinCertifyReview; error?: string }>;
type Certifier = (sourceId: string, joinId: string) => Promise<{ ok: boolean; certification?: CertificationByline; blockers?: string[]; error?: string }>;

/**
 * The short review before certifying a join (T4), opened from the publish
 * dialog's not-certified list or the Data list's ⋯ menu — never a detour to
 * Modeling: the keys, "each order has one location — checked on N rows" from
 * a check run just now, what would double-count if the join were wrong, and
 * the grain and key columns certifying fills in the model from those checks.
 * Then one button, "I vouch for this join — certify". The server checks again
 * and writes through Modeling's own path, so Modeling shows it certified; a
 * check that fails says why and nothing is written.
 */
export function CertifyJoinDialog({
  sourceId,
  joinId,
  name,
  onClose,
  onCertified,
  initialReview,
  loadReview,
  certify,
}: {
  sourceId: string;
  joinId: string;
  /** "Orders → Location", shown while the review loads. */
  name?: string;
  onClose: () => void;
  onCertified: (sourceId: string, joinId: string, certification: CertificationByline | undefined) => void;
  /** The review to show before (or instead of) loading it (tests). */
  initialReview?: JoinCertifyReview;
  loadReview?: ReviewLoader;
  certify?: Certifier;
}): JSX.Element {
  const [review, setReview] = useState<JoinCertifyReview | null>(initialReview ?? null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ message: string; blockers: string[] } | null>(null);
  // Under a host where certifying only proposes certification, every word says "propose" (the check and what is written stay).
  const words = certifyWords(useHostUi()).join;

  useEffect(() => {
    if (initialReview) return undefined;
    let active = true;
    void (loadReview ?? ((source, join) => api.getJoinCertifyReview(source, join)))(sourceId, joinId).then((response) => {
      if (!active) return;
      if (response.ok && response.review) setReview(response.review);
      else setLoadError(response.error ?? 'ZLens could not check this join.');
    }).catch((cause) => { if (active) setLoadError(messageOf(cause)); });
    return () => { active = false; };
  }, [sourceId, joinId, initialReview, loadReview]);
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape' && !saving) onClose(); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onClose, saving]);

  const vouch = () => {
    if (!review) return;
    setSaving(true);
    setError(null);
    void (certify ?? ((source, join) => api.certifyAppJoin(source, join)))(review.sourceId, review.joinId).then((response) => {
      setSaving(false);
      if (!response.ok) {
        setError({ message: response.error ?? words.couldNot, blockers: response.blockers ?? [] });
        return;
      }
      onCertified(review.sourceId, review.joinId, response.certification);
    }).catch((cause) => {
      setSaving(false);
      setError({ message: messageOf(cause), blockers: [] });
    });
  };

  const title = review?.name ?? name ?? 'this join';
  const changedOn = certifiedDateLabel(review?.previousCertification?.at);
  return (
    <div className="proposal-scrim certify-review-scrim" role="dialog" aria-modal="true" aria-labelledby="certify-join-title">
      <section className="table-dataset-card certify-review-card">
        <header>
          <span className="table-dataset-icon"><Link2 size={17} aria-hidden="true" /></span>
          <div>
            <h2 id="certify-join-title">{words.heading(title)}</h2>
            <p>{words.intro}</p>
          </div>
          <button type="button" className="icon" onClick={onClose} disabled={saving} aria-label="Close"><X size={15} /></button>
        </header>
        <div className="table-dataset-body">
          {!review && !loadError ? <p className="table-dataset-muted" role="status">Checking the join on the data…</p> : null}
          {loadError ? <p className="table-dataset-error" role="alert">{loadError}</p> : null}
          {review ? <>
            {changedOn ? <p className="certify-review-who">Changed since it was certified on {changedOn}.</p> : null}
            <section className="certify-review-part" aria-label="The keys">
              <h3><KeyRound size={13} aria-hidden="true" /> The keys</h3>
              <p>{review.keysSentence}</p>
            </section>
            <section className="certify-review-part" aria-label="The check">
              <h3><ShieldCheck size={13} aria-hidden="true" /> Checked just now</h3>
              {review.checkedSentence ? <p className="certify-review-ok"><Check size={13} aria-hidden="true" /> {review.checkedSentence}</p> : null}
              {review.checkLines.length ? <ul>{review.checkLines.map((line) => <li key={line}>{line}</li>)}</ul> : null}
            </section>
            <section className="certify-review-part" aria-label="What would double-count">
              <h3><Copy size={13} aria-hidden="true" /> What would double-count if it were wrong</h3>
              <p>{review.doubleCount}</p>
            </section>
            {review.fills.length ? <section className="certify-review-part" aria-label="Filled in the model">
              <h3><Check size={13} aria-hidden="true" /> Filled in the model from these checks</h3>
              <ul>{review.fills.map((fill) => <li key={`${fill.side}:${fill.table}`} className="certify-review-fill">{fill.table}: one row per {fill.grain}{fill.keys.join(', ') !== fill.grain ? ` (key ${fill.keys.join(', ')})` : ''}<small>{fill.because}</small></li>)}</ul>
            </section> : null}
            {review.blockers.length ? <div className="table-dataset-error" role="alert"><p><AlertTriangle size={13} aria-hidden="true" /> Not certified:</p><ul>{review.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul></div> : null}
            {error ? <div className="table-dataset-error" role="alert"><p>{error.message}</p>{error.blockers.length ? <ul>{error.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul> : null}</div> : null}
          </> : null}
        </div>
        <footer>
          <button type="button" onClick={onClose} disabled={saving}>Not now</button>
          {review ? <small>{words.record}</small> : <span />}
          {review ? <button type="button" className="primary" disabled={saving || !review.canVouch} onClick={vouch}>{saving ? words.saving : words.button}</button> : null}
        </footer>
      </section>
    </div>
  );
}
