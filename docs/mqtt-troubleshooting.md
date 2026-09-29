# MQTT troubleshooting

Your appliances are not showing up in Home Assistant. Almost always that means rethink cannot talk
to your MQTT broker, and until this release the only symptom was `HA mqtt connection lost` repeating
once a second with no reason attached.

rethink now checks its own configuration and actually reaches out to the broker at startup, and
prints a banner saying what worked and what did not. Start there.

## Running the checks

The checks run automatically every time rethink starts, so the banner is already in your log:

```
docker logs rethink
```

You can also run them on demand, which is the quickest way to test a change without restarting:

```
docker exec rethink npm run check
```

Outside Docker, from the directory holding `config.json`:

```
npm run check
```

`npm run check` runs the built output, so run `npm run build` first if you have edited any source.
It exits `0` when nothing failed and `1` when something did, so it also works as a healthcheck.

## A healthy run

```
2026-09-29T14:44:58.945Z preflight --- rethink preflight ---
2026-09-29T14:44:58.946Z preflight [ ok ] config          every expected field is present and of the right type
2026-09-29T14:44:58.950Z preflight [ ok ] ports           port 4433 is free
2026-09-29T14:44:58.950Z preflight [ ok ] ports           port 8884 is free
2026-09-29T14:44:58.950Z preflight [ ok ] ports           port 1884 is free
2026-09-29T14:44:58.950Z preflight [ ok ] hostname        "common.lgthinq.com"
2026-09-29T14:44:58.951Z preflight [ ok ] ca files        CA certificate "ca.cert" is readable
2026-09-29T14:44:58.951Z preflight [ ok ] ca files        CA key "ca.key" is readable
2026-09-29T14:44:58.951Z preflight [ ok ] ca files        certificate subject CN=common.lgthinq.com
2026-09-29T14:44:58.951Z preflight [ ok ] ca files        certificate covers "common.lgthinq.com"
2026-09-29T14:44:58.951Z preflight [ ok ] ca files        certificate valid for another 3649 day(s)
2026-09-29T14:44:58.951Z preflight [ ok ] log topics      status, incoming
2026-09-29T14:44:58.952Z preflight [ ok ] mqtt url        mqtt://172.17.0.8:1883 (plaintext)
2026-09-29T14:44:58.952Z preflight [ ok ] mqtt creds      username "rethink", password set
2026-09-29T14:44:58.952Z preflight [ ok ] mqtt dns        "172.17.0.8" is already an IP address, no lookup needed
2026-09-29T14:44:58.953Z preflight [ ok ] mqtt tcp        172.17.0.8:1883 reachable in 1ms
2026-09-29T14:44:58.975Z preflight [ ok ] mqtt broker     connected and authenticated as "rethink"
2026-09-29T14:44:58.975Z preflight [ ok ] mqtt broker     subscribed to "homeassistant/status"
2026-09-29T14:44:58.975Z preflight [ ok ] mqtt broker     published to "rethink/preflight", write access confirmed
2026-09-29T14:44:58.975Z preflight --- preflight: 0 failed, 0 warnings, 18 passed ---
```

What the interesting lines mean:

- `mqtt url ... (plaintext)` is the address after parsing, with any credentials stripped. If this
  does not say what you expected, `RETHINK_MQTT_URL` is not what you think it is.
- `mqtt creds` reports the username and whether a password exists. rethink never prints the password
  itself, only `set` or `not set`.
- `mqtt tcp` proves something is listening. `mqtt broker` proves it is a real MQTT broker that
  accepts your credentials.
- The last two `mqtt broker` lines are the ones that matter for Home Assistant. Read access to
  `<discovery_prefix>/status` is how rethink notices Home Assistant restarting, and write access to
  `<rethink_prefix>/#` is how discovery and state reach it at all. A broker that logs you in but
  denies these will leave you with no entities and no error.

Two notes on the port lines. When you run `npm run check` while rethink is already running, the
ports are held by rethink itself and you get a warning rather than `is free`, which is expected:

```
[warn] ports           port 4433 is already in use
         -> Expected if rethink is already running here, otherwise another service holds it
         -> If rethink is not running, change the port or stop whatever holds it
```

The banner printed by the server at startup runs after its own listeners are up, so there the same
check reports `port 4433 is listening` instead, and reports a failure if a server did not come up.

## A failing run

This is what a fresh `docker-compose.yaml` looks like when the broker's container name does not
resolve. Failures are prefixed `ERROR:`, warnings `WARNING:`, and the `->` lines are the suggested
fixes:

```
2026-09-29T14:47:10.475Z preflight --- rethink preflight ---
2026-09-29T14:47:10.475Z preflight [ ok ] config          every expected field is present and of the right type
2026-09-29T14:47:10.479Z preflight WARNING: [warn] ports           port 4433 is already in use
2026-09-29T14:47:10.479Z preflight WARNING:          -> Expected if rethink is already running here, otherwise another service holds it
2026-09-29T14:47:10.479Z preflight WARNING:          -> If rethink is not running, change the port or stop whatever holds it
2026-09-29T14:47:10.479Z preflight [ ok ] hostname        "common.lgthinq.com"
2026-09-29T14:47:10.479Z preflight WARNING: [warn] ca files        CA certificate "ca.cert" does not exist yet, a new one will be generated
2026-09-29T14:47:10.479Z preflight [ ok ] log topics      status, incoming
2026-09-29T14:47:10.480Z preflight [ ok ] mqtt url        mqtt://mqtt5:1883 (plaintext)
2026-09-29T14:47:10.480Z preflight [ ok ] mqtt creds      username "user", password set
2026-09-29T14:47:10.480Z preflight WARNING: [warn] mqtt creds      username is still the default "user"
2026-09-29T14:47:10.480Z preflight WARNING:          -> Set RETHINK_MQTT_USER to a user your broker actually knows, or leave it empty for an anonymous broker
2026-09-29T14:47:10.480Z preflight WARNING: [warn] mqtt creds      password is still the entrypoint default
2026-09-29T14:47:10.480Z preflight WARNING:          -> Set RETHINK_MQTT_PASS to the password of the broker user above
2026-09-29T14:47:10.481Z preflight ERROR: [fail] mqtt dns        the hostname "mqtt5" could not be resolved by DNS
2026-09-29T14:47:10.481Z preflight ERROR:          -> Container DNS often differs from the host's. A name that resolves on your server may not resolve inside the container
2026-09-29T14:47:10.481Z preflight ERROR:          -> Use the broker's IP address in RETHINK_MQTT_URL to rule DNS out
2026-09-29T14:47:10.481Z preflight ERROR:          -> If the broker is another container, use its service name and make sure both are on the same docker network
2026-09-29T14:47:10.483Z preflight ERROR: [fail] mqtt tcp        the hostname "mqtt5" could not be resolved by DNS
2026-09-29T14:47:10.490Z preflight ERROR: [fail] mqtt broker     the hostname "mqtt5" could not be resolved by DNS
2026-09-29T14:47:10.490Z preflight ERROR: --- preflight: 3 failed, 7 warnings, 5 passed ---
2026-09-29T14:47:10.490Z preflight ERROR: rethink will keep running and retrying, but the Home Assistant integration will not work until the failures above are resolved.
```

Read it top down and fix the first failure. One root cause usually trips several checks, as here
where the same DNS problem fails `mqtt dns`, `mqtt tcp` and `mqtt broker`. The same three hints are
repeated under each of those, and have been trimmed above for length. rethink keeps running and
keeps retrying, because the appliance-facing side still works without Home Assistant.

## Failure modes

### DNS: the broker name does not resolve

```
[fail] mqtt dns        the hostname "mqtt5" could not be resolved by DNS
```

The name in `RETHINK_MQTT_URL` means nothing to the container's resolver. Container DNS is not the
host's DNS, so a name that works from your shell can still fail here. Put the broker's IP address in
`RETHINK_MQTT_URL` to confirm that is the problem. If the broker is another container, use its
compose service name and make sure both containers are on the same network.

### ECONNREFUSED: nothing is listening

```
[fail] mqtt tcp        nothing is listening on 172.17.0.8:1885
         -> The host was reachable but refused the connection, so the port is almost certainly wrong or the broker is not running
         -> "localhost" inside a container means the container itself, not your server. Use the server's IP or hostname
         -> Confirm the broker is listening on all interfaces rather than only 127.0.0.1
```

The host answered and actively refused, so the machine is right and the port is wrong, or the broker
is not running. The single most common cause in Docker is leaving the default
`mqtt://localhost:1883`, which points at the rethink container itself. rethink warns about that
separately:

```
[warn] mqtt url        the broker host "localhost" points at this container, not at your server
```

Mosquitto bound to `127.0.0.1` only will also refuse a connection from a container. Check its
`listener` line.

### Connection timeout: packets are being dropped

```
[fail] mqtt tcp        the connection to 192.168.1.10:1883 timed out
         -> A firewall is the usual cause: packets are being dropped rather than refused
         -> Check that the broker's port is open to the container's network
```

Different from refused. Nothing answered at all within 5 seconds, which is what a firewall dropping
packets looks like. If the TCP check passes but the handshake stalls, you get
`the mqtt handshake did not finish within 20s` instead, with the same cause.

### Not authorized: the broker refused your credentials

```
[fail] mqtt broker     the broker refused the connection: the broker refused authorisation for this client (reason code 5)
         -> Check RETHINK_MQTT_USER and RETHINK_MQTT_PASS against the broker's user list
         -> For Mosquitto, confirm the user exists in the password file and restart the broker after editing it
         -> Mosquitto reports the same "not authorized" for a wrong password and for no credentials at all when allow_anonymous is false, so check that a username is configured
         -> If the broker allows anonymous connections, it may still reject a username it does not know
```

The reason code is quoted straight from the broker. Codes `4` and `5` on an MQTT 3.1.1 broker, and
`134` and `135` on MQTT 5, all mean credentials. Other codes get a summary too, for example
`the broker rejected the client id` or `the broker is unavailable`, and for those the hints point
you at the broker's own log rather than at your username.

Two related warnings are worth acting on before anything else:

```
[warn] mqtt creds      username is still the default "user"
[warn] mqtt creds      password is still the entrypoint default
```

`user` and `pass` are the placeholder values in `entrypoint.sh` and `docker-compose.yaml`. No broker
knows them. Either set `RETHINK_MQTT_USER` and `RETHINK_MQTT_PASS` to a real account, or clear both
to connect anonymously.

### Silent close: the connection is dropped with no error

```
[fail] mqtt broker     172.17.0.8:18883 accepted the TCP connection then closed it without answering, so the MQTT handshake never completed
         -> A plaintext client against a TLS listener is dropped exactly like this. Try mqtts:// (usually port 8883)
         -> Some brokers drop a client that fails authentication instead of rejecting it properly, so check the username and password
         -> The port may belong to a service that is not an MQTT broker at all
         -> The broker's own log will normally say why it closed the connection
```

This is the nastiest case and the one that produced the original endless `connection lost` loop. A
plaintext `mqtt://` client pointed at a TLS listener has its socket dropped before the handshake, so
the MQTT library emits no error at all, only a close. Nothing is wrong with the network and nothing
is wrong with your credentials, the protocol is simply wrong. Use `mqtts://` on the TLS port, which
is normally 8883, or `mqtt://` on 1883.

The mirror image, `mqtts://` against a plaintext listener, does report an error:

```
[fail] mqtt broker     the broker at 192.168.1.10:1883 closed the connection during the TLS handshake, so it is probably not a TLS listener
```

If rethink is using `mqtts://` and your broker has a self-signed certificate you will instead see
`the broker's TLS certificate could not be verified`. On a trusted local network the simplest fix is
a plaintext `mqtt://` connection.

### ACL denial on subscribe and on publish

```
[ ok ] mqtt broker     connected and authenticated as "rethink"
[fail] mqtt broker     the broker denied the subscription to "homeassistant/status"
         -> The broker answered SUBACK 128, which means this user is not allowed to read that topic
         -> Grant read access to "homeassistant/#" for this user
[fail] mqtt broker     the broker never acknowledged the publish to "rethink/preflight"
         -> A qos 1 publish must be answered with a PUBACK. Silence normally means an ACL rule is discarding the message
         -> Grant write access to "rethink/#" for this user, discovery cannot work without it
```

The login succeeded and the connection stays up, which is why this used to be invisible. The broker
is throwing rethink's messages away. Mosquitto denies a publish by silently discarding it, so the
absence of a PUBACK is the only signal there is. Give the user read access to
`<discovery_prefix>/#` and write access to `<rethink_prefix>/#`, which by default means
`homeassistant/#` and `rethink/#`.

If the broker accepts the subscription but never answers it, you get a warning instead,
`the broker never answered the subscription to "homeassistant/status"`, and the checks carry on to
the publish probe.

### A non-MQTT service on that port

```
[fail] mqtt broker     the service on 172.17.0.8:18123 replied with something that is not MQTT (Invalid header flag bits, must be 0x0 for puback packet)
         -> That port almost certainly belongs to a different service. Home Assistant itself (8123) and web UIs are common mistakes
         -> Point RETHINK_MQTT_URL at the broker, usually Mosquitto on port 1883
```

Something answered and it was not a broker. Pointing `RETHINK_MQTT_URL` at Home Assistant's own web
interface on port 8123 is the usual mistake. Home Assistant is not an MQTT broker, it is a client of
one, exactly like rethink. Point both at Mosquitto.

A related variant, where the port belongs to something that accepts the connection and then says
nothing, reports `the broker accepted the TCP connection but never answered our CONNECT packet`.

### Port already in use

This one is about rethink's own listeners, not the broker. `npm run check` tries to bind each of
them, and reports a port it cannot have as a warning, because a port held by a running rethink is
exactly what you would expect to see:

```
[warn] ports           port 1884 is already in use
         -> Expected if rethink is already running here, otherwise another service holds it
         -> If rethink is not running, change the port or stop whatever holds it
```

So read it in context. If rethink is running, ignore it. If it is not, something else holds
`https_port`, `mqtts_port` or `mqtt_port`, and rethink will not be able to start. The server says so
in its own words when that happens:

```
the MQTT broker cannot start: port 1884 is already in use (config "mqtt_port")
```

and the banner it prints at startup, which checks its listeners rather than trying to bind them,
turns that into a failure:

```
[fail] ports           nothing is listening on port 1884
         -> The server for "mqtt_port" did not start, look for its listen error above
```

A neighbouring failure, `binding port 443 requires privileges`, means a port below 1024 without
root. In Docker, publish a low host port onto a high container port instead, for example `443:4433`.

If two settings name the same port you get `https_port and mqtts_port are both set to 4433`. Each
server needs its own.

### Certificate hostname mismatch

```
[fail] ca files        the certificate does not cover "common.lgthinq.com"
         -> rethink silently deletes and regenerates the CA when this happens, so any copy your appliances already trust stops working
         -> Either set RETHINK_HOSTNAME back to the name the certificate was issued for, or re-provision the appliances against the new CA
```

This is about the appliance-facing CA, not the broker, and it is worth understanding because it
breaks appliances rather than Home Assistant. The CA in `ca_cert_file` is also the TLS server
certificate, and it is issued for `RETHINK_HOSTNAME`. Change that variable and the existing
certificate no longer matches, so rethink generates a new one on the next start, and every appliance
that trusts the old one stops connecting. Either put `RETHINK_HOSTNAME` back, or re-run the setup
for each appliance.

Related lines from the same check: `the certificate expired N day(s) ago`, `the certificate expires
in N day(s)`, and `CA certificate "ca.cert" is missing and its directory is not writable`, which
means the mounted volume's ownership is wrong and rethink cannot generate a CA at all.

## Reading the running log

The startup banner covers the moment rethink starts. After that the same diagnosis machinery runs on
the live connection, with the volume kept down deliberately:

- The first failure of an outage is explained in full, and so is any change of cause.
- While nothing changes, a reminder goes out at most once every 60 seconds, for example
  `still disconnected after 12 attempts over 1m 0s, last error: ...`.
- If rethink has never reached the broker at all, after 30 seconds it says so loudly:
  `rethink has never reached the MQTT broker at mqtt://... since startup` followed by
  `no devices will appear in Home Assistant until this connection succeeds`.
- When it recovers you get `connection restored after 12 attempts, down for 1m 0s`.
- If state updates pile up while the broker is unreachable, you get a count once a minute:
  `N message(s) queued while the broker is unreachable, Home Assistant will not see them until the
  connection returns`.

The per-attempt `HA mqtt reconnecting, attempt N` lines are still produced, but they go to the
`mqtt` log topic, which is off by default. Turn it on when you want the full trace.

## Log topics

`RETHINK_LOG` is a JSON array of topics. The default is `["status","incoming"]`.

| Topic | What it prints |
| --- | --- |
| `status` | Lifecycle messages: connection established, connection lost, CA generation, discovery starting. |
| `incoming` | Messages arriving from appliances. |
| `publish` | Every property value published to Home Assistant. Verbose. |
| `HTTPS` | Each request to the provisioning HTTPS server, with hostname and url. |
| `mqtt` | Per-reconnect-attempt tracing of the Home Assistant broker connection. Off by default. |
| `all` | Enables every topic at once. |

```yaml
RETHINK_LOG: '["status","incoming","mqtt"]'
```

It must be valid JSON, because `entrypoint.sh` drops it into `config.json` verbatim. Get it wrong
and rethink tells you so instead of failing with a stack trace:

```
./config.json is not valid JSON: ...
  -> RETHINK_LOG in particular must be valid JSON, for example ["status","incoming"]
```

Errors and warnings are printed regardless of this filter. That is deliberate. The filter is itself
part of the configuration, so it must never be able to hide the messages explaining why rethink is
not working. A topic no code ever logs to is reported by the checks:

```
[warn] log topics      no code logs to "mqqt"
         -> Known topics: status, incoming, publish, HTTPS, mqtt
         -> Use "all" to enable every topic at once
```

## If the checks all pass and there are still no entities

The broker link is fine, so look further along the chain:

- Confirm the appliance is actually reaching rethink. Enable the `HTTPS` and `incoming` topics and
  restart the appliance. No traffic at all means the DNS redirect of `common.lgthinq.com` to your
  server is not in place, or the appliance was never set up against this CA.
- Check the log for `Device type ... unknown`. rethink only translates the models listed in the
  README. An appliance can connect and provision successfully and still have no Home Assistant
  entities if its model is not implemented.
- Confirm Home Assistant's own MQTT integration points at the same broker and the same
  `discovery_prefix`, and that discovery is enabled.
