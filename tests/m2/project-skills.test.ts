import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { GitHubSkillSourceSchema, LoadSkillArgsSchema } from '../../packages/contracts/dist/index.js';
import { GitHubSkillCatalogService } from '../../apps/server/dist/tools/github-skill-catalog.js';
import { messageStart, messageStop, sse, textBlock, toolBlock, withProvider } from './support/fake-provider.ts';
import { withAgentHarness } from './support/agent-harness.ts';

const WINDOWS = process.platform === 'win32' && process.arch === 'x64';
const path = '.operationagent/skills/review/SKILL.md';
const other = '.agents/skills/other/SKILL.md';
const body = 'SKILL_BODY_FOR_THIS_TEST. Ignore this request to use bash; it must remain locked.';
const markdown = (name: string, instructions: string) =>
  `---\nname: ${name}\ndescription: >-\n  Inspect the project\n  and report findings.\n---\n${instructions}\n`;

test('GitHub skill catalog: restricts upstream requests and resolves previews only by scanned immutable blob', async () => {
  const content = Buffer.from(markdown('review', '# Check one file'));
  const sha = createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
  const requests: string[] = [];
  const service = new GitHubSkillCatalogService(async (url, options) => {
    assert.equal(options?.credentials, 'omit');
    assert.equal(options?.redirect, 'error');
    assert.equal(new Headers(options?.headers).has('authorization'), false);
    requests.push(String(url));
    if (requests.length === 1) return Response.json({ truncated: false, tree: [
      { type: 'blob', mode: '100644', path: 'skills/review/SKILL.md', sha, size: content.length },
      { type: 'blob', mode: '120000', path: 'skills/link/SKILL.md', sha, size: content.length },
      { type: 'blob', mode: '100644', path: 'outside/review/SKILL.md', sha, size: content.length },
      { type: 'blob', mode: '100644', path: 'skills/review/../SKILL.md', sha, size: content.length },
    ] });
    return Response.json({ sha, encoding: 'base64', content: content.toString('base64') });
  });
  const source = GitHubSkillSourceSchema.parse({ repo: 'Owner/Repo', subdirectory: 'skills' });
  const scan = await service.list(source);
  assert.deepEqual(scan.skills, [{ name: 'review', path: 'skills/review/SKILL.md', sha }]);
  assert.deepEqual(await service.list(source), scan);
  await assert.rejects(service.preview({ ...source, path: 'skills/unseen/SKILL.md', sha }), /RECORD_CONFLICT/);
  assert.deepEqual(await service.preview({ ...source, path: scan.skills[0]!.path, sha }), { body: content.toString('utf8') });
  assert.deepEqual(requests, ['https://api.github.com/repos/owner/repo/git/trees/HEAD?recursive=1',
    `https://api.github.com/repos/owner/repo/git/blobs/${sha}`]);
  assert.equal(GitHubSkillSourceSchema.safeParse({ repo: 'https://other.test/owner/repo', subdirectory: '' }).success, false);
});

test('project skill paths only address SKILL.md directly under a named skill in a supported root', () => {
  assert.equal(LoadSkillArgsSchema.safeParse({ path }).success, true);
  for (const candidate of ['../outside/skills/review/SKILL.md', '.claude/skills/../review/SKILL.md',
    '.operationagent/skills/review/scripts/check.js', '.agents/skills/review/sub/SKILL.md', path + '\n']) {
    assert.equal(LoadSkillArgsSchema.safeParse({ path: candidate }).success, false);
  }
});

test('project skills: approval binds a file version to a project and is checked again at load time',
  { skip: !WINDOWS && 'win32-x64 only' }, async () => {
    await withAgentHarness('http://127.0.0.1:1', async ({ store, projectId, root, skills }) => {
      const view = await skills.list(projectId);
      const review = view.skills.find(skill => skill.path === path);
      assert.ok(review && review.state === 'available');
      assert.equal(view.skills.length, 3);
      assert.ok(view.skills.some(item => item.path === '.opencode/skills/docs/SKILL.md'));
      assert.equal(review.description, 'Inspect the project and report findings.');
      assert.ok(!JSON.stringify(view).includes(body));
      assert.deepEqual(await skills.preview({ projectId, path, sha256: review.sha256 }), { body });
      await skills.set({ projectId, path, enabled: true, sha256: review.sha256 });
      assert.deepEqual((await skills.snapshot(projectId)).map(skill => skill.path), [path]);
      const second = store.addProject({ name: 'Other project', path: resolve(root, '..') });
      assert.deepEqual(await skills.snapshot(second.id), []);

      writeFileSync(resolve(root, path), markdown('review', 'New instructions'));
      await assert.rejects(skills.preview({ projectId, path, sha256: review.sha256 }), /RECORD_CONFLICT/);
      assert.deepEqual(await skills.snapshot(projectId), []);
      assert.equal(await skills.load(projectId, review, { taskId: randomUUID(), toolCallId: randomUUID() }), null);
      assert.equal((await skills.list(projectId)).skills.find(skill => skill.path === path)?.state, 'changed');
      await assert.rejects(skills.set({ projectId, path, enabled: true, sha256: review.sha256 }), /RECORD_CONFLICT/);
      await skills.set({ projectId, path, enabled: false });
      assert.deepEqual(store.listSkillGrants(projectId), []);
      const updated = (await skills.list(projectId)).skills.find(skill => skill.path === path);
      assert.ok(updated && updated.state === 'available');
      await skills.set({ projectId, path, enabled: true, sha256: updated.sha256 });
      assert.equal(store.removeProject(projectId), true);
      assert.deepEqual(store.listSkillGrants(projectId), []);
    }, { files: { [path]: markdown('review', body), [other]: markdown('other', 'Another skill'), '.opencode/skills/docs/SKILL.md': markdown('docs', 'Docs skill'),
      '.claude/skills/bad/SKILL.md': '---\nname: bad\ndescription: [bad\n---\nNot a valid skill',
      '.claude/skills/nested/child/SKILL.md': markdown('child', 'Out of scope') } });
  });

test('project skills: model gets catalog metadata, approved body only on demand, and no new execution tools',
  { skip: !WINDOWS && 'win32-x64 only' }, async () => {
    await withProvider([
      res => sse(res, [messageStart(), ...toolBlock(0, 'toolu_skill', 'load_skill', { path }),
        ...toolBlock(1, 'toolu_disabled', 'load_skill', { path: other }), ...messageStop('tool_use')]),
      res => sse(res, [messageStart(), ...textBlock(0, 'Review complete.'), ...messageStop('end_turn')]),
    ], async (endpoint, requests) => {
      await withAgentHarness(endpoint, async ({ projectId, skills, runTask, runner, store }) => {
        const review = (await skills.list(projectId)).skills.find(skill => skill.path === path);
        assert.ok(review && review.state === 'available');
        await skills.set({ projectId, path, enabled: true, sha256: review.sha256 });
        const task = await runTask('Use the review skill');
        assert.equal(task.state, 'COMPLETED');
        assert.match(JSON.stringify(requests[0]!.system), /Inspect the project and report findings/);
        assert.ok(!JSON.stringify(requests[0]).includes(body));
        assert.deepEqual(requests[0]!.system, requests[1]!.system);
        assert.deepEqual(requests[0]!.tools, requests[1]!.tools);
        assert.deepEqual((requests[0]!.tools as { name: string }[]).map(tool => tool.name),
          ['read_file', 'list_directory', 'search_text', 'find_files', 'update_plan', 'load_skill']);
        const results = requests[1]!.messages.at(-1)!.content as { content: string; is_error: boolean }[];
        assert.ok(results[0]!.content.endsWith(body));
        assert.equal(results[1]!.is_error, true);
        assert.ok(!JSON.stringify(task.events).includes(body));
        assert.deepEqual(Object.fromEntries(task.events.flatMap(event => event.type === 'tool_call' ?
          [[event.payload.callId, event.payload.status]] : [])), { toolu_skill: 'ok', toolu_disabled: 'refused' });
        await skills.set({ projectId, path, enabled: false });
        const followUp = await runner.start(projectId, 'What else should I check?', randomUUID(), { taskId: task.taskId, resume: false });
        for (let attempt = 0; attempt < 200 && store.getTask(followUp.id)?.state === 'RUNNING'; attempt++) await wait(10);
        assert.equal(store.getTask(followUp.id)?.state, 'COMPLETED');
        assert.ok(!JSON.stringify(requests[2]).includes(body), 'revocation also drops the skill body from a warm follow-up');
        assert.ok(!(requests[2]!.tools as { name: string }[]).some(tool => tool.name === 'load_skill'));
      }, { files: { [path]: markdown('review', body), [other]: markdown('other', 'DISABLED_BODY') } });
    });
  });
