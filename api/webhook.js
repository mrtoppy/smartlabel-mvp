import { initializeApp } from "firebase/app";
import { getFirestore, collection, addDoc, serverTimestamp } from "firebase/firestore";
import { getAuth, signInWithEmailAndPassword } from "firebase/auth";

// 🔥 1. เอา firebaseConfig จากหน้า App.jsx ของพาร์ทเนอร์มาวางตรงนี้เลยครับ
const firebaseConfig = {
  apiKey: "AIzaSyDqRCBpJthakk9JuDevn0EieDRLrVUqR10",
  authDomain: "smartlabel-90891.firebaseapp.com",
  projectId: "smartlabel-90891",
  storageBucket: "smartlabel-90891.firebasestorage.app",
  messagingSenderId: "692671657416",
  appId: "1:692671657416:web:15b5107260be704531fcfd",
  measurementId: "G-4YT0GXW1YM"
};

// เริ่มต้นเปิดระบบ Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

export default async function handler(req, res) {
  const VERIFY_TOKEN = "smartlabel_super_secret_2026";

  // โหมดที่ 1: Facebook ยิงมาเพื่อยืนยันตัวตน
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    } else {
      return res.status(403).send('Forbidden');
    }
  }

  // โหมดที่ 2: Facebook ส่งข้อความแชทมาให้
  if (req.method === 'POST') {
    const body = req.body;

    if (body.object === 'page') {
      try {
        // 🤖 2. สั่งให้บอท Login เข้าสู่ระบบก่อนทำงาน!
        await signInWithEmailAndPassword(auth, "bot@smartlabel.com", "bot2026");

        // วนลูปอ่านข้อความ
        for (const entry of body.entry) {
          const webhook_event = entry.messaging[0];
          const sender_psid = webhook_event.sender.id;
          
          if (webhook_event.message && webhook_event.message.text) {
            const messageText = webhook_event.message.text;
            console.log(`💬 แชทจากลูกค้า [${sender_psid}]: ${messageText}`);
            
            // 💾 3. บันทึกข้อความลงตาราง 'chats' ใน Firestore
            await addDoc(collection(db, "chats"), {
              senderId: sender_psid,
              message: messageText,
              timestamp: serverTimestamp(),
              status: "new" // สถานะบอกว่าแชทใหม่ยังไม่ได้พิมพ์
            });
            console.log("✅ บันทึกลง Firestore สำเร็จ!");
          }
        }
        return res.status(200).send('EVENT_RECEIVED');
        
      } catch (error) {
        console.error("❌ เกิดข้อผิดพลาด:", error);
        return res.status(500).send('Server Error');
      }
    } else {
      return res.status(404).send('Not Found');
    }
  }

  res.setHeader('Allow', ['GET', 'POST']);
  return res.status(405).send(`Method ${req.method} Not Allowed`);
}