<template>
  <Teleport to="body">
    <div v-if="visible" class="sdm-overlay" @click.self="$emit('close')">
      <div class="sdm-panel">
        <div class="sdm-header">
          <div class="sdm-title-row">
            <h3 class="sdm-title">{{ skill.name }}</h3>
            <span v-if="skill.installed && !effectiveEnabled" class="sdm-badge-disabled">Disabled</span>
          </div>
          <button class="sdm-close" type="button" aria-label="Close" @click="$emit('close')">
            <IconTablerX class="sdm-close-icon" />
          </button>
        </div>

        <div class="sdm-body">
          <div class="sdm-meta">
            <span class="sdm-owner">{{ skill.owner }}</span>
          </div>
          <p v-if="skill.description" class="sdm-desc">{{ skill.description }}</p>
          <a class="sdm-link" :href="skill.url" target="_blank" rel="noopener noreferrer">View on GitHub</a>
        </div>

        <div class="sdm-footer">
          <div class="sdm-footer-actions">
            <button
              v-if="skill.installed"
              class="sdm-btn sdm-btn-danger"
              type="button"
              :disabled="isActing"
              @click="onUninstall"
            >
              {{ isUninstalling ? 'Uninstalling...' : 'Uninstall' }}
            </button>
            <button
              v-else
              class="sdm-btn sdm-btn-primary"
              type="button"
              :disabled="isActing"
              @click="onInstall"
            >
              {{ isInstalling ? 'Installing...' : 'Install' }}
            </button>

            <button
              v-if="skill.installed"
              class="sdm-btn sdm-btn-secondary"
              type="button"
              :disabled="isActing"
              @click="onToggleEnabled"
            >
              {{ effectiveEnabled ? 'Disable' : 'Enable' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import IconTablerX from '../icons/IconTablerX.vue'

export type HubSkill = {
  name: string
  owner: string
  description: string
  stars: number
  updatedAt: string
  url: string
  installed: boolean
  path?: string
  enabled?: boolean
}

const props = defineProps<{
  skill: HubSkill
  visible: boolean
}>()

const emit = defineEmits<{
  close: []
  install: [skill: HubSkill]
  uninstall: [skill: HubSkill]
  'toggle-enabled': [skill: HubSkill, enabled: boolean]
}>()

const isInstalling = ref(false)
const isUninstalling = ref(false)
const localEnabled = ref<boolean | null>(null)

const effectiveEnabled = computed(() => localEnabled.value ?? props.skill.enabled ?? true)
const isActing = computed(() => isInstalling.value || isUninstalling.value)

watch(() => props.visible, (v) => {
  if (v) {
    isInstalling.value = false
    isUninstalling.value = false
    localEnabled.value = null
  }
})

async function onInstall(): Promise<void> {
  isInstalling.value = true
  try {
    emit('install', props.skill)
  } finally {
    isInstalling.value = false
  }
}

async function onUninstall(): Promise<void> {
  isUninstalling.value = true
  try {
    emit('uninstall', props.skill)
  } finally {
    isUninstalling.value = false
  }
}

function onToggleEnabled(): void {
  const next = !effectiveEnabled.value
  localEnabled.value = next
  emit('toggle-enabled', props.skill, next)
}
</script>

<style scoped>
@reference "tailwindcss";

.sdm-overlay {
  @apply fixed inset-0 z-50 flex items-center justify-center bg-black/40;
}

.sdm-panel {
  @apply w-full max-w-md rounded-2xl bg-white shadow-xl flex flex-col overflow-hidden;
}

.sdm-header {
  @apply flex items-start justify-between gap-3 p-5 pb-0;
}

.sdm-title-row {
  @apply flex items-center gap-2 min-w-0;
}

.sdm-title {
  @apply text-lg font-semibold text-zinc-900 m-0 truncate;
}

.sdm-badge-disabled {
  @apply shrink-0 rounded-md border border-zinc-200 bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500 leading-none;
}

.sdm-close {
  @apply shrink-0 h-7 w-7 rounded-lg border-0 bg-transparent text-zinc-400 flex items-center justify-center transition hover:bg-zinc-100 hover:text-zinc-700;
}

.sdm-close-icon {
  @apply w-4 h-4;
}

.sdm-body {
  @apply p-5 flex flex-col gap-2;
}

.sdm-meta {
  @apply flex items-center gap-2;
}

.sdm-owner {
  @apply text-xs text-zinc-400;
}

.sdm-desc {
  @apply m-0 text-sm text-zinc-600 leading-relaxed;
}

.sdm-link {
  @apply text-xs text-blue-600 hover:text-blue-700 no-underline hover:underline;
}

.sdm-footer {
  @apply p-5 pt-0;
}

.sdm-footer-actions {
  @apply flex items-center gap-2;
}

.sdm-btn {
  @apply rounded-lg px-3 py-1.5 text-sm font-medium transition border-0 disabled:opacity-50 disabled:cursor-not-allowed;
}

.sdm-btn-primary {
  @apply bg-zinc-900 text-white hover:bg-black;
}

.sdm-btn-danger {
  @apply bg-rose-600 text-white hover:bg-rose-700;
}

.sdm-btn-secondary {
  @apply bg-zinc-100 text-zinc-700 hover:bg-zinc-200;
}
</style>
