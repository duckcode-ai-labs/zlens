export const APP_STUDIO_V2_STYLES = `
.dql-studio-v2, .dql-studio-v2-launch, .dql-app-studio-home, .dql-studio-v2-loading { width:100%; min-height:0; color:var(--text-primary); font-family:var(--font-ui); }
.dql-studio-v2, .dql-studio-v2-launch, .dql-studio-v2-loading { height:100%; background:var(--bg-canvas); }
.dql-studio-v2 button, .dql-studio-v2 input, .dql-studio-v2 textarea, .dql-studio-v2 select, .dql-studio-v2-launch button, .dql-studio-v2-launch input, .dql-studio-v2-launch textarea, .dql-app-studio-home button, .dql-app-studio-home input, .dql-app-studio-home textarea, .dql-studio-v2-loading button { font:inherit; color:inherit; }
.dql-studio-v2 button, .dql-studio-v2-launch button, .dql-app-studio-home button, .dql-studio-v2-loading button { cursor:pointer; }
.dql-studio-v2 .icon, .dql-studio-v2-launch .icon, .dql-studio-v2-loading .icon { width:34px; height:34px; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-1); display:inline-flex; align-items:center; justify-content:center; padding:0; }
.dql-studio-v2 .icon:hover, .dql-studio-v2-launch .icon:hover, .dql-studio-v2-loading .icon:hover { background:var(--bg-0); border-color:var(--border-strong); }
.dql-studio-v2 .icon:disabled { opacity:.35; cursor:default; }

.dql-studio-v2-launch { overflow:auto; }
.dql-studio-v2-launch > header { height:66px; padding:0 28px; border-bottom:1px solid var(--border-subtle); display:flex; align-items:center; gap:14px; background:color-mix(in srgb,var(--bg-2) 92%,transparent); position:sticky; top:0; z-index:4; }
.dql-studio-v2-launch > header > div { display:grid; gap:2px; }
.dql-studio-v2-launch > header span { color:var(--text-tertiary); font-size:13px; text-transform:uppercase; letter-spacing:.12em; }
.dql-studio-v2-launch > header strong { font-size:14px; }
.dql-studio-v2-launch > main { width:min(1120px,calc(100% - 48px)); margin:0 auto; padding:64px 0 80px; display:grid; grid-template-columns:minmax(280px,.85fr) minmax(520px,1.35fr); gap:56px; align-items:start; }
.dql-app-studio-home { display:grid; grid-template-columns:minmax(300px,.82fr) minmax(520px,1.18fr); gap:clamp(34px,4vw,62px); align-items:center; padding:44px 0 56px; border-bottom:1px solid var(--border-subtle); }
.dql-app-studio-home .dql-studio-v2-intro { position:static; padding:18px 0; }
.dql-studio-v2-intro { position:sticky; top:120px; padding:18px 0; }
.dql-studio-v2-intro .eyebrow { display:inline-flex; align-items:center; gap:7px; color:var(--accent); font-size:14px; font-weight:600; text-transform:uppercase; letter-spacing:.1em; }
.dql-studio-v2-intro h1 { font-size:clamp(38px,4.3vw,62px); line-height:1.02; letter-spacing:-.05em; margin:22px 0; max-width:650px; }
.dql-studio-v2-intro p { color:var(--text-secondary); font-size:16px; line-height:1.65; max-width:490px; }
.dql-studio-v2-start-card { background:var(--bg-2); border:1px solid var(--border-default); border-radius:12px; padding:26px; box-shadow:0 18px 54px color-mix(in srgb,var(--text-primary) 7%,transparent); display:grid; gap:22px; }
.mode-switch { background:var(--bg-0); border-radius:12px; padding:4px; display:grid; grid-template-columns:1fr 1fr; gap:4px; }
.mode-switch button { border:0; border-radius:8px; background:transparent; padding:11px 10px; color:var(--text-secondary); display:flex; align-items:center; justify-content:center; gap:8px; font-size:13px; font-weight:600; white-space:nowrap; }
.mode-switch button.on { background:var(--bg-2); color:var(--text-primary); box-shadow:0 1px 5px color-mix(in srgb,var(--text-primary) 10%,transparent); }
.primary-field { display:grid; gap:8px; }
.primary-field > span, .launch-label { font-size:14px; font-weight:600; color:var(--text-secondary); }
.primary-field textarea, .primary-field input { width:100%; box-sizing:border-box; border:1px solid var(--border-default); background:var(--bg-1); border-radius:12px; padding:14px; resize:vertical; outline:none; line-height:1.5; }
.primary-field textarea:focus, .primary-field input:focus { border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-dim); }
.ai-launch-explainer { display:flex; align-items:flex-start; gap:10px; border:1px solid color-mix(in srgb,var(--accent) 24%,var(--border-default)); background:color-mix(in srgb,var(--accent-dim) 36%,var(--bg-2)); border-radius:12px; padding:12px; }
.ai-launch-explainer > span { width:32px; height:32px; flex:none; border-radius:8px; display:grid; place-items:center; color:var(--accent); background:var(--bg-2); }
.ai-launch-explainer > div { display:grid; gap:3px; }
.ai-launch-explainer strong { font-size:13px; line-height:1.35; }
.ai-launch-explainer small { color:var(--text-tertiary); font-size:13px; line-height:1.45; }
.ai-launch-connect { display:grid; gap:10px; border:1px solid var(--border-default); background:var(--bg-2); border-radius:12px; padding:14px; }
.ai-launch-connect strong { font-size:14px; line-height:1.35; color:var(--text-primary); }
.ai-launch-connect p { margin:0; color:var(--text-secondary); font-size:13px; line-height:1.45; }
.ai-launch-connect-actions { display:flex; flex-wrap:wrap; gap:8px; }
.ai-launch-connect-actions button { border:1px solid var(--border-default); background:var(--bg-1); color:var(--text-primary); border-radius:8px; padding:7px 12px; font-size:13px; font-weight:600; cursor:pointer; }
.ai-launch-connect-actions button.primary { border-color:var(--accent); background:var(--accent); color:var(--accent-fg); }
.studio-ai-connect { display:grid; gap:8px; border:1px solid var(--border-default); background:var(--bg-2); border-radius:8px; padding:12px; color:var(--text-secondary); font-size:12px; line-height:1.45; }
.studio-ai-connect strong { color:var(--text-primary); font-size:13px; }
.studio-ai-connect button { justify-self:start; border:1px solid var(--accent); background:var(--accent); color:var(--accent-fg); border-radius:8px; padding:6px 11px; font-size:12px; font-weight:600; cursor:pointer; }
.data-step-provenance button.link, .proposal-planner-provenance button.link, .ai-launch-explainer button.link { padding:0; border:0; background:transparent; color:var(--accent); font:inherit; cursor:pointer; text-decoration:underline; }
.launch-options { border:1px solid var(--border-subtle); border-radius:12px; background:var(--bg-1); overflow:hidden; }
.launch-options > summary { list-style:none; min-height:44px; padding:0 13px; display:grid; grid-template-columns:auto 1fr auto; align-items:center; gap:9px; cursor:pointer; color:var(--text-secondary); font-size:13px; }
.launch-options > summary::-webkit-details-marker { display:none; }
.launch-options > summary strong { justify-self:end; color:var(--text-primary); font-size:13px; }
.launch-options > summary svg { transition:transform .15s; }
.launch-options[open] > summary { border-bottom:1px solid var(--border-subtle); }
.launch-options[open] > summary svg { transform:rotate(180deg); }
.launch-options .template-grid { padding:12px; }
.template-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
.template-grid button { border:1px solid var(--border-subtle); background:var(--bg-1); border-radius:12px; padding:14px; text-align:left; display:grid; grid-template-columns:28px 1fr; gap:3px 8px; }
.template-grid button > span { grid-row:1/3; color:var(--text-tertiary); }
.template-grid button strong { font-size:13px; }
.template-grid button small { color:var(--text-tertiary); line-height:1.35; }
.template-grid button.on { border-color:var(--accent); background:var(--accent-dim); }
.template-grid button.on > span { color:var(--accent); }
.studio-source-policy-row { display:grid; grid-template-columns:1fr; border:1px solid var(--border-subtle); border-radius:12px; background:var(--bg-1); overflow:hidden; }
.studio-source-policy-row > header, .studio-review-toggle { min-width:0; min-height:54px; box-sizing:border-box; padding:11px 13px; display:flex; align-items:center; gap:10px; }
.studio-source-policy-row > header { border-bottom:1px solid var(--border-subtle); }
.studio-source-policy-row p, .studio-review-toggle span { min-width:0; margin:0; display:grid; gap:3px; }
.studio-source-policy-row strong { font-size:13px; line-height:1.3; }
.studio-source-policy-row small { color:var(--text-tertiary); font-size:13px; line-height:1.4; }
.policy-mark { flex:0 0 auto; width:31px; height:31px; border-radius:8px; display:grid; place-items:center; color:var(--accent); background:var(--accent-dim); }
.studio-review-toggle { cursor:pointer; }
.studio-review-toggle input { display:none; }
.studio-review-toggle i { flex:0 0 auto; width:34px; height:20px; border-radius:12px; background:var(--border-strong); position:relative; transition:.15s; }
.studio-review-toggle i:after { content:''; position:absolute; width:14px; height:14px; left:3px; top:3px; border-radius:50%; background:var(--bg-2); transition:.15s; }
.studio-review-toggle input:checked + i { background:var(--accent); }
.studio-review-toggle input:checked + i:after { transform:translateX(14px); }
.studio-review-toggle:has(input:checked) { background:var(--accent-dim); }
.policy-toggle { display:grid; grid-template-columns:1fr 36px 1fr; align-items:center; gap:12px; border:1px solid var(--border-subtle); border-radius:12px; padding:13px; }
.policy-toggle > span { display:grid; grid-template-columns:22px 1fr; align-items:center; }
.policy-toggle span svg { grid-row:1/3; color:var(--accent); }
.policy-toggle b { font-size:14px; }
.policy-toggle small { grid-column:2; color:var(--text-tertiary); font-size:13px; }
.policy-toggle input { display:none; }
.policy-toggle i { width:34px; height:20px; border-radius:12px; background:var(--border-strong); position:relative; }
.policy-toggle i:after { content:''; position:absolute; width:14px; height:14px; left:3px; top:3px; border-radius:50%; background:var(--bg-2); transition:.15s; }
.policy-toggle input:checked + i { background:var(--accent); }
.policy-toggle input:checked + i:after { transform:translateX(14px); }
.launch-action { min-height:46px; border:0; border-radius:12px; background:var(--accent); color:var(--accent-fg) !important; font-weight:600; display:flex; align-items:center; justify-content:center; gap:8px; }
.launch-action:hover { background:var(--accent-hover); }
.launch-action:disabled { opacity:.5; cursor:default; }
.launch-next-step { display:block; margin-top:-13px; color:var(--text-tertiary); font-size:13px; text-align:center; line-height:1.4; }
.recent-drafts { grid-column:2; display:grid; gap:8px; }
.recent-drafts > header { color:var(--text-tertiary); font-size:14px; font-weight:600; display:flex; align-items:center; gap:6px; }
.recent-drafts > button { border:1px solid var(--border-subtle); border-radius:8px; background:var(--bg-1); padding:11px 13px; display:flex; justify-content:space-between; }
.recent-drafts > button span { color:var(--text-tertiary); font-size:13px; }

.dql-studio-v2-loading { position:relative; display:grid; place-items:center; padding:24px; box-sizing:border-box; }
.dql-studio-v2-loading > .icon { position:absolute; top:16px; left:16px; }
.dql-studio-v2-loading > div { width:min(380px,100%); display:grid; justify-items:center; gap:9px; text-align:center; }
.dql-studio-v2-loading .loading-mark { width:46px; height:46px; border-radius:12px; display:grid; place-items:center; color:var(--accent); background:var(--accent-dim); animation:studio-loading-pulse 1.4s ease-in-out infinite; }
.dql-studio-v2-loading strong { margin-top:7px; font-size:16px; }
.dql-studio-v2-loading small { color:var(--text-tertiary); font-size:13px; line-height:1.55; }
.dql-studio-v2-loading > div > button { margin-top:7px; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-1); padding:8px 12px; font-size:13px; font-weight:600; }
.studio-ai-activity-label { min-height:18px; color:var(--accent) !important; font-size:14px !important; font-weight:600; }
.studio-ai-activity-actions { display:flex; justify-content:center; flex-wrap:wrap; gap:7px; }
.dql-studio-v2-loading .studio-ai-activity-actions > button { margin-top:7px; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-1); padding:8px 12px; font-size:13px; font-weight:600; }
.dql-studio-v2-loading .studio-ai-activity-actions > button.primary { border-color:var(--accent); background:var(--accent); color:var(--accent-fg); }
@keyframes studio-loading-pulse { 50% { transform:translateY(-2px); box-shadow:0 8px 24px var(--accent-dim); } }

.dql-studio-v2 { position:relative; display:grid; grid-template-columns:272px minmax(0,1fr) auto; grid-template-rows:52px minmax(0,1fr); overflow:hidden; }
.studio-topbar { grid-column:1/4; height:58px; border-bottom:1px solid var(--border-subtle); background:var(--bg-2); display:grid; grid-template-columns:300px minmax(200px,1fr) auto; align-items:center; z-index:6; }
.studio-brand { height:100%; display:flex; align-items:center; gap:9px; padding:0 12px; border-right:1px solid var(--border-subtle); }
.studio-brand .mark { width:29px; height:29px; border-radius:8px; background:var(--accent-dim); color:var(--accent); display:flex; align-items:center; justify-content:center; }
.studio-brand > div { display:grid; min-width:0; }
.studio-brand input { border:0; background:transparent; font-weight:600; width:145px; outline:none; padding:0; }
.studio-brand small { color:var(--text-tertiary); font-size:13px; max-width:190px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.source-catalog-empty { display:grid; gap:6px; margin:0 0 10px; padding:9px; border:1px solid var(--border-subtle); border-radius:8px; background:var(--bg-1); }
.source-catalog-empty strong { color:var(--text-primary); font-size:13px; }
.source-catalog-empty small { color:var(--text-tertiary); font-size:13px; line-height:1.45; }
.source-catalog-empty code { font-size:12px; }
.source-catalog-empty .primary { justify-self:start; border:0; border-radius:8px; background:var(--accent); color:var(--accent-fg); font:inherit; font-size:13px; font-weight:600; padding:6px 10px; cursor:pointer; }
.source-catalog-empty .primary:disabled { opacity:.55; cursor:default; }
.page-nav { height:100%; display:flex; align-items:center; gap:3px; overflow:auto; padding:0 18px; }
.page-nav > button:not(.icon) { border:0; background:transparent; padding:8px 11px; border-radius:8px; color:var(--text-tertiary); font-size:14px; font-weight:600; white-space:nowrap; }
.page-nav > button.on { background:var(--bg-0); color:var(--text-primary); }
.studio-actions { position:relative; display:flex; align-items:center; gap:6px; padding-right:12px; }
.breakpoints { display:flex; background:var(--bg-0); border-radius:8px; padding:3px; }
.breakpoints button { width:29px; height:27px; border:0; border-radius:8px; background:transparent; display:flex; align-items:center; justify-content:center; color:var(--text-tertiary); }
.breakpoints button.on { background:var(--bg-2); color:var(--accent); box-shadow:0 1px 4px color-mix(in srgb,var(--text-primary) 10%,transparent); }
.studio-actions .publish { border:0; border-radius:8px; background:var(--accent); color:var(--accent-fg); padding:9px 13px; font-size:13px; font-weight:600; white-space:nowrap; display:flex; align-items:center; gap:6px; }
.studio-actions .publish small { padding-left:6px; border-left:1px solid color-mix(in srgb,var(--accent-fg) 34%,transparent); color:inherit; font-size:12px; font-weight:600; }
.studio-actions .preview { border:1px solid var(--border-default); border-radius:8px; background:var(--bg-1); color:var(--text-primary); padding:8px 11px; font-size:13px; font-weight:600; white-space:nowrap; display:flex; align-items:center; gap:6px; }
.studio-actions .preview:hover { border-color:var(--border-strong); background:var(--bg-0); }
.studio-actions .copilot { border:1px solid var(--border-default); border-radius:8px; background:var(--bg-1); color:var(--text-primary); padding:8px 10px; font-size:13px; font-weight:600; white-space:nowrap; display:flex; align-items:center; gap:6px; }
.studio-actions .copilot:hover, .studio-actions .copilot.on { border-color:var(--accent); background:var(--accent-dim); color:var(--accent); }
.studio-overflow-menu { position:absolute; z-index:20; top:43px; right:10px; width:174px; padding:5px; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-2); box-shadow:0 12px 34px color-mix(in srgb,var(--text-primary) 14%,transparent); }
.studio-overflow-menu button { width:100%; border:0; border-radius:8px; background:transparent; color:var(--status-error); padding:9px; display:flex; align-items:center; gap:7px; text-align:left; font-size:13px; font-weight:600; }
.studio-overflow-menu button:hover { background:color-mix(in srgb,var(--status-error) 9%,var(--bg-2)); }

.studio-left, .studio-right { min-height:0; background:var(--bg-2); }
.studio-left { grid-column:1; grid-row:2; border-right:1px solid var(--border-subtle); display:grid; grid-template-columns:64px 1fr; }
.studio-left > nav { border-right:1px solid var(--border-subtle); padding:10px 6px; display:flex; flex-direction:column; gap:5px; }
.studio-left > nav button { border:0; background:transparent; border-radius:8px; padding:8px 3px; min-height:48px; color:var(--text-tertiary); display:flex; flex-direction:column; align-items:center; justify-content:center; gap:4px; font-size:13px; }
.studio-left > nav button.on { background:var(--accent-dim); color:var(--accent); }
.left-content { min-width:0; overflow:auto; padding:14px 11px; }
.mobile-drawer-close { display:none; }
.panel-title { display:flex; align-items:flex-start; justify-content:space-between; margin-bottom:12px; }
.panel-title > div { display:grid; gap:2px; }
.panel-title strong { font-size:13px; }
.panel-title small { font-size:13px; color:var(--text-tertiary); line-height:1.3; }
.panel-title button { width:27px; height:27px; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-1); display:flex; align-items:center; justify-content:center; }
.studio-list, .filter-list, .template-list { display:grid; gap:6px; }
.studio-list > button, .filter-list > button, .template-list > button, .filter-list > div { border:1px solid transparent; background:transparent; border-radius:8px; padding:8px; display:flex; align-items:center; gap:8px; text-align:left; }
.studio-list > button:hover, .filter-list > button:hover, .template-list > button:hover { background:var(--bg-0); }
.studio-list > button.on, .template-list > button.on { border-color:var(--accent); background:var(--accent-dim); }
.studio-list > button > span, .filter-list > button > span, .filter-list > div > span, .template-list > button > span { width:28px; height:28px; flex:none; border-radius:8px; background:var(--bg-0); display:flex; align-items:center; justify-content:center; color:var(--text-tertiary); }
.studio-list button div, .filter-list button div, .filter-list > div div, .template-list button div { min-width:0; display:grid; flex:1; gap:2px; }
.studio-list strong, .filter-list strong, .template-list strong { font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.studio-list small, .filter-list small, .template-list small { font-size:13px; color:var(--text-tertiary); line-height:1.3; }
.filter-workflow { display:grid; gap:5px; border:1px solid var(--border-subtle); background:var(--bg-1); border-radius:8px; padding:9px; margin-bottom:12px; }
.filter-workflow span { display:flex; align-items:center; gap:7px; color:var(--text-secondary); font-size:13px; }
.filter-workflow b { width:18px; height:18px; border-radius:50%; display:inline-flex; align-items:center; justify-content:center; background:var(--accent-dim); color:var(--accent); font-size:12px; }
.filter-workflow small { color:var(--text-tertiary); font-size:12px; line-height:1.4; padding:3px 0 0 25px; }
.filter-remove { width:26px; height:26px; flex:none; border:0; border-radius:8px; background:transparent; color:var(--text-tertiary); display:flex; align-items:center; justify-content:center; }
.filter-remove:hover { background:var(--bg-0); color:var(--status-error); }
.panel-empty.compact { padding:8px 2px; font-size:13px; }
.filter-contract-list { display:grid; gap:7px; }
.filter-contract-list article { display:grid; grid-template-columns:minmax(0,1fr) 28px; align-items:center; border:1px solid var(--border-subtle); border-radius:8px; background:var(--bg-1); overflow:hidden; }
.filter-contract-summary { min-width:0; border:0; background:transparent; padding:9px; display:flex; align-items:center; gap:8px; text-align:left; }
.filter-contract-summary > span { width:30px; height:30px; flex:none; border-radius:8px; display:grid; place-items:center; color:var(--accent); background:var(--accent-dim); }
.filter-contract-summary > div { min-width:0; display:grid; flex:1; gap:1px; }
.filter-contract-summary strong { font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.filter-contract-summary small { color:var(--text-secondary); font-size:12px; }
.filter-contract-summary em { color:var(--text-tertiary); font-size:12px; font-style:normal; }
.filter-contract-summary > svg { color:var(--text-tertiary); flex:none; }
.filter-contract-list article > .filter-remove { margin-right:4px; }
.filter-empty { border:1px dashed var(--border-default); border-radius:12px; padding:17px 13px; display:grid; justify-items:start; gap:6px; background:var(--bg-1); }
.filter-empty > span { width:34px; height:34px; border-radius:8px; display:grid; place-items:center; color:var(--accent); background:var(--accent-dim); }
.filter-empty strong { font-size:13px; }
.filter-empty p { margin:0; color:var(--text-tertiary); font-size:13px; line-height:1.45; }
.filter-empty button, .filter-add-another { min-height:30px; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-2); display:flex; align-items:center; justify-content:center; gap:5px; color:var(--text-primary); font-size:13px; font-weight:600; }
.filter-empty button { margin-top:3px; padding:0 10px; color:var(--accent); border-color:color-mix(in srgb,var(--accent) 36%,var(--border-default)); }
.filter-add-another { width:100%; margin-top:10px; }
.filter-field-search { height:38px; border:1px solid var(--border-default); border-radius:8px; padding:0 9px; display:flex; align-items:center; gap:7px; color:var(--text-tertiary); background:var(--bg-1); }
.filter-field-search:focus-within { border-color:var(--accent); box-shadow:0 0 0 2px var(--accent-dim); }
.filter-field-search input { min-width:0; flex:1; border:0; outline:0; background:transparent; color:var(--text-primary); font-size:13px; }
.filter-field-results { display:grid; gap:6px; margin-top:9px; }
.filter-field-results > button { width:100%; border:1px solid var(--border-subtle); border-radius:8px; padding:8px; background:var(--bg-1); display:flex; align-items:center; gap:8px; text-align:left; }
.filter-field-results > button:hover { border-color:var(--accent); background:var(--accent-dim); }
.filter-field-results > button > span { width:29px; height:29px; flex:none; border-radius:8px; display:grid; place-items:center; color:var(--accent); background:var(--bg-2); }
.filter-field-results > button > div { min-width:0; display:grid; flex:1; gap:1px; }
.filter-field-results strong { font-size:13px; }
.filter-field-results small { color:var(--text-secondary); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.filter-field-results em { color:var(--text-tertiary); font-size:11px; font-style:normal; }
.filter-field-results > button > svg { color:var(--text-tertiary); transform:rotate(-90deg); }
.filter-builder { display:grid; gap:11px; }
.filter-builder > label { display:grid; gap:5px; }
.filter-builder > label > span, .filter-builder legend { color:var(--text-secondary); font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:.06em; }
.filter-builder > label > input, .filter-builder > label > select { width:100%; height:35px; border:1px solid var(--border-default); border-radius:8px; padding:0 9px; outline:0; color:var(--text-primary); background:var(--bg-1); font-size:13px; }
.filter-builder > label > input:focus, .filter-builder > label > select:focus { border-color:var(--accent); box-shadow:0 0 0 2px var(--accent-dim); }
.filter-availability { border:1px solid var(--border-subtle); border-radius:8px; padding:8px; display:grid; grid-template-columns:27px minmax(0,1fr) auto; align-items:center; gap:8px; background:var(--bg-1); }
.filter-availability > span { width:27px; height:27px; border-radius:8px; display:grid; place-items:center; color:var(--text-tertiary); background:var(--bg-0); }
.filter-availability > div { min-width:0; display:grid; gap:2px; }
.filter-availability strong { font-size:13px; }
.filter-availability small { color:var(--text-tertiary); font-size:12px; line-height:1.35; }
.filter-availability button { min-height:29px; border:1px solid var(--border-default); border-radius:8px; padding:0 8px; display:flex; align-items:center; gap:4px; background:var(--bg-2); color:var(--text-secondary); font-size:12px; font-weight:600; }
.filter-availability.ready { border-color:color-mix(in srgb,var(--status-success) 24%,var(--border-default)); background:color-mix(in srgb,var(--status-success) 5%,var(--bg-2)); }
.filter-availability.ready > span { color:var(--status-success); background:color-mix(in srgb,var(--status-success) 10%,var(--bg-2)); }
.filter-availability.empty { border-color:color-mix(in srgb,var(--status-warning) 32%,var(--border-default)); background:color-mix(in srgb,var(--status-warning) 5%,var(--bg-2)); }
.filter-availability.empty > span { color:var(--status-warning); background:color-mix(in srgb,var(--status-warning) 10%,var(--bg-2)); }
.filter-builder-field { border:1px solid color-mix(in srgb,var(--accent) 28%,var(--border-default)); border-radius:8px; padding:8px; background:var(--accent-dim); display:flex; align-items:center; gap:8px; }
.filter-builder-field > span { width:29px; height:29px; flex:none; border-radius:8px; display:grid; place-items:center; color:var(--accent); background:var(--bg-2); }
.filter-builder-field > div { min-width:0; display:grid; flex:1; gap:1px; }
.filter-builder-field small { color:var(--text-tertiary); font-size:11px; font-weight:600; letter-spacing:.07em; }
.filter-builder-field strong { font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.filter-builder-field button { border:0; background:transparent; color:var(--accent); font-size:12px; font-weight:600; }
.filter-builder fieldset { min-width:0; margin:0; padding:0; border:0; display:grid; gap:6px; }
.filter-builder fieldset > small { color:var(--text-tertiary); font-size:12px; line-height:1.4; }
.filter-scope-switch { display:grid; grid-template-columns:1fr 1.35fr; gap:3px; border-radius:8px; padding:3px; background:var(--bg-0); }
.filter-scope-switch button { min-height:30px; border:0; border-radius:8px; background:transparent; color:var(--text-tertiary); font-size:12px; font-weight:600; }
.filter-scope-switch button.on { background:var(--bg-2); color:var(--text-primary); box-shadow:0 1px 3px color-mix(in srgb,var(--text-primary) 10%,transparent); }
.filter-mapping { border:1px solid var(--border-subtle) !important; border-radius:8px; padding:9px !important; background:var(--bg-1); }
.filter-mapping legend { padding:0 4px; }
.filter-mapping > header { display:flex; align-items:center; justify-content:space-between; gap:6px; }
.filter-mapping > header span { color:var(--text-tertiary); font-size:12px; }
.filter-mapping > header button { border:0; background:transparent; color:var(--accent); font-size:12px; font-weight:600; }
.filter-mapping > div { max-height:300px; overflow:auto; display:grid; gap:8px; }
.filter-mapping > div > section { display:grid; gap:4px; }
.filter-mapping > div > section > small { padding:3px 2px 1px; color:var(--text-secondary); font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:.06em; }
.filter-mapping .filter-mapping-hint { color:var(--text-tertiary); font-size:11px; line-height:1.35; }
.filter-mapping-row { min-width:0; border:1px solid var(--border-subtle); border-radius:8px; padding:7px; display:grid; gap:6px; background:var(--bg-2); }
.filter-mapping-row.applies { border-color:color-mix(in srgb,var(--accent) 42%,var(--border-default)); background:var(--accent-dim); }
.filter-mapping-row.unsupported { background:var(--bg-0); }
.filter-mapping-row > span { min-width:0; display:grid; gap:1px; }
.filter-date-field-options { display:flex; flex-wrap:wrap; gap:4px; margin-top:4px; }
.filter-date-field-options button, .filter-date-field-clear { justify-self:start; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-1); color:var(--accent); font-size:12px; font-weight:600; padding:3px 7px; cursor:pointer; }
.filter-date-field-clear { margin-top:4px; border:0; background:none; padding:0; color:var(--text-tertiary); font-weight:500; }
.filter-mapping-row strong { font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.filter-mapping-row small { color:var(--text-tertiary); font-size:11px; line-height:1.3; overflow-wrap:anywhere; }
.filter-applies-switch { display:grid; grid-template-columns:1fr 1.4fr; gap:3px; border-radius:8px; padding:2px; background:var(--bg-0); }
.filter-applies-switch button { min-height:24px; border:0; border-radius:8px; background:transparent; color:var(--text-tertiary); font-size:11px; font-weight:600; display:inline-flex; align-items:center; justify-content:center; gap:4px; }
.filter-applies-switch button.on { background:var(--bg-2); color:var(--text-primary); box-shadow:0 1px 3px color-mix(in srgb,var(--text-primary) 10%,transparent); }
.filter-mapping-row.applies .filter-applies-switch button.on { color:var(--accent); }
.filter-applies-switch button:disabled { opacity:.45; cursor:not-allowed; }
.filter-required { grid-template-columns:15px minmax(0,1fr) !important; align-items:start; gap:7px !important; }
/* Filter link suggestions (D10): other Datasets with the same field, unchecked. */
.filter-link-suggestions { border:1px dashed color-mix(in srgb,var(--accent) 40%,var(--border-default)) !important; border-radius:8px; padding:9px !important; background:var(--bg-1); }
.filter-link-suggestions legend { padding:0 4px; font-size:13px; font-weight:600; color:var(--text-primary); text-transform:none; letter-spacing:0; }
.filter-link-suggestions label { min-width:0; border:1px solid var(--border-subtle); border-radius:8px; padding:7px; display:grid; grid-template-columns:15px minmax(0,1fr); align-items:center; gap:6px; background:var(--bg-2); cursor:pointer; }
.filter-link-suggestions label:has(input:checked) { border-color:color-mix(in srgb,var(--accent) 42%,var(--border-default)); background:var(--accent-dim); }
.filter-link-suggestions label > input { width:13px; height:13px; accent-color:var(--accent); }
.filter-link-suggestions label > span { min-width:0; display:grid; gap:1px; }
.filter-link-suggestions label strong { font-size:13px; line-height:1.35; overflow-wrap:anywhere; }
.filter-link-suggestions label small { color:var(--text-tertiary); font-size:11px; }
.filter-required > input { width:14px !important; height:14px !important; padding:0 !important; accent-color:var(--accent); }
.filter-required > span { display:grid; gap:1px; text-transform:none !important; letter-spacing:0 !important; }
.filter-required strong { font-size:13px; }
.filter-required small { color:var(--text-tertiary); font-size:12px; font-weight:500; }
.filter-builder-actions { display:grid; grid-template-columns:1fr 1.5fr; gap:6px; padding-top:2px; }
.filter-builder-actions button { min-height:34px; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-2); color:var(--text-secondary); font-size:13px; font-weight:600; }
.filter-builder-actions button.primary { border-color:var(--accent); background:var(--accent); color:var(--accent-fg); }
.filter-builder-actions button:disabled { opacity:.45; cursor:not-allowed; }
.source-search-primary { position:sticky; top:-14px; z-index:3; display:grid; grid-template-columns:16px minmax(0,1fr) 24px; align-items:center; gap:7px; min-height:41px; margin:-3px 0 10px; padding:0 8px; border:1px solid var(--border-default); border-radius:8px; color:var(--text-tertiary); background:var(--bg-2); box-shadow:0 8px 16px color-mix(in srgb,var(--bg-2) 76%,transparent); }
.source-search-primary:focus-within { border-color:var(--accent); box-shadow:0 0 0 2px var(--accent-dim),0 8px 16px color-mix(in srgb,var(--bg-2) 76%,transparent); }
.source-search-primary input { min-width:0; width:100%; border:0; outline:0; background:transparent; color:var(--text-primary); font-size:13px; }
.source-search-primary input::placeholder { color:var(--text-muted); }
.source-search-primary button { width:24px; height:24px; border:0; border-radius:8px; display:grid; place-items:center; color:var(--text-tertiary); background:transparent; }
.source-search-primary button:hover { color:var(--text-primary); background:var(--bg-0); }
.used-sources-disclosure { margin:0 0 10px; border:1px solid var(--border-subtle); border-radius:8px; background:var(--bg-1); overflow:hidden; }
.used-sources-disclosure summary { min-height:43px; padding:8px 9px; display:grid; grid-template-columns:minmax(0,1fr) auto 15px; align-items:center; gap:7px; cursor:pointer; list-style:none; }
.used-sources-disclosure summary::-webkit-details-marker { display:none; }
.used-sources-disclosure summary > div { display:grid; gap:1px; }
.used-sources-disclosure summary strong { font-size:13px; }
.used-sources-disclosure summary small { color:var(--text-tertiary); font-size:12px; }
.used-sources-disclosure summary > span { min-width:21px; height:20px; padding:0 6px; border-radius:8px; display:grid; place-items:center; background:var(--bg-0); color:var(--text-secondary); font-size:12px; font-weight:600; }
.used-sources-disclosure summary > svg { color:var(--text-tertiary); transition:transform .14s ease; }
.used-sources-disclosure[open] summary > svg { transform:rotate(180deg); }
.used-sources-disclosure[open] summary { border-bottom:1px solid var(--border-subtle); }
.used-sources-disclosure .used-source-list, .used-sources-disclosure .source-panel-state { margin:0; padding:7px; }
.source-catalog-toolbar { min-width:0; display:grid; grid-template-columns:minmax(0,1fr); gap:5px; margin:10px 0 8px; }
.source-catalog-toolbar > small { min-width:0; justify-self:end; color:var(--text-muted); font-size:12px; text-align:right; }
.source-view-tabs { min-width:0; width:100%; box-sizing:border-box; display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:3px; padding:3px; border-radius:8px; background:var(--bg-0); }
.source-view-tabs button { min-width:0; min-height:25px; padding:0 3px; border:0; border-radius:8px; color:var(--text-tertiary); background:transparent; font-size:12px; font-weight:600; }
.source-view-tabs button.on { color:var(--text-primary); background:var(--bg-2); box-shadow:0 1px 3px color-mix(in srgb,var(--text-primary) 10%,transparent); }
.source-catalog-list { display:grid; gap:6px; }
.source-catalog-row { display:grid; grid-template-columns:minmax(0,1fr); border:1px solid var(--border-subtle); border-radius:8px; background:var(--bg-2); overflow:hidden; }
.source-catalog-row:hover { border-color:var(--border-default); background:var(--bg-1); }
.source-catalog-row.on { border-color:var(--accent); background:color-mix(in srgb,var(--accent-dim) 42%,var(--bg-2)); }
.source-catalog-summary { min-width:0; width:100%; border:0; background:transparent; padding:8px 8px 5px; display:flex; align-items:center; gap:8px; text-align:left; }
.source-catalog-summary > span { width:29px; height:29px; flex:none; border-radius:8px; background:var(--bg-1); display:flex; align-items:center; justify-content:center; }
.source-catalog-summary > span.certified, .studio-source-ready .certified { color:var(--status-success); background:color-mix(in srgb,var(--status-success) 10%,var(--bg-1)); }
.source-catalog-summary > span.review { color:var(--status-warning); background:color-mix(in srgb,var(--status-warning) 9%,var(--bg-1)); }
.source-catalog-summary > div { min-width:0; display:grid; gap:2px; }
.source-catalog-summary strong { font-size:13px; line-height:1.22; white-space:normal; overflow-wrap:break-word; }
.source-catalog-summary small { color:var(--text-tertiary); font-size:12px; line-height:1.3; }
.source-add-view { min-height:28px; margin:0 8px 8px 45px; padding:5px 8px; border:1px solid color-mix(in srgb,var(--accent) 34%,var(--border-default)); border-radius:8px; background:var(--bg-2); color:var(--accent) !important; display:flex; align-items:center; justify-content:center; gap:4px; white-space:normal; line-height:1.25; font-size:12px; font-weight:600; }
.source-add-view:hover { background:var(--accent-dim); border-color:var(--accent); }
.source-add-view:disabled, .source-view-options button:disabled, .content-quick-add button:disabled { cursor:wait; opacity:.5; }
.source-action-feedback { margin:-3px 8px 8px 45px; color:var(--text-tertiary); font-size:12px; line-height:1.35; overflow-wrap:anywhere; }
.source-action-feedback.added { color:var(--status-success); }
.source-action-feedback.error { color:var(--status-error); }
.source-catalog-detail { padding:0 8px 9px 45px; display:grid; gap:7px; }
.source-catalog-detail > p { margin:0; color:var(--text-secondary); font-size:12px; line-height:1.42; }
.source-catalog-detail > span { display:flex; align-items:center; gap:5px; color:var(--text-tertiary); font-size:12px; }
.source-catalog-detail > span svg { color:var(--accent); }
.source-view-options { display:grid; grid-template-columns:repeat(3,1fr); gap:5px; }
.source-view-options button { border:1px solid var(--border-default); background:var(--bg-2); border-radius:8px; padding:6px 3px; display:flex; justify-content:center; align-items:center; gap:4px; font-size:13px; }
.dataset-filter-builder { display:grid; gap:4px; min-width:0; }
.dataset-filter-builder legend { color:var(--text-secondary); font-size:12px; font-weight:600; }
.dataset-builder-mode { display:grid; gap:4px; }
.dataset-builder-mode label { display:flex; align-items:flex-start; gap:6px; padding:3px 1px; }
.dataset-builder-mode input { width:auto; margin:2px 0 0; }
.dataset-builder-mode span { display:grid; gap:1px; min-width:0; }
.dataset-builder-mode strong { color:var(--text-primary); font-size:12px; }
.dataset-builder-mode small { color:var(--text-tertiary); font-size:11px; line-height:1.35; }
.dataset-detail-columns { display:grid; gap:5px; }
.dataset-detail-columns > small { color:var(--text-tertiary); font-size:11px; line-height:1.35; }
.dataset-detail-columns > div { display:grid; gap:3px; max-height:112px; overflow:auto; }
.dataset-detail-columns > div label { display:grid; grid-template-columns:auto minmax(0,1fr) auto; align-items:center; gap:5px; color:var(--text-primary); font-size:12px; }
.dataset-detail-columns input[type="checkbox"] { width:auto; margin:0; }
.dataset-detail-columns em { color:var(--text-tertiary); font-size:11px; font-style:normal; }
.dataset-detail-limit { display:grid; grid-template-columns:minmax(0,1fr) 76px; gap:6px; align-items:center; color:var(--text-secondary); font-size:12px; }
.dataset-measure-list { display:grid; gap:3px; max-height:106px; overflow:auto; }
.dataset-measure-list label { display:flex; align-items:center; gap:6px; padding:3px 1px; }
.dataset-measure-list input { width:auto; margin:0; }
.dataset-measure-list span { display:grid; gap:1px; min-width:0; }
.dataset-measure-list strong { color:var(--text-primary); font-size:12px; }
.dataset-measure-list small { color:var(--text-tertiary); font-size:11px; }
.dataset-comparison-builder { display:grid; gap:6px; }
.dataset-comparison-builder > legend { color:var(--text-secondary); font-size:12px; font-weight:600; }
.dataset-comparison-toggle { display:flex; align-items:flex-start; gap:6px; cursor:pointer; }
.dataset-comparison-toggle input { width:auto; margin:2px 0 0; }
.dataset-comparison-toggle span { display:grid; gap:1px; min-width:0; }
.dataset-comparison-toggle strong { color:var(--text-primary); font-size:12px; }
.dataset-comparison-toggle small, .dataset-comparison-summary { color:var(--text-tertiary); font-size:11px; line-height:1.35; }
.dataset-comparison-fields { display:grid; grid-template-columns:1fr 1fr; gap:5px; }
.dataset-comparison-fields > label, .dataset-comparison-periods label, .dataset-comparison-advanced label { display:grid; gap:3px; color:var(--text-secondary); font-size:11px; }
.dataset-comparison-fields > label span, .dataset-comparison-periods label span, .dataset-comparison-advanced label span { font-weight:600; }
.dataset-comparison-periods { grid-column:1/-1; display:grid; grid-template-columns:1fr 1fr; gap:5px; }
.dataset-comparison-advanced { grid-column:1/-1; border-top:1px solid var(--border-subtle); padding-top:5px; }
.dataset-comparison-advanced summary { color:var(--text-secondary); cursor:pointer; font-size:11px; }
.tile-query-editor { display:grid; gap:7px; min-width:0; }
.tile-query-editor select, .tile-query-editor input:not([type=checkbox]):not([type=radio]) { min-width:0; width:100%; box-sizing:border-box; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-1); color:var(--text-primary); padding:5px 6px; font:inherit; font-size:13px; }
.tile-query-editor fieldset { min-width:0; margin:0; padding:6px; border:1px solid var(--border-subtle); border-radius:8px; display:grid; gap:4px; }
.tile-query-editor legend, .dataset-editor-row label > span { color:var(--text-secondary); font-size:12px; font-weight:600; }
.tile-query-editor fieldset > small { color:var(--text-tertiary); font-size:11px; }
.dataset-editor-row { display:grid; grid-template-columns:repeat(auto-fit,minmax(90px,1fr)); gap:6px; align-items:end; }
.dataset-editor-row label { display:grid; gap:3px; min-width:0; }
.dataset-sort-direction { display:inline-flex; align-items:center; justify-content:center; gap:4px; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-1); color:var(--text-secondary); font:inherit; font-size:12px; padding:5px 6px; cursor:pointer; }
.dataset-sort-direction:disabled { opacity:.5; cursor:default; }
.dataset-measure-list label.is-suggested { opacity:.62; }
.dataset-field-badge { margin-left:auto; flex:none; border-radius:999px; padding:1px 6px; background:var(--bg-0); color:var(--text-tertiary); font-size:11px; font-style:normal; font-weight:600; }
.dataset-live-preview { display:grid; gap:4px; padding:6px; border:1px dashed var(--border-default); border-radius:8px; background:var(--bg-1); min-width:0; }
.dataset-live-preview > header { display:flex; align-items:center; gap:6px; }
.dataset-live-preview > header strong { color:var(--text-primary); font-size:12px; }
.dataset-live-preview > header small { color:var(--text-tertiary); font-size:11px; }
.dataset-live-preview > header button { margin-left:auto; display:inline-flex; align-items:center; gap:3px; border:0; background:none; color:var(--accent); font:inherit; font-size:11px; cursor:pointer; }
.dataset-live-preview-note { margin:0; color:var(--text-secondary); font-size:11px; }
.dataset-live-preview-table { overflow-x:auto; }
.dataset-live-preview-table table { width:100%; border-collapse:collapse; font-size:12px; }
.dataset-live-preview-table th, .dataset-live-preview-table td { text-align:left; padding:2px 4px; border-bottom:1px solid var(--border-subtle); white-space:nowrap; }
.dataset-live-preview-table th { color:var(--text-secondary); font-weight:600; }
.dataset-live-preview-table td { color:var(--text-primary); font-variant-numeric:tabular-nums; }
.dataset-live-preview-table small { color:var(--text-tertiary); font-size:11px; }
.dataset-link-hint { display:flex; flex-wrap:wrap; align-items:center; gap:6px; margin-top:4px; padding:4px 6px; border-radius:8px; background:var(--accent-dim); color:var(--text-secondary); font-size:12px; }
.dataset-link-hint button { border:0; background:none; color:var(--accent); font:inherit; font-weight:600; cursor:pointer; padding:0; }
.dataset-comparison-advanced[open] { display:grid; gap:5px; }
.dataset-comparison-advanced[open] summary { margin-bottom:1px; }
.dataset-comparison-advanced label { grid-template-columns:70px minmax(0,1fr); align-items:center; }
.dataset-comparison-summary { grid-column:1/-1; margin:0; }
.dataset-filter-builder > div { display:flex; gap:4px; min-width:0; }
.dataset-filter-builder > div > * { min-width:0; flex:1; }
.dataset-filter-builder > div > button { flex:0 0 auto; padding:4px 6px; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-1); color:var(--accent); display:flex; align-items:center; gap:3px; font-size:12px; font-weight:600; }
.dataset-filter-chips { display:flex; flex-wrap:wrap; gap:3px; }
.dataset-filter-chips button { border:1px solid var(--border-default); border-radius:99px; padding:3px 5px; color:var(--text-secondary); background:var(--bg-1); display:flex; align-items:center; gap:3px; font-size:11px; }
.dataset-builder-error { color:var(--status-error); font-size:12px; line-height:1.35; }
.dataset-query-inspector { display:grid; gap:8px; padding:9px; border:1px solid var(--border-subtle); border-radius:8px; background:var(--bg-2); }
.dataset-query-inspector > label { color:var(--text-tertiary); font-size:13px; text-transform:uppercase; letter-spacing:.09em; font-weight:600; }
.dataset-query-inspector > p { margin:0; color:var(--text-secondary); font-size:13px; line-height:1.4; }
.dataset-inspector-measures { display:grid; gap:4px; max-height:136px; overflow:auto; }
.dataset-inspector-measures label { display:grid; grid-template-columns:auto minmax(0,1fr) auto; align-items:center; gap:5px; color:var(--text-primary); font-size:13px; text-transform:none; letter-spacing:0; }
.dataset-inspector-measures input { width:auto; margin:0; }
.dataset-inspector-measures small { color:var(--text-tertiary); font-size:12px; text-transform:none; letter-spacing:0; }
.dataset-inspector-row { display:grid; grid-template-columns:70px minmax(0,1fr); gap:6px; align-items:center; }
.dataset-inspector-row > span { color:var(--text-tertiary); font-size:13px; }
.dataset-inspector-row select, .dataset-inspector-filters select, .dataset-inspector-filters input { width:100%; min-width:0; box-sizing:border-box; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-1); color:var(--text-primary); padding:6px; font:inherit; font-size:13px; }
.dataset-inspector-filters { min-width:0; margin:0; padding:7px; border:1px solid var(--border-subtle); border-radius:8px; }
.dataset-inspector-filters legend { color:var(--text-tertiary); font-size:12px; font-weight:600; }
.dataset-inspector-filters > div { display:flex; min-width:0; gap:4px; }
.dataset-inspector-filters > div > * { min-width:0; flex:1; }
.dataset-inspector-filters > div > button { flex:0 0 auto; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-1); color:var(--accent); padding:4px 6px; display:flex; align-items:center; gap:3px; font-size:12px; font-weight:600; }
.dataset-change-source { width:100%; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-1); color:var(--accent); padding:6px; display:flex; align-items:center; justify-content:center; gap:5px; font-size:13px; font-weight:600; }
.dataset-change-source:disabled { color:var(--text-muted); cursor:default; }
.dataset-interaction-inspector { display:grid; gap:7px; padding:9px; border:1px solid var(--border-subtle); border-radius:8px; background:var(--bg-2); }
.dataset-interaction-inspector > label { color:var(--text-tertiary); font-size:13px; text-transform:uppercase; letter-spacing:.09em; font-weight:600; }
.dataset-interaction-inspector > p { margin:0; color:var(--text-secondary); font-size:13px; line-height:1.4; }
.dataset-interaction-form { display:grid; gap:4px; }
.dataset-interaction-form select, .dataset-navigation-form select { width:100%; min-width:0; box-sizing:border-box; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-1); color:var(--text-primary); padding:6px; font:inherit; font-size:13px; }
.dataset-interaction-form button, .dataset-navigation-form button, .dataset-detail-navigation { border:1px solid var(--border-default); border-radius:8px; background:var(--bg-1); color:var(--accent); padding:6px; font-size:12px; font-weight:600; }
.dataset-interaction-form button:disabled, .dataset-navigation-form button:disabled { color:var(--text-muted); cursor:default; }
.dataset-interaction-list { display:flex; flex-wrap:wrap; gap:4px; }
.dataset-interaction-list > span { display:flex; align-items:center; gap:4px; border:1px solid var(--border-subtle); border-radius:99px; background:var(--bg-1); color:var(--text-secondary); padding:3px 5px; font-size:12px; }
.dataset-interaction-list button { display:grid; place-items:center; padding:0; border:0; background:transparent; color:var(--text-tertiary); }
.dataset-navigation-form { display:grid; gap:5px; padding-top:7px; border-top:1px solid var(--border-subtle); }
.dataset-navigation-form > small { color:var(--text-secondary); font-size:12px; font-weight:600; }
.dataset-navigation-form > span { display:flex; gap:4px; }
.dataset-navigation-filters { display:grid; gap:3px; }
.dataset-navigation-filters label { display:flex; align-items:center; gap:5px; color:var(--text-secondary); font-size:12px; }
.dataset-navigation-filters input { width:auto; margin:0; }
.dataset-interaction-message { color:var(--text-tertiary); font-size:12px; line-height:1.35; }
.dataset-dql-receipt { display:grid; gap:5px; margin-top:7px; }
.dataset-dql-receipt summary { cursor:pointer; color:var(--accent); font-size:12px; font-weight:600; }
.dataset-dql-receipt p { margin:0; color:var(--text-tertiary); font-size:12px; line-height:1.35; }
.dataset-dql-receipt pre { max-height:180px; overflow:auto; margin:0; padding:7px; border:1px solid var(--border-subtle); border-radius:8px; background:var(--bg-1); color:var(--text-secondary); font:7.5px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; white-space:pre-wrap; overflow-wrap:anywhere; }
.dataset-execution-evidence { display:grid; gap:5px; }
.dataset-execution-evidence > small { color:var(--text-secondary); font-size:12px; font-weight:600; }
.dataset-evidence-rows { display:grid; gap:3px; margin:0; }
.dataset-evidence-rows > div { display:grid; grid-template-columns:minmax(72px, .7fr) minmax(0, 1.3fr); gap:5px; }
.dataset-evidence-rows dt { color:var(--text-tertiary); font-size:11px; }
.dataset-evidence-rows dd { min-width:0; margin:0; color:var(--text-secondary); font:7.5px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap:anywhere; }
.panel-section-label { display:flex; align-items:baseline; justify-content:space-between; margin:14px 2px 7px; gap:8px; }
.panel-section-label span { color:var(--text-secondary); font-size:13px; font-weight:600; text-transform:uppercase; letter-spacing:.08em; }
.panel-section-label small { color:var(--text-muted); font-size:12px; }
.source-panel-state { border:1px dashed var(--border-default); border-radius:8px; padding:11px; margin:0 0 8px; display:flex; align-items:flex-start; gap:8px; color:var(--accent); }
.source-panel-state > div { display:grid; gap:3px; }
.source-panel-state strong { color:var(--text-primary); font-size:13px; }
.source-panel-state small { color:var(--text-tertiary); font-size:13px; line-height:1.4; overflow-wrap:anywhere; }
.source-panel-state.error { color:var(--status-error); border-color:color-mix(in srgb,var(--status-error) 34%,var(--border-default)); background:color-mix(in srgb,var(--status-error) 6%,var(--bg-2)); }
.source-panel-state.compact { padding:9px; }
.used-source-list { display:grid; gap:5px; }
.used-source-list > div { border:1px solid var(--border-subtle); background:var(--bg-1); border-radius:8px; padding:7px; display:flex; align-items:center; gap:8px; }
.used-source-list > div > span { width:29px; height:29px; border-radius:8px; flex:none; display:grid; place-items:center; color:var(--status-success); background:color-mix(in srgb,var(--status-success) 9%,var(--bg-2)); }
.used-source-list > div > span.review_required, .used-source-list > div > span.draft_ready { color:var(--status-warning); background:color-mix(in srgb,var(--status-warning) 9%,var(--bg-2)); }
.used-source-list p, .source-review-lane p { min-width:0; margin:0; display:grid; gap:2px; }
.used-source-list strong { font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.used-source-list small, .source-review-lane small { color:var(--text-tertiary); font-size:12px; line-height:1.4; }
.source-review-lane { margin:8px 0 13px; padding:8px; border:1px solid color-mix(in srgb,var(--status-warning) 25%,var(--border-default)); border-radius:8px; background:color-mix(in srgb,var(--status-warning) 6%,var(--bg-2)); color:var(--status-warning); display:flex; align-items:flex-start; gap:7px; }
.source-review-lane strong { color:var(--text-primary); font-size:13px; }
.content-quick-add { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:6px; }
.content-quick-add button { border:1px solid var(--border-subtle); background:transparent; border-radius:8px; padding:8px; display:flex; align-items:center; gap:8px; text-align:left; }
.content-quick-add button:hover { background:var(--bg-0); }
.content-quick-add button > span { flex:1; display:grid; gap:2px; }
.content-quick-add strong { font-size:13px; }
.content-quick-add small { color:var(--text-tertiary); font-size:12px; }
.content-quick-add button > svg:first-child { display:none; }
.content-quick-add button > svg:last-child { color:var(--accent); flex:none; }
.panel-empty { color:var(--text-tertiary); font-size:13px; line-height:1.5; padding:10px; }

.studio-workspace { grid-column:2; grid-row:2; min-width:0; min-height:0; overflow:auto; background:var(--bg-canvas); padding:24px; position:relative; }
.studio-canvas-frame { margin:0 auto; transition:width .18s ease; }
.studio-canvas-frame.wide { width:min(100%,1260px); }
.studio-canvas-frame.medium { width:min(100%,760px); }
.studio-canvas-frame.narrow { width:min(100%,390px); }
.studio-canvas-frame.preview-mode-auto { width:100%; }
.studio-canvas { min-height:calc(100vh - 145px); background:var(--bg-2); border:1px solid var(--border-default); border-radius:12px; box-shadow:0 12px 36px color-mix(in srgb,var(--text-primary) 6%,transparent); padding:28px; }
.studio-page-heading { display:flex; align-items:end; justify-content:space-between; border-bottom:1px solid var(--border-subtle); padding-bottom:17px; margin-bottom:16px; }
.studio-page-heading > div { display:grid; gap:3px; }
.studio-page-heading > div > small { font-size:12px; font-weight:600; letter-spacing:.12em; color:var(--accent); }
.studio-page-heading span { font-size:24px; font-weight:600; letter-spacing:-.025em; }
.studio-page-heading > small { color:var(--text-tertiary); font-size:13px; }
.studio-source-ready { display:flex; align-items:center; justify-content:space-between; gap:12px; border:1px solid color-mix(in srgb,var(--accent) 28%,var(--border-default)); background:color-mix(in srgb,var(--accent-dim) 38%,var(--bg-2)); border-radius:8px; padding:8px 9px; margin-bottom:12px; }
.studio-source-ready > div { display:flex; align-items:center; gap:8px; min-width:0; }
.studio-source-ready > div > span { width:28px; height:28px; border-radius:8px; display:flex; align-items:center; justify-content:center; flex:none; }
.studio-source-ready p { margin:0; display:grid; min-width:0; }
.studio-source-ready p small { color:var(--text-tertiary); font-size:12px; }
.studio-source-ready p strong { font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.studio-source-actions { display:flex; align-items:center; gap:5px; }
.studio-source-actions > button { border:0; background:var(--accent); color:var(--accent-fg) !important; border-radius:8px; padding:7px 9px; display:flex; align-items:center; gap:5px; white-space:nowrap; font-size:13px; font-weight:600; }
.studio-source-actions > .source-clear { width:30px; height:30px; padding:0; justify-content:center; background:var(--bg-1); color:var(--text-secondary) !important; border:1px solid var(--border-default); }
.studio-page-filterbar { display:flex; gap:7px; flex-wrap:wrap; margin-bottom:16px; }
.studio-filter { min-height:36px; border:1px solid var(--border-default); background:var(--bg-1); border-radius:8px; padding:4px 8px; display:grid; gap:1px; }
.studio-filter > span, .studio-filter > label { color:var(--text-tertiary); font-size:12px; font-weight:600; }
.studio-filter input, .studio-filter select { min-width:100px; border:0; outline:0; background:transparent; padding:0; font-size:13px; }
.studio-filter > small { color:var(--text-muted); font-size:11px; line-height:1.2; }
.studio-filter.searchable { min-width:190px; position:relative; }
.studio-filter-combobox { display:flex; align-items:center; gap:5px; color:var(--text-tertiary); font-size:13px; font-weight:500; }
.studio-filter-combobox input { min-width:0; flex:1; color:var(--text-primary); }
.studio-filter-combobox input::-webkit-search-cancel-button { cursor:pointer; }
.studio-filter-combobox svg:last-child { margin-left:auto; flex:none; }
.studio-filter[aria-busy="true"] { border-color:color-mix(in srgb,var(--accent) 45%,var(--border-default)); }
.studio-filter.range { grid-template-columns:1fr auto 1fr; align-items:end; }
.studio-filter.range > span { grid-column:1/-1; }
.studio-filter.range input { min-width:112px; }
.studio-filter.range i { align-self:center; color:var(--text-muted); font-style:normal; }
.studio-filter.range > small { grid-column:1/-1; }
.studio-filter.empty { border-color:color-mix(in srgb,var(--status-warning) 42%,var(--border-default)); background:color-mix(in srgb,var(--status-warning) 5%,var(--bg-2)); }
.studio-filter.empty > small { color:var(--status-warning); }
.studio-filter.boolean { display:flex; align-items:center; gap:6px; }
.studio-filter.boolean input { min-width:0; }
.studio-filter.boolean span { font-size:13px; color:var(--text-secondary); }
.studio-filter.dropdown { min-width:190px; position:relative; padding:0; display:block; }
.studio-filter.dropdown > summary { min-height:36px; padding:5px 8px; list-style:none; cursor:pointer; display:flex; align-items:center; gap:7px; }
.studio-filter.dropdown > summary::-webkit-details-marker { display:none; }
.studio-filter.dropdown > summary > span { min-width:0; display:grid; flex:1; gap:1px; }
.studio-filter.dropdown > summary small { color:var(--text-tertiary); font-size:12px; font-weight:600; }
.studio-filter.dropdown > summary strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--text-primary); font-size:13px; font-weight:600; }
.studio-filter.dropdown > summary > svg { color:var(--text-tertiary); transition:transform .14s ease; }
.studio-filter.dropdown[open] > summary > svg { transform:rotate(180deg); }
.studio-filter-menu { position:absolute; z-index:20; top:calc(100% + 5px); left:0; width:max(220px,100%); max-width:320px; padding:7px; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-2); box-shadow:0 12px 28px color-mix(in srgb,var(--text-primary) 16%,transparent); display:grid; gap:5px; }
.studio-filter-menu > label { min-height:31px; border:1px solid var(--border-default); border-radius:8px; padding:0 7px; display:flex; align-items:center; gap:6px; color:var(--text-tertiary); }
.studio-filter-menu > label:focus-within { border-color:var(--accent); }
.studio-filter-menu > label input { min-width:0; flex:1; border:0; outline:0; background:transparent; color:var(--text-primary); font-size:13px; }
.studio-filter-menu > button, .studio-filter-menu > div > button { width:100%; min-height:28px; border:0; border-radius:8px; padding:5px 7px; background:transparent; color:var(--text-secondary); display:flex; align-items:center; gap:6px; text-align:left; font-size:13px; }
.studio-filter-menu > button:hover, .studio-filter-menu > div > button:hover, .studio-filter-menu > div > button.on { background:var(--accent-dim); color:var(--text-primary); }
.studio-filter-menu > div { max-height:190px; overflow:auto; display:grid; gap:2px; }
.studio-filter-menu > div > button > span:not(.filter-option-check) { min-width:0; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.filter-option-check { width:14px; height:14px; flex:none; border:1px solid var(--border-default); border-radius:4px; display:grid; place-items:center; color:var(--accent-fg); background:var(--bg-2); }
.studio-filter-menu > div > button.on .filter-option-check { border-color:var(--accent); background:var(--accent); }
.studio-filter-menu > small { padding:7px; color:var(--text-muted); font-size:12px; }
.studio-filter-menu footer { border-top:1px solid var(--border-subtle); padding:5px 3px 0; color:var(--text-muted); font-size:11px; }
.studio-page-grid { position:static; display:grid; grid-template-columns:repeat(12,minmax(0,1fr)); gap:12px; align-items:start; pointer-events:auto; background:none; }
.medium .studio-page-grid { grid-template-columns:repeat(6,minmax(0,1fr)); }
.narrow .studio-page-grid { grid-template-columns:1fr; }
.studio-component-card { grid-column:span var(--studio-tile-width); min-height:150px; border:1px solid var(--border-subtle); background:var(--bg-1); border-radius:12px; padding:0; text-align:left; overflow:hidden; }
.narrow .studio-component-card { grid-column:1; }
.studio-component-card:hover { border-color:var(--border-strong); }
.studio-component-card.selected { border-color:var(--accent); box-shadow:0 0 0 2px var(--accent-dim); }
.studio-component-card.dragging { opacity:.55; border-style:dashed; }
.studio-component-card > header { height:38px; padding:0 11px; display:flex; align-items:center; gap:6px; border-bottom:1px solid var(--border-subtle); }
.drag-handle { color:var(--text-muted); cursor:grab; font-size:16px; line-height:1; }
.studio-component-card > header strong { font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.studio-component-card > header small { margin-left:auto; color:var(--text-tertiary); font-size:12px; text-transform:uppercase; }
.studio-autopilot-target { margin-left:auto; border:1px solid var(--border-default); border-radius:4px; padding:3px 5px; background:var(--bg-2); color:var(--text-secondary); font:inherit; font-size:12px; font-weight:600; line-height:1.1; white-space:nowrap; cursor:pointer; }
.studio-autopilot-target:hover { border-color:var(--accent); color:var(--accent); }
.studio-autopilot-target.on { border-color:var(--accent); background:var(--accent-dim); color:var(--accent); }
.studio-autopilot-target + small { margin-left:0; }
.studio-autopilot-selection-hint { display:grid; gap:3px; margin:10px 0; padding:9px 11px; border:1px solid var(--accent); border-radius:8px; background:var(--accent-dim); color:var(--text-secondary); font-size:13px; line-height:1.4; }
.studio-autopilot-selection-hint strong { color:var(--text-primary); font-size:13px; }
.studio-tile-preview-interactions { min-width:0; }
.tile-filter-notice { display:flex; align-items:center; gap:5px; margin:8px 10px 0; padding:6px 8px; border-radius:8px; background:var(--bg-0); color:var(--text-secondary); font-size:13px; line-height:1.35; }
.tile-filter-notice svg { flex:0 0 auto; color:var(--text-tertiary); }
.trust-dot { width:7px; height:7px; border-radius:50%; background:var(--text-muted); display:inline-block; flex:none; }
.trust-dot.certified { background:var(--status-success); }
.trust-dot.review_required { background:var(--status-warning); }
.trust-dot.draft_ready { background:var(--accent); }
.trust-dot.governed { background:var(--trust-governed, #3659c9); }
.tile-heading { padding:22px 16px; font-size:20px; font-weight:600; }
.tile-text { padding:16px; font-size:14px; color:var(--text-secondary); line-height:1.55; }
.preview-kpi { padding:18px; display:grid; gap:4px; }
.preview-kpi strong { font-size:32px; letter-spacing:-.04em; }
.preview-kpi span { color:var(--text-tertiary); font-size:13px; }
.preview-chart { height:120px; padding:18px 18px 12px; display:flex; align-items:end; gap:8px; }
.preview-chart i { flex:1; min-width:5px; background:var(--accent-dim); border:1px solid color-mix(in srgb,var(--accent) 30%,transparent); border-radius:4px 4px 0 0; }
.preview-table { padding:13px; display:grid; gap:7px; }
.preview-table i { display:grid; grid-template-columns:1fr 1.6fr .7fr; gap:8px; }
.preview-table span { height:9px; border-radius:4px; background:var(--bg-3); }
.live-component-preview { height:calc(100% - 39px); min-height:150px; overflow:auto; padding:5px 8px 8px; box-sizing:border-box; cursor:default; }
.live-component-preview > .live-component-body, .live-component-body > div { width:100%; height:100%; }
.dataset-mark-controls { display:flex; flex-wrap:wrap; align-items:center; gap:4px; margin:5px 0 0; padding:5px; border-top:1px solid var(--border-subtle); }
.dataset-mark-controls > span { color:var(--text-tertiary); font-size:11px; font-weight:600; }
.dataset-mark-controls button { border:1px solid var(--border-default); border-radius:99px; background:var(--bg-1); color:var(--text-secondary); padding:3px 5px; font-size:11px; }
.dataset-mark-controls button.on { border-color:var(--accent); background:var(--accent-dim); color:var(--accent); }
.dataset-mark-controls small { width:100%; color:var(--text-muted); font-size:11px; }
.dataset-detail-navigation { margin-top:5px; width:100%; }
.studio-mark-filterbar { display:flex; align-items:center; flex-wrap:wrap; gap:5px; margin:0 0 9px; padding:6px 8px; border:1px solid color-mix(in srgb,var(--accent) 22%,var(--border-default)); border-radius:8px; background:var(--accent-dim); }
.studio-mark-filterbar > span { color:var(--accent); font-size:12px; font-weight:600; }
.studio-mark-filterbar button { display:flex; align-items:center; gap:3px; border:1px solid var(--border-default); border-radius:99px; background:var(--bg-2); color:var(--text-secondary); padding:3px 6px; font-size:12px; }
.studio-mark-filterbar button.clear { margin-left:auto; color:var(--accent); }
.studio-preview-incomplete { display:grid; gap:3px; margin:0 0 9px; padding:7px 9px; border:1px solid var(--border-default); border-radius:8px; background:var(--accent-dim); color:var(--text-secondary); font-size:13px; line-height:1.45; }
.studio-preview-incomplete strong { color:var(--text-primary); font-size:13px; }
.preview-state { min-height:150px; padding:24px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:6px; text-align:center; color:var(--text-tertiary); }
.preview-state strong { color:var(--text-secondary); font-size:13px; }
.preview-state span { max-width:360px; font-size:13px; line-height:1.45; }
.preview-state.error strong { color:var(--status-error); }
.preview-loading-mark, .preview-idle-mark { width:34px; height:34px; border-radius:8px; display:grid; place-items:center; color:var(--accent); background:var(--accent-dim); }
.preview-state.loading .preview-loading-mark { animation:studio-loading-pulse 1.4s ease-in-out infinite; }
.preview-state.idle { min-height:130px; }
.empty-canvas { grid-column:1/-1; min-height:330px; border:1px dashed var(--border-strong); border-radius:12px; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; padding:30px; }
.empty-canvas > span { width:46px; height:46px; border-radius:12px; background:var(--accent-dim); color:var(--accent); display:flex; align-items:center; justify-content:center; }
.empty-canvas strong { margin-top:14px; }
.empty-canvas p { color:var(--text-tertiary); font-size:13px; max-width:320px; }
.empty-canvas button { border:1px solid var(--border-default); border-radius:8px; background:var(--bg-1); padding:8px 12px; font-size:13px; font-weight:600; }
.studio-error { border:1px solid color-mix(in srgb,var(--status-error) 35%,var(--border-default)); background:color-mix(in srgb,var(--status-error) 8%,var(--bg-2)); color:var(--status-error); border-radius:8px; padding:10px 12px; font-size:13px; }
.studio-error.floating { position:sticky; top:0; z-index:4; margin:0 auto 10px; max-width:800px; display:flex; justify-content:space-between; }
.studio-error button { border:0; background:transparent; color:inherit; }

.studio-right { grid-column:3; grid-row:2; min-width:0; border-left:1px solid var(--border-subtle); overflow-y:auto; overflow-x:hidden; }
.studio-right > header { height:46px; border-bottom:1px solid var(--border-subtle); padding:0 12px; display:flex; align-items:center; justify-content:space-between; }
.studio-right > header > div { display:flex; align-items:center; gap:7px; font-size:13px; }
.inspector-body { min-width:0; max-width:100%; box-sizing:border-box; padding:14px; display:grid; gap:16px; }
.inspector-body section, .inspector-body section > *, .field-mapping > div, .format-grid > div, .frame-facts > div, .data-trust > div { min-width:0; max-width:100%; box-sizing:border-box; }
.inspector-body section { display:grid; gap:7px; }
.inspector-body p, .inspector-body span, .inspector-body strong, .inspector-body small, .field-help, .inspector-id { min-width:0; overflow-wrap:anywhere; word-break:break-word; }
.field-help { color:var(--text-tertiary); font-size:13px; line-height:1.45; }
.review-action { border:1px solid var(--accent); background:var(--accent-dim); color:var(--accent); border-radius:8px; padding:9px; display:flex; align-items:center; justify-content:center; gap:6px; font-size:13px; font-weight:600; }
.review-action:disabled { border-color:var(--border-default); background:var(--bg-0); color:var(--text-muted); cursor:default; }
.review-task-list > div { border:1px solid var(--border-subtle); border-radius:8px; padding:8px; display:grid; gap:7px; }
.review-task-list span { color:var(--text-secondary); font-size:13px; line-height:1.4; }
.review-task-list button { justify-self:start; border:0; background:transparent; color:var(--accent); padding:0; display:flex; gap:4px; align-items:center; font-size:13px; font-weight:600; }
.inspector-body label { color:var(--text-tertiary); font-size:13px; text-transform:uppercase; letter-spacing:.09em; font-weight:600; }
.inspector-body input, .inspector-body textarea, .inspector-body select, .inspector-body button { min-width:0; max-width:100%; box-sizing:border-box; }
.inspector-body input, .inspector-body textarea, .inspector-body select { width:100%; border:1px solid var(--border-default); background:var(--bg-1); border-radius:8px; padding:9px 10px; outline:none; font-size:13px; }
.field-mapping > div, .format-grid > div { display:grid; grid-template-columns:74px minmax(0,1fr); gap:7px; align-items:center; }
.field-mapping > div span, .format-grid > div span { color:var(--text-tertiary); font-size:13px; }
.frame-facts > div { border-bottom:1px solid var(--border-subtle); padding:7px 0; display:flex; justify-content:space-between; gap:10px; }
.frame-facts span { color:var(--text-tertiary); font-size:13px; }
.frame-facts strong { font-size:13px; text-align:right; }
.ask-ai { border:0; background:var(--accent); color:var(--accent-fg) !important; border-radius:8px; padding:10px; display:flex; align-items:center; justify-content:center; gap:7px; font-size:13px; font-weight:600; }
.trust-summary { grid-template-columns:24px 1fr !important; border:1px solid var(--border-subtle); background:var(--bg-1); border-radius:8px; padding:11px; color:var(--accent); }
.trust-summary div { display:grid; gap:3px; }
.trust-summary strong { font-size:13px; color:var(--text-primary); }
.trust-summary p { margin:0; color:var(--text-tertiary); font-size:13px; line-height:1.4; }
.size-buttons { display:grid; grid-template-columns:1fr 1fr; gap:5px; }
.size-buttons button { border:1px solid var(--border-default); background:var(--bg-1); border-radius:8px; padding:7px; font-size:13px; }
.data-trust > div { display:flex; align-items:center; gap:7px; }
.data-trust p { color:var(--text-tertiary); font-size:13px; margin:0; line-height:1.5; }
.delete-component { border:1px solid color-mix(in srgb,var(--status-error) 25%,var(--border-default)); color:var(--status-error) !important; background:transparent; border-radius:8px; padding:9px; display:flex; align-items:center; justify-content:center; gap:6px; font-size:13px; }
.inspector-id { color:var(--text-muted); font-size:12px; text-align:center; }

.studio-ai-plan { width:min(920px,100%); margin:0 auto; box-sizing:border-box; border:1px solid var(--border-default); background:var(--bg-2); border-radius:12px; box-shadow:0 18px 52px color-mix(in srgb,var(--text-primary) 9%,transparent); overflow:hidden; }
.proposal-source-picker { isolation:isolate; }
.studio-ai-plan > header { padding:22px 24px; display:flex; align-items:flex-start; gap:12px; border-bottom:1px solid var(--border-subtle); }
.studio-ai-plan > header > span { width:38px; height:38px; flex:none; border-radius:12px; display:grid; place-items:center; color:var(--accent); background:var(--accent-dim); }
.studio-ai-plan > header > div { flex:1; min-width:0; display:grid; gap:4px; }
.studio-ai-plan > header small { color:var(--accent); font-size:12px; font-weight:600; letter-spacing:.1em; }
.studio-ai-plan > header h1 { margin:0; font-size:24px; letter-spacing:-.025em; }
.studio-ai-plan > header p { max-width:700px; margin:2px 0 0; color:var(--text-secondary); font-size:13px; line-height:1.5; }
.studio-ai-plan > header p strong { color:var(--text-primary); }
.studio-ai-plan > header .proposal-planner-provenance { color:var(--text-tertiary); font-size:12px; font-weight:600; letter-spacing:0; }
.studio-ai-plan > header .proposal-warnings { margin:6px 0 0; padding-left:16px; display:grid; gap:2px; color:var(--text-secondary); font-size:12px; line-height:1.4; }
.studio-ai-plan > header > button { width:31px; height:31px; flex:none; border:0; border-radius:8px; display:grid; place-items:center; background:transparent; color:var(--text-tertiary); }
.studio-ai-plan > header > button:hover { background:var(--bg-0); color:var(--text-primary); }
.proposal-source-summary { display:flex; align-items:center; gap:7px; flex-wrap:wrap; padding:11px 24px; border-bottom:1px solid var(--border-subtle); background:var(--bg-1); }
.proposal-source-summary span { border:1px solid var(--border-subtle); background:var(--bg-2); border-radius:999px; padding:6px 9px; color:var(--text-tertiary); font-size:12px; }
.proposal-source-summary strong { color:var(--text-primary); }
.proposal-source-body { padding:18px 24px 22px; display:grid; gap:18px; }
.proposal-source-search { display:flex; align-items:center; gap:8px; border:1px solid var(--border-default); background:var(--bg-1); border-radius:8px; padding:0 11px; color:var(--text-tertiary); }
.proposal-source-search:focus-within { border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-dim); }
.proposal-source-search input { width:100%; min-width:0; border:0; outline:0; background:transparent; padding:11px 0; font-size:13px; }
.proposal-source-group { display:grid; gap:8px; }
.proposal-source-heading { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.proposal-source-heading > div { display:grid; gap:2px; }
.proposal-source-heading h2 { margin:0; font-size:14px; }
.proposal-source-heading p { margin:0; color:var(--text-tertiary); font-size:12px; }
.proposal-source-heading > strong { min-width:25px; height:25px; display:grid; place-items:center; border-radius:999px; color:var(--accent); background:var(--accent-dim); font-size:13px; }
.proposal-source-list, .proposal-catalog-list { display:grid; gap:6px; }
.proposal-source-row, .proposal-catalog-list > article { min-width:0; border:1px solid var(--border-subtle); background:var(--bg-1); border-radius:12px; padding:10px; display:grid; grid-template-columns:34px minmax(0,1fr) auto; align-items:center; gap:10px; }
.proposal-source-row.selected { border-color:color-mix(in srgb,var(--status-success) 25%,var(--border-default)); background:color-mix(in srgb,var(--status-success) 4%,var(--bg-1)); }
.proposal-source-trust, .proposal-catalog-list > article > span { width:34px; height:34px; border-radius:8px; display:grid; place-items:center; color:var(--status-success); background:color-mix(in srgb,var(--status-success) 9%,var(--bg-2)); }
.proposal-source-trust.review_required, .proposal-source-trust.draft_ready, .proposal-catalog-list > article > span.review_required { color:var(--status-warning); background:color-mix(in srgb,var(--status-warning) 9%,var(--bg-2)); }
.proposal-source-row > div, .proposal-catalog-list > article > div { min-width:0; display:grid; gap:2px; }
.proposal-source-row strong, .proposal-catalog-list strong { font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.proposal-source-row small, .proposal-catalog-list small { color:var(--text-tertiary); font-size:12px; }
.proposal-source-row p, .proposal-catalog-list p { margin:1px 0 0; color:var(--text-secondary); font-size:12px; line-height:1.4; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.proposal-source-row p.proposal-source-why { color:var(--text-tertiary); white-space:normal; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; }
.proposal-source-row > button, .proposal-catalog-list > article > button { border:1px solid var(--border-default); background:var(--bg-2); border-radius:8px; padding:7px 9px; display:flex; align-items:center; gap:5px; color:var(--accent); font-size:12px; font-weight:600; }
.proposal-source-row > button, .proposal-catalog-list > article > button { max-width:190px; white-space:normal; line-height:1.25; text-align:center; justify-content:center; }
.proposal-source-row > button.remove { color:var(--text-secondary); }
.proposal-source-row > button:hover, .proposal-catalog-list > article > button:hover { border-color:var(--accent); background:var(--accent-dim); color:var(--accent); }
.proposal-source-row > button:disabled, .proposal-catalog-list > article > button:disabled { opacity:.45; cursor:default; }
.proposal-source-empty { border:1px dashed var(--border-default); border-radius:12px; padding:14px; display:flex; align-items:center; gap:10px; color:var(--accent); }
.proposal-source-empty > div { display:grid; gap:2px; }
.proposal-source-empty strong { color:var(--text-primary); font-size:13px; }
.proposal-source-empty p { margin:0; color:var(--text-tertiary); font-size:12px; }
.studio-ai-review-lane { border:1px dashed color-mix(in srgb,var(--status-warning) 32%,var(--border-default)); border-radius:8px; padding:9px; display:flex; align-items:flex-start; gap:8px; color:var(--status-warning); }
.studio-ai-review-lane p { margin:0; display:grid; gap:2px; }
.studio-ai-review-lane strong { color:var(--text-primary); font-size:13px; }
.studio-ai-review-lane small { color:var(--text-tertiary); font-size:12px; line-height:1.4; }
.studio-ai-plan-empty { margin:0; color:var(--text-tertiary); font-size:13px; line-height:1.45; padding:12px; border:1px dashed var(--border-default); border-radius:8px; }
.studio-ai-questions { border:1px solid color-mix(in srgb,var(--status-warning) 28%,var(--border-default)); background:color-mix(in srgb,var(--status-warning) 6%,var(--bg-2)); border-radius:8px; padding:11px; display:grid; gap:8px; }
.studio-ai-questions > header { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.studio-ai-questions > header strong { font-size:13px; }
.studio-ai-questions > header small { color:var(--status-warning); font-size:12px; }
.studio-ai-questions > p { margin:0; color:var(--text-secondary); font-size:13px; line-height:1.45; }
.studio-ai-questions button { justify-self:start; border:1px solid var(--accent); color:var(--accent); background:var(--accent-dim); border-radius:8px; padding:7px 9px; font-size:12px; font-weight:600; }
.studio-ai-plan > footer { position:sticky; bottom:0; border-top:1px solid var(--border-subtle); background:var(--bg-2); padding:14px 24px; display:flex; justify-content:flex-end; gap:8px; }
.studio-ai-plan > footer > span { margin-right:auto; align-self:center; color:var(--text-tertiary); font-size:12px; }
.studio-ai-plan > footer button { border:1px solid var(--border-default); background:var(--bg-1); border-radius:8px; padding:9px 12px; font-size:13px; font-weight:600; }
.studio-ai-plan > footer button.primary { border-color:var(--accent); background:var(--accent); color:var(--accent-fg); display:flex; align-items:center; gap:6px; }
.studio-ai-plan > footer button:disabled { opacity:.45; cursor:default; }
.studio-copilot-panel { top:58px !important; bottom:0 !important; height:auto !important; }
.inspector-body .tile-query-editor label, .inspector-body .tile-query-editor legend { color:var(--text-secondary); font-size:13px; text-transform:none; letter-spacing:normal; font-weight:600; }
.inspector-body .tile-query-editor input[type=checkbox], .inspector-body .tile-query-editor input[type=radio] { width:auto; padding:0; margin:0; flex:none; }
.inspector-body .tile-query-editor input:not([type=checkbox]):not([type=radio]), .inspector-body .tile-query-editor select { padding:5px 7px; font-size:13px; border-radius:8px; }
.tile-query-editor .dataset-builder-mode label, .tile-query-editor .dataset-measure-list label, .tile-query-editor .dataset-detail-columns label, .tile-query-editor .dataset-comparison-toggle { display:flex; align-items:flex-start; gap:6px; text-align:left; }
.tile-query-editor .dataset-builder-mode label span, .tile-query-editor .dataset-comparison-toggle span { display:grid; gap:1px; }
.tile-query-editor .dataset-builder-mode strong, .tile-query-editor .dataset-comparison-toggle strong { color:var(--text-primary); font-size:13px; text-transform:none; letter-spacing:normal; }
.tile-query-editor .dataset-builder-mode small, .tile-query-editor .dataset-comparison-toggle small { color:var(--text-tertiary); font-size:12px; font-weight:500; text-transform:none; letter-spacing:normal; }
.tile-query-editor .dataset-filter-builder > div { display:flex; gap:4px; align-items:center; }
.studio-tile-dql-toggle { margin-left:6px; border:1px solid var(--border-subtle); border-radius:999px; background:var(--bg-1); color:var(--text-secondary); font:inherit; font-size:13px; padding:1px 8px; cursor:pointer; }
.studio-tile-dql-toggle.on { border-color:var(--accent); color:var(--accent); }
.studio-tile-dql { margin:6px 0; max-height:260px; overflow:auto; border:1px solid var(--border-subtle); border-radius:8px; background:var(--bg-1); padding:8px; font-size:13px; }
.studio-tile-dql pre { white-space:pre-wrap; word-break:break-word; font-size:13px; margin:4px 0 8px; }
.tile-filter-notice.adapted { color:var(--text-secondary); }
.tile-filter-notice.retired { color:var(--status-warning); }
.tile-filter-notice.retired svg { color:var(--status-warning); }
.studio-ai-scope { display:flex; gap:4px; margin:10px 12px 0; padding:3px; border:1px solid var(--border-subtle); border-radius:8px; background:var(--bg-1); }
.studio-ai-scope button { flex:1; min-width:0; border:0; border-radius:8px; background:none; color:var(--text-secondary); font:inherit; font-size:14px; padding:6px 8px; cursor:pointer; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.studio-ai-scope button.on { background:var(--bg-2); color:var(--text-primary); font-weight:600; box-shadow:0 1px 2px color-mix(in srgb,var(--text-primary) 12%,transparent); }
.studio-ai-page-scope { display:grid; gap:8px; margin:12px; }
.studio-ai-page-scope label { color:var(--text-primary); font-size:13px; font-weight:600; }
.studio-ai-page-scope button.studio-ai-connect-link { justify-self:start; padding:0; border:0; background:transparent; color:var(--accent); font-size:12px; text-decoration:underline; cursor:pointer; }
.studio-ai-connect { margin:12px; }
.studio-ai-page-scope textarea { width:100%; box-sizing:border-box; resize:vertical; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-2); color:var(--text-primary); font:inherit; font-size:13px; padding:8px; }
.studio-ai-page-scope small { color:var(--text-tertiary); font-size:12px; }
.studio-ai-page-scope .primary { justify-self:start; display:inline-flex; align-items:center; gap:6px; border:0; border-radius:8px; background:var(--accent); color:var(--accent-fg); font:inherit; font-size:13px; font-weight:600; padding:7px 12px; cursor:pointer; }
.studio-ai-page-scope .primary:disabled { opacity:.55; cursor:default; }
.studio-ai-page-scope .studio-ai-replace { display:flex; align-items:center; gap:8px; font-size:13px; font-weight:400; color:var(--text-secondary); }
.studio-ai-page-scope .studio-ai-replace input { accent-color:var(--accent); }
.studio-copilot-loading { padding:18px; color:var(--text-tertiary); font-size:13px; }
.studio-copilot-change { margin:12px; display:grid; gap:10px; border:1px solid var(--border-default); border-radius:12px; background:var(--bg-1); padding:12px; }
.studio-copilot-change > header { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; }
.studio-copilot-change > header > div { display:grid; gap:3px; }
.studio-copilot-change > header small { color:var(--accent); font-size:12px; font-weight:600; letter-spacing:.1em; }
.studio-copilot-change > header strong { font-size:13px; }
.studio-copilot-change > header > span { color:var(--text-tertiary); font-size:12px; }
.studio-copilot-change > p { margin:0; color:var(--text-secondary); font-size:13px; line-height:1.45; }
.studio-copilot-change label { display:grid; gap:5px; color:var(--text-secondary); font-size:13px; font-weight:600; }
.studio-copilot-change input { width:100%; box-sizing:border-box; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-2); padding:8px 9px; font-size:13px; outline:none; }
.studio-copilot-change input:focus { border-color:var(--accent); box-shadow:0 0 0 2px var(--accent-dim); }
.studio-copilot-change-summary { display:grid; gap:3px; border:1px solid var(--border-subtle); border-radius:8px; background:var(--bg-2); padding:9px; }
.studio-copilot-change-summary strong { font-size:13px; }
.studio-copilot-change-summary span { color:var(--accent); font-size:13px; }
.studio-copilot-change-summary small { color:var(--text-tertiary); font-size:12px; line-height:1.4; }
.studio-copilot-diagnostic { margin:0; border-left:2px solid var(--accent); padding-left:8px; color:var(--text-secondary); font-size:13px; line-height:1.4; }
.studio-copilot-change footer { display:flex; justify-content:flex-end; gap:7px; }
.studio-copilot-change footer button { border:1px solid var(--border-default); border-radius:8px; background:var(--bg-2); padding:7px 9px; font-size:13px; font-weight:600; }
.studio-copilot-change footer button.primary { border-color:var(--accent); background:var(--accent); color:var(--accent-fg); }
.studio-copilot-change footer button:disabled { opacity:.45; cursor:default; }

.proposal-scrim { position:fixed; inset:0; z-index:30; background:color-mix(in srgb,var(--bg-canvas) 68%,transparent); backdrop-filter:blur(5px); display:flex; align-items:center; justify-content:center; padding:24px; }
.proposal-card { width:min(620px,100%); max-height:calc(100vh - 48px); overflow:auto; border:1px solid var(--border-default); background:var(--bg-2); border-radius:12px; box-shadow:0 24px 80px color-mix(in srgb,var(--text-primary) 18%,transparent); }
.proposal-card > header { padding:18px; display:flex; gap:11px; align-items:center; border-bottom:1px solid var(--border-subtle); }
.proposal-card > header > span { width:34px; height:34px; border-radius:8px; background:var(--accent-dim); color:var(--accent); display:flex; align-items:center; justify-content:center; }
.proposal-card > header > div { display:grid; gap:3px; flex:1; }
.proposal-card > header small { color:var(--text-tertiary); font-size:13px; }
.proposal-summary { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; padding:16px 18px; }
.proposal-summary div { background:var(--bg-1); border:1px solid var(--border-subtle); border-radius:8px; padding:10px; display:grid; }
.proposal-summary strong { font-size:20px; }
.proposal-summary span { color:var(--text-tertiary); font-size:13px; }
.proposal-clarifications { margin:0 18px 14px; border:1px solid color-mix(in srgb,var(--status-warning) 30%,var(--border-default)); background:color-mix(in srgb,var(--status-warning) 7%,var(--bg-2)); border-radius:8px; padding:11px; display:grid; gap:9px; }
.proposal-clarifications > strong { font-size:13px; color:var(--status-warning); }
.proposal-clarifications > div { display:flex; gap:5px; align-items:center; flex-wrap:wrap; }
.proposal-clarifications span { width:100%; font-size:13px; }
.proposal-clarifications button { border:1px solid var(--border-default); background:var(--bg-2); border-radius:999px; padding:5px 8px; font-size:13px; }
.proposal-clarifications button.on { border-color:var(--accent); color:var(--accent); background:var(--accent-dim); display:inline-flex; align-items:center; gap:4px; }
.proposal-change-list { padding:0 18px 18px; display:grid; gap:8px; }
.proposal-change-list span { display:flex; align-items:center; gap:7px; color:var(--text-secondary); font-size:13px; }
.proposal-change-list svg { color:var(--status-success); }
.proposal-card > footer { padding:14px 18px; border-top:1px solid var(--border-subtle); display:flex; justify-content:flex-end; gap:8px; }
.proposal-card > footer button { border:1px solid var(--border-default); background:var(--bg-1); border-radius:8px; padding:9px 12px; font-size:13px; font-weight:600; }
.proposal-card > footer button.primary { border-color:var(--accent); background:var(--accent); color:var(--accent-fg); display:flex; align-items:center; gap:6px; }
.studio-readiness-card { width:min(680px,100%); max-height:calc(100vh - 48px); overflow:hidden; display:flex; flex-direction:column; border:1px solid var(--border-default); background:var(--bg-2); border-radius:12px; box-shadow:0 24px 80px color-mix(in srgb,var(--text-primary) 18%,transparent); }
.studio-readiness-card > header { padding:19px 20px; display:flex; align-items:flex-start; gap:11px; border-bottom:1px solid var(--border-subtle); }
.studio-readiness-card > header > span { width:38px; height:38px; flex:none; border-radius:12px; display:grid; place-items:center; color:var(--status-warning); background:color-mix(in srgb,var(--status-warning) 9%,var(--bg-2)); }
.studio-readiness-card > header > span.ready { color:var(--status-success); background:color-mix(in srgb,var(--status-success) 9%,var(--bg-2)); }
.studio-readiness-card > header > div { flex:1; min-width:0; display:grid; gap:4px; }
.studio-readiness-card h2 { margin:0; font-size:20px; letter-spacing:-.02em; }
.studio-readiness-card > header p { margin:0; color:var(--text-secondary); font-size:13px; line-height:1.5; }
.studio-readiness-card > header .icon { width:32px; height:32px; flex:none; }
.readiness-body { min-height:0; overflow:auto; padding:14px 20px; display:grid; gap:8px; }
.readiness-item { border:1px solid var(--border-subtle); background:var(--bg-1); border-radius:12px; padding:12px; display:flex; align-items:flex-start; gap:10px; }
.readiness-item.warning { border-color:color-mix(in srgb,var(--status-warning) 28%,var(--border-default)); background:color-mix(in srgb,var(--status-warning) 5%,var(--bg-2)); }
.readiness-item .step-mark { width:31px; height:31px; flex:none; display:grid; place-items:center; border-radius:8px; color:var(--accent); background:var(--accent-dim); }
.readiness-item.warning .step-mark { color:var(--status-warning); background:color-mix(in srgb,var(--status-warning) 10%,var(--bg-2)); }
.readiness-item > div { min-width:0; flex:1; display:grid; gap:4px; }
.readiness-item strong { font-size:13px; }
.readiness-item p { margin:0; color:var(--text-secondary); font-size:13px; line-height:1.45; overflow-wrap:anywhere; }
.readiness-item small { color:var(--text-tertiary); font-size:13px; line-height:1.4; }
.readiness-actions, .readiness-choices { margin-top:5px; display:flex; gap:6px; flex-wrap:wrap; }
.readiness-actions button, .readiness-choices button { border:1px solid var(--border-default); background:var(--bg-2); border-radius:8px; padding:7px 9px; display:inline-flex; align-items:center; gap:5px; color:var(--text-secondary); font-size:13px; font-weight:600; }
.readiness-actions button.primary { border-color:var(--accent); background:var(--accent-dim); color:var(--accent); }
.readiness-actions button:disabled, .readiness-choices button:disabled { opacity:.5; cursor:default; }
.readiness-ready { border:1px solid color-mix(in srgb,var(--status-success) 25%,var(--border-default)); background:color-mix(in srgb,var(--status-success) 6%,var(--bg-2)); border-radius:12px; padding:14px; display:flex; align-items:flex-start; gap:9px; color:var(--status-success); }
.readiness-ready > div { display:grid; gap:3px; }
.readiness-ready strong { color:var(--text-primary); font-size:13px; }
.readiness-ready span { color:var(--text-secondary); font-size:13px; line-height:1.45; }
.readiness-ready.with-review { border-color:color-mix(in srgb,var(--status-warning) 30%,var(--border-default)); background:color-mix(in srgb,var(--status-warning) 6%,var(--bg-2)); color:var(--status-warning); }
.readiness-technical { margin-top:6px; font-size:12px; color:var(--text-tertiary); }
.readiness-technical summary { cursor:pointer; }
.readiness-technical code { display:block; margin-top:4px; white-space:pre-wrap; word-break:break-word; font-size:11px; color:var(--text-secondary); }
.studio-readiness-card > footer { padding:14px 20px; border-top:1px solid var(--border-subtle); display:flex; align-items:center; justify-content:flex-end; gap:8px; }
.studio-readiness-card > footer button { border:1px solid var(--border-default); background:var(--bg-1); border-radius:8px; padding:9px 12px; font-size:13px; font-weight:600; }
.studio-readiness-card > footer button.primary { border-color:var(--accent); background:var(--accent); color:var(--accent-fg); }
.studio-readiness-card > footer button:disabled { opacity:.5; cursor:default; }
.readiness-footer-hint { flex:1; color:var(--text-tertiary); font-size:13px; text-align:right; }
.readiness-publish { flex:1; display:flex; align-items:center; justify-content:flex-end; gap:12px; min-width:0; }
.readiness-readers-note { color:var(--text-secondary); font-size:12px; text-align:right; }
.readiness-trust-count { margin:2px 0 0; color:var(--text-secondary); font-size:13px; }
.studio-delete-card { width:min(420px,100%); border:1px solid var(--border-default); background:var(--bg-2); border-radius:12px; padding:24px; box-shadow:0 24px 80px color-mix(in srgb,var(--text-primary) 18%,transparent); }
.studio-delete-card .delete-mark { width:40px; height:40px; border-radius:12px; display:flex; align-items:center; justify-content:center; color:var(--status-error); background:color-mix(in srgb,var(--status-error) 9%,var(--bg-2)); }
.studio-delete-card h2 { margin:15px 0 7px; font-size:20px; }
.studio-delete-card p { margin:0; color:var(--text-secondary); font-size:13px; line-height:1.6; }
.studio-delete-card footer { display:flex; justify-content:flex-end; gap:8px; margin-top:22px; }
.studio-delete-card footer button { border:1px solid var(--border-default); background:var(--bg-1); border-radius:8px; padding:9px 12px; font-size:13px; font-weight:600; }
.studio-delete-card footer button.danger { border-color:var(--status-error); background:var(--status-error); color:white; }
.dataset-author-source { width:100%; margin-top:9px; border:1px solid var(--border-default); background:var(--bg-1); color:var(--text-secondary); border-radius:8px; padding:8px 9px; display:flex; align-items:center; justify-content:center; gap:6px; font-size:13px; font-weight:600; }
.dataset-author-source:hover:not(:disabled) { border-color:var(--accent); color:var(--accent); background:var(--accent-dim); }
.dataset-source-authoring-card { width:min(760px,100%); max-height:calc(100vh - 48px); overflow:hidden; display:flex; flex-direction:column; border:1px solid var(--border-default); background:var(--bg-2); border-radius:12px; box-shadow:0 24px 80px color-mix(in srgb,var(--text-primary) 18%,transparent); }
.dataset-source-authoring-card > header { padding:18px 20px; display:flex; gap:11px; align-items:flex-start; border-bottom:1px solid var(--border-subtle); }
.dataset-source-authoring-card > header > span { width:36px; height:36px; flex:none; display:grid; place-items:center; border-radius:8px; color:var(--accent); background:var(--accent-dim); }
.dataset-source-authoring-card > header > div { flex:1; min-width:0; display:grid; gap:3px; }
.dataset-source-authoring-card > header small { color:var(--text-tertiary); font-size:13px; letter-spacing:.07em; font-weight:600; }
.dataset-source-authoring-card h2 { margin:0; font-size:20px; letter-spacing:-.02em; }
.dataset-source-authoring-card header p { margin:0; color:var(--text-secondary); font-size:13px; overflow-wrap:anywhere; }
.dataset-source-authoring-card header code { color:var(--text-tertiary); font-size:13px; }
.dataset-source-authoring-card > header .icon { width:30px; height:30px; flex:none; }
.dataset-source-authoring-body { min-height:0; overflow:auto; padding:15px 20px; display:grid; gap:10px; }
.dataset-source-authoring-body > section { border:1px solid var(--border-subtle); border-radius:8px; background:var(--bg-1); padding:11px; display:grid; gap:8px; }
.dataset-source-authoring-body > section > label { color:var(--text-primary); font-size:13px; font-weight:600; }
.dataset-source-authoring-body > section > p, .dataset-source-authoring-body > section > small { margin:0; color:var(--text-secondary); font-size:13px; line-height:1.45; }
.dataset-source-grain { grid-template-columns:repeat(2,minmax(0,1fr)); }
.dataset-source-grain > label, .dataset-source-grain > p, .dataset-source-grain > small { grid-column:1/-1; }
.dataset-source-checkbox { display:flex !important; align-items:center; gap:7px; align-self:end; min-height:31px; color:var(--text-secondary); font-size:13px; }
.dataset-source-checkbox input { width:auto !important; min-width:auto !important; accent-color:var(--accent); }
.dataset-source-fields > div { display:flex; gap:6px; flex-wrap:wrap; }
.dataset-source-fields > div > span { min-width:184px; flex:1 1 184px; display:grid; gap:5px; padding:7px 8px; border:1px solid var(--border-subtle); border-radius:8px; background:var(--bg-2); }
.dataset-source-fields strong { font-size:13px; overflow-wrap:anywhere; }
.dataset-source-fields small { color:var(--text-tertiary); font-size:12px; }
.dataset-source-field-editor > label { display:grid; gap:3px; }
.dataset-source-field-editor > label > span { color:var(--text-tertiary); font-size:12px; font-weight:600; }
.dataset-source-candidates > div { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:7px; }
.dataset-source-candidates button { min-width:0; text-align:left; border:1px solid var(--border-default); background:var(--bg-2); border-radius:8px; padding:8px; display:grid; gap:4px; color:var(--text-secondary); }
.dataset-source-candidates button:hover:not(:disabled) { border-color:var(--accent); background:var(--accent-dim); }
.dataset-source-candidates strong { color:var(--text-primary); font-size:13px; }
.dataset-source-candidates code { color:var(--accent); font-size:12px; line-height:1.35; overflow-wrap:anywhere; }
.dataset-source-candidates small { color:var(--text-tertiary); font-size:12px; }
.dataset-source-form-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
.dataset-source-form-grid label, .dataset-source-expression { display:grid; gap:4px; min-width:0; }
.dataset-source-form-grid span, .dataset-source-expression > span { color:var(--text-tertiary); font-size:12px; font-weight:600; }
.dataset-source-authoring-card input, .dataset-source-authoring-card select, .dataset-source-authoring-card textarea { min-width:0; width:100%; box-sizing:border-box; border:1px solid var(--border-default); background:var(--bg-2); color:var(--text-primary); border-radius:8px; padding:7px 8px; font:inherit; font-size:13px; }
.dataset-source-authoring-card textarea { resize:vertical; line-height:1.45; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
.dataset-source-authoring-message { margin:0; border:1px solid color-mix(in srgb,var(--status-warning) 30%,var(--border-default)); background:color-mix(in srgb,var(--status-warning) 7%,var(--bg-2)); border-radius:8px; padding:9px; color:var(--text-secondary); font-size:13px; line-height:1.45; }
.dataset-source-authoring-card > footer { padding:13px 20px; border-top:1px solid var(--border-subtle); display:flex; justify-content:flex-end; align-items:center; gap:8px; }
.dataset-source-authoring-card > footer > span { flex:1; color:var(--text-tertiary); font-size:13px; line-height:1.4; }
.dataset-source-authoring-card > footer button { border:1px solid var(--border-default); background:var(--bg-1); color:var(--text-primary); border-radius:8px; padding:9px 11px; font-size:13px; font-weight:600; }
.dataset-source-authoring-card > footer button.primary { border-color:var(--accent); background:var(--accent); color:var(--accent-fg); display:inline-flex; align-items:center; gap:6px; }
.dataset-source-authoring-card button:disabled { opacity:.52; cursor:default; }
.dataset-source-rebind-card { width:min(470px,100%); border:1px solid var(--border-default); background:var(--bg-2); border-radius:12px; box-shadow:0 24px 80px color-mix(in srgb,var(--text-primary) 18%,transparent); overflow:hidden; }
.dataset-source-rebind-card > header { padding:17px 18px; display:flex; gap:10px; align-items:flex-start; border-bottom:1px solid var(--border-subtle); }
.dataset-source-rebind-card > header > span { width:34px; height:34px; display:grid; place-items:center; flex:none; color:var(--accent); background:var(--accent-dim); border-radius:8px; }
.dataset-source-rebind-card > header > div { flex:1; display:grid; gap:2px; }
.dataset-source-rebind-card > header small { color:var(--text-tertiary); font-size:13px; font-weight:600; letter-spacing:.06em; }
.dataset-source-rebind-card h2 { margin:0; font-size:16px; letter-spacing:-.02em; }
.dataset-source-rebind-card > header .icon { width:30px; height:30px; }
.dataset-source-rebind-card > p { margin:0; padding:13px 18px 0; color:var(--text-secondary); font-size:13px; line-height:1.5; }
.dataset-source-rebind-card > p + p { padding-top:8px; }
.dataset-source-rebind-card > footer { margin-top:15px; padding:13px 18px; display:flex; justify-content:flex-end; gap:8px; border-top:1px solid var(--border-subtle); }
.dataset-source-rebind-card > footer button { border:1px solid var(--border-default); background:var(--bg-1); color:var(--text-primary); border-radius:8px; padding:9px 10px; font-size:13px; font-weight:600; }
.dataset-source-rebind-card > footer button.primary { border-color:var(--accent); background:var(--accent); color:var(--accent-fg); display:inline-flex; align-items:center; gap:6px; }
.dataset-source-rebind-card button:disabled { opacity:.52; cursor:default; }

/* ── Studio layout: header · Data panel · page · tile settings or AI ── */
.dql-studio-v2.studio-view .studio-workspace { grid-column:1/3; }
.studio-topbar { grid-column:1/-1; height:52px; display:flex; align-items:center; gap:14px; padding:0 12px 0 8px; box-sizing:border-box; }
.studio-brand { flex:none; width:256px; height:auto; border-right:0; padding:0; gap:8px; }
.studio-brand .mark { width:26px; height:26px; border-radius:8px; }
.studio-brand input { width:200px; font-size:14px; font-weight:600; }
.studio-brand small { font-size:12px; max-width:210px; }
.ghost-icon { width:30px; height:30px; flex:none; border:0; border-radius:8px; background:transparent; color:var(--text-secondary); display:inline-flex; align-items:center; justify-content:center; padding:0; }
.ghost-icon:hover { background:var(--bg-0); color:var(--text-primary); }
.ghost-icon:disabled { opacity:.35; cursor:default; background:transparent; }
.page-nav { flex:1; min-width:0; height:auto; padding:0; gap:2px; }
.page-nav > button:not(.ghost-icon) { height:32px; padding:0 12px; font-size:13px; font-weight:500; color:var(--text-secondary); }
.page-nav > button:not(.ghost-icon):hover { background:var(--bg-0); color:var(--text-primary); }
.page-nav > button.on { background:var(--bg-0); color:var(--text-primary); font-weight:600; }
.studio-actions { flex:none; gap:8px; padding-right:0; }
.studio-actions .history { display:flex; gap:2px; padding-right:8px; border-right:1px solid var(--border-subtle); }
.mode-toggle { display:flex; padding:3px; border-radius:8px; background:var(--bg-0); }
.mode-toggle button { height:26px; padding:0 12px; border:0; border-radius:8px; background:transparent; color:var(--text-secondary); font-size:13px; font-weight:500; }
.mode-toggle button.on { background:var(--bg-2); color:var(--text-primary); font-weight:600; box-shadow:0 1px 2px color-mix(in srgb,var(--text-primary) 10%,transparent); }
.studio-actions .preview, .studio-actions .copilot, .studio-actions .publish { height:32px; box-sizing:border-box; padding:0 12px; border-radius:8px; font-size:13px; font-weight:500; gap:6px; }
.studio-actions .copilot { border-color:color-mix(in srgb,var(--accent) 30%,var(--border-default)); background:var(--accent-dim); color:var(--accent); }
.studio-actions .copilot.on { border-color:var(--accent); }
.studio-actions .publish { font-weight:600; }
.studio-actions .publish:hover { background:var(--accent-hover, var(--accent)); }
.studio-actions .publish small { font-size:11px; }
.studio-overflow-menu { top:42px; right:0; width:228px; padding:6px; border-radius:8px; display:grid; }
.studio-overflow-menu > small { padding:6px 8px 4px; color:var(--text-tertiary); font-size:11px; font-weight:600; letter-spacing:.05em; text-transform:uppercase; }
.studio-overflow-menu button { height:32px; padding:0 8px; color:var(--text-primary); font-size:13px; font-weight:500; }
.studio-overflow-menu button:hover { background:var(--bg-0); }
.studio-overflow-menu button.on { color:var(--accent); }
.studio-overflow-menu button .menu-check { margin-left:auto; }
.studio-overflow-menu button.danger { color:var(--status-error); }
.studio-overflow-menu button.danger:hover { background:color-mix(in srgb,var(--status-error) 9%,var(--bg-2)); }
.studio-overflow-menu button:disabled { opacity:.45; cursor:default; }
.studio-overflow-menu hr, .tile-menu hr { border:0; border-top:1px solid var(--border-subtle); margin:5px 0; }

.studio-left { display:flex; flex-direction:column; background:var(--bg-1); }
.studio-left > nav { flex-direction:row; flex:none; gap:2px; padding:8px 12px 0; border-right:0; border-bottom:1px solid var(--border-subtle); }
.studio-left > nav button { height:34px; min-height:0; flex-direction:row; padding:0 10px; border-radius:0; background:transparent; color:var(--text-secondary); font-size:13px; font-weight:500; }
.studio-left > nav button:hover { color:var(--text-primary); }
.studio-left > nav button.on { background:transparent; color:var(--text-primary); font-weight:600; box-shadow:inset 0 -2px 0 var(--text-primary); }
.left-content { flex:1; min-height:0; padding:12px; }
.panel-add { width:100%; height:34px; margin-top:8px; border:1px dashed var(--border-strong); border-radius:8px; background:transparent; color:var(--text-secondary); display:flex; align-items:center; justify-content:center; gap:6px; font-size:13px; font-weight:500; }
.panel-add:hover { color:var(--text-primary); border-color:var(--text-tertiary); }
.studio-list > button { border:1px solid var(--border-subtle); background:var(--bg-2); padding:10px 12px; }
.studio-list > button.on { border-color:color-mix(in srgb,var(--accent) 40%,var(--border-default)); background:var(--bg-2); box-shadow:inset 3px 0 0 var(--accent); }
.studio-list strong, .template-list strong { font-size:14px; font-weight:600; }
.studio-list small, .template-list small { font-size:12px; }
.panel-section-label span { font-size:11px; font-weight:600; letter-spacing:.06em; color:var(--text-tertiary); }

.studio-workspace { padding:22px 28px 48px; }
.studio-canvas { min-height:0; padding:0; border:0; border-radius:0; background:transparent; box-shadow:none; }
.studio-page-heading { align-items:flex-end; gap:16px; margin-bottom:14px; padding-bottom:0; border-bottom:0; }
.studio-page-heading > div { gap:0; }
.studio-page-heading h1 { margin:0; font-size:24px; font-weight:600; letter-spacing:-.01em; line-height:1.25; }
.studio-page-heading p { margin:4px 0 0; max-width:760px; color:var(--text-secondary); font-size:14px; line-height:1.45; }
.add-tile { flex:none; height:32px; padding:0 12px; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-2); display:inline-flex; align-items:center; gap:6px; font-size:13px; font-weight:500; }
.add-tile:hover { border-color:var(--border-strong); background:var(--bg-1); }
.studio-page-filterbar { gap:8px; margin-bottom:14px; }
.studio-filter { min-height:32px; border-color:var(--border-subtle); background:var(--bg-2); }
.studio-filter.dropdown > summary { min-height:32px; padding:0 10px; }
.studio-filter.dropdown > summary > span { display:flex; align-items:baseline; gap:6px; }
.studio-filter.dropdown > summary small { color:var(--text-secondary); font-size:13px; font-weight:500; }
.studio-filter.dropdown > summary strong { font-size:13px; }
.studio-page-filterbar .studio-filter:not(.dropdown):not(.range) { display:flex; align-items:center; gap:6px; height:32px; box-sizing:border-box; padding:0 10px; }
.studio-page-filterbar .studio-filter > span, .studio-page-filterbar .studio-filter > label { color:var(--text-secondary); font-size:13px; font-weight:500; white-space:nowrap; }
.studio-page-filterbar .studio-filter input, .studio-page-filterbar .studio-filter select { min-width:90px; font-size:13px; font-weight:600; color:var(--text-primary); }
.studio-page-filterbar .studio-filter input::placeholder { color:var(--text-primary); font-weight:600; }
.studio-page-filterbar .studio-filter:not(.empty) > small { display:none; }
.studio-page-filterbar .studio-filter.range { display:flex; align-items:center; gap:6px; height:32px; padding:0 10px; box-sizing:border-box; }
.studio-page-filterbar .studio-filter.range.one-sided > small { display:inline; color:var(--text-secondary); font-size:12px; font-weight:600; white-space:nowrap; }
.studio-page-filterbar .studio-filter.range > small em { font-style:normal; color:var(--text-muted); font-weight:500; }
.studio-page-grid { gap:14px; }
.studio-component-card { position:relative; overflow:visible; border-color:var(--border-subtle); border-radius:12px; background:var(--bg-2); }
.studio-edit .studio-component-card { cursor:pointer; }
.studio-component-card:hover { border-color:var(--border-default); }
.studio-component-card.selected, .studio-component-card.selected:hover { border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-dim); }
.studio-component-card > header { height:auto; min-height:44px; box-sizing:border-box; padding:8px 8px 2px 14px; border-bottom:0; gap:8px; }
.studio-component-card > header strong { font-size:14px; font-weight:600; }
.studio-component-card .drag-handle { margin-left:-8px; opacity:0; transition:opacity .12s; }
.studio-component-card:hover .drag-handle { opacity:1; }
.tile-tools { position:relative; margin-left:auto; display:flex; align-items:center; gap:2px; opacity:0; transition:opacity .12s; }
.studio-component-card:hover .tile-tools, .studio-component-card.selected .tile-tools, .tile-tools:focus-within { opacity:1; }
.tile-tools > button { width:28px; height:28px; margin:0; padding:0; border:0; border-radius:8px; background:transparent; color:var(--text-secondary); display:inline-flex; align-items:center; justify-content:center; }
.tile-tools > button:hover { background:var(--bg-0); color:var(--text-primary); }
.tile-tools > button.on { background:var(--accent-dim); color:var(--accent); }
.tile-tools > .studio-autopilot-target { color:var(--accent); }
.tile-menu { position:absolute; top:32px; right:0; z-index:25; width:214px; padding:6px; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-2); box-shadow:0 12px 32px color-mix(in srgb,var(--text-primary) 14%,transparent); display:grid; cursor:default; }
.tile-menu button { height:32px; border:0; border-radius:8px; background:transparent; padding:0 9px; display:flex; align-items:center; gap:9px; color:var(--text-primary); font-size:13px; text-align:left; }
.tile-menu button:hover { background:var(--bg-0); }
.tile-menu button.danger { color:var(--status-error); }
.studio-component-card.text-tile { min-height:0; background:transparent; border-color:transparent; }
.studio-edit .studio-component-card.text-tile:hover { border-color:var(--border-subtle); }
.studio-view .studio-component-card.text-tile > header { display:none; }
.tile-heading { padding:2px 14px 12px; font-size:20px; font-weight:600; }
.tile-text { padding:2px 14px 14px; font-size:14px; }
.empty-canvas { min-height:360px; border-radius:12px; background:var(--bg-2); }
.empty-canvas strong { font-size:16px; }
.empty-canvas p { font-size:14px; max-width:380px; line-height:1.5; }
.empty-canvas .empty-actions { display:flex; gap:8px; }
.empty-canvas .empty-actions button { display:inline-flex; align-items:center; gap:6px; height:34px; padding:0 14px; font-size:13px; font-weight:500; }
.empty-canvas .empty-actions button.primary { border-color:var(--accent); background:var(--accent); color:var(--accent-fg); }

.studio-right { grid-column:3; grid-row:2; width:320px; display:flex; flex-direction:column; overflow:hidden; background:var(--bg-2); }
.studio-right > header { height:auto; flex:none; padding:12px 10px 4px 16px; border-bottom:0; align-items:flex-start; }
.studio-right > header > div { display:grid; gap:2px; font-size:13px; }
.studio-right > header small { color:var(--text-tertiary); font-size:11px; font-weight:600; letter-spacing:.06em; }
.studio-right > header strong { color:var(--text-secondary); font-size:13px; font-weight:500; }
.studio-right > .inspector-body { flex:1; min-height:0; overflow-y:auto; align-content:start; padding:0 16px 16px; gap:16px; }
.inspector-title > label { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
.inspector-body .inspector-title input { width:calc(100% + 12px); max-width:none; margin:0 -6px; padding:4px 6px; border-color:transparent; background:transparent; font-size:16px; font-weight:600; }
.inspector-body .inspector-title input:hover { border-color:var(--border-subtle); }
.inspector-docs { display:grid; gap:6px; }
.inspector-driver { display:grid; gap:6px; }
/* RFC 0008 step 8: story pages. */
.studio-page-heading > .studio-presentation, .studio-presentation { display:inline-flex; flex:none; gap:2px; align-self:center; margin-left:auto; margin-right:8px; padding:2px; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-1); }
.studio-presentation button { height:28px; padding:0 10px; border:0; border-radius:4px; background:transparent; color:var(--text-secondary); font-size:13px; font-weight:500; }
.studio-presentation button.on { background:var(--accent-dim); color:var(--accent); font-weight:600; }
.layout-topbar { display:flex; flex-wrap:wrap; align-items:center; gap:8px 12px; }
.layout-ai { flex:1 1 360px; display:flex; gap:8px; min-width:0; }
.layout-ai input { flex:1; min-width:0; height:34px; padding:0 12px; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-2); color:var(--text-primary); font-size:13px; }
.layout-ai button { flex:none; height:34px; padding:0 14px; border:0; border-radius:8px; background:var(--accent); color:var(--accent-fg); font-size:13px; font-weight:600; cursor:pointer; }
.layout-ai button:disabled { opacity:.55; cursor:default; }
.layout-ai button:focus-visible, .layout-ai input:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
.layout-surface { display:grid; gap:10px; }
.layout-addbar { display:flex; flex-wrap:wrap; align-items:center; gap:6px; padding:6px 8px; border:1px solid var(--border-subtle); border-radius:8px; background:var(--bg-2); }
.layout-addbar > span:first-child { padding:0 4px; color:var(--text-secondary); font-size:12px; font-weight:600; }
.layout-addbar button, .layout-toolbar button, .layout-toolbar select { display:inline-flex; align-items:center; gap:5px; height:28px; padding:0 9px; border:1px solid var(--border-subtle); border-radius:4px; background:var(--bg-2); color:var(--text-primary); font-size:12px; font-weight:500; cursor:pointer; }
.layout-addbar button:hover:not(:disabled), .layout-toolbar button:hover:not(:disabled) { border-color:var(--border-strong); background:var(--bg-1); }
.layout-addbar button:disabled, .layout-toolbar button:disabled { opacity:.45; cursor:default; }
.layout-addbar button:focus-visible, .layout-toolbar button:focus-visible, .layout-toolbar select:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
.layout-addbar-menu { position:relative; }
.layout-hint { margin-left:auto; color:var(--text-secondary); font-size:12px; }
.layout-refusal { margin:0; padding:8px 12px; border:1px solid var(--status-warning-border, rgba(168,100,26,.35)); border-radius:8px; background:var(--status-warning-bg, rgba(211,138,31,.08)); color:var(--text-primary); font-size:13px; }
.layout-toolbar { position:absolute; z-index:20; display:flex; align-items:center; gap:4px; padding:4px; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-2); box-shadow:0 8px 24px rgba(0,0,0,.14); white-space:nowrap; }
.layout-toolbar button.icon { width:28px; padding:0; justify-content:center; }
.layout-toolbar button.danger:hover:not(:disabled) { color:var(--status-error, #c14545); }
.layout-piece-label { padding:0 8px; color:var(--accent); font-size:12px; font-weight:600; max-width:220px; overflow:hidden; text-overflow:ellipsis; }
.layout-toolbar-sep { width:1px; height:18px; margin:0 2px; background:var(--border-subtle); }
.layout-popover { position:absolute; top:calc(100% + 6px); left:0; z-index:30; width:280px; max-height:320px; overflow:auto; display:grid; gap:2px; padding:6px; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-2); box-shadow:0 12px 32px rgba(0,0,0,.16); white-space:normal; }
.layout-popover button { display:flex !important; justify-content:space-between; gap:12px; width:100%; height:auto !important; min-height:30px; padding:6px 8px !important; border:0 !important; text-align:left; }
.layout-popover button small { color:var(--text-secondary); font-size:12px; font-variant-numeric:tabular-nums; }
.layout-popover-search { height:30px; margin:2px 2px 6px; padding:0 10px; border:1px solid var(--border-default); border-radius:4px; background:var(--bg-1); color:var(--text-primary); font-size:13px; }
.layout-popover-group { display:grid; gap:1px; }
.layout-popover-group + .layout-popover-group { margin-top:4px; padding-top:4px; border-top:1px solid var(--border-subtle); }
.layout-popover-group > span { padding:4px 8px 2px; color:var(--text-secondary); font-size:11px; font-weight:600; letter-spacing:.04em; text-transform:uppercase; }
.layout-popover button strong { font-weight:500; }
.layout-popover p { margin:4px 8px; color:var(--text-secondary); font-size:12px; }
.layout-empty { display:grid; justify-items:center; gap:8px; padding:48px 24px; border:1px dashed var(--border-default); border-radius:12px; text-align:center; }
.layout-empty strong { font-size:16px; font-weight:600; color:var(--text-primary); }
.layout-empty span { max-width:420px; color:var(--text-secondary); font-size:13px; line-height:1.5; }
.layout-empty div { display:flex; gap:8px; margin-top:6px; }
.layout-empty button { height:34px; padding:0 14px; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-2); color:var(--text-primary); font-size:13px; font-weight:500; }
.layout-empty button.primary { border-color:var(--accent); background:var(--accent); color:var(--accent-fg); }
.page-format { position:relative; flex:none; align-self:center; margin-left:auto; margin-right:8px; }
.page-format-button { display:inline-flex; align-items:center; gap:6px; height:32px; padding:0 10px; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-2); color:var(--text-secondary); font-size:13px; cursor:pointer; }
.page-format-button strong { color:var(--text-primary); font-weight:600; }
.page-format-button:hover { border-color:var(--border-strong); }
.page-format-button:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
.page-format-menu { position:absolute; top:calc(100% + 6px); right:0; z-index:30; width:320px; display:grid; gap:2px; padding:6px; border:1px solid var(--border-default); border-radius:12px; background:var(--bg-2); box-shadow:0 12px 32px rgba(0,0,0,.14); }
.page-format-menu button { display:grid; grid-template-columns:20px minmax(0,1fr) 16px; align-items:start; gap:10px; padding:8px; border:0; border-radius:8px; background:transparent; color:var(--text-secondary); text-align:left; cursor:pointer; }
.page-format-menu button svg { margin-top:2px; }
.page-format-menu button:hover, .page-format-menu button:focus-visible { background:var(--bg-1); outline:none; }
.page-format-menu button.on { background:var(--accent-dim); color:var(--accent); }
.page-format-menu button span { display:grid; gap:2px; }
.page-format-menu button strong { color:var(--text-primary); font-size:13px; font-weight:600; }
.page-format-menu button small { color:var(--text-secondary); font-size:12px; line-height:1.4; }
/* The page heading styles its own spans and divs as a title; the format control is not one. */
.studio-page-heading > .page-format { display:block; }
.studio-page-heading .page-format span { font-size:inherit; font-weight:inherit; letter-spacing:normal; }
.page-format-menu p { margin:4px 8px 2px; padding-top:8px; border-top:1px solid var(--border-subtle); color:var(--text-secondary); font-size:12px; line-height:1.4; }
.studio-story { max-width:820px; margin:0 auto; display:grid; gap:14px; }
.studio-story .proposal-banner { flex-wrap:wrap; }
.proposal-banner-actions { display:inline-flex; gap:6px; margin-left:auto; }
.proposal-banner-actions button { height:28px; padding:0 10px; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-2); color:var(--text-primary); font-size:13px; font-weight:600; }
.proposal-banner-actions button.primary { border-color:var(--accent); background:var(--accent); color:var(--bg-2); }
.studio-story-editor { display:grid; gap:12px; }
.studio-story-draft { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:6px 8px; align-items:center; padding:12px; border:1px solid var(--border-subtle); border-radius:12px; background:var(--bg-2); }
.studio-story-draft input { height:32px; padding:0 10px; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-1); color:var(--text-primary); font-size:13px; }
.studio-story-draft button.primary { height:32px; padding:0 12px; border:0; border-radius:8px; background:var(--accent); color:var(--bg-2); font-size:13px; font-weight:600; }
.studio-story-draft button.primary:disabled { opacity:.55; }
.studio-story-draft small { grid-column:1/-1; }
.studio-story-empty { margin:0; color:var(--text-tertiary); font-size:13px; }
.studio-story-block { display:grid; gap:8px; padding:10px 12px 12px; border:1px solid var(--border-subtle); border-radius:12px; background:var(--bg-2); }
.studio-story-block > header { display:flex; align-items:center; justify-content:space-between; gap:8px; color:var(--text-tertiary); font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:.04em; }
.studio-story-block-tools { display:inline-flex; gap:2px; }
.studio-story-block-tools button { width:26px; height:26px; border:0; border-radius:4px; background:transparent; color:var(--text-secondary); font-size:13px; }
.studio-story-block-tools button:hover:not(:disabled) { background:var(--bg-0); color:var(--text-primary); }
.studio-story-text { display:grid; gap:8px; }
.studio-story-text textarea { min-height:72px; resize:vertical; padding:8px 10px; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-1); color:var(--text-primary); font:400 14px/1.5 var(--font-ui); }
.studio-story-text-tools select, .studio-story-add select { height:30px; max-width:100%; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-1); color:var(--text-primary); font-size:13px; }
.studio-story-issues { margin:0; padding-left:18px; color:var(--status-error); font-size:12px; display:grid; gap:2px; }
.studio-story-issues li.warn { color:var(--status-warning); }
.studio-story-preview { padding:8px 10px; border-left:2px solid var(--accent-dim); color:var(--text-primary); font-size:14px; line-height:1.6; display:grid; gap:8px; }
.studio-story-preview p { margin:0; }
.studio-story-preview .dql-story-value, .studio-story .dql-story-value { font-weight:600; font-variant-numeric:tabular-nums; border-bottom:1px dotted var(--accent); }
.studio-story-preview .dql-story-value.missing { color:var(--text-tertiary); border-bottom-style:dashed; }
.studio-story-add { display:flex; flex-wrap:wrap; gap:8px; }
.studio-story-add button { height:30px; padding:0 12px; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-2); color:var(--text-primary); font-size:13px; font-weight:500; }
.studio-page-grid.story-embed { display:block; }
/* RFC 0008 step 9: governed HTML pages. */
.studio-canvas-page, .studio-canvas-editor { display:grid; gap:12px; }
.studio-canvas-tabs { display:flex; align-items:center; gap:4px; }
.studio-canvas-tabs button { height:30px; padding:0 12px; border:1px solid transparent; border-radius:8px; background:transparent; color:var(--text-secondary); font-size:13px; font-weight:500; }
.studio-canvas-tabs button.on { border-color:var(--border-default); background:var(--bg-2); color:var(--text-primary); font-weight:600; }
.studio-canvas-tabs .studio-canvas-template { margin-left:auto; border-color:var(--border-default); background:var(--bg-2); color:var(--text-primary); }
.studio-canvas-code { display:grid; gap:8px; }
.studio-canvas-code textarea { min-height:420px; resize:vertical; padding:10px 12px; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-1); color:var(--text-primary); font:400 12px/1.5 var(--font-mono, ui-monospace, monospace); }
.studio-page-grid.story-embed .studio-component-card { min-height:260px; }
.live-component-preview.driver { overflow:auto; }
.inspector-docs textarea { resize:vertical; min-height:52px; }
.inspector-body .inspector-title input:focus { border-color:var(--accent); background:var(--bg-2); }
.inspector-tabs { position:sticky; top:0; z-index:2; display:flex; gap:2px; margin:-6px -16px 0; padding:0 12px; border-bottom:1px solid var(--border-subtle); background:var(--bg-2); }
.inspector-tabs button { height:36px; padding:0 10px; border:0; background:transparent; color:var(--text-secondary); font-size:13px; font-weight:500; }
.inspector-tabs button:hover { color:var(--text-primary); }
.inspector-tabs button.on { color:var(--text-primary); font-weight:600; box-shadow:inset 0 -2px 0 var(--text-primary); }
.inspector-body label { color:var(--text-secondary); font-size:12px; font-weight:600; text-transform:none; letter-spacing:0; }
.inspector-body input, .inspector-body textarea, .inspector-body select { padding:7px 10px; background:var(--bg-2); font-size:13px; }
.inspector-body input:focus, .inspector-body textarea:focus, .inspector-body select:focus { border-color:var(--accent); box-shadow:0 0 0 2px var(--accent-dim); }
.chart-type-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:6px; }
.chart-type-grid button { height:56px; border:1px solid var(--border-subtle); border-radius:8px; background:var(--bg-2); color:var(--text-secondary); display:flex; flex-direction:column; align-items:center; justify-content:center; gap:4px; font-size:12px; }
.chart-type-grid button:hover { border-color:var(--border-strong); color:var(--text-primary); }
.chart-type-grid button.on { border-color:var(--accent); background:var(--accent-dim); color:var(--accent); font-weight:600; }
.chart-type-grid button:disabled { opacity:.5; cursor:default; }
.inspector-footer { position:sticky; bottom:-16px; z-index:2; margin:4px -16px -16px; padding:10px 16px; border-top:1px solid var(--border-subtle); background:var(--bg-2); display:flex; align-items:center; justify-content:space-between; gap:8px; }
.run-state { display:flex; align-items:center; gap:6px; color:var(--text-secondary); font-size:12px; }
.run-state::before { content:''; width:7px; height:7px; border-radius:50%; background:var(--text-muted); }
.run-state.ok::before { background:var(--status-success); }
.run-state.error::before { background:var(--status-error); }
.inspector-footer .delete-component { width:auto; height:30px; padding:0 10px; border:0; border-radius:8px; background:transparent; font-size:13px; font-weight:500; }
.inspector-footer .delete-component:hover { background:color-mix(in srgb,var(--status-error) 9%,var(--bg-2)); }
.inspector-id { color:var(--text-muted); font-size:11px; }

.studio-topbar { background:var(--bg-2); }
.studio-workspace { background:var(--bg-canvas); }
.live-component-preview .dql-kpi-card { align-items:flex-start !important; justify-content:flex-end !important; padding:4px 6px 10px !important; }
.live-component-preview .dql-kpi-value { font-family:inherit !important; font-size:min(clamp(26px,2.4vw,34px), var(--kpi-fit, 99px)) !important; font-weight:600 !important; letter-spacing:-.02em; color:var(--text-primary) !important; }
.dataset-mark-controls.marks { position:absolute; width:1px; height:1px; margin:-1px; padding:0; overflow:hidden; clip:rect(0 0 0 0); border:0; }
.dataset-mark-controls.marks:focus-within { position:static; width:auto; height:auto; margin:6px 0 0; overflow:visible; clip:auto; padding:6px 0 0; border-top:1px solid var(--border-subtle); }
.dataset-mark-controls { border-top:0; padding:6px 2px 0; }
.dataset-mark-controls > span { color:var(--text-tertiary); font-weight:600; }
.dql-studio-v2 .dataset-detail-navigation { width:auto; margin:6px 2px 0 auto; display:flex; align-items:center; gap:4px; border:0; background:transparent; color:var(--accent); font-size:13px; font-weight:600; padding:4px 6px; border-radius:8px; }
.dql-studio-v2 .dataset-detail-navigation:hover { background:var(--accent-dim); }
.dql-studio-v2 .studio-copilot-panel { grid-column:3; grid-row:2; position:relative; width:400px; top:auto !important; bottom:auto !important; height:auto !important; }
.studio-ai-scope { margin:10px 12px 0; }
.studio-ai-scope button { display:inline-flex; align-items:center; justify-content:center; gap:6px; font-size:13px; }

/* ── Data panel: one Dataset, its fields; click to build ── */
.data-panel { display:flex; flex-direction:column; gap:10px; }
.dataset-picker { position:relative; }
.dataset-picker:has(> .dataset-more) { display:flex; gap:2px; align-items:center; }
.dataset-picker:has(> .dataset-more) > .dataset-current { flex:1; min-width:0; }
.dataset-current { width:100%; display:flex; align-items:center; gap:10px; padding:10px; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-2); text-align:left; }
.dataset-current:hover { border-color:var(--border-strong); }
.dataset-current:disabled { cursor:default; opacity:.7; }
.dataset-icon { width:30px; height:30px; flex:none; border-radius:8px; display:grid; place-items:center; color:var(--accent); background:var(--accent-dim); }
.dataset-text { min-width:0; flex:1; display:grid; gap:2px; }
.dataset-text strong { font-size:14px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dataset-text small { display:flex; align-items:center; gap:4px; color:var(--text-tertiary); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dataset-text small.certified { color:var(--status-success); font-weight:600; }
.dataset-text small.review { color:var(--status-warning); font-weight:600; }
.dataset-menu { position:absolute; z-index:15; top:calc(100% + 4px); left:0; right:0; padding:6px; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-2); box-shadow:0 12px 32px color-mix(in srgb,var(--text-primary) 14%,transparent); display:grid; max-height:320px; overflow:auto; }
.dataset-menu button { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:7px 9px; border:0; border-radius:8px; background:transparent; text-align:left; }
.dataset-menu button:hover, .dataset-menu button.on { background:var(--bg-0); }
.dataset-menu button span { display:grid; gap:1px; min-width:0; }
.dataset-menu strong { font-size:13px; font-weight:600; }
.dataset-menu small { color:var(--text-tertiary); font-size:12px; }
.dataset-menu hr { border:0; border-top:1px solid var(--border-subtle); margin:5px 0; }
.field-search { height:32px; display:flex; align-items:center; gap:7px; padding:0 9px; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-2); color:var(--text-tertiary); }
.field-search:focus-within { border-color:var(--accent); box-shadow:0 0 0 2px var(--accent-dim); }
.field-search input { min-width:0; flex:1; border:0; outline:0; background:transparent; color:var(--text-primary); font-size:13px; }
.field-search button { width:22px; height:22px; border:0; border-radius:4px; background:transparent; color:var(--text-tertiary); display:grid; place-items:center; padding:0; }
.field-target { margin:0; padding:8px 10px; border-radius:8px; background:var(--accent-dim); color:var(--text-secondary); font-size:13px; line-height:1.45; }
/* A fixed two-line box: the field list under it keeps its place when the text changes. */
.field-target { box-sizing:border-box; flex:none; height:calc(2.9em + 16px); overflow:hidden; display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; }
.field-target strong { color:var(--text-primary); font-weight:600; }
.field-groups { display:grid; gap:4px; }
.field-groups section { display:grid; gap:1px; }
.field-groups h3 { margin:8px 8px 4px; color:var(--text-tertiary); font-size:11px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; }
.data-field { width:100%; height:30px; display:flex; align-items:center; gap:8px; padding:0 8px; border:0; border-radius:8px; background:transparent; color:var(--text-primary); font-size:13px; text-align:left; }
.data-field:hover:not(:disabled) { background:var(--bg-0); }
.data-field.on { background:var(--accent-dim); color:var(--accent); font-weight:600; }
.data-field:disabled { color:var(--text-tertiary); cursor:default; }
.data-field .glyph { width:18px; flex:none; display:grid; place-items:center; color:var(--accent); }
.data-field .glyph .sigma { color:var(--accent); font-size:13px; font-weight:600; }
.data-field .glyph .aa { font-size:11px; font-weight:600; }
.data-field .glyph svg { color:var(--status-warning); }
/* The name keeps its room: the grain list ("month · quarter · year") gives way first. */
.data-field .name { min-width:0; flex:1 1 auto; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.data-field .meta { min-width:0; flex:0 1000 auto; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--text-tertiary); font-family:var(--font-mono, ui-monospace, monospace); font-size:11px; font-weight:400; }
.data-field .badge { padding:1px 6px; border-radius:4px; background:color-mix(in srgb,var(--status-warning) 12%,var(--bg-2)); color:var(--status-warning); font-size:11px; font-weight:600; }
.data-field .check { flex:none; }
.field-groups .related-fields h3 { display:flex; align-items:center; gap:6px; text-transform:none; letter-spacing:0; font-size:12px; }
.field-groups .related-fields h3 .badge { padding:1px 6px; border-radius:4px; background:color-mix(in srgb,var(--status-warning) 12%,var(--bg-2)); color:var(--status-warning); font-size:11px; font-weight:600; }
.join-notes { display:grid; gap:4px; margin:6px 8px 0; }
.join-notes small { color:var(--text-tertiary); font-size:12px; line-height:1.4; }
.field-empty { margin:6px 2px; color:var(--text-tertiary); font-size:13px; line-height:1.5; }
.field-empty button { border:0; background:transparent; color:var(--accent); font-weight:600; padding:0; }
.content-quick-add.compact { display:grid; grid-template-columns:1fr 1fr; gap:6px; }
.content-quick-add.compact button { display:flex; align-items:center; gap:7px; height:34px; padding:0 10px; border:1px solid var(--border-subtle); border-radius:8px; background:var(--bg-2); color:var(--text-secondary); }
.content-quick-add.compact button:hover { border-color:var(--border-strong); color:var(--text-primary); }
.content-quick-add.compact strong { font-size:13px; font-weight:500; }
.panel-back { display:inline-flex; align-items:center; gap:5px; margin:0 0 10px; padding:4px 6px; border:0; border-radius:8px; background:transparent; color:var(--accent); font-size:13px; font-weight:600; }
.panel-back:hover { background:var(--accent-dim); }

/* ── A tile being built ── */
.draft-tile { grid-column:1/-1; border:1.5px solid var(--accent) !important; box-shadow:0 0 0 4px var(--accent-dim); cursor:default !important; }
.draft-tile > header { min-height:44px; }
.draft-badge { padding:3px 7px; border-radius:4px; background:var(--accent-dim); color:var(--accent); font-size:11px; font-weight:600; letter-spacing:.05em; }
.draft-status { margin-left:auto; display:flex; align-items:center; gap:6px; color:var(--text-secondary); font-size:12px; white-space:nowrap; }
.draft-status::before { content:''; width:7px; height:7px; border-radius:50%; background:var(--text-muted); }
.draft-status.ok::before { background:var(--status-success); }
.draft-status.error::before { background:var(--status-error); }
.draft-body { min-height:260px; padding:4px 14px 14px; display:flex; flex-direction:column; }
.draft-body > div:not(.draft-empty) { width:100%; }
.draft-body .dql-kpi-card { align-items:flex-start !important; justify-content:center !important; padding-left:6px !important; }
.draft-body .dql-kpi-value { font-family:inherit !important; font-size:40px !important; font-weight:600 !important; letter-spacing:-.02em; color:var(--text-primary) !important; }
.draft-empty { flex:1; min-height:240px; border:1.5px dashed var(--border-strong); border-radius:8px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:6px; color:var(--text-secondary); text-align:center; padding:20px; }
.draft-empty strong { color:var(--text-primary); font-size:14px; font-weight:600; }
.draft-empty span { font-size:13px; max-width:420px; line-height:1.45; }
.draft-empty.warn { border-color:color-mix(in srgb,var(--status-warning) 45%,var(--border-default)); background:color-mix(in srgb,var(--status-warning) 5%,var(--bg-2)); }
.draft-empty.loading { border-style:solid; border-color:var(--border-subtle); }
.inspector-field { display:grid; gap:6px; }
.dataset-query-inspector { display:grid; gap:14px; padding:0; border:0; background:transparent; }
.inspector-body .data-trust { gap:8px; padding-top:12px; border-top:1px solid var(--border-subtle); }
.data-trust > .dataset-reusable-block, .data-trust > .dataset-cache-delivery, .data-trust > .dataset-review-replacement { display:grid; gap:6px; margin-top:6px; padding:10px; border:1px solid var(--border-subtle); border-radius:8px; background:var(--bg-1); }
.data-trust > .dataset-reusable-block strong { font-size:13px; font-weight:600; }
.data-trust > .dataset-reusable-block p { margin:0; color:var(--text-secondary); font-size:13px; line-height:1.45; }
.data-trust > .dataset-reusable-block button, .data-trust > .dataset-cache-delivery button { justify-self:start; height:30px; padding:0 10px; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-2); font-size:13px; font-weight:500; }
.data-trust > .dataset-reusable-block button:disabled { opacity:.5; cursor:not-allowed; }
.dataset-query-inspector .static-field, .draft-inspector .static-field { height:32px; display:flex; align-items:center; padding:0 10px; border:1px solid var(--border-subtle); border-radius:8px; background:var(--bg-1); font-size:13px; }
.pill-row { display:flex; flex-wrap:wrap; gap:6px; }
.field-pill { display:inline-flex; align-items:center; gap:4px; height:28px; padding:0 4px 0 10px; border-radius:8px; background:var(--bg-0); color:var(--text-primary); font-size:13px; font-weight:500; }
.field-pill.measure { background:var(--accent-dim); color:var(--accent); }
.field-pill button { width:20px; height:20px; border:0; border-radius:4px; background:transparent; color:inherit; display:grid; place-items:center; padding:0; }
.field-pill button:hover { background:color-mix(in srgb,currentColor 12%,transparent); }
.segmented { display:flex; padding:3px; border-radius:8px; background:var(--bg-0); }
.segmented button { flex:1; height:28px; border:0; border-radius:8px; background:transparent; color:var(--text-secondary); font-size:13px; font-weight:500; }
.segmented button.on { background:var(--bg-2); color:var(--text-primary); font-weight:600; box-shadow:0 1px 2px color-mix(in srgb,var(--text-primary) 10%,transparent); }
.segmented button:disabled { opacity:.4; cursor:not-allowed; }
.draft-more { border-top:1px solid var(--border-subtle); padding-top:10px; }
.draft-more > summary { cursor:pointer; color:var(--text-secondary); font-size:13px; font-weight:600; margin-bottom:8px; }
.inspector-footer .secondary, .inspector-footer .primary { height:32px; padding:0 14px; border-radius:8px; font-size:13px; font-weight:500; }
.inspector-footer .secondary { border:1px solid var(--border-default); background:var(--bg-2); }
.inspector-footer .primary { margin-left:auto; border:1px solid var(--accent); background:var(--accent); color:var(--accent-fg); font-weight:600; }
.inspector-footer .primary:disabled { opacity:.45; cursor:not-allowed; }

/* ── AI proposals drawn on the canvas ── */
.proposal-banner { display:flex; align-items:flex-start; gap:8px; margin:0 0 14px; padding:10px 12px; border:1px solid color-mix(in srgb,var(--accent) 30%,var(--border-default)); border-radius:8px; background:var(--accent-dim); color:var(--text-secondary); font-size:13px; line-height:1.45; }
.proposal-banner svg { flex:none; margin-top:2px; color:var(--accent); }
.proposal-banner strong { color:var(--accent); font-weight:600; }
.proposal-banner.warn { border-color:color-mix(in srgb,var(--status-warning) 45%,var(--border-default)); background:color-mix(in srgb,var(--status-warning) 7%,var(--bg-2)); }
.proposal-tile { border:1.5px dashed var(--accent) !important; background:color-mix(in srgb,var(--accent-dim) 45%,var(--bg-2)) !important; cursor:default !important; }
.proposal-badge { flex:none; padding:3px 7px; border-radius:4px; background:var(--accent); color:var(--accent-fg); font-size:11px; font-weight:600; letter-spacing:.05em; }
.chart-style-panel { display:grid; gap:8px; }
.chart-style-grid { display:grid; grid-template-columns:minmax(0,96px) minmax(0,1fr); gap:6px 8px; align-items:center; }
.chart-style-grid label { font-size:12px; font-weight:400; color:var(--text-secondary); }
.chart-style-grid select, .chart-style-row input { width:100%; box-sizing:border-box; height:28px; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-2); color:var(--text-primary); font:inherit; font-size:12px; padding:0 8px; }
.chart-style-check { display:flex; align-items:center; gap:8px; font-size:12px; font-weight:400; color:var(--text-secondary); }
.chart-style-check input { accent-color:var(--accent); width:auto !important; flex:none; margin:0; }
.chart-style-marks { display:grid; gap:6px; border-top:1px solid var(--border-subtle); padding-top:8px; }
.chart-style-heading { font-size:12px; font-weight:500; color:var(--text-primary); }
.chart-style-row { display:flex; gap:6px; align-items:center; }
.chart-style-row button { flex:none; width:28px; height:28px; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-2); color:var(--text-secondary); cursor:pointer; }
.chart-style-row select { min-width:0; flex:1; box-sizing:border-box; height:28px; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-2); color:var(--text-primary); font:inherit; font-size:12px; padding:0 6px; }
.chart-style-format { display:grid; gap:4px; }
.chart-style-totals { display:grid; gap:4px; margin:0; padding:8px 0 0; border:0; border-top:1px solid var(--border-subtle); }
.chart-style-totals legend { padding:0; margin-bottom:4px; }
.chart-style-rule { padding-left:12px; }
.chart-style-rule select:first-child { flex:0 0 72px; }
.chart-style-add { justify-self:start; border:0; background:transparent; color:var(--accent); font:inherit; font-size:12px; font-weight:500; padding:0; cursor:pointer; }
.proposal-keep { margin-left:auto; display:inline-flex; align-items:center; gap:6px; font-size:12px; font-weight:500; color:var(--text-secondary); cursor:pointer; }
.proposal-keep input { accent-color:var(--accent); }
.proposal-tile.skipped { opacity:.5; border-style:dotted !important; background:var(--bg-2) !important; }
.proposal-tile.skipped .proposal-badge { background:var(--bg-3); color:var(--text-secondary); }
.proposal-badge.updated, .proposal-badge.link { background:var(--accent-dim); color:var(--accent); border:1px solid color-mix(in srgb,var(--accent) 35%,transparent); }
.proposal-badge.removed { background:color-mix(in srgb,var(--status-error) 10%,var(--bg-2)); color:var(--status-error); }
.proposal-was { color:var(--text-tertiary); font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.studio-component-card.proposal-linked { border:1.5px dashed var(--accent); }
.studio-component-card.proposal-removed { opacity:.5; border-style:dashed; }
.has-proposal .studio-component-card:not(.proposal-tile) { cursor:default; }
.page-nav > button.proposed-page { border:1px dashed color-mix(in srgb,var(--accent) 50%,var(--border-default)); color:var(--accent); }
.page-nav .change-dot { display:inline-block; width:6px; height:6px; margin-left:6px; border-radius:50%; background:var(--accent); vertical-align:middle; }
.studio-plan-pane { width:420px; overflow-y:auto; }
.studio-plan-pane .studio-ai-plan { border:0; border-radius:0; box-shadow:none; background:transparent; margin:0; max-width:none; }
.studio-plan-pane .studio-ai-plan > header { padding:16px 16px 10px; grid-template-columns:28px minmax(0,1fr) 30px; gap:10px; }
.studio-plan-pane .studio-ai-plan > header h1 { font-size:16px; margin:2px 0 4px; }
.studio-plan-pane .studio-ai-plan > header p { font-size:13px; line-height:1.45; margin:0; }
.studio-plan-pane .proposal-source-summary { padding:0 16px 10px; flex-wrap:wrap; gap:6px; }
.studio-plan-pane .proposal-source-body { padding:0 16px 16px; }
.studio-plan-pane .proposal-source-row, .studio-plan-pane .proposal-catalog-list > article { grid-template-columns:32px minmax(0,1fr); }
.studio-plan-pane .proposal-source-row > button, .studio-plan-pane .proposal-catalog-list > article > button { grid-column:2; justify-self:start; }
.studio-plan-pane .studio-ai-plan > footer { position:sticky; bottom:0; z-index:2; display:grid; grid-template-columns:1fr 2fr; gap:8px; padding:12px 16px; border-top:1px solid var(--border-subtle); background:var(--bg-2); }
.studio-plan-pane .studio-ai-plan > footer > span { grid-column:1/-1; color:var(--text-tertiary); font-size:12px; }
.studio-plan-pane .studio-ai-plan > footer button { justify-content:center; height:34px; }
.studio-ai-activity-docked { padding:28px 20px; display:grid; justify-items:center; gap:10px; text-align:center; }
.studio-ai-activity-docked > div { display:grid; justify-items:center; gap:8px; }
.studio-ai-activity-docked .loading-mark { width:44px; height:44px; border-radius:12px; display:grid; place-items:center; color:var(--accent); background:var(--accent-dim); animation:studio-loading-pulse 1.4s ease-in-out infinite; }
.studio-ai-activity-docked strong { font-size:16px; }
.studio-ai-activity-docked small { color:var(--text-tertiary); font-size:13px; line-height:1.5; }
.studio-ai-activity-docked .studio-ai-activity-actions button { height:32px; padding:0 12px; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-2); font-size:13px; }
.studio-ai-activity-docked .studio-ai-activity-actions button.primary { border-color:var(--accent); background:var(--accent); color:var(--accent-fg); }

@media (max-width:1240px) {
  .dql-studio-v2 { grid-template-columns:240px minmax(0,1fr) auto; }
  .studio-brand { width:auto; }
  .studio-brand input { width:150px; }
  .studio-right, .dql-studio-v2 .studio-copilot-panel { position:fixed; z-index:18; right:0; top:52px; bottom:0; box-shadow:-12px 0 36px color-mix(in srgb,var(--text-primary) 13%,transparent); }
  .dql-studio-v2 .studio-copilot-panel { width:min(400px,calc(100vw - 64px)); }
  .studio-actions .copilot span, .studio-actions .preview span { display:none; }
  .studio-actions .copilot, .studio-actions .preview { width:32px; padding:0; justify-content:center; }
}
@media (max-width:900px) {
  .dql-studio-v2-launch > main { grid-template-columns:1fr; width:min(100% - 28px,620px); padding-top:28px; gap:22px; }
  .dql-app-studio-home { grid-template-columns:1fr; padding:28px 0 38px; gap:18px; }
  .dql-studio-v2-intro { position:static; }
  .dql-studio-v2-intro h1 { font-size:32px; }
  .recent-drafts { grid-column:1; }
  .dql-studio-v2 { grid-template-columns:minmax(0,1fr) auto; }
  .studio-topbar { gap:8px; }
  .studio-brand .mark, .studio-brand > div { display:none; }
  .studio-actions .history { display:none; }
  .studio-actions { gap:5px; }
  .studio-actions .publish { padding:0 10px; }
  .studio-actions .publish small { display:none; }
  .studio-left { position:fixed; z-index:12; left:0; top:52px; bottom:0; width:0; overflow:visible; }
  .studio-left > nav { position:fixed; left:0; right:0; bottom:0; z-index:13; justify-content:center; background:var(--bg-2); border-top:1px solid var(--border-subtle); padding:0 8px; }
  .left-content { display:none; position:fixed; z-index:12; left:0; top:52px; bottom:35px; width:min(300px,100vw); background:var(--bg-1); border-right:1px solid var(--border-default); box-shadow:8px 0 24px color-mix(in srgb,var(--text-primary) 10%,transparent); padding-top:44px; overflow:auto; box-sizing:border-box; }
  .left-content.open { display:block; }
  .mobile-drawer-close { display:flex; position:absolute; right:10px; top:9px; width:28px; height:28px; align-items:center; justify-content:center; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-1); color:var(--text-secondary); }
  .studio-workspace, .dql-studio-v2.studio-view .studio-workspace { grid-column:1; padding:14px 14px 56px; }
  .studio-page-heading { align-items:flex-start; gap:8px; }
  .studio-source-ready { align-items:flex-start; flex-direction:column; }
  .template-grid { grid-template-columns:1fr; }
  .policy-toggle { grid-template-columns:1fr 36px; }
  .policy-toggle > span:last-child { grid-column:1/-1; }
}
@media (max-width:620px) {
  .dql-app-studio-home .dql-studio-v2-start-card { padding:16px; border-radius:12px; }
  .dql-app-studio-home .dql-studio-v2-intro h1 { font-size:32px; }
          .studio-ai-plan { border-radius:12px; }
  .studio-ai-plan > header, .proposal-source-body, .studio-ai-plan > footer { padding-left:14px; padding-right:14px; }
  .studio-ai-plan > header h1 { font-size:20px; }
  .proposal-source-summary { padding-left:14px; padding-right:14px; }
  .proposal-source-row, .proposal-catalog-list > article { grid-template-columns:32px minmax(0,1fr); }
  .proposal-source-row > button, .proposal-catalog-list > article > button { grid-column:2; justify-self:start; }
  .studio-ai-plan > footer { display:grid; grid-template-columns:1fr 1fr; }
  .studio-ai-plan > footer > span { grid-column:1/-1; }
  .studio-ai-plan > footer button.primary { justify-content:center; }
  .proposal-scrim { padding:10px; align-items:flex-end; }
  .studio-readiness-card { max-height:calc(100vh - 20px); border-radius:12px 12px 0 0; }
  .dataset-source-authoring-card { max-height:calc(100vh - 20px); border-radius:12px 12px 0 0; }
  .studio-readiness-card > header, .readiness-body, .studio-readiness-card > footer { padding-left:14px; padding-right:14px; }
  .readiness-item { padding:10px; }
  .dataset-source-authoring-card > header, .dataset-source-authoring-body, .dataset-source-authoring-card > footer { padding-left:14px; padding-right:14px; }
  .dataset-source-candidates > div { grid-template-columns:1fr; }
  .dataset-source-grain { grid-template-columns:1fr; }
  .dataset-source-grain > label, .dataset-source-grain > small { grid-column:auto; }
  .studio-readiness-card > footer { display:grid; grid-template-columns:1fr 1fr; }
}
/* RFC 0008 step 5: the placed canvas. Tiles sit in the cells their author gave them. */
.studio-page-grid.placed { gap:12px; align-items:stretch; }
.studio-draft-slot { margin-bottom:12px; }
.studio-page-grid.placed .studio-component-card { min-height:0; display:flex; flex-direction:column; }
.studio-page-grid.placed .studio-component-card > :not(header):not(.tile-resize-handle) { min-height:0; }
.studio-page-grid.placed .tile-text { flex:1; overflow:auto; }
.studio-page-grid.placed .studio-tile-preview-interactions { flex:1 1 0; min-height:0; display:flex; flex-direction:column; overflow:hidden; }
.studio-page-grid.placed .preview-state, .studio-page-grid.placed .preview-skeleton { min-height:0; height:100%; box-sizing:border-box; }
.studio-page-grid.placed .live-component-preview { flex:1 1 0; height:auto; min-height:0; display:flex; flex-direction:column; overflow:hidden; }
.studio-page-grid.placed .live-component-preview > .live-component-body { flex:1 1 0; height:auto; min-height:0; overflow:hidden; }
.studio-page-grid.placed .live-component-preview > :not(.live-component-body) { flex:none; }
.studio-page-grid.placed .preview-state, .studio-page-grid.placed .preview-skeleton { flex:1 1 0; }
.studio-edit .studio-page-grid.placed .studio-component-card > header { cursor:grab; touch-action:none; user-select:none; }
.studio-page-grid.arranging, .studio-page-grid.arranging * { cursor:grabbing !important; user-select:none; }
.studio-page-grid.arranging { background-image:linear-gradient(to right, var(--border-subtle) 1px, transparent 1px); background-size:calc((100% + 12px) / 12) 100%; }
.studio-component-card.gesturing { border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-dim), 0 12px 32px color-mix(in srgb,var(--text-primary) 12%,transparent); z-index:5; }
.studio-component-card:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.tile-resize-handle { position:absolute; z-index:4; touch-action:none; }
.tile-resize-handle.e { top:12px; right:-4px; bottom:12px; width:8px; cursor:ew-resize; }
.tile-resize-handle.s { left:12px; right:12px; bottom:-4px; height:8px; cursor:ns-resize; }
.tile-resize-handle.se { right:-4px; bottom:-4px; width:14px; height:14px; cursor:nwse-resize; }
.tile-resize-handle.se::after { content:''; position:absolute; right:6px; bottom:6px; width:8px; height:8px; border-right:2px solid var(--text-tertiary); border-bottom:2px solid var(--text-tertiary); border-radius:0 0 4px 0; opacity:0; transition:opacity .12s; }
.studio-component-card:hover .tile-resize-handle.se::after, .studio-component-card.selected .tile-resize-handle.se::after { opacity:1; }
.tile-menu kbd { margin-left:auto; font:inherit; font-size:12px; color:var(--text-tertiary); }
.studio-canvas-keys { margin:12px 0 0; color:var(--text-tertiary); font-size:12px; line-height:1.5; }
.visually-hidden { position:absolute; width:1px; height:1px; margin:-1px; padding:0; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; border:0; }
.preview-skeleton { min-height:130px; padding:12px 14px 14px; display:flex; flex-direction:column; gap:8px; }
.preview-skeleton i { display:block; border-radius:4px; background:var(--bg-0); animation:studio-skeleton 1.4s ease-in-out infinite; }
.preview-skeleton .sk-value { width:44%; height:32px; }
.preview-skeleton .sk-caption { width:28%; height:12px; }
.preview-skeleton .sk-row { height:20px; }
.preview-skeleton .sk-bars { flex:1; min-height:96px; display:flex; align-items:flex-end; gap:8px; }
.preview-skeleton .sk-bars i { flex:1; border-radius:4px 4px 0 0; }
.preview-skeleton .sk-line { flex:1; width:100%; min-height:96px; }
.preview-skeleton .sk-line path { fill:none; stroke:var(--border-default); stroke-width:3; vector-effect:non-scaling-stroke; animation:studio-skeleton 1.4s ease-in-out infinite; }
/* RFC 0009 step 1: shelves for Dataset tiles. */
.shelf-editor { display:grid; gap:6px; }
.shelf { display:grid; grid-template-columns:60px minmax(0,1fr); align-items:start; gap:8px; }
.shelf-name { padding-top:7px; color:var(--text-secondary); font-size:12px; font-weight:500; }
.shelf-pills { list-style:none; margin:0; padding:3px; min-height:32px; display:flex; flex-wrap:wrap; align-items:center; gap:4px; border:1px dashed var(--border-default); border-radius:8px; background:var(--bg-1); }
.shelf.over .shelf-pills { border-style:solid; border-color:var(--accent); background:var(--accent-dim); }
.shelf-pill { position:relative; display:inline-flex; align-items:center; gap:4px; min-height:24px; padding:0 2px 0 8px; border-radius:999px; background:var(--bg-0); color:var(--text-primary); font-size:12px; font-weight:500; cursor:grab; }
.shelf-pill.measure { background:var(--accent-dim); color:var(--accent); }
.shelf-pill { max-width:100%; }
.shelf-pill svg { flex:none; }
.shelf-pill-name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.shelf-pill em { color:var(--text-secondary); font-style:normal; font-weight:400; }
.shelf-pill > button { width:20px; height:20px; display:grid; place-items:center; padding:0; border:0; border-radius:999px; background:transparent; color:inherit; cursor:pointer; }
.shelf-pill > button:hover, .shelf-pill > button[aria-expanded="true"] { background:color-mix(in srgb,currentColor 12%,transparent); }
.shelf-pill > button:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
/* "Top 10 ▾" on a measure pill: the tile's Top N or sort, one click from changing it. */
.shelf-pill > button.shelf-pill-sort { width:auto; height:18px; padding:0 6px; margin-left:2px; border-radius:999px; background:var(--accent-dim); color:var(--accent); font-size:11px; font-weight:600; white-space:nowrap; }
.shelf-empty { padding:3px 6px; color:var(--text-tertiary); font-size:12px; }
.shelf-marks { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; padding:8px; border:1px solid var(--border-subtle); border-radius:8px; }
.shelf.mark { grid-template-columns:minmax(0,1fr); gap:2px; }
.shelf.mark .shelf-name { padding-top:0; font-size:11px; }
.shelf.mark .shelf-pills { min-height:28px; }
.shelf-reading { margin:0; color:var(--text-secondary); font-size:12px; }
.show-me { display:grid; gap:6px; padding-top:8px; border-top:1px solid var(--border-subtle); }
.show-me-title { color:var(--text-secondary); font-size:12px; font-weight:500; }
.show-me-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(76px,1fr)); gap:4px; }
.show-me-grid button { position:relative; min-height:52px; padding:6px 4px 4px; border:1px solid var(--border-subtle); border-radius:8px; background:var(--bg-2); color:var(--text-secondary); display:flex; flex-direction:column; align-items:center; justify-content:center; gap:3px; font-size:11px; line-height:1.2; text-align:center; cursor:pointer; }
.show-me-grid button:hover { border-color:var(--border-strong); color:var(--text-primary); }
.show-me-grid button:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
.show-me-grid button.best { border-color:var(--accent); }
.show-me-grid button.on { border-color:var(--accent); background:var(--accent-dim); color:var(--accent); font-weight:600; }
.show-me-grid button.unfit { border-style:dashed; background:transparent; color:var(--text-tertiary); cursor:not-allowed; }
.show-me-grid button.unfit svg { opacity:.5; }
.show-me-grid button[aria-disabled="true"]:not(.unfit) { cursor:default; }
.show-me-best { position:absolute; top:-6px; right:4px; padding:0 5px; border-radius:999px; background:var(--accent); color:var(--accent-fg); font-size:11px; font-weight:600; line-height:14px; }
.show-me-misfit { display:grid; gap:6px; padding:8px 10px; border:1px solid var(--status-warning-border, rgba(168,100,26,.35)); border-radius:8px; background:var(--status-warning-bg, rgba(211,138,31,.08)); }
.show-me-misfit p { margin:0; color:var(--text-primary); font-size:12px; line-height:1.4; }
.show-me-misfit button { justify-self:start; height:28px; padding:0 10px; border:1px solid var(--accent); border-radius:8px; background:var(--accent); color:var(--accent-fg); font-size:12px; font-weight:600; cursor:pointer; }
.show-me-reason { margin:0; min-height:32px; color:var(--text-secondary); font-size:12px; line-height:1.4; }
.show-me-reason strong { color:var(--text-primary); font-weight:600; }
.show-me-reason.unfit strong { color:var(--text-secondary); }
.shelf-menu { position:absolute; top:28px; left:0; z-index:50; width:268px; padding:10px; display:grid; gap:10px; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-2); box-shadow:0 12px 32px rgba(15,23,42,.16); color:var(--text-primary); cursor:default; }
.shelf-menu-group { display:grid; gap:4px; margin:0; }
.shelf-menu-label { color:var(--text-secondary); font-size:11px; font-weight:500; }
.shelf-menu-chips, .shelf-menu-actions { display:flex; flex-wrap:wrap; gap:4px; }
.shelf-menu-chips button, .shelf-menu-actions button, .shelf-menu-row button { display:inline-flex; align-items:center; gap:4px; height:24px; padding:0 8px; border:1px solid var(--border-default); border-radius:999px; background:var(--bg-1); color:var(--text-primary); font-size:12px; font-weight:500; cursor:pointer; }
.shelf-menu-chips button.on { border-color:var(--accent); background:var(--accent-dim); color:var(--accent); }
.shelf-menu-actions .danger { color:var(--status-error); }
.shelf-menu-row { display:flex; gap:6px; }
.shelf-menu-row select, .shelf-menu-row input { flex:1; min-width:0; height:28px; padding:0 8px; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-1); color:var(--text-primary); font-size:12px; }
.shelf-menu-row input[type="number"] { flex:0 0 64px; }
.shelf-menu button:focus-visible, .shelf-menu select:focus-visible, .shelf-menu input:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
/* RFC 0009 step 3: calculations. */
.shelf-pill.calc { background:color-mix(in srgb,var(--accent) 16%,var(--bg-2)); }
.shelf-calcs { display:grid; grid-template-columns:60px minmax(0,1fr); align-items:start; gap:8px; }
.shelf-calcs .shelf-name { padding-top:4px; }
.shelf-calc-list { display:flex; flex-wrap:wrap; gap:4px; }
.shelf-calc, .shelf-calc-add { display:inline-flex; align-items:center; gap:4px; height:24px; padding:0 8px; border:1px solid var(--border-default); border-radius:999px; background:var(--bg-1); color:var(--text-primary); font-size:12px; font-weight:500; cursor:pointer; }
.shelf-calc { border-color:transparent; background:var(--accent-dim); color:var(--accent); }
.shelf-calc-add { border-style:dashed; color:var(--text-secondary); }
.shelf-calc:hover, .shelf-calc-add:hover { border-color:var(--border-strong); color:var(--text-primary); }
.shelf-calc:focus-visible, .shelf-calc-add:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
.calc-editor { display:grid; gap:8px; padding:10px; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-2); }
.calc-editor-row { display:grid; gap:4px; }
.calc-editor-row label { color:var(--text-secondary); font-size:11px; font-weight:500; }
.calc-editor-row input, .calc-editor-row textarea { width:100%; box-sizing:border-box; padding:6px 8px; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-1); color:var(--text-primary); font-size:13px; }
.calc-editor-row textarea { resize:vertical; min-height:44px; font-family:var(--font-mono, ui-monospace, monospace); line-height:1.45; }
.calc-editor-row textarea[aria-invalid="true"] { border-color:var(--status-error); }
.calc-editor-row input:focus-visible, .calc-editor-row textarea:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
.calc-editor-measures { display:flex; flex-wrap:wrap; gap:4px; }
.calc-editor-measures button { height:22px; padding:0 8px; border:1px solid var(--border-subtle); border-radius:999px; background:var(--bg-1); color:var(--text-secondary); font-size:11px; cursor:pointer; }
.calc-editor-measures button:hover { color:var(--text-primary); border-color:var(--border-strong); }
.calc-editor-check { margin:0; color:var(--text-secondary); font-size:12px; line-height:1.45; }
.calc-editor-check.error { color:var(--status-error); }
.calc-editor-check.ok { color:var(--text-primary); }
.calc-editor-check.ok svg { color:var(--accent); vertical-align:-2px; }
.calc-editor-check code { font-family:var(--font-mono, ui-monospace, monospace); font-size:11px; color:var(--text-primary); }
.calc-editor-actions { display:flex; justify-content:flex-end; gap:6px; }
.calc-editor-actions button { height:28px; padding:0 12px; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-1); color:var(--text-primary); font-size:12px; font-weight:500; cursor:pointer; }
.calc-editor-actions button.primary { border-color:var(--accent); background:var(--accent); color:var(--accent-fg, #fff); }
.calc-editor-actions button:disabled { opacity:.5; cursor:not-allowed; }
.shelf-menu-chips button.unfit { border-style:dashed; background:transparent; color:var(--text-tertiary); cursor:not-allowed; }
.shelf-menu-note { color:var(--text-secondary); font-size:11px; line-height:1.4; }
/* Start from a table (RFC 0009, first page). */
.data-start { display:grid; justify-items:start; gap:8px; margin:8px 0; padding:14px; border:1px dashed var(--border-default); border-radius:12px; background:var(--bg-1); color:var(--text-primary); }
.data-start svg { color:var(--accent); }
.data-start strong { font-size:14px; font-weight:600; }
.data-start p { margin:0; color:var(--text-secondary); font-size:12px; line-height:1.5; }
.data-start button.primary { height:30px; padding:0 12px; border:1px solid var(--accent); border-radius:8px; background:var(--accent); color:var(--accent-fg, #fff); font-size:12px; font-weight:600; cursor:pointer; }
.data-start button.link { padding:0; border:0; background:transparent; color:var(--accent); font-size:12px; cursor:pointer; }
.data-start button:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.table-dataset-card { width:min(560px, calc(100vw - 32px)); max-height:min(720px, calc(100vh - 48px)); display:flex; flex-direction:column; border:1px solid var(--border-default); border-radius:12px; background:var(--bg-2); color:var(--text-primary); box-shadow:0 24px 64px rgba(15,23,42,.24); overflow:hidden; }
.table-dataset-card > header { display:flex; align-items:flex-start; gap:12px; padding:16px 16px 12px; border-bottom:1px solid var(--border-subtle); }
.table-dataset-card > header h2 { margin:0; font-size:16px; font-weight:600; }
.table-dataset-card > header p { margin:4px 0 0; color:var(--text-secondary); font-size:12px; }
.table-dataset-card > header > div { flex:1; min-width:0; }
.table-dataset-card > header button.icon { width:28px; height:28px; display:grid; place-items:center; border:0; border-radius:8px; background:transparent; color:var(--text-secondary); cursor:pointer; }
.table-dataset-icon { width:32px; height:32px; display:grid; place-items:center; border-radius:8px; background:var(--accent-dim); color:var(--accent); flex:none; }
.table-dataset-body { flex:1; min-height:0; overflow:auto; display:grid; align-content:start; gap:12px; padding:12px 16px; }
.table-dataset-list { list-style:none; margin:0; padding:0; display:grid; gap:4px; }
.table-dataset-list button { width:100%; display:grid; grid-template-columns:minmax(0,1fr) auto; gap:2px 8px; padding:8px 10px; border:1px solid var(--border-subtle); border-radius:8px; background:var(--bg-1); color:var(--text-primary); text-align:left; cursor:pointer; }
.table-dataset-list button:hover { border-color:var(--border-strong); }
.table-dataset-list button:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
.table-dataset-list strong { font-size:13px; font-weight:600; }
.table-dataset-list span { grid-column:1; color:var(--text-secondary); font-size:12px; }
.table-dataset-list em { grid-row:1 / span 2; grid-column:2; align-self:center; color:var(--accent); font-size:12px; font-style:normal; }
.table-dataset-name { display:grid; gap:4px; }
.table-dataset-name span { color:var(--text-secondary); font-size:11px; font-weight:500; }
.table-dataset-name input { height:32px; padding:0 10px; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-1); color:var(--text-primary); font-size:13px; }
.table-dataset-row { margin:0; display:flex; gap:6px; align-items:flex-start; padding:8px 10px; border-radius:8px; background:var(--accent-dim); color:var(--text-primary); font-size:12px; line-height:1.5; }
.table-dataset-row svg { flex:none; margin-top:3px; color:var(--accent); }
.table-dataset-row code { font-size:11px; }
.table-dataset-numbers { margin:0; padding:0; border:0; display:grid; gap:4px; }
.table-dataset-numbers legend, .table-dataset-groups > span { margin-bottom:4px; color:var(--text-secondary); font-size:11px; font-weight:600; letter-spacing:.02em; }
.table-dataset-number { display:flex; align-items:center; gap:8px; padding:6px 8px; border:1px solid var(--border-subtle); border-radius:8px; }
.table-dataset-number.off { opacity:.62; }
.table-dataset-number label { flex:1; min-width:0; display:grid; grid-template-columns:auto auto minmax(0,1fr); align-items:center; gap:2px 6px; cursor:pointer; }
.table-dataset-number label strong { font-size:13px; font-weight:600; }
.table-dataset-number label span { grid-column:2 / span 2; color:var(--text-secondary); font-size:11px; line-height:1.4; }
.table-dataset-number label .table-dataset-unit { grid-column:2 / span 2; color:var(--text-primary); font-size:11px; font-weight:600; line-height:1.4; }
.table-dataset-number select { flex:none; height:28px; padding:0 6px; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-1); color:var(--text-primary); font-size:12px; }
.table-dataset-groups { display:grid; gap:4px; }
.table-dataset-groups p { margin:0; display:flex; flex-wrap:wrap; gap:4px; }
.table-dataset-groups .chip { display:inline-flex; align-items:center; gap:4px; height:22px; padding:0 8px; border-radius:999px; background:var(--bg-1); color:var(--text-primary); font-size:12px; }
.table-dataset-muted { margin:0; color:var(--text-secondary); font-size:12px; }
.table-dataset-error { margin:0; color:var(--status-error); font-size:12px; line-height:1.5; }
.table-dataset-card > footer { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:12px 16px; border-top:1px solid var(--border-subtle); }
.table-dataset-card > footer small { flex:1; color:var(--text-secondary); font-size:11px; }
.table-dataset-card > footer button { height:32px; padding:0 14px; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-1); color:var(--text-primary); font-size:13px; font-weight:500; cursor:pointer; }
.table-dataset-card > footer button.primary { border-color:var(--accent); background:var(--accent); color:var(--accent-fg, #fff); font-weight:600; }
.table-dataset-card > footer button:disabled { opacity:.5; cursor:not-allowed; }
/* Make a saved query row-level (design D1; formerly "Add fields"). */
.saved-query-fields-notice { margin:0; padding:8px 10px; border:1px solid color-mix(in srgb,var(--status-warning) 40%,var(--border-default)); border-radius:8px; background:color-mix(in srgb,var(--status-warning) 8%,var(--bg-2)); color:var(--text-secondary); font-size:12px; line-height:1.5; }
.saved-query-fields-notice strong { color:var(--text-primary); }
.saved-query-fields-card .table-dataset-error { display:grid; gap:8px; }
.saved-query-fields-card .table-dataset-error p { margin:0; }
.saved-query-fields-card .table-dataset-error button { justify-self:start; height:30px; padding:0 12px; border:1px solid var(--status-error); border-radius:8px; background:var(--bg-1); color:var(--status-error); font-size:12px; font-weight:600; cursor:pointer; }
.saved-query-fields-done { display:flex; gap:10px; align-items:flex-start; padding:10px 12px; border-radius:8px; background:var(--accent-dim); }
.saved-query-fields-done.review { background:color-mix(in srgb,var(--status-warning) 8%,var(--bg-2)); }
.certified-receipt-note { display:flex; gap:10px; align-items:flex-start; margin:8px 0; padding:10px 12px; border:1px solid color-mix(in srgb,var(--accent) 30%,var(--border-subtle)); border-radius:8px; background:var(--accent-dim); color:var(--text-primary); }
.certified-receipt-note > svg { flex:none; margin-top:2px; color:var(--accent); }
.certified-receipt-note strong { display:block; font-size:13px; }
.certified-receipt-note small { display:block; margin-top:6px; color:var(--text-secondary); font-size:11px; font-weight:600; }
.certified-receipt-note ul { margin:3px 0 0; padding-left:16px; color:var(--text-secondary); font-size:12px; line-height:1.45; }
.certified-receipt-note.checked { border-color:color-mix(in srgb,var(--status-warning) 35%,var(--border-subtle)); background:color-mix(in srgb,var(--status-warning) 8%,var(--bg-2)); }
.certified-receipt-note.checked > svg { color:var(--status-warning); }
.certified-receipt-note.checked > div > small:first-of-type { font-weight:500; }
.table-dataset-duplicate { margin:0; padding:10px 12px; border:1px solid color-mix(in srgb,var(--status-warning) 35%,var(--border-subtle)); border-radius:8px; display:grid; gap:6px; }
.table-dataset-duplicate legend { padding:0 4px; display:inline-flex; align-items:center; gap:6px; font-size:13px; font-weight:600; color:var(--text-primary); }
.table-dataset-duplicate label { display:flex; gap:8px; align-items:flex-start; cursor:pointer; font-size:12px; }
.table-dataset-duplicate label input { margin-top:3px; }
.table-dataset-duplicate label span { display:grid; gap:2px; }
.table-dataset-duplicate label em { font-style:normal; font-size:11px; font-weight:600; color:var(--accent); }
.table-dataset-duplicate label small { color:var(--text-secondary); font-size:11px; }
.certify-review-scrim { z-index:80; }
.certify-review-who { margin:0; color:var(--text-secondary); font-size:12px; }
.certify-review-part { display:grid; gap:4px; }
.certify-review-part h3 { margin:0; display:flex; align-items:center; gap:6px; color:var(--text-secondary); font-size:11px; font-weight:600; letter-spacing:.02em; text-transform:uppercase; }
.certify-review-part p { margin:0; font-size:13px; line-height:1.5; }
.certify-review-part ul { margin:0; padding-left:16px; font-size:12px; line-height:1.5; color:var(--text-primary); }
.certify-review-ok { display:flex; align-items:center; gap:6px; color:var(--status-success, var(--accent)) !important; font-size:12px !important; }
.certify-review-owner { display:grid; gap:6px; font-size:12px; color:var(--text-secondary); }
.certify-review-owner input { height:32px; padding:0 10px; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-0); color:var(--text-primary); font-size:13px; }
.certify-review-owner input:focus { outline:2px solid var(--accent-dim); border-color:var(--accent); }
.certify-review-part li.certify-review-ok, .certify-review-part li.table-dataset-error { display:flex; align-items:center; gap:6px; list-style:none; margin-left:-16px; }
.certify-review-editor-link { padding:0; border:0; background:none; color:var(--accent); font:inherit; cursor:pointer; text-decoration:underline; }
.certify-review-fill small { display:block; color:var(--text-secondary); font-size:11px; }
.readiness-uncertified-list { list-style:none; margin:6px 0 0; padding:0; display:grid; gap:6px; }
.readiness-uncertified-list li { display:flex; align-items:center; gap:8px; justify-content:space-between; padding:6px 8px; border:1px solid var(--border-subtle); border-radius:8px; background:var(--bg-1); font-size:12px; }
.readiness-uncertified-list li span { display:grid; gap:1px; min-width:0; }
.readiness-uncertified-list li small { color:var(--text-secondary); font-size:11px; }
.readiness-uncertified-list li button { flex:none; height:28px; padding:0 10px; border:1px solid var(--accent); border-radius:8px; background:var(--accent); color:var(--accent-fg, #fff); font-size:12px; font-weight:600; cursor:pointer; }
.readiness-uncertified-list li button.secondary { border-color:var(--border-default); background:var(--bg-2); color:var(--text-primary); }
.readiness-uncertified-actions { display:flex; flex-wrap:wrap; gap:6px; justify-content:flex-end; }
.readiness-uncertified-list li button:not(.primary) { border-color:var(--border-default); background:var(--bg-2); color:var(--text-primary); display:inline-flex; align-items:center; gap:4px; }
.studio-reader-parts { display:grid; gap:10px; margin:0 0 12px; }
.studio-summary-pending { display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding:10px 12px; border:1px dashed var(--border-default); border-radius:8px; color:var(--text-secondary); font-size:12px; }
.studio-summary-pending button { margin-left:auto; height:26px; padding:0 10px; border:1px solid var(--border-default); border-radius:4px; background:var(--bg-2); color:var(--text-primary); font:600 12px var(--font-ui, inherit); cursor:pointer; }
.saved-query-fields-done svg { flex:none; margin-top:2px; color:var(--accent); }
.saved-query-fields-done.review svg { color:var(--status-warning); }
.saved-query-fields-done div { display:grid; gap:4px; }
.saved-query-fields-done strong { font-size:13px; }
.saved-query-fields-done small { color:var(--text-secondary); font-size:12px; line-height:1.45; }
.dataset-more { position:relative; display:inline-flex; }
.dataset-more > button { width:22px; height:28px; border:0; background:transparent; color:var(--text-secondary); border-radius:8px; padding:0; display:grid; place-items:center; }
.dataset-more > button:hover { color:var(--text-primary); background:var(--bg-2); }
.dataset-more-menu { position:absolute; right:0; top:calc(100% + 4px); z-index:30; width:260px; display:grid; padding:4px; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-1); box-shadow:0 12px 32px color-mix(in srgb,var(--text-primary) 14%,transparent); }
.dataset-more-menu button { display:grid; gap:2px; text-align:left; border:0; background:transparent; padding:8px; border-radius:8px; color:var(--text-primary); font-size:12px; }
.dataset-more-menu button:hover { background:var(--bg-2); }
.dataset-more-menu small { color:var(--text-secondary); font-size:11px; line-height:1.4; }
/* Start form: the App's domain. */
.launch-domain-field { display:grid; gap:6px; }
.launch-domain-field > span { font-size:14px; font-weight:600; color:var(--text-secondary); }
.launch-domain-field select { width:100%; min-height:40px; box-sizing:border-box; border:1px solid var(--border-default); background:var(--bg-1); color:var(--text-primary); border-radius:12px; padding:0 12px; font-size:14px; }
.launch-domain-field select:focus { outline:none; border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-dim); }
.launch-domain-field small { color:var(--text-tertiary); font-size:12px; line-height:1.4; }

/* Data step (design D3): the App's data first, then the canvas. */
.dql-studio-v2.studio-data-stage { display:block; overflow:auto; }
.studio-data-step { min-height:100%; box-sizing:border-box; display:flex; flex-direction:column; gap:14px; width:min(1180px,calc(100% - 32px)); margin:0 auto; padding:22px 0 0; }
.data-step-header { display:flex; align-items:flex-start; gap:10px; }
.data-step-header > div { display:grid; gap:4px; min-width:0; }
.data-step-header small { color:var(--text-tertiary); font-size:12px; text-transform:uppercase; letter-spacing:.08em; }
.data-step-header h1 { margin:0; font-size:24px; line-height:1.15; letter-spacing:-.02em; }
.data-step-header p { margin:0; color:var(--text-secondary); font-size:14px; line-height:1.5; }
.studio-data-step > .studio-error { display:flex; justify-content:space-between; gap:10px; }
.data-step-body { flex:1; min-height:0; display:grid; grid-template-columns:minmax(240px,320px) minmax(0,1fr); gap:16px; align-items:start; }
.data-step-list { border:1px solid var(--border-subtle); border-radius:12px; background:var(--bg-2); padding:12px; display:grid; gap:10px; position:sticky; top:12px; }
.data-step-list-head { display:flex; align-items:baseline; justify-content:space-between; gap:8px; }
.data-step-list-head h2 { margin:0; font-size:14px; font-weight:600; }
.data-step-list-head small { color:var(--text-tertiary); font-size:12px; }
.data-step-list ul { list-style:none; margin:0; padding:0; display:grid; gap:6px; }
.data-step-list li { display:grid; grid-template-columns:auto minmax(0,1fr) auto; align-items:center; gap:8px; padding:8px; border:1px solid var(--border-subtle); border-radius:8px; background:var(--bg-1); }
.data-step-list li p { margin:0; display:grid; gap:2px; min-width:0; }
.data-step-list li strong { font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.data-step-list li small { color:var(--text-tertiary); font-size:12px; }
.data-step-list li .add-data-confirm { grid-column:1 / -1; }
.data-step-empty { display:flex; gap:10px; align-items:flex-start; padding:12px; border:1px dashed var(--border-default); border-radius:8px; color:var(--text-secondary); }
.data-step-empty svg { flex:none; color:var(--accent); }
.data-step-empty p { margin:0; display:grid; gap:3px; }
.data-step-empty strong { color:var(--text-primary); font-size:13px; }
.data-step-empty small { font-size:12px; line-height:1.45; }
.data-step-browser { min-width:0; border:1px solid var(--border-subtle); border-radius:12px; background:var(--bg-2); padding:12px; }
.data-step-footer { position:sticky; bottom:0; display:flex; align-items:center; justify-content:flex-end; gap:8px; padding:12px 0 18px; background:linear-gradient(to bottom, transparent, var(--bg-canvas) 30%); }
.data-step-footer button { border:1px solid var(--border-default); background:var(--bg-1); color:var(--text-primary); border-radius:8px; padding:9px 14px; font-size:13px; font-weight:600; display:inline-flex; align-items:center; gap:6px; }
.data-step-footer button:hover { border-color:var(--border-strong); }
.data-step-footer button.primary { border-color:var(--accent); background:var(--accent); color:var(--accent-fg); }
.data-step-footer button.primary:hover { background:var(--accent-hover); }
.data-step-footer button:disabled { opacity:.5; cursor:default; }
.data-step-next-hint { color:var(--text-tertiary); font-size:12px; }
/* No AI (round-2 Q2): three quick choices, then Build App. */
.quick-start-step .data-step-header small.quick-start-note, .quick-start-note { text-transform:none; letter-spacing:0; color:var(--text-tertiary); font-size:12px; line-height:1.45; }
.quick-start-note button.link { padding:0; border:0; background:transparent; color:var(--accent); font:inherit; text-align:left; cursor:pointer; text-decoration:underline; }
.quick-start-step > .quick-choices, .quick-start-step > .quick-start-empty { width:min(760px,100%); }
.quick-choices { display:grid; gap:12px; }
.quick-choice-list { list-style:none; margin:0; padding:0; display:grid; gap:8px; }
.quick-choice { display:grid; grid-template-columns:76px minmax(0,1fr) 28px; grid-template-areas:"kind sentence remove" ". title title"; align-items:center; gap:6px 10px; padding:12px; border:1px solid var(--border-subtle); border-radius:12px; background:var(--bg-2); }
.quick-choice-kind { grid-area:kind; display:inline-flex; align-items:center; gap:5px; justify-self:start; padding:3px 8px; border-radius:999px; background:var(--accent-dim); color:var(--accent); font-size:12px; font-weight:600; }
.quick-choice-sentence { grid-area:sentence; display:flex; flex-wrap:wrap; align-items:center; gap:6px; min-width:0; color:var(--text-secondary); font-size:14px; }
.quick-choice-sentence select { min-width:0; max-width:100%; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-1); color:var(--text-primary); padding:6px 8px; font:inherit; font-size:13px; }
.quick-choice-sentence select:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
.quick-choice-time { color:var(--text-tertiary); font-size:12px; }
.quick-choice-title { grid-area:title; color:var(--text-tertiary); font-size:12px; }
.quick-choice-title strong { color:var(--text-primary); font-weight:600; }
.quick-choice-remove { grid-area:remove; width:28px; height:28px; display:grid; place-items:center; border:0; border-radius:8px; background:transparent; color:var(--text-tertiary); cursor:pointer; }
.quick-choice-remove:hover:not(:disabled) { background:var(--bg-3); color:var(--text-primary); }
.quick-choice-remove:disabled { opacity:.35; cursor:default; }
.quick-choice-add { display:flex; flex-wrap:wrap; align-items:center; gap:6px; color:var(--text-secondary); font-size:13px; }
.quick-choice-add button { display:inline-flex; align-items:center; gap:4px; border:1px dashed var(--border-default); border-radius:8px; background:transparent; color:var(--text-primary); padding:5px 10px; font-size:12px; font-weight:600; cursor:pointer; }
.quick-choice-add button:hover:not(:disabled) { border-color:var(--accent); color:var(--accent); }
.quick-choice-add button:disabled { opacity:.45; cursor:default; }
.quick-choice-submit { justify-self:start; border:1px solid var(--accent); border-radius:8px; background:var(--accent); color:var(--accent-fg); padding:9px 16px; font-size:13px; font-weight:600; cursor:pointer; }
.quick-choice-submit:hover:not(:disabled) { background:var(--accent-hover); }
.quick-choice-submit:disabled { opacity:.5; cursor:default; }
.studio-quick-panel { width:360px; }
.studio-quick-panel .inspector-body { display:grid; gap:12px; padding-top:8px; }
.studio-quick-panel .quick-choice { grid-template-columns:minmax(0,1fr) 28px; grid-template-areas:"kind remove" "sentence sentence" "title title"; }
.studio-quick-panel .data-step-empty { flex-wrap:wrap; }
@media (max-width:620px) { .quick-choice { grid-template-columns:minmax(0,1fr) 28px; grid-template-areas:"kind remove" "sentence sentence" "title title"; } }
.ai-data-step .data-step-header p.data-step-goal { color:var(--text-primary); font-size:14px; }
.ai-data-step .data-step-header p.data-step-goal strong { font-weight:600; }
.ai-data-step .data-step-header .data-step-provenance { text-transform:none; letter-spacing:0; }
.data-step-activity { display:flex; align-items:flex-start; gap:10px; padding:10px 12px; border:1px solid color-mix(in srgb,var(--accent) 30%,var(--border-default)); border-radius:12px; background:var(--accent-dim); }
.data-step-activity .loading-mark { width:28px; height:28px; flex:none; border-radius:8px; display:grid; place-items:center; color:var(--accent); background:var(--bg-2); animation:studio-loading-pulse 1.4s ease-in-out infinite; }
.data-step-activity > div { display:grid; gap:6px; min-width:0; }
.data-step-activity strong { font-size:13px; color:var(--text-primary); }
.data-step-activity small { color:var(--text-secondary); font-size:12px; line-height:1.45; }
.data-step-activity ol { margin:0; padding:0; list-style:none; display:flex; flex-wrap:wrap; gap:6px; }
.data-step-activity ol li { border:1px solid var(--border-subtle); background:var(--bg-2); color:var(--text-tertiary); border-radius:999px; padding:3px 9px; font-size:12px; }
.data-step-activity ol li.done { color:var(--text-secondary); }
.data-step-activity ol li.on { border-color:var(--accent); color:var(--accent); font-weight:600; }
.data-step-activity.error { border-color:color-mix(in srgb,var(--status-error) 35%,var(--border-default)); background:color-mix(in srgb,var(--status-error) 6%,var(--bg-2)); }
.data-step-activity-actions { display:flex; flex-wrap:wrap; gap:8px; }
.data-step-activity-actions button { border:1px solid var(--border-default); background:var(--bg-1); color:var(--text-primary); border-radius:8px; padding:6px 11px; font-size:12px; font-weight:600; }
.data-step-activity-actions button.primary { border-color:var(--accent); background:var(--accent); color:var(--accent-fg); }
.data-step-list li small.data-step-tiles { color:var(--text-secondary); }
.data-step-list li small.data-step-why { white-space:normal; line-height:1.4; }
.data-step-list li.ai-suggestion { background:var(--bg-2); border-style:dashed; }
.data-step-group { display:grid; gap:6px; }
.data-step-group h3 { margin:4px 0 0; font-size:13px; font-weight:600; }
.data-step-group > p { margin:0; color:var(--text-tertiary); font-size:12px; }
.data-step-notes ul { list-style:disc; padding-left:18px; gap:3px; }
.data-step-notes ul li { display:list-item; padding:0; border:0; background:transparent; color:var(--text-secondary); font-size:12px; line-height:1.45; }
.data-step-list .studio-ai-questions > div { display:grid; gap:6px; }
.data-step-list .studio-ai-questions > div > p { margin:0; color:var(--text-secondary); font-size:12px; line-height:1.45; }
.studio-ai-questions > p.data-step-not-covered-note, .studio-ai-questions > p { margin:0; color:var(--text-tertiary); font-size:12px; line-height:1.45; }
.data-step-list .studio-ai-questions fieldset { margin:0; padding:0; border:0; display:grid; gap:6px; }
.data-step-list .studio-ai-questions legend { margin-bottom:4px; font-size:12px; color:var(--text-primary); }
.data-step-list .studio-ai-questions fieldset button { display:grid; gap:2px; text-align:left; }
.data-step-skeleton li { min-height:38px; }
.data-step-skeleton li .add-data-mark, .data-step-skeleton li strong, .data-step-skeleton li small { border-radius:4px; background:var(--bg-3); color:transparent; animation:studio-loading-pulse 1.4s ease-in-out infinite; }
.data-step-skeleton li .add-data-mark { width:24px; height:24px; }
.data-step-skeleton li strong { width:70%; }
.data-step-skeleton li small { width:45%; }
/* AI mode: the picks carry a reason each, so the list gets room to read, and
   it scrolls on its own so "Not covered yet" is never cut off below the fold. */
.ai-data-step .data-step-body { grid-template-columns:minmax(360px,40%) minmax(0,1fr); }
.ai-data-step .data-step-list { max-height:max(260px, calc(100vh - 290px)); overflow:auto; overscroll-behavior:contain; align-content:start; }
.proposal-back-to-data { margin:0 16px 10px; justify-self:start; display:inline-flex; align-items:center; gap:5px; border:0; background:transparent; padding:0; color:var(--accent); font-size:12px; font-weight:600; }
.proposal-back-to-data:hover { text-decoration:underline; }
.proposal-back-to-data:disabled { opacity:.5; cursor:default; }

/* Add data browser: the Data step and the canvas "+ Add data" dialog. */
.add-data-browser { display:grid; gap:10px; min-width:0; }
.add-data-controls { display:grid; gap:8px; }
.add-data-search { display:flex; align-items:center; gap:8px; min-height:38px; padding:0 10px; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-1); color:var(--text-tertiary); }
.add-data-search:focus-within { border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-dim); }
.add-data-search input { flex:1; min-width:0; border:0; outline:none; background:transparent; color:var(--text-primary); font-size:13px; }
.add-data-search button { border:0; background:transparent; color:var(--text-tertiary); display:grid; place-items:center; padding:2px; }
.add-data-domains { display:flex; flex-wrap:wrap; gap:6px; }
.add-data-domains button { border:1px solid var(--border-default); background:var(--bg-1); color:var(--text-secondary); border-radius:999px; padding:4px 10px; font-size:12px; }
.add-data-domains button:hover { border-color:var(--border-strong); color:var(--text-primary); }
.add-data-domains button.on { border-color:var(--accent); background:var(--accent-dim); color:var(--text-primary); }
/* One list (design D1): chips for the kind of data instead of tabs. */
.add-data-kinds { display:flex; flex-wrap:wrap; gap:4px; padding:2px; border:1px solid var(--border-subtle); border-radius:8px; background:var(--bg-1); justify-self:start; }
.add-data-kinds button { border:0; background:transparent; color:var(--text-secondary); border-radius:8px; padding:5px 10px; font-size:12px; font-weight:600; display:inline-flex; align-items:center; gap:6px; }
.add-data-kinds button:hover { color:var(--text-primary); }
.add-data-kinds button.on { background:var(--bg-3, var(--bg-2)); color:var(--text-primary); box-shadow:0 0 0 1px var(--border-default); }
.add-data-kinds small { color:var(--text-tertiary); font-size:11px; font-weight:500; }
.add-data-more-menu { position:relative; display:inline-flex; }
.add-data-action button.more { padding:5px 6px; }
.add-data-menu { position:absolute; right:0; top:calc(100% + 4px); z-index:30; width:280px; display:grid; padding:4px; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-1); box-shadow:0 12px 32px color-mix(in srgb,var(--text-primary) 14%,transparent); }
.add-data-action .add-data-menu button { display:grid; gap:2px; justify-items:start; text-align:left; white-space:normal; border:0; background:transparent; padding:8px; border-radius:8px; }
.add-data-action .add-data-menu button:hover { background:var(--bg-2); }
.add-data-menu small { color:var(--text-secondary); font-size:11px; font-weight:400; line-height:1.4; }
.add-data-rule { margin:0; display:flex; flex-wrap:wrap; align-items:center; gap:6px; color:var(--text-secondary); font-size:12px; }
.add-data-rule svg { color:var(--status-success); }
.add-data-rule strong { color:var(--text-primary); font-weight:600; }
.add-data-browser button.link, .dataset-source-actions button.link { border:0; background:transparent; padding:0; color:var(--accent); font-size:12px; font-weight:600; display:inline-flex; align-items:center; gap:4px; }
.add-data-browser button.link:hover, .dataset-source-actions button.link:hover { text-decoration:underline; }
.add-data-browser button.link:disabled, .dataset-source-actions button.link:disabled { opacity:.5; cursor:default; text-decoration:none; }
.add-data-tabs { display:flex; gap:2px; border-bottom:1px solid var(--border-subtle); overflow-x:auto; }
.add-data-tabs button { border:0; border-bottom:2px solid transparent; background:transparent; color:var(--text-secondary); padding:8px 10px; font-size:13px; font-weight:600; white-space:nowrap; display:inline-flex; align-items:center; gap:6px; margin-bottom:-1px; }
.add-data-tabs button:hover { color:var(--text-primary); }
.add-data-tabs button.on { color:var(--text-primary); border-bottom-color:var(--accent); }
.add-data-tabs small { color:var(--text-tertiary); font-size:11px; font-weight:500; }
.add-data-list { display:grid; gap:6px; align-content:start; }
.add-data-row { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; border:1px solid var(--border-subtle); border-radius:8px; background:var(--bg-2); overflow:hidden; }
.add-data-row:hover { border-color:var(--border-default); }
.add-data-row.added { background:color-mix(in srgb,var(--accent-dim) 30%,var(--bg-2)); }
.add-data-row.highlight { border-color:var(--accent); box-shadow:0 0 0 2px var(--accent-dim); }
.add-data-summary { min-width:0; display:flex; align-items:flex-start; gap:10px; padding:10px; border:0; background:transparent; text-align:left; color:var(--text-primary); }
.add-data-summary.static { cursor:default; }
.add-data-summary > div { min-width:0; flex:1; display:grid; gap:2px; }
.add-data-summary strong { font-size:13px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.add-data-summary small { color:var(--text-tertiary); font-size:12px; }
.add-data-summary p { margin:2px 0 0; color:var(--text-secondary); font-size:12px; line-height:1.4; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.add-data-summary .chevron { flex:none; margin-top:4px; color:var(--text-tertiary); transition:transform .15s ease; }
.add-data-summary[aria-expanded="true"] .chevron { transform:rotate(180deg); }
.add-data-mark { width:28px; height:28px; flex:none; border-radius:8px; display:grid; place-items:center; color:var(--text-secondary); background:var(--bg-1); }
.add-data-mark.certified { color:var(--status-success); background:color-mix(in srgb,var(--status-success) 10%,var(--bg-1)); }
.add-data-mark.review { color:var(--status-warning); background:color-mix(in srgb,var(--status-warning) 9%,var(--bg-1)); }
.add-data-action { display:flex; align-items:center; gap:6px; padding:0 10px; flex-wrap:wrap; justify-content:flex-end; }
.add-data-action button, .add-data-empty-actions button, .add-data-confirm button, .data-step-list li > button.remove { border:1px solid var(--border-default); background:var(--bg-1); color:var(--text-primary); border-radius:8px; padding:5px 10px; font-size:12px; font-weight:600; display:inline-flex; align-items:center; gap:4px; white-space:nowrap; }
.add-data-action button:hover, .add-data-empty-actions button:hover, .data-step-list li > button.remove:hover { border-color:var(--border-strong); }
.add-data-action button.primary, .add-data-empty-actions button.primary { border-color:var(--accent); background:var(--accent); color:var(--accent-fg); }
.add-data-action button.primary:hover, .add-data-empty-actions button.primary:hover { background:var(--accent-hover); }
.add-data-action button.review { border-color:color-mix(in srgb,var(--status-warning) 45%,var(--border-default)); color:var(--text-primary); }
.add-data-action button:disabled, .add-data-empty-actions button:disabled, .add-data-confirm button:disabled { opacity:.5; cursor:default; }
.add-data-added { display:inline-flex; align-items:center; gap:4px; color:var(--status-success); font-size:12px; font-weight:600; }
.add-data-confirm { display:flex; flex-wrap:wrap; align-items:center; gap:6px; }
.add-data-confirm small { color:var(--text-secondary); font-size:12px; }
.add-data-confirm button.danger { border-color:var(--status-error); color:var(--status-error); }
.add-data-detail { grid-column:1 / -1; display:grid; gap:10px; padding:10px 12px 12px; border-top:1px solid var(--border-subtle); background:var(--bg-1); }
.add-data-fields { display:grid; gap:8px; }
.add-data-fields section { display:grid; gap:4px; }
.add-data-fields h4 { margin:0; color:var(--text-secondary); font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.06em; }
.add-data-fields p { margin:0; display:flex; flex-wrap:wrap; gap:4px; }
.add-data-fields .chip { display:inline-flex; align-items:center; gap:4px; padding:2px 8px; border:1px solid var(--border-subtle); border-radius:999px; background:var(--bg-2); font-size:12px; color:var(--text-primary); }
.add-data-fields .chip.muted { color:var(--text-tertiary); }
.add-data-fields .sigma { color:var(--accent); font-weight:600; }
.add-data-sample-table { max-width:100%; overflow:auto; border:1px solid var(--border-subtle); border-radius:8px; }
.add-data-sample-table table { border-collapse:collapse; width:100%; font-size:12px; }
.add-data-sample-table th, .add-data-sample-table td { padding:5px 8px; border-bottom:1px solid var(--border-subtle); text-align:left; white-space:nowrap; }
.add-data-sample-table th { color:var(--text-secondary); font-weight:600; background:var(--bg-2); }
.add-data-muted { margin:0; color:var(--text-tertiary); font-size:12px; line-height:1.45; }
.add-data-error { margin:0; color:var(--status-error); font-size:12px; }
.add-data-hint { margin:0; display:flex; align-items:center; gap:6px; padding:8px 10px; border-radius:8px; background:var(--accent-dim); color:var(--text-primary); font-size:12px; }
.add-data-empty { display:grid; grid-template-columns:auto minmax(0,1fr); gap:6px 10px; padding:12px; border:1px dashed var(--border-default); border-radius:8px; background:var(--bg-1); }
.add-data-empty > svg { color:var(--accent); }
.add-data-empty strong { font-size:13px; }
.add-data-empty p { margin:2px 0 0; color:var(--text-secondary); font-size:12px; }
.add-data-empty-actions { grid-column:1 / -1; display:flex; flex-wrap:wrap; gap:6px; }
.add-data-more { justify-self:center; border:1px solid var(--border-default); background:var(--bg-1); border-radius:8px; padding:6px 12px; font-size:12px; }
.studio-add-data-card { width:min(760px,100%); max-height:min(760px,calc(100vh - 48px)); display:flex; flex-direction:column; border:1px solid var(--border-default); border-radius:12px; background:var(--bg-2); color:var(--text-primary); box-shadow:0 24px 64px color-mix(in srgb,var(--text-primary) 18%,transparent); overflow:hidden; }
.studio-add-data-card > header { display:flex; align-items:flex-start; gap:12px; padding:16px 16px 12px; border-bottom:1px solid var(--border-subtle); }
.studio-add-data-card > header > div { flex:1; min-width:0; }
.studio-add-data-card > header h2 { margin:0; font-size:16px; font-weight:600; }
.studio-add-data-card > header p { margin:4px 0 0; color:var(--text-secondary); font-size:12px; }
.studio-add-data-card > header button.icon { width:28px; height:28px; display:grid; place-items:center; border:0; border-radius:8px; background:transparent; color:var(--text-secondary); }
.studio-add-data-card > .studio-error { margin:10px 16px 0; }
.studio-add-data-card > .add-data-browser { flex:1; min-height:0; overflow:auto; padding:12px 16px; }
.studio-add-data-card > footer { display:flex; justify-content:flex-end; padding:12px 16px; border-top:1px solid var(--border-subtle); }
.studio-add-data-card > footer button { border:1px solid var(--accent); background:var(--accent); color:var(--accent-fg); border-radius:8px; padding:7px 14px; font-size:13px; font-weight:600; }

/* Data pane: this App's data, saved query actions. */
.dataset-menu-label { padding:4px 9px 2px; color:var(--text-tertiary); font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.06em; }
.dataset-menu-empty { padding:4px 9px; color:var(--text-tertiary); font-size:12px; }
.saved-query-panel { display:grid; gap:8px; padding:10px; border:1px solid var(--border-subtle); border-radius:8px; background:var(--bg-1); }
.saved-query-panel p { margin:0; color:var(--text-secondary); font-size:12px; line-height:1.45; }
.saved-query-label { color:var(--text-secondary); font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.06em; }
.dataset-source-actions { display:flex; flex-wrap:wrap; gap:10px; }
.readiness-unused-note { margin:0; display:flex; align-items:center; gap:8px; padding:10px 12px; border:1px solid var(--border-subtle); border-radius:8px; background:var(--bg-1); color:var(--text-secondary); font-size:13px; }
@media (max-width:820px) {
  .data-step-body, .ai-data-step .data-step-body { grid-template-columns:minmax(0,1fr); }
  .data-step-list, .ai-data-step .data-step-list { position:static; max-height:none; overflow:visible; }
}
@media (max-width:620px) {
  .add-data-row { grid-template-columns:minmax(0,1fr); }
  .add-data-action { justify-content:flex-start; padding:0 10px 10px 48px; }
}
/* The editor header stays in view: the Studio never scrolls itself (focus or scrollIntoView used to move it). */
.dql-studio-v2 { overflow:clip; }
.studio-topbar { position:sticky; top:0; }
/* A tile's menu opens above its own table and the tiles after it, and stays visible while open. */
.tile-tools.open { opacity:1; }
.studio-component-card.menu-open { z-index:9; }
.studio-component-card.menu-open > header { position:relative; z-index:8; }
/* A short tile title wraps to a second line instead of reading "Lif…"; the full title is in its tooltip. */
.studio-component-card > header strong { white-space:normal; display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; line-height:1.25; min-width:0; overflow-wrap:break-word; }
/* The tile's tools keep their own room in the header row, so they never cover the title or the trust dot.
   A narrow tile puts them on their own row above the title instead of squeezing the title. */
.studio-component-card > header { position:relative; flex-wrap:wrap; container-type:inline-size; }
/* Basis 0 so a long title wraps inside itself instead of pushing the tools to another row; it still grows to its full width. */
.studio-component-card > header strong { flex:1 1 0; max-width:max-content; }
.studio-component-card > header .trust-dot { flex:none; }
@container (max-width: 240px) {
  .studio-component-card > header .tile-tools { order:-1; flex:1 0 100%; justify-content:flex-end; margin-left:0; }
}
.tile-filter-notice > span { min-width:0; overflow-wrap:anywhere; }
/* A notice is one short line (its full text is in its tooltip), so it never
   pushes a KPI's value or a chart out of a tile at its default size. */
.tile-filter-notice { flex:none; padding:3px 8px; margin-top:4px; font-size:12px; white-space:nowrap; overflow:hidden; }
.tile-filter-notice > span { overflow:hidden; text-overflow:ellipsis; overflow-wrap:normal; }
/* A new tile's one-click filter offer: the sentence, then Apply and Not now. */
.tile-filter-notice.tile-filter-offer { background:var(--accent-dim); color:var(--text-primary); }
.tile-filter-notice.tile-filter-offer svg { color:var(--accent); }
.tile-filter-notice.tile-filter-offer > span { flex:1 1 auto; }
.tile-filter-notice.tile-filter-offer button { flex:none; padding:1px 8px; border-radius:4px; border:1px solid var(--accent); background:var(--accent); color:var(--accent-fg); font-size:12px; cursor:pointer; }
.tile-filter-notice.tile-filter-offer button.quiet { border-color:transparent; background:transparent; color:var(--text-secondary); }
.tile-filter-notice.tile-filter-offer button:disabled { opacity:.6; cursor:default; }
/* "Rolled up from a saved query" lives behind this icon in the header. */
.tile-adapted-note { flex:none; display:inline-flex; align-items:center; color:var(--text-tertiary); cursor:help; border-radius:4px; }
.tile-adapted-note:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
/* Interaction hints show while the pointer is on the tile, when it is selected, or while a click-filter is active. */
.live-component-preview { position:relative; }
.dataset-link-hint.hover-only { display:none; position:absolute; left:8px; right:8px; bottom:6px; z-index:2; box-shadow:0 4px 12px rgba(0,0,0,.08); }
.studio-component-card:hover .dataset-link-hint.hover-only,
.studio-component-card:focus-within .dataset-link-hint.hover-only,
.studio-component-card.selected .dataset-link-hint.hover-only { display:flex; }
/* Long text stays inside its card when the canvas narrows. */
.studio-component-card .live-component-preview, .studio-component-card .tile-text { overflow:hidden; overflow-wrap:anywhere; }
/* A text tile's heading is its own line above the sentence, as readers see it. */
.tile-text .tile-text-title, .tile-heading .tile-text-title { display:block; margin:0 0 4px; color:var(--text-primary); font-weight:600; }
.tile-text .tile-text-title { font-size:16px; }
.tile-text p, .tile-heading p { margin:0 0 6px; }
.tile-text p:last-child, .tile-heading p:last-child { margin-bottom:0; }
/* Charts follow the tile's width when panels open and close. */
.live-component-preview, .live-component-body, .studio-tile-preview-interactions { min-width:0; }
.live-component-body { overflow:hidden; }
.bar-cap-note button:hover { text-decoration:underline; }
.same-name-origin { font-style:normal; font-weight:500; color:var(--text-tertiary); }
.shelf-menu-row input[aria-label="Custom top N"] { width:110px; }
@keyframes studio-skeleton { 50% { opacity:.45; } }
@media (prefers-reduced-motion:reduce) { .data-step-activity .loading-mark, .data-step-skeleton li .add-data-mark, .data-step-skeleton li strong, .data-step-skeleton li small, .studio-canvas-frame, .policy-toggle i:after, .studio-review-toggle i:after, .dql-studio-v2-loading .loading-mark, .preview-state.loading .preview-loading-mark, .preview-skeleton i, .preview-skeleton path { transition:none; animation:none; } }
`;
