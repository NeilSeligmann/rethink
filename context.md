# rethink - architectural overview

This file is the map of the repository. Read it before scanning the source.

`rethink` replaces LG's ThinQ cloud with a service you run on your own network. An LG appliance's
Wi-Fi module is pointed at this server instead of LG's, provisions itself against it over HTTPS,
then connects to the built-in MQTT broker and speaks LG's "CLIP" protocol. rethink decodes that
protocol per appliance model and republishes it as Home Assistant MQTT discovery entities on your
own broker (usually Mosquitto).

There are two MQTT sides and it is easy to confuse them:

- the **internal broker** rethink implements itself, which appliances connect to (ports
  `mqtt_port` and `mqtts_port`)
- the **external broker** rethink connects to as a client, which Home Assistant also uses
  (`homeassistant.mqtt_url`)

## Entry points

| Entry point | Invocation | Purpose |
| --- | --- | --- |
| `rethink/rethink-cloud.ts` | `npm run start` (built) or `npm run dev` (tsx) | The server. HTTPS provisioning, internal MQTT/MQTTS broker, device manager, Home Assistant bridge. |
| `rethink/preflight-cli.ts` | `npm run check` | Runs the startup checks on demand and exits non zero if any failed. Usable as a container healthcheck. |
| `rethink/rethink-setup.ts` | `tsx rethink-setup.ts host wifiname wifipass` | One-off tool run against an appliance in AP setup mode, to join it to Wi-Fi and point it at rethink instead of LG. |
| `rethink/experimental/bridge/bridge.ts` | `node dist/experimental/bridge/bridge.js ...` | Optional. Registers a rethink-provisioned device on LG's real cloud and forwards traffic both ways, so the official app keeps working. |
| `rethink/packet-parser.ts` | `tsx packet-parser.ts device-uuid` or `-message HEX` | Debug tool. Decodes TLV packets seen on the wire. |
| `rethink/packet-sender.ts` | `tsx packet-sender.ts device-uuid ...` | Debug tool. Injects a hand-built TLV packet to an appliance. |
| `entrypoint.sh` | container `ENTRYPOINT` | Writes `config.json` from `RETHINK_*` env vars, then starts the services chosen by `RETHINK_SERVER_MODE`. |

`rethink-cloud.ts` is an ES module using top-level `await`, which is why `tsconfig.json` targets
`es2022`.

## Module architecture

### Top level (deployment)

- **`Dockerfile`** - `node:trixie`, `WORKDIR /rethink`, copies `rethink/` in, runs `npm install` and
  `npm run build`, exposes 443, 4433, 8884 and 1884, entrypoint `/entrypoint.sh`.
- **`entrypoint.sh`** - reads every `RETHINK_*` variable, writes `/rethink/config.json`, symlinks
  everything under `/config` into `/rethink` so certificates and bridge state persist, starts the
  cloud service and/or the bridge services according to `RETHINK_SERVER_MODE`, waits for the CA to
  appear and copies `ca.cert`/`ca.key` into `/config`, then `exec tail -F /var/log/rethink/*.log`
  to keep the container alive and stream logs to `docker logs`.
- **`start-bridge-services.sh`** - tails `/var/log/rethink/cloud.log`, spots each new appliance from
  its `preDeploy` message (`"type":0`), and launches one `bridge.js` process per device that does
  not already have one. This is what makes `RETHINK_SERVER_MODE=both` bridge every device without
  naming them individually.
- **`docker-compose.yaml`** - one `rethink` service (`container_name: rethink`), all the
  `RETHINK_*` variables with comments, `./config:/config` volume, `tmpfs` for the log directory, and
  a healthcheck that only greps for the running process.
- **`appliance-simulator/`** - `simulator.cpp`, a standalone C program that imitates the UART
  responses of an air conditioner at 9600 baud so the LG Wi-Fi module can be activated and tested on
  the bench without an appliance attached. It reimplements the same CRC16/XMODEM used by
  `rethink/util/crc16.ts`.

### `rethink/cloud/` - the server core

- **`mqtt-broker.ts`** - a minimal MQTT broker written on top of `mqtt-connection`. Exports `Broker`
  and `Client`. `Broker.accept(stream)` wraps a raw `net.Socket` or `tls.TLSSocket`, and `Client`
  handles the wire protocol (CONNACK, PUBACK, SUBACK, PINGRESP), wildcard subscription matching,
  retained messages and the client's last will. `Broker.publish()` fans a message out to matching
  clients and emits `publish`, `connect` and `disconnect`.
- **`devmgr.ts`** - the CLIP protocol layer. `DeviceManager` listens to the broker's `publish`
  events, parses the JSON CLIP envelope on `clip/...` topics, answers `preDeploy`/`deploy` with the
  payload from `provisioning.ts`, and on `completeProvisioning_ack` creates a `Device` and emits
  `newDevice`. Steady-state `device_packet` messages are hex-decoded and emitted as `data` on the
  `Device`. `Device.send(buf)` publishes a `packet` command back to the appliance.
- **`ha_bridge.ts`** - default export `Bridge`, the glue between `DeviceManager` and the Home
  Assistant connection. Holds the **only** model registry in the codebase, the `deviceTypes` object
  keyed by the `kind` string the appliance reports (`RAC_056905_WW`, `WIN_056905_WW`,
  `2REF11EIDA__4`, `2RES1VE61NFA2`, `Y_V8_Y___W.B32QEUK`). An unknown `kind` is warned about and
  dropped. It wires each `Device`'s `data`/`close` to the model class, replays discovery when Home
  Assistant restarts, and routes `setProperty` from Home Assistant to the right device.
- **`homeassistant.ts`** - `Connection`, the MQTT client for the external broker. Publishes
  discovery configs and property values, subscribes to `<discovery_prefix>/status`,
  `<rethink_prefix>/+/+/set` and `<rethink_prefix>/+/availability`, and manages the two-level
  availability scheme described in the comment at the top of the file. It also owns all MQTT failure
  reporting: every failure event is registered, failures are diagnosed through
  `util/mqtt-diagnostics.ts`, and the reconnect loop is rate limited (full explanation on the first
  failure of an outage or when the cause changes, a reminder at most once every 60s, a loud
  escalation after 30s if the broker has never been reached, and a "connection restored" line on
  recovery). Per-attempt chatter goes to the `mqtt` log topic, which is off by default.
- **`provisioning.ts`** - `setupHttp(app, config, ca)` registers the HTTPS endpoints an appliance
  calls during onboarding, and `generateDeployResponse(payload)` builds the CLIP
  `completeProvisioning` reply used by `devmgr.ts`.

### `rethink/cloud/devices/` - per-model translation

- **`base.ts`** - default export `HADevice`, the abstract base. Static helpers `defaultConfig`,
  `componentConfig` and `deviceConfig` build the Home Assistant discovery fragments every model
  spreads into its own config. Subclasses must implement `query()`, `processData(buf)` and
  `setProperty(prop, value)`.
- **`tlv_device.ts`** - `TLVDevice`, base for appliances using LG's TLV framing (the air
  conditioners). `addField()` is a declarative field registry that generates the MQTT topics and
  holds the read/write transforms. `processData` validates the 11-byte header and CRC then publishes
  each decoded tag, `setProperty` builds and sends the write packet.
- **`aabb_device.ts`** - `AABBDevice`, base for appliances framed as `AA <len> ... <xor> BB` (the
  fridges and the washer). Adds a change-detecting `publishProperty` wrapper.
- **`fridge_common.ts`** - shared setpoint range and Celsius/Fahrenheit conversion helpers for the
  two fridge models.
- **`RAC_056905_WW.ts`** - LG DualCool wall-mounted air conditioner. Publishes a `climate` entity
  plus display `light` and an energy sensor.
- **`WIN_056905_WW.ts`** - LG window/portable air conditioner (LW1823HRSM). Same TLV tags, simpler
  mode set, `climate` only.
- **`2REF11EIDA__4.ts`** - LG fridge. Builds its config lazily once the first status packet reveals
  the temperature unit, then exposes fridge/freezer setpoints, a flex compartment select and a door
  sensor.
- **`2RES1VE61NFA2.ts`** - a second LG fridge with a different status layout, described by a named
  `STATUS_FIELDS` table rather than raw offsets, and extra express cool/freeze switches.
- **`Y_V8_Y___W.B32QEUK.ts`** - LG washer. Power switch, status and error sensors, an operation
  select and a remaining-time sensor. Starting a cycle is not implemented.

### `rethink/util/`

- **`clip.ts`** - the type definitions shared across the project. `Config` and `HAConfig` describe
  `config.json`, `CA` is the key/cert pair, `ClipMessage`, `DeployPayload` and `ClipDeployMessage`
  describe the CLIP wire format.
- **`logging.ts`** - the default export `log(topic, ...)` is filtered by the configured topic list.
  `info`, `warn` and `error` deliberately **bypass** the filter, because the filter is itself
  configuration and a bad filter must never hide the messages explaining why rethink is broken.
  `setFilter()` installs the filter.
- **`mqtt-diagnostics.ts`** - turns MQTT failures into something a user can act on, with no
  dependency on the rest of the project. `parseBrokerUrl` validates the broker url and returns a
  `safeUrl` with any inline credentials removed, `redactUrl` is the logging-safe form,
  `diagnoseMqttError` maps socket error codes and CONNACK reason codes to a summary plus hints,
  `diagnoseSilentClose` covers the case where the socket closes with no error at all, and
  `formatDiagnosis` renders a diagnosis as log lines. The lookup tables are `Map`s because their
  keys come from user configuration.
- **`preflight.ts`** - `runPreflight(config, options)`, ten checks over the configuration and the
  broker: config shape, ports, hostname, CA files, log topics, broker url, credentials, DNS, TCP
  reachability and a full MQTT handshake including a subscribe and a QoS 1 publish. It never throws
  and never exits, and it never prints the password, only `set` or `not set`. With
  `{ serversStarted: true }` the port check confirms rethink's own listeners are up instead of
  testing whether the ports are free.
- **`crc16.ts`** - CRC16/XMODEM, used by the TLV framing and duplicated in the simulator.
- **`tlv.ts`** - `parse` and `build` for LG's compact type-length-value encoding.
- **`json_splitter.ts`** - a byte-at-a-time splitter that finds complete top-level JSON values in a
  stream, used by `rethink-setup.ts`.
- **`util.ts`** - `allowExtendedType`, a generics helper to get around TypeScript's excess property
  check without losing type safety.

### `rethink/types/`

- **`mqtt-connection.d.ts`** - ambient declarations for the untyped `mqtt-connection` package, so
  the broker code is type checked. Picked up via `typeRoots` in `tsconfig.json`.

### `rethink/experimental/bridge/` - optional ThinQ cloud bridge

Standalone. `rethink-cloud.ts` does not import any of it, it runs as its own process.

- **`bridge.ts`** - CLI entry point taking the rethink MQTT url, country code, device type, model
  name and device id. Keeps per-device registration in `.bridge_${deviceId}.json`, performs an
  interactive OAuth2 login the first time (cached in `.oauth.json`), registers the device on LG's
  cloud, then forwards packets in both directions between rethink's internal broker and LG's.
- **`deviceConnection.ts`** - `Connection`, the MQTTS client to LG's broker using the device's
  issued certificate. Sends the synthetic `preDeploy` handshake a real appliance would send.
- **`oauth2.ts`** - LG account OAuth2, request signing, code exchange and token refresh.
- **`thinq2api.ts`** - the ThinQ2 REST client. `Client` (device list, add/remove, status) and
  `Device` (certificate pairing via `openssl`), plus LG's result code tables.
- **`util.ts`** - `subprocess()`, a small `spawn` wrapper used to shell out to `openssl`.

## Data flow

### Appliance to Home Assistant

1. The appliance connects to the internal broker over plain MQTT (`mqtt_port`) or MQTTS
   (`mqtts_port`, using the CA as the server certificate). `Broker.accept()` terminates it.
2. `DeviceManager` sees the broker's `publish` events, parses the CLIP JSON on `clip/...` topics and
   completes provisioning, creating a `Device` and emitting `newDevice`.
3. `Bridge` looks the reported `kind` up in `deviceTypes` and instantiates the matching model class,
   then pipes the `Device`'s `data` events into `processData()`.
4. The model class decodes its binary framing (TLV or `AA...BB`) and calls `HA.publishProperty()`.
5. `Connection` publishes to `<rethink_prefix>/<id>/<property>` on the external broker, having
   already published the discovery config to `<discovery_prefix>/<class>/rethink/<id>/config`.

### Home Assistant to appliance

Home Assistant publishes to `<rethink_prefix>/<id>/<property>/set`. `Connection.received()` emits
`setProperty`, `Bridge` routes it to the right model class, which builds the outbound TLV or AABB
buffer and calls `Device.send()`. That publishes a CLIP `packet` message on `lime/devices/<did>`,
which the internal broker delivers to the appliance.

### Provisioning over HTTPS

1. `rethink-setup.ts` is run once per appliance while it is in AP setup mode. It drives the module's
   local TLS protocol on port 5500 to set the Wi-Fi credentials and point the device at rethink.
2. The appliance then calls the HTTPS server on `https_port`, served by
   `https.createServer(ca, app)` with routes from `provisioning.ts`:
   - `GET /route` returns the API server and MQTT server addresses and ports to use.
   - `GET /route/certificate` lists the supported CAs, and with `?name=` returns the CA certificate.
   - `POST /device/:deviceId/certificate` signs the device's CSR with the local CA using
     `openssl x509 -req` and returns the certificate.
3. The appliance connects to the internal broker and the CLIP handshake above takes over.

The CA is loaded from `ca_key_file`/`ca_cert_file` at startup, or generated with `openssl req -x509`
if missing or if it does not cover `hostname`. Regenerating it invalidates every appliance already
paired against the old one.

## Configuration

One path, from environment to types:

```
RETHINK_* env vars  ->  entrypoint.sh  ->  /rethink/config.json  ->  Config in util/clip.ts
```

Outside Docker there is no `entrypoint.sh` and you edit `rethink/config.json` by hand. Both entry
points read `./config.json` relative to the working directory.

| Env var | config.json key | Default | Meaning |
| --- | --- | --- | --- |
| `RETHINK_HOSTNAME` | `hostname` | `rethink.lan` | DNS name appliances are redirected to. Not an IP, the CA is issued for this name. |
| `RETHINK_MQTT_URL` | `homeassistant.mqtt_url` | `mqtt://localhost:1883` | The external broker Home Assistant uses. |
| `RETHINK_DISCOVERY_PREFIX` | `homeassistant.discovery_prefix` | `homeassistant` | Home Assistant's MQTT discovery prefix. |
| `RETHINK_PREFIX` | `homeassistant.rethink_prefix` | `rethink` | Prefix for rethink's own state and command topics. |
| `RETHINK_MQTT_USER` | `homeassistant.mqtt_user` | `user` | External broker username. Empty means anonymous. |
| `RETHINK_MQTT_PASS` | `homeassistant.mqtt_pass` | `pass` | External broker password. Never logged, only reported as `set` or `not set`. |
| `RETHINK_CA_KEY_FILE` | `ca_key_file` | `ca.key` | CA private key, generated on first boot if absent. |
| `RETHINK_CA_CERT_FILE` | `ca_cert_file` | `ca.cert` | CA certificate, also the TLS server certificate. |
| `RETHINK_HTTPS_PORT` | `https_port` | `4433` | Provisioning HTTPS port. |
| `RETHINK_MQTTS_PORT` | `mqtts_port` | `8884` | Internal broker, TLS. |
| `RETHINK_MQTT_PORT` | `mqtt_port` | `1884` | Internal broker, plaintext. |
| `RETHINK_LOG` | `log` | `["status","incoming"]` | JSON array of log topics. Must be valid JSON. |
| `RETHINK_SERVER_MODE` | not in config.json | `both` | `cloud`, `bridge` or `both`. |
| `RETHINK_DEVICE_ID`, `RETHINK_COUNTRY_CODE`, `RETHINK_MODEL_NAME`, `RETHINK_DEVICE_TYPE` | not in config.json | see `entrypoint.sh` | Only used by the experimental bridge in `bridge` mode. |

`Config` also has an optional `mqtt?: boolean`. Setting it to `false` skips the internal broker
listeners entirely, which is only useful when something else terminates the appliance connections.

Log topics in use anywhere in the codebase are `status`, `incoming`, `publish`, `HTTPS`, `mqtt` and
the catch-all `all`. The `mqtt` topic carries per-reconnect-attempt tracing and is off by default.
Messages emitted through `info`, `warn` and `error` ignore the filter entirely, so failures are
always visible. See `docs/mqtt-troubleshooting.md`.

## Dependencies

Runtime: `express` for the provisioning HTTPS server, `mqtt` as the client for the external broker,
`mqtt-connection` for the internal broker's wire protocol, `node-fetch` for the experimental bridge.
Build: `typescript` (`npm run build` runs plain `tsc` into `dist/`), `tsx` for running TypeScript
directly in development. Node 16 or 20 and up. `openssl` must be on `PATH`, it is shelled out to for
CA generation, CSR signing and the bridge's certificate pairing.

## Things that are easy to get wrong

- Lookup tables keyed by values from configuration or from the wire must be a `Map`. A plain object
  resolves keys like `constructor` and `toString` off the prototype and silently returns nonsense.
  This applies to the log filter in `rethink-cloud.ts` and to the tables in `mqtt-diagnostics.ts`.
- `mqtt.connect()` attaches its own no-op `error` listener, so any code creating a client must
  register its own `error` handler or every failure is swallowed.
- `dist/` is gitignored. `npm run start` and `npm run check` both run built output, so run
  `npm run build` after changing any `.ts` file.
- Preflight runs last in `rethink-cloud.ts`, after the listeners are up, so slow network checks
  cannot delay CA generation or appliance connections.
