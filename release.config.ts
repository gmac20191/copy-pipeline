import { execSync } from 'child_process'

const pluginsCI = [
  '@semantic-release/commit-analyzer',
  '@semantic-release/release-notes-generator',
  [
    '@semantic-release/changelog',
    {
      changelogFile: 'CHANGELOG.md',
    },
  ],
  [
    '@semantic-release/npm',
    {
      npmPublish: false,
    },
  ],
  [
    '@semantic-release/git',
    {
      assets: ['package.json', 'CHANGELOG.md'],
      message:
        'chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}',
    },
  ],
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
    branches: ['main', 'next'],
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
