<template>
  <div class="skills-hub">
    <div class="skills-hub-header">
      <h2 class="skills-hub-title">Skills Hub</h2>
      <p class="skills-hub-subtitle">Browse and discover skills from the OpenClaw community</p>
    </div>

    <div class="skills-hub-search-wrap">
      <IconTablerSearch class="skills-hub-search-icon" />
      <input
        ref="searchRef"
        v-model="query"
        class="skills-hub-search"
        type="text"
        placeholder="Search skills... (e.g. flight, docker, react)"
        @input="onSearchInput"
      />
      <span v-if="totalCount > 0" class="skills-hub-count">{{ totalCount }} skills</span>
    </div>

    <div v-if="toast" class="skills-hub-toast" :class="toastClass">{{ toast.text }}</div>

    <div v-if="installedSkills.length > 0" class="skills-hub-section">
      <button class="skills-hub-section-toggle" type="button" @click="isInstalledOpen = !isInstalledOpen">
        <span class="skills-hub-section-title">Installed ({{ installedSkills.length }})</span>
        <IconTablerChevronRight class="skills-hub-section-chevron" :class="{ 'is-open': isInstalledOpen }" />
      </button>
      <div v-if="isInstalledOpen" class="skills-hub-grid">
        <SkillCard v-for="skill in installedSkills" :key="skill.url" :skill="skill" @select="openDetail" />
      </div>
    </div>

    <div class="skills-hub-section">
      <div v-if="isLoading" class="skills-hub-loading">Loading skills...</div>
      <div v-else-if="error" class="skills-hub-error">{{ error }}</div>
      <template v-else>
        <div v-if="browseSkills.length > 0" class="skills-hub-grid">
          <SkillCard v-for="skill in browseSkills" :key="skill.url" :skill="skill" @select="openDetail" />
        </div>
        <div v-else-if="query.trim()" class="skills-hub-empty">No skills found for "{{ query }}"</div>
      </template>
    </div>

    <SkillDetailModal
      :skill="detailSkill"
      :visible="isDetailOpen"
      @close="isDetailOpen = false"
      @install="handleInstall"
      @uninstall="handleUninstall"
      @toggle-enabled="handleToggleEnabled"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import IconTablerSearch from '../icons/IconTablerSearch.vue'
import IconTablerChevronRight from '../icons/IconTablerChevronRight.vue'
import SkillCard from './SkillCard.vue'
import SkillDetailModal, { type HubSkill } from './SkillDetailModal.vue'

const searchRef = ref<HTMLInputElement | null>(null)
const query = ref('')
const results = ref<HubSkill[]>([])
const totalCount = ref(0)
const isLoading = ref(false)
const error = ref('')
const isInstalledOpen = ref(false)
const isDetailOpen = ref(false)
const detailSkill = ref<HubSkill>({ name: '', owner: '', description: '', stars: 0, updatedAt: '', url: '', installed: false })
const toast = ref<{ text: string; type: 'success' | 'error' } | null>(null)
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let toastTimer: ReturnType<typeof setTimeout> | null = null

const toastClass = computed(() => toast.value?.type === 'error' ? 'skills-hub-toast-error' : 'skills-hub-toast-success')
const installedSkills = computed(() => results.value.filter((s) => s.installed))
const browseSkills = computed(() => results.value.filter((s) => !s.installed))

function showToast(text: string, type: 'success' | 'error' = 'success'): void {
  toast.value = { text, type }
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.value = null }, 3000)
}

async function fetchSkills(q: string): Promise<void> {
  isLoading.value = true
  error.value = ''
  try {
    const params = new URLSearchParams()
    if (q.trim()) params.set('q', q.trim())
    params.set('limit', '100')
    const resp = await fetch(`/codex-api/skills-hub?${params}`)
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const data = (await resp.json()) as { data: HubSkill[]; total: number }
    results.value = data.data
    totalCount.value = data.total
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to load skills'
  } finally {
    isLoading.value = false
  }
}

function onSearchInput(): void {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => fetchSkills(query.value), 300)
}

function openDetail(skill: HubSkill): void {
  detailSkill.value = skill
  isDetailOpen.value = true
}

async function handleInstall(skill: HubSkill): Promise<void> {
  try {
    const resp = await fetch('/codex-api/skills-hub/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: skill.owner, name: skill.name }),
    })
    const data = (await resp.json()) as { ok?: boolean; error?: string }
    if (!data.ok) throw new Error(data.error || 'Install failed')
    showToast(`${skill.name} skill installed`)
    isDetailOpen.value = false
    await fetchSkills(query.value)
  } catch (e) {
    showToast(e instanceof Error ? e.message : 'Failed to install skill', 'error')
  }
}

async function handleUninstall(skill: HubSkill): Promise<void> {
  try {
    const resp = await fetch('/codex-api/skills-hub/uninstall', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: skill.name, path: skill.path }),
    })
    const data = (await resp.json()) as { ok?: boolean; error?: string }
    if (!data.ok) throw new Error(data.error || 'Uninstall failed')
    showToast(`${skill.name} skill uninstalled`)
    isDetailOpen.value = false
    await fetchSkills(query.value)
  } catch (e) {
    showToast(e instanceof Error ? e.message : 'Failed to uninstall skill', 'error')
  }
}

async function handleToggleEnabled(skill: HubSkill, enabled: boolean): Promise<void> {
  try {
    const resp = await fetch('/codex-api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'skills/config/write', params: { path: skill.path, enabled } }),
    })
    if (!resp.ok) throw new Error('Failed to update skill')
    showToast(`${skill.name} skill ${enabled ? 'enabled' : 'disabled'}`)
    await fetchSkills(query.value)
  } catch (e) {
    showToast(e instanceof Error ? e.message : 'Failed to update skill', 'error')
  }
}

onMounted(() => {
  void fetchSkills('')
})
</script>

<style scoped>
@reference "tailwindcss";

.skills-hub {
  @apply flex flex-col gap-4 p-6 max-w-4xl mx-auto w-full overflow-y-auto h-full;
}

.skills-hub-header {
  @apply flex flex-col gap-1;
}

.skills-hub-title {
  @apply text-2xl font-semibold text-zinc-900 m-0;
}

.skills-hub-subtitle {
  @apply text-sm text-zinc-500 m-0;
}

.skills-hub-search-wrap {
  @apply flex items-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 py-2 transition focus-within:border-zinc-400 focus-within:shadow-sm;
}

.skills-hub-search-icon {
  @apply w-4 h-4 text-zinc-400 shrink-0;
}

.skills-hub-search {
  @apply flex-1 min-w-0 bg-transparent text-sm text-zinc-800 placeholder-zinc-400 outline-none border-none p-0;
}

.skills-hub-count {
  @apply text-xs text-zinc-400 whitespace-nowrap;
}

.skills-hub-toast {
  @apply rounded-lg px-3 py-2 text-sm font-medium;
}

.skills-hub-toast-success {
  @apply border border-emerald-200 bg-emerald-50 text-emerald-700;
}

.skills-hub-toast-error {
  @apply border border-rose-200 bg-rose-50 text-rose-700;
}

.skills-hub-section {
  @apply flex flex-col gap-2;
}

.skills-hub-section-toggle {
  @apply flex items-center gap-1.5 border-0 bg-transparent p-0 text-sm font-medium text-zinc-600 transition hover:text-zinc-900 cursor-pointer;
}

.skills-hub-section-title {
  @apply text-sm font-medium;
}

.skills-hub-section-chevron {
  @apply w-3.5 h-3.5 transition-transform;
}

.skills-hub-section-chevron.is-open {
  @apply rotate-90;
}

.skills-hub-grid {
  @apply grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3;
}

.skills-hub-loading {
  @apply text-sm text-zinc-400 py-8 text-center;
}

.skills-hub-error {
  @apply text-sm text-rose-600 py-4 text-center rounded-lg border border-rose-200 bg-rose-50;
}

.skills-hub-empty {
  @apply text-sm text-zinc-400 py-8 text-center;
}
</style>
