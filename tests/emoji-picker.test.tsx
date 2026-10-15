import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { EmojiPicker } from '../app/components/emoji-picker'

// 微信式表情面板：分类标签 + 网格；点击经 onPick 传出（插入输入框由 ChatInput 负责）

const noop = () => {}

function renderPicker() {
  // 静态渲染无 localStorage：最近使用页签不出现，默认落在「笑脸」分类
  return renderToStaticMarkup(createElement(EmojiPicker, { onPick: noop }))
}

describe('表情面板', () => {
  it('默认渲染笑脸分类的表情网格', () => {
    const html = renderPicker()
    expect(html).toContain('😀')
    expect(html).toContain('😂')
    expect(html).toContain('role="dialog"')
  })

  it('包含全部分类页签（无 localStorage 时不含「最近」）', () => {
    const html = renderPicker()
    for (const label of ['笑脸', '手势', '动物', '食物', '活动', '物品', '旅行', '符号']) {
      expect(html).toContain(label)
    }
    expect(html).not.toContain('>最近</button>')
  })

  it('只展示当前分类的表情（食物分类的水果不在默认视图）', () => {
    const html = renderPicker()
    expect(html).not.toContain('🍔')
    expect(html).not.toContain('❤️')
  })
})
