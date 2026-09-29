import * as mqtt from 'mqtt'
import { randomBytes } from 'node:crypto'
import EventEmitter from 'node:events'
import { HAConfig } from '../util/clip.js'
import log, { error, info, warn } from '../util/logging.js'
import { BrokerUrl, BrokerUrlError, Diagnosis, diagnoseMqttError, diagnoseSilentClose, formatDiagnosis, parseBrokerUrl } from '../util/mqtt-diagnostics.js'

// Notes on availability topic handling:
// 1. We want HA to be able to tell if a device is available.
// 2. When rethink stops, all devices should turn "offline"
// 3. But we can register only a single LWT topic at the MQTT broker
// 4. We define two availability topics. One per-device, the other - global
// 5. In a previous attempt, we had used availablility_mode: latest, and published all availability
// 	  messages with retain=off. This had one flaw: if HA was not already subscribed to the per-device
//    topic, it would miss the message and display the device as "offline" until it reconnected.
// 6. If we publish the per-device availability message with retain=true, then HA will received it
//    once it subscribes. It will also mean that these messages can survive from one `rethink` run
//	  to another. This would cause these "phatom" devices to appear "online" as soon as the new
//	  `rethink` instance starts.
// 7. To solve this, we subscribe to the availability topics and clean up all the retained "online"
// 	  messages on startup.

const KEEPALIVE = 60
const CONNECT_TIMEOUT = 10000
// the mqtt module defaults to 1s, which turns an unreachable broker into an unreadable log
const RECONNECT_PERIOD = 5000
// how often we are allowed to repeat ourselves while nothing about the failure has changed
const REMINDER_INTERVAL = 60000
// how long we give the very first connection before declaring the broker unreachable
const NEVER_CONNECTED_TIMEOUT = 30000
// a "granted" qos of 128 is a refusal, normally the broker's access control list
const SUBSCRIPTION_DENIED = 128

// renders a millisecond span as "3m 20s", dropping the minutes below a minute
function formatDuration(ms: number) {
	const total = Math.max(0, Math.round(ms / 1000))
	const minutes = Math.floor(total / 60)
	const seconds = total % 60
	return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

// transient conditions go out as warnings, anything a retry cannot fix goes out as an error
function reportLines(diagnosis: Diagnosis, lines: string[]) {
	const emit = diagnosis.fatal ? error : warn
	for(const line of lines)
		emit('mqtt', line)
}

function recursiveReplace(obj: unknown, replacements: Record<string, string>) {
	if(Array.isArray(obj)) {
		return obj.map((v) => recursiveReplace(v, replacements))

	} else if(typeof(obj) === 'object') {
		const rv = {}
		for(let k in obj) {
			rv[k] = recursiveReplace(obj[k], replacements)
		}
		return rv

	} else if(typeof(obj) === 'string') {
		let str: string = obj
		for(let pattern in replacements) {
			str = str.replaceAll(pattern, replacements[pattern])
		}
		return str

	} else
		return obj
}

export class Connection extends EventEmitter {
	client: mqtt.MqttClient

	// the parsed broker address, kept so failures can name what we were actually trying to reach
	readonly broker: BrokerUrl

	// record for which devices we have published the availability topic during this connection
	readonly publishedAvailability = new Set<string>();

	// connection health, used to keep the failure log informative instead of endless
	connectAttempts = 1
	consecutiveFailures = 0
	// timestamp the current outage started, 0 while the connection is up
	downSince = Date.now()
	hasEverConnected = false
	lastError: Diagnosis = null

	// per-attempt state, reset on every reconnect. Dropping a plaintext client onto a TLS listener
	// emits no 'error' at all, only 'close', so the close handler cannot rely on lastError.
	errorThisAttempt = false
	reportedThisAttempt = false

	lastReminder = 0
	queuedWhileOffline = 0
	lastQueueWarning = 0
	neverConnectedTimer: NodeJS.Timeout = null

	constructor(readonly config: HAConfig) {
		super()

		try {
			this.broker = parseBrokerUrl(config.mqtt_url)
		} catch(err) {
			if(err instanceof BrokerUrlError) {
				error('mqtt', `cannot use the configured broker url: ${err.message}`)
				for(const hint of err.hints)
					error('mqtt', '  -> ' + hint)
			}
			throw err
		}

		const clientId = 'rethink_' + randomBytes(4).toString('hex')
		// empty rather than absent is the common misconfiguration, and handing a broker a blank
		// username makes it reject a connection it would have accepted anonymously
		const username = config.mqtt_user || undefined
		const password = config.mqtt_pass || undefined

		info('mqtt', 'Home Assistant MQTT configuration:')
		info('mqtt', `  broker:           ${this.broker.safeUrl}`)
		info('mqtt', `  protocol:         ${this.broker.protocol}`)
		info('mqtt', `  host:             ${this.broker.host}`)
		info('mqtt', `  port:             ${this.broker.port}`)
		info('mqtt', `  tls:              ${this.broker.secure ? 'yes' : 'no'}`)
		info('mqtt', `  client id:        ${clientId}`)
		info('mqtt', `  username:         ${username ?? '<anonymous>'}`)
		// only ever report whether a password exists, never any part of its value
		info('mqtt', `  password:         ${password ? 'set' : 'not set'}`)
		info('mqtt', `  keepalive:        ${KEEPALIVE}s`)
		info('mqtt', `  connect timeout:  ${CONNECT_TIMEOUT / 1000}s`)
		info('mqtt', `  reconnect period: ${RECONNECT_PERIOD / 1000}s`)
		info('mqtt', `  discovery prefix: ${config.discovery_prefix}`)
		info('mqtt', `  rethink prefix:   ${config.rethink_prefix}`)

		if(this.broker.inlineCredentials)
			warn('mqtt', 'the broker url carries inline credentials, which take precedence over RETHINK_MQTT_USER and RETHINK_MQTT_PASS')

		if(username && !password)
			warn('mqtt', `a username ("${username}") is configured but RETHINK_MQTT_PASS is empty, most brokers refuse that combination`)

		// reconnectOnConnackError postdates the pinned mqtt 5.3, whose connack handler already keeps
		// retrying after a rejection. package.json allows ^5.3.0 though, and from 5.4 onwards a
		// CONNACK rejection ends the client unless this is set, which would make an auth failure go
		// quiet after a single attempt. Declared rather than assigned by key so it stays type checked.
		const options: mqtt.IClientOptions & { reconnectOnConnackError?: boolean } = {
			will: {
				topic: config.rethink_prefix + '/availability',
				payload: Buffer.from('offline'),
				retain: true,
			},
			clientId,
			username,
			password,
			protocolVersion: 4,
			keepalive: KEEPALIVE,
			connectTimeout: CONNECT_TIMEOUT,
			reconnectPeriod: RECONNECT_PERIOD,
			reconnectOnConnackError: true,
		}

		// mqtt module has builtin reconnection support
		this.client = mqtt.connect(this.config.mqtt_url, options)
		this.client.on('connect', this.connected.bind(this))
		this.client.on('close', this.disconnected.bind(this))
		this.client.on('message', this.received.bind(this))
		// mqtt.connect() attaches its own no-op 'error' listener, so without these handlers every
		// connection failure is swallowed and the only symptom is the "connection lost" loop
		this.client.on('error', this.failed.bind(this))
		this.client.on('offline', this.wentOffline.bind(this))
		this.client.on('reconnect', this.retrying.bind(this))
		this.client.on('disconnect', this.brokerDisconnect.bind(this))
		this.client.on('end', this.ended.bind(this))

		// unref'd so a broker we can never reach cannot hold the process open on its own
		this.neverConnectedTimer = setTimeout(this.reportNeverConnected.bind(this), NEVER_CONNECTED_TIMEOUT)
		this.neverConnectedTimer.unref()
	}

	// remembers when the current outage began, so the reminder can say how long it has lasted
	markDown() {
		if(this.downSince === 0)
			this.downSince = Date.now()
	}

	// The single place that decides how loud a failure gets. The first failure of an outage and any
	// change of cause are printed in full, everything after that is a reminder once a minute.
	reportCondition(diagnosis: Diagnosis) {
		this.markDown()

		// one attempt usually reports itself twice, as an 'error' and then its 'close'
		if(this.reportedThisAttempt && this.lastError?.summary === diagnosis.summary)
			return

		const changed = this.lastError?.summary !== diagnosis.summary
		const first = this.consecutiveFailures === 0
		this.lastError = diagnosis
		this.reportedThisAttempt = true
		this.consecutiveFailures++

		if(changed || first) {
			reportLines(diagnosis, formatDiagnosis(diagnosis))
			this.lastReminder = Date.now()
			return
		}

		const now = Date.now()
		if(now - this.lastReminder < REMINDER_INTERVAL)
			return

		this.lastReminder = now
		reportLines(diagnosis, [
			`still disconnected after ${this.connectAttempts} attempts over ${formatDuration(now - this.downSince)}, last error: ${diagnosis.summary}`,
			...diagnosis.hints.map((hint) => '  -> ' + hint)
		])
	}

	failed(err: Error) {
		this.errorThisAttempt = true
		this.reportCondition(diagnoseMqttError(err, this.broker))
	}

	reportNeverConnected() {
		this.neverConnectedTimer = null
		if(this.hasEverConnected)
			return

		error('mqtt', `rethink has never reached the MQTT broker at ${this.broker.safeUrl} since startup (${this.connectAttempts} attempts)`)
		error('mqtt', 'no devices will appear in Home Assistant until this connection succeeds')
		if(this.lastError) {
			error('mqtt', `last error: ${this.lastError.summary}`)
			for(const hint of this.lastError.hints)
				error('mqtt', '  -> ' + hint)
		}
		error('mqtt', '  -> the broker address comes from RETHINK_MQTT_URL')
	}

	wentOffline() {
		// per-attempt chatter, see retrying()
		log('mqtt', 'HA mqtt client went offline')
	}

	retrying() {
		this.connectAttempts++
		this.errorThisAttempt = false
		this.reportedThisAttempt = false
		// Once an outage is explained, a line per attempt adds nothing but volume, and a reconnect
		// every 5s buries the explanation above it. Demoted to the "mqtt" topic, which is off unless
		// RETHINK_LOG asks for it. The 60s reminder is what keeps a long outage visible.
		log('mqtt', `HA mqtt reconnecting, attempt ${this.connectAttempts}`)
	}

	// MQTT5 only, so it stays silent while we speak protocol version 4. The broker uses it to say
	// why it is dropping us, which is otherwise indistinguishable from the network failing.
	brokerDisconnect(packet: mqtt.IDisconnectPacket) {
		const reason = packet?.properties?.reasonString
		warn('mqtt', `the broker closed the connection, reason code ${packet?.reasonCode ?? 'unknown'}${reason ? ': ' + reason : ''}`)
	}

	ended() {
		warn('mqtt', 'the mqtt client has shut down and will not reconnect')
	}

	// wraps subscribe so a rejection is reported instead of silently dropping our subscription
	subscribeChecked(topic: string) {
		this.client.subscribe(topic, (err, granted) => {
			if(err) {
				error('mqtt', `failed to subscribe to ${topic}: ${err.message}`)
				return
			}

			for(const grant of granted ?? [])
				if(grant.qos === SUBSCRIPTION_DENIED)
					warn('mqtt', `the broker refused our subscription to ${grant.topic}, check its access control list for this user`)
		})
	}

	// wraps publish so a rejected message is reported. Never throws: a failed property update must
	// not take down the device handler that produced it.
	publishChecked(topic: string, payload: string | Buffer, options?: mqtt.IClientPublishOptions) {
		this.noteOfflinePublish()
		this.client.publish(topic, payload, options ?? {}, (err) => {
			if(err)
				error('mqtt', `failed to publish to ${topic}: ${err.message}`)
		})
	}

	// mqtt queues messages while the broker is unreachable. Summarise that once a minute rather
	// than once per message, or a handful of chatty devices bury the reason for the outage.
	noteOfflinePublish() {
		if(this.client.connected)
			return

		this.queuedWhileOffline++
		const now = Date.now()
		if(now - this.lastQueueWarning < REMINDER_INTERVAL)
			return

		this.lastQueueWarning = now
		warn('mqtt', `${this.queuedWhileOffline} message(s) queued while the broker is unreachable, Home Assistant will not see them until the connection returns`)
	}

	connected() {
		this.publishedAvailability.clear();

		if(this.consecutiveFailures > 0 || this.connectAttempts > 1)
			info('mqtt', `connection restored after ${this.connectAttempts} attempts, down for ${formatDuration(Date.now() - this.downSince)}`)

		log('status', 'HA mqtt connection established')

		this.hasEverConnected = true
		this.connectAttempts = 0
		this.consecutiveFailures = 0
		this.lastError = null
		this.errorThisAttempt = false
		this.reportedThisAttempt = false
		this.lastReminder = 0
		this.queuedWhileOffline = 0
		this.lastQueueWarning = 0
		this.downSince = 0

		if(this.neverConnectedTimer) {
			clearTimeout(this.neverConnectedTimer)
			this.neverConnectedTimer = null
		}

		// homeassistant/status
		this.subscribeChecked(this.config.discovery_prefix + '/status')
		// rethink/ID/PROPERTY/set
		this.subscribeChecked(this.config.rethink_prefix + '/+/+/set')

		this.subscribeChecked(this.config.rethink_prefix + '/+/availability')
		this.publishChecked(this.config.rethink_prefix + '/availability', Buffer.from('online'), { retain: true })

		this.emit('discovery')
	}

	disconnected() {
		// Only the close that starts an outage is news. Every later one during the same outage is
		// the reconnect loop repeating itself, which is the noise this whole change exists to remove.
		const firstOfOutage = this.consecutiveFailures === 0
		log(firstOfOutage ? 'status' : 'mqtt', 'HA mqtt connection lost')

		// a close we asked for is not a fault
		if(this.client?.disconnecting)
			return

		// A peer that drops the socket before the handshake clears the connack timer, so neither
		// 'error' nor a connack timeout ever fires and this is the only notice we get. Explain the
		// close ourselves rather than leaving a bare "connection lost" with no cause.
		this.reportCondition(this.errorThisAttempt && this.lastError
			? this.lastError
			: diagnoseSilentClose(this.broker, this.hasEverConnected))
	}

	received(topic: string, message: Buffer, packet) {
		try {
			if(topic === this.config.discovery_prefix + '/status' && message.toString('utf-8') === 'online') {
				log('status', 'HA online, starting discovery process')
				this.emit('discovery')
			}

			if(topic.startsWith(this.config.rethink_prefix + '/')) {
				const pathelements = topic.substring(this.config.rethink_prefix.length + 1).split('/')
				// rethink/+/+/set
				if(pathelements.length === 3 && pathelements[2] === 'set') {
					const [id, prop] = pathelements
					this.emit('setProperty', id, prop, message.toString('utf-8'))
				}

				// rethink/+/availability
				// only for retained deliveries. Packets delivered in real-time will not be caught by this
				if(pathelements.length === 2 && pathelements[1] === 'availability' && message.toString('utf-8') === 'online' && packet.retain) {
					// clear any retained availability topic, but only if we hadn't published a message on that topic yet
					if(!this.publishedAvailability.has(pathelements[0]))
						this.publishChecked(topic, 'offline', { retain: true })
				}
			}

		} catch(err) {
			error('mqtt', `error processing MQTT packet on topic ${topic}: ${err}`)
		}
	}

	publishConfig(id: string, haClass: string, config: Config) {
		const discoveryTopic = `${this.config.discovery_prefix}/${haClass}/rethink/${id}`
		const deviceTopic = `${this.config.rethink_prefix}/${id}`
		const replacements = {
			'$this': deviceTopic,
			'$rethink': this.config.rethink_prefix,
			'$deviceid': id
		}
		const configPayload = JSON.stringify(recursiveReplace(config, replacements))
		this.publishChecked(discoveryTopic + '/config' , configPayload)
	}

	publishProperty(id: string, property: string, value: string | number, options?: mqtt.IClientPublishOptions) {
		if(!options)
			options = {retain:true} // FIXME?

		if(typeof(value) === 'number')
			value = value.toString()

		const deviceTopic = `${this.config.rethink_prefix}/${id}`
		if(property === 'availability')
			this.publishedAvailability.add(id)

		log('publish', id, property, value)
		this.publishChecked(deviceTopic + '/' + property, value, options)
	}
}

export type DeviceInfo = {
	identifiers: string | string[];
	manufacturer?: string
	model?: string
	sw_version?: string
	name?: string
}

export type OriginInfo = {
	name: string,
	support_url?: string,
	sw_version?: string
}

export type AvailabilityInfo = {
	topic: string
}

export type ComponentInfo = {
	name?: string
	platform: string
	unique_id: string
}

export type DeviceDiscovery = {
	device: DeviceInfo,
	origin: OriginInfo,
	availability?: AvailabilityInfo[]
	components: Record<string, ComponentInfo>
}

export type ComponentDiscovery = {
	device: DeviceInfo,
	origin: OriginInfo,
	availability?: AvailabilityInfo[]
	name?: string
	unique_id: string
	object_id?: string
	optimistic?: boolean
}

export type Config = DeviceDiscovery | ComponentDiscovery