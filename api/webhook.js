import { initializeApp } from "firebase/app";
import { getFirestore, collection, addDoc, serverTimestamp, query, where, getDocs } from "firebase/firestore";
import { getAuth, signInWithEmailAndPassword } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyDqRCBpJthakk9JuDevn0EieDRLrVUqR10",
  authDomain: "smartlabel-90891.firebaseapp.com",
  projectId: "smartlabel-90891",
  storageBucket: "smartlabel-90891.firebasestorage.app",
  messagingSenderId: "692671657416",
  appId: "1:692671657416:web:15b5107260be704531fcfd",
  measurementId: "G-4YT0GXW1YM"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// ⚡ ฟังก์ชันสำหรับยิงข้อความเข้า Facebook Send API
async function sendFacebookMessage(pageId, senderPsid, messageText) {
  // 💡 ข้อแนะนำในอนาคต: ควรเก็บ PAGE_ACCESS_TOKEN ของแต่ละเพจไว้ในฐานข้อมูล (เช่น ในคอลเลกชัน users) 
  // ตรงนี้สมมติให้ใช้ Token หลัก หรือดึงจากระบบที่ท่านเซตอัปไว้ครับ
  const PAGE_ACCESS_TOKEN = "EAAV0RD7eKcQBRqHOZBKlnCjVfGCilsNHYONaIw46ChaDr8R34xzwKm5zZBAqRzAJUxfXNXrwWZAdA3XwZBGsr6D3gkQjqZBhCwax9wx52ZBXXVacxBglToYXuHxTKQZB6Lefq1403wzpfms9xJSp7fqtRIrY5QDc7nSuLG2faZAvPS4s3D58BrzkfIZBUiRGw3lXwio4OMuAuUwZDZD"; 
  
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`;
  
  const payload = {
    recipient: { id: senderPsid },
    message: { text: messageText }
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  return response.json();
}

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

    // ⚡ เพิ่มเงื่อนไข: รองรับการสั่งส่งข้อความแจ้งเลขพัสดุจากหน้าบ้าน SmartLabel
    if (body.action === 'send_tracking') {
      const { pageId, senderId, trackingNum, customerName } = body;
      
      if (!pageId || !senderId || !trackingNum) {
        return res.status(400).json({ error: "ข้อมูลไม่ครบถ้วนสำหรับการส่งข้อความ" });
      }

      try {
        const msgText = `ขอบคุณที่อุดหนุนครับ! 🙏\nคุณลูกค้า: ${customerName || 'คุณลูกค้า'}\n📦 เลขพัสดุของคุณคือ: ${trackingNum}\n🚚 ตรวจสอบสถานะได้ที่: https://track.thailandpost.co.th/?trackNumber=${trackingNum}\n\nSmartLabel ยินดีให้บริการครับ ✅`;
        
        const result = await sendFacebookMessage(pageId, senderId, msgText);
        console.log("🤖 ผลการส่งบอทแจ้งเลขพัสดุ:", result);
        
        return res.status(200).json({ success: true, result });
      } catch (err) {
        console.error("❌ บอทส่งข้อความล้มเหลว:", err);
        return res.status(500).json({ error: err.message });
      }
    }

    // 📥 ระบบรับ Webhook แชทเข้าจาก Facebook เดิมของท่าน CEO
    if (body.object === 'page') {
      try {
        await signInWithEmailAndPassword(auth, "bot@smartlabel.com", "bot2026");

        for (const entry of body.entry) {
          const page_id = entry.id; 
          const webhook_event = entry.messaging[0];
          const sender_psid = webhook_event.sender.id;
          
          if (webhook_event.message && webhook_event.message.text) {
            const messageText = webhook_event.message.text;
            console.log(`💬 แชทจากลูกค้า [${sender_psid}] ถึงเพจ [${page_id}]: ${messageText}`);
            
            const q = query(collection(db, "users"), where("connectedPages", "array-contains", page_id));
            const querySnapshot = await getDocs(q);
            
            let ownerId = "unknown";
            if (!querySnapshot.empty) {
                ownerId = querySnapshot.docs[0].id;
            }

            await addDoc(collection(db, "chats"), {
              senderId: sender_psid,
              message: messageText,
              status: "new",
              pageId: page_id,
              ownerId: ownerId,
              timestamp: serverTimestamp()
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