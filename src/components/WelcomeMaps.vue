<template>
  <div class="map-cards">
  <div class="map-label">What is your need?</div>
  <a href="/MAIA_Group_Network.html" target="_blank" rel="noopener" class="map-card">
    <svg class="map-card__art" viewBox="0 0 96 56" aria-hidden="true">
      <path d="M30 17 L22 39" stroke="#6b4fbb" stroke-width="1.6" stroke-dasharray="3 2" fill="none" />
      <path d="M30 17 L64 39" stroke="#6b4fbb" stroke-width="1.6" stroke-dasharray="3 2" fill="none" />
      <path d="M66 17 L30 39" stroke="#0b7f76" stroke-width="1.6" stroke-dasharray="3 2" fill="none" />
      <path d="M8 30 C 12 36, 14 40, 16 42" stroke="#b06a00" stroke-width="3" fill="none" stroke-linecap="round" />
      <rect x="20" y="4" width="22" height="13" rx="3" fill="#efedf6" stroke="#6b4fbb" stroke-width="1.2" />
      <rect x="56" y="4" width="22" height="13" rx="3" fill="#efedf6" stroke="#0b7f76" stroke-width="1.2" />
      <rect x="14" y="39" width="30" height="14" rx="3" fill="#e8f0fa" stroke="#1976d2" stroke-width="1.2" />
      <rect x="54" y="39" width="30" height="14" rx="3" fill="#e8f0fa" stroke="#1976d2" stroke-width="1.2" />
      <circle cx="6" cy="24" r="4" fill="#586675" />
    </svg>
    <span class="map-card__text">
      <span class="map-card__title">How MAIA groups connect</span>
      <span class="map-card__sub">Patient hosts, trustee.ai’s demonstration groups, and a radiologist sending a report</span>
    </span>
    <q-icon name="open_in_new" size="18px" class="map-card__icon" />
  </a>
  <div class="map-label">A technical perspective…</div>
  <a href="/MAIA_Request_Map.html" target="_blank" rel="noopener" class="map-card">
    <svg class="map-card__art" viewBox="0 0 96 56" aria-hidden="true">
      <g stroke="#c5d3e3" stroke-width="1.5" stroke-dasharray="2 3">
        <line x1="10" y1="6" x2="10" y2="52" /><line x1="29" y1="6" x2="29" y2="52" />
        <line x1="48" y1="6" x2="48" y2="52" /><line x1="67" y1="6" x2="67" y2="52" />
        <line x1="86" y1="6" x2="86" y2="52" />
      </g>
      <g fill="#1976d2"><circle cx="10" cy="6" r="3" /><circle cx="29" cy="6" r="3" /><circle cx="48" cy="6" r="3" /><circle cx="67" cy="6" r="3" /><circle cx="86" cy="6" r="3" /></g>
      <path d="M10 18 H45" stroke="#1976d2" stroke-width="2" fill="none" /><path d="M45 14 L49 18 L45 22 z" fill="#1976d2" />
      <path d="M29 30 H64" stroke="#0b7f76" stroke-width="2" fill="none" /><path d="M64 26 L68 30 L64 34 z" fill="#0b7f76" />
      <path d="M48 43 H14" stroke="#2e7d32" stroke-width="3" fill="none" /><path d="M14 38 L9 43 L14 48 z" fill="#2e7d32" />
    </svg>
    <span class="map-card__text">
      <span class="map-card__title">How MAIA handles requests</span>
      <span class="map-card__sub">Who runs what, and how a request travels from the person asking to your records</span>
    </span>
    <q-icon name="open_in_new" size="18px" class="map-card__icon" />
  </a>
  </div>
</template>

<script setup lang="ts">
/**
 * The two public diagrams (public/MAIA_Group_Network.html and
 * public/MAIA_Request_Map.html) as cards, on every welcome page: a
 * patient host's and a group-only host's.
 */
</script>

<style scoped>
.map-cards {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.map-label {
  font-size: 0.8rem;
  font-weight: 600;
  color: #586675;
  margin: 6px 0 -4px 2px;
}
.map-card {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 14px;
  border: 1px solid #d6e2ef;
  border-radius: 12px;
  background: #f7fafd;
  color: #14202b;
  text-decoration: none;
  transition: border-color 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease;
}
.map-card:hover, .map-card:focus-visible {
  border-color: #1976d2;
  box-shadow: 0 2px 10px rgba(25, 118, 210, 0.12);
  transform: translateY(-1px);
}
.map-card:focus-visible { outline: 2px solid #1976d2; outline-offset: 2px; }
.map-card__art { flex: none; width: 88px; height: 52px; }
.map-card__text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.map-card__title { font-weight: 600; font-size: 0.95rem; }
.map-card__sub { font-size: 0.8rem; color: #586675; line-height: 1.35; }
.map-card__icon { flex: none; color: #1976d2; margin-left: auto; }
@media (prefers-reduced-motion: reduce) {
  .map-card { transition: none; }
  .map-card:hover { transform: none; }
}
</style>
