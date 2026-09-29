// On-demand version of the startup checks: `npm run check`.
//
// Same config and same checks as the server performs at boot, but it exits non zero when anything
// failed so it can be used from a shell or a container healthcheck.

import { readFileSync } from 'node:fs'

import { Config } from './util/clip.js'
import { runPreflight } from './util/preflight.js'
import { error } from './util/logging.js'

let config: Config
try {
	config = JSON.parse(readFileSync('./config.json').toString('utf-8')) as Config
} catch(err) {
	error('preflight', 'could not read ./config.json:', err)
	error('preflight', 'Run this from the directory holding config.json, which entrypoint.sh generates from the RETHINK_* environment variables.')
	process.exit(1)
}

const report = await runPreflight(config)

// exit explicitly, a probe socket the broker never closed could otherwise keep the process alive
process.exit(report.failed > 0 ? 1 : 0)
