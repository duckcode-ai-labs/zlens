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

  // Emails and e-mail are the same contact detail as email. The plural and the
  // hyphenated spelling used to pass while the singular was refused.
  it.each([
    'List customers with their emails',
    'Show Jessica\'s emails',
    'What is Jessica Richard\'s e-mail address?',
    'What is Jessica Richard\'s e-mail?',
    'Show the E-Mail of each customer',
    'List contacts with their e-mail addresses',
    'List users and their e-mails',
    'Export the e-mails for every subscriber',
    'Show customer emails',
  ])('blocks emails and e-mail as contact data: %s', (question) => {
    expect(evaluateAnalyticalRequestPolicy(question)).toMatchObject({
      allowed: false,
      code: 'SENSITIVE_PERSONAL_DATA_REQUEST',
    });
  });

  // A count of emails sent, opened or clicked is about messages, not addresses.
  it.each([
    'How many emails did we send in Q3?',
    'Which campaigns sent the most emails?',
    'How many contacts opted out of marketing emails last month?',
    'How many emails were opened last week?',
    'How many emails have been sent per campaign?',
    'What is the number of emails clicked per campaign?',
    'Which customers opened the most emails?',
    'Which newsletter sent more than 10,000 emails?',
    'How many e-mails did we send in October?',
    'How many marketing e-mails were clicked last quarter?',
    'What is the e-mail campaign open rate?',
    'How many contacts opted out of e-mail?',
  ])('allows counts of emails sent, opened or clicked: %s', (question) => {
    expect(evaluateAnalyticalRequestPolicy(question)).toEqual({ allowed: true });
  });

  // Only the count is set aside: an address asked for beside it, one named
  // person or pronoun, or an owned email keeps its personal reading.
  it.each([
    'Which customers opened the most emails, with their email addresses?',
    'Which customers opened the most emails? Show their emails too',
    'How many emails did we send to Jessica Richard?',
    'How many emails did she open?',
    'Which emails did Jessica open?',
    'Show Jessica Richard\'s emails sent last month',
    'List customers with their emails sent',
  ])('still blocks contact data beside an email count: %s', (question) => {
    expect(evaluateAnalyticalRequestPolicy(question)).toMatchObject({
      allowed: false,
      code: 'SENSITIVE_PERSONAL_DATA_REQUEST',
    });
  });

  // A column name is the words it joins: `\b` finds no word edge at an
  // underscore, so `email_address`, `customer_email` and `phone_number` used to
  // pass while "email address" was refused. A hyphen joins words the same way.
  it.each([
    'List customers with their email_address',
    'Show customer_email for each customer',
    'What is Jessica Richard\'s phone_number?',
    'Show the credit_card_number for each customer',
    'List patients with their diagnosis_code',
    'Show home_address for every member',
    'List customers with their zip_code',
    'List customers with their customer_address',
    'Show contact_details for Jessica Richard',
    'Show Jessica Richard\'s credit-card',
  ])('blocks personal data named with underscores or hyphens: %s', (question) => {
    expect(evaluateAnalyticalRequestPolicy(question)).toMatchObject({
      allowed: false,
      code: 'SENSITIVE_PERSONAL_DATA_REQUEST',
    });
  });

  it.each([
    'Show Jessica Richard\'s date-of-birth',
    'List customers with their date_of_birth',
    'List employees with their birth-date',
    'Show customer_ssn for each customer',
    'What is Jessica Richard\'s tax-id?',
    'Does ZLens support showing Jessica Richard\'s date-of-birth with masking?',
  ])('blocks regulated identifiers named with underscores or hyphens: %s', (question) => {
    expect(evaluateAnalyticalRequestPolicy(question)).toMatchObject({
      allowed: false,
      code: 'REGULATED_IDENTIFIER_REQUEST',
    });
  });

  it.each([
    'Show ceo_salary',
    'What is the employee_salary for the CEO?',
    'Show Jessica Richard\'s base_pay',
  ])('blocks one person\'s pay named with underscores: %s', (question) => {
    expect(evaluateAnalyticalRequestPolicy(question)).toMatchObject({
      allowed: false,
      code: 'INDIVIDUAL_COMPENSATION_REQUEST',
    });
  });

  it.each([
    'How does DQL handle date_of_birth masking?',
    'What is the email_open_rate by campaign?',
    'Which campaigns have the highest email_click_rate?',
    'Show total_sales by store_id',
    'What is the average health_score by segment?',
    'What is the average base_salary by department?',
  ])('allows business column names with underscores: %s', (question) => {
    expect(evaluateAnalyticalRequestPolicy(question)).toEqual({ allowed: true });
  });

  // An address is where a person lives or gets mail when the question is about
  // people, with or without "mailing" or "home" in front of it.
  it.each([
    'What is Jessica Richard\'s mailing address?',
    'What is Jessica Richard\'s address?',
    'What is her address?',
    'List customers with their addresses',
    'Show the mailing address of each customer',
    'List customers with their name and address',
    'Show each customer\'s billing address',
    'What is Jessica Richard\'s IP address?',
    'What is the store address for Jessica Richard?',
  ])('blocks a person\'s address: %s', (question) => {
    expect(evaluateAnalyticalRequestPolicy(question)).toMatchObject({
      allowed: false,
      code: 'SENSITIVE_PERSONAL_DATA_REQUEST',
    });
  });

  // An IP, MAC or web address, a store's or an office's address, and "address"
  // as a verb are not where a person lives. Without people in the question, an
  // address is a place's.
  it.each([
    'Which IP addresses had the most failed logins?',
    'List users with their last login IP address',
    'Which web addresses get the most traffic from users?',
    'Show the store address for each customer order',
    'What is the office address of each sales rep?',
    'List stores with their address',
    'Which suppliers have a mailing address in Texas?',
    'How many customers have a mailing address on file?',
    'How should we address churn among customers?',
  ])('allows addresses that are not a person\'s: %s', (question) => {
    expect(evaluateAnalyticalRequestPolicy(question)).toEqual({ allowed: true });
  });

  // Contact details are a phone number, an email and an address under one name.
  it.each([
    'Show Jessica Richard\'s contact details',
    'Show Jessica Richard\'s contact information',
    'List suppliers with their contact info',
  ])('blocks contact details: %s', (question) => {
    expect(evaluateAnalyticalRequestPolicy(question)).toMatchObject({
      allowed: false,
      code: 'SENSITIVE_PERSONAL_DATA_REQUEST',
    });
  });

  it('allows a count of people with contact details on file', () => {
    expect(evaluateAnalyticalRequestPolicy('How many customers have contact details on file?')).toEqual({ allowed: true });
  });

  // An aggregate word beside a list of people does not make the list an
  // aggregate: each customer's email is still asked for.
  it.each([
    'List customers with their emails and total orders',
    'Show each customer\'s email and total spend',
    'List customers with their phone number and average order value',
    'Show the email address and total spend for each customer',
    'What is the phone number and total spend of every customer?',
    'For every member, show their phone number and average claim amount',
    'Show each employee\'s home address and total hours by department',
    'Show me the top 10 customers by total spend with their email addresses',
    'Show all active customers with phone numbers and average basket size',
    'Give me a list of customers with emails and total orders',
    'Show customer emails with total orders',
    'Show customer names, emails and total spend by region',
    'Export users and their phone numbers with total logins',
    'Customers with their emails and total orders',
    'Which customers have the highest total spend, and what are their emails?',
    'Which customer has the highest total spend and what is their phone number?',
    'Who are our top customers by average order value, with their mailing addresses?',
    'List patients with their diagnosis and average length of stay',
  ])('blocks a list of people beside an aggregate: %s', (question) => {
    expect(evaluateAnalyticalRequestPolicy(question)).toMatchObject({
      allowed: false,
      code: 'SENSITIVE_PERSONAL_DATA_REQUEST',
    });
  });

  it.each([
    'List all staff with salary and total compensation by department',
    'Show the employees with the highest total compensation by department',
  ])('blocks a list of people\'s pay beside an aggregate: %s', (question) => {
    expect(evaluateAnalyticalRequestPolicy(question)).toMatchObject({
      allowed: false,
      code: 'INDIVIDUAL_COMPENSATION_REQUEST',
    });
  });

  // A count, a share or an average over people stays answerable, also when it
  // starts with a listing verb, says "each" of a group, or uses "their".
  it.each([
    'How many customers have an email address?',
    'How many customers have verified their phone number?',
    'What percentage of users signed up with their work email?',
    'What do customers with a phone number spend on average?',
    'Show the number of customers with an email address',
    'Give me the total number of customers with a phone number',
    'Show the percentage of customers by gender',
    'What percentage of customers in each customer segment have a phone number on file?',
    'How many members have a home address on file in each region?',
    'Break down the percentage of employees by gender for each department',
    'What is the average length of stay for patients by diagnosis?',
    'Show patient volume by diagnosis with average length of stay',
    'How many different customers bought from the Imaginary Street Press Company in 2025?',
    'Show the average salary by department',
  ])('allows an aggregate over people: %s', (question) => {
    expect(evaluateAnalyticalRequestPolicy(question)).toEqual({ allowed: true });
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
