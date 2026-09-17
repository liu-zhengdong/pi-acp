import assert from 'node:assert/strict'
import test from 'node:test'
import { syncUpstream } from './upstream-sync.mjs'

const sha = 'a'.repeat(40)
const missing = () => Object.assign(new Error('Not Found'), { status: 404 })
function fixture() {
  const state = {
    release: { tag_name: 'v1.2.3', draft: false, prerelease: false },
    ahead: 2,
    branch: null,
    prs: [],
    writes: []
  }
  const github = {
    rest: {
      repos: {
        getLatestRelease: async () => ({ data: state.release }),
        get: async () => ({ data: { default_branch: 'main' } }),
        compareCommitsWithBasehead: async args => {
          assert.equal(args.basehead, `main...${sha}`)
          return { data: { ahead_by: state.ahead } }
        }
      },
      git: {
        getRef: async args => {
          if (args.ref.startsWith('tags/')) return { data: { object: { type: 'commit', sha } } }
          if (!state.branch) throw missing()
          return { data: { object: { type: 'commit', sha: state.branch } } }
        },
        getTag: async () => ({ data: { object: { type: 'commit', sha } } }),
        createRef: async args => {
          state.writes.push(['ref', args])
          state.branch = args.sha
        }
      },
      pulls: {
        list: async args => {
          assert.equal(args.state, 'all')
          assert.equal(args.head, 'owner:upstream-sync/v1.2.3')
          return { data: state.prs }
        },
        create: async args => {
          state.writes.push(['pr', args])
          const pr = { state: 'open', html_url: 'https://github.com/owner/fork/pull/10', ...args }
          state.prs.push(pr)
          return { data: pr }
        }
      }
    }
  }
  return {
    state,
    github,
    run: options => syncUpstream({ github, owner: 'owner', repo: 'fork', upstream: 'upstream/project', ...options })
  }
}

test('dry-run 展示完整 PR，无任何写入；真实执行创建草稿，重复执行不重建', async () => {
  const f = fixture()
  const preview = await f.run()
  assert.equal(preview.status, 'would-create')
  assert.match(preview.body, /Ready for review/)
  assert.deepEqual(f.state.writes, [])
  assert.equal((await f.run({ dryRun: false })).status, 'created')
  assert.equal(f.state.writes[1][1].draft, true)
  assert.equal(f.state.writes[0][1].sha, sha)
  assert.equal((await f.run({ dryRun: false })).status, 'existing-pr')
  f.state.prs[0].state = 'closed'
  assert.equal((await f.run({ dryRun: false })).state, 'closed')
  assert.equal(f.state.writes.length, 2)
})

test('已包含的上游提交、预发布与草稿均不创建 PR', async () => {
  const f = fixture()
  f.state.ahead = 0
  assert.equal((await f.run({ dryRun: false })).status, 'up-to-date')
  f.state.release.prerelease = true
  assert.equal((await f.run({ dryRun: false })).status, 'not-stable')
  f.state.release.prerelease = false
  f.state.release.draft = true
  assert.equal((await f.run({ dryRun: false })).status, 'not-stable')
  assert.deepEqual(f.state.writes, [])
})

test('拒绝畸形 tag、上游名及非布尔 dry-run', async () => {
  for (const tag of ['../main', 'v1.2.3-rc.1', 'v1.2.3\nrun', null, 'x'.repeat(300)]) {
    const f = fixture()
    f.state.release.tag_name = tag
    await assert.rejects(f.run({ dryRun: false }), /稳定版本 tag/)
    assert.deepEqual(f.state.writes, [])
  }
  await assert.rejects(fixture().run({ upstream: '../bad/repo' }), /无效的上游/)
  await assert.rejects(fixture().run({ dryRun: 'false' }), /布尔值/)
})

test('不会把认证、限流和异常比较结果当作无更新', async () => {
  for (const status of [403, 429, 500]) {
    const f = fixture()
    f.github.rest.repos.getLatestRelease = async () => {
      throw Object.assign(new Error('API failure'), { status })
    }
    await assert.rejects(f.run({ dryRun: false }), /API failure/)
    assert.deepEqual(f.state.writes, [])
  }
  for (const ahead of [undefined, -1, '0', NaN]) {
    const f = fixture()
    f.state.ahead = ahead
    await assert.rejects(f.run({ dryRun: false }), /比较结果无效/)
  }
  const f = fixture()
  f.github.rest.repos.getLatestRelease = async () => {
    throw missing()
  }
  assert.equal((await f.run()).status, 'no-release')
  f.github.rest.repos.get = async () => {
    throw missing()
  }
  await assert.rejects(f.run(), /Not Found/)
})

test('支持 annotated tag，拒绝无限嵌套和非 commit', async () => {
  const f = fixture()
  const original = f.github.rest.git.getRef
  f.github.rest.git.getRef = async args =>
    args.ref.startsWith('tags/') ? { data: { object: { type: 'tag', sha } } } : original(args)
  assert.equal((await f.run()).sha, sha)
  f.github.rest.git.getTag = async () => ({ data: { object: { type: 'tag', sha } } })
  await assert.rejects(f.run(), /有效 commit/)
  f.github.rest.git.getTag = async () => ({ data: { object: { type: 'tree', sha } } })
  await assert.rejects(f.run(), /有效 commit/)
})

test('恢复中断的建 PR，不改写用户已有分支；失败如实抛出', async () => {
  const f = fixture()
  f.state.branch = sha
  assert.equal((await f.run({ dryRun: false })).status, 'created')
  assert.equal(f.state.writes.length, 1)
  const g = fixture()
  g.state.branch = 'b'.repeat(40)
  await assert.rejects(g.run({ dryRun: false }), /人工处理/)
  assert.deepEqual(g.state.writes, [])
  const h = fixture()
  h.github.rest.pulls.create = async () => {
    throw new Error('PR permission denied')
  }
  await assert.rejects(h.run({ dryRun: false }), /permission denied/)
  assert.equal(h.state.branch, sha)
})
