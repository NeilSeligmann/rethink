// Startup diagnostics.
//
// The bug this exists to fix: a user whose broker was unreachable saw nothing but
// "HA mqtt connection lost" once a second, forever. Every actionable detail (bad url, wrong port,
// DNS failure, refused credentials, denied ACL) was either never checked or swallowed by the
// mqtt client's own no-op 'error' listener. Preflight checks all of it once at boot and prints
// a single readable banner.
//
// Two hard rules for everything in this file:
//  - it must never throw and never exit. The LG-facing HTTPS side is still useful with a broken
//    Home Assistant link, so rethink has to start regardless.
//  - it must never print the mqtt password, in any form. "set" or "not set" only.

import { createServer, connect as netConnect, isIP, Socket } from 'node:net'
import { accessSync, constants as fsConstants, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { X509Certificate, randomBytes } from 'node:crypto'
import { promises as dnsPromises } from 'node:dns'
import { connect as mqttConnect, IClientOptions, ISubscriptionGrant, MqttClient } from 'mqtt'

import { Config, HAConfig } from './clip.js'
import { info, warn, error } from './logging.js'
import {
	parseBrokerUrl,
	diagnoseMqttError,
	diagnoseSilentClose,
	BrokerUrl,
	BrokerUrlError
} from './mqtt-diagnostics.js'

export type CheckStatus = 'ok' | 'warn' | 'fail'

export type CheckResult = {
	status: CheckStatus
	message: string
	hints?: string[]
}

export type PreflightReport = {
	passed: number
	warnings: number
	failed: number
}

// Checks share a context so the mqtt url only has to be parsed once and the network checks below
// it can be skipped cleanly when it could not be parsed at all.
type Context = {
	config: Partial<Config>
	ha: Partial<HAConfig>
	broker?: BrokerUrl
	// true when rethink's own servers are already listening, which changes what the port check means
	serversStarted?: boolean
}

export type PreflightOptions = {
	serversStarted?: boolean
}

type Check = {
	// short label printed in the second column, keep it under the column width
	name: string
	run: (ctx: Context) => CheckResult[] | Promise<CheckResult[]>
}

const NAME_COLUMN = 16
const HINT_INDENT = ' '.repeat(9)

// Backstop for a check that forgets its own timeout. Must stay comfortably above every internal
// budget below, otherwise it would fire first and throw away the detail that check had gathered.
const CHECK_BUDGET_MS = 30000

// Log topics actually passed to log() anywhere in the repo. Derived with:
//   grep -rnE "(^|[^.a-zA-Z_0-9])log\(" --include=*.ts . --exclude-dir=node_modules
// which excludes console.log. Re-run it when adding a new topic.
const KNOWN_LOG_TOPICS = new Set(['status', 'incoming', 'publish', 'HTTPS', 'mqtt', 'all'])

// Defaults baked into entrypoint.sh. Leaving them in place means the broker is almost certainly
// rejecting us, so they are worth calling out by name.
const DEFAULT_MQTT_USER = 'user'
const DEFAULT_MQTT_PASS = 'pass'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0'])

// -----------------------------------------------------------------------------------------------
// small helpers
// -----------------------------------------------------------------------------------------------

function ok(message: string, hints?: string[]): CheckResult {
	return { status: 'ok', message, hints }
}

function warning(message: string, hints?: string[]): CheckResult {
	return { status: 'warn', message, hints }
}

function failure(message: string, hints?: string[]): CheckResult {
	return { status: 'fail', message, hints }
}

// Resolves with the fallback rather than rejecting, so one stuck check can never stall startup.
function withTimeout<T>(work: Promise<T>, ms: number, fallback: () => T): Promise<T> {
	return new Promise<T>((settle) => {
		let done = false
		const finish = (value: T) => {
			if(done)
				return
			done = true
			clearTimeout(timer)
			settle(value)
		}

		const timer = setTimeout(() => finish(fallback()), ms)
		// unref so a pending timer cannot hold the process open in the CLI
		if(typeof(timer.unref) === 'function')
			timer.unref()

		work.then(finish, () => finish(fallback()))
	})
}

// "localhost" resolves to the container itself, which is the single most common cause of an
// unreachable broker in a docker deployment. Only worth warning about when we really are in one.
function inContainer(): boolean {
	try {
		accessSync('/.dockerenv', fsConstants.F_OK)
		return true
	} catch(err) {
		// not a container marker, fall through to cgroup inspection
	}

	try {
		return /docker|containerd|kubepods/.test(readFileSync('/proc/1/cgroup').toString('utf-8'))
	} catch(err) {
		return false
	}
}

function isReadable(path: string): boolean {
	try {
		accessSync(path, fsConstants.R_OK)
		return true
	} catch(err) {
		return false
	}
}

function isWritableDir(path: string): boolean {
	try {
		accessSync(dirname(path) || '.', fsConstants.W_OK)
		return true
	} catch(err) {
		return false
	}
}

// -----------------------------------------------------------------------------------------------
// check 1: config shape
// -----------------------------------------------------------------------------------------------

type FieldSpec = {
	key: string
	env: string
	type: 'string' | 'number' | 'array'
	optional?: boolean
	// for values where "" is a meaningful setting rather than a mistake
	allowEmpty?: boolean
}

const TOP_LEVEL_FIELDS: FieldSpec[] = [
	{ key: 'hostname', env: 'RETHINK_HOSTNAME', type: 'string' },
	{ key: 'ca_key_file', env: 'RETHINK_CA_KEY_FILE', type: 'string' },
	{ key: 'ca_cert_file', env: 'RETHINK_CA_CERT_FILE', type: 'string' },
	{ key: 'https_port', env: 'RETHINK_HTTPS_PORT', type: 'number' },
	{ key: 'mqtts_port', env: 'RETHINK_MQTTS_PORT', type: 'number' },
	{ key: 'mqtt_port', env: 'RETHINK_MQTT_PORT', type: 'number' },
	{ key: 'log', env: 'RETHINK_LOG', type: 'array', optional: true }
]

const HA_FIELDS: FieldSpec[] = [
	{ key: 'mqtt_url', env: 'RETHINK_MQTT_URL', type: 'string' },
	{ key: 'discovery_prefix', env: 'RETHINK_DISCOVERY_PREFIX', type: 'string' },
	{ key: 'rethink_prefix', env: 'RETHINK_PREFIX', type: 'string' },
	// blank credentials are how you connect to an anonymous broker, so never fail on them here.
	// checkMqttCredentials warns about the combinations that are actually suspicious.
	{ key: 'mqtt_user', env: 'RETHINK_MQTT_USER', type: 'string', optional: true, allowEmpty: true },
	{ key: 'mqtt_pass', env: 'RETHINK_MQTT_PASS', type: 'string', optional: true, allowEmpty: true }
]

// Keyed by a config key read from json, so a Map rather than an object literal: a key like
// "constructor" would otherwise resolve off Object.prototype and report a nonsense value.
function fieldValues(source: object | undefined): Map<string, unknown> {
	const values = new Map<string, unknown>()
	if(source && typeof(source) === 'object')
		for(const [ key, value ] of Object.entries(source))
			values.set(key, value)
	return values
}

function checkField(values: Map<string, unknown>, spec: FieldSpec, where: string): CheckResult | undefined {
	const value = values.get(spec.key)

	if(value === undefined || value === null) {
		if(spec.optional)
			return undefined
		return failure(`${where}${spec.key} is missing`, [`Set ${spec.env}`])
	}

	if(spec.type === 'string') {
		if(typeof(value) !== 'string')
			return failure(`${where}${spec.key} should be a string but is ${typeof(value)}`, [`Check the value of ${spec.env}`])
		if(value.trim() === '' && !spec.allowEmpty)
			return failure(`${where}${spec.key} is empty`, [`Set ${spec.env}`])
		return undefined
	}

	if(spec.type === 'number') {
		if(typeof(value) !== 'number' || !Number.isFinite(value))
			return failure(`${where}${spec.key} should be a number but is ${JSON.stringify(value)}`, [
				`Set ${spec.env} to a plain number, entrypoint.sh writes it into config.json unquoted`
			])
		return undefined
	}

	if(!Array.isArray(value) || value.some((entry) => typeof(entry) !== 'string'))
		return failure(`${where}${spec.key} should be an array of strings`, [
			`${spec.env} must be valid json, for example RETHINK_LOG='["status","incoming"]'`
		])

	return undefined
}

function checkConfigShape(ctx: Context): CheckResult[] {
	const results: CheckResult[] = []
	const top = fieldValues(ctx.config)

	for(const spec of TOP_LEVEL_FIELDS) {
		const problem = checkField(top, spec, '')
		if(problem)
			results.push(problem)
	}

	const haBlock = top.get('homeassistant')
	if(!haBlock || typeof(haBlock) !== 'object') {
		results.push(failure('the "homeassistant" block is missing from config.json', [
			'Without it rethink cannot talk to Home Assistant at all',
			'Regenerate config.json by restarting the container, entrypoint.sh always writes this block'
		]))
	} else {
		const ha = fieldValues(haBlock)
		for(const spec of HA_FIELDS) {
			const problem = checkField(ha, spec, 'homeassistant.')
			if(problem)
				results.push(problem)
		}
	}

	const mqttEnabled = top.get('mqtt')
	if(mqttEnabled !== undefined && typeof(mqttEnabled) !== 'boolean')
		results.push(failure(`mqtt should be true or false but is ${JSON.stringify(mqttEnabled)}`))

	if(results.length === 0)
		results.push(ok('every expected field is present and of the right type'))

	return results
}

// -----------------------------------------------------------------------------------------------
// check 2: ports
// -----------------------------------------------------------------------------------------------

type PortSpec = {
	key: 'https_port' | 'mqtts_port' | 'mqtt_port'
	env: string
}

const PORT_SPECS: PortSpec[] = [
	{ key: 'https_port', env: 'RETHINK_HTTPS_PORT' },
	{ key: 'mqtts_port', env: 'RETHINK_MQTTS_PORT' },
	{ key: 'mqtt_port', env: 'RETHINK_MQTT_PORT' }
]

// Confirms something is listening on a port we expect to be ours. Used once the servers are up,
// where a test bind would only ever rediscover our own listeners.
function testListening(port: number, key: string): Promise<CheckResult> {
	return new Promise<CheckResult>((settle) => {
		let done = false
		const socket = new Socket()

		const finish = (result: CheckResult) => {
			if(done)
				return
			done = true
			clearTimeout(timer)
			socket.removeAllListeners()
			socket.destroy()
			settle(result)
		}

		const timer = setTimeout(() => finish(warning(`port ${port} did not answer within 3s`)), 3000)
		if(typeof(timer.unref) === 'function')
			timer.unref()

		socket.once('connect', () => finish(ok(`port ${port} is listening`)))
		socket.once('error', () => finish(failure(`nothing is listening on port ${port}`, [
			`The server for "${key}" did not start, look for its listen error above`
		])))

		socket.connect(port, '127.0.0.1')
	})
}

// Binds and immediately releases, which is the only reliable way to tell whether listen() will
// succeed later. Only meaningful while the real servers are not running.
function testBind(port: number): Promise<CheckResult> {
	return new Promise<CheckResult>((settle) => {
		let done = false
		const server = createServer()

		const finish = (result: CheckResult) => {
			if(done)
				return
			done = true
			clearTimeout(timer)
			server.removeAllListeners()
			try {
				server.close()
			} catch(err) {
				// already closed or never opened, nothing to do
			}
			settle(result)
		}

		const timer = setTimeout(() => finish(warning(`port ${port} did not answer a test bind within 3s`)), 3000)
		if(typeof(timer.unref) === 'function')
			timer.unref()

		server.once('error', (err: NodeJS.ErrnoException) => {
			switch(err.code) {
				case 'EADDRINUSE':
					// A warning rather than a failure: running the checks inside a container where
					// rethink is already up is the documented way to use them, and there the port
					// being held is expected.
					return finish(warning(`port ${port} is already in use`, [
						'Expected if rethink is already running here, otherwise another service holds it',
						'If rethink is not running, change the port or stop whatever holds it'
					]))
				case 'EACCES':
					return finish(failure(`binding port ${port} requires privileges`, [
						'Ports below 1024 need root or CAP_NET_BIND_SERVICE',
						'In docker, publish a low host port onto a high container port instead, for example "443:4433"'
					]))
				default:
					return finish(failure(`port ${port} could not be bound (${err.code ?? err.message})`))
			}
		})

		server.once('listening', () => finish(ok(`port ${port} is free`)))

		try {
			server.listen(port, '0.0.0.0')
		} catch(err) {
			finish(failure(`port ${port} could not be bound (${err})`))
		}
	})
}

async function checkPorts(ctx: Context): Promise<CheckResult[]> {
	const results: CheckResult[] = []
	// port number -> the config keys asking for it, so a collision names both of them
	const seen = new Map<number, string[]>()

	for(const spec of PORT_SPECS) {
		const value = ctx.config[spec.key]

		if(typeof(value) !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
			results.push(failure(`${spec.key} is not a valid port (${JSON.stringify(value)})`, [
				`${spec.env} must be an integer between 1 and 65535`
			]))
			continue
		}

		seen.set(value, [ ...(seen.get(value) ?? []), spec.key ])
	}

	for(const [ port, keys ] of seen)
		if(keys.length > 1)
			results.push(failure(`${keys.join(' and ')} are both set to ${port}`, [
				'Each server needs its own port, they cannot share one'
			]))

	// Once our own servers hold these ports, a test bind can only ever report our own listener as a
	// collision. Confirm they came up instead, which is the thing actually worth knowing.
	for(const [ port, keys ] of seen)
		results.push(ctx.serversStarted ? await testListening(port, keys[0]) : await testBind(port))

	return results
}

// -----------------------------------------------------------------------------------------------
// check 3: hostname
// -----------------------------------------------------------------------------------------------

function checkHostname(ctx: Context): CheckResult[] {
	const hostname = ctx.config.hostname

	if(typeof(hostname) !== 'string' || hostname.trim() === '')
		return [ failure('hostname is not set', [
			'Set RETHINK_HOSTNAME to the DNS name your appliances will be redirected to'
		]) ]

	const results: CheckResult[] = []

	if(hostname.includes('://'))
		results.push(failure(`hostname "${hostname}" contains a protocol`, [
			'RETHINK_HOSTNAME is a bare DNS name, for example "common.lgthinq.com", not a url'
		]))
	else if(/:\d+$/.test(hostname))
		results.push(failure(`hostname "${hostname}" contains a port`, [
			'RETHINK_HOSTNAME is a bare DNS name. The port is set separately by RETHINK_HTTPS_PORT'
		]))
	else if(isIP(hostname) !== 0)
		results.push(warning(`hostname "${hostname}" is an IP address`, [
			'Appliances need a DNS name here, not an IP. The generated certificate is issued for this value',
			'Create a DNS record pointing at this server, see the comment on RETHINK_HOSTNAME in docker-compose.yaml'
		]))
	else
		results.push(ok(`"${hostname}"`))

	return results
}

// -----------------------------------------------------------------------------------------------
// check 4: CA files
// -----------------------------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000
const CERT_EXPIRY_WARNING_DAYS = 30

function checkCaFiles(ctx: Context): CheckResult[] {
	const results: CheckResult[] = []
	const certFile = ctx.config.ca_cert_file
	const keyFile = ctx.config.ca_key_file

	for(const [ label, path, env ] of [
		[ 'certificate', certFile, 'RETHINK_CA_CERT_FILE' ],
		[ 'key', keyFile, 'RETHINK_CA_KEY_FILE' ]
	] as const) {
		if(typeof(path) !== 'string' || path.trim() === '') {
			results.push(failure(`the CA ${label} path is not set`, [`Set ${env}`]))
			continue
		}

		if(isReadable(path)) {
			results.push(ok(`CA ${label} "${path}" is readable`))
			continue
		}

		// absent is fine, rethink generates a pair on first boot, but only if it can write there
		if(isWritableDir(path))
			results.push(warning(`CA ${label} "${path}" does not exist yet, a new one will be generated`))
		else
			results.push(failure(`CA ${label} "${path}" is missing and its directory is not writable`, [
				'rethink generates the CA on first boot and cannot do so without write access',
				'Check the ownership of the mounted volume'
			]))
	}

	if(typeof(certFile) !== 'string' || !isReadable(certFile))
		return results

	let cert: X509Certificate
	try {
		cert = new X509Certificate(readFileSync(certFile))
	} catch(err) {
		results.push(failure(`the CA certificate "${certFile}" could not be parsed (${err})`, [
			'rethink will overwrite it with a freshly generated one',
			'Delete it deliberately if that is what you want, otherwise restore a good copy'
		]))
		return results
	}

	results.push(ok(`certificate subject ${cert.subject.replace(/\n/g, ', ')}`))

	const hostname = ctx.config.hostname
	if(typeof(hostname) === 'string' && hostname.trim() !== '') {
		if(cert.checkHost(hostname))
			results.push(ok(`certificate covers "${hostname}"`))
		else
			results.push(failure(`the certificate does not cover "${hostname}"`, [
				'rethink silently deletes and regenerates the CA when this happens, so any copy your appliances already trust stops working',
				'Either set RETHINK_HOSTNAME back to the name the certificate was issued for, or re-provision the appliances against the new CA'
			]))
	}

	const expiry = Date.parse(cert.validTo)
	if(Number.isNaN(expiry)) {
		results.push(warning(`the certificate expiry date could not be read ("${cert.validTo}")`))
	} else {
		const days = Math.floor((expiry - Date.now()) / DAY_MS)
		if(days < 0)
			results.push(failure(`the certificate expired ${-days} day(s) ago (${cert.validTo})`, [
				'Delete the CA files and restart to have rethink generate a new pair, then re-provision the appliances'
			]))
		else if(days <= CERT_EXPIRY_WARNING_DAYS)
			results.push(warning(`the certificate expires in ${days} day(s) (${cert.validTo})`))
		else
			results.push(ok(`certificate valid for another ${days} day(s)`))
	}

	return results
}

// -----------------------------------------------------------------------------------------------
// check 5: log topics
// -----------------------------------------------------------------------------------------------

function checkLogTopics(ctx: Context): CheckResult[] {
	const topics = ctx.config.log

	if(topics === undefined)
		return [ ok('not set, defaulting to "status" and "incoming"') ]

	if(!Array.isArray(topics) || topics.some((topic) => typeof(topic) !== 'string'))
		return [ failure('log should be an array of strings', [
			'RETHINK_LOG must be valid json, for example RETHINK_LOG=\'["status","incoming"]\''
		]) ]

	const unknown = topics.filter((topic) => !KNOWN_LOG_TOPICS.has(topic))
	if(unknown.length === 0)
		return [ ok(topics.length > 0 ? topics.join(', ') : 'empty, nothing will be logged') ]

	return [ warning(`no code logs to ${unknown.map((topic) => `"${topic}"`).join(', ')}`, [
		`Known topics: ${Array.from(KNOWN_LOG_TOPICS).filter((topic) => topic !== 'all').join(', ')}`,
		'Use "all" to enable every topic at once'
	]) ]
}

// -----------------------------------------------------------------------------------------------
// check 6: mqtt url
// -----------------------------------------------------------------------------------------------

function checkMqttUrl(ctx: Context): CheckResult[] {
	const raw = ctx.ha.mqtt_url

	let broker: BrokerUrl
	try {
		broker = parseBrokerUrl(typeof(raw) === 'string' ? raw : '')
	} catch(err) {
		if(err instanceof BrokerUrlError)
			return [ failure(err.message, err.hints) ]
		return [ failure(`the broker url could not be parsed (${err})`) ]
	}

	ctx.broker = broker

	const traits = [ broker.secure ? 'TLS' : 'plaintext' ]
	if(broker.websocket)
		traits.push('websocket')

	const results: CheckResult[] = [ ok(`${broker.safeUrl} (${traits.join(', ')})`) ]

	if(LOOPBACK_HOSTS.has(broker.host.toLowerCase()) && inContainer())
		results.push(warning(`the broker host "${broker.host}" points at this container, not at your server`, [
			'Inside a container "localhost" is the container itself, so the broker will never be found',
			'Use the server\'s LAN IP, or the broker container\'s service name if both are on the same docker network'
		]))

	return results
}

// -----------------------------------------------------------------------------------------------
// check 7: mqtt credentials
// -----------------------------------------------------------------------------------------------

// Reports the username, never the password. "set" or "not set" is the only thing said about the
// password anywhere in this file: no length, no hash, no masked preview.
function checkMqttCredentials(ctx: Context): CheckResult[] {
	const user = typeof(ctx.ha.mqtt_user) === 'string' ? ctx.ha.mqtt_user : ''
	const pass = typeof(ctx.ha.mqtt_pass) === 'string' ? ctx.ha.mqtt_pass : ''
	const results: CheckResult[] = []

	results.push(ok(`username ${user === '' ? 'not set (anonymous)' : `"${user}"`}, password ${pass === '' ? 'not set' : 'set'}`))

	if(user === DEFAULT_MQTT_USER)
		results.push(warning(`username is still the default "${DEFAULT_MQTT_USER}"`, [
			'Set RETHINK_MQTT_USER to a user your broker actually knows, or leave it empty for an anonymous broker'
		]))

	if(pass === DEFAULT_MQTT_PASS)
		results.push(warning('password is still the entrypoint default', [
			'Set RETHINK_MQTT_PASS to the password of the broker user above'
		]))

	if(user !== '' && pass === '')
		results.push(warning(`a username ("${user}") is set but no password is`, [
			'Most brokers reject a known username with an empty password',
			'Set RETHINK_MQTT_PASS, or clear RETHINK_MQTT_USER to connect anonymously'
		]))

	if(ctx.broker?.inlineCredentials)
		results.push(warning('credentials are embedded in RETHINK_MQTT_URL', [
			'The url takes precedence in some paths and RETHINK_MQTT_USER/RETHINK_MQTT_PASS in others, which is easy to get wrong',
			'Put the host and port in RETHINK_MQTT_URL and the credentials in RETHINK_MQTT_USER and RETHINK_MQTT_PASS'
		]))

	return results
}

// -----------------------------------------------------------------------------------------------
// check 8: DNS
// -----------------------------------------------------------------------------------------------

async function checkDns(ctx: Context): Promise<CheckResult[]> {
	const broker = ctx.broker
	if(!broker)
		return [ warning('skipped, the broker url could not be parsed') ]

	if(isIP(broker.host) !== 0)
		return [ ok(`"${broker.host}" is already an IP address, no lookup needed`) ]

	const lookup = dnsPromises.lookup(broker.host, { all: true, verbatim: true })
		.then((addresses) => ok(`"${broker.host}" resolves to ${addresses.map((entry) => entry.address).join(', ')}`))
		.catch((err) => {
			const diagnosis = diagnoseMqttError(err, broker)
			return failure(diagnosis.summary, diagnosis.hints)
		})

	return [ await withTimeout(lookup, 5000, () => failure(`the DNS lookup of "${broker.host}" did not finish within 5s`, [
		'The container\'s DNS resolver is not answering. Check the docker network and any custom "dns:" setting',
		'Use the broker\'s IP address in RETHINK_MQTT_URL to rule DNS out'
	])) ]
}

// -----------------------------------------------------------------------------------------------
// check 9: TCP reachability
// -----------------------------------------------------------------------------------------------

const TCP_TIMEOUT_MS = 5000

function checkTcp(ctx: Context): Promise<CheckResult[]> {
	const broker = ctx.broker
	if(!broker)
		return Promise.resolve([ warning('skipped, the broker url could not be parsed') ])

	return new Promise<CheckResult[]>((settle) => {
		const started = Date.now()
		let done = false

		const socket: Socket = netConnect({ host: broker.host, port: broker.port })
		socket.setTimeout(TCP_TIMEOUT_MS)

		const finish = (result: CheckResult) => {
			if(done)
				return
			done = true
			try {
				socket.destroy()
			} catch(err) {
				// already gone
			}
			settle([ result ])
		}

		socket.once('connect', () => finish(ok(`${broker.host}:${broker.port} reachable in ${Date.now() - started}ms`)))

		socket.once('timeout', () => {
			const diagnosis = diagnoseMqttError({ code: 'ETIMEDOUT' }, broker)
			finish(failure(diagnosis.summary, diagnosis.hints))
		})

		socket.once('error', (err) => {
			const diagnosis = diagnoseMqttError(err, broker)
			finish(failure(diagnosis.summary, diagnosis.hints))
		})
	})
}

// -----------------------------------------------------------------------------------------------
// check 10: mqtt handshake
// -----------------------------------------------------------------------------------------------

const HANDSHAKE_CONNECT_TIMEOUT_MS = 8000
const HANDSHAKE_BUDGET_MS = 20000
// each post-connect step gets its own deadline. A broker that logs us in and then silently
// ignores a subscribe or a publish is a real failure mode, and without a per step bound it would
// surface as one vague "did not finish in time" instead of naming the operation that hung.
const HANDSHAKE_STEP_TIMEOUT_MS = 5000
const SUBACK_DENIED = 128

function checkMqttHandshake(ctx: Context): Promise<CheckResult[]> {
	const broker = ctx.broker
	if(!broker)
		return Promise.resolve([ warning('skipped, the broker url could not be parsed') ])

	const user = typeof(ctx.ha.mqtt_user) === 'string' && ctx.ha.mqtt_user !== '' ? ctx.ha.mqtt_user : undefined
	const pass = typeof(ctx.ha.mqtt_pass) === 'string' && ctx.ha.mqtt_pass !== '' ? ctx.ha.mqtt_pass : undefined
	const discoveryPrefix = typeof(ctx.ha.discovery_prefix) === 'string' ? ctx.ha.discovery_prefix : 'homeassistant'
	const rethinkPrefix = typeof(ctx.ha.rethink_prefix) === 'string' ? ctx.ha.rethink_prefix : 'rethink'

	const options: IClientOptions = {
		// a distinct client id so this probe can never take over the real client's session
		clientId: 'rethink-preflight-' + randomBytes(6).toString('hex'),
		// one attempt only, we want the first failure rather than an endless retry loop
		reconnectPeriod: 0,
		connectTimeout: HANDSHAKE_CONNECT_TIMEOUT_MS,
		clean: true,
		username: user,
		password: pass
	}

	let client: MqttClient
	try {
		client = mqttConnect(broker.safeUrl, options)
	} catch(err) {
		return Promise.resolve([ failure(`the mqtt client could not be created (${err})`) ])
	}

	// lives outside the promise so the overall timeout below can still report whatever the probe
	// did manage to establish before it stalled
	const results: CheckResult[] = []
	let torndown = false

	const teardown = () => {
		if(torndown)
			return
		torndown = true
		try {
			// force close, an unclosed probe client would keep the CLI process alive
			client.end(true)
		} catch(err) {
			// nothing useful to do, the report matters more than the teardown
		}
	}

	const attempt = new Promise<CheckResult[]>((settle) => {
		let done = false
		let connected = false

		const finish = (extra: CheckResult[]) => {
			if(done)
				return
			done = true
			teardown()
			settle([ ...results, ...extra ])
		}

		// Runs `start`, and calls `onTimeout` if nothing has answered within the step budget.
		// Returns a guard the callback must pass through so a late answer cannot double report.
		const bounded = (onTimeout: () => void) => {
			let answered = false
			const timer = setTimeout(() => {
				if(answered || done)
					return
				answered = true
				onTimeout()
			}, HANDSHAKE_STEP_TIMEOUT_MS)
			if(typeof(timer.unref) === 'function')
				timer.unref()

			return () => {
				if(answered || done)
					return false
				answered = true
				clearTimeout(timer)
				return true
			}
		}

		// mqtt.connect() attaches its own no-op 'error' listener, so without this one every
		// failure below is swallowed and the user sees nothing. That silence is the whole reason
		// this file exists.
		client.on('error', (err) => {
			const diagnosis = diagnoseMqttError(err, broker)
			finish([ failure(diagnosis.summary, diagnosis.hints) ])
		})

		// A plaintext client against a TLS listener has its socket dropped before the handshake,
		// which clears the connack timer, so neither 'error' nor a connack timeout ever fires.
		// 'close' is the only event that does. Without this listener the probe would sit there
		// until its own budget expired and then say nothing useful.
		client.on('close', () => {
			if(connected)
				return
			const diagnosis = diagnoseSilentClose(broker, false)
			finish([ failure(diagnosis.summary, diagnosis.hints) ])
		})

		const probePublish = () => {
			const probeTopic = `${rethinkPrefix}/preflight`
			const claim = bounded(() => finish([ failure(`the broker never acknowledged the publish to "${probeTopic}"`, [
				'A qos 1 publish must be answered with a PUBACK. Silence normally means an ACL rule is discarding the message',
				`Grant write access to "${rethinkPrefix}/#" for this user, discovery cannot work without it`
			]) ]))

			// non retained so this probe leaves nothing behind on the broker
			client.publish(probeTopic, 'ok', { qos: 1, retain: false }, (pubErr?: Error) => {
				if(!claim())
					return

				if(pubErr)
					finish([ failure(`publishing to "${probeTopic}" failed (${pubErr.message})`, [
						'This is almost certainly an ACL rule denying write access',
						`Grant write access to "${rethinkPrefix}/#" for this user, discovery cannot work without it`
					]) ])
				else
					finish([ ok(`published to "${probeTopic}", write access confirmed`) ])
			})
		}

		const probeSubscribe = () => {
			const statusTopic = `${discoveryPrefix}/status`
			const claim = bounded(() => {
				results.push(warning(`the broker never answered the subscription to "${statusTopic}"`, [
					'A subscribe must be answered with a SUBACK. Check the broker\'s own log'
				]))
				probePublish()
			})

			client.subscribe(statusTopic, { qos: 0 }, (subErr: Error | null, granted: ISubscriptionGrant[]) => {
				if(!claim())
					return

				if(subErr)
					results.push(failure(`subscribing to "${statusTopic}" failed (${subErr.message})`, [
						'This is usually an ACL rule. The broker accepted the login but not the subscription'
					]))
				else if((granted ?? []).some((entry) => entry.qos === SUBACK_DENIED))
					results.push(failure(`the broker denied the subscription to "${statusTopic}"`, [
						'The broker answered SUBACK 128, which means this user is not allowed to read that topic',
						`Grant read access to "${discoveryPrefix}/#" for this user`
					]))
				else
					results.push(ok(`subscribed to "${statusTopic}"`))

				probePublish()
			})
		}

		client.once('connect', () => {
			connected = true
			results.push(ok(`connected and authenticated as ${user ? `"${user}"` : 'an anonymous client'}`))
			probeSubscribe()
		})
	})

	return withTimeout(attempt, HANDSHAKE_BUDGET_MS, () => {
		teardown()
		return [ ...results, failure(`the mqtt handshake did not finish within ${HANDSHAKE_BUDGET_MS / 1000}s`, [
			'The broker neither accepted nor refused the connection in that time',
			'A firewall dropping packets silently is the usual cause'
		]) ]
	})
}

// -----------------------------------------------------------------------------------------------
// runner
// -----------------------------------------------------------------------------------------------

const CHECKS: Check[] = [
	{ name: 'config', run: checkConfigShape },
	{ name: 'ports', run: checkPorts },
	{ name: 'hostname', run: checkHostname },
	{ name: 'ca files', run: checkCaFiles },
	{ name: 'log topics', run: checkLogTopics },
	{ name: 'mqtt url', run: checkMqttUrl },
	{ name: 'mqtt creds', run: checkMqttCredentials },
	{ name: 'mqtt dns', run: checkDns },
	{ name: 'mqtt tcp', run: checkTcp },
	{ name: 'mqtt broker', run: checkMqttHandshake }
]

function emit(name: string, result: CheckResult) {
	const label = `[${result.status === 'ok' ? ' ok ' : result.status}] ${name.padEnd(NAME_COLUMN)}${result.message}`
	const lines = [ label, ...(result.hints ?? []).map((hint) => HINT_INDENT + '-> ' + hint) ]

	for(const line of lines)
		if(result.status === 'fail')
			error('preflight', line)
		else if(result.status === 'warn')
			warn('preflight', line)
		else
			info('preflight', line)
}

function plural(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? '' : 's'}`
}

// Runs every check, prints the banner and returns the counts. Never throws, never exits.
export async function runPreflight(config: Config, options: PreflightOptions = {}): Promise<PreflightReport> {
	const report: PreflightReport = { passed: 0, warnings: 0, failed: 0 }

	try {
		const partial = (config ?? {}) as Partial<Config>
		const ctx: Context = {
			config: partial,
			ha: (partial.homeassistant ?? {}) as Partial<HAConfig>,
			serversStarted: options.serversStarted === true
		}

		info('preflight', '--- rethink preflight ---')

		for(const check of CHECKS) {
			let results: CheckResult[]
			try {
				results = await withTimeout(
					Promise.resolve(check.run(ctx)),
					CHECK_BUDGET_MS,
					() => [ failure(`the "${check.name}" check did not finish within ${CHECK_BUDGET_MS / 1000}s`) ]
				)
			} catch(err) {
				results = [ failure(`the "${check.name}" check itself failed (${err})`) ]
			}

			for(const result of results) {
				if(result.status === 'fail')
					report.failed++
				else if(result.status === 'warn')
					report.warnings++
				else
					report.passed++

				emit(check.name, result)
			}
		}

		const summary = `--- preflight: ${report.failed} failed, ${plural(report.warnings, 'warning')}, ${report.passed} passed ---`
		if(report.failed > 0) {
			error('preflight', summary)
			error('preflight', 'rethink will keep running and retrying, but the Home Assistant integration will not work until the failures above are resolved.')
		} else if(report.warnings > 0) {
			warn('preflight', summary)
		} else {
			info('preflight', summary)
		}
	} catch(err) {
		// a broken preflight must never be the reason rethink fails to start
		error('preflight', 'the preflight checks could not be completed:', err)
	}

	return report
}

export default runPreflight
