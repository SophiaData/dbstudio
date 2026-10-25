import { readFile } from 'node:fs/promises'
import { checkReleaseVersion } from './check-release-version.mjs'

// Called only by the final GitHub Actions job. Keep remote operations injectable
// so upload failures can prove that a new release never becomes partially public.
export async function publishRelease({ github, owner, repo, gate, env = process.env }) {
  const { tag, publish } = checkReleaseVersion(gate.version, env)
  if (!publish) throw new Error('Manual builds cannot publish releases')
  if (gate.sha !== env.GITHUB_SHA || gate.runId !== env.GITHUB_RUN_ID || gate.runAttempt !== env.GITHUB_RUN_ATTEMPT) {
    throw new Error('Gate identity does not match this workflow')
  }
  let release
  try { release = (await github.rest.repos.getReleaseByTag({ owner, repo, tag })).data }
  catch (error) { if (error.status !== 404) throw error }
  if (release && !release.draft) throw new Error('Refusing to modify an existing public release')
  if (release && release.target_commitish !== gate.sha) throw new Error('Existing draft has a different commit')
  if (!release) {
    release = (await github.rest.repos.createRelease({
      owner, repo, tag_name: tag, target_commitish: gate.sha, name: tag, draft: true,
      prerelease: gate.version.includes('-')
    })).data
  }
  const listAssets = () => github.paginate(github.rest.repos.listReleaseAssets, { owner, repo, release_id: release.id })
  for (const asset of await listAssets()) {
    await github.rest.repos.deleteReleaseAsset({ owner, repo, asset_id: asset.id })
  }
  for (const asset of gate.assets) {
    await github.rest.repos.uploadReleaseAsset({
      owner, repo, release_id: release.id, name: asset.name,
      data: await readFile(asset.path),
      headers: { 'content-type': 'application/octet-stream', 'content-length': asset.size }
    })
  }
  const uploaded = await listAssets()
  if (uploaded.length !== gate.assets.length || gate.assets.some((asset) => !uploaded.some((remote) =>
    remote.name === asset.name && remote.size === asset.size && remote.state === 'uploaded'
      && remote.digest === `sha256:${asset.sha256}`))) {
    throw new Error('Draft attachment verification failed; release remains private')
  }
  await github.rest.repos.updateRelease({ owner, repo, release_id: release.id, draft: false })
}
