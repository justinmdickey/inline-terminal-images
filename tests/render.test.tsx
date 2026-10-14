import type { OnScreen } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { fitBox, replayHook } from '../hooks/register'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAMgAAABkAQMAAAD5SO1IAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAADUExURf8AABniCTcAAAAHdElNRQfqCgsOCxeMA3ziAAAAJXRFWHRkYXRlOmNyZWF0ZQAyMDI2LTEwLTExVDE0OjExOjIzKzAwOjAwMvN/GAAAACV0RVh0ZGF0ZTptb2RpZnkAMjAyNi0xMC0xMVQxNDoxMToyMyswMDowMEOux6QAAAAodEVYdGRhdGU6dGltZXN0YW1wADIwMjYtMTAtMTFUMTQ6MTE6MjMrMDA6MDAUu+Z7AAAAGUlEQVRIx+3BgQAAAADDoPlTH+AKVQEAwBsKKAABSvrqYAAAAABJRU5ErkJggg=='
const CACHE = '/tmp/claude-inline-images'

const props = (output: unknown, tool = 'Read', onScreen?: OnScreen | null) => ({
  tool_use_id: 't1',
  tool,
  output,
  isErrored: false,
  ...(onScreen !== undefined ? { onScreen } : {}),
})
const read = (type = 'image/png') => ({ type: 'image', file: { base64: PNG, type, originalSize: 1 } })
const shown = (caption?: string) =>
  JSON.stringify({ shown_to_user: true, path: 'shot.jpg', width: 1600, height: 900, ...(caption ? { caption } : {}) })

const ran = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false, stream: 'stdout' as const }

// The engine beneath: a Read row, the environment, and the commands the mod
// runs (a cell's pixel size, ImageMagick, the forwarder), each recorded.
const below = (on: any, env: Record<string, string> = {}, cell = '11 26') => {
  const calls: { argv: readonly string[]; stdin?: string }[] = []
  mock.env(on, env)
  on('ui.render', { component: 'ToolResult' }, () => ({ type: 'Text', props: {}, children: ['Read image (1KB)'] }))
  on('process.run', (_: unknown, e: { argv: readonly string[]; init?: { stdin?: string } }) => {
    calls.push({ argv: e.argv, stdin: e.init?.stdin })
    return { value: { ...ran, stdout: e.argv[2]?.endsWith('cell-size.py') ? cell : '' } }
  })
  return calls
}

const mount = ($: any, p: unknown, columns = 100, rows = 40) =>
  $.ui.mount({ plugin: 'inline-terminal-images', surface: 'terminal', component: 'ToolResult', props: p, viewport: { columns, rows } })

test('fitBox keeps the picture in shape for the cell size', () => {
  expect(fitBox(200, 100, 80, 2)).toEqual({ columns: 80, rows: 20 })
  expect(fitBox(200, 100, 80, 26 / 11)).toEqual({ columns: 80, rows: 17 })
  expect(fitBox(100, 400, 80, 2)).toEqual({ columns: 12, rows: 24 })
  expect(fitBox(100, 400, 80, 2, 10)).toEqual({ columns: 5, rows: 10 })
  expect(fitBox(1, 1, 0, 2)).toEqual({ columns: 1, rows: 1 })
})

test('the replay hook runs the forwarder for its pane quietly in the background', () => {
  expect(replayHook('/plug', '%12')).toBe(`run-shell -b "python3 -I '/plug/bin/tmux-forward.py' --pane '%12' >/dev/null 2>&1 || true"`)
})

test('draws a Read PNG from its bytes outside tmux, under its size', async ($, on) => {
  const calls = below(on)
  const ui = await mount($, props(read()))
  expect(await ui.drawn()).toMatchObject({
    type: 'Box',
    children: [
      { type: 'Text', children: ['Read image (1KB)'] },
      {
        type: 'Box',
        children: [
          { type: 'Text', props: { dimColor: true }, children: ['     ', '200x100 png'] },
          { type: 'Box', props: { marginLeft: 5 }, children: [{ type: 'Image', props: { source: { png: PNG }, columns: 80, rows: 17, alt: '[image 200x100]' } }] },
        ],
      },
    ],
  })
  expect(calls.map(c => c.argv[2])).toEqual([expect.stringMatching(/cell-size\.py$/)])
})

test('converts a Read JPEG to a cached PNG file', async ($, on) => {
  const calls = below(on)
  const ui = await mount($, props(read('image/jpeg')))
  expect(await ui.find({ type: 'Image' })).toMatchObject({ props: { source: { file: `${CACHE}/t1.png`, format: 'png' } } })
  expect(calls.find(c => c.argv[0] === 'sh')).toMatchObject({ argv: ['sh', '-c', expect.stringContaining('magick - "png:$2"'), 'sh', CACHE, `${CACHE}/t1.png`], stdin: PNG })
})

test('leaves other tools and surfaces alone', async ($, on) => {
  below(on)
  for (const [surface, tool] of [['terminal', 'Bash'], ['desktop', 'Read']] as const) {
    const ui = await $.ui.mount({ plugin: 'inline-terminal-images', surface, component: 'ToolResult', props: props(read(), tool) })
    expect(await ui.drawn()).toMatchObject({ type: 'Text' })
  }
})

test('draws a show_image result from its snapshot, with the gutter and label', async ($, on) => {
  below(on)
  const ui = await mount($, props(shown('Home'), 'mcp__inline-terminal-images__show_image'), 120)
  expect(await ui.drawn()).toMatchObject({
    type: 'Box',
    children: [
      { type: 'Text', props: { dimColor: true, wrap: 'truncate' }, children: ['  ⎿  ', 'Home · shot.jpg (1600x900)'] },
      { type: 'Box', children: [{ type: 'Image', props: { source: { file: `${CACHE}/t1.png`, format: 'png' }, columns: 80, rows: 19 } }] },
    ],
  })
})

test('inside tmux, tags the head line and forwards the picture once painted', async ($, on) => {
  const clock = mock.clock(on)
  const calls = below(on, { TMUX: '/tmp/tmux-1000/default,1,0' })
  const ui = await mount($, props(shown(), 'mcp__inline-terminal-images__show_image', { first: 3, last: 30, of: 31 }), 120, 48)
  expect(await ui.find({ type: 'Text' })).toMatchObject({ children: ['  ⎿  ', '#t1 shot.jpg (1600x900)'] })

  expect(calls.map(c => c.argv[2])).toEqual([expect.stringMatching(/cell-size\.py$/)])
  await clock.advance(150)
  const forwarded = calls.filter(c => c.argv[2]?.endsWith('tmux-forward.py'))
  expect(forwarded).toHaveLength(1)
  expect(JSON.parse(forwarded[0]!.stdin!)).toEqual({ images: [{ tag: 't1', file: `${CACHE}/t1.png`, c: 80, r: 19, top: true }] })
  await clock.advance(600)
  expect(calls.filter(c => c.argv[2]?.endsWith('tmux-forward.py'))).toHaveLength(2)
})

test('inside tmux, a Read PNG is written to a file so the forwarder can name it', async ($, on) => {
  const clock = mock.clock(on)
  const calls = below(on, { TMUX: '1' })
  const ui = await mount($, props(read(), 'Read', null))
  expect(await ui.find({ type: 'Image' })).toMatchObject({ props: { source: { file: `${CACHE}/t1.png`, format: 'png' } } })
  expect(await ui.find({ type: 'Text', text: /#t1/ })).toMatchObject({ children: ['     ', '#t1 200x100 png'] })
  expect(calls.find(c => c.argv[0] === 'sh')).toMatchObject({ argv: ['sh', '-c', expect.stringContaining('base64 -d > "$2"'), 'sh', CACHE, `${CACHE}/t1.png`], stdin: PNG })

  await clock.advance(150)
  const forwarded = calls.filter(c => c.argv[2]?.endsWith('tmux-forward.py'))
  expect(JSON.parse(forwarded[0]!.stdin!)).toEqual({ images: [] })
})

test('draws an image pasted into a prompt under the prompt row', async ($, on) => {
  mock.env(on, {})
  const written: string[] = []
  on('ui.render', { component: 'UserMessage' }, () => ({ type: 'Text', props: {}, children: ['> look [Image #1]'] }))
  on('session.messages', () => ({
    value: [
      { role: 'user', content: [{ type: 'text', text: 'older' }] },
      { role: 'user', content: [{ type: 'tool_result', content: [{ type: 'text', text: 'The user sent: look [Image #1]' }, { type: 'image', source: { type: 'base64', data: PNG } }] }] },
    ],
  }))
  on('fs.read', () => {
    throw new Error('ENOENT')
  })
  on('fs.write', (_: unknown, e: { path: string }) => (written.push(e.path), { value: undefined }))
  on('process.run', (_: unknown, e: { argv: readonly string[]; init?: { stdin?: string } }) => ({
    value: { ...ran, stdout: e.argv[2]?.endsWith('cell-size.py') ? '11 26' : e.init?.stdin === PNG ? '200 100' : '' },
  }))
  const ui = await $.ui.mount({
    plugin: 'inline-terminal-images',
    surface: 'terminal',
    component: 'UserMessage',
    requestId: 'm1',
    props: { text: 'look [Image #1]', origin: { kind: 'composer' }, isExpanded: true },
    viewport: { columns: 100, rows: 40 },
  })
  expect(await ui.drawn()).toMatchObject({
    type: 'Box',
    children: [
      { type: 'Text', children: ['> look [Image #1]'] },
      {
        type: 'Box',
        children: [
          { type: 'Text', children: ['     ', 'Image #1 · 200x100'] },
          { type: 'Box', children: [{ type: 'Image', props: { source: { file: `${CACHE}/paste-m1-0.png`, format: 'png' }, columns: 80, rows: 17 } }] },
        ],
      },
    ],
  })
  expect(written).toEqual([`${CACHE}/paste-m1.json`])
})
