// Git connections and reading repositories (roadmap 6.1, 6.2) on the mock Git host: repository URLs and Dockerfiles
// read, a token checked on save (whose, scopes, expiry, how many repositories) and kept out of the record, tokens that
// need attention, the daily check, POST /git/check on public, private and multi-stage repositories, and who may.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startApp } from './helpers.js';
import { parseRepoUrl, readDockerfile, isBranchName, isRepoPath } from '../src/git/hosts.js';

const API = '/infrastructure/api/v1';

test('repository URLs and Dockerfiles are read, and what is not one is refused', () => {
  assert.deepEqual(parseRepoUrl('https://github.com/stevie/storefront.git'), {
    provider: 'github', hostname: 'github.com', owner: 'stevie', name: 'storefront', fullName: 'stevie/storefront', cloneUrl: 'https://github.com/stevie/storefront.git',
  });
  assert.equal(parseRepoUrl('git@github.com:stevie/storefront.git').cloneUrl, 'https://github.com/stevie/storefront.git');
  assert.equal(parseRepoUrl('https://gitlab.com/group/sub/project').fullName, 'group/sub/project');
  assert.equal(parseRepoUrl('https://git.example.com/team/app.git').provider, 'other');
  for (const bad of ['http://github.com/a/b', 'https://github.com/a', 'https://github.com/a/b/c', 'file:///etc/passwd', 'https://github.com/a/b;rm -rf', '--upload-pack=x', '']) {
    assert.equal(parseRepoUrl(bad), null, bad);
  }
  assert.ok(isBranchName('main') && isBranchName('release/2.1') && !isBranchName('-x') && !isBranchName('a..b') && !isBranchName('a b'));
  assert.ok(isRepoPath('./Dockerfile') && isRepoPath('web/Dockerfile') && !isRepoPath('../etc/passwd') && !isRepoPath('/etc/passwd'));

  assert.deepEqual(readDockerfile('FROM node:22-alpine\nWORKDIR /app\nEXPOSE 3000\nCMD ["node", "server.js"]\n'), { baseImage: 'node:22-alpine', port: 3000, stages: 1 });
  const multi = readDockerfile('FROM golang:1.23 AS build\nRUN go build -o /out/api\nFROM gcr.io/distroless/static\nCOPY --from=build /out/api /api\nEXPOSE 3000\n');
  assert.deepEqual(multi, { baseImage: 'gcr.io/distroless/static', port: 3000, stages: 2 });
  assert.equal(readDockerfile('FROM nginx:1.27\n').port, null, 'no EXPOSE: the form asks for the port');
});

test('a token is checked on save and kept in secrets; one that cannot add webhooks, or expires soon, needs attention', async () => {
  const t = await startApp({ seed: true });
  try {
    const seeded = (await t.get(`${API}/git/connections`, { as: 'naledi-k' })).json;
    assert.deepEqual(seeded.connections.map((c) => [c.id, c.state, c.repoCount, c.apps.length > 0]), [['github-stevie', 'connected', 24, true]]);
    assert.match(seeded.help.github, /admin:repo_hook/);

    assert.equal((await t.post(`${API}/git/connections`, { as: 'priya-s', body: { provider: 'gitlab', token: 'mock_gitlab_stevie' } })).status, 403, 'only an Owner adds one');
    const bad = await t.post(`${API}/git/connections`, { as: 'stevie', body: { provider: 'bitbucket', token: '' } });
    assert.equal(bad.status, 422);
    assert.deepEqual(Object.keys(bad.json.error.details.fields).sort(), ['provider', 'token']);
    const expired = await t.post(`${API}/git/connections`, { as: 'stevie', body: { provider: 'github', token: 'mock_github_expired' } });
    assert.equal(expired.status, 422);
    assert.match(expired.json.error.message, /does not accept this token/);

    const lab = await t.post(`${API}/git/connections`, { as: 'stevie', body: { provider: 'gitlab', token: 'mock_gitlab_stevie' } });
    assert.equal(lab.status, 201, lab.text);
    assert.deepEqual([lab.json.id, lab.json.user, lab.json.state, lab.json.canHook], ['gitlab-stevie', 'stevie', 'connected', true]);
    assert.equal(lab.json.token, undefined);
    const file = await fs.readFile(path.join(t.dataDir, 'git-connections', 'gitlab-stevie.md'), 'utf8');
    assert.doesNotMatch(file, /mock_gitlab_stevie/, 'the record holds a ref, never the token');
    assert.match(file, /tokenRef:/);

    const ro = (await t.post(`${API}/git/connections`, { as: 'stevie', body: { provider: 'github', token: 'mock_github_readonly' } })).json;
    assert.deepEqual([ro.id, ro.state, ro.canHook], ['github-stevie-2', 'needs-attention', false]);
    assert.match(ro.problem, /cannot add webhooks \(it needs admin:repo_hook\)/);
    const soon = (await t.post(`${API}/git/connections`, { as: 'stevie', body: { provider: 'github', token: 'mock_github_soon' } })).json;
    assert.equal(soon.state, 'needs-attention');
    assert.match(soon.problem, /The token expires on \d{4}-\d{2}-\d{2}\. Add a new one before then\./);

    await t.hosted.runJob('git-check');
    assert.equal((await t.get(`${API}/git/connections/github-stevie`, { as: 'stevie' })).json.state, 'connected', 'the daily check');
    const tested = await t.post(`${API}/git/connections/gitlab-stevie/test`, { as: 'stevie' });
    assert.deepEqual([tested.status, tested.json.state], [200, 'connected']);

    assert.equal((await t.delete(`${API}/git/connections/gitlab-stevie`, { as: 'thabo-n' })).status, 403);
    assert.deepEqual((await t.delete(`${API}/git/connections/gitlab-stevie`, { as: 'stevie' })).json, { removed: 'gitlab-stevie' });
    assert.equal((await t.get(`${API}/git/connections/gitlab-stevie`, { as: 'stevie' })).status, 404);
    const connected = (await t.get(`${API}/activity?kind=git&limit=10`, { as: 'stevie' })).json.activity.map((a) => a.verb);
    assert.ok(connected.includes('Connected') && connected.includes('Removed'), connected.join());
  } finally {
    await t.close();
  }
});

test('checking a repository reads its Dockerfile through the host: public, private with a connection, multi-stage, none', async () => {
  const t = await startApp({ seed: true });
  try {
    const check = (body, as = 'priya-s') => t.post(`${API}/git/check`, { as, body });
    const blog = (await check({ repo: 'https://github.com/nooblyjs/blog.git' })).json;
    assert.deepEqual([blog.found, blog.branch, blog.port, blog.private, blog.connection], [true, 'main', 8080, false, null]);
    assert.match(blog.baseImage, /^nginx/);
    assert.match(blog.commit.sha, /^[0-9a-f]{40}$/);

    const hidden = (await check({ repo: 'https://github.com/stevie/storefront.git' })).json;
    assert.equal(hidden.found, false);
    assert.match(hidden.message, /private, or not there\. Pick a Git connection/);
    const shop = (await check({ repo: 'https://github.com/stevie/storefront.git', gitConnection: 'github-stevie' })).json;
    assert.deepEqual([shop.found, shop.baseImage, shop.port, shop.private, shop.connection], [true, 'node:22-alpine', 3000, true, 'github-stevie']);
    assert.ok(shop.branches.includes('develop'));
    const dev = (await check({ repo: 'https://github.com/stevie/storefront.git', gitConnection: 'github-stevie', branch: 'develop' })).json;
    assert.equal(dev.branch, 'develop');
    assert.notEqual(dev.commit.sha, shop.commit.sha);
    assert.match((await check({ repo: 'https://github.com/stevie/storefront.git', gitConnection: 'github-stevie', branch: 'nope' })).json.message, /has no branch nope/);

    const go = (await check({ repo: 'https://github.com/stevie/orders-api.git', gitConnection: 'github-stevie' })).json;
    assert.deepEqual([go.baseImage, go.stages, go.port], ['gcr.io/distroless/static-debian12', 2, 3000]);
    const none = (await check({ repo: 'https://github.com/stevie/no-dockerfile.git' })).json;
    assert.deepEqual([none.found, none.message], [false, 'No ./Dockerfile on main. Apps are built from a Dockerfile.']);
    const other = (await check({ repo: 'https://git.example.com/team/app.git' })).json;
    assert.equal(other.found, null);
    assert.match(other.message, /cloned on the VM/);

    assert.equal((await check({ repo: 'not a url' })).status, 422);
    assert.equal((await check({ repo: 'https://github.com/nooblyjs/blog.git' }, 'naledi-k')).status, 403, 'a Viewer may not');
  } finally {
    await t.close();
  }
});
