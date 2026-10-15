'use strict'

const path = require('node:path')
const fs = require('node:fs')
const http = require('node:http')
const express = require('express')
const compression = require('compression')
const { Server } = require('socket.io')
const { WorldView } = require('prismarine-viewer/viewer/lib/worldView')
const { createTranslator } = require('./viewer-compat')
const { loadViewerAssets } = require('./viewer-assets')

async function startViewer(bot, { port = 3007, viewDistance = 4, demo = false } = {}) {
  const translator = createTranslator(bot.version)
  const assets = loadViewerAssets()
  const app = express()
  const server = http.createServer(app)
  const io = new Server(server)
  let ended = false
  let lastError = null
  const state = () => ({
    mode: demo ? 'demo' : 'live',
    sourceVersion: bot.version,
    displayVersion: translator.displayVersion,
    connected: !ended,
    error: lastError,
    approximated: [...translator.approximated]
  })

  app.use(compression())
  app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'viewer.html')))
  app.get('/status', (_, res) => res.set('Cache-Control', 'no-store').json(state()))
  app.get('/index.js', (_, res) => res.type('js').send(assets.index))
  app.get('/worker.js', (_, res) => res.type('js').send(assets.worker))
  app.get('/favicon.ico', (_, res) => res.status(204).end())
  const publicDir = path.join(path.dirname(require.resolve('prismarine-viewer')), 'public')
  for (const asset of [`textures/${translator.displayVersion}.png`, `blocksStates/${translator.displayVersion}.json`]) {
    if (!fs.existsSync(path.join(publicDir, asset))) throw new Error(`뷰어 리소스 누락: ${asset}. npm ci로 복원하세요.`)
  }
  app.use(express.static(publicDir))

  const onEnd = () => { ended = true }
  bot.once('end', onEnd)

  io.on('connection', (socket) => {
    if (ended) return socket.disconnect(true)
    socket.emit('version', translator.displayVersion)
    const report = (error) => {
      lastError = error.message
      socket.emit('viewer_error', { message: error.message })
    }
    const world = {
      async getColumnAt(position) {
        const column = await bot.world.getColumnAt(position)
        return column ? { toJson: () => translator.chunk(column) } : null
      },
      raycast: (...args) => bot.world.raycast(...args)
    }
    // WorldView's bot listeners also forward live block changes, not just chunks.
    const emitter = {
      on: (...args) => socket.on(...args),
      emit(event, packet) {
        if (!socket.connected) return
        if (event === 'blockUpdate') packet = { ...packet, stateId: translator.state(packet.stateId) }
        socket.emit(event, packet)
      }
    }
    const view = new WorldView(world, viewDistance, bot.entity.position, emitter)
    const originalLoad = view.loadChunk.bind(view)
    view.loadChunk = (position) => originalLoad(position).catch(report)
    const position = () => {
      socket.emit('position', {
        pos: bot.entity.position,
        yaw: bot.entity.yaw,
        pitch: bot.entity.pitch,
        addMesh: false
      })
      view.updatePosition(bot.entity.position).catch(report)
    }
    position() // Stock viewer waits for movement, leaving stationary bots without a camera.
    view.listenToBot(bot)
    bot.on('move', position)
    view.init(bot.entity.position).catch(report)
    socket.on('disconnect', () => {
      bot.removeListener('move', position)
      view.removeListenersFromBot(bot)
      view.loadChunk = async () => {} // Stop outstanding initial-load batches.
    })
  })

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
  } catch (error) {
    bot.removeListener('end', onEnd)
    io.close()
    throw error
  }
  return {
    url: `http://localhost:${server.address().port}`,
    state,
    close() {
      bot.removeListener('end', onEnd)
      return new Promise((resolve) => io.close(resolve))
    }
  }
}

module.exports = { startViewer }
