import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwind()],
  build: {
    chunkSizeWarningLimit: 750,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react') || id.includes('node_modules/scheduler')) {
            return 'vendor-react'
          }

          if (id.includes('node_modules/@react-three')) {
            return 'vendor-r3f'
          }

          if (id.includes('node_modules/three/addons') || id.includes('node_modules/three/examples')) {
            return 'vendor-three-addons'
          }

          if (id.includes('node_modules/three')) {
            return 'vendor-three-core'
          }

          if (id.includes('node_modules/@elevenlabs')) {
            return 'vendor-elevenlabs'
          }
        }
      }
    }
  },
  server: {
    host: '127.0.0.1',
    port: 5274,
    strictPort: true,
    headers: {
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
    },
    fs: {
      allow: ['..']
    }
  },
  preview: {
    host: '127.0.0.1',
    port: 4274,
    strictPort: true,
    headers: {
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
    }
  },
  optimizeDeps: {
    exclude: ['onnxruntime-web']
  },
  define: {
    global: 'globalThis',
  }
})
