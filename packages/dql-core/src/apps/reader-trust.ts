/**
 * One trust vocabulary for App readers (RFC 0008 step 6). Every data tile
 * shows exactly one of four states, worked out from the governed run
 * evidence the server returned, never from the tile's own claims alone:
 *
 * - certified: a certified source ran exactly as reviewed
 * - governed:  a governed semantic query (metrics and dimensions from the
 *              model), or a checked calculation over certified measures;
 *              not individually certified
 * - review:    not certified yet, adapted, out of date, or AI-generated
 * - blocked:   governance or the source stopped this tile from showing data
 *
 * Shared by the reader, signed snapshots and scheduled digests (step 10), so
 * a page says the same thing wherever it is read. Pure: no I/O.
 */
export type ReaderTrustState = 'certified' | 'governed' | 'review' | 'blocked';

export interface ReaderTrust {
  state: ReaderTrustState;
  label: string;
  /** One sentence a reader can act on. */
  detail: string;
  /**
   * Who certified the data and when, for a certified tile: "Certified by
   * Kranthi · 21 Oct", or "Certified · 21 Oct" when no person was recorded.
   * Absent for every other state.
   */
  byline?: string;
  /** The checks that passed when it was certified, in plain words. */
  checks?: string[];
}

/**
 * The certification receipt a run tile, a Data list row or a block carries:
 * who certified it (`by` is the recorded identity, `name` the display name
 * when one was recorded), when, and which checks passed. Old certifications
 * may have no person (`by` missing or "local") or no date.
 */
export interface CertificationByline {
  by?: string | null;
  name?: string | null;
  at?: string | null;
  checks?: ReadonlyArray<string> | null;
}

/** The parts of a layout item trust depends on. */
export interface ReaderTrustItem {
  text?: unknown;
  block?: unknown;
  semantic?: unknown;
  query?: unknown;
  aiPin?: unknown;
  draftAnalysis?: unknown;
}

/** The parts of a run tile trust depends on. */
export interface ReaderTrustTile {
  status: string;
  tileType?: string;
  repair?: unknown;
  aiPin?: { certification?: string; reviewStatus?: string } | null;
  dataset?: {
    trust?: string;
    validation?: { outcome?: string } | null;
    /** Joins to related tables the tile used (design D2), in plain words. */
    joins?: Array<{ trust?: string; sentence?: string }> | null;
  } | null;
  artifact?: { trustState?: string; sourceKind?: string } | null;
  certificationStatus?: string | null;
  trustState?: string;
  /** Who certified the source behind this tile, and when (D5). */
  certification?: CertificationByline | null;
}

export const READER_TRUST_LABELS: Record<ReaderTrustState, string> = {
  certified: 'Certified',
  governed: 'Governed',
  review: 'Needs review',
  blocked: 'Blocked',
};

const trust = (state: ReaderTrustState, detail: string): ReaderTrust => ({ state, label: READER_TRUST_LABELS[state], detail });

/** Identities that name no person: a receipt written before ZLens knew who was certifying. */
const ANONYMOUS_CERTIFIERS = new Set(['local', 'guest@local', 'owner@local', 'unknown', 'anonymous']);

/**
 * The name to show for a certifier. A recorded display name wins. Otherwise an
 * email is shortened to its name part ("maria.lopez@acme.com" → "Maria Lopez",
 * a GitHub noreply address loses its number), and a placeholder identity
 * ("local") names nobody.
 */
export function certifierDisplayName(by?: string | null, name?: string | null): string | undefined {
  const display = name?.trim();
  if (display && !ANONYMOUS_CERTIFIERS.has(display.toLowerCase())) return display;
  const identity = by?.trim();
  if (!identity || ANONYMOUS_CERTIFIERS.has(identity.toLowerCase())) return undefined;
  const at = identity.indexOf('@');
  if (at <= 0) return identity;
  const local = identity.slice(0, at).replace(/^\d+\+/, '');
  const words = local.split(/[._-]+/).filter(Boolean);
  if (!words.length) return undefined;
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "21 Oct", with the year when it is not this year ("21 Oct 2025"); undefined for no or a bad date. */
export function certifiedDateLabel(at?: string | null, now: Date = new Date()): string | undefined {
  if (!at) return undefined;
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return undefined;
  const day = `${date.getDate()} ${MONTHS[date.getMonth()]}`;
  return date.getFullYear() === now.getFullYear() ? day : `${day} ${date.getFullYear()}`;
}

/**
 * The one way every surface says who certified something and when (D5):
 * "Certified by Kranthi · 21 Oct". Without a recorded person it is
 * "Certified · 21 Oct", and with neither just "Certified".
 */
export function certifiedByLabel(receipt: CertificationByline | null | undefined, now: Date = new Date()): string {
  const who = certifierDisplayName(receipt?.by, receipt?.name);
  const when = certifiedDateLabel(receipt?.at, now);
  return [who ? `Certified by ${who}` : 'Certified', when].filter(Boolean).join(' · ');
}

const PLAIN_CHECKS: Record<string, string> = {
  metadata: 'Has an owner and a description',
  validation: 'The definition is valid',
  run: 'Ran without errors',
  tests: 'Its tests passed',
  chart: 'Has a chart set up',
  lineage: 'Its sources are traced',
  'ai-reviewed': 'No unreviewed AI-written content',
};

/**
 * The checks a certification passed, in plain words. Receipts record the
 * Certify checklist by name ("run", "tests") and, for data checked from a
 * table, full sentences ("Row key: …"); names are translated, sentences kept.
 */
export function plainCertificationChecks(checks: ReadonlyArray<string> | null | undefined): string[] {
  const out: string[] = [];
  for (const check of checks ?? []) {
    const text = PLAIN_CHECKS[check.trim().toLowerCase()] ?? check.trim();
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

/**
 * One line for the certifications behind several tiles (the App header):
 * every certifier named once, and the most recent date. "Certified by
 * Kranthi · 21 Oct", "Certified by Kranthi and Maria · 21 Oct", "Certified
 * by Kranthi and 2 others · 21 Oct"; undefined when nothing was certified.
 */
export function certifiedByAcross(receipts: ReadonlyArray<CertificationByline | null | undefined>, now: Date = new Date()): string | undefined {
  const present = receipts.filter((receipt): receipt is CertificationByline => Boolean(receipt));
  if (!present.length) return undefined;
  const names: string[] = [];
  for (const receipt of present) {
    const name = certifierDisplayName(receipt.by, receipt.name);
    if (name && !names.includes(name)) names.push(name);
  }
  const latest = present
    .map((receipt) => (receipt.at ? new Date(receipt.at) : null))
    .filter((date): date is Date => Boolean(date) && !Number.isNaN(date!.getTime()))
    .sort((left, right) => right.getTime() - left.getTime())[0];
  const who = names.length === 0 ? '' : names.length === 1 ? names[0] : names.length === 2 ? `${names[0]} and ${names[1]}` : `${names[0]} and ${names.length - 1} others`;
  const when = latest ? certifiedDateLabel(latest.toISOString(), now) : undefined;
  return [who ? `Certified by ${who}` : 'Certified', when].filter(Boolean).join(' · ');
}

/** A certified trust with who certified it and the checks that passed. */
function certifiedTrust(detail: string, receipt: CertificationByline | null | undefined): ReaderTrust {
  const base = trust('certified', detail);
  const checks = plainCertificationChecks(receipt?.checks);
  return {
    ...base,
    byline: certifiedByLabel(receipt),
    ...(checks.length ? { checks } : {}),
  };
}

/** Text and heading tiles carry no data, so they carry no trust label. */
export function isDataTileForTrust(item: ReaderTrustItem, tile?: Pick<ReaderTrustTile, 'tileType'>): boolean {
  if (item.text || tile?.tileType === 'text') return false;
  return Boolean(tile || item.block || item.semantic || item.query || item.aiPin || item.draftAnalysis);
}

export function readerTileTrust(item: ReaderTrustItem, tile?: ReaderTrustTile): ReaderTrust | null {
  if (!isDataTileForTrust(item, tile)) return null;
  if (!tile) return null;
  if (tile.status === 'unauthorized') return trust('blocked', 'You do not have access to this data.');
  if (tile.status === 'unresolved') return trust('blocked', 'This tile’s source could not be found in the project.');
  if (tile.status === 'error') return trust('blocked', 'This tile could not run with the current source and filters.');
  if (tile.status === 'stale') return trust('review', 'This result is out of date; refresh the page.');
  if (tile.repair) return trust('review', 'This tile was repaired automatically and needs a person to check it.');

  if (tile.aiPin || item.aiPin) {
    const pin = tile.aiPin;
    return pin?.certification === 'certified' || pin?.reviewStatus === 'certified'
      ? certifiedTrust('An AI answer that a person reviewed and certified.', tile.certification)
      : trust('review', 'An AI answer that nobody has reviewed yet.');
  }

  const dataset = tile.dataset;
  if (dataset) {
    const outcome = dataset.validation?.outcome;
    if (outcome === 'rejected') return trust('blocked', 'The data’s checks rejected this query.');
    // A join nobody certified yet (drafted in setup) makes the tile Needs review, like other review data.
    if (dataset.trust === 'certified' && outcome !== 'needs_review' && dataset.joins?.some((join) => join.trust !== 'certified')) {
      return trust('review', 'It uses a join between tables that nobody has certified yet.');
    }
    const calculated = Boolean((item.query as { calculations?: unknown[] } | undefined)?.calculations?.length);
    if (dataset.trust === 'certified' && outcome !== 'needs_review' && calculated) {
      // Checked arithmetic over certified measures is governed, not certified:
      // nobody reviewed this formula. Promoting it into the Dataset certifies it.
      return trust('governed', 'Calculated on certified data: checked arithmetic over its certified measures.');
    }
    if (dataset.trust === 'certified' && outcome !== 'needs_review') {
      return outcome === 'adapted'
        ? certifiedTrust('Certified data; the query was adapted within what it certifies.', tile.certification)
        : certifiedTrust('Runs on certified data, within what it certifies.', tile.certification);
    }
    return trust('review', outcome === 'needs_review'
      ? 'The query goes beyond what the data certifies.'
      : 'This data is not certified yet.');
  }

  if (tile.certificationStatus === 'certified' || tile.artifact?.trustState === 'certified' || tile.trustState === 'certified') {
    return certifiedTrust('Runs a certified saved query exactly as it was reviewed.', tile.certification);
  }
  if (tile.tileType === 'semantic' || item.semantic || tile.artifact?.sourceKind === 'semantic_query') {
    return trust('governed', 'Metrics and dimensions come from the governed semantic model.');
  }
  return trust('review', 'This source is not certified yet; check it before relying on it.');
}

/** Counts for the Trust Lens legend, in a fixed order. */
export function readerTrustCounts(trusts: Array<ReaderTrust | null>): Array<{ state: ReaderTrustState; label: string; count: number }> {
  const order: ReaderTrustState[] = ['certified', 'governed', 'review', 'blocked'];
  return order
    .map((state) => ({ state, label: READER_TRUST_LABELS[state], count: trusts.filter((entry) => entry?.state === state).length }))
    .filter((entry) => entry.count > 0);
}

/** "All 6 tiles certified" or "4 of 6 tiles certified"; empty when no data tile ran. */
export function readerTrustSummary(trusts: Array<ReaderTrust | null>): { certified: number; total: number; text: string } {
  const total = trusts.filter(Boolean).length;
  const certified = trusts.filter((entry) => entry?.state === 'certified').length;
  const text = total === 0 ? '' : certified === total ? `All ${total} ${total === 1 ? 'tile' : 'tiles'} certified` : `${certified} of ${total} tiles certified`;
  return { certified, total, text };
}

/**
 * The one aggregate trust an App page shows (header badge, Trust Lens line,
 * story and canvas summaries), derived from its current tiles' run evidence.
 *
 * - `certified` only when every data tile ran from a certified source and the
 *   App has no pending drafts; nothing else may say "certified" or "verified".
 * - `pending` while no run evidence exists yet: a saved document's own claims
 *   (or a bare block reference) are never read as certified, because the
 *   source behind them may have been edited or demoted since.
 *
 * This is data trust. An App's lifecycle (draft / review / published) is a
 * separate axis and is labelled separately.
 */
export type AppTrustState = 'certified' | 'partial' | 'review' | 'pending' | 'empty';

export interface AppTrustSummary {
  state: AppTrustState;
  certified: number;
  total: number;
  allCertified: boolean;
  /** Short badge text: "All data certified", "0 of 1 tiles certified", "Trust not checked yet". */
  label: string;
  /** Sentence form for summaries; empty when no data tile ran. */
  text: string;
  /**
   * Who certified the page's certified tiles, and the latest date (D5):
   * "Certified by Kranthi · 21 Oct". Absent when no tile is certified.
   */
  byline?: string;
}

export function appTrustSummary<Item extends ReaderTrustItem & { i: string }>(
  items: ReadonlyArray<Item> | undefined,
  runTiles: ReadonlyMap<string, ReaderTrustTile> | ReadonlyArray<ReaderTrustTile & { i?: string; id?: string; tileId?: string }> | undefined,
  options: { pendingDrafts?: number } = {},
): AppTrustSummary {
  const tileFor = (id: string): ReaderTrustTile | undefined => {
    if (!runTiles) return undefined;
    if (runTiles instanceof Map) return runTiles.get(id);
    return (runTiles as ReadonlyArray<ReaderTrustTile & { i?: string; id?: string; tileId?: string }>)
      .find((tile) => (tile.i ?? tile.tileId ?? tile.id) === id);
  };
  const dataItems = (items ?? []).filter((item) => isDataTileForTrust(item, tileFor(item.i)));
  const total = dataItems.length;
  if (total === 0) {
    return { state: 'empty', certified: 0, total: 0, allCertified: false, label: 'No data tiles', text: '' };
  }
  if (!runTiles) {
    return { state: 'pending', certified: 0, total, allCertified: false, label: 'Trust not checked yet', text: '' };
  }
  // A tile with no run evidence counts as not certified, never as certified.
  const trusts = dataItems.map((item) => readerTileTrust(item, tileFor(item.i)));
  const certified = trusts.filter((entry) => entry?.state === 'certified').length;
  const across = certified > 0
    ? certifiedByAcross(dataItems
      .filter((_, index) => trusts[index]?.state === 'certified')
      .map((item) => tileFor(item.i)?.certification ?? {}))
    : undefined;
  // A bare "Certified" (no person, no date recorded) adds nothing to the count.
  const byline = across && across !== 'Certified' ? across : undefined;
  const drafts = options.pendingDrafts ?? 0;
  const allCertified = certified === total && drafts === 0;
  const text = certified === total
    ? `All ${total} ${total === 1 ? 'tile' : 'tiles'} certified`
    : `${certified} of ${total} ${total === 1 ? 'tile' : 'tiles'} certified`;
  return {
    state: allCertified ? 'certified' : certified > 0 ? 'partial' : 'review',
    certified,
    total,
    allCertified,
    label: allCertified ? 'All data certified' : text,
    text,
    ...(byline ? { byline } : {}),
  };
}
