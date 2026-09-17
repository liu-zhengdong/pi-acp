// 仅使用 GitHub 元数据；不会 checkout 或执行上游代码。
export async function syncUpstream({ github, owner, repo, upstream, dryRun = true }) {
  if (typeof dryRun !== 'boolean') throw new Error('dryRun 必须是布尔值')
  if (!/^[\w.-]+\/[\w.-]+$/.test(upstream)) throw new Error('无效的上游仓库')
  const [upstreamOwner, upstreamRepo] = upstream.split('/')
  const source = { owner: upstreamOwner, repo: upstreamRepo }
  const target = { owner, repo }
  let release
  try {
    release = (await github.rest.repos.getLatestRelease(source)).data
  } catch (error) {
    if (error.status === 404) {
      await github.rest.repos.get(source) // 仓库消失或无权限时不能报成“没有版本”。
      return { status: 'no-release' }
    }
    throw error
  }
  if (release.draft || release.prerelease) return { status: 'not-stable' }
  const tag = release.tag_name
  if (typeof tag !== 'string' || !/^v?\d{1,10}\.\d{1,10}\.\d{1,10}$/.test(tag)) {
    throw new Error('只接受 vX.Y.Z 或 X.Y.Z 格式的稳定版本 tag')
  }

  let object = (await github.rest.git.getRef({ ...source, ref: `tags/${tag}` })).data.object
  for (let depth = 0; object.type === 'tag' && depth < 5; depth++) {
    object = (await github.rest.git.getTag({ ...source, tag_sha: object.sha })).data.object
  }
  if (object.type !== 'commit' || !/^[0-9a-f]{40}$/.test(object.sha)) {
    throw new Error('上游 tag 未能解析到有效 commit')
  }
  const sha = object.sha
  const base = (await github.rest.repos.get(target)).data.default_branch
  const comparison = (
    await github.rest.repos.compareCommitsWithBasehead({
      ...target,
      basehead: `${base}...${sha}`
    })
  ).data
  if (!Number.isSafeInteger(comparison.ahead_by) || comparison.ahead_by < 0) {
    throw new Error('GitHub 提交比较结果无效')
  }
  if (comparison.ahead_by === 0) return { status: 'up-to-date', tag, sha }

  const branch = `upstream-sync/${tag}`
  const existing = (
    await github.rest.pulls.list({
      ...target,
      head: `${owner}:${branch}`,
      base,
      state: 'all',
      per_page: 1
    })
  ).data
  if (existing.length) {
    return { status: 'existing-pr', tag, url: existing[0].html_url, state: existing[0].state }
  }
  // 允许创建分支后请求失败的下一轮恢复；用户改过分支时明确失败，不强推。
  let branchExists = false
  try {
    const ref = (await github.rest.git.getRef({ ...target, ref: `heads/${branch}` })).data
    if (ref.object.sha !== sha) throw new Error(`分支 ${branch} 已有不同提交，请人工处理`)
    branchExists = true
  } catch (error) {
    if (error.status !== 404) throw error
  }
  const title = `同步上游 ${upstream} ${tag}`
  const releaseUrl = `https://github.com/${upstream}/releases/tag/${tag}`
  const body = [
    `## 上游版本\n\n[${upstream} ${tag}](${releaseUrl})\n\n提交：\`${sha}\``,
    '## 审阅与合入\n\n这是自动创建的草稿 PR，不会自动合入、发布 npm 或替换安装。',
    '- 检查差异；如有冲突，先解决冲突，保留 fork 的能力、scoped 包名和仓库信息。',
    '- 确认 npm 版本及配套包兼容性；同步上游不等于发布新版本。',
    '- 标记 **Ready for review** 以触发 CI，通过后再决定合入。',
    '- 不需要这个版本时直接关闭；定时任务不会为同一分支重复创建 PR。',
    '## 自动化范围\n\n本分支指向上游 tag 的真实提交，由 GitHub 三方合并计算差异。任务不会执行上游代码、解决冲突或强推已有分支。'
  ].join('\n\n')
  if (dryRun) return { status: 'would-create', tag, sha, branch, base, title, body }
  if (!branchExists) await github.rest.git.createRef({ ...target, ref: `refs/heads/${branch}`, sha })
  const pr = (await github.rest.pulls.create({ ...target, base, head: branch, title, body, draft: true })).data
  return { status: 'created', tag, sha, url: pr.html_url }
}
