import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
// เพิ่มการ import messaging เข้าไปครับ
import { getMessaging } from "firebase/messaging";

// TODO: เอา Config จาก Firebase Console ของพาร์ทเนอร์มาวางทับตรงนี้ครับ
const firebaseConfig = {
  apiKey: "AIzaSyDqRCBpJthakk9JuDevn0EieDRLrVUqR10",
  authDomain: "smartlabel-90891.firebaseapp.com",
  projectId: "smartlabel-90891",
  storageBucket: "smartlabel-90891.firebasestorage.app",
  messagingSenderId: "692671657416",
  appId: "1:692671657416:web:15b5107260be704531fcfd",
  measurementId: "G-4YT0GXW1YM"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// เปิดใช้งานระบบ Messaging และส่งออกไปให้ไฟล์อื่นใช้
export const messaging = getMessaging(app);