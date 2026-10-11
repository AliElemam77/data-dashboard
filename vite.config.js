import { defineConfig } from 'vite';
import fs from 'fs';
import path from 'path';

function storageBridgePlugin() {
  const syncFile = path.resolve(__dirname, 'scratch', 'shared_clients.json');
  return {
    name: 'storage-bridge',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        // Enable CORS for all origins and ports (including Tab3 on port 5174)
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
          res.statusCode = 204;
          res.end();
          return;
        }

        if (req.url && req.url.startsWith('/api/storage/clients')) {
          if (req.method === 'GET') {
            let data = {};
            if (fs.existsSync(syncFile)) {
              try { data = JSON.parse(fs.readFileSync(syncFile, 'utf8')); } catch(e){}
            }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(data));
            return;
          }
          if (req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
              try {
                const dir = path.dirname(syncFile);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(syncFile, body, 'utf8');
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ ok: true }));
              } catch(e) {
                res.statusCode = 500;
                res.end(JSON.stringify({ error: e.message }));
              }
            });
            return;
          }
        }
        next();
      });
    }
  };
}

export default defineConfig({
  plugins: [storageBridgePlugin()],
  build: {
    chunkSizeWarningLimit: 4500,
    outDir: 'dist',
  },
  server: {
    port: 3000,
    cors: true,
  },
});
