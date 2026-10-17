// Renders stage frames from a demo render to PNG (dev-only visual check).
import fs from 'node:fs'
import zlib from 'node:zlib'
import { renderOffline } from '../../engine/render.mjs'
import { createViz, onTick, advance, draw } from '../../mod/hooks/stage.ts'
const COLS = 96, ROWS = 14, SCALE = 6
const r = renderOffline({ script: 'demo', seconds: 50 })
const viz = createViz(); viz.running = true
const shots = [6, 18, 30, 42]
const frames = []
let t = 0, ti = 0
for (const at of shots) {
  while (t < at * 1000) {
    while (ti < r.ticks.length && r.ticks[ti].sample / 48000 * 1000 <= t) onTick(viz, r.ticks[ti++])
    advance(viz, 33); t += 33
  }
  frames.push(draw(viz, COLS, ROWS, t))
}
const W = COLS * SCALE, H = ROWS * 2 * SCALE * frames.length + (frames.length - 1) * 8
const px = Buffer.alloc(W * H * 3, 40)
frames.forEach((cells, f) => {
  const oy = f * (ROWS * 2 * SCALE + 8)
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const o = (r * COLS + c) * 3
    for (const [half, col] of [[0, cells[o + 1]], [1, cells[o + 2]]]) {
      for (let dy = 0; dy < SCALE; dy++) for (let dx = 0; dx < SCALE; dx++) {
        const p = ((oy + (r * 2 + half) * SCALE + dy) * W + c * SCALE + dx) * 3
        px[p] = col >> 16 & 255; px[p + 1] = col >> 8 & 255; px[p + 2] = col & 255
      }
    }
  }
})
const raw = Buffer.alloc((W * 3 + 1) * H)
for (let y = 0; y < H; y++) { raw[y * (W * 3 + 1)] = 0; px.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3) }
const crc = b => { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 } let x = 0xffffffff; for (const v of b) x = t[(x ^ v) & 255] ^ (x >>> 8); return (x ^ 0xffffffff) >>> 0 }
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]) }
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2
fs.writeFileSync(process.argv[2] || 'work/out/stage.png', Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]))
console.log('ok', W, H)
