import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // lets friends on the same wifi open it from their phones
    proxy: {
      '/socket.io': { target: 'http://localhost:3001', ws: true },
    },
  },
});
