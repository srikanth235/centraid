/**
 * Assistant-facing connector tool registration path.
 *
 * Loads capability descriptors from live healthy vault connections via the
 * same list DTOs the Connectors UI uses. Unhealthy / paused / needs-auth
 * connections do not advertise tools. Never returns secret cells.
 *
 * Wire this into any assistant system-prompt or tool-registration consumer
 * that needs dynamic connector tools.
 */
export { loadConnectorToolDescriptors } from './settingsConnectionsData.js';
export type { ConnectorToolDescriptor } from './connectorPlatform.js';
