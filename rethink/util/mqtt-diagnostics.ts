// Shared helpers for turning MQTT failures into messages a user can act on.
//
// Background: `mqtt.connect()` attaches its own no-op 'error' listener to the client it returns
// (mqtt 5.3.0, node_modules/mqtt/build/lib/connect/index.js line 130), so every connection
// failure - DNS, refused, TLS mismatch, bad credentials - is swallowed unless we register our
// own listener. Without one the only symptom is an endless "connection lost" loop that says
// nothing about the cause.

export type BrokerUrl = {
	// the url with any inline credentials removed, safe to print
	safeUrl: string
	protocol: string
	host: string
	port: number
	secure: boolean
	websocket: boolean
	// true when credentials were embedded in the url itself
	inlineCredentials: boolean
}

// Keyed by a string taken from user configuration, so a Map is required: a plain object would
// resolve 'constructor' or 'toString' off Object.prototype and report a bogus default port.
const DEFAULT_PORTS = new Map<string, number>([
	['mqtt', 1883],
	['tcp', 1883],
	['mqtts', 8883],
	['mqtt+ssl', 8883],
	['ssl', 8883],
	['tls', 8883],
	['ws', 80],
	['wss', 443],
])

const SECURE_PROTOCOLS = new Set(['mqtts', 'mqtt+ssl', 'ssl', 'tls', 'wss'])
const WEBSOCKET_PROTOCOLS = new Set(['ws', 'wss'])

export const SUPPORTED_PROTOCOLS = Array.from(DEFAULT_PORTS.keys())

export class BrokerUrlError extends Error {
	constructor(message: string, readonly hints: string[] = []) {
		super(message)
		this.name = 'BrokerUrlError'
	}
}

// Parses an mqtt broker url the same way the mqtt module does, but fails with an explanation
// instead of a stack trace. Never returns the password.
export function parseBrokerUrl(raw: string): BrokerUrl {
	if(typeof(raw) !== 'string' || raw.trim() === '')
		throw new BrokerUrlError('the broker url is empty', [
			'Set RETHINK_MQTT_URL, for example RETHINK_MQTT_URL="mqtt://192.168.1.10:1883"'
		])

	const url = raw.trim()

	if(!/^[a-z0-9+]+:\/\//i.test(url))
		throw new BrokerUrlError(`"${url}" has no protocol`, [
			`Prefix the address with a protocol, for example "mqtt://${url}"`,
			`Supported protocols: ${SUPPORTED_PROTOCOLS.join(', ')}`
		])

	// new URL() rejects an out of range port with a bare "Invalid URL", which tells the user
	// nothing, so name the real problem first.
	const portMatch = url.match(/:(\d+)(\/|$)/)
	if(portMatch && Number(portMatch[1]) > 65535)
		throw new BrokerUrlError(`port ${portMatch[1]} in "${url}" is out of range`, [
			'The port must be an integer between 1 and 65535'
		])

	let parsed: URL
	try {
		parsed = new URL(url)
	} catch(err) {
		throw new BrokerUrlError(`"${url}" is not a valid url (${err})`, [
			'Expected the form protocol://host:port, for example "mqtt://192.168.1.10:1883"'
		])
	}

	const protocol = parsed.protocol.replace(/:$/, '').toLowerCase()
	if(!DEFAULT_PORTS.has(protocol))
		throw new BrokerUrlError(`protocol "${protocol}" is not supported by the mqtt client`, [
			`Supported protocols: ${SUPPORTED_PROTOCOLS.join(', ')}`,
			'Home Assistant\'s own port (8123) is not an MQTT broker. Point this at the broker, usually Mosquitto on port 1883'
		])

	if(!parsed.hostname)
		throw new BrokerUrlError(`"${url}" contains no hostname`, [
			'Expected the form protocol://host:port, for example "mqtt://192.168.1.10:1883"'
		])

	const inlineCredentials = parsed.username !== '' || parsed.password !== ''
	const port = parsed.port ? Number(parsed.port) : DEFAULT_PORTS.get(protocol)

	if(!Number.isInteger(port) || port < 1 || port > 65535)
		throw new BrokerUrlError(`"${parsed.port}" is not a valid port number`, [
			'The port must be an integer between 1 and 65535'
		])

	const hostPart = parsed.hostname.includes(':') ? `[${parsed.hostname}]` : parsed.hostname

	return {
		safeUrl: `${protocol}://${hostPart}:${port}${parsed.pathname === '/' ? '' : parsed.pathname}`,
		protocol,
		host: parsed.hostname,
		port,
		secure: SECURE_PROTOCOLS.has(protocol),
		websocket: WEBSOCKET_PROTOCOLS.has(protocol),
		inlineCredentials,
	}
}

// Strips credentials from a url for logging. Falls back to a placeholder if it cannot be parsed,
// so a malformed url carrying a password can never be echoed verbatim.
export function redactUrl(raw: string): string {
	try {
		return parseBrokerUrl(raw).safeUrl
	} catch(err) {
		return typeof(raw) === 'string' ? raw.replace(/\/\/[^@/]*@/, '//<credentials>@') : String(raw)
	}
}

export type Diagnosis = {
	// one line naming what went wrong
	summary: string
	// things the user can check, most likely first
	hints: string[]
	// false for transient conditions that a reconnect may well fix on its own
	fatal: boolean
}

// MQTT 3.1.1 CONNACK return codes (mqtt v3 brokers report these)
const CONNACK_V3 = new Map<number, string>([
	[1, 'the broker refused the protocol version'],
	[2, 'the broker rejected the client id'],
	[3, 'the broker is unavailable'],
	[4, 'the broker rejected the username or password'],
	[5, 'the broker refused authorisation for this client'],
])

// MQTT 5 CONNACK reason codes, only the ones a misconfiguration realistically produces
const CONNACK_V5 = new Map<number, string>([
	[128, 'the broker refused the connection (unspecified error)'],
	[129, 'the broker could not parse our CONNECT packet'],
	[130, 'the broker reported a protocol error'],
	[131, 'the broker rejected something in our CONNECT packet'],
	[132, 'the broker does not support this MQTT protocol version'],
	[133, 'the broker rejected the client id'],
	[134, 'the broker rejected the username or password'],
	[135, 'the broker refused authorisation for this client'],
	[136, 'the broker is not available'],
	[137, 'the broker is busy'],
	[138, 'this client has been banned by the broker'],
	[140, 'the broker rejected the authentication method'],
	[144, 'the broker rejected the topic name'],
	[149, 'our packet was larger than the broker accepts'],
	[151, 'the broker applied a quota limit'],
	[153, 'the payload format was rejected'],
	[154, 'the broker does not allow retained messages'],
	[155, 'the broker does not support the requested QoS'],
	[159, 'the broker applied a connection rate limit'],
])

const CREDENTIAL_HINTS = [
	'Check RETHINK_MQTT_USER and RETHINK_MQTT_PASS against the broker\'s user list',
	'For Mosquitto, confirm the user exists in the password file and restart the broker after editing it',
	'Mosquitto reports the same "not authorized" for a wrong password and for no credentials at all when allow_anonymous is false, so check that a username is configured',
	'If the broker allows anonymous connections, it may still reject a username it does not know'
]

const TLS_MISMATCH_HINTS = [
	'The broker appears to expect TLS. Use mqtts:// (default port 8883) instead of mqtt://',
	'Conversely, if the broker is plaintext, use mqtt:// on port 1883'
]

// Turns any error thrown or emitted by the mqtt client into something actionable.
export function diagnoseMqttError(err: any, broker?: BrokerUrl): Diagnosis {
	const message = err?.message ?? String(err)
	const code = err?.code

	// mqtt's ErrorWithReasonCode carries a numeric code, socket errors carry a string one
	if(typeof(code) === 'number') {
		const explanation = CONNACK_V5.get(code) ?? CONNACK_V3.get(code)
		const isAuth = code === 4 || code === 5 || code === 134 || code === 135
		return {
			summary: `the broker refused the connection: ${explanation ?? message} (reason code ${code})`,
			hints: isAuth ? CREDENTIAL_HINTS : [
				'The connection reached the broker, so the address and port are correct',
				'Check the broker\'s own log for the matching rejection'
			],
			fatal: true
		}
	}

	switch(code) {
		case 'ENOTFOUND':
		case 'EAI_AGAIN':
			return {
				summary: `the hostname "${broker?.host ?? 'broker'}" could not be resolved by DNS`,
				hints: [
					'Container DNS often differs from the host\'s. A name that resolves on your server may not resolve inside the container',
					'Use the broker\'s IP address in RETHINK_MQTT_URL to rule DNS out',
					'If the broker is another container, use its service name and make sure both are on the same docker network'
				],
				fatal: true
			}

		case 'ECONNREFUSED':
			return {
				summary: `nothing is listening on ${broker?.host}:${broker?.port}`,
				hints: [
					'The host was reachable but refused the connection, so the port is almost certainly wrong or the broker is not running',
					'"localhost" inside a container means the container itself, not your server. Use the server\'s IP or hostname',
					'Confirm the broker is listening on all interfaces rather than only 127.0.0.1'
				],
				fatal: true
			}

		case 'ETIMEDOUT':
		case 'ERR_SOCKET_CONNECTION_TIMEOUT':
			return {
				summary: `the connection to ${broker?.host}:${broker?.port} timed out`,
				hints: [
					'A firewall is the usual cause: packets are being dropped rather than refused',
					'Check that the broker\'s port is open to the container\'s network'
				],
				fatal: false
			}

		case 'EHOSTUNREACH':
		case 'ENETUNREACH':
			return {
				summary: `there is no network route to ${broker?.host}`,
				hints: [
					'Check the container\'s network mode and that the broker is on a reachable subnet'
				],
				fatal: true
			}

		case 'ECONNRESET':
			// Verified against mosquitto 2.1: pointing mqtts:// at a plaintext listener reports
			// ECONNRESET during the handshake rather than a TLS specific code.
			if(broker?.secure || /secure TLS connection/i.test(message))
				return {
					summary: `the broker at ${broker?.host}:${broker?.port} closed the connection during the TLS handshake, so it is probably not a TLS listener`,
					hints: [
						`Use mqtt://${broker?.host}:${broker?.port} if that port is a plaintext listener`,
						'A TLS listener is usually on port 8883, a plaintext one on 1883'
					],
					fatal: true
				}

			return {
				summary: 'the broker closed the connection unexpectedly',
				hints: [
					...TLS_MISMATCH_HINTS,
					'Some brokers close the socket instead of sending a proper rejection when credentials are wrong'
				],
				fatal: false
			}

		case 'EPIPE':
			return {
				summary: 'the connection was closed while we were writing to it',
				hints: ['The broker may be restarting or dropping idle clients'],
				fatal: false
			}

		case 'EACCES':
			return {
				summary: 'the operating system denied the connection',
				hints: ['Check container capabilities and any local firewall rules'],
				fatal: true
			}

		case 'EPROTO':
		case 'ERR_SSL_WRONG_VERSION_NUMBER':
		case 'ERR_SSL_PACKET_LENGTH_TOO_LONG':
			return {
				summary: 'the TLS handshake failed because the broker is not speaking TLS on this port',
				hints: TLS_MISMATCH_HINTS,
				fatal: true
			}

		case 'DEPTH_ZERO_SELF_SIGNED_CERT':
		case 'SELF_SIGNED_CERT_IN_CHAIN':
		case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
			return {
				summary: 'the broker\'s TLS certificate could not be verified',
				hints: [
					'The broker is using a self signed certificate',
					'Either install the broker\'s CA certificate or use a plaintext mqtt:// connection on the local network'
				],
				fatal: true
			}

		case 'CERT_HAS_EXPIRED':
			return {
				summary: 'the broker\'s TLS certificate has expired',
				hints: ['Renew the certificate on the broker'],
				fatal: true
			}

		case 'ERR_TLS_CERT_ALTNAME_INVALID':
			return {
				summary: 'the broker\'s TLS certificate does not cover the hostname we connected to',
				hints: [`Use the hostname the certificate was issued for, or connect by that name instead of "${broker?.host}"`],
				fatal: true
			}
	}

	if(/connack timeout/i.test(message))
		return {
			summary: 'the broker accepted the TCP connection but never answered our CONNECT packet',
			hints: [
				...TLS_MISMATCH_HINTS,
				'The port may belong to a different service that is not an MQTT broker',
				'Some brokers stay silent instead of rejecting when authentication fails'
			],
			fatal: false
		}

	// Verified by pointing the client at an HTTP server: the reply fails to parse as MQTT and
	// surfaces as a packet parser error with no code at all.
	if(/header flag bits|unrecognized packet type|cannot parse|invalid protocol|protocol error/i.test(message))
		return {
			summary: `the service on ${broker?.host}:${broker?.port} replied with something that is not MQTT (${message})`,
			hints: [
				'That port almost certainly belongs to a different service. Home Assistant itself (8123) and web UIs are common mistakes',
				'Point RETHINK_MQTT_URL at the broker, usually Mosquitto on port 1883',
				...TLS_MISMATCH_HINTS
			],
			fatal: true
		}

	if(/keepalive timeout/i.test(message))
		return {
			summary: 'the broker stopped responding to keepalive pings',
			hints: ['The broker or the network between us dropped out. We will keep retrying'],
			fatal: false
		}

	return {
		summary: message,
		hints: [],
		fatal: false
	}
}

// The nastiest case, and the one that produces the user visible "connection lost" loop: the
// socket closes with no error event at all. Verified by pointing a plaintext client at a TLS
// listener, where the peer drops the connection before the handshake and the connack timer is
// cleared by the close, so nothing is ever emitted.
export function diagnoseSilentClose(broker?: BrokerUrl, everConnected = false): Diagnosis {
	if(everConnected)
		return {
			summary: `the connection to ${broker?.host}:${broker?.port} was closed`,
			hints: [
				'The broker restarted, the network dropped, or another client connected using the same client id',
				'Check the broker\'s log around this time'
			],
			fatal: false
		}

	return {
		summary: `${broker?.host}:${broker?.port} accepted the TCP connection then closed it without answering, so the MQTT handshake never completed`,
		hints: [
			broker?.secure
				? 'Confirm that port really is a TLS listener, and try mqtt:// on port 1883 if it is not'
				: 'A plaintext client against a TLS listener is dropped exactly like this. Try mqtts:// (usually port 8883)',
			'Some brokers drop a client that fails authentication instead of rejecting it properly, so check the username and password',
			'The port may belong to a service that is not an MQTT broker at all',
			'The broker\'s own log will normally say why it closed the connection'
		],
		fatal: false
	}
}

// Renders a diagnosis as lines ready to hand to the log functions.
export function formatDiagnosis(diagnosis: Diagnosis): string[] {
	return [diagnosis.summary, ...diagnosis.hints.map((hint) => '  -> ' + hint)]
}
