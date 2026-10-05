export const HOSTS = ['production', 'dr'];
export const IP = { production: '10.81.0.11', dr: '10.3.0.150' };
export const CONFIRMATIONS = {
  failover: 'PROMOTE DR', rejoin: 'REBUILD PRODUCTION', failback: 'CUT OVER TO PRODUCTION'
};
export const LICENSE = 'convoxcces_global.convoxccs_license_details';
export const LOCAL_TABLES = [LICENSE, 'convoxcces_global.convoxccs_notifications',
  'convoxcces_global.convoxccs_servers', 'convoxcces_global.convoxccs_web_servers'];
export const EXCLUSIONS = ['/var/www/convox4.conf', '/var/www/convoxwebpanel.conf'];
export const FILES = ['/var/www/html/calls/', '/var/www/html/ConVoxCCS/', '/var/www/asterisk/', '/var/www/convox_agi/', '/var/www/convox_moh/', '/var/www/convox_perl/', '/var/www/convox_sounds/', '/etc/asterisk/'];

export function initialState() {
  return {
    schemaVersion: 1, active: 'production', fileSource: 'production', revision: 1,
    servers: {
      production: { ip: IP.production, reachable: true, role: 'primary', readOnly: false, fenced: false, services: 'running', io: null, sql: null, lag: null, watermark: 577, records: 577, fileWatermark: 577 },
      dr: { ip: IP.dr, reachable: true, role: 'replica', readOnly: true, fenced: false, services: 'stopped', io: true, sql: true, lag: 0, watermark: 577, records: 577, fileWatermark: 577 }
    }, jobs: [], audit: [], checkedAt: new Date().toISOString()
  };
}

export function validateObservation(view) {
  if (!view || !HOSTS.includes(view.active) || !HOSTS.includes(view.fileSource)) throw new Error('Invalid topology returned by status hook');
  for (const host of HOSTS) {
    const s = view.servers?.[host];
    if (!s || s.ip !== IP[host] || typeof s.reachable !== 'boolean') throw new Error(`Invalid ${host} observation`);
    if (s.reachable && (typeof s.readOnly !== 'boolean' || typeof s.fenced !== 'boolean' || !['primary', 'replica', 'fenced', 'rebuilding'].includes(s.role))) throw new Error(`Incomplete ${host} observation`);
  }
  const writable = HOSTS.filter(h => view.servers[h].reachable && view.servers[h].readOnly === false && !view.servers[h].fenced);
  if (writable.length > 1) throw new Error('SPLIT BRAIN: both servers are writable. Stop and fence one server.');
  return { active: view.active, fileSource: view.fileSource, servers: view.servers };
}

export function prerequisites(state, action) {
  const p = state.servers.production, d = state.servers.dr;
  if (action === 'failover') {
    if (state.active !== 'production') throw new Error('DR is already authoritative');
    if (!d.reachable || !d.readOnly || d.role !== 'replica' || d.sql !== true || d.lastSqlError) throw new Error('DR must be a reachable, read-only replica with a healthy SQL thread');
    if (p.reachable && (d.io !== true || d.lag !== 0 || d.lastIoError)) throw new Error('For a planned switch, DR must first catch up without replication errors');
  } else if (action === 'rejoin') {
    if (state.active !== 'dr' || !d.reachable || d.readOnly || !p.reachable) throw new Error('DR must be active and production must be reachable');
  } else if (action === 'failback') {
    if (state.active !== 'dr' || !d.reachable || !p.reachable || p.role !== 'replica' || !p.readOnly || p.io !== true || p.sql !== true || p.lag !== 0 || p.lastIoError || p.lastSqlError) throw new Error('Production must be a healthy read-only replica of active DR with zero lag');
  } else throw new Error('Unknown operation');
}

export function makePlan(action) {
  const step = (key, title, host) => ({ key, title, host, state: 'pending' });
  if (action === 'failover') return [
    step('fence', 'Fence production and stop its file sync', 'production'),
    step('drain', 'Apply all received database events', 'dr'),
    step('promote', 'Persist DR as the writable primary', 'dr'),
    step('activate', 'Start verified ConVox services', 'dr'),
    step('route', 'Switch web, SIP and carrier routing', 'dr'),
    step('verify', 'Verify the active role and traffic', 'dr')
  ];
  if (action === 'rejoin') return [
    step('fence', 'Persist production fencing and read-only mode', 'production'),
    step('preserve', 'Back up production licence and local configuration', 'production'),
    step('seed', 'Seed production from authoritative DR', 'production'),
    step('files', 'Copy DR files and recordings to production', 'production'),
    step('replicate', 'Configure production as a read-only DR replica', 'production'),
    step('catchup', 'Verify database and file catch-up', 'production')
  ];
  if (action === 'failback') return [
    step('fence', 'Freeze DR writers and stop DR file sync', 'dr'),
    step('catchup', 'Verify final DR GTID and file watermark', 'production'),
    step('promote', 'Persist production as the writable primary', 'production'),
    step('activate', 'Start verified ConVox services', 'production'),
    step('route', 'Switch web, SIP and carrier routing', 'production'),
    step('standby', 'Rebuild DR as the read-only production replica', 'dr'),
    step('verify', 'Verify production and restore file sync direction', 'production')
  ];
  throw new Error('Unknown operation');
}
