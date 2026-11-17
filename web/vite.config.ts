import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import legacy from '@vitejs/plugin-legacy'

export default defineConfig({
    plugins: [
        react(),
        legacy({
            targets: ['chrome >= 53', 'safari >= 11'], // Covers most Smart TVs
            additionalLegacyPolyfills: ['regenerator-runtime/runtime'],
        }),
    ],

    server: {
        port: 3000,
        proxy: {
            '/api': {
                target: 'http://localhost:8000',
                changeOrigin: true,
            },
        },
    },
})