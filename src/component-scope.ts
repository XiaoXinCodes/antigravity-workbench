import { LiveError } from './live-storage';
import type { ComponentBirth, ComponentCensus } from './component-coordination';
export interface ComponentHubOwner { hub: ComponentBirth; parentPid: number }
const key = (birth: ComponentBirth): string => `${birth.pid}:${birth.startIdentity}`;
/** Keep only actual related Hub owners and this transaction's retained hosts.
 * Empty unrelated extension hosts do not need a component actor. Still retain
 * all scope-proven Hubs so a new writer cannot disappear from the census. */
export function relatedComponentCensus(snapshot: ComponentCensus, initiating: ComponentBirth,
  owners: readonly ComponentHubOwner[], retained: readonly ComponentBirth[] = []): ComponentCensus {
  if (!snapshot.complete || snapshot.unknown) throw new LiveError('COMPONENT_CENSUS_UNVERIFIED');
  const selected = new Map<string, ComponentBirth>();
  for (const host of [initiating, ...retained]) {
    if (!snapshot.hosts.some(value => key(value) === key(host))) throw new LiveError('COMPONENT_PARTICIPANTS_CHANGED');
    selected.set(key(host), host);
  }
  for (const hub of snapshot.hubs) {
    const matches = owners.filter(value => key(value.hub) === key(hub));
    if (matches.length !== 1) throw new LiveError('COMPONENT_CENSUS_UNVERIFIED');
    const host = snapshot.hosts.find(value => value.pid === matches[0]!.parentPid);
    if (!host) throw new LiveError('COMPONENT_PARTICIPANT_UNAVAILABLE');
    selected.set(key(host), host);
  }
  return { complete: true, unknown: false, hosts: [...selected.values()], hubs: snapshot.hubs };
}
