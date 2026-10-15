'use strict'

const minecraftData = require('minecraft-data')
const loadBlock = require('prismarine-block')
const BitArray = require('prismarine-chunk/src/pc/common/BitArrayNoSpan')

// This is a display format only. The bot still speaks its actual server version.
const DISPLAY_VERSION = '1.21.4'

function createTranslator(sourceVersion) {
  const source = minecraftData(sourceVersion)
  const target = minecraftData(DISPLAY_VERSION)
  if (!source) throw new Error(`뷰어 변환에 필요한 버전 데이터가 없습니다: ${sourceVersion}`)
  const SourceBlock = loadBlock(sourceVersion)
  const TargetBlock = loadBlock(DISPLAY_VERSION)
  const states = new Map()
  const approximated = new Set()

  function state(id) {
    if (states.has(id)) return states.get(id)
    const block = SourceBlock.fromStateId(id, 0)
    const definition = target.blocksByName[block.name]
    let result = target.blocksByName.magenta_concrete.defaultState
    if (definition) {
      const properties = TargetBlock.fromStateId(definition.defaultState, 0).getProperties()
      const original = block.getProperties()
      for (const property of definition.states || []) {
        const value = original[property.name]
        const valid = property.values
          ? property.values.includes(String(value))
          : property.type === 'bool'
            ? typeof value === 'boolean'
            : Number.isInteger(value) && value >= 0 && value < property.num_values
        if (valid) properties[property.name] = value
        else if (value !== undefined) approximated.add(block.name)
      }
      try {
        result = TargetBlock.fromProperties(block.name, properties, 0).stateId
        if (result < definition.minStateId || result > definition.maxStateId) throw new Error('Invalid mapped state')
      } catch (_) {
        result = definition.defaultState
        approximated.add(block.name)
      }
    } else {
      approximated.add(block.name || `state:${id}`)
    }
    states.set(id, result)
    return result
  }

  function biome(id) {
    return target.biomesByName[source.biomes[id]?.name]?.id ?? target.biomesByName.plains.id
  }

  function chunk(column) {
    // Do not mutate Mineflayer's chunks or reuse numeric IDs across versions.
    const data = JSON.parse(column.toJson())
    data.sections = data.sections.map((json) => {
      if (json === null) return null
      const section = JSON.parse(json)
      section.data = translateContainer(section.data, state)
      section.noSizePrefix = false
      section.hasFluidCount = false
      return JSON.stringify(section)
    })
    data.biomes = data.biomes.map((json) => translateContainer(json, biome))
    return JSON.stringify(data)
  }

  return { state, chunk, approximated, sourceVersion, displayVersion: DISPLAY_VERSION }
}

function translateContainer(json, translate) {
  const container = JSON.parse(json)
  if (container.type === 'single') {
    container.value = translate(container.value)
  } else if (container.type === 'indirect') {
    container.palette = container.palette.map(translate)
  } else if (container.type === 'direct') {
    // The bundled client's direct-container JSON reader loses its packed data.
    // Emit an indirect palette instead, including for high-diversity sections.
    const original = BitArray.fromJson(container.data)
    const palette = []
    const indices = new Map()
    const values = []
    for (let i = 0; i < original.capacity; i++) {
      const value = translate(original.get(i))
      if (!indices.has(value)) {
        indices.set(value, palette.length)
        palette.push(value)
      }
      values.push(indices.get(value))
    }
    const packed = new BitArray({
      capacity: original.capacity,
      bitsPerValue: Math.max(4, Math.ceil(Math.log2(palette.length)))
    })
    values.forEach((value, index) => packed.set(index, value))
    return JSON.stringify({ type: 'indirect', palette, data: packed.toJson(), maxBits: 15, maxBitsPerBlock: 15 })
  } else {
    throw new Error(`알 수 없는 청크 팔레트 형식: ${container.type}`)
  }
  return JSON.stringify(container)
}

module.exports = { createTranslator, DISPLAY_VERSION }
