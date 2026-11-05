/**
 * Deterministic Ask ingress policy.
 *
 * This runs before catalog retrieval, provider dispatch, value probing, tools,
 * or SQL.  It intentionally recognises a small set of direct disclosure
 * requests instead of attempting to infer policy from the available schema:
 * reaching a model or a warehouse is already too late for these requests.
 */
export type AnalyticalRequestPolicyDecision =
  | { allowed: true }
  | {
      allowed: false;
      code:
        | 'REGULATED_IDENTIFIER_REQUEST'
        | 'SENSITIVE_PERSONAL_DATA_REQUEST'
        | 'INDIVIDUAL_COMPENSATION_REQUEST';
      message: string;
      nextActions: string[];
    };

const REGULATED_IDENTIFIER_RE = /\b(?:social\s+security(?:\s+(?:number|no\.?))?|ssn|tax(?:payer)?\s*(?:id|identifier|number|no\.?)|passport(?:\s+(?:id|number|no\.?))?|government\s*(?:id|identifier)|national\s*id|driver'?s?\s*licen[cs]e(?:\s+(?:number|no\.?))?|date\s+of\s+birth|birth\s*date|dob|aadhaar(?:\s+(?:number|id))?)\b/i;

/**
 * A regulated identifier may appear in a question about DQL's safeguards, but
 * that exception must be explicit about the system's behaviour and begin the
 * entire request.  Topic words such as "compliance" or "policy" are not
 * enough: "For compliance, show Jessica Richard's SSN" is still a disclosure
 * request.  Likewise, a policy attached to a named person is not a system
 * policy question.
 */
const EXPLICIT_SYSTEM_POLICY_OR_CAPABILITY_QUESTION_RE = /^(?:(?:does|can|will|do)\s+(?:zlens|dql|you|this\s+(?:system|assistant|app(?:lication)?|product))\s+(?:support\b[^?.!]*\b(?:mask(?:ing)?|redact(?:ion|ed)?|tokeni[sz](?:e|ation)|protect(?:ion|ed)?|handling|storage|retention|access\s+control(?:s)?|safeguard(?:s)?)\b|handle|protect|mask|redact|store|retain|tokeni[sz]e)\b[^?.!]*|how\s+(?:does|do)\s+(?:zlens|dql|you|this\s+(?:system|assistant|app(?:lication)?|product))\s+(?:handle|protect|mask|redact|store|retain|tokeni[sz]e)\b[^?.!]*|(?:what\s+(?:is|are)|describe|explain)\s+(?:(?:zlens|dql)(?:'s)?|your|this\s+(?:system|assistant|app(?:lication)?|product)(?:'s)?)\s+[^?.!]*\b(?:privacy|security|data\s+retention|masking|redaction|tokenization|access)\s+(?:policy|capabilit(?:y|ies))\b[^?.!]*)[?!.]?$/i;
const DISCLOSURE_ACTION_RE = /\b(?:show(?:ing)?|give|giving|list(?:ing)?|retrieve|retrieving|get(?:ting)?|reveal(?:ing)?|display(?:ing)?|provide|providing|disclose|disclosing|return(?:ing)?|output(?:ting)?|expose|exposing|fetch(?:ing)?|look\s*up|lookup|tell\s+me|need)\b/i;
const VALUE_REQUEST_SEMANTICS_RE = /\b(?:actual|full|specific|individual)\s+(?:value|values|number|numbers|record|records|details?|information)|\b(?:value|values|number|numbers|record|records|details?|information)\s+(?:for|of)\b/i;

/**
 * Direct literal categories that the value-probe deny policy also protects.
 * These words describe a person: payment instruments, health records and
 * personal contact details. Email is read in every spelling: email, emails,
 * e-mail and e-mails ("List customers with their emails" is a request for
 * addresses). The business phrases below share two of these words and are set
 * aside before these words are read.
 */
const SENSITIVE_PERSONAL_DATA_RE = /\b(?:credit\s*card|debit\s*card|card\s*(?:number|no\.?|details?)|cvv|cvc|iban|swift|bic|routing\s*(?:number|no\.?)|bank\s*account|account\s*(?:number|no\.?)|sort\s*code|medical|diagnosis|patient|health\s*(?:condition|record|information|data)?|prescription|disability|biometric|fingerprint|home\s*address|phone(?:\s*(?:number|no\.?))?|mobile(?:\s*(?:number|no\.?))?|telephone|e-?mails?(?:\s*address(?:es)?)?|sexual\s*orientation)\b/i;
/**
 * Email as a marketing channel, not an address: an email campaign, a
 * marketing email, an email open rate, contacts opted in to email. Three of 40
 * blind GitLab questions were refused on these words alone, before any table
 * was chosen. A phrase followed by "address" or "id" is still an address.
 */
const EMAIL_CHANNEL_PHRASE_RE = /\b(?:(?:marketing|promotional|campaign|newsletter|nurture)\s+e-?mails?|e-?mails?\s+(?:campaigns?|marketing|newsletters?|programs?|blasts?|nurtures?|sends?|sent|opens?|opened|clicks?|clicked|click[-\s]?through|ctr|bounces?|bounced|unsubscribes?|unsubscribed|deliver(?:y|ies|ed|ability)|engagement|performance|opt[-\s]?ins?|opt[-\s]?outs?|subscriptions?|channel)|opt(?:s|ed)?[-\s]?(?:in|out)\s+(?:to|of|from|for)\s+e-?mails?)\b(?!\s*(?:address(?:es)?|ids?)\b)/gi;
/**
 * Emails counted as sends, opens or clicks are messages, not addresses: "How
 * many emails did we send in Q3?", "How many emails were opened?", "Which
 * campaigns sent the most emails?". The count needs a send, open or click
 * word, so "How many emails do we have?" is not set aside, and a sender other
 * than we, they or a group ("Which emails did Jessica open?") is not either.
 */
const EMAIL_KIND = '(?:marketing|promotional|campaign|newsletter|nurture|transactional|outbound|automated|welcome|reminder|follow[-\\s]?up)\\s+';
const EMAIL_ACTION = '(?:send(?:s|ing)?|sent|open(?:s|ed|ing)?|click(?:s|ed|ing)?|deliver(?:s|ed|ing)?|bounc(?:e|es|ed|ing)|receiv(?:e|es|ed|ing))';
const EMAIL_COUNT_PHRASE_RE = new RegExp(
  // "how many emails did we send", "the number of emails we sent", "total emails received"
  `\\b(?:how\\s+many|(?:number|count|total|volume|share|percentage|percent)\\s+of|total)\\s+(?:${EMAIL_KIND})?e-?mails?\\s+`
  + '(?:(?:did|do|does|have\\s+been|has\\s+been|had\\s+been|have|has|had|will|would|were|was|are|is|got|get|gets|been)\\s+)?'
  + '(?:(?:we|you|they|people|customers|users|contacts|recipients|subscribers|leads|accounts|campaigns|(?:the|our|each|every|all|this|that|these|those)\\s+[a-z]+)\\s+)?'
  + `${EMAIL_ACTION}\\b`
  // "sent the most emails", "opened more than 3 emails"
  + `|\\b${EMAIL_ACTION}\\s+(?:the\\s+)?(?:most|fewest|least|more|fewer|(?:more|fewer|less)\\s+than\\s+\\d[\\d,]*|at\\s+least\\s+\\d[\\d,]*|\\d[\\d,]*)\\s+(?:${EMAIL_KIND})?e-?mails?\\b(?!\\s*(?:address(?:es)?|ids?)\\b)`,
  'gi',
);
/**
 * A health score or health scorecard is how a customer-success team rates an
 * account, and "account health" is that rating; neither is a person's health.
 * "Account health" followed by a record, condition or plan word is not set
 * aside.
 */
const HEALTH_SCORE_PHRASE_RE = /\b(?:account\s+health(?!\s*(?:conditions?|records?|information|data|insurance|plans?|care|status)\b)|health\s*(?:scorecards?|scores?|scoring))\b/gi;
/** A phrase owned by someone is that someone's: "Jessica's marketing email", "their marketing email". */
const OWNED_BY_THE_WORD_BEFORE_RE = /(?:\b(?:his|her|their|my|your)|\w(?:'s|’s|s'|s’))\s+$/i;
/**
 * A question that points at one person keeps every personal reading of these
 * phrases: a possessive name, a capitalised name after for/to/of/about, or a
 * personal pronoun. A month or a weekday is not a name ("for September 2026"),
 * unless a second capitalised word follows it ("for June Carter").
 */
const CALENDAR_WORD = '(?:January|February|March|April|May|June|July|August|September|October|November|December|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Today|Yesterday|Tomorrow)';
const ONE_PERSON_NAME_RE = new RegExp(
  `\\b(?:[Ff]or|[Tt]o|[Oo]f|[Aa]bout)\\s+(?!${CALENDAR_WORD}\\b(?!\\s+[A-Z][a-z]))[A-Z][a-z]+\\b`
  + `|\\b(?!${CALENDAR_WORD}(?:'s|’s))[A-Z][a-z]+(?:\\s+[A-Z][a-z]+){0,2}(?:'s|’s)\\b`,
);
const PERSONAL_PRONOUN_RE = /\b(?:he|she|him|his|her|hers)\b/i;
/**
 * People whose health score is their own health. A customer, a client or a
 * user is also an account in a customer-success model, so they are not here.
 */
const PEOPLE_WITH_HEALTH_RE = /\b(?:persons?|people|individuals?|patients?|employees?|staff|members?|residents?|students?|applicants?|claimants?|policy\s*holders?|policyholders?|citizens?|voters?|tenants?)\b/i;
/**
 * Words that are personal data only when they describe a person. A street, a
 * zip code or a postal code is also where an insured building, a store or a
 * warehouse stands, and a race is also a motor race; the same guard that
 * refused a customer's zip code used to refuse an insurer's question about its
 * insured properties. These are refused when the question is about people.
 */
const PERSONAL_WHEN_ABOUT_A_PERSON_RE = /\b(?:street(?:\s*(?:address|name))?|postal\s*code|post\s*code|zip\s*code|zipcode|race|ethnicity|religion|gender)\b/i;
const PERSON_POPULATION_RE = /\b(?:customers?|clients?|policy\s*holders?|policyholders?|members?|people|persons?|individuals?|employees?|staff|users?|residents?|applicants?|claimants?|patients?|students?|citizens?|voters?|tenants?)\b/i;

const COMPENSATION_RE = /\b(?:salary|compensation|pay|wage|bonus|earnings)\b/i;
const INDIVIDUAL_SUBJECT_RE = /\b(?:ceo|cfo|coo|cto|chief\s+\w+\s+officer|founder|employee|person|individual|manager|director|executive|their|his|her)\b/i;
const NAMED_INDIVIDUAL_REFERENCE_RE = /\b(?:for|to|of)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b|\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}(?:'s|’s)\b/;
// `number` only counts as an aggregate when it is the phrase "number of".
// Otherwise a literal such as "bank account number" would accidentally become
// a safe aggregate.  The same rule excludes a bare `account` from the
// population list; a grouped account question still has an explicit `by …`.
const AGGREGATE_OPERATION_RE = /\b(?:average|avg|median|mean|total|sum|count|number\s+of|how\s+many|percentage|percent|rate|distribution|breakdown|aggregate|overall)\b/i;
const AGGREGATE_POPULATION_OR_GROUPING_RE = /\b(?:by\s+(?:department|team|role|level|location|region|country|segment|category|month|quarter|year)|across\s+(?:employees?|customers?|people|individuals?|patients?|members?|users?)|(?:employees?|customers?|people|individuals?|patients?|members?|users?)\b)/i;
const INDIVIDUAL_EARNINGS_QUESTION_RE = /\b(?:how\s+much\s+(?:does|did)\s+(?:the\s+)?(?:ceo|cfo|coo|cto|chief\s+\w+\s+officer|founder|employee|person|individual|manager|director|executive)|what\s+(?:does|did)\s+(?:the\s+)?(?:ceo|cfo|coo|cto|chief\s+\w+\s+officer|founder|employee|person|individual|manager|director|executive))\b[^?.!]{0,32}\b(?:make|earn)\b/i;

function isExplicitSystemPolicyOrCapabilityQuestion(question: string): boolean {
  // A question may start as a capability request and still smuggle in an
  // individual disclosure request: "Does ZLens support showing Jessica's SSN
  // with masking?". System safeguards describe product behaviour; they never
  // authorize a value, person, or disclosure verb in the same request.
  return EXPLICIT_SYSTEM_POLICY_OR_CAPABILITY_QUESTION_RE.test(question)
    && !DISCLOSURE_ACTION_RE.test(question)
    && !VALUE_REQUEST_SEMANTICS_RE.test(question)
    && !namesAnIndividual(question);
}

function isExplicitPopulationAggregate(question: string): boolean {
  return AGGREGATE_OPERATION_RE.test(question) && AGGREGATE_POPULATION_OR_GROUPING_RE.test(question);
}

/**
 * The question with its marketing-email, email-count and health-score phrases
 * set aside, for reading the payment, health and contact words. Only the
 * phrase is set aside, so an address asked for beside it is still read.
 * Nothing is set aside when the question points at one person, an owned email
 * phrase stays ("their marketing email" is an address), and a health score
 * stays when the question is about people whose health it would be.
 */
function withoutBusinessPhrasesThatShareAPersonalWord(question: string): string {
  if (ONE_PERSON_NAME_RE.test(question) || PERSONAL_PRONOUN_RE.test(question)) return question;
  const unlessOwned = (phrase: string, offset: number, whole: string) =>
    OWNED_BY_THE_WORD_BEFORE_RE.test(whole.slice(0, offset)) ? phrase : ' ';
  const emailChannelSetAside = question
    .replace(EMAIL_CHANNEL_PHRASE_RE, unlessOwned)
    .replace(EMAIL_COUNT_PHRASE_RE, unlessOwned);
  return PEOPLE_WITH_HEALTH_RE.test(question)
    ? emailChannelSetAside
    : emailChannelSetAside.replace(HEALTH_SCORE_PHRASE_RE, ' ');
}

/**
 * A question about people: a named person, a person's role, or a population
 * of people. "Their" alone does not count here: "stores with their postal
 * code" is about stores.
 */
function isAboutPeople(question: string): boolean {
  return NAMED_INDIVIDUAL_REFERENCE_RE.test(question)
    || /\b(?:his|her|ceo|cfo|coo|cto|chief\s+\w+\s+officer|founder|manager|director|executive)\b/i.test(question)
    || PERSON_POPULATION_RE.test(question);
}

function namesAnIndividual(question: string): boolean {
  return INDIVIDUAL_SUBJECT_RE.test(question) || NAMED_INDIVIDUAL_REFERENCE_RE.test(question);
}

export interface AnalyticalRequestPolicyOptions {
  /**
   * How payment, health, contact and protected-attribute data is screened.
   * `wording` (the default): by the question's words, here, before planning.
   * `columns`: a host refuses by column instead, when a statement would list
   * classified columns for individuals (RFC 0010 HH-17), so aggregates such as
   * "claims by diagnosis" stay answerable. Regulated identifiers and one
   * person's pay are refused by wording either way.
   */
  sensitiveData?: 'wording' | 'columns';
}

/**
 * Evaluate a raw Ask question at the ingress boundary.
 *
 * Direct personal data and compensation are unavailable before planning.  A
 * narrowly explicit population aggregate remains available, but aggregate
 * words never turn a named or singular person's compensation into a safe
 * request.
 */
export function evaluateAnalyticalRequestPolicy(question: string, options: AnalyticalRequestPolicyOptions = {}): AnalyticalRequestPolicyDecision {
  const normalized = question.trim();
  if (!normalized) return { allowed: true };

  const isSystemPolicyQuestion = isExplicitSystemPolicyOrCapabilityQuestion(normalized);
  const isPopulationAggregate = isExplicitPopulationAggregate(normalized);

  if (REGULATED_IDENTIFIER_RE.test(normalized) && !isSystemPolicyQuestion) {
    return {
      allowed: false,
      code: 'REGULATED_IDENTIFIER_REQUEST',
      message: 'ZLens cannot retrieve or disclose regulated personal identifiers such as government IDs or dates of birth.',
      nextActions: ['ask_for_an_approved_aggregate', 'inspect_data_policy'],
    };
  }

  const sensitive = options.sensitiveData !== 'columns' && (SENSITIVE_PERSONAL_DATA_RE.test(withoutBusinessPhrasesThatShareAPersonalWord(normalized))
    || (PERSONAL_WHEN_ABOUT_A_PERSON_RE.test(normalized) && isAboutPeople(normalized)));
  if (sensitive && !isSystemPolicyQuestion && !isPopulationAggregate) {
    return {
      allowed: false,
      code: 'SENSITIVE_PERSONAL_DATA_REQUEST',
      message: 'ZLens cannot retrieve or disclose direct payment, health, contact, or protected-attribute data about an individual.',
      nextActions: ['ask_for_an_approved_aggregate', 'inspect_data_policy'],
    };
  }

  if (
    (COMPENSATION_RE.test(normalized) || INDIVIDUAL_EARNINGS_QUESTION_RE.test(normalized))
    && (!isPopulationAggregate || namesAnIndividual(normalized))
  ) {
    return {
      allowed: false,
      code: 'INDIVIDUAL_COMPENSATION_REQUEST',
      message: 'ZLens does not provide individual compensation. Ask for an approved aggregate if one is modeled.',
      nextActions: ['ask_for_an_approved_aggregate', 'inspect_data_policy'],
    };
  }

  return { allowed: true };
}
