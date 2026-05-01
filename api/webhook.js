import { initializeApp } from "firebase/app";
import { getFirestore, collection, addDoc, serverTimestamp, query, where, getDocs } from "firebase/firestore";
import { getAuth, signInWithEmailAndPassword } from "firebase/auth";

// 🔥 1. เอา firebaseConfig จากหน้า App.jsx ของพาร์ทเนอร์มาวางตรงนี้เลยครับ
const firebaseConfig = {
  apiKey: "AIzaSyDqRCbpJthakk9JuDevn0EieDRLrVUqR10",
  authDomain: "smartlabel-90891.firebaseapp.com",
  projectId: "smartlabel-90891",
  storageBucket: "smartlabel-90891.firebasestorage.app",
  messagingSenderId: "602671657416",
  appId: "1:602671657416:web:15b5107268he704531fcfd",
  measurementId: "G-4YT0GXW1YM"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

export default async function handler(req, res) {
  const VERIFY_TOKEN = "smartlabel_super_secret_2026";

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

  if (req.method === 'POST') {
    const body = req.body;

    if (body.object === 'page') {
      try {
        await signInWithEmailAndPassword(auth, "bot@smartlabel.com", "bot2026");

        for (const entry of body.entry) {
          // 🛑 ดึง Page ID (เพจที่รับแชท) ออกมาก่อน
          const page_id = entry.id; 
          const webhook_event = entry.messaging[0];
          const sender_psid = webhook_event.sender.id;
          
          if (webhook_event.message && webhook_event.message.text) {
            const messageText = webhook_event.message.text;
            console.log(`💬 แชทจากลูกค้า [${sender_psid}] ถึงเพจ [${page_id}]: ${messageText}`);
            
            // 🔍 ค้นหาว่า Page ID นี้ เป็นของแม่ค้าคนไหนในระบบของเรา
            const q = query(collection(db, "users"), where("connectedPages", "array-contains", page_id));
            const querySnapshot = await getDocs(q);
            
            let ownerId = "unknown";
            if (!querySnapshot.empty) {
                // ถ้าเจอแม่ค้าที่เป็นเจ้าของเพจ ให้เอา ID แม่ค้ามาบันทึกด้วย
                ownerId = querySnapshot.docs[0].id;
            }

            // 💾 บันทึกข้อความลง Firestore พร้อมระบุเจ้าของเพจ
            await addDoc(collection(db, "chats"), {
              senderId: sender_psid,
              pageId: page_id,
              ownerId: ownerId, // 👈 จุดสำคัญ: บอกว่าแชทนี้เป็นของใคร
              message: messageText,
              timestamp: serverTimestamp(),
              status: "new" 
            });
            console.log(`✅ บันทึกลง Firestore สำเร็จ! (Owner: ${ownerId})`);
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