import { useEffect, useState } from 'react';
import { AlertTriangle, Check, Copy, Hash, Link2, ShieldCheck, Table2, X } from 'lucide-react';
import { api, type CertificationByline, type CertifyReview } from '../../../api/client';
import { checkedByLabel } from './app-data';
import { humanize, messageOf } from './studio-ui';

type ReviewLoader = (sourceId: string) => Promise<{ ok: boolean; review?: CertifyReview; error?: string }>;
type Certifier = (sourceId: string, sourceRevision?: string) => Promise<{ ok: boolean; certification?: CertificationByline; sourceRevision?: string; blockers?: string[]; error?: string }>;

/**
 * The short review before certifying data on purpose (design Q1). "Check and
 * use" left it **Checked · Needs certifying**; certifying is a separate step,
 * opened from the publish check or the Data list's ⋯ menu: what one row is,
 * the row key checked again now, number formats (cents read as dollars),
 * joins used, columns hidden as duplicates — then one button, "I vouch for
 * this — certify". The server runs the same certification rules as Block
 * Studio's Certify; with a host, only people who may certify can.
 * A saved query without a row-level definition certifies in Block Studio.
 */
export function CertifyReviewDialog({
  sourceId,
  name,
  onClose,
  onCertified,
  onOpenBlockStudio,
  initialReview,
  loadReview,
  certify,
}: {
  sourceId: string;
  name?: string;
  onClose: () => void;
  /** Certified: who certified it and its new revision come back with it. */
  onCertified: (sourceId: string, certification: CertificationByline | undefined) => void;
  /** Open a saved query in Block Studio, where saved queries certify. */
  onOpenBlockStudio?: (path: string) => void;
  /** The review to show before (or instead of) loading it (tests). */
  initialReview?: CertifyReview;
  loadReview?: ReviewLoader;
  certify?: Certifier;
}): JSX.Element {
  const [review, setReview] = useState<CertifyReview | null>(initialReview ?? null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ message: string; blockers: string[] } | null>(null);

  useEffect(() => {
    if (initialReview) return undefined;
    let active = true;
    void (loadReview ?? ((id) => api.getCertifyReview(id)))(sourceId).then((response) => {
      if (!active) return;
      if (response.ok && response.review) setReview(response.review);
      else setLoadError(response.error ?? 'ZLens could not read this data.');
    }).catch((cause) => { if (active) setLoadError(messageOf(cause)); });
    return () => { active = false; };
  }, [sourceId, initialReview, loadReview]);
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape' && !saving) onClose(); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onClose, saving]);

  const vouch = () => {
    if (!review) return;
    setSaving(true);
    setError(null);
    void (certify ?? ((id, revision) => api.certifyAppData(id, revision)))(review.sourceId, review.sourceRevision).then((response) => {
      setSaving(false);
      if (!response.ok) {
        setError({ message: response.error ?? 'ZLens could not certify this data.', blockers: response.blockers ?? [] });
        return;
      }
      onCertified(review.sourceId, response.certification);
    }).catch((cause) => {
      setSaving(false);
      setError({ message: messageOf(cause), blockers: [] });
    });
  };

  const title = humanize(review?.name ?? name ?? 'this data');
  const keyFailed = review?.keyCheck && !review.keyCheck.ok;
  return (
    <div className="proposal-scrim certify-review-scrim" role="dialog" aria-modal="true" aria-labelledby="certify-review-title">
      <section className="table-dataset-card certify-review-card">
        <header>
          <span className="table-dataset-icon"><ShieldCheck size={17} aria-hidden="true" /></span>
          <div>
            <h2 id="certify-review-title">Certify {title}</h2>
            <p>{review?.kind === 'saved_query'
              ? 'A saved query is certified in Block Studio, where its tests run.'
              : review?.kind === 'metrics'
                ? 'Metrics come from your semantic model and are governed there.'
                : 'A short review. Certifying says you looked at it and vouch for these numbers.'}</p>
          </div>
          <button type="button" className="icon" onClick={onClose} disabled={saving} aria-label="Close"><X size={15} /></button>
        </header>
        <div className="table-dataset-body">
          {!review && !loadError ? <p className="table-dataset-muted" role="status">Checking {title} again…</p> : null}
          {loadError ? <p className="table-dataset-error" role="alert">{loadError}</p> : null}
          {review ? <>
            {review.check ? <p className="certify-review-who">{checkedByLabel(review.check)}</p> : null}
            {review.kind === 'dataset' ? <>
              <section className="certify-review-part" aria-label="What one row is">
                <h3><Table2 size={13} aria-hidden="true" /> What one row is</h3>
                <p>{review.row ?? 'ZLens does not know what one row is yet.'}</p>
                {review.keyCheck ? (
                  review.keyCheck.ok
                    ? <p className="certify-review-ok"><Check size={13} aria-hidden="true" /> {review.keyCheck.sentence}</p>
                    : <p className="table-dataset-error" role="alert"><AlertTriangle size={13} aria-hidden="true" /> {review.keyCheck.error}</p>
                ) : null}
              </section>
              <section className="certify-review-part" aria-label="Number formats">
                <h3><Hash size={13} aria-hidden="true" /> Number formats</h3>
                {review.numbers.length ? <ul>{review.numbers.map((number) => <li key={number.name}><strong>{number.label}</strong>: {number.format}{number.note ? ` · ${number.note}` : ''}</li>)}</ul> : <p className="table-dataset-muted">No numbers.</p>}
              </section>
              <section className="certify-review-part" aria-label="Joins used">
                <h3><Link2 size={13} aria-hidden="true" /> Joins used</h3>
                {review.joins.length ? <ul>{review.joins.map((join) => <li key={join.label}>{join.sentence}{join.trust === 'certified' ? '' : ' · this join is not certified yet'}</li>)}</ul> : <p className="table-dataset-muted">No joins to other tables.</p>}
              </section>
              <section className="certify-review-part" aria-label="Columns hidden as duplicates">
                <h3><Copy size={13} aria-hidden="true" /> Columns hidden as duplicates</h3>
                {review.hiddenColumns.length ? <ul>{review.hiddenColumns.map((entry) => <li key={entry.column}>{entry.reason}</li>)}</ul> : <p className="table-dataset-muted">None.</p>}
              </section>
            </> : null}
            {error ? <div className="table-dataset-error" role="alert"><p>{error.message}</p>{error.blockers.length ? <ul>{error.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul> : null}</div> : null}
          </> : null}
        </div>
        <footer>
          <button type="button" onClick={onClose} disabled={saving}>Not now</button>
          {review?.kind === 'dataset' ? <small>ZLens records you as the person who certified it, with the date and what was checked.</small> : <span />}
          {review?.kind === 'dataset'
            ? <button type="button" className="primary" disabled={saving || !review.canVouch || Boolean(keyFailed)} onClick={vouch}>{saving ? 'Certifying…' : 'I vouch for this — certify'}</button>
            : review?.kind === 'saved_query' && review.blockStudioPath && onOpenBlockStudio
              ? <button type="button" className="primary" onClick={() => onOpenBlockStudio(review.blockStudioPath!)}>Open in Block Studio</button>
              : null}
        </footer>
      </section>
    </div>
  );
}
