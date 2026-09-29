let filter = (_: string) => true

export default function log(topic: string, ...args: any) {
    if(filter(topic))
        console.log(new Date(), topic, ...args)
}

// info/warn/error deliberately bypass the topic filter. The log filter is itself part of the
// configuration, so a misconfigured filter must never be able to hide the messages that explain
// why rethink is not working.
export function info(topic: string, ...args: any) {
    console.log(new Date(), topic, ...args)
}

export function warn(topic: string, ...args: any) {
    console.warn(new Date(), topic, 'WARNING:', ...args)
}

export function error(topic: string, ...args: any) {
    console.error(new Date(), topic, 'ERROR:', ...args)
}

export function setFilter(newFilter: (_: string) => boolean) {
    filter = newFilter
}
