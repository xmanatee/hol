import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'
import { defineConfig } from 'vite'

const manualChunks = id => {
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

const rolldownCodeSplitting = {
  groups: [
    {
      name: 'vendor-react',
      test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/,
      priority: 50,
    },
    {
      name: 'vendor-three-addons',
      test: /node_modules[\\/]three[\\/](addons|examples)[\\/]/,
      priority: 40,
    },
    {
      name: 'vendor-three-core',
      test: /node_modules[\\/]three[\\/]/,
      priority: 30,
    },
    {
      name: 'vendor-r3f',
      test: /node_modules[\\/]@react-three[\\/]/,
      priority: 20,
    },
    {
      name: 'vendor-elevenlabs',
      test: /node_modules[\\/]@elevenlabs[\\/]/,
      priority: 10,
    },
  ],
}

export default defineConfig({
  plugins: [react(), tailwind()],
  build: {
    chunkSizeWarningLimit: 750,
    rolldownOptions: {
      output: {
        codeSplitting: rolldownCodeSplitting,
      },
    },
    rollupOptions: {
      output: {
        manualChunks,
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
