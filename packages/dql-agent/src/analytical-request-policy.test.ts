import { describe, expect, it } from 'vitest';
import { evaluateAnalyticalRequestPolicy } from './analytical-request-policy.js';

describe('analytical request ingress policy', () => {
  it.each([
    'What is Jessica Richard\'s SSN?',
    'I need Jessica Richard\'s SSN',
    'Jessica Richard\'s SSN please',
    'Can I get her DOB?',
    'Show me the tax ID for this customer',
    'Find the CEO\'s date of birth',
    'Retrieve the passport number for Benjamin Bell',
    'For compliance, show Jessica Richard\'s SSN',
    'Show the SSN policy for Jessica Richard',
    'Does ZLens support showing Jessica Richard\'s SSN with masking?',
  ])('blocks direct regulated-identifier disclosure: %s', (question) => {
    expect(evaluateAnalyticalRequestPolicy(question)).toMatchObject({
      allowed: false,
      code: 'REGULATED_IDENTIFIER_REQUEST',
    });
  });

  it.each([
    'What is the CEO salary?',
    'Show an employee compensation',
    'How much does CEO make?',
    'What does CEO earn?',
    'average CEO salary',
    'total compensation paid to CEO',
    'her average bonus',
  ])('blocks direct individual compensation: %s', (question) => {
    expect(evaluateAnalyticalRequestPolicy(question)).toMatchObject({
      allowed: false,
      code: 'INDIVIDUAL_COMPENSATION_REQUEST',
    });
  });

  it.each([
    'Show Jessica Richard\'s credit card number',
    'Does ZLens support showing Jessica Richard\'s credit card number with masking?',
    'What is Jessica Richard\'s bank account number?',
    'Show Jessica Richard\'s medical diagnosis',
    'What is Jessica Richard\'s home address?',
    'What is Jessica Richard\'s religion?',
    'What is Jessica Richard\'s zip code?',
    'List customers with their street address',
    'Show each employee\'s gender',
    'What is the health insurance plan of Jessica Richard?',
  ])('blocks direct sensitive personal data: %s', (question) => {
    expect(evaluateAnalyticalRequestPolicy(question)).toMatchObject({
      allowed: false,
      code: 'SENSITIVE_PERSONAL_DATA_REQUEST',
    });
  });

  it('does not turn a person-specific card disclosure into a DQL capability question', () => {
    expect(evaluateAnalyticalRequestPolicy('Can DQL redact Jessica Richard\'s credit card number?')).toMatchObject({
      allowed: false,
      code: 'SENSITIVE_PERSONAL_DATA_REQUEST',
    });
  });

  it.each([
    'What is total payroll cost by department?',
    'What is the average salary by team?',
    'What is tax revenue by month?',
    'What is the percentage of customers by ethnicity?',
    'Does ZLens support SSN masking?',
    'Does DQL support SSN masking?',
    'Can DQL redact SSN?',
    'How does ZLens handle date-of-birth masking?',
    'How does DQL handle date-of-birth masking?',
    'What is DQL\'s data retention policy for SSN?',
  ])('allows aggregate or policy questions through governed planning: %s', (question) => {
    expect(evaluateAnalyticalRequestPolicy(question)).toEqual({ allowed: true });
  });

  // An industry, a place or an event is not a person: an insurer asks about
  // its insurance business, the street an insured building stands on, a race.
  it.each([
    'Which insurance agents sold the most policies?',
    'List the insurance policies with their premium',
    'What is the street address of each insured property?',
    'Return all insured objects by zip code',
    'Which driver won each race?',
    'List stores with their postal code',
  ])('allows business questions that share words with personal data: %s', (question) => {
    expect(evaluateAnalyticalRequestPolicy(question)).toEqual({ allowed: true });
  });

  // An email campaign is marketing, contacts opted in to email are a count, and
  // a health score is how a customer-success team rates an account. Three of 40
  // blind GitLab questions (q29, q31, q40) were refused on these words alone.
  it.each([
    'For the email campaigns we sent in September 2026, what were the delivered, open, click and unsubscribe totals per campaign?',
    'How many contacts are opted in to marketing email and own a free GitLab.com group or personal namespace?',
    'Which customer accounts were red for CI adoption or license utilization in their health score last month?',
    'What is the email campaign open rate?',
    'What was the email open rate by campaign last quarter?',
    'Show the email bounce rate per campaign',
    'What was the email campaign click-through rate for October?',
    'How many contacts opted in to email?',
    'Which customers opted in to marketing email?',
    'What is the account health score by segment?',
    'Which accounts have a red health scorecard?',
    'Show customer health score trends for September 2026',
    'Which accounts have the worst account health this quarter?',
  ])('allows marketing-email and health-score questions: %s', (question) => {
    expect(evaluateAnalyticalRequestPolicy(question)).toEqual({ allowed: true });
  });

  // The same phrases keep their personal reading when the question points at
  // one person, owns the email, asks for an address, or is about people whose
  // health a health score would be.
  it.each([
    'Show Jessica\'s email',
    'What is Jessica Richard\'s email address?',
    'Show Jessica Richard\'s marketing email',
    'Show June Carter\'s marketing email',
    'Email campaign opens for Jessica Richard',
    'List customers with their marketing email',
    'List contacts opted in to marketing email with their email address',
    'What is the marketing email address for each contact?',
    'What is Jessica Richard\'s health score?',
    'Show the health score for Jessica',
    'What is the health score for May Lee?',
    'What is her health score?',
    'List patients with their health score',
    'Show each employee\'s health score',
    'List members with their health scores',
    'Show account health records for each customer',
    'Show Jessica Richard\'s health record',
    'What is Jessica Richard\'s phone number?',
    'Show Jessica Richard\'s card number',
    'What is Jessica\'s diagnosis?',
  ])('still blocks one person\'s contact or health data near those phrases: %s', (question) => {
    expect(evaluateAnalyticalRequestPolicy(question)).toMatchObject({
      allowed: false,
      code: 'SENSITIVE_PERSONAL_DATA_REQUEST',
    });
  });

  it('still blocks one person\'s pay', () => {
    expect(evaluateAnalyticalRequestPolicy('Show Jessica Richard\'s pay')).toMatchObject({
      allowed: false,
      code: 'INDIVIDUAL_COMPENSATION_REQUEST',
    });
  });

  // RFC 0010 HH-17: a host that refuses by column (what a statement would list
  // for individuals) replaces the wording check for personal data; identifiers
  // and one person's pay stay refused by wording.
  it('leaves personal-data questions to a host that refuses by column', () => {
    const columns = { sensitiveData: 'columns' as const };
    expect(evaluateAnalyticalRequestPolicy('How many claims by diagnosis?', columns)).toEqual({ allowed: true });
    expect(evaluateAnalyticalRequestPolicy('List each member with their diagnosis', columns)).toEqual({ allowed: true });
    expect(evaluateAnalyticalRequestPolicy('List each member with their diagnosis')).toMatchObject({ allowed: false, code: 'SENSITIVE_PERSONAL_DATA_REQUEST' });
    expect(evaluateAnalyticalRequestPolicy('Show Jessica Richard\'s SSN', columns)).toMatchObject({ allowed: false, code: 'REGULATED_IDENTIFIER_REQUEST' });
    expect(evaluateAnalyticalRequestPolicy('What is the CEO\'s salary?', columns)).toMatchObject({ allowed: false, code: 'INDIVIDUAL_COMPENSATION_REQUEST' });
  });
});
