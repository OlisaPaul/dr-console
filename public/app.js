let token, state, selectedView = 'overview', pendingAction, connected = true;
const main = document.querySelector('#main');
const dialog = document.querySelector('#confirmation');
const phrases = { failover: 'PROMOTE DR', rejoin: 'REBUILD PRODUCTION', failback: 'CUT OVER TO PRODUCTION', reconcile: 'I VERIFIED BOTH SERVERS' };
const names = { failover: 'Bring DR online', rejoin: 'Prepare production', failback: 'Cut over to production', reconcile: 'Reconcile server state' };
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const time = value => value ? new Date(value).toLocaleString('en-NG', { timeZone: 'Africa/Lagos', hour: '2-digit', minute: '2-digit', second: '2-digit', day: '2-digit', month: 'short' }) + ' WAT' : 'Not checked';
const label = host => host === 'production' ? 'Production' : 'Disaster recovery';
const pill = (text, kind = '') => `<span class="pill ${kind}">${esc(text)}</span>`;
const stepList = {
  failover: ['Fence production and stop its writers', 'Drain received events', 'Persist DR as writable primary', 'Start services and switch routing'],
  rejoin: ['Fence returning production', 'Preserve its licence and local settings', 'Restore a fresh DR seed and recordings', 'Start read-only replication from DR'],
  failback: ['Freeze DR writes', 'Verify final database and file boundaries', 'Promote production and switch routing', 'Rebuild DR as the standby replica'],
  reconcile: ['Inspect both servers and any interrupted remote jobs', 'Refresh verified server roles', 'Acknowledge the state before allowing another operation']
};
async function api(url, data, retried = false) {
  const options = { headers: { 'X-Console-Token': token } };
  if (data !== undefined) { options.method = 'POST'; options.headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(data); }
  const response = await fetch(url, options);
  const result = await response.json();
  if (response.status === 401 && data === undefined && !retried) {
    const session = await fetch('/api/session').then(r => r.json());
    token = session.token;
    return api(url, data, true);
  }
  if (!response.ok) throw new Error(result.error || 'Request failed');
  return result;
}
let toastTimer;
function toast(message) {
  const el = document.querySelector('#toast'); el.textContent = message; el.classList.add('visible');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('visible'), 6000);
}
function header(title, subtitle) {
  return `<div class="page-heading"><div><div class="eyebrow">SERVER CONTINUITY</div><h1>${title}</h1><p>${subtitle}</p></div><button class="button secondary" data-command="refresh">↻ Refresh status</button></div>`;
}
function modeBanner() {
  return `<div class="mode-banner ${state.mode === 'live' ? 'live' : ''}"><span class="mode-mark">${state.mode === 'simulation' ? '◈' : '●'}</span><div><strong>${state.mode === 'simulation' ? 'Simulation workspace' : 'Live server control'}</strong><span>${state.mode === 'simulation' ? 'All actions use persisted local demo data. No commands are sent to your servers.' : 'Actions execute administrator-provisioned hooks. Confirm the observed roles before switching.'}</span></div>${pill(state.mode === 'simulation' ? 'NO SERVER CHANGES' : 'LIVE EXECUTION', state.mode === 'live' ? 'warning' : '')}</div>`;
}
function serverCard(host) {
  const s = state.servers[host];
  const primary = state.active === host;
  const health = s.reachable ? (s.role === 'replica' && s.sql !== true ? 'Needs attention' : 'Reachable') : 'Unreachable';
  const repl = s.role === 'replica' ? `${s.io ? 'IO connected' : 'IO disconnected'} · ${s.sql ? 'SQL applying' : 'SQL stopped'}` : 'No upstream replica connection';
  const writes = !s.reachable ? 'Unknown · last observed' : s.readOnly ? 'Read-only' : 'Writable';
  return `<article class="server-card ${primary ? 'authoritative' : ''}"><div class="server-top"><span class="server-icon">▤</span>${pill(primary ? 'AUTHORITATIVE' : s.role.toUpperCase(), primary ? 'green' : '')}</div><h2>${label(host)}</h2><div class="ip">${esc(s.ip)} <span>MariaDB 10.5</span></div><div class="server-health"><span class="status-dot ${s.reachable ? 'good' : 'bad'}"></span>${health}${s.fenced ? pill('Fenced', 'warning') : ''}</div><dl><div><dt>Database writes</dt><dd>${writes}</dd></div><div><dt>Application services</dt><dd>${esc(s.services)}</dd></div><div><dt>Replication lag</dt><dd>${s.lag === null || s.lag === undefined ? '—' : esc(s.lag) + ' seconds'}</dd></div><div><dt>${state.mode === 'simulation' ? 'Demo records saved' : 'Applied GTID'}</dt><dd>${esc(state.mode === 'simulation' ? s.records : s.gtid || 'Not reported')}</dd></div></dl><div class="server-foot">${esc(repl)}</div></article>`;
}
function actionCard(action, number, description) {
  const available = state.actions[action];
  return `<article class="action-card"><div class="action-number">0${number}</div><h3>${names[action]}</h3><p>${description}</p><button class="button ${action === 'failover' ? 'primary' : 'secondary'}" data-action="${action}" ${!available.allowed || !connected ? 'disabled' : ''}>${names[action]} <span>→</span></button>${!available.allowed ? `<small class="blocked-reason">${esc(available.reason)}</small>` : '<small class="blocked-reason ready">Ready for operator confirmation</small>'}</article>`;
}
function jobPanel(job = state.jobs[0]) {
  if (!job) return `<section class="panel empty-job"><span>✓</span><div><h3>No operations running</h3><p>Your first recovery operation will appear here with a step-by-step execution log.</p></div></section>`;
  const completed = job.steps.filter(s => s.state === 'complete').length;
  return `<section class="panel job-panel"><div class="section-heading"><div><h2>${names[job.action]}</h2><p>Started ${time(job.startedAt)} · ${completed}/${job.steps.length} steps</p></div>${pill(job.state, job.state === 'failed' || job.state === 'interrupted' ? 'red' : job.state === 'complete' ? 'green' : 'blue')}</div><div class="steps">${job.steps.map((s, i) => `<div class="step ${esc(s.state)}"><span class="step-dot">${s.state === 'complete' ? '✓' : s.state === 'failed' ? '!' : i + 1}</span><div><strong>${esc(s.title)}</strong><small>${label(s.host)}${s.message ? ' · ' + esc(s.message) : ''}</small></div><span class="step-state">${esc(s.state)}</span></div>`).join('')}</div>${job.error ? `<div class="inline-error">${esc(job.error)}<p>No automatic rollback is attempted. Verify both servers before continuing.</p></div>` : ''}</section>`;
}
function auditPanel(limit = 8) {
  return `<section class="panel audit-panel"><div class="section-heading"><div><h2>Activity log</h2><p>Durable operation history · times shown in West Africa Time</p></div>${pill(state.audit.length + ' events')}</div>${state.audit.length ? `<div class="audit-list">${state.audit.slice(0, limit).map(e => `<div class="audit-row"><span class="audit-dot"></span><div><strong>${esc(e.event)}</strong><p>${esc(e.details)}</p></div><time>${time(e.at)}</time></div>`).join('')}</div>` : '<p class="empty-text">No events yet. Use the simulation controls to begin a recovery drill.</p>'}</section>`;
}
function simulationPanel() {
  if (state.mode !== 'simulation') return '';
  const disabled = state.busy || !connected ? 'disabled' : '';
  return `<section class="panel demo-panel"><div><h2>Run a recovery drill</h2><p>Simulate an outage, promote DR, save a call, bring production back, then rebuild and cut over.</p></div><div class="demo-buttons"><button class="button secondary" data-demo="outage" ${disabled} ${state.active !== 'production' || !state.servers.production.reachable ? 'disabled' : ''}>Simulate production outage</button><button class="button secondary" data-demo="write" ${disabled}>Save a test call</button><button class="button secondary" data-demo="return" ${disabled} ${state.active !== 'dr' || state.servers.production.reachable ? 'disabled' : ''}>Production returns</button><button class="button text-button" data-demo="reset" ${disabled}>Reset demo</button></div></section>`;
}
function settings() {
  return `${header('Connection setup', 'Prepare the management host before enabling live server operations.')}<section class="panel setup-panel"><h2>Keep the control plane independent</h2><p>Deploy this console on a third management machine so it remains available when either ConVox server fails. The local preview binds to 127.0.0.1 and can be accessed through an SSH tunnel.</p><div class="setup-grid"><div><h3>Production</h3><code>10.81.0.11</code><p>Server ID 8111<br>Original production licence and IP configuration</p></div><div><h3>Disaster recovery</h3><code>10.3.0.150</code><p>Server ID 30150<br>Independent DR licence and IP configuration</p></div></div><h3>Live adapter</h3><p>The backend invokes one administrator-configured executable with a fixed argument list. The browser cannot send shell commands or change credentials. Server-side hooks must implement verified fencing, seeding, replication, file sync, service activation, and routing.</p><p>See <code>dr-console/README.md</code> for the hook contract and deployment procedure. Live mode is unavailable until those hooks are installed and verified.</p><h3>Environment data stays local</h3><ul><li><code>convoxcces_global.convoxccs_license_details</code></li><li><code>/var/www/convox4.conf</code></li><li><code>/var/www/convoxwebpanel.conf</code></li></ul><p>Fresh seeds preserve the destination licence. File transfers exclude the two environment-specific configuration files. A role change must also stop the old file-sync direction.</p><h3>Before remote deployment</h3><p>Add operator authentication, HTTPS, protected secret storage, access controls and verified carrier/NAT routing. Do not expose this local preview directly to the internet.</p></section>`;
}
function render() {
  if (!state) return;
  const focused = document.activeElement?.dataset?.focus;
  const alerts = `${!connected ? '<div class="inline-error" role="alert">Controller connection lost. No action is available until it reconnects.</div>' : ''}${state.observationError ? `<div class="inline-error" role="alert">${esc(state.observationError)}</div>` : ''}${state.reconcileRequired ? '<div class="inline-error">The previous operation needs reconciliation. Inspect both servers before continuing. <button class="button secondary" data-action="reconcile">Reconcile state</button></div>' : ''}`;
  let content;
  if (selectedView === 'settings') content = settings();
  else if (selectedView === 'audit') content = `${header('Audit history', 'Every recovery step is recorded on the management host.')}${auditPanel(500)}`;
  else if (selectedView === 'operations') content = `${header('Recovery operations', 'Only one operation can run at a time.')}${state.jobs.length ? state.jobs.map(jobPanel).join('') : jobPanel()}${simulationPanel()}`;
  else {
    const a = state.servers[state.active], other = state.active === 'production' ? 'dr' : 'production';
    content = `${header('Disaster recovery', 'Manage server roles, replication and controlled cutover from one place.')}<div class="metrics"><div><span class="metric-label">ACTIVE PRIMARY</span><strong>${label(state.active)}</strong><small>${esc(a.ip)}</small></div><div><span class="metric-label">REPLICATION</span><strong>${state.servers[other].role === 'replica' && state.servers[other].io && state.servers[other].sql ? 'Connected' : 'Needs attention'}</strong><small>${state.servers[other].role === 'replica' ? 'Primary → read-only replica' : 'Standby not yet replicating'}</small></div><div><span class="metric-label">LAST OBSERVATION</span><strong class="metric-time">${time(state.checkedAt)}</strong><small>${state.mode === 'simulation' ? 'Local simulation state' : 'Verified server hook'}</small></div></div><div class="server-grid">${serverCard('production')}${serverCard('dr')}</div><div class="replication-strip"><span class="status-dot ${state.servers[other].role === 'replica' && state.servers[other].io ? 'good' : 'neutral'}"></span><strong>${label(state.fileSource)} → ${label(state.fileSource === 'production' ? 'dr' : 'production')}</strong><span>${state.servers[other].role === 'replica' ? 'Database + recordings' : 'Desired sync direction · peer rebuild required'}</span><small>Licence and local IP settings preserved</small></div><div class="section-heading workflow-title"><div><h2>Recovery workflow</h2><p>One active writer. Controlled promotion. Verified catch-up before cutover.</p></div></div><div class="actions-grid">${actionCard('failover', 1, 'Fence production, persist the DR primary role and restore service on DR.')}${actionCard('rejoin', 2, 'Rebuild returning production from DR and keep it read-only while it catches up.')}${actionCard('failback', 3, 'Freeze DR, verify the final data boundary and return the primary role to production.')}</div>${jobPanel()}${simulationPanel()}${auditPanel()}`;
  }
  main.innerHTML = modeBanner() + alerts + content;
  main.querySelectorAll('button').forEach((b, i) => b.dataset.focus = `${selectedView}-${i}`);
  if (focused) main.querySelector(`[data-focus="${focused}"]`)?.focus({ preventScroll: true });
}
function openConfirmation(action) {
  pendingAction = action;
  document.querySelector('#confirm-title').textContent = names[action];
  const descriptions = {
    failover: 'Promotion requires fencing production first. An unreachable server is not proof that it has stopped accepting writes.',
    rejoin: 'A fresh seed replaces the production application databases with the current DR data. Existing destination data must be backed up. Mixed MyISAM tables require a consistent locking backup and may briefly pause writes on DR.',
    failback: 'This operation briefly pauses DR writes. Production is promoted only after its database and recordings match the final DR boundary.',
    reconcile: 'Confirm you inspected remote jobs and both server roles. Refreshing status alone does not resolve a partially completed transfer or routing change.'
  };
  document.querySelector('#confirm-description').textContent = descriptions[action] + (state.mode === 'simulation' ? ' This is a simulation; no server is changed.' : ' This changes real servers.');
  document.querySelector('#confirm-steps').innerHTML = stepList[action].map(s => `<li>${esc(s)}</li>`).join('');
  document.querySelector('#confirm-phrase').textContent = phrases[action];
  document.querySelector('#confirm-input').value = '';
  document.querySelector('#confirm-error').textContent = '';
  document.querySelector('#outage-label').hidden = action !== 'failover' || state.servers.production.reachable;
  document.querySelector('#outage-accepted').checked = false;
  updateConfirmation(); dialog.showModal(); document.querySelector('#confirm-input').focus();
}
function updateConfirmation() {
  const ack = document.querySelector('#outage-label').hidden || document.querySelector('#outage-accepted').checked;
  document.querySelector('#submit-operation').disabled = document.querySelector('#confirm-input').value !== phrases[pendingAction] || !ack;
}
main.addEventListener('click', async event => {
  const button = event.target.closest('button'); if (!button || button.disabled) return;
  try {
    if (button.dataset.action) return openConfirmation(button.dataset.action);
    if (button.dataset.demo) {
      if (button.dataset.demo === 'reset' && !window.confirm('Reset local simulation data and its demo history?')) return;
      state = await api('/api/demo', { command: button.dataset.demo }); render(); toast('Simulation updated');
    }
    if (button.dataset.command === 'refresh') { state = await api('/api/refresh', {}); render(); toast('Status refreshed'); }
  } catch (error) { toast(error.message); }
});
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => {
  selectedView = button.dataset.view;
  document.querySelectorAll('[data-view]').forEach(b => { b.classList.toggle('active', b === button); b.setAttribute('aria-current', b === button ? 'page' : 'false'); }); render();
}));
document.querySelector('#cancel').addEventListener('click', () => dialog.close());
document.querySelector('#confirm-input').addEventListener('input', updateConfirmation);
document.querySelector('#outage-accepted').addEventListener('change', updateConfirmation);
document.querySelector('#confirm-form').addEventListener('submit', async event => {
  event.preventDefault(); document.querySelector('#submit-operation').disabled = true;
  try {
    const confirmation = document.querySelector('#confirm-input').value;
    await api(pendingAction === 'reconcile' ? '/api/reconcile' : '/api/jobs', { action: pendingAction, confirmation, outageAccepted: document.querySelector('#outage-accepted').checked });
    dialog.close(); state = await api('/api/state'); render(); toast('Operation recorded');
  } catch (error) { document.querySelector('#confirm-error').textContent = error.message; updateConfirmation(); }
});
async function poll() {
  try { state = await api('/api/state'); connected = true; render(); }
  catch { connected = false; render(); }
  finally { setTimeout(poll, 1800); }
}
try {
  const session = await fetch('/api/session').then(r => r.json()); token = session.token;
  await poll();
} catch (error) { main.textContent = `Unable to connect: ${error.message}. Refresh this page.`; }
