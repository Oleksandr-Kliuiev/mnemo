// Renders the app icon, PWA icons and iOS launch screens from inline SVG.
// Usage: node scripts/gen-icons.mjs
import { Resvg } from '@resvg/resvg-js'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pub = join(root, 'public')
mkdirSync(join(pub, 'icons'), { recursive: true })
mkdirSync(join(pub, 'splash'), { recursive: true })

/** Circular "repeat" arrow centred on the front card. */
function repeatArrow(t, s) {
  const cx = t(560)
  const cy = t(530)
  const R = 92 * s
  const rad = (d) => (d * Math.PI) / 180
  const P = (d) => [cx + R * Math.cos(rad(d)), cy + R * Math.sin(rad(d))]
  const a0 = -40
  const a1 = 235
  const [x0, y0] = P(a0)
  const [x1, y1] = P(a1)
  // Tangent of a clockwise arc at a1, and its normal.
  const tx = -Math.sin(rad(a1))
  const ty = Math.cos(rad(a1))
  const nx = -ty
  const ny = tx
  const head = 46 * s
  const tip = [x1 + tx * head * 0.9, y1 + ty * head * 0.9]
  const b1 = [x1 - tx * head * 0.25 + nx * head * 0.75, y1 - ty * head * 0.25 + ny * head * 0.75]
  const b2 = [x1 - tx * head * 0.25 - nx * head * 0.75, y1 - ty * head * 0.25 - ny * head * 0.75]
  const f = (n) => n.toFixed(1)
  return `<path d="M ${f(x0)} ${f(y0)} A ${f(R)} ${f(R)} 0 1 1 ${f(x1)} ${f(y1)}" fill="none" stroke="#5B4CF0" stroke-width="${f(40 * s)}" stroke-linecap="round"/>
    <path d="M ${f(tip[0])} ${f(tip[1])} L ${f(b1[0])} ${f(b1[1])} L ${f(b2[0])} ${f(b2[1])} Z" fill="#5B4CF0" stroke="#5B4CF0" stroke-width="${f(10 * s)}" stroke-linejoin="round"/>`
}

/** The mark: two stacked cards with a "repeat" arrow, on a 1024 canvas. */
function mark({ rounded, scale = 1 }) {
  const s = scale
  const t = (v) => 512 + (v - 512) * s
  const r = rounded ? 230 : 0
  return `
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#5B4CF0"/>
      <stop offset="0.55" stop-color="#7C3AED"/>
      <stop offset="1" stop-color="#C026D3"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.25" cy="0.15" r="0.75">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.35"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="card" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#EEF0FF"/>
    </linearGradient>
    <filter id="shadow" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="${18 * s}" stdDeviation="${26 * s}" flood-color="#1e0b5c" flood-opacity="0.35"/>
    </filter>
  </defs>
  <rect width="1024" height="1024" rx="${r}" fill="url(#bg)"/>
  <rect width="1024" height="1024" rx="${r}" fill="url(#glow)"/>
  <g transform="rotate(-12 ${t(470)} ${t(520)})" filter="url(#shadow)">
    <rect x="${t(250)}" y="${t(300)}" width="${440 * s}" height="${330 * s}" rx="${48 * s}" fill="#ffffff" fill-opacity="0.42"/>
  </g>
  <g transform="rotate(7 ${t(560)} ${t(560)})" filter="url(#shadow)">
    <rect x="${t(330)}" y="${t(360)}" width="${460 * s}" height="${340 * s}" rx="${50 * s}" fill="url(#card)"/>
    ${repeatArrow(t, s)}
  </g>`
}

function svg(w, h, inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${inner}</svg>`
}

function png(svgText, width) {
  return new Resvg(svgText, { fitTo: { mode: 'width', value: width }, font: { loadSystemFonts: false } }).render().asPng()
}

const rounded = svg(1024, 1024, mark({ rounded: true }))
const square = svg(1024, 1024, mark({ rounded: false }))
const maskable = svg(1024, 1024, mark({ rounded: false, scale: 0.78 }))

writeFileSync(join(pub, 'favicon.svg'), rounded)
writeFileSync(join(pub, 'apple-touch-icon.png'), png(square, 180))
writeFileSync(join(pub, 'icons', 'icon-192.png'), png(rounded, 192))
writeFileSync(join(pub, 'icons', 'icon-512.png'), png(rounded, 512))
writeFileSync(join(pub, 'icons', 'icon-maskable-512.png'), png(maskable, 512))

// iOS launch screens (portrait): CSS size × pixel ratio.
const DEVICES = [
  [440, 956, 3],
  [430, 932, 3],
  [428, 926, 3],
  [420, 912, 3],
  [414, 896, 3],
  [414, 896, 2],
  [402, 874, 3],
  [393, 852, 3],
  [390, 844, 3],
  [375, 812, 3],
  [375, 667, 2],
]
const links = []
for (const [w, h, r] of DEVICES) {
  for (const theme of ['light', 'dark']) {
    const W = w * r
    const H = h * r
    const size = 112 * r
    const bg = theme === 'light' ? '#F2F2F7' : '#000000'
    const inner = `<rect width="${W}" height="${H}" fill="${bg}"/>
      <svg x="${(W - size) / 2}" y="${(H - size) / 2 - 24 * r}" width="${size}" height="${size}" viewBox="0 0 1024 1024">${mark({ rounded: true })}</svg>`
    const name = `splash-${W}x${H}-${theme}.png`
    writeFileSync(join(pub, 'splash', name), png(svg(W, H, inner), W))
    const media = `(device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${r}) and (orientation: portrait) and (prefers-color-scheme: ${theme})`
    links.push(`    <link rel="apple-touch-startup-image" media="${media}" href="splash/${name}" />`)
  }
}

// Native iOS app (Capacitor): app icon and launch image, when the iOS project exists.
const iosAssets = join(root, 'ios', 'App', 'App', 'Assets.xcassets')
import('node:fs').then(({ existsSync, rmSync, readdirSync }) => {
  if (!existsSync(iosAssets)) return
  const iconDir = join(iosAssets, 'AppIcon.appiconset')
  writeFileSync(join(iconDir, 'AppIcon-512@2x.png'), png(square, 1024))
  const splashDir = join(iosAssets, 'Splash.imageset')
  for (const f of readdirSync(splashDir)) if (f.endsWith('.png')) rmSync(join(splashDir, f))
  const S = 2732
  const size = 300
  for (const theme of ['light', 'dark']) {
    const bg = theme === 'light' ? '#F2F2F7' : '#000000'
    const inner = `<rect width="${S}" height="${S}" fill="${bg}"/>
      <svg x="${(S - size) / 2}" y="${(S - size) / 2}" width="${size}" height="${size}" viewBox="0 0 1024 1024">${mark({ rounded: true })}</svg>`
    writeFileSync(join(splashDir, `splash-${theme}.png`), png(svg(S, S, inner), S))
  }
  writeFileSync(
    join(splashDir, 'Contents.json'),
    JSON.stringify(
      {
        images: [
          { idiom: 'universal', filename: 'splash-light.png' },
          { idiom: 'universal', filename: 'splash-dark.png', appearances: [{ appearance: 'luminosity', value: 'dark' }] },
        ],
        info: { version: 1, author: 'xcode' },
      },
      null,
      2,
    ),
  )
  console.log('iOS assets updated')
})

const indexPath = join(root, 'index.html')
const html = readFileSync(indexPath, 'utf8')
const next = html.replace(/<!-- splash:start -->[\s\S]*?<!-- splash:end -->/, `<!-- splash:start -->\n${links.join('\n')}\n    <!-- splash:end -->`)
writeFileSync(indexPath, next)
console.log(`icons: 5, splash screens: ${links.length}`)
