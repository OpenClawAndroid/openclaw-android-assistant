<template>
  <button
    class="skill-card"
    type="button"
    :class="{ 'is-disabled': skill.installed && skill.enabled === false }"
    @click="$emit('select', skill)"
  >
    <div class="skill-card-header">
      <span class="skill-card-name">{{ skill.name }}</span>
      <span v-if="skill.installed && skill.enabled === false" class="skill-card-badge-disabled">Disabled</span>
      <span v-else-if="skill.installed" class="skill-card-badge">Installed</span>
    </div>
    <span class="skill-card-owner">{{ skill.owner }}</span>
    <p v-if="skill.description" class="skill-card-desc">{{ skill.description }}</p>
  </button>
</template>

<script setup lang="ts">
defineProps<{
  skill: {
    name: string
    owner: string
    description: string
    url: string
    installed: boolean
    enabled?: boolean
  }
}>()

defineEmits<{
  select: [skill: unknown]
}>()
</script>

<style scoped>
@reference "tailwindcss";

.skill-card {
  @apply flex flex-col gap-1 rounded-xl border border-zinc-200 bg-white p-3 text-left transition hover:border-zinc-300 hover:shadow-sm cursor-pointer;
}

.skill-card.is-disabled {
  @apply opacity-50;
}

.skill-card-header {
  @apply flex items-center gap-2;
}

.skill-card-name {
  @apply text-sm font-medium text-zinc-900 truncate;
}

.skill-card-badge {
  @apply shrink-0 rounded-md border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 leading-none;
}

.skill-card-badge-disabled {
  @apply shrink-0 rounded-md border border-zinc-200 bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500 leading-none;
}

.skill-card-owner {
  @apply text-xs text-zinc-400;
}

.skill-card-desc {
  @apply m-0 text-xs text-zinc-500 line-clamp-2;
}
</style>
