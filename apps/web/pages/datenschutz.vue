<script setup lang="ts">
definePageMeta({
  public: true,
  layout: false,
});

// Alte URL (u. a. in App Store und Play Console hinterlegt) leitet auf die Webseite weiter.
await navigateTo(usePrivacyUrl().value, { external: true, redirectCode: 302 });
</script>

<template>
  <div />
</template>
