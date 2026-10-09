import { expect, test } from 'claude-code/testing'

test('the Cache panel draws on the terminal and the desktop', async ($, on) => {
  on('clock.now', () => ({ value: 1_000_000 }))
  on('ui.render', () => ({ value: null }) as any)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'cache-tax', surface, component: 'Pane', requestId: 'cache', props: { title: 'Cache', isFocused: false, bodyColumns: 44, placement: 'dock' } } as any)
    expect(await ui.find({ type: 'Text', text: /PROMPT CACHE/ })).toBeDefined()
  }
})
