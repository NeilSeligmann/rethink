import TLVDevice from './tlv_device.js'
import { Device as ClipDevice } from "../devmgr.js"
import { DeviceDiscovery, Config, type Connection } from '../homeassistant.js'
import { ClipDeployMessage } from '../../util/clip.js'
import { allowExtendedType } from '../../util/util.js'
import HADevice from './base.js'

export default class Device extends TLVDevice {
	constructor(HA: Connection, clipDevice: ClipDevice, provisionMsg: ClipDeployMessage) {
		super(HA, 'device', clipDevice)
		const config: Config = allowExtendedType({
			...HADevice.deviceConfig(provisionMsg, { name: 'LG Air Conditioner' }),
			components: {
				climate: {
					platform: "climate",
					unique_id: '$deviceid-climate',
					name: 'Climate',
					temperature_unit: 'C',
					temp_step: 0.5,
					precision: 0.5,
					fan_modes: [ 'auto', 'very low', 'low', 'medium', 'high', 'very high' ],
					swing_modes: [ '1', '2', '3', '4', '5', '1-3', '3-5', 'on', 'off' ],
					vertical_swing_modes: [ '1', '2', '3', '4', '5', '6', 'on', 'off' ], // not supported by HA (FIXME: now supported!)
					current_temperature_topic: '$this/current_temperature',
					mode_state_topic: '$this/mode',
					mode_command_topic: '$this/mode/set',
					fan_mode_state_topic: '$this/fan_mode',
					fan_mode_command_topic: '$this/fan_mode/set',
					temperature_state_topic: '$this/temperature',
					temperature_command_topic: '$this/temperature/set',
					vertical_swing_mode_state_topic: '$this/vertical_swing_mode',
					vertical_swing_mode_command_topic: '$this/vertical_swing_mode/set',
					swing_mode_state_topic: '$this/swing_mode',
					swing_mode_command_topic: '$this/swing_mode/set'
				},
				light: {
					platform: "switch",
					unique_id: '$deviceid-light',
					name: 'Display Light',
					state_topic: '$this/light',
					command_topic: '$this/light/set'
				},
				energy: {
					platform: "sensor",
					unique_id: '$deviceid-energy',
					name: 'Energy Consumption',
					device_class: 'energy',
					state_class: 'total_increasing',
					unit_of_measurement: 'Wh',
					state_topic: '$this/energy_consumption'
				}
			}
		})

		this.addField(config, {
			id: 0x1fd, name: 'current_temperature', writable: false,
			read_xform: (raw) => raw/2
		}, false)

		this.addField(config, {
			id: 0x1f7, name: 'power', readable: false,
			write_xform: (val) => val === 'ON' ? 1 : 0,
			write_attach: (raw) => raw ? [0x1f9, 0x1fa] : [],
			read_xform: (raw) => raw ? 'ON' : 'OFF',
			read_callback: (val) => {
				// update 'mode' instead
				this.processKeyValue(0x1f9, this.raw_clip_state[0x1f9])
			}
		}, false)

		this.addField(config, {
			id: 0x1f9, name: 'mode',
			read_xform: (raw) => {
				const modes2ha = [ 'cool', 'dry', 'fan_only', undefined, 'heat', undefined, 'auto' ]
				if(this.raw_clip_state[0x1f7] === 0)
					return 'off'
				return modes2ha[raw]
			},
			write_xform: (val) => {
				const modes2clip = { cool: 0, dry: 1, fan_only:2, heat:4, auto:6 }
				if (val === 'off') {
					// Call function power (0x1f7) with value OFF
					this.setProperty('power', 'OFF')
				}
				return modes2clip[val]
			},
			write_attach: [0x1fa, 0x1fe]
		}, false)

		this.addField(config, {
			id: 0x1fa, name: 'fan_mode',
			read_xform: (raw) => {
				const modes2ha = [ undefined, undefined, 'very low', 'low', 'medium', 'high', 'very high', undefined, 'auto' ]
				return modes2ha[raw]
			},
			write_xform: (val) => {
				const modes2clip = { 'very low': 2, 'low': 3, 'medium': 4, 'high': 5, 'very high': 6, auto: 8 }
				return modes2clip[val]
			},
			write_attach: [0x1f9, 0x1fe]
		}, false)

		this.addField(config, {
			id: 0x1fe, name: 'temperature', read_xform: (raw) => raw/2, write_xform: (val) => Math.round(Number(val)*2),
			write_attach: [0x1f9, 0x1fa]
		}, false)

		this.addField(config, {
			id: 0x321, name: 'vertical_swing_mode', 
			read_xform: (raw) => {
				const modes2ha = [ "off", "1", "2", "3", "4", "5", "6" ]
				modes2ha[100] = "on"
				return modes2ha[raw]
			},
			write_xform: (val) => {
				const modes2clip = { "off": 0, "1":1, "2":2, "3":3, "4":4, "5":5, "6":6, "on":100 }
				return modes2clip[val]
			},
			write_attach: [0x1f9, 0x1fa]
		}, false)

		this.addField(config, {
			id: 0x322, name: 'swing_mode',
			read_xform: (raw) => {
				const modes2ha = [ "off", "1", "2", "3", "4", "5" ]
				modes2ha[13] = "1-3"
				modes2ha[35] = "3-5"
				modes2ha[100] = "on"
				return modes2ha[raw]
			},
			write_xform: (val) => {
				const modes2clip = { "off": 0, "1":1, "2":2, "3":3, "4":4, "5":5, "1-3":13, "3-5":35, "on":100 }
				return modes2clip[val]
			},
			write_attach: [0x1f9, 0x1fa]
		}, false)

		this.addField(config, {
			id: 0x21f,
			name: 'light',
			write_xform: (val) => val === 'ON' ? 1 : 0,
			read_xform: (raw) => raw === 1 ? 'ON' : 'OFF'
		}, false)

		this.addField(config, {
			id: 0x232,
			name: 'energy_consumption',
			writable: false,
			read_xform: (raw) => raw
		}, false)

		this.setConfig(config)
	}
}