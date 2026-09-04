'use strict'

const readline = require('node:readline')
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals: { GoalGetToBlock } } = require('mineflayer-pathfinder')
const { mineflayer: startViewer } = require('prismarine-viewer')

function readInteger(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback

  const value = Number.parseInt(raw, 10)
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer, received: ${raw}`)
  return value
}

function readBoolean(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase())
}

function printable(value) {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch (_) {
    return String(value)
  }
}

function emit(event, payload = {}) {
  process.stdout.write(`${JSON.stringify({ event, ...payload })}\n`)
}

const config = {
  host: process.env.MINECRAFT_HOST || '192.168.50.210',
  port: readInteger('MINECRAFT_PORT', 25565),
  username: process.env.MINECRAFT_USERNAME || 'python_bot',
  auth: process.env.MINECRAFT_AUTH || 'offline',
  version: process.env.MINECRAFT_VERSION || undefined,
  viewerEnabled: readBoolean('VIEWER_ENABLED', true),
  viewerPort: readInteger('VIEWER_PORT', 3007)
}

const botOptions = {
  host: config.host,
  port: config.port,
  username: config.username,
  auth: config.auth,
  profilesFolder: '.minecraft-profiles'
}
if (config.version) botOptions.version = config.version

let bot
let spawned = false
let shuttingDown = false
let harvestJob = null
let logBlockIds = []
let leafBlockIds = []

try {
  bot = mineflayer.createBot(botOptions)
  bot.loadPlugin(pathfinder)
} catch (error) {
  emit('error', { message: error.message, fatal: true })
  process.exitCode = 1
  return
}

emit('connecting', {
  host: config.host,
  port: config.port,
  username: config.username,
  auth: config.auth
})

bot.once('spawn', () => {
  spawned = true
  configureHarvesting()
  emit('spawn', { username: bot.username })

  if (!config.viewerEnabled) return
  try {
    const viewerResult = startViewer(bot, {
      port: config.viewerPort,
      firstPerson: true,
      viewDistance: 6
    })
    if (viewerResult && typeof viewerResult.catch === 'function') {
      viewerResult.catch((error) => emit('viewer_error', { message: error.message }))
    }
    emit('viewer_started', { url: `http://localhost:${config.viewerPort}` })
  } catch (error) {
    emit('viewer_error', { message: error.message })
  }
})

bot.on('chat', (username, message) => emit('chat', { username, message }))
bot.on('death', stopHarvest)
bot.on('kicked', (reason, loggedIn) => {
  emit('kicked', { reason: printable(reason), loggedIn })
})
bot.on('error', (error) => {
  emit('error', { message: error.message, code: error.code || null, fatal: false })
})
bot.on('end', (reason) => {
  spawned = false
  stopHarvest()
  emit('end', { reason: printable(reason) })
  input.close()
  setTimeout(() => process.exit(0), 25)
})

function configureHarvesting() {
  const blocks = Object.values(bot.registry.blocksByName)
  logBlockIds = blocks
    .filter((block) => block.name.endsWith('_log') && !block.name.startsWith('stripped_'))
    .map((block) => block.id)
  leafBlockIds = blocks
    .filter((block) => block.name.endsWith('_leaves'))
    .map((block) => block.id)

  const movements = new Movements(bot)
  movements.canDig = false
  movements.allow1by1towers = false
  movements.allowParkour = false
  movements.maxDropDown = 2
  movements.scafoldingBlocks = []
  bot.pathfinder.setMovements(movements)
}

function lowestConnectedLog(block) {
  let current = block
  for (let depth = 0; depth < 16; depth += 1) {
    const below = bot.blockAt(current.position.offset(0, -1, 0))
    if (!below || !logBlockIds.includes(below.type)) break
    current = below
  }
  return current
}

function findNaturalLog(maxDistance) {
  const positions = bot.findBlocks({ matching: logBlockIds, maxDistance, count: 128 })

  for (const position of positions) {
    const candidate = bot.blockAt(position)
    if (!candidate) continue

    // Leaves near a log are a simple guard against mining wooden buildings.
    const nearbyLeaf = bot.findBlock({
      matching: leafBlockIds,
      point: candidate.position,
      maxDistance: 6
    })
    if (nearbyLeaf) return lowestConnectedLog(candidate)
  }
  return null
}

async function withTimeout(promise, timeoutMs, message) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

function stopHarvest() {
  if (!harvestJob) return
  harvestJob.cancelled = true
  bot.pathfinder.setGoal(null)
  if (bot.targetDigBlock) bot.stopDigging()
  bot.clearControlStates()
}

function completeHarvest(job, reason) {
  emit('harvest_complete', {
    mined: job.mined,
    requested: job.count,
    reason
  })
}

async function runHarvest(job) {
  try {
    // Without this wait an immediate scan can run before nearby chunks arrive.
    await bot.waitForChunksToLoad()

    while (job.mined < job.count && !job.cancelled) {
      const target = findNaturalLog(job.maxDistance)
      if (!target) {
        completeHarvest(
          job,
          job.mined === 0 ? 'no_natural_tree_found' : 'no_more_logs_found'
        )
        return
      }

      emit('harvest_target', {
        block: target.name,
        position: { x: target.position.x, y: target.position.y, z: target.position.z }
      })

      if (!bot.canDigBlock(target)) {
        try {
          await withTimeout(
            bot.pathfinder.goto(
              new GoalGetToBlock(target.position.x, target.position.y, target.position.z)
            ),
            15_000,
            '나무까지 이동하는 데 시간이 너무 오래 걸렸습니다.'
          )
        } catch (error) {
          if (job.cancelled) return
          bot.pathfinder.setGoal(null)
          completeHarvest(job, 'tree_unreachable')
          return
        }
      }

      if (job.cancelled) break
      const currentBlock = bot.blockAt(target.position)
      if (!currentBlock || !logBlockIds.includes(currentBlock.type)) continue
      if (!bot.canDigBlock(currentBlock)) {
        completeHarvest(job, 'tree_unreachable')
        return
      }

      const tool = bot.pathfinder.bestHarvestTool(currentBlock)
      if (tool) await bot.equip(tool, 'hand')
      await withTimeout(bot.dig(currentBlock, true), 10_000, '나무를 캐지 못했습니다.')
      job.mined += 1

      emit('harvest_progress', {
        mined: job.mined,
        requested: job.count,
        block: currentBlock.name,
        position: {
          x: currentBlock.position.x,
          y: currentBlock.position.y,
          z: currentBlock.position.z
        }
      })
      await bot.waitForTicks(5)
    }

    if (!job.cancelled) completeHarvest(job, 'requested_count_reached')
  } catch (error) {
    if (!job.cancelled) {
      emit('harvest_error', {
        mined: job.mined,
        requested: job.count,
        message: error.message
      })
    }
  } finally {
    bot.pathfinder.setGoal(null)
    bot.clearControlStates()
    if (harvestJob === job) harvestJob = null
  }
}

function startHarvest(count, maxDistance) {
  if (!spawned) throw new Error('The bot has not spawned yet')
  if (harvestJob) throw new Error('A harvest job is already running')
  if (logBlockIds.length === 0 || leafBlockIds.length === 0) {
    throw new Error(`Tree blocks are unavailable for Minecraft ${bot.version}`)
  }

  const job = {
    count,
    maxDistance,
    mined: 0,
    cancelled: false
  }
  harvestJob = job
  void runHarvest(job)
  return job
}

function commandInteger(value, fallback, minimum, maximum, name) {
  const number = value === undefined ? fallback : Number(value)
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`)
  }
  return number
}

async function executeCommand(command) {
  switch (command.action) {
    case 'chat': {
      if (!spawned) throw new Error('The bot has not spawned yet')
      const message = String(command.message || '').trim()
      if (!message) throw new Error('chat.message cannot be empty')
      bot.chat(message)
      return { sent: true }
    }
    case 'harvest_logs': {
      const count = commandInteger(command.count, 8, 1, 64, 'harvest_logs.count')
      const maxDistance = commandInteger(command.maxDistance, 32, 8, 64, 'harvest_logs.maxDistance')
      const job = startHarvest(count, maxDistance)
      return { count: job.count, maxDistance: job.maxDistance }
    }
    case 'quit': {
      const reason = String(command.reason || 'Python controller stopped')
      shuttingDown = true
      stopHarvest()
      bot.quit(reason)
      return { quitting: true }
    }
    default:
      throw new Error(`Unsupported action: ${command.action}`)
  }
}

async function handleLine(line) {
  let command
  try {
    command = JSON.parse(line)
  } catch (error) {
    emit('protocol_error', { message: `Invalid JSON: ${error.message}` })
    return
  }

  const id = command.id ?? null
  try {
    const result = await executeCommand(command)
    emit('command_result', { id, ok: true, result })
  } catch (error) {
    emit('command_result', { id, ok: false, error: error.message })
  }
}

const input = readline.createInterface({ input: process.stdin, terminal: false })
input.on('line', (line) => {
  if (line.trim()) void handleLine(line)
})

function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  emit('shutdown', { signal })

  try {
    stopHarvest()
    bot.clearControlStates()
    bot.quit(`Received ${signal}`)
  } catch (_) {
    process.exit(0)
    return
  }
  setTimeout(() => process.exit(0), 1500)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
