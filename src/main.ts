/**
 * User app Vue main entry point
 */

import { createApp } from 'vue';
import { Quasar, Dialog, Notify } from 'quasar';
import App from './App.vue';
import RequestPage from './components/RequestPage.vue';

// Quasar components and styles
import '@quasar/extras/material-icons/material-icons.css';
import 'quasar/src/css/index.sass';

// A patient's personal request link (/r/<asId>) opens the requester's page,
// never the patient app (group_requests.md §10.10).
const isRequestPage = /^\/r\/[0-9a-f]{32}\/?$/.test(window.location.pathname);
const app = createApp(isRequestPage ? RequestPage : App);

app.use(Quasar, {
  plugins: {
    Dialog,
    Notify
  },
  config: {
    // Toasts linger long enough to read (default was 5s) and every one
    // carries an X so nobody has to wait a notification out.
    notify: {
      timeout: 10000,
      actions: [{ icon: 'close', color: 'white', round: true, dense: true }]
    }
  }
});

// Defer mount until page is fully loaded to avoid "Layout was forced before the page was fully loaded"
// and reduce flash of unstyled content (FOUC), especially in Firefox
function mountApp() {
  app.mount('#app');
}
if (document.readyState === 'complete') {
  mountApp();
} else {
  window.addEventListener('load', mountApp);
}

