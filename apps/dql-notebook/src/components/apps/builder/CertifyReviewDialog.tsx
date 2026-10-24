import { useEffect, useState } from 'react';
import { AlertTriangle, Check, Copy, Hash, Link2, ListChecks, Play, ShieldCheck, Table2, UserRound, X } from 'lucide-react';
import { api, type CertificationByline, type CertifyReview } from '../../../api/client';
import { checkedByLabel } from './app-data';
import { certifiedDateLabel } from '@zlens/core/apps/reader-trust';
import { humanize, messageOf } from './studio-ui';

type ReviewLoader = (sourceId: string) => Promise<{ ok: boolean; review?: CertifyReview; error?: string }>;
type Certifier = (sourceId: string, sourceRevision?: string, owner?: string) => Promise<{ ok: boolean; certification?: CertificationByline; sourceRevision?: string; blockers?: string[]; error?: string }>;

/**
 * Whether "I vouch for this — certify" may be pressed, and the owner it
 * sends: a review that can be vouched for (data, or a saved query ZLens ran
 * here), whose row key check did not fail, and — for a saved query nobody
 * owns yet — with an owner typed in (T4).
 */
export function certifyReviewVouch(review: CertifyReview | null, owner: string): { enabled: boolean; owner?: string } {
  if (!review) return { enabled: false };
  const savedQuery = review.kind === 'saved_query' ? review.savedQuery : undefined;
  const vouchable = review.kind === 'dataset' || Boolean(savedQuery);
  const keyFailed = Boolean(review.keyCheck && !review.keyCheck.ok);
  const named = owner.trim();
  const ownerMissing = Boolean(savedQuery?.ownerRequired && !named);
  return {
    enabled: vouchable && review.canVouch && !keyFailed && !ownerMissing,
    ...(savedQuery?.ownerRequired && named ? { owner: named } : {}),
  };
}

/**
 * The short review before certifying data on purpose (design Q1). "Check and
 * use" left it checked, **Not certified yet**; certifying is a separate step,
 * opened from the publish check or the Data list's ⋯ menu: what one row is,
 * the row key checked again now, number formats (cents read as dollars),
 * joins used, columns hidden as duplicates — then one button, "I vouch for
 * this — certify". The server runs the same certification rules as Block
 * Studio's Certify; with a host, only people who may certify can.
 *
 * A saved query certifies here too (T4): it runs and its tests run now, who
 * owns it (asked for, and written, when nobody is named) and what one row is.
 * The saved query editor stays one small link away.
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
  const [owner, setOwner] = useState('');

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
    void (certify ?? ((id, revision, named) => api.certifyAppData(id, revision, named)))(review.sourceId, review.sourceRevision, certifyReviewVouch(review, owner).owner).then((response) => {
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
  const savedQuery = review?.kind === 'saved_query' ? review.savedQuery : undefined;
  const vouchable = review?.kind === 'dataset' || Boolean(savedQuery);
  const canVouchNow = certifyReviewVouch(review, owner).enabled;
  const changedOn = review && !review.certified ? certifiedDateLabel(review.previousCertification?.at) : undefined;
  return (
    <div className="proposal-scrim certify-review-scrim" role="dialog" aria-modal="true" aria-labelledby="certify-review-title">
      <section className="table-dataset-card certify-review-card">
        <header>
          <span className="table-dataset-icon"><ShieldCheck size={17} aria-hidden="true" /></span>
          <div>
            <h2 id="certify-review-title">Certify {title}</h2>
            <p>{review?.kind === 'saved_query' && !savedQuery
              ? 'A saved query ZLens cannot run here is certified in the saved query editor.'
              : review?.kind === 'metrics'
                ? 'Metrics come from your semantic model and are certified there.'
                : 'A short review. Certifying says you looked at it and vouch for these numbers.'}</p>
          </div>
          <button type="button" className="icon" onClick={onClose} disabled={saving} aria-label="Close"><X size={15} /></button>
        </header>
        <div className="table-dataset-body">
          {!review && !loadError ? <p className="table-dataset-muted" role="status">Checking {title} again…</p> : null}
          {loadError ? <p className="table-dataset-error" role="alert">{loadError}</p> : null}
          {review ? <>
            {changedOn ? <p className="certify-review-who">Changed since it was certified on {changedOn}.</p> : null}
            {review.check ? <p className="certify-review-who">{checkedByLabel(review.check)}</p> : null}
            {savedQuery ? <>
              <section className="certify-review-part" aria-label="It runs">
                <h3><Play size={13} aria-hidden="true" /> It runs</h3>
                {savedQuery.runs.ok
                  ? <p className="certify-review-ok"><Check size={13} aria-hidden="true" /> {savedQuery.runs.sentence}</p>
                  : <p className="table-dataset-error" role="alert"><AlertTriangle size={13} aria-hidden="true" /> {savedQuery.runs.error}</p>}
              </section>
              <section className="certify-review-part" aria-label="Its tests pass">
                <h3><ListChecks size={13} aria-hidden="true" /> Its tests pass</h3>
                <p>{savedQuery.testsSentence}</p>
                {savedQuery.tests.length ? <ul>{savedQuery.tests.map((test) => <li key={test.name} className={test.passed ? 'certify-review-ok' : 'table-dataset-error'}>{test.passed ? <Check size={12} aria-hidden="true" /> : <AlertTriangle size={12} aria-hidden="true" />} {test.name}{test.passed ? ' · passed' : ` · failed${test.error ? `: ${test.error}` : ''}`}</li>)}</ul> : null}
              </section>
              <section className="certify-review-part" aria-label="Who owns it">
                <h3><UserRound size={13} aria-hidden="true" /> Who owns it</h3>
                {savedQuery.ownerRequired
                  ? <label className="certify-review-owner">
                    <span>Nobody owns it yet. Name the person or team who answers for these numbers; ZLens writes it into the saved query when you certify.</span>
                    <input value={owner} onChange={(event) => setOwner(event.target.value)} placeholder="Owner, e.g. Maria Lopez or Sales analytics" aria-label="Owner" maxLength={120} disabled={saving} />
                  </label>
                  : <p>{savedQuery.owner}</p>}
              </section>
              <section className="certify-review-part" aria-label="What one row is">
                <h3><Table2 size={13} aria-hidden="true" /> What one row is</h3>
                <p>{savedQuery.row ?? 'Not known: it declares no grain or grouping columns.'}</p>
              </section>
              {savedQuery.blockers.length ? <div className="table-dataset-error" role="alert"><p>Not ready to certify:</p><ul>{savedQuery.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul></div> : null}
            </> : null}
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
                {review.numbers.length ? <ul>{review.numbers.map((number) => <li key={number.name}><strong>{humanize(number.name)}</strong>: {number.format}{number.note ? ` · ${number.note}` : ''}</li>)}</ul> : <p className="table-dataset-muted">No numbers.</p>}
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
          {vouchable ? <small>ZLens records you as the person who certified it, with the date and what was checked.{review?.kind === 'saved_query' && review.blockStudioPath && onOpenBlockStudio ? <> <button type="button" className="link certify-review-editor-link" onClick={() => onOpenBlockStudio(review.blockStudioPath!)} disabled={saving}>Open in the saved query editor</button></> : null}</small> : <span />}
          {vouchable
            ? <button type="button" className="primary" disabled={saving || !canVouchNow} onClick={vouch}>{saving ? 'Certifying…' : 'I vouch for this — certify'}</button>
            : review?.kind === 'saved_query' && review.blockStudioPath && onOpenBlockStudio
              ? <button type="button" className="primary" onClick={() => onOpenBlockStudio(review.blockStudioPath!)}>Open in the saved query editor</button>
              : null}
        </footer>
      </section>
    </div>
  );
}
