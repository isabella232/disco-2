<template>
  <svg
    xmlns="http://www.w3.org/2000/svg"
    fill="none"
    :class="customClass"
    :viewBox="viewBox"
    stroke="currentColor"
  >
    <path
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="2"
      d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"
    />
  </svg>
</template>
<script>
export default {
  name: 'home-icon',
  props: {
    customClass: {
      default: 'w-7 h-7',
      type: String
    },
    viewBox: { default: '0 0 24 24', type: String }
  }
}
</script>
