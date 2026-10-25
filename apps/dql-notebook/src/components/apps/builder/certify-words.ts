import { hostProposesCertification, type HostUiState } from '../../../host/host-ui';

/**
 * The App Studio's certify words in one place: the short review's heading and
 * button, the Data list's ⋯ menu, and the publish check's "Certify now".
 *
 * Under a host that says `certification: 'proposes'` (RFC 0010 HH-9), pressing
 * the button does not certify: the host certifies through its own review (a
 * creator's change becomes a pull request a steward certifies), so every word
 * a person reads says "propose" instead. Without a host, or when the host does
 * not set it, the words are the single-user notebook's own, unchanged. Only
 * the words change: what is checked and written stays the same.
 */
export interface CertifyWords {
  /** Whether certifying here only proposes certification. */
  proposes: boolean;
  /** The short review of data or a saved query (design Q1, T4). */
  review: {
    heading: (title: string) => string;
    intro: string;
    button: string;
    saving: string;
    /** The footer's small print beside the button. */
    record: string;
    /** Above a saved query's blockers. */
    notReady: string;
    /** Asking for a saved query's owner when nobody is named. */
    ownerAsk: string;
    couldNot: string;
  };
  /** The short review of a join (T4). */
  join: {
    heading: (title: string) => string;
    intro: string;
    button: string;
    saving: string;
    record: string;
    couldNot: string;
  };
  /** The Data list's and Add data's ⋯ menus. */
  menu: {
    certify: string;
    certifyHint: string;
    join: (label: string) => string;
    joinHint: (sentence: string) => string;
  };
  /** The publish check's tiles not certified yet. */
  publish: {
    recommended: string;
    now: string;
    nowAria: (name: string) => string;
    join: string;
    joinAria: (title: string) => string;
  };
}

const CERTIFIES: CertifyWords = {
  proposes: false,
  review: {
    heading: (title) => `Certify ${title}`,
    intro: 'A short review. Certifying says you looked at it and vouch for these numbers.',
    button: 'I vouch for this — certify',
    saving: 'Certifying…',
    record: 'ZLens records you as the person who certified it, with the date and what was checked.',
    notReady: 'Not ready to certify:',
    ownerAsk: 'Nobody owns it yet. Name the person or team who answers for these numbers; ZLens writes it into the saved query when you certify.',
    couldNot: 'ZLens could not certify this data.',
  },
  join: {
    heading: (title) => `Certify the join ${title}`,
    intro: 'A short review, here. Certifying says you checked how these tables join and vouch for it.',
    button: 'I vouch for this join — certify',
    saving: 'Certifying…',
    record: 'ZLens records you as the person who certified it, with the date and the check; Modeling shows it certified.',
    couldNot: 'ZLens could not certify this join.',
  },
  menu: {
    certify: 'Certify…',
    certifyHint: 'A short review, then “I vouch for this — certify”.',
    join: (label) => `Certify the join to ${label}…`,
    joinHint: (sentence) => `${sentence}: a fresh check, then “I vouch for this join — certify”.`,
  },
  publish: {
    recommended: 'Readers see “Not certified yet” on these tiles. Certifying is recommended, not required.',
    now: 'Certify now (recommended)',
    nowAria: (name) => `Certify now: ${name}`,
    join: 'Certify this join (recommended)',
    joinAria: (title) => `Certify the join for ${title}`,
  },
};

const PROPOSES: CertifyWords = {
  proposes: true,
  review: {
    heading: (title) => `Propose ${title} for certification`,
    intro: 'A short review. Proposing says you looked at it and vouch for these numbers; a steward certifies it through review.',
    button: 'Propose for certification',
    saving: 'Proposing…',
    record: 'ZLens records you as the person who proposed it, with the date and what was checked; a steward certifies it through review.',
    notReady: 'Not ready to propose:',
    ownerAsk: 'Nobody owns it yet. Name the person or team who answers for these numbers; ZLens writes it into the saved query when you propose it.',
    couldNot: 'ZLens could not propose this data.',
  },
  join: {
    heading: (title) => `Propose the join ${title} for certification`,
    intro: 'A short review, here. Proposing says you checked how these tables join and vouch for it; a steward certifies it through review.',
    button: 'Propose this join for certification',
    saving: 'Proposing…',
    record: 'ZLens records you as the person who proposed it, with the date and the check; a steward certifies it through review.',
    couldNot: 'ZLens could not propose this join.',
  },
  menu: {
    certify: 'Propose certification…',
    certifyHint: 'A short review, then “Propose for certification”.',
    join: (label) => `Propose certification of the join to ${label}…`,
    joinHint: (sentence) => `${sentence}: a fresh check, then “Propose this join for certification”.`,
  },
  publish: {
    recommended: 'Readers see “Not certified yet” on these tiles. Proposing certification is recommended, not required.',
    now: 'Propose certification now (recommended)',
    nowAria: (name) => `Propose certification now: ${name}`,
    join: 'Propose this join for certification (recommended)',
    joinAria: (title) => `Propose the join for ${title}`,
  },
};

/** The certify words for this host state: "propose" under a host whose `certification` is `proposes`, else "certify". */
export function certifyWords(state: HostUiState): CertifyWords {
  return hostProposesCertification(state) ? PROPOSES : CERTIFIES;
}
