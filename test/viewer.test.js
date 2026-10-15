'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { io } = require('socket.io-client')
const { Vec3 } = require('vec3')
const loadData = require('minecraft-data')
const loadBlock = require('prismarine-block')
const loadChunk = require('prismarine-chunk')
const { SingleValueContainer, DirectPaletteContainer } = require('prismarine-chunk/src/pc/common/PaletteContainer')
const { createTranslator, DISPLAY_VERSION } = require('../bridge/viewer-compat')
const { startViewer } = require('../bridge/viewer')
const { createDemoBot } = require('../bridge/viewer-demo')

const SOURCE_VERSION = '26.1.2'
const sourceData = loadData(SOURCE_VERSION)
const targetData = loadData(DISPLAY_VERSION)
const SourceBlock = loadBlock(SOURCE_VERSION)
const TargetBlock = loadBlock(DISPLAY_VERSION)
const SourceChunk = loadChunk(SOURCE_VERSION)
const TargetChunk = loadChunk(DISPLAY_VERSION)

function nextEvent(emitter, name) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(name, onEvent)
      reject(new Error(`Timed out waiting for ${name}`))
    }, 5000)
    const onEvent = (value) => {
      clearTimeout(timer)
      resolve(value)
    }
    emitter.once(name, onEvent)
  })
}

test('maps shifted state IDs by name and preserves bed/stair properties', () => {
  const translator = createTranslator(SOURCE_VERSION)
  const cases = [
    ['white_bed', { part: 'head', occupied: true, facing: 'east' }],
    ['oak_stairs', { facing: 'west', half: 'top', shape: 'inner_left', waterlogged: true }]
  ]
  for (const [name, properties] of cases) {
    const original = SourceBlock.fromProperties(name, properties, 0)
    const mapped = TargetBlock.fromStateId(translator.state(original.stateId), 0)
    assert.notEqual(original.stateId, mapped.stateId, 'fixture must exercise shifted IDs')
    assert.equal(mapped.name, name)
    assert.deepEqual(mapped.getProperties(), original.getProperties())
  }
})

test('newer blocks become an explicit placeholder rather than an unrelated block', () => {
  const translator = createTranslator(SOURCE_VERSION)
  const unknown = sourceData.blocksByName.copper_chest
  assert.equal(targetData.blocksByName.copper_chest, undefined)
  assert.equal(translator.state(unknown.defaultState), targetData.blocksByName.magenta_concrete.defaultState)
  assert.deepEqual([...translator.approximated], ['copper_chest'])
})

test('single, indirect and direct chunk palettes decode without changing source chunks', () => {
  const translator = createTranslator(SOURCE_VERSION)
  const chunk = new SourceChunk({ minY: -64, worldHeight: 384 })
  const bed = sourceData.blocksByName.white_bed.defaultState
  chunk.sections[0].data = new SingleValueContainer({ value: bed, capacity: 4096 })
  chunk.sections[0].solidBlockCount = 4096
  chunk.setBlockStateId(new Vec3(2, -48, 3), sourceData.blocksByName.oak_stairs.defaultState)
  chunk.sections[2].data = new DirectPaletteContainer({ bitsPerValue: 16, capacity: 4096 })
  for (let i = 0; i < 4096; i++) chunk.sections[2].data.set(i, i % 300)
  chunk.sections[2].solidBlockCount = 4082
  chunk.biomes[0].data = new SingleValueContainer({ value: sourceData.biomesByName.forest.id, capacity: 64 })
  chunk.setBiome(new Vec3(4, -48, 4), sourceData.biomesByName.desert.id)
  chunk.biomes[2].data = new DirectPaletteContainer({ bitsPerValue: 7, capacity: 64 })
  const biomes = Object.values(sourceData.biomes)
  for (let i = 0; i < 64; i++) chunk.biomes[2].data.set(i, biomes[i % biomes.length].id)

  const before = chunk.toJson()
  const translated = translator.chunk(chunk)
  assert.equal(chunk.toJson(), before)
  const json = JSON.parse(translated)
  assert.equal(json.minY, -64)
  assert.equal(json.worldHeight, 384)
  assert.deepEqual(json.sections.slice(0, 3).map((section) => JSON.parse(JSON.parse(section).data).type), ['single', 'indirect', 'indirect'])
  const decoded = TargetChunk.fromJson(translated)
  assert.equal(decoded.getBlock(new Vec3(0, -64, 0)).name, 'white_bed')
  assert.equal(decoded.getBlock(new Vec3(2, -48, 3)).name, 'oak_stairs')
  assert.equal(decoded.getBlock(new Vec3(3, -48, 3)).name, 'air')
  assert.equal(decoded.getBiome(new Vec3(0, -64, 0)), targetData.biomesByName.forest.id)
  assert.equal(decoded.getBiome(new Vec3(4, -48, 4)), targetData.biomesByName.desert.id)
  for (let i = 0; i < 4096; i++) assert.equal(decoded.sections[2].data.get(i), translator.state(i % 300))
  for (let i = 0; i < 64; i++) {
    const name = biomes[i % biomes.length].name
    assert.equal(decoded.biomes[2].data.get(i), (targetData.biomesByName[name] || targetData.biomesByName.plains).id)
  }
})

test('offline viewer serves assets, initializes a stationary camera, streams chunks and closes', { timeout: 15000 }, async (t) => {
  const bot = createDemoBot()
  const viewer = await startViewer(bot, { port: 0, viewDistance: 1, demo: true })
  t.after(() => viewer.close())
  const url = viewer.url.replace('localhost', '127.0.0.1')
  const page = await fetch(url)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /<canvas|index\.js/)
  for (const asset of ['/index.js', '/worker.js', `/textures/${DISPLAY_VERSION}.png`, `/blocksStates/${DISPLAY_VERSION}.json`]) {
    const response = await fetch(url + asset)
    assert.equal(response.status, 200, asset)
    assert.ok((await response.arrayBuffer()).byteLength > 100, asset)
  }
  const status = await (await fetch(url + '/status')).json()
  assert.equal(status.mode, 'demo')
  assert.equal(status.sourceVersion, SOURCE_VERSION)
  assert.equal(status.displayVersion, DISPLAY_VERSION)
  assert.equal(status.connected, true)

  const socket = io(url, { autoConnect: false, transports: ['websocket'], reconnection: false })
  t.after(() => socket.close())
  const events = []
  socket.onAny((event) => events.push(event))
  const version = nextEvent(socket, 'version')
  const position = nextEvent(socket, 'position')
  const chunkPacket = nextEvent(socket, 'loadChunk')
  socket.connect()
  assert.equal(await version, DISPLAY_VERSION)
  const initial = await position // No move event has been emitted on the bot.
  assert.deepEqual(initial.pos, { x: 8.5, y: 63, z: 13.5 })
  assert.equal(initial.yaw, bot.entity.yaw)
  assert.equal(initial.pitch, bot.entity.pitch)
  assert.ok(events.indexOf('version') < events.indexOf('position'))
  const packet = await chunkPacket
  assert.equal(packet.x, 0)
  assert.equal(packet.z, 0)
  const chunk = TargetChunk.fromJson(packet.chunk)
  assert.equal(chunk.getBlock(new Vec3(8, 63, 5)).name, 'oak_log')
  assert.equal(chunk.getBlock(new Vec3(11, 63, 7)).name, 'white_bed')
  assert.equal(chunk.getBlock(new Vec3(11, 63, 8)).name, 'magenta_concrete')

  const update = nextEvent(socket, 'blockUpdate')
  const changedAt = new Vec3(5, 63, 7)
  bot.emit('blockUpdate', { position: changedAt }, { stateId: sourceData.blocksByName.white_bed.defaultState })
  assert.deepEqual(await update, { pos: { x: 5, y: 63, z: 7 }, stateId: targetData.blocksByName.white_bed.defaultState })
  const disconnect = nextEvent(socket, 'disconnect')
  await viewer.close()
  await disconnect
  for (const event of ['move', 'blockUpdate', 'chunkColumnLoad', 'entitySpawn', 'entityMoved', 'entityGone', 'end']) {
    assert.equal(bot.listenerCount(event), 0, event)
  }
})

test('a busy localhost port rejects cleanly without retaining bot listeners', { timeout: 10000 }, async (t) => {
  const viewer = await startViewer(createDemoBot(), { port: 0, viewDistance: 1 })
  t.after(() => viewer.close())
  const bot = createDemoBot()
  await assert.rejects(startViewer(bot, { port: Number(new URL(viewer.url).port) }), { code: 'EADDRINUSE' })
  assert.equal(bot.listenerCount('end'), 0)
})
