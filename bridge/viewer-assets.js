'use strict'

const fs = require('node:fs')
const path = require('node:path')

// prismarine-viewer 1.33.0 ships a browser bundle that still assumes y=0..255.
// Adapt the served copy, leaving the installed dependency untouched.
function replaceExactly(source, before, after, count, label) {
  const matches = source.split(before)
  if (matches.length - 1 !== count) {
    throw new Error(`Viewer asset patch ${label}: expected ${count} matches, found ${matches.length - 1}`)
  }
  return matches.join(after)
}

function loadViewerAssets() {
  const packagePath = require.resolve('prismarine-viewer/package.json')
  const metadata = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
  if (metadata.version !== '1.33.0') {
    throw new Error(`Viewer asset patches require prismarine-viewer 1.33.0; found ${metadata.version}`)
  }

  const publicDir = path.join(path.dirname(packagePath), 'public')
  let index = fs.readFileSync(path.join(publicDir, 'index.js'), 'utf8')
  let worker = fs.readFileSync(path.join(publicDir, 'worker.js'), 'utf8')

  index = replaceExactly(
    index,
    'addColumn(t,e,i){this.loadedChunks[`${t},${e}`]=!0;',
    'addColumn(t,e,i){const {minY=0,worldHeight=256}=JSON.parse(i);this.loadedChunks[`${t},${e}`]={minY,worldHeight};',
    1,
    'remember column height'
  )
  index = replaceExactly(
    index,
    'removeColumn(t,e){delete this.loadedChunks[`${t},${e}`];',
    'removeColumn(t,e){const {minY=0,worldHeight=256}=this.loadedChunks[`${t},${e}`]||{};delete this.loadedChunks[`${t},${e}`];',
    1,
    'restore column height on unload'
  )
  index = replaceExactly(
    index,
    'for(let i=0;i<256;i+=16)',
    'for(let i=minY;i<minY+worldHeight;i+=16)',
    2,
    'render and unload the full column'
  )

  worker = replaceExactly(
    worker,
    'i.sections[Math.floor(a/16)]',
    'i.sections[Math.floor((a-i.minY)/16)]',
    1,
    'queue section relative to minY'
  )
  worker = replaceExactly(
    worker,
    'l.sections[Math.floor(n/16)]',
    'l.sections[Math.floor((n-l.minY)/16)]',
    1,
    'render section relative to minY'
  )
  for (const snippet of ['if(g.position.y<0)continue;', 'if(n.position.y<0)continue']) {
    worker = replaceExactly(
      worker,
      snippet,
      '',
      1,
      `render negative-Y faces (${snippet})`
    )
  }

  return { index, worker }
}

module.exports = { loadViewerAssets }
