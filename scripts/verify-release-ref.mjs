import { readFile } from 'node:fs/promises'

const packageJson = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
)
const releaseRef = process.argv[2] ?? process.env.GITHUB_REF_NAME

if (!releaseRef) {
  throw new Error('release tag is required as argv[2] or GITHUB_REF_NAME')
}

const expectedRef = `v${packageJson.version}`
if (releaseRef !== expectedRef) {
  throw new Error(
    `release tag ${JSON.stringify(releaseRef)} does not match package version ${JSON.stringify(expectedRef)}`,
  )
}

if (
  !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(
    releaseRef,
  )
) {
  throw new Error(
    `release tag ${JSON.stringify(releaseRef)} is not valid SemVer`,
  )
}

process.stdout.write(
  `${releaseRef} matches package version ${packageJson.version}\n`,
)
