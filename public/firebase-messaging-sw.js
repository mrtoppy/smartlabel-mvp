// ดึงไลบรารีของ Firebase มาใช้งานใน Background
importScripts('https://www.gstatic.com/firebasejs/8.10.1/firebase-app.js');
importScripts('https://www.gstatic.com/firebasejs/8.10.1/firebase-messaging.js');

// 🚨 ให้ท่าน CEO เอา Config ของโปรเจกต์จากไฟล์ firebase.js ของเรามาใส่ตรงนี้ครับ
firebase.initializeApp({
  apiKey: "AIzaSyDqRCBpJthakk9JuDevn0EieDRLrVUqR10",
  authDomain: "smartlabel-90891.firebaseapp.com",
  projectId: "smartlabel-90891",
  storageBucket: "smartlabel-90891.firebasestorage.app",
  messagingSenderId: "692671657416",
  appId: "1:692671657416:web:15b5107260be704531fcfd",
});

const messaging = firebase.messaging();

// ฟังก์ชันคอยดักฟังแจ้งเตือน ตอนที่แม่ค้าย่อหน้าจอเว็บลงไป
messaging.onBackgroundMessage(function(payload) {
  console.log('[บุรุษไปรษณีย์] ได้รับข้อความแจ้งเตือน! ', payload);
  
  const notificationTitle = payload.notification.title;
  const notificationOptions = {
    body: payload.notification.body,
    icon: '/vite.svg' // รูปไอคอนที่จะเด้งเตือน (ใช้โลโก้เว็บเราได้เลยครับ)
  };

  self.registration.showNotification(notificationTitle, notificationOptions);
});