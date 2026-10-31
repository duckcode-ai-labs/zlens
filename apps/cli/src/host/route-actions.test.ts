import { describe, expect, it } from 'vitest';
import { routeAction } from './route-actions.js';

describe('what each API request does (RFC 0010 HH-2)', () => {
  it.each([
    ['GET', '/api/identity', 'project.read', 'project'],
    ['GET', '/api/connections', 'project.read', 'project'],
    ['PUT', '/api/connections', 'connection.manage', 'project'],
    ['POST', '/api/connections/warehouse/metadata-scope', 'connection.manage', 'connection'],
    ['POST', '/api/test-connection', 'connection.manage', 'project'],
    ['POST', '/api/settings/providers', 'settings.manage', 'project'],
    ['POST', '/api/persona', 'app.author', 'project'],
    ['POST', '/api/git/commit', 'git.review', 'project'],
    ['POST', '/api/block-studio/certify', 'dataset.certify', 'project'],
    // The route the UI certifies through. Saving a cell only writes a draft.
    ['POST', '/api/block-studio/certifications', 'dataset.certify', 'project'],
    ['POST', '/api/blocks/save-from-cell', 'dataset.author', 'project'],
    ['POST', '/api/apps/claims/dashboards/overview/approve-semantic', 'dataset.certify', 'app'],
    // Approving a metric draft makes it answer; making and discarding drafts is authoring.
    ['POST', '/api/semantic-layer/metric-drafts/approve', 'dataset.certify', 'project'],
    ['POST', '/api/semantic-layer/metric-drafts/discard', 'dataset.author', 'project'],
    ['POST', '/api/block-studio/ai-imports/imp_abc/metric-drafts', 'dataset.author', 'project'],
    ['POST', '/api/block-studio/certification-check', 'dataset.author', 'project'],
    // "Check and use" leaves data Checked · Needs certifying; certifying is its own route (design Q1).
    ['POST', '/api/app-datasets/tables/create', 'dataset.author', 'project'],
    ['POST', '/api/app-datasets/certify', 'dataset.certify', 'project'],
    ['GET', '/api/app-datasets/certify-review', 'project.read', 'project'],
    ['POST', '/api/app-datasets/joins/certify', 'dataset.certify', 'project'],
    ['GET', '/api/app-datasets/joins/certify-review', 'project.read', 'project'],
    ['POST', '/api/app-datasets/tables/draft', 'dataset.author', 'project'],
    ['POST', '/api/app-datasets/saved-queries/create', 'dataset.author', 'project'],
    ['POST', '/api/app-datasets/saved-queries/draft', 'dataset.author', 'project'],
    ['POST', '/api/app-datasets/saved-queries/fields', 'app.author', 'project'],
    ['POST', '/api/app-datasets/run', 'app.view', 'project'],
    ['POST', '/api/agent/hints/h-1/review', 'hint.review', 'hint'],
    ['POST', '/api/agent/hints/h-1/lifecycle', 'hint.review', 'hint'],
    ['PATCH', '/api/agent/hints/h-1', 'hint.review', 'hint'],
    // A recorded correction writes a candidate hint into the project: a change to it, not part of asking.
    ['POST', '/api/agent/learnings/correction', 'project.write', 'project'],
    // Promoting a research run writes a draft block into the project.
    ['POST', '/api/notebook/research/r1/promote-dql', 'dataset.author', 'project'],
    ['POST', '/api/notebook/research/r1/run', 'research', 'project'],
    ['GET', '/api/apps', 'project.read', 'project'],
    ['POST', '/api/apps', 'app.author', 'project'],
    ['GET', '/api/apps/claims', 'app.view', 'app'],
    ['POST', '/api/apps/claims/dashboards/overview/run', 'app.view', 'app'],
    ['POST', '/api/apps/claims/dashboards/overview/story', 'app.view', 'app'],
    ['POST', '/api/apps/claims/dashboards/overview/monitors', 'schedule.manage', 'app'],
    ['POST', '/api/apps/claims/ask', 'ask', 'app'],
    ['POST', '/api/apps/claims/follow', 'app.view', 'app'],
    ['GET', '/api/apps/claims/follow', 'app.view', 'app'],
    ['PUT', '/api/apps/claims/audience', 'app.author', 'app'],
    ['GET', '/api/home', 'project.read', 'project'],
    ['GET', '/api/host/home-cards', 'project.read', 'project'],
    ['POST', '/api/apps/claims/promote', 'app.publish', 'app'],
    ['PUT', '/api/apps/claims/dashboards/overview', 'app.author', 'app'],
    ['GET', '/api/apps/claims/dashboards/overview/snapshot', 'export', 'app'],
    ['POST', '/api/app-builds/b-1/publish-to-project', 'app.publish', 'app-build'],
    ['POST', '/api/app-builds/b-1/dashboards/p/run', 'app.author', 'app-build'],
    ['POST', '/api/agent-runs', 'ask', 'project'],
    ['POST', '/api/agent-runs/request-certification', 'ask', 'project'],
    ['POST', '/api/semantic-query', 'ask', 'project'],
    ['POST', '/api/notebook/research', 'research', 'project'],
    ['POST', '/api/query', 'query.run', 'project'],
    ['POST', '/api/notebook/execute', 'query.run', 'project'],
    ['POST', '/api/keys/prove', 'query.run', 'project'],
    ['GET', '/api/ask-traces/0123456789abcdef0123456789abcdef/export', 'export', 'project'],
    ['POST', '/api/modeling/entities', 'dataset.author', 'project'],
    ['POST', '/api/notebooks', 'project.write', 'project'],
    ['DELETE', '/api/something-new', 'project.write', 'project'],
    ['GET', '/api/something-new', 'project.read', 'project'],
  ])('%s %s is %s on a %s', (method, path, action, type) => {
    const route = routeAction(method, path);
    expect(route.action).toBe(action);
    expect(route.resource.type).toBe(type);
  });

  it('names the App, draft, hint or connection it acts on', () => {
    expect(routeAction('GET', '/api/apps/claims%20ops/dashboards').resource).toEqual({ type: 'app', id: 'claims ops' });
    expect(routeAction('GET', '/api/app-builds/b-1').resource).toEqual({ type: 'app-build', id: 'b-1' });
    expect(routeAction('GET', '/api/apps').resource).toEqual({ type: 'project' });
  });
});
