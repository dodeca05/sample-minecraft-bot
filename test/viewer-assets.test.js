'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { Worker } = require('node:worker_threads')
const { Vec3 } = require('vec3')
const loadChunk = require('prismarine-chunk')
const loadData = require('minecraft-data')
const { createTranslator, DISPLAY_VERSION } = require('../bridge/viewer-compat')
const { loadViewerAssets } = require('../bridge/viewer-assets')

test('bundled viewer meshes sections below zero and above 255', { timeout: 20000 }, async (t) => {
  const sourceVersion = '26.1.2'
  const source = loadData(sourceVersion)
  const Chunk = loadChunk(sourceVersion)
  const column = new Chunk()
  column.setBlockStateId(new Vec3(2, -32, 2), source.blocksByName.stone.defaultState)
  column.setBlockStateId(new Vec3(2, 304, 2), source.blocksByName.oak_log.defaultState)

  const worker = new Worker(loadViewerAssets().worker, { eval: true })
  t.after(() => worker.terminate())
  const blockStates = require(`prismarine-viewer/public/blocksStates/${DISPLAY_VERSION}.json`)
  const geometry = new Map()

  const rendered = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('High/low sections did not render')), 15000)
    worker.on('error', (error) => { clearTimeout(timeout); reject(error) })
    worker.on('message', (message) => {
      if (message.type !== 'geometry') return
      geometry.set(message.key, message.geometry)
      if (geometry.has('0,-32,0') && geometry.has('0,304,0')) {
        clearTimeout(timeout)
        resolve()
      }
    })
  })

  worker.postMessage({ type: 'version', version: DISPLAY_VERSION })
  worker.postMessage({ type: 'blockStates', json: blockStates })
  worker.postMessage({ type: 'chunk', x: 0, z: 0, chunk: createTranslator(sourceVersion).chunk(column) })
  worker.postMessage({ type: 'dirty', x: 0, y: -32, z: 0, value: true })
  worker.postMessage({ type: 'dirty', x: 0, y: 304, z: 0, value: true })
  await rendered
  assert.ok(geometry.get('0,-32,0').positions.length > 0, 'below zero block should have visible faces')
  assert.ok(geometry.get('0,304,0').positions.length > 0, 'above 255 block should have visible faces')
})
