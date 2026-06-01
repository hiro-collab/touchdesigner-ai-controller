const assert = require('node:assert/strict')
const test = require('node:test')

const helper = require('../tools/send-touchdesigner-udp-fuzz')

test('TouchDesigner UDP fuzz helper defaults to bounded dry-run plan', () => {
  const config = helper.parseArgs(['--run-id', 'rr002_test'])
  const packets = helper.buildPackets(config)

  helper.validateConfig(config, packets.length)

  assert.equal(config.dryRun, true)
  assert.equal(config.host, '127.0.0.1')
  assert.equal(config.port, 9001)
  assert.equal(config.intervalMs, helper.MIN_INTERVAL_MS)
  assert.equal(packets.length, 9)
  assert.ok(packets.length <= helper.MAX_PACKETS)
  assert.ok(packets.some((packet) => packet.caseId === 'td-udp-005' && !packet.json))
  assert.ok(packets.some((packet) => packet.caseId === 'td-udp-006' && packet.json))
})

test('TouchDesigner UDP fuzz helper requires explicit send mode for live packets', () => {
  assert.equal(helper.parseArgs([]).dryRun, true)
  assert.equal(helper.parseArgs(['--send']).dryRun, false)
  assert.equal(helper.parseArgs(['--send', '--dry-run']).dryRun, true)
})

test('TouchDesigner UDP fuzz helper rejects broad network and too-fast sends', () => {
  const nonLoopback = helper.parseArgs(['--host', '192.168.1.10'])
  assert.throws(
    () => helper.validateConfig(nonLoopback, 1),
    /host_must_be_numeric_ipv4_loopback/
  )

  const hostname = helper.parseArgs(['--host', 'localhost'])
  assert.throws(
    () => helper.validateConfig(hostname, 1),
    /host_must_be_numeric_ipv4_loopback/
  )

  const tooFast = helper.parseArgs(['--interval-ms', '999'])
  assert.throws(
    () => helper.validateConfig(tooFast, 1),
    /interval_ms_below_minimum/
  )
})

test('TouchDesigner UDP fuzz helper rejects unknown cases and oversize batches', () => {
  assert.throws(
    () => helper.parseArgs(['--cases', 'td-udp-999']),
    /unknown_case:td-udp-999/
  )

  const config = helper.parseArgs(['--cases', 'td-udp-001'])
  assert.throws(
    () => helper.validateConfig(config, helper.MAX_PACKETS + 1),
    /packet_count_exceeds_limit/
  )
})
