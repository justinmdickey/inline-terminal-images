import type { Elements, EngineInterface, ImageSource, OnScreen, Register, RenderViewport, Timer } from 'claude-code'

// Largest box drawn, in cells.
const MAX_COLUMNS = 80
const MAX_ROWS = 24
// A tool result's text starts after "  ⎿  "; pictures line up with it.
const GUTTER = 5
const CACHE_DIR = '/tmp/claude-inline-images'
const SHOW_IMAGE = 'mcp__inline-images__show_image'

type ImageRead = {
  type: 'image'
  file: {
    base64: string
    type: string
    dimensions?: {
      originalWidth?: number
      originalHeight?: number
      displayWidth?: number
      displayHeight?: number
    }
  }
}

const isImageRead = (output: unknown): output is ImageRead => {
  const o = output as { type?: unknown; file?: { base64?: unknown } } | null
  return o?.type === 'image' && typeof o.file?.base64 === 'string'
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

const decodeHead = (base64: string): number[] => {
  const bytes: number[] = []
  for (let i = 0; i + 3 < base64.length && bytes.length < 24; i += 4) {
    const n = [0, 1, 2, 3].reduce((acc, k) => (acc << 6) | Math.max(0, B64.indexOf(base64[i + k] ?? 'A')), 0)
    bytes.push((n >> 16) & 255, (n >> 8) & 255, n & 255)
  }
  return bytes
}

// Width and height from a PNG's IHDR chunk (bytes 16..24).
export const pngSize = (base64: string): { width: number; height: number } | undefined => {
  const b = decodeHead(base64.slice(0, 32))
  if (b.length < 24 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) return undefined
  const u32 = (at: number) => ((b[at]! << 24) >>> 0) + (b[at + 1]! << 16) + (b[at + 2]! << 8) + b[at + 3]!
  return { width: u32(16), height: u32(20) }
}

// The box a picture fills: at most `maxColumns` wide and `maxRows` tall,
// keeping its shape given a cell's height over its width (`aspect`).
export const fitBox = (width: number, height: number, maxColumns: number, aspect = 2, maxRows = MAX_ROWS) => {
  const tallest = Math.max(1, Math.min(maxRows, MAX_ROWS, 255))
  let columns = Math.max(1, Math.min(maxColumns, MAX_COLUMNS, 255))
  let rows = Math.round((columns * height) / width / aspect)
  if (rows > tallest) {
    rows = tallest
    columns = Math.max(1, Math.min(columns, Math.round((rows * aspect * width) / height)))
  }
  return { columns, rows: Math.max(1, rows) }
}

const cachePath = (id: string) => `${CACHE_DIR}/${id.replace(/[^\w-]/g, '_')}.png`

let tmux: Promise<boolean> | undefined
const inTmux = ($: EngineInterface) => (tmux ??= $.env.get('TMUX').then(v => !!v))

// A cell's height over its width, from the pixel size the terminal reports;
// 2 where it reports none.
let aspect: Promise<number> | undefined
const cellAspect = ($: EngineInterface) =>
  (aspect ??= $.process.run(['python3', '-I', `${$.plugin.root}/bin/cell-size.py`], { timeoutMs: 5_000 }).then(
    ({ exitCode, stdout }) => {
      const [w, h] = stdout.trim().split(' ').map(Number)
      return exitCode === 0 && w && h ? h / w : 2
    },
    () => 2,
  ))

// Copies the picture to a PNG of its own per tool call (first frame, any
// format ImageMagick reads, at most 2048 pixels a side), so the transcript
// keeps what was shown even if the file changes. Answers its pixel size.
const snapshot = async ($: EngineInterface, id: string, path: string) => {
  const png = cachePath(id)
  const { exitCode, stdout, stderr } = await $.process.run(
    ['sh', '-c', 'mkdir -p "$1" && magick "$2[0]" -resize "2048x2048>" -write "png:$3" -format "%w %h" info:', 'sh', CACHE_DIR, path, png],
    { timeoutMs: 20_000 },
  )
  const [width, height] = stdout.trim().split(' ').map(Number)
  if (exitCode !== 0 || !width || !height) throw new Error(stderr.trim() || `could not read ${path}`)
  return { png, width, height }
}

// What a Read's image draws from: its PNG bytes as they are outside tmux;
// else a PNG file of the cache, which the terminal reads itself and the
// forwarder can name (JPEG, GIF and WebP are converted with ImageMagick).
const readSource = async ($: EngineInterface, id: string, read: ImageRead): Promise<ImageSource | undefined> => {
  const png = read.file.type === 'image/png'
  if (png && !(await inTmux($))) return { png: read.file.base64 }

  const out = cachePath(id)
  const cached = await $.fs.stat(out).catch(() => undefined)
  if (cached?.kind === 'file') return { file: out, format: 'png' }

  const write = png ? 'base64 -d > "$2"' : 'base64 -d | magick - "png:$2"'
  const { exitCode } = await $.process.run(['sh', '-c', `mkdir -p "$1" && ${write}`, 'sh', CACHE_DIR, out], {
    stdin: read.file.base64,
    timeoutMs: 10_000,
  })
  return exitCode === 0 ? { file: out, format: 'png' } : undefined
}

// Inside tmux, Claude Code draws an Image's placeholder cells but sends the
// pixels in an escape tmux drops, so bin/tmux-forward.py sends each picture
// again through tmux passthrough under the id the pane shows. It tells the
// placeholder blocks apart by the "#tag" line drawn above each picture, and a
// block clipped at the top of the screen by `onScreen`. It needs
// CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1, or Claude Code draws the alt instead.
type Drawn = { tag: string; file: string; c: number; r: number; onScreen: OnScreen | null | undefined }
const drawn = new Map<string, Drawn>()
const MOST_DRAWN = 512
let timers: Timer[] = []

// Five characters of the call's id: what the head line shows the forwarder.
const tagOf = (id: string) => id.replace(/\W/g, '').slice(-5) || 'x'

const forward = ($: EngineInterface) => {
  const images = [...drawn.values()]
    .filter(d => d.onScreen !== null)
    .map(({ tag, file, c, r, onScreen }) => ({ tag, file, c, r, top: !!onScreen && onScreen.first > 0 }))
  void $.process
    .run(['python3', '-I', `${$.plugin.root}/bin/tmux-forward.py`], { stdin: JSON.stringify({ images }), timeoutMs: 5_000 })
    .then(
      ({ exitCode, stdout, stderr }) => $.ui.log(`tmux-forward: ${exitCode === 0 ? stdout.trim() : stderr.trim()}`, { to: 'debug' }),
      err => $.ui.log(`tmux-forward: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' }),
    )
}

// After the frame is painted, and again in case it was late.
const forwardSoon = ($: EngineInterface, id: string, image: Drawn) => {
  drawn.delete(id)
  drawn.set(id, image)
  for (const old of [...drawn.keys()].slice(0, Math.max(0, drawn.size - MOST_DRAWN))) drawn.delete(old)
  for (const t of timers) t.cancel()
  timers = [150, 700].map(ms => $.clock.after(ms, () => forward($)))
}

type Picture = { source: ImageSource; file?: string; width: number; height: number; label: string }
type Site = { id: string; viewport?: RenderViewport; onScreen: OnScreen | null | undefined }
type Leaves = Pick<Elements['terminal'], 'Box' | 'Text' | 'Image'>

// The head line (the tag inside tmux, then the label) over the picture, both
// at the gutter; `prefix` is the gutter, drawn where the engine's row is
// replaced. No head line where it would say nothing.
const picture = async ($: EngineInterface, site: Site, { Box, Text, Image }: Leaves, p: Picture, prefix: string) => {
  const columns = (site.viewport?.columns ?? 80) - GUTTER - 1
  const { columns: c, rows: r } = fitBox(p.width, p.height, columns, await cellAspect($), (site.viewport?.rows ?? 48) - 8)
  const tag = p.file && (await inTmux($)) ? tagOf(site.id) : undefined
  if (tag && p.file) forwardSoon($, site.id, { tag, file: p.file, c, r, onScreen: site.onScreen })
  const head = [tag && `#${tag}`, p.label].filter(Boolean).join(' ')
  return (
    <Box flexDirection="column">
      {head && (
        <Text dimColor wrap="truncate">
          {prefix}
          {head}
        </Text>
      )}
      <Box marginLeft={GUTTER}>
        <Image source={p.source} columns={c} rows={r} alt={`[image ${p.width}x${p.height}]`} />
      </Box>
    </Box>
  )
}

// Images pasted into a prompt live only in the conversation: the API form of
// the session's messages holds them as image blocks after the prompt's text
// block (for a prompt sent mid-turn, inside a tool result). Each is written
// once to the cache with a sidecar of its size, so later draws read no messages.
type Pasted = { file: string; width: number; height: number; n: number }
const PASTE_REF = /\[Image #(\d+)\]/g

type Block = { type?: string; text?: string; content?: unknown; source?: { type?: string; data?: string } }

export const pastedBlocks = (messages: readonly { role: string; content: unknown }[], text: string): string[] => {
  let found: string[] = []
  const visit = (blocks: unknown) => {
    if (!Array.isArray(blocks)) return
    for (const [i, b] of (blocks as Block[]).entries()) {
      if (b?.type === 'text' && typeof b.text === 'string' && b.text.includes(text)) {
        const images: string[] = []
        for (const next of (blocks as Block[]).slice(i + 1)) {
          if (next?.type !== 'image') break
          if (next.source?.type === 'base64' && typeof next.source.data === 'string') images.push(next.source.data)
        }
        if (images.length) found = images
      }
      visit(b?.content)
    }
  }
  for (const m of messages) if (m.role === 'user') visit(m.content)
  return found
}

const pastedImages = async ($: EngineInterface, id: string, text: string): Promise<Pasted[]> => {
  const refs = [...text.matchAll(PASTE_REF)].map(m => Number(m[1]))
  if (!refs.length) return []
  const meta = `${CACHE_DIR}/paste-${id.replace(/[^\w-]/g, '_')}.json`
  const cached = await $.fs.read(meta).then(t => JSON.parse(t) as Pasted[], () => undefined)
  if (cached) return cached

  const messages = await $.session.messages({ as: 'api' })
  const blocks = pastedBlocks(messages as readonly { role: string; content: unknown }[], text)
  const out: Pasted[] = []
  for (const [i, data] of blocks.entries()) {
    const file = cachePath(`paste-${id}-${i}`)
    const { exitCode, stdout } = await $.process.run(
      ['sh', '-c', 'mkdir -p "$1" && base64 -d | magick - -write "png:$2" -format "%w %h" info:', 'sh', CACHE_DIR, file],
      { stdin: data, timeoutMs: 20_000 },
    )
    const [width, height] = stdout.trim().split(' ').map(Number)
    if (exitCode === 0 && width && height) out.push({ file, width, height, n: refs[i] ?? i + 1 })
  }
  if (out.length) await $.fs.write(meta, JSON.stringify(out))
  return out
}

export type Shown = { path: string; width: number; height: number; caption?: string }

// The tool's result is a JSON string (a plugin tool answers text): what the
// model reads and what the row draws from. Core may hand it back as text blocks.
const parseShown = (output: unknown): Shown | undefined => {
  const text = Array.isArray(output)
    ? output.map(b => (b as { text?: unknown })?.text).filter(t => typeof t === 'string').join('')
    : output
  if (typeof text !== 'string') return undefined
  try {
    const o = JSON.parse(text) as Partial<Shown> | null
    return typeof o?.path === 'string' && typeof o.width === 'number' && typeof o.height === 'number' ? (o as Shown) : undefined
  } catch {
    return undefined
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'show_image',
      description:
        'Show an image file to the user inline in their terminal (Kitty graphics: Kitty, Ghostty). Use it for a ' +
        'screenshot, chart, render or other picture the user should see, when you do not need to look at it ' +
        'yourself: unlike Read it costs no image tokens, and you only learn the pixel size. Takes PNG, JPEG, ' +
        'GIF (first frame), WebP, SVG and other formats ImageMagick reads.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path, or relative to the working directory' },
          caption: { type: 'string', description: 'Optional one-line caption drawn above the image' },
        },
        required: ['path'],
      },
      isDeferred: false,
    })
    return next(e)
  })

  on('tool.call', { tool: SHOW_IMAGE }, async ($, e) => {
    const { path, caption } = e as unknown as { path?: unknown; caption?: unknown }
    if (typeof path !== 'string' || !path) return { deny: 'show_image needs a path.' }
    if (!e.tool_use_id) return { deny: 'show_image needs a tool_use_id to draw under.' }
    try {
      const stat = await $.fs.stat(path)
      if (stat.kind !== 'file') return { deny: `${path} is not a file.` }
      const { width, height } = await snapshot($, e.tool_use_id, path)
      const shown: Shown = { path, width, height, ...(typeof caption === 'string' && caption ? { caption } : {}) }
      return { result: JSON.stringify({ shown_to_user: true, ...shown }) }
    } catch (err) {
      return { deny: `Could not show ${path}: ${err instanceof Error ? err.message : String(err)}` }
    }
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const shown = e.props.tool === SHOW_IMAGE && !e.props.isErrored ? parseShown(e.props.output) : undefined
    if (!shown) return next(e)
    const label = `${shown.caption ? `${shown.caption} · ` : ''}${shown.path} (${shown.width}x${shown.height})`
    if (e.surface !== 'terminal') {
      const { Text } = $.ui.resolve(e)
      return <Text dimColor>{label}</Text>
    }
    const file = cachePath(e.props.tool_use_id)
    const site = { id: e.props.tool_use_id, viewport: e.viewport, onScreen: e.props.onScreen }
    return picture($, site, $.ui.resolve(e), { source: { file, format: 'png' }, file, width: shown.width, height: shown.height, label }, '  ⎿  ')
  })

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const row = await next(e)
    if (e.surface !== 'terminal' || !e.props.text.includes('[Image #')) return row
    const pasted = await pastedImages($, e.requestId, e.props.text)
    if (!pasted.length) return row

    const leaves = $.ui.resolve(e)
    const { Box } = leaves
    const pictures = []
    for (const [i, p] of pasted.entries()) {
      const site = { id: `${e.requestId}-${i}`, viewport: e.viewport, onScreen: e.props.onScreen }
      const source = { file: p.file, format: 'png' } as const
      pictures.push(await picture($, site, leaves, { source, file: p.file, width: p.width, height: p.height, label: `Image #${p.n} · ${p.width}x${p.height}` }, ' '.repeat(GUTTER)))
    }
    return (
      <Box flexDirection="column">
        {row}
        {pictures}
      </Box>
    )
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const row = await next(e)
    if (e.surface !== 'terminal' || e.props.tool !== 'Read' || e.props.isErrored) return row
    if (!isImageRead(e.props.output)) return row

    const read = e.props.output
    const dims = read.file.dimensions
    const size =
      (dims?.displayWidth && dims.displayHeight && { width: dims.displayWidth, height: dims.displayHeight }) ||
      (dims?.originalWidth && dims.originalHeight && { width: dims.originalWidth, height: dims.originalHeight }) ||
      (read.file.type === 'image/png' ? pngSize(read.file.base64) : undefined) ||
      { width: 4, height: 3 }

    const source = await readSource($, e.props.tool_use_id, read)
    if (!source) return row

    const file = 'file' in source ? source.file : undefined
    const label = `${size.width}x${size.height} ${read.file.type.replace('image/', '')}`
    const site = { id: e.props.tool_use_id, viewport: e.viewport, onScreen: e.props.onScreen }
    const leaves = $.ui.resolve(e)
    const { Box } = leaves
    return (
      <Box flexDirection="column">
        {row}
        {await picture($, site, leaves, { source, file, ...size, label }, ' '.repeat(GUTTER))}
      </Box>
    )
  })
}
