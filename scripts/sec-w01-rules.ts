// SEC-W01 acceptance rules (ADR-WIN-001), shared by the runner test and verify:agent so the gate that runs on the
// disposable runner and the gate that admits committed evidence can never drift apart. Returns every violation;
// an empty list is the only PASS. Unreachable, timed-out or uncontrolled outcomes are inconclusive and fail.

export const SEC_W01_ENV = ['LOCALAPPDATA', 'OA_INHERITED_CHANNEL', 'SystemRoot', 'TEMP', 'TMP', 'WINDIR'];
// The channel addon consumes the inherited-channel variable once it has taken the handle.
export const SEC_W01_ENV_AFTER_CHANNEL = SEC_W01_ENV.filter(name => name !== 'OA_INHERITED_CHANNEL');
const FILE_PROBES = ['file.read.workspace', 'file.read.profile', 'file.read.temp', 'file.read.repo-git-config', 'file.list.profile',
  'file.list.workspace', 'file.list.users', 'file.write.workspace', 'file.write.profile', 'file.write.temp', 'file.write.runtime'];
const EXACT_DENIALS = [...FILE_PROBES, 'proc.spawn', 'proc.kill-sibling', 'native.dlopen-parent-addon'];
/** Each network probe, the host control that must have reached the same kind of target, and accepted outcomes. */
const NETWORK: ReadonlyArray<{ probe: string; control: string; accepted: readonly string[] }> = [
  { probe: 'net.tcp4.public', control: 'tcp4Public', accepted: ['DENIED'] },
  { probe: 'net.tcp6.public', control: 'tcp6Public', accepted: ['DENIED'] },
  { probe: 'net.udp4.dns-public', control: 'udp4Dns', accepted: ['DENIED'] },
  { probe: 'net.dns.lookup', control: 'dns', accepted: ['DENIED', 'ERROR:ENOTFOUND', 'ERROR:EAI_FAIL'] },
  // AppContainer loopback isolation drops the SYN, so the OS reports ETIMEDOUT; zero listener hits are required too.
  { probe: 'net.tcp4.loopback', control: 'loopbackTcp4', accepted: ['DENIED', 'ERROR:ETIMEDOUT'] },
  { probe: 'net.tcp6.loopback', control: 'loopbackTcp6', accepted: ['DENIED', 'ERROR:ETIMEDOUT'] },
  // A connected UDP socket is authorized at connect time; SENT counts only with a zero-hit listener.
  { probe: 'net.udp4.loopback', control: 'loopbackUdp4', accepted: ['DENIED', 'SENT'] },
];

/** The public resolver the probe queries; must match the test host's targets. */
export const DNS_TARGET = '1.1.1.1';
/** The public IPv6 target the probe connects to on port 443; must match the test host's targets. */
export const IPV6_TARGET = '2606:4700:4700::1111';

type Json = Record<string, unknown>;
const record = (value: unknown): Json => (value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {});

export function evaluateSecW01(evidence: unknown): string[] {
  const violations: string[] = [];
  const need = (ok: boolean, message: string): void => { if (!ok) violations.push(message); };
  const root = record(evidence);
  need(root.check === 'SEC_W01_WIN32_X64', 'CHECK_NAME');
  need(typeof root.source === 'string' && /^[0-9a-f]{40}$/.test(root.source), 'SOURCE_COMMIT_MISSING');
  const baseline = record(root.baseline);
  need(baseline.appContainer === true && baseline.capabilityCount === 0 && typeof baseline.integrityRid === 'number' &&
    baseline.integrityRid <= 0x1000 && baseline.noChildProcessCreation === true && baseline.verifiedBeforeResume === true &&
    baseline.inheritedHandles === 'rpc-pipe,nul-read,stderr-pipe', 'BASELINE');
  need(record(root.exit).cleanup === 'confirmed', 'CLEANUP_UNCONFIRMED');
  const prepared = record(root.prepared); const controls = record(prepared.controls);
  need(prepared.parentAddonExists === true, 'CONTROL_PARENT_ADDON_MISSING');
  const report = record(root.report); const results = record(report.results);
  need(Object.keys(results).length > 0, 'REPORT_MISSING');
  // Positive controls: the probe ran in the granted context and saw the real native boundary.
  need(results['self.read-runtime'] === 'ALLOWED', 'CONTROL_SELF_READ');
  need(results['native.exports'] === 'close,read,write', `NATIVE_EXPORTS:${String(results['native.exports'])}`);
  need(!('native.load' in results), 'NATIVE_LOAD_FAILED');
  need(JSON.stringify(report.envAtStart) === JSON.stringify(SEC_W01_ENV), 'ENV_AT_START');
  need(JSON.stringify(report.env) === JSON.stringify(SEC_W01_ENV_AFTER_CHANNEL), 'ENV_AFTER_CHANNEL');
  for (const name of EXACT_DENIALS) need(results[name] === 'DENIED', `${name}:${String(results[name])}`);
  const observed = record(root.observed);
  need(observed.siblingAlive === true, 'SIBLING_KILLED');
  need(JSON.stringify(observed.hits) === JSON.stringify({ tcp4: 0, tcp6: 0, udp4: 0 }), `LISTENER_HITS:${JSON.stringify(observed.hits)}`);
  // A UDP send can "succeed" locally while WFP drops it. Silence then counts only with an audited outbound drop or
  // block of exactly that datagram from the probe runtime (WFP events 5152/5157, UDP = protocol 17).
  const wfp = Array.isArray(observed.wfp) ? observed.wfp.map(record) : [];
  const audited = (ids: number[], destination: string, port: number, protocol: number): boolean => observed.wfpAudit === true &&
    wfp.some(event => ids.includes(Number(event.id)) && event.direction === 'outbound' && event.destination === destination &&
      event.port === port && event.protocol === protocol);
  // Without an IPv6 internet path the runner routes the target through a dead ULA next hop: the host's attempt then
  // goes unanswered instead of failing route lookup, so a denial is policy, and WFP must have audited the block.
  const routedIpv6 = prepared.ipv6Route === true && ['TIMEOUT', 'ERROR:ETIMEDOUT'].includes(String(controls.tcp6Public)) &&
    audited([5157], IPV6_TARGET, 443, 6);
  for (const { probe, control, accepted } of NETWORK) {
    const outcome = String(results[probe]);
    const controlled = controls[control] === 'REACHABLE' || (probe === 'net.tcp6.public' && routedIpv6);
    // Without a successful (or audited, routed) control a denial cannot be told apart from an unreachable target.
    need(controlled, `${probe}:INCONCLUSIVE_CONTROL_${String(controls[control])}`);
    const proven = accepted.includes(outcome) || (probe === 'net.udp4.dns-public' && outcome === 'NO_RESPONSE' && audited([5152, 5157], DNS_TARGET, 53, 17));
    need(proven, `${probe}:${outcome}`);
  }
  return violations;
}
