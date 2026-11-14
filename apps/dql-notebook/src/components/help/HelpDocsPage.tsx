/**
 * HelpDocsPage — the Help & documentation page from "Help Docs Redesign.dc.html".
 *
 * TOC rail with scroll-tracked active section (compares the container's
 * scrollTop to section offsets — never scrollIntoView, so the app shell does
 * not jump), a 680px article with dark code blocks, a purple info callout,
 * the trust-labels grid, troubleshooting cards, and a "Was this helpful?"
 * footer. No image placeholders: a step says what you see instead (D7).
 *
 * Two guides share the layout: the laptop guide (install the CLI, open a
 * folder) and, in the ZLens app for Snowflake, a guide to that app (what it
 * did at first open, grants, the Configurations tab, backups, stop and start).
 */
import React, { useRef, useState } from 'react';
import { Info, MessageCircle } from 'lucide-react';
import { useNotebook } from '../../store/NotebookStore';
import { themes, type Theme } from '../../themes/notebook-theme';
import { useSnowflakeApp } from '../../snowflake-app/snowflake-app-mode';

const CLI_REFERENCE_URL = 'https://github.com/duckcode-ai-labs/zlens/blob/main/docs/reference/cli.md';

/**
 * The rail's outside links. Every target must be a page that exists:
 * questions go to GitHub Discussions (Q&A), bugs to the issue forms, and
 * SUPPORT.md explains the rest (what to include, triage, RFCs).
 */
export const HELP_LINKS = [
  { label: 'Keyboard shortcuts', href: 'https://github.com/duckcode-ai-labs/zlens#readme' },
  { label: 'CLI reference', href: CLI_REFERENCE_URL },
  { label: 'Ask a question', href: 'https://github.com/duckcode-ai-labs/zlens/discussions/categories/q-a' },
  { label: 'Community & support', href: 'https://github.com/duckcode-ai-labs/zlens/blob/main/SUPPORT.md' },
  { label: 'Report an issue', href: 'https://github.com/duckcode-ai-labs/zlens/issues/new/choose' },
] as const;

/** The Snowflake app's rail links: its support page, and how the app is built (public pages, no sign-in). */
export const SNOWFLAKE_APP_HELP_LINKS = [
  { label: 'Support', href: 'https://zlens.app/support.html' },
  { label: 'The app guide (README)', href: 'https://github.com/duckcode-ai-labs/zlens/blob/main/deploy/snowflake-app/app/README.md' },
  { label: 'How the app works', href: 'https://github.com/duckcode-ai-labs/zlens/blob/main/deploy/snowflake-app/ARCHITECTURE.md' },
] as const;

/** The styles a guide's sections are written with. */
interface HelpKit {
  t: Theme;
  para: React.CSSProperties;
  codeBlock: React.CSSProperties;
  comment: React.CSSProperties;
  inlineCode: React.CSSProperties;
  callout: (body: React.ReactNode) => React.ReactNode;
  troubleCard: (title: string, body: React.ReactNode) => React.ReactNode;
  trustLabels: React.ReactNode;
}

interface HelpSection {
  title: string;
  mins: string;
  body: React.ReactNode;
}

interface HelpGuideContent {
  railTitle: string;
  title: string;
  intro: string;
  sections: (kit: HelpKit) => HelpSection[];
  links: ReadonlyArray<{ label: string; href: string }>;
  /** The "Ask about setup" box (the laptop guide's assistant reads the laptop docs). */
  assistant: boolean;
}

export function HelpDocsPage() {
  const snowflakeApp = useSnowflakeApp();
  return <HelpGuide content={snowflakeApp ? SNOWFLAKE_APP_GUIDE : LAPTOP_GUIDE} />;
}

function HelpGuide({ content }: { content: HelpGuideContent }) {
  const { state, dispatch } = useNotebook();
  const t = themes[state.themeMode];
  const [active, setActive] = useState(0);
  const [helpful, setHelpful] = useState<'yes' | 'no' | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const sectionRefs = useRef<Array<HTMLDivElement | null>>([]);

  // Track the section nearest the top of the viewport while scrolling.
  const handleScroll = () => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const top = scroller.scrollTop + 90;
    let current = 0;
    sectionRefs.current.forEach((el, index) => {
      if (el && el.offsetTop <= top) current = index;
    });
    setActive(current);
  };

  // Jump by setting the container scrollTop (per the handoff — not scrollIntoView).
  const goTo = (index: number) => {
    const scroller = scrollerRef.current;
    const el = sectionRefs.current[index];
    if (!scroller || !el) return;
    scroller.scrollTo({ top: Math.max(0, el.offsetTop - 24), behavior: 'smooth' });
  };

  const mono = t.fontMono;
  const codeBlock: React.CSSProperties = { margin: '12px 0 0', border: `1px solid ${t.cellBorder}`, background: '#1e1c26', borderRadius: 10, padding: '13px 16px', fontSize: 12.5, lineHeight: 1.7, fontFamily: mono, color: '#e8e6f0', overflowX: 'auto', whiteSpace: 'pre' };
  const comment: React.CSSProperties = { color: '#8a8d96' };
  const inlineCode: React.CSSProperties = { fontFamily: mono, fontSize: 12, background: 'var(--bg-0)', borderRadius: 4, padding: '1px 5px' };
  const h2 = (num: string, title: string) => (
    <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: '-0.01em', color: t.textPrimary, display: 'flex', alignItems: 'center', gap: 9 }}>
      <span style={{ color: t.textMuted, fontFamily: mono, fontSize: 15 }}>{num}</span>{title}
    </h2>
  );
  const para: React.CSSProperties = { margin: '12px 0 0' };
  const callout = (body: React.ReactNode) => (
    <div style={{ margin: '14px 0 0', display: 'flex', gap: 9, alignItems: 'flex-start', border: '1px solid var(--status-info-border)', background: 'var(--accent-dim)', borderRadius: 10, padding: '11px 13px' }}>
      <Info size={13} color={t.accent} style={{ flexShrink: 0, marginTop: 2 }} />
      <span style={{ fontSize: 12.5, lineHeight: 1.6, color: t.textSecondary }}>{body}</span>
    </div>
  );
  const troubleCard = (title: string, body: React.ReactNode) => (
    <div key={title} style={{ border: '1px solid var(--border-subtle)', borderRadius: 10, background: t.cellBg, padding: '12px 14px' }}>
      <div style={{ fontSize: 13, fontWeight: 650, color: t.textPrimary }}>{title}</div>
      <div style={{ fontSize: 12.5, color: t.textSecondary, marginTop: 4, lineHeight: 1.6 }}>{body}</div>
    </div>
  );
  const trustLabels = (
    <div style={{ margin: '14px 0 0', border: '1px solid var(--border-subtle)', borderRadius: 10, background: t.cellBg, overflow: 'hidden' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr', fontSize: 12.5 }}>
        <div style={{ padding: '9px 13px', borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-1)', fontWeight: 650, color: 'var(--status-success)' }}>Certified</div>
        <div style={{ padding: '9px 13px', borderBottom: '1px solid var(--border-subtle)', color: t.textSecondary }}>Answered from a certified saved query — instant and trusted.</div>
        <div style={{ padding: '9px 13px', borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-1)', fontWeight: 650, color: t.accent }}>From Metrics</div>
        <div style={{ padding: '9px 13px', borderBottom: '1px solid var(--border-subtle)', color: t.textSecondary }}>Built from your Metrics and checked joins.</div>
        <div style={{ padding: '9px 13px', background: 'var(--bg-1)', fontWeight: 650, color: 'var(--status-warning)' }}>AI-generated</div>
        <div style={{ padding: '9px 13px', color: t.textSecondary }}>Fresh SQL grounded in your schema, verified, and clearly labeled.</div>
      </div>
    </div>
  );
  const sections = content.sections({ t, para, codeBlock, comment, inlineCode, callout, troubleCard, trustLabels });
  const setSectionRef = (index: number) => (el: HTMLDivElement | null) => { sectionRefs.current[index] = el; };

  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', overflow: 'hidden', background: 'var(--bg-canvas)', fontFamily: t.font }}>
      {/* TOC rail */}
      <div style={{ width: 'clamp(200px, 18vw, 252px)', flexShrink: 0, borderRight: `1px solid ${t.headerBorder}`, background: t.cellBg, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'auto', padding: '16px 8px' }}>
        <div style={{ padding: '0 10px 8px', fontSize: 10, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: t.textMuted }}>{content.railTitle}</div>
        {sections.map((section, index) => {
          const isActive = active === index;
          return (
            <button
              key={section.title}
              type="button"
              onClick={() => goTo(index)}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6.5px 10px', borderRadius: 7, border: 'none', cursor: 'pointer', textAlign: 'left', fontSize: 12, fontWeight: 550, fontFamily: t.font, width: '100%', background: isActive ? 'var(--accent-dim)' : 'transparent', color: isActive ? t.accent : t.textSecondary }}
            >
              <span style={{ width: 18, height: 18, borderRadius: 5, background: isActive ? t.accent : 'var(--bg-0)', color: isActive ? '#fff' : t.textMuted, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 9.5, fontWeight: 700, flexShrink: 0, fontFamily: mono }}>{String(index + 1).padStart(2, '0')}</span>
              <span style={{ flex: 1 }}>{section.title}</span>
              <span style={{ fontSize: 9.5, color: t.textMuted }}>{section.mins}</span>
            </button>
          );
        })}
        <div style={{ height: 1, background: 'var(--border-subtle)', margin: '12px 10px' }} />
        <div style={{ padding: '0 10px', display: 'flex', flexDirection: 'column', gap: 7, fontSize: 11.5 }}>
          {content.links.map((link) => (
            <a key={link.label} href={link.href} target="_blank" rel="noreferrer" style={{ color: t.accent, textDecoration: 'none' }}>{link.label}</a>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        {content.assistant ? (
          <div style={{ margin: '12px 10px 0', border: '1px solid var(--border-subtle)', borderRadius: 9, background: t.appBg, padding: '10px 11px', fontSize: 11, color: t.textMuted, lineHeight: 1.5 }}>
            Stuck? Ask the assistant — it reads these docs.
            <div>
              <button
                type="button"
                onClick={() => dispatch({ type: 'OPEN_GLOBAL_AI', autoRun: { text: 'Help me finish setting up ZLens — what is left to configure in this workspace?' } })}
                style={{ marginTop: 7, display: 'inline-flex', alignItems: 'center', gap: 5, height: 26, padding: '0 10px', borderRadius: 6, border: `1px solid ${t.cellBorder}`, background: t.cellBg, color: t.accent, fontSize: 11, fontWeight: 650, cursor: 'pointer', fontFamily: t.font }}
              >
                <MessageCircle size={11} strokeWidth={1.75} /> Ask about setup
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {/* Article */}
      <div ref={scrollerRef} onScroll={handleScroll} style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
        <div style={{ width: 'min(680px, 100% - 56px)', margin: '0 auto', padding: '34px 0 80px', fontSize: 14, lineHeight: 1.7, color: t.textSecondary }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: t.accent }}>Guide</div>
          <h1 style={{ margin: '6px 0 0', fontSize: 28, fontWeight: 700, letterSpacing: '-0.02em', color: t.textPrimary, lineHeight: 1.25 }}>{content.title}</h1>
          <div style={{ marginTop: 8, fontSize: 13.5, color: t.textMuted }}>{content.intro}</div>

          {sections.map((section, index) => (
            <div key={section.title} ref={setSectionRef(index)} style={{ marginTop: index === 0 ? 36 : 44 }}>
              {h2(String(index + 1).padStart(2, '0'), section.title)}
              {section.body}
            </div>
          ))}

          <div style={{ marginTop: 44, borderTop: '1px solid var(--border-subtle)', paddingTop: 18, display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 12, color: t.textMuted }}>Was this guide helpful?</span>
            <button type="button" onClick={() => setHelpful('yes')} style={{ height: 26, padding: '0 11px', borderRadius: 999, border: `1px solid ${helpful === 'yes' ? 'var(--status-success)' : t.cellBorder}`, background: helpful === 'yes' ? 'var(--status-success-bg)' : t.cellBg, color: helpful === 'yes' ? 'var(--status-success)' : t.textSecondary, fontSize: 11.5, fontWeight: 600, cursor: 'pointer', fontFamily: t.font }}>Yes</button>
            <button type="button" onClick={() => setHelpful('no')} style={{ height: 26, padding: '0 11px', borderRadius: 999, border: `1px solid ${helpful === 'no' ? 'var(--status-error)' : t.cellBorder}`, background: helpful === 'no' ? 'var(--status-error-bg)' : t.cellBg, color: helpful === 'no' ? 'var(--status-error)' : t.textSecondary, fontSize: 11.5, fontWeight: 600, cursor: 'pointer', fontFamily: t.font }}>Not quite</button>
            <div style={{ flex: 1 }} />
            {helpful ? <span style={{ fontSize: 12, color: t.textMuted }}>Thanks for the feedback.</span> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The laptop guide: install the CLI, open a folder, Guided Setup. */
const LAPTOP_GUIDE: HelpGuideContent = {
  railTitle: 'Getting started',
  title: 'Getting started with ZLens',
  intro: 'From a database file or a dbt project to your first published App — about 20 minutes.',
  links: HELP_LINKS,
  assistant: true,
  sections: ({ t, para, codeBlock, comment, inlineCode, callout, troubleCard, trustLabels }) => [
    {
      title: 'Install and open',
      mins: '3 min',
      body: (
        <>
          <p style={para}>Install the CLI once, then open the folder that holds your data: a database file (DuckDB) or a dbt project.</p>
          <pre style={{ ...codeBlock, margin: '14px 0 0' }}>npm i -g @zlens/cli --allow-scripts=better-sqlite3{'\n'}zlens notebook ./shop</pre>
          <p style={para}>In a folder with no ZLens project, ZLens asks <strong>No ZLens project here. Create one? [Y/n]</strong>. Press Enter: a folder with a database file and no dbt becomes a <strong>Database only</strong> project with a connection to the file; a folder with <span style={inlineCode}>dbt_project.yml</span> becomes a dbt project. The workbench then opens on Guided Setup.</p>
          <p style={para}>Without a terminal, ZLens prints the one command to run instead: <span style={inlineCode}>npx -p @zlens/cli zlens notebook ./shop --yes</span>.</p>
          {callout(<><strong>Requirements:</strong> Node 20, 22, 24 or 26, and a database ZLens can read (a DuckDB file, PostgreSQL, Snowflake and more). A dbt project is optional. Working in one of the sample repositories? Follow its README; it already holds a ZLens project.</>)}
        </>
      ),
    },
    {
      title: 'Guided Setup',
      mins: '4 min',
      body: (
        <>
          <p style={para}>Setup asks where your data model lives and picks the card for you from what the folder holds: <strong>Database only</strong>, <strong>dbt project</strong>, or <strong>Open an existing ZLens project</strong>.</p>
          <ol style={{ margin: '12px 0 0', paddingLeft: 22, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <li><strong>Connect your database.</strong> A database file in the folder is already connected and tested for you; otherwise fill in the form and <strong>Save connection</strong>, which tests before saving.</li>
            <li><strong>Which schemas should ZLens read?</strong> The schemas are listed as soon as the test passes. Tick the ones that hold your tables and click <strong>Apply and synchronize</strong>. Staging and raw schemas wait behind <strong>Show staging tables</strong>. ZLens reads table structure and counts rows to check keys. Sample rows are shown only to you, on this computer. Nothing is sent anywhere unless you turn on value profiles for AI answers.</li>
            <li><strong>Draft my models</strong> drafts your tables and the joins between them, each checked on the data, in a Domain named after your database (you can rename it). Staging copies of a table are left out unless you tick <strong>Show staging tables</strong>. The drafts are kept until you review or discard them in Modeling.</li>
            <li>AI is optional. Finish, and start where you like.</li>
          </ol>
          <p style={para}>Technical settings (index mode, semantic adapters, dbt profile import) are under <strong>Advanced</strong>. Setup remembers where you are: stop the notebook halfway and it opens on the same step next time.</p>
        </>
      ),
    },
    {
      title: 'Run CLI commands',
      mins: '2 min',
      body: (
        <>
          <p style={para}>With the global install, run <span style={inlineCode}>zlens …</span> anywhere. A project-local install puts the executable in <span style={inlineCode}>node_modules/.bin</span>: use the project&apos;s npm scripts or <span style={inlineCode}>npm exec -- zlens</span>.</p>
          <pre style={codeBlock}>zlens doctor          <span style={comment}># project setup and readiness</span>{'\n'}zlens notebook        <span style={comment}># local browser UI</span>{'\n'}zlens sync warehouse  <span style={comment}># read the chosen schemas again</span>{'\n'}zlens sync dbt        <span style={comment}># refresh dbt state (dbt projects)</span>{'\n'}zlens --help</pre>
          <p style={para}>See the <a href={CLI_REFERENCE_URL} target="_blank" rel="noreferrer" style={{ color: t.accent, textDecoration: 'none' }}>complete CLI reference</a> for all commands, flags, examples, and exit codes.</p>
        </>
      ),
    },
    {
      title: 'Build your first App',
      mins: '5 min',
      body: (
        <>
          <p style={para}>Open <strong>Apps → Build new App</strong>, give it a name, and choose its data. The <strong>Data</strong> list shows every table, saved query and Metrics in one place. Data reads <strong>Certified</strong> once someone vouches for it, otherwise <strong>Not certified yet</strong>; tables setup drafted also say <strong>drafted — review in Modeling</strong>.</p>
          <ol style={{ margin: '12px 0 0', paddingLeft: 22, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <li>On a table, click <strong>Check and add</strong>. ZLens checks what one row is and which numbers add up, then adds it with fields.</li>
            <li>On the page, click fields — a number and a date make a line chart, a number and a name make a bar chart, one number makes a KPI.</li>
            <li>Add filters, then <strong>Publish</strong>. Readers see the numbers with who checked the data.</li>
          </ol>
        </>
      ),
    },
    {
      title: 'Create your first saved query',
      mins: '5 min',
      body: (
        <>
          <p style={para}>Saved queries are questions you save once and reuse — &quot;total revenue&quot;, &quot;churn by tier&quot;. Ask answers from certified saved queries before it writes any new SQL, so every saved query you certify makes more answers ones you can trust.</p>
          <ol style={{ margin: '12px 0 0', paddingLeft: 22, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <li>Open <strong>Saved queries</strong> and hit <strong>+</strong>, or start from an Ask AI answer with <em>Save as saved query</em>.</li>
            <li>In the Visual Builder, pick measures and dimensions from the semantic picker — or paste raw SQL and convert it.</li>
            <li>Add parameters (like <span style={inlineCode}>{'${region}'}</span>) so the saved query is reusable.</li>
            <li>Run it, check the result, and <strong>Save draft</strong>. Certification happens in review.</li>
          </ol>
        </>
      ),
    },
    {
      title: 'Ask your first question',
      mins: '3 min',
      body: (
        <>
          <p style={para}>Open <strong>Ask</strong> and type a business question. ZLens answers in a strict order — certified saved queries first, semantic metrics next, generated SQL last — and labels every answer with how it was produced.</p>
          {trustLabels}
          <p style={para}>Click any artifact chip in the chat to inspect the result, chart, DQL, SQL, and the full trust trail. Good answers deserve <em>Save as saved query</em> — that&apos;s how the certified layer grows.</p>
        </>
      ),
    },
    {
      title: 'Share your work',
      mins: '3 min',
      body: (
        <>
          <p style={para}>Everything you author is a file in Git. The <strong>Source control</strong> page walks you through it without git commands: pick changes, describe them in plain words, share to your branch, and open a review request. Nothing reaches main without an approval.</p>
        </>
      ),
    },
    {
      title: 'Troubleshooting',
      mins: '—',
      body: (
        <>
          <div style={{ margin: '14px 0 0', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {troubleCard('“No ZLens project here”', <>Press Enter to create one, or run <span style={inlineCode}>npx -p @zlens/cli zlens notebook &lt;folder&gt; --yes</span>. A folder with a database file becomes Database only; a folder with <span style={inlineCode}>dbt_project.yml</span> becomes a dbt project.</>)}
            {troubleCard('“dbt manifest not found”', <>Run <span style={inlineCode}>dbt parse</span> in the dbt project, then <span style={inlineCode}>zlens sync dbt</span> from its ZLens workspace. ZLens needs a compiled manifest to read lineage.</>)}
            {troubleCard('“zlens: command not found”', <>A project-local install uses <span style={inlineCode}>npm run ...</span> or <span style={inlineCode}>npm exec -- zlens ...</span>. Install the CLI globally only if you want bare <span style={inlineCode}>zlens ...</span> commands.</>)}
            {troubleCard('Connection test fails', <>Check <span style={inlineCode}>zlens doctor</span> and <strong>Settings → Database</strong>. A DuckDB file written by a newer DuckDB (2.x) cannot be opened yet; rebuild it with <span style={inlineCode}>pip install &apos;duckdb&lt;1.5&apos;</span>.</>)}
            {troubleCard('AI answers feel wrong', <>Add a skill with your definitions (&quot;revenue = recognized, not bookings&quot;) and certify more saved queries. Trust labels tell you which route produced each answer.</>)}
          </div>
        </>
      ),
    },
  ],
};

/** The guide in the ZLens app for Snowflake: no install, no Git, no dbt project. */
const SNOWFLAKE_APP_GUIDE: HelpGuideContent = {
  railTitle: 'ZLens in Snowflake',
  title: 'ZLens in your Snowflake account',
  intro: 'What ZLens did when it first opened, how to ask and certify, and how to look after it.',
  links: SNOWFLAKE_APP_HELP_LINKS,
  assistant: false,
  sections: ({ para, codeBlock, inlineCode, callout, troubleCard, trustLabels }) => [
    {
      title: 'What ZLens did first',
      mins: '2 min',
      body: (
        <>
          <p style={para}>ZLens runs inside your Snowflake account, as a Snowflake Native App. It reads only the database your Snowflake admin granted to it, with its own extra-small warehouse. Nothing is sent to the app's provider.</p>
          <p style={para}>When it first opened, ZLens read the tables and views in that database and drafted models: the business entities, their keys and the joins between them. A strip at the top of the page said so while it worked.</p>
          <p style={para}>Nothing is saved until you review the drafts. Open <strong>Modeling</strong> to accept or change them.</p>
        </>
      ),
    },
    {
      title: 'Ask a question',
      mins: '3 min',
      body: (
        <>
          <p style={para}>Open <strong>Ask</strong> and type a business question. ZLens answers in a strict order — certified saved queries first, Metrics next, AI-written SQL last — and labels every answer with how it was produced.</p>
          {trustLabels}
          <p style={para}>Open <strong>How it was answered</strong> under an answer to see each step, the SQL that ran and the checks it passed. When your tables do not hold what a question needs, ZLens says so instead of guessing.</p>
        </>
      ),
    },
    {
      title: 'Certify and build Apps',
      mins: '5 min',
      body: (
        <>
          <p style={para}>A good answer deserves <em>Save as saved query</em>. Saving never certifies: open it in <strong>Saved queries</strong>, check it, and select <strong>Certify</strong>. The next time anyone asks that question, the answer is <strong>Certified</strong>.</p>
          <p style={para}>To share numbers, open <strong>Apps → Build new App</strong>, pick its data (certified saved queries first), add tiles and filters, then <strong>Publish</strong>. Readers see who checked each number.</p>
        </>
      ),
    },
    {
      title: 'Add more data',
      mins: '2 min',
      body: (
        <>
          <p style={para}>ZLens reads one database. To add a schema, or tables created after the last grant, your Snowflake admin runs the grant lines again in a Snowsight worksheet, with your app's name in place of <span style={inlineCode}>ZLENS_APP</span>:</p>
          <pre style={codeBlock}>{'GRANT USAGE ON SCHEMA MY_DB.MY_SCHEMA TO APPLICATION ZLENS_APP;\nGRANT SELECT ON ALL TABLES IN SCHEMA MY_DB.MY_SCHEMA TO APPLICATION ZLENS_APP;\nGRANT SELECT ON ALL VIEWS IN SCHEMA MY_DB.MY_SCHEMA TO APPLICATION ZLENS_APP;'}</pre>
          <p style={para}>Then open <strong>Settings » Database</strong> and select <strong>Apply and synchronize</strong>.</p>
        </>
      ),
    },
    {
      title: 'Settings in Snowsight',
      mins: '2 min',
      body: (
        <>
          <p style={para}>Two things are set outside ZLens, on the app's <strong>Configurations</strong> tab in Snowsight (<strong>Apps</strong>, then this app): the one person who uses ZLens, and an optional stage for backups that outlive the app.</p>
          <p style={para}>AI runs on Anthropic's Claude through Snowflake Cortex, inside Snowflake: model <span style={inlineCode}>claude-sonnet-5</span> unless you name another in <strong>Settings » AI provider</strong>. Ask needs the app to hold the <span style={inlineCode}>SNOWFLAKE.CORTEX_USER</span> database role; <strong>Test</strong> on that page says whether Claude answers.</p>
        </>
      ),
    },
    {
      title: 'Backups',
      mins: '2 min',
      body: (
        <>
          <p style={para}>ZLens backs up its projects once a day, as it stops for the day, and keeps the last 7. See them, take one now, or put one back in <strong>Settings » Backups</strong>. An admin can do the same in SQL:</p>
          <pre style={codeBlock}>{'CALL ZLENS_APP.app_public.backups();\nCALL ZLENS_APP.app_public.back_up_now();\nCALL ZLENS_APP.app_public.restore_backup(\'<name>\');'}</pre>
          {callout(<>These backups are inside the app: uninstalling it removes them. A stage named on the Configurations tab keeps a daily copy outside the app.</>)}
        </>
      ),
    },
    {
      title: 'Stopping and starting',
      mins: '2 min',
      body: (
        <>
          <p style={para}>After 60 minutes with no one using it, ZLens stops by itself, and its projects are kept. Opening it again starts it: about 2 minutes, or 5 to 15 when Snowflake also has to start its compute pool.</p>
          <p style={para}>While it starts, Snowflake shows a short message that the service is not yet running. Wait, then reload once: each reload sends you back to Snowflake's sign-in.</p>
          <p style={para}>Before a meeting, an admin can start it ahead of time, or ask how long is left:</p>
          <pre style={codeBlock}>{'CALL ZLENS_APP.app_public.start_app();\nCALL ZLENS_APP.app_public.app_url();'}</pre>
        </>
      ),
    },
    {
      title: 'Troubleshooting and support',
      mins: '—',
      body: (
        <>
          <div style={{ margin: '14px 0 0', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {troubleCard('“Service is not yet running”', <>ZLens is starting. Wait a few minutes, then reload once. <span style={inlineCode}>CALL ZLENS_APP.app_public.app_url();</span> says how long is left.</>)}
            {troubleCard('“This ZLens app is set up for one person”', <>Only the user named on the app's Configurations tab can open it. Your Snowflake admin can change that name there.</>)}
            {troubleCard('Ask cannot reach Claude', <>Your Snowflake admin grants <span style={inlineCode}>SNOWFLAKE.CORTEX_USER</span> to the app. Then <strong>Settings » AI provider » Test</strong>.</>)}
            {troubleCard('A table is missing', <>Grant it to the app (see <strong>Add more data</strong>), then <strong>Settings » Database » Apply and synchronize</strong>.</>)}
            {troubleCard('Still stuck', <>Write to support through the <strong>Support</strong> link on the left. Say what you did, what you saw, and when.</>)}
          </div>
        </>
      ),
    },
  ],
};
