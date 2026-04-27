import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

// TODO: เอา Config จาก Firebase Console ของพาร์ทเนอร์มาวางทับตรงนี้ครับ
const firebaseConfig = {
  apiKey: "AIzaSyYourAPIKeyHere...",
  authDomain: "smartlabel-pro.firebaseapp.com",
  projectId: "smartlabel-pro",
  storageBucket: "smartlabel-pro.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abcdef"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);