import { initializeApp } from "firebase/app";
import { getFirestore, collection, addDoc, serverTimestamp, query, where, getDocs } from "firebase/firestore";

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

async function sendFacebookMessage(pageId, senderPsid, messageText) {
  const PAGE_ACCESS_TOKEN = "EAAV0RD7eKcQBRqHOZBKlnCjVfGCilsNHYONaIw46ChaDr8R34xzwKm5zZBAqRzAJUxfXNXrwWZAdA3XwZBGsr6D3gkQjqZBhCwax9wx52ZBXXVacxBglToYXuHxTKQZB6Lefq1403wzpfms9xJSp7fqtRIrY5QDc7nSuLG2faZAvPS4s3D58BrzkfIZBUiRGw3lXwio4OMuAuUwZDZD"; // 🔐 วางกุญแจ Token ที่ได้จากรูป d17429 เรียบร้อยครับ
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

    // ⚡ 1. โหมดส่งข้อความแจ้งเลขแทรคกิ้งจากหน้าบ้าน
    if (body.action === 'send_tracking') {
      const { pageId, senderId, trackingNum, customerName } = body;
      if (!pageId || !senderId || !trackingNum) {
        return res.status(400).json({ error: "ข้อมูลไม่ครบถ้วนสำหรับการส่งข้อความ" });
      }
      try {
        const msgText = `ขอบคุณที่อุดหนุนครับ! 🙏\nคุณลูกค้า: ${customerName || 'คุณลูกค้า'}\n📦 เลขพัสดุของคุณคือ: ${trackingNum}\n🚚 ตรวจสอบสถานะได้ที่: https://track.thailandpost.co.th/?trackNumber=${trackingNum}\n\nSmartLabel ยินดีให้บริการครับ ✅`;
        const result = await sendFacebookMessage(pageId, senderId, msgText);
        return res.status(200).json({ success: true, result });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    // 📥 2. โหมดรับแชทอัตโนมัติจาก Facebook (ฉบับปลดล็อกสิทธิ์ไหลลื่น)
    if (body.object === 'page') {
      try {
        for (const entry of body.entry) {
          if (!entry.messaging || entry.messaging.length === 0) continue;

          const page_id = entry.id; 
          const webhook_event = entry.messaging[0];
          const sender_psid = webhook_event.sender.id;
          
          if (webhook_event.message && webhook_event.message.text) {
            const messageText = webhook_event.message.text;
            console.log(`💬 ยิงสัญญาณเข้า: [${sender_psid}] -> [${page_id}]: ${messageText}`);
            
            // 🔍 ค้นหาเจ้าของร้านในระบบ
            const q = query(collection(db, "users"), where("connectedPages", "array-contains", page_id));
            const querySnapshot = await getDocs(q);
            
            let ownerId = "unknown";
            if (!querySnapshot.empty) {
                ownerId = querySnapshot.docs[0].id;
            }

            // 💾 บันทึกลงฐานข้อมูลตรงๆ (ไม่ต้องรอตรวจสิทธิ์ล็อกอินบอทซ้ำซ้อน)
            await addDoc(collection(db, "chats"), {
              senderId: sender_psid,
              message: messageText,
              status: "new",
              pageId: page_id,
              ownerId: ownerId,
              timestamp: serverTimestamp()
            });
            console.log(`✅ ข้อความไหลเข้าฐานข้อมูลเรียบร้อย! (Owner: ${ownerId})`);
          }
        }
        return res.status(200).send('EVENT_RECEIVED');
        
      } catch (error) {
        console.error("❌ บันทึกแชทล้มเหลวเนื่องจาก:", error);
        return res.status(500).send('Server Error');
      }
    } else {
      return res.status(404).send('Not Found');
    }
  }

  res.setHeader('Allow', ['GET', 'POST']);
  return res.status(405).send(`Method ${req.method} Not Allowed`);
}