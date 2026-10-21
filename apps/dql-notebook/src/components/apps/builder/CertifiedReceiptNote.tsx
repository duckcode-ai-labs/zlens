import { ShieldCheck } from 'lucide-react';
import type { CertificationByline } from '../../../api/client';
import { certifiedByLabel, plainCertificationChecks } from '../reader-trust';

/**
 * What "Certify and use this data" (and "Make row-level") leaves behind
 * (D5): who certified it and when, and the checks that passed, in plain words.
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
