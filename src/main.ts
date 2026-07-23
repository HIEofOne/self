/**
 * User app Vue main entry point
 */

import { createApp } from 'vue';
import { Quasar, Dialog, Notify } from 'quasar';
import App from './App.vue';

// Quasar components and styles
import '@quasar/extras/material-icons/material-icons.css';
import 'quasar/src/css/index.sass';

const app = createApp(App);

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

