import { DriverRegistry } from '../src/core/registry'
import { registerBuiltinDrivers } from '../src/drivers'
import { ConnectionManager } from '../src/main/ConnectionManager'
import { ConnectionStore } from '../src/main/ConnectionStore'
import { OwnerGovernance } from '../src/main/server/owner-governance'

const registry = new DriverRegistry()
registerBuiltinDrivers(registry)

export { ConnectionManager, ConnectionStore, OwnerGovernance }
export function listBuiltinDialects() {
  return registry.list()
}
