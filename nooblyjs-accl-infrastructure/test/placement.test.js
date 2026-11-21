// Placement (spec 8.2 R3, R4; task 8.2.2) as a pure function: a workload's instances spread over hosts, a host is never
// reserved beyond its allocatable on a pool, a LAN site may over-commit CPU (never memory), draining hosts take nothing,
// and when the instances do not fit the answer is grow (when the pool may) or full.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { place, reservations } from '../src/platform/placement.js';

const host = (id, cpu = 3.75, memoryMb = 7680, extra = {}) => ({ id, name: id, allocatable: { cpu, memoryMb }, ...extra });
const small = { cpu: 0.5, memoryMb: 512 };

test('a workload\'s instances go to different hosts, then the least reserved; the order hosts are listed in does not matter', () => {
  const hosts = [host('h-b'), host('h-a'), host('h-c')];
  assert.deepEqual(place({ hosts, plan: small, count: 3, workload: 't/web' }).hosts.sort(), ['h-a', 'h-b', 'h-c']);
  // h-a already has one of this workload; h-b is busier with others' instances than h-c.
  const instances = [
    { host: 'h-a', cpu: 0.5, memoryMb: 512, workload: 't/web' },
    { host: 'h-b', cpu: 2, memoryMb: 4096, workload: 'u/api' },
  ];
  assert.deepEqual(place({ hosts, instances, plan: small, count: 2, workload: 't/web' }).hosts, ['h-c', 'h-b']);
  assert.deepEqual(place({ hosts: [...hosts].reverse(), instances, plan: small, count: 2, workload: 't/web' }).hosts, ['h-c', 'h-b']);
  // One host: every instance goes there.
  assert.deepEqual(place({ hosts: [host('h-a')], plan: small, count: 3, workload: 't/web' }).hosts, ['h-a', 'h-a', 'h-a']);
});

test('a pool host is never reserved beyond its allocatable CPU or memory', () => {
  const hosts = [host('h-a', 1.75, 3584)];
  const plan = { cpu: 1, memoryMb: 1024 };
  let r = place({ hosts, plan, count: 2 });
  assert.deepEqual([r.hosts, r.missing, r.full], [['h-a'], 1, true], '1.75 vCPU holds one 1 vCPU instance, not two');
  r = place({ hosts, plan: { cpu: 0.25, memoryMb: 2048 }, count: 2 });
  assert.deepEqual([r.hosts.length, r.missing], [1, 1], '3584 MB holds one 2048 MB instance');
  // Exactly full is allowed (floating point included).
  assert.deepEqual(place({ hosts: [host('h-a', 0.3, 768)], plan: { cpu: 0.1, memoryMb: 256 }, count: 3 }).hosts, ['h-a', 'h-a', 'h-a']);
  const left = reservations(hosts, [{ host: 'h-a', cpu: 1, memoryMb: 1024 }]);
  assert.deepEqual(left, [{ id: 'h-a', instances: 1, reserved: { cpu: 1, memoryMb: 1024 }, free: { cpu: 0.75, memoryMb: 2560 } }]);
});

test('a LAN site may over-commit CPU (a quarter of the plan must be free) but never memory', () => {
  const hosts = [host('srv', 1, 8192)];
  const plan = { cpu: 1, memoryMb: 1024 };
  assert.equal(place({ hosts, plan, count: 4, cpuFloor: 0.25 }).hosts.length, 1, 'after one, no CPU is left at all');
  assert.equal(place({ hosts: [host('srv', 2, 8192)], plan, count: 4, cpuFloor: 0.25 }).hosts.length, 2);
  assert.equal(place({ hosts: [host('srv', 2.5, 8192)], plan, count: 4, cpuFloor: 0.25 }).hosts.length, 3, 'a quarter vCPU is still free for the third');
  assert.equal(place({ hosts: [host('srv', 64, 2048)], plan, count: 4, cpuFloor: 0.25 }).hosts.length, 2, 'memory decides');
});

test('a draining host takes nothing; nothing fits means grow when the pool may, full when it may not', () => {
  const hosts = [host('h-a', 3.75, 7680, { draining: true }), host('h-b', 0.5, 512)];
  assert.deepEqual(place({ hosts, plan: small, count: 1 }).hosts, ['h-b']);
  assert.deepEqual(place({ hosts, plan: small, count: 2, canGrow: true }), { hosts: ['h-b'], missing: 1, grow: true });
  assert.deepEqual(place({ hosts, plan: small, count: 2 }), { hosts: ['h-b'], missing: 1, full: true });
  assert.deepEqual(place({ hosts: [], plan: small, count: 1 }), { hosts: [], missing: 1, full: true });
  assert.throws(() => place({ hosts, plan: { cpu: 0 }, count: 1 }), /needs a plan/);
});
