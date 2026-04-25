<script setup>
import {ref} from 'vue'

const activeTab = ref('code')
</script>

<template>
  <div class="code-wiring-tabs">
    <div class="tabs-header">
      <button
        class="tab-button"
        :class="{active: activeTab === 'code'}"
        @click="activeTab = 'code'"
      >
        Code
      </button>
      <button
        class="tab-button"
        :class="{active: activeTab === 'wiring'}"
        @click="activeTab = 'wiring'"
      >
        Wiring
      </button>
    </div>
    <div class="tab-content">
      <div v-show="activeTab === 'code'">
        <slot name="code" />
      </div>
      <div v-show="activeTab === 'wiring'" class="wiring-panel">
        <slot name="wiring" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.tabs-header {
  display: flex;
  gap: 0;
  border-bottom: 1px solid var(--vp-c-divider);
  margin-bottom: 0;
}

.tab-button {
  padding: 8px 16px;
  font-size: 14px;
  font-weight: 500;
  color: var(--vp-c-text-2);
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  transition:
    color 0.2s,
    border-color 0.2s;
  font-family: var(--vp-font-family-base);
}

.tab-button:hover {
  color: var(--vp-c-text-1);
}

.tab-button.active {
  color: var(--vp-c-brand-1);
  border-bottom-color: var(--vp-c-brand-1);
}

.wiring-panel {
  padding: 24px 16px;
  background: var(--vp-c-bg-soft);
  border-radius: 0 0 8px 8px;
}
</style>
