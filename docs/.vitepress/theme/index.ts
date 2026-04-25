import './style.css'
import '@shikijs/vitepress-twoslash/style.css'
import 'virtual:group-icons.css'

import TwoslashFloatingVue from '@shikijs/vitepress-twoslash/client'
import {onContentUpdated} from 'vitepress'
import DefaultTheme from 'vitepress/theme'

import Abbr from './Abbr.vue'
import BlinkyDiagram from './BlinkyDiagram.vue'
import {restorePreferred, setupCodeGroupSync} from './codeGroupSync'
import CodeWiringTabs from './CodeWiringTabs.vue'
import Layout from './Layout.vue'
import NeoPixelDiagram from './NeoPixelDiagram.vue'

export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({app}: {app: import('vue').App}) {
    app.use(TwoslashFloatingVue)
    app.component('Abbr', Abbr)
    app.component('CodeWiringTabs', CodeWiringTabs)
    app.component('BlinkyDiagram', BlinkyDiagram)
    app.component('NeoPixelDiagram', NeoPixelDiagram)

    // Suppress upstream VitePress bug: VPSidebar passes a plain object to watch()
    app.config.warnHandler = (msg, _instance, trace) => {
      if (msg.includes('Invalid watch source') && trace?.includes('VPSidebar')) return
      // eslint-disable-next-line no-console
      console.warn('[Vue warn]:', msg, trace)
    }

    if (typeof window !== 'undefined') {
      setupCodeGroupSync()
    }
  },
  setup() {
    onContentUpdated(() => {
      restorePreferred()
    })
  },
}
