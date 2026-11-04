import { DriverRegistry } from '../src/core/registry'
import { registerBuiltinDrivers } from '../src/drivers'
import { ConnectionManager } from '../src/main/ConnectionManager'
import { ConnectionStore } from '../src/main/ConnectionStore'

const registry = new DriverRegistry()
registerBuiltinDrivers(registry)

export { ConnectionManager, ConnectionStore }
export function listBuiltinDialects() {
  return registry.list()
}
