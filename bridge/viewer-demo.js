'use strict'

const { EventEmitter } = require('node:events')
const readline = require('node:readline')
const { Vec3 } = require('vec3')
const { startViewer } = require('./viewer')

// Generate real 26.1.2 chunk objects; exercise the same translation as a live bot.
function createDemoBot() {
  const version = '26.1.2'
  const data = require('minecraft-data')(version)
  const Chunk = require('prismarine-chunk')(version)
  const World = require('prismarine-world')(version)
  const bot = new EventEmitter()
  bot.version = version
  bot.username = 'offline_demo'
  bot.entities = {}
  bot.entity = { position: new Vec3(8.5, 63, 13.5), yaw: 0, pitch: -0.12 }
  bot.world = new World((cx, cz) => {
    const chunk = new Chunk()
    for (let y = chunk.minY; y < chunk.minY + chunk.worldHeight; y += 4) {
      for (let x = 0; x < 16; x += 4) {
        for (let z = 0; z < 16; z += 4) chunk.setBiome(new Vec3(x, y, z), data.biomesByName.plains.id)
      }
    }
    const put = (x, y, z, name) => chunk.setBlockStateId(new Vec3(x, y, z), data.blocksByName[name].defaultState)
    for (let x = 0; x < 16; x++) {
      for (let z = 0; z < 16; z++) {
        put(x, 61, z, 'dirt')
        put(x, 62, z, 'grass_block')
      }
    }
    if (cx === 0 && cz === 0) {
      for (let y = 63; y < 69; y++) put(8, y, 5, 'oak_log')
      for (let x = 6; x <= 10; x++) {
        for (let z = 3; z <= 7; z++) {
          for (let y = 67; y <= 70; y++) {
            if (!(x === 8 && z === 5 && y < 69)) put(x, y, z, 'oak_leaves')
          }
        }
      }
      put(5, 63, 7, 'crafting_table')
      put(11, 63, 7, 'white_bed') // Its numeric state IDs differ between these versions.
      put(11, 63, 8, 'copper_chest') // A newer block intentionally shown as a placeholder.
    }
    return chunk
  })
  return bot
}

async function main() {
  const viewer = await startViewer(createDemoBot(), { port: Number(process.env.VIEWER_PORT || 3007), viewDistance: 2, demo: true })
  const emit = (event, payload) => process.stdout.write(JSON.stringify({ event, ...payload }) + '\n')
  emit('viewer_started', { url: viewer.url })
  const input = readline.createInterface({ input: process.stdin })
  let closing = false
  const close = async () => {
    if (closing) return
    closing = true
    input.close()
    await viewer.close()
  }
  input.on('line', (line) => {
    try {
      const command = JSON.parse(line)
      if (command.action === 'quit') {
        emit('command_result', { id: command.id, ok: true, result: { quitting: true } })
        void close()
      }
    } catch (_) {}
  })
  input.on('close', close)
  process.on('SIGINT', close)
  process.on('SIGTERM', close)
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(error.stack + '\n')
    process.exitCode = 1
  })
}
module.exports = { createDemoBot }
