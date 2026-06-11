import { execSync } from 'child_process'

// Tag + GitHub Release only — no commit-back to main. The version source of
// truth is the git tag; release notes live on the Releases page. (A
// commit-back plugin would need a bypass on the protected main branch, which
// GitHub doesn't grant to the Actions app on personal repos.)
const pluginsCI = [
  '@semantic-release/commit-analyzer',
  '@semantic-release/release-notes-generator',
  '@semantic-release/github',
]

function getLocalRunConfig() {
  return {
    repositoryUrl: getLocalRepoUrl(),
    branches: [getCurrentBranch()],
    plugins: pluginsCI,
  }
}

function getCIConfig() {
  return {
    branches: ['main'],
    plugins: pluginsCI,
  }
}

function isLocalRun() {
  return process.argv.includes('--local')
}

function getLocalRepoUrl() {
  const topLevelDir = execSync('git rev-parse --show-toplevel')
    .toString()
    .trim()
  return `file://${topLevelDir}/.git`
}

function getCurrentBranch() {
  return execSync('git rev-parse --abbrev-ref HEAD').toString().trim()
}

const config = isLocalRun() ? getLocalRunConfig() : getCIConfig()

export default config
