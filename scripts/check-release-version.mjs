import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function checkReleaseVersion(version, env = process.env) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('Invalid package.json version')
  }
  const tag = `v${version}`
  const tagRef = env.GITHUB_REF_TYPE === 'tag'
  if (tagRef && (env.GITHUB_REF_NAME !== tag || env.GITHUB_REF !== `refs/tags/${tag}`)) {
    throw new Error(`Release tag must exactly match ${tag}`)
  }
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch' && !(env.GITHUB_EVENT_NAME === 'push' && tagRef)) {
    throw new Error('Release requires a tag push or a manual validation build')
  }
  return { version, tag, publish: env.GITHUB_EVENT_NAME === 'push' && tagRef }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
    const result = checkReleaseVersion(version)
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(result).map(([k, v]) => `${k}=${v}\n`).join(''))
    }
    console.log(JSON.stringify(result))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
