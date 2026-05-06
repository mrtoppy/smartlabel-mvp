import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // 🛑 เพิ่มบล็อกนี้เข้าไป เพื่อบังคับให้ระบบรู้จักโค้ดรุ่นเก่าครับ
  optimizeDeps: {
    include: ['promptpay-qr', 'crc'] 
  }
})