import { ShieldCheck, SearchCheck } from 'lucide-react';
import type { CertificationByline } from '../../../api/client';
import { certifiedByLabel, plainCertificationChecks } from '../reader-trust';
import { CHECKED_NEEDS_CERTIFYING, checkedByLabel } from './app-data';

/**
 * What "Check and use" (and "Make row-level") leaves behind (design Q1):
 * the data is checked, not certified (T1: it reads "Not certified yet"). Who
 * checked it and when, what the check found, and that certifying it is a
 * separate, deliberate step.
 */
export function CheckedReceiptNote({ name, check }: { name?: string; check: CertificationByline }): JSX.Element {
  const checks = plainCertificationChecks(check.checks);
  return (
    <div className="certified-receipt-note checked" role="status">
      <SearchCheck size={15} aria-hidden="true" />
      <div>
        <strong>{name ? `${name} · ` : ''}{CHECKED_NEEDS_CERTIFYING}</strong>
        <small>{checkedByLabel(check)}, not certified yet. Build tiles now; certify it when you are ready.</small>
        {checks.length ? (
          <>
            <small>What the check found</small>
            <ul aria-label="What the check found">{checks.map((line) => <li key={line}>{line}</li>)}</ul>
          </>
        ) : null}
      </div>
    </div>
  );
}

/**
 * What "I vouch for this — certify" leaves behind (D5, design Q1): who
 * certified it and when, and the checks that passed, in plain words.
 */
export function CertifiedReceiptNote({ name, certification }: { name?: string; certification: CertificationByline }): JSX.Element {
  const checks = plainCertificationChecks(certification.checks);
  return (
    <div className="certified-receipt-note" role="status">
      <ShieldCheck size={15} aria-hidden="true" />
      <div>
        <strong>{name ? `${name} · ` : ''}{certifiedByLabel(certification)}</strong>
        {checks.length ? (
          <>
            <small>Checks passed</small>
            <ul aria-label="Checks passed">{checks.map((check) => <li key={check}>{check}</li>)}</ul>
          </>
        ) : null}
      </div>
    </div>
  );
}
