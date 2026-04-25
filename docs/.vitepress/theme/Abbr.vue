<script setup lang="ts">
import {ref, computed} from 'vue'

const props = defineProps<{
  title: string
}>()

const visible = ref(false)
const id = computed(() => `abbr-${Math.random().toString(36).slice(2, 9)}`)
let showTimeout: ReturnType<typeof setTimeout> | null = null
let hideTimeout: ReturnType<typeof setTimeout> | null = null

function show() {
  if (hideTimeout) {
    clearTimeout(hideTimeout)
    hideTimeout = null
  }
  showTimeout = setTimeout(() => {
    visible.value = true
  }, 300)
}

function hide() {
  if (showTimeout) {
    clearTimeout(showTimeout)
    showTimeout = null
  }
  hideTimeout = setTimeout(() => {
    visible.value = false
  }, 100)
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && visible.value) {
    visible.value = false
  }
}
</script>

<template>
  <span
    class="abbr"
    tabindex="0"
    :aria-describedby="visible ? id : undefined"
    @mouseenter="show"
    @mouseleave="hide"
    @focusin="show"
    @focusout="hide"
    @keydown="onKeydown"
  >
    <slot />
    <span v-show="visible" :id="id" role="tooltip" class="abbr-tooltip">
      {{ props.title }}
    </span>
  </span>
</template>

<style scoped>
.abbr {
  position: relative;
  text-decoration: underline dotted var(--vp-c-text-3);
  text-underline-offset: 3px;
  cursor: help;
}

.abbr:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
  border-radius: 2px;
}

.abbr-tooltip {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  padding: 4px 10px;
  font-size: 12px;
  font-weight: 500;
  line-height: 1.4;
  white-space: nowrap;
  color: var(--vp-c-text-1);
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  pointer-events: auto;
  user-select: text;
  z-index: 10;
}
</style>
