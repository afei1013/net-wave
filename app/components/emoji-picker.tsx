'use client'

import { useEffect, useState } from 'react'
import { cn } from '@lib/utils'

/**
 * 微信式 Emoji 面板：分类标签 + 网格选择，点击插入输入框光标处。
 * 纯 Unicode 文本（零依赖、零图片资源），随消息文本通道传输；
 * 最近使用存 localStorage（nw_recent_emojis，最多 24 个）。
 */

const RECENT_KEY = 'nw_recent_emojis'
const RECENT_MAX = 24

/** 精选常用 emoji：每类一段空格分隔的字符串，构建时拆分为数组 */
const RAW_CATEGORIES: { key: string; label: string; raw: string }[] = [
  {
    key: 'smileys',
    label: '笑脸',
    raw: '😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😙 🥲 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 😐 😑 😶 😏 😒 🙄 😬 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🥵 🥶 🥴 😵 🤯 🤠 🥳 🥸 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 🤬 😈 👿 💀 💩 🤡 👻 👽 🤖 🎃',
  },
  {
    key: 'gestures',
    label: '手势',
    raw: '👋 🤚 🖐 ✋ 🖖 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 👐 🤲 🤝 🙏 💪 ✍️ 💅 🤳 💋 👀 🧠 👶 🧒 👦 👧 🧑 👨 🧔 👩 🧓 👴 👵 🙈 🙉 🙊 💁 🙋 🙇 🤦 🤷 💇 💆 🧘 🕺 💃 🕴 🚶 🏃 👯 🤰 🤱',
  },
  {
    key: 'animals',
    label: '动物',
    raw: '🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🐔 🐧 🐦 🐤 🦆 🦅 🦉 🦇 🐺 🐗 🐴 🦄 🐝 🐛 🦋 🐌 🐞 🐜 🐢 🐍 🦎 🦂 🦀 🐡 🐠 🐟 🐬 🐳 🐋 🦈 🐊 🐅 🐆 🦓 🦍 🐘 🦏 🐪 🦒 🐁 🐇 🐿 🦔 🌵 🌲 🌳 🌴 🌱 🌿 ☘️ 🍀 🎄 🌸 💮 🏵 🌹 🥀 🌺 🌻 🌼 🌷',
  },
  {
    key: 'food',
    label: '食物',
    raw: '🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍈 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🥑 🍆 🥔 🥕 🌽 🌶 🥒 🥬 🥦 🍄 🥜 🌰 🍞 🥐 🥖 🥨 🥞 🧇 🧀 🍖 🍗 🥩 🍤 🍳 🍔 🍟 🍕 🌭 🥪 🌮 🌯 🥗 🍜 🍲 🍣 🍱 🍚 🍛 🍦 🍰 🎂 🍫 🍿 ☕ 🍵 🧋 🍺 🍻 🥂 🍷 🥤 🧃 🍾',
  },
  {
    key: 'activities',
    label: '活动',
    raw: '⚽ 🏀 🏈 ⚾ 🎾 🏐 🏉 🎱 🏓 🏸 🥅 🏒 🏑 🥍 🏏 ⛳ 🏹 🎣 🥊 🥋 🎽 🛹 ⛸ 🎿 ⛷ 🏂 🏋️ 🤸 ⛹️ 🏄 🏊 🚣 🧗 🚴 🚵 🎖 🏅 🥇 🥈 🥉 🏆 🎯 🎮 🎲 🧩 ♟ 🎨 🎭 🎤 🎧 🎼 🎹 🥁 🎷 🎺 🎸 🎻 🎬 🎪 🎉 🎊 🎈 🎁 🎆 🎇 🧨',
  },
  {
    key: 'objects',
    label: '物品',
    raw: '⌚ 📱 💻 ⌨️ 🖥 🖨 🖱 💾 💿 📀 📷 📸 📹 🎥 📞 ☎️ 📟 📠 📺 📻 🎙 ⏰ ⏳ 📡 🔋 🔌 💡 🔦 🕯 💸 💵 💰 💳 💎 ⚖️ 🔧 🔨 ⚙️ 🔪 🗡 🛡 🔮 📿 🔭 🔬 💊 💉 🌡 🔑 🚪 🛋 🛏 🖼 🛍 🎒 👞 👟 👠 👡 👢 👑 🎩 🧢 🎓 ⛑ 🧣 🧤 🧥 👖 👕 👗 👘 🥻 🩱 💼 👓 🕶 🥇 🧳 ⛱ 🌂 ☂️',
  },
  {
    key: 'travel',
    label: '旅行',
    raw: '🚗 🚕 🚙 🚌 🚎 🏎 🚓 🚑 🚒 🚐 🚚 🚛 🚜 🛴 🚲 🛵 🏍 🚨 🚔 🚖 🚡 🚠 🚃 🚋 🚞 🚝 🚄 🚅 🚈 🚂 🚆 🚇 🚊 🚉 ✈️ 🛫 🛬 🛩 💺 🚀 🛸 🚁 🛶 ⛵ 🚤 🛥 🛳 ⛴ 🚢 ⚓ 🗺 🗿 🗽 🗼 🏰 🏯 🏟 🎡 🎢 🎠 ⛲ ⛱ 🏖 🏝 🏜 🌋 ⛰ 🏔 🗻 🏕 ⛺ 🏠 🏡 🏘 🏚 🏗 🏭 🏢 🏬 🏣 🏤 🏥 🏦 🏨 🏪 🏫 💒 🕌 🕍 ⛪ 🌃 🌆 🌇 🌉',
  },
  {
    key: 'symbols',
    label: '符号',
    raw: '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 ☮️ ☯️ ✡️ 🔯 ♈ ♉ ♊ ♋ ♌ ♍ ♎ ♏ ♐ ♑ ♒ ♓ ⚛️ ☢️ ☣️ 💯 🔥 ✨ 🌟 ⭐ 💫 ⚡ ☄️ 💥 🔔 🎵 🎶 ➕ ➖ ➗ ✖️ 💲 ™️ ©️ ®️ 〰️ ➰ ➿ 🔚 🔙 🔛 🔝 🔜 ✔️ ☑️ 🔘 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ 🟤 🔺 🔻 🔸 🔹 🔶 🔷 🔳 🔲 🌈 ☀️ ⛅ 🌧 ⛈ 🌩 🌨 ❄️ ☃️ ⛄ 🌬 💨 💧 💦 ☔ 🌊',
  },
]

const CATEGORIES = RAW_CATEGORIES.map(({ key, label, raw }) => ({ key, label, emojis: raw.split(' ') }))

interface EmojiPickerProps {
  /** 选中表情：由调用方负责插入到输入光标处（面板保持打开以便连续选择） */
  onPick: (emoji: string) => void
}

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    if (!raw) return []
    const list = JSON.parse(raw) as unknown
    return Array.isArray(list) ? (list.filter((e) => typeof e === 'string') as string[]).slice(0, RECENT_MAX) : []
  } catch {
    return []
  }
}

function saveRecent(emoji: string): string[] {
  const next = [emoji, ...loadRecent().filter((e) => e !== emoji)].slice(0, RECENT_MAX)
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    // 隐私模式等场景写入失败：仅本次会话内生效
  }
  return next
}

export function EmojiPicker({ onPick }: EmojiPickerProps) {
  // 最近使用在 effect 中加载（SSR/静态渲染无 localStorage）
  const [recent, setRecent] = useState<string[]>([])
  const [active, setActive] = useState<string>('smileys')

  useEffect(() => {
    setRecent(loadRecent())
  }, [])

  const handlePick = (emoji: string) => {
    setRecent(saveRecent(emoji))
    onPick(emoji)
  }

  const tabs = [
    ...(recent.length > 0 ? [{ key: 'recent', label: '最近' }] : []),
    ...CATEGORIES.map(({ key, label }) => ({ key, label })),
  ]
  const activeEmojis = active === 'recent' ? recent : (CATEGORIES.find((c) => c.key === active)?.emojis ?? [])

  return (
    <div className="w-[344px] rounded-xl border border-white/[0.06] bg-sidebar shadow-xl" role="dialog" aria-label="表情选择">
      <div className="flex gap-0.5 overflow-x-auto border-b border-white/[0.06] px-1.5 pt-1.5" role="tablist">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={active === tab.key}
            onClick={() => setActive(tab.key)}
            className={cn(
              'shrink-0 rounded-md px-2 py-1 text-xs transition-colors',
              active === tab.key ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="grid max-h-56 grid-cols-8 gap-0.5 overflow-y-auto p-1.5">
        {activeEmojis.map((emoji) => (
          <button
            key={emoji}
            type="button"
            onClick={() => handlePick(emoji)}
            className="flex h-9 items-center justify-center rounded-md text-xl leading-none transition-colors hover:bg-accent"
            aria-label={`插入表情 ${emoji}`}
          >
            {emoji}
          </button>
        ))}
      </div>
    </div>
  )
}
