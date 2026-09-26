import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { quasar, transformAssetUrls } from '@quasar/vite-plugin';
import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import net from 'net';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_PORT = 3001;

/** Returns true if something is already accepting connections on port (so we should not spawn). */
function portHasServer(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const onError = () => {
      socket.destroy();
      resolve(false);
    };
    socket.setTimeout(500);
    socket.once('error', onError);
    socket.once('timeout', onError);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.connect(port, '127.0.0.1');
  });
}

function backendPlugin() {
  let server: ChildProcess | null = null;
  return {
    name: 'run-backend',
    async configureServer() {
      if (await portHasServer(API_PORT)) {
        return;
      }
      server = spawn('node', ['server/index.js'], {
        cwd: path.resolve(__dirname),
        stdio: 'inherit',
        env: { ...process.env, PORT: String(API_PORT) }
      });
      server.on('error', (err) => console.error('Backend failed to start:', err));
      server.on('exit', (code) => {
        if (code !== null && code !== 0) {
          console.warn('Backend exited with code', code);
        }
        server = null;
      });
      await new Promise((r) => setTimeout(r, 1500));
    },
    closeBundle() {
      if (server) {
        server.kill();
        server = null;
      }
    }
  };
}

export default defineConfig({
  plugins: [
    vue({
      template: { transformAssetUrls }
    }),
    quasar({
      sassVariables: true
    }),
    backendPlugin()
  ],
  server: {
    port: 5173,
    // Let OPTIONS reach the backend: GNAP discovery is an OPTIONS request
    // (RFC 9635 §9), and Vite's own CORS handler would answer it empty.
    cors: false,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true
      },
      // GNAP (P4): the grant, continue, interaction and resource-server paths.
      '/gnap': {
        target: 'http://localhost:3001',
        changeOrigin: true
      }
    }
  },
  optimizeDeps: {
    include: ['punycode', 'events']
  }
});

