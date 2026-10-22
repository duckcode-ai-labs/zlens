/**
 * One trust vocabulary for App readers (RFC 0008 step 6; one trust model,
 * T1/T2). People see two words: **Certified** (by whom, and when) or **Not
 * certified yet**. Everything else is detail in the tile's receipt. The
 * states are worked out from the run evidence the server returned, never
 * from the tile's own claims alone:
 *
 * - certified: a certified source ran exactly as reviewed, through certified
 *              joins; a calculation is certified when all its inputs are
 * - governed:  a legacy semantic-model result nobody certified (shown as
 *              "Not certified yet", like `review`; kept as a code value)
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
  /**
   * The person reading is the person who certified it (the server compares
   * the recorded identity with the viewer's, the same way it names people
   * everywhere): "Certified by you · 22 Oct".
   */
  byYou?: boolean | null;
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
    /** ZLens checked the data and someone added it, but nobody certified it yet (receipt: "Checked, not certified yet"). */
    checked?: boolean | null;
    validation?: { outcome?: string } | null;
    /** Joins to related tables the tile used (design D2), in plain words. */
    joins?: Array<{ trust?: string; sentence?: string; changedSinceCertified?: { at?: string | null } | null }> | null;
  } | null;
  artifact?: { trustState?: string; sourceKind?: string } | null;
  certificationStatus?: string | null;
  trustState?: string;
  /** Who certified the source behind this tile, and when (D5). */
  certification?: CertificationByline | null;
}

/**
 * The second of the two trust words (T1): anything nobody has vouched for.
 * Why (checked but not certified, changed since it was certified, a join
 * nobody certified) is detail in the receipt, never a third word.
 */
export const NOT_CERTIFIED_YET = 'Not certified yet';

/** @deprecated Checked data reads "Not certified yet" like any other (T1). */
export const CHECKED_NEEDS_CERTIFYING_LABEL = NOT_CERTIFIED_YET;

/** Receipt detail for data ZLens checked that nobody certified yet. */
export const CHECKED_NOT_CERTIFIED_DETAIL = 'Checked, not certified yet.';
/** Receipt detail for a tile on a join nobody certified. */
export const UNCERTIFIED_JOIN_DETAIL = 'Uses a join nobody has certified.';

export const READER_TRUST_LABELS: Record<ReaderTrustState, string> = {
  certified: 'Certified',
  governed: NOT_CERTIFIED_YET,
  review: NOT_CERTIFIED_YET,
  blocked: 'Blocked',
};

/** "Uses a join that changed since it was certified on 21 Oct." for a join whose certification no longer holds. */
export function changedJoinDetail(at: string | null | undefined, now: Date = new Date()): string | undefined {
  const date = certifiedDateLabel(at, now);
  return date ? `Uses a join that changed since it was certified on ${date}.` : undefined;
}

/** "Changed since it was certified on 21 Oct." for data whose certification no longer holds. */
export function changedSinceCertifiedDetail(at: string | null | undefined, now: Date = new Date()): string | undefined {
  const date = certifiedDateLabel(at, now);
  return date ? `Changed since it was certified on ${date}.` : undefined;
}

/**
 * "Checked by you, not certified yet." — who checked it, when known.
 */
export function checkedNotCertifiedDetail(check: { byYou?: boolean | null; by?: string | null; name?: string | null } | null | undefined): string {
  if (check?.byYou) return 'Checked by you, not certified yet.';
  const who = certifierDisplayName(check?.by, check?.name);
  return who ? `Checked by ${who}, not certified yet.` : CHECKED_NOT_CERTIFIED_DETAIL;
}

const trust = (state: ReaderTrustState, detail: string): ReaderTrust => ({ state, label: READER_TRUST_LABELS[state], detail });

/** Identities that name no person: a receipt written before ZLens knew who was certifying. */
const ANONYMOUS_CERTIFIERS = new Set(['local', 'guest@local', 'owner@local', 'unknown', 'anonymous']);

/**
 * Team and role mailboxes: "analytics@jaffle.shop" is a team, not a person
 * called Analytics, so it keeps its domain ("Analytics (jaffle.shop)").
 */
const ROLE_MAILBOXES = new Set([
  'admin', 'analytics', 'analysts', 'bi', 'data', 'dataops', 'dbt', 'engineering', 'finance', 'info',
  'insights', 'marketing', 'ops', 'operations', 'reporting', 'sales', 'support', 'team', 'warehouse',
]);

/**
 * The name to show for a certifier. A recorded display name wins. Otherwise an
 * email is shortened to its name part ("maria.lopez@acme.com" → "Maria Lopez",
 * a GitHub noreply address loses its number), a team mailbox keeps its domain
 * ("analytics@jaffle.shop" → "Analytics (jaffle.shop)"), and a placeholder
 * identity ("local") names nobody.
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
  const shown = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
  const domain = identity.slice(at + 1).toLowerCase();
  if (words.length === 1 && ROLE_MAILBOXES.has(words[0]!.toLowerCase()) && domain && domain !== 'local' && !domain.endsWith('noreply.github.com')) {
    return `${shown} (${domain})`;
  }
  return shown;
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
  const who = receipt?.byYou ? 'you' : certifierDisplayName(receipt?.by, receipt?.name);
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
  // The reader comes first when they certified some of it: "Certified by you and Maria".
  if (present.some((receipt) => receipt.byYou)) names.push('you');
  for (const receipt of present) {
    if (receipt.byYou) continue;
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
    // A join nobody certified yet (drafted in setup) keeps the tile from being certified.
    if (dataset.trust === 'certified' && outcome !== 'needs_review' && dataset.joins?.some((join) => join.trust !== 'certified')) {
      const changed = dataset.joins.find((join) => join.trust !== 'certified' && join.changedSinceCertified?.at);
      return trust('review', changedJoinDetail(changed?.changedSinceCertified?.at) ?? UNCERTIFIED_JOIN_DETAIL);
    }
    const calculated = Boolean((item.query as { calculations?: unknown[] } | undefined)?.calculations?.length);
    if (dataset.trust === 'certified' && outcome !== 'needs_review') {
      // A calculation is certified when every input is (T2): checked
      // arithmetic over certified measures, through certified joins.
      if (calculated) return certifiedTrust('Calculated from certified data: every input is certified.', tile.certification);
      return outcome === 'adapted'
        ? certifiedTrust('Certified data; the query was adapted within what it certifies.', tile.certification)
        : certifiedTrust('Runs on certified data, within what it certifies.', tile.certification);
    }
    if (outcome !== 'needs_review' && dataset.checked) {
      return trust('review', CHECKED_NOT_CERTIFIED_DETAIL);
    }
    if (outcome === 'needs_review') return trust('review', 'The query goes beyond what the data certifies.');
    return trust('review', changedSinceCertifiedDetail(tile.certification?.at) ?? 'Nobody has certified this data yet.');
  }

  if (tile.certificationStatus === 'certified' || tile.artifact?.trustState === 'certified' || tile.trustState === 'certified') {
    return certifiedTrust('Runs a certified saved query exactly as it was reviewed.', tile.certification);
  }
  if (tile.tileType === 'semantic' || item.semantic || tile.artifact?.sourceKind === 'semantic_query') {
    return trust('governed', 'Metrics and dimensions come from the semantic model; nobody has certified this result.');
  }
  return trust('review', changedSinceCertifiedDetail(tile.certification?.at) ?? 'Nobody has certified this saved query yet.');
}

/**
 * Counts for the Trust Lens legend, in a fixed order: Certified, Not
 * certified yet (every tile nobody vouched for, whatever the reason), Blocked.
 */
export function readerTrustCounts(trusts: Array<ReaderTrust | null>): Array<{ state: ReaderTrustState; label: string; count: number }> {
  const count = (states: ReaderTrustState[]) => trusts.filter((entry) => entry && states.includes(entry.state)).length;
  return ([
    { state: 'certified', label: READER_TRUST_LABELS.certified, count: count(['certified']) },
    { state: 'review', label: NOT_CERTIFIED_YET, count: count(['review', 'governed']) },
    { state: 'blocked', label: READER_TRUST_LABELS.blocked, count: count(['blocked']) },
  ] as Array<{ state: ReaderTrustState; label: string; count: number }>).filter((entry) => entry.count > 0);
}

/** "All tiles certified": the one count text when every data tile is certified (T2). */
export const ALL_TILES_CERTIFIED = 'All tiles certified';

/**
 * The one way every surface counts certified tiles (T2): "All tiles
 * certified" or "3 of 4 tiles certified"; empty for no data tiles. The App
 * header, the reader's trust line, the Apps card, the publish dialog and the
 * stored `dql.app.json` count all read it.
 */
export function tileTrustCountText(certified: number, total: number): string {
  if (total <= 0) return '';
  return certified === total
    ? ALL_TILES_CERTIFIED
    : `${certified} of ${total} ${total === 1 ? 'tile' : 'tiles'} certified`;
}

/** "All tiles certified" or "4 of 6 tiles certified"; empty when no data tile ran. */
export function readerTrustSummary(trusts: Array<ReaderTrust | null>): { certified: number; total: number; text: string } {
  const total = trusts.filter(Boolean).length;
  const certified = trusts.filter((entry) => entry?.state === 'certified').length;
  return { certified, total, text: tileTrustCountText(certified, total) };
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
  /** Short badge text: "All tiles certified", "0 of 1 tile certified", "Trust not checked yet". */
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
  const text = tileTrustCountText(certified, total);
  return {
    state: allCertified ? 'certified' : certified > 0 ? 'partial' : 'review',
    certified,
    total,
    allCertified,
    label: text,
    text,
    ...(byline ? { byline } : {}),
  };
}
