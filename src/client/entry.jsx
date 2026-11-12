import { createElement } from 'react'
import css from './styles.css'
import { RimlistApp } from './app.jsx'
import { setupLocale, t } from './i18n.js'

let styleInjected = false
function injectStyles() {
  if (styleInjected || typeof document === 'undefined') return
  styleInjected = true
  const el = document.createElement('style')
  el.setAttribute('data-dsh-rimlist', '')
  el.textContent = css
  document.head.appendChild(el)
}

const SIDEBAR_TAB_ID = 'dsh-rimlist/mods'
const SIDEBAR_TAB_KIND = 'dsh-rimlist-mods'

const plugin = {
  name: 'dsh-rimlist',
  inject: ['slots', 'locale'],
  apply(ctx) {
    setupLocale(ctx)
    injectStyles()
    const slots = ctx.get('slots')
    // Full-width tab in the conversation tab bar (next to 对话 / 轨迹 / 看板).
    slots.inject('conversation.view', () =>
      slots.register(
        { name: 'conversation.view', id: 'rimlist', order: 25, label: () => t('tab'), inject: () => ({}) },
        (props) => createElement(RimlistApp, props),
      ),
    )
    // Also a tab in the right sidebar (requires sidebarRightTabs from the harness).
    if (typeof ctx.inject === 'function') {
      ctx.inject(['sidebarRightTabs'], (owner) => {
        const tabs = owner.get('sidebarRightTabs')
        owner.effect(
          () =>
            tabs.register({
              id: SIDEBAR_TAB_ID,
              kind: SIDEBAR_TAB_KIND,
              priority: 'extension',
              title: () => t('sidebarTitle'),
              guide: [{ order: 90, title: () => t('sidebarTitle') }],
            }),
          'dsh-rimlist: sidebar tab type',
        )
        const ownerSlots = owner.slots || slots
        ownerSlots.inject('sidebar.right.pane.tab', () =>
          ownerSlots.register(
            { name: 'sidebar.right.pane.tab', key: SIDEBAR_TAB_ID, inject: () => ({ inSidebar: true }) },
            (props) => createElement(RimlistApp, { ...props, inSidebar: true }),
          ),
        )
      })
    }
  },
}
export default plugin
