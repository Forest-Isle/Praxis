import { writePraxisBuildIdentity } from '../dist/platform/praxis-build-identity.js'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
await writePraxisBuildIdentity({
  sourceRoot: repositoryRoot,
  outputRoot: resolve(repositoryRoot, 'dist'),
})
