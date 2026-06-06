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

// 📡 ฟังก์ชันส่งข้อความ: รับกุญแจเฉพาะของแต่ละร้านเข้าไปยิง API
async function sendFacebookMessage(pageAccessToken, senderPsid, messageText) {
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${pageAccessToken}`;
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

    // ⚡ [จุดอัปเกรดที่ 1] โหมดกดส่งเลขพัสดุสายฟ้าแลบจากหน้าตาราง Dashboard (SaaS Version)
    if (body.action === 'send_tracking') {
      const { pageId, senderId, trackingNum, customerName } = body;
      if (!pageId || !senderId || !trackingNum) {
        return res.status(400).json({ error: "ข้อมูลไม่ครบถ้วนสำหรับการส่งข้อความ" });
      }
      try {
        // 🔍 สลับกุญแจ: ค้นหา Token ของร้านค้าเจ้าของเพจนี้ในฐานข้อมูล
        const qStore = query(collection(db, "users"), where("connectedPages", "array-contains", pageId));
        const storeSnapshot = await getDocs(qStore);
        
        if (storeSnapshot.empty || !storeSnapshot.docs[0].data().pageAccessToken) {
          return res.status(404).json({ error: "ไม่พบกุญแจเชื่อมต่อ Facebook ของร้านค้านี้" });
        }
        
        const storeToken = storeSnapshot.docs[0].data().pageAccessToken;
        const msgText = `ขอบคุณที่อุดหนุนครับ! 🙏\nคุณลูกค้า: ${customerName || 'คุณลูกค้า'}\n📦 เลขพัสดุของคุณคือ: ${trackingNum}\n🚚 ตรวจสอบสถานะได้ที่: https://track.thailandpost.co.th/?trackNumber=${trackingNum}\n\nSmartLabel ยินดีให้บริการครับ ✅`;
        
        // ยิงส่งข้อความออกไปด้วย Token ของร้านค้านั้นๆ
        const result = await sendFacebookMessage(storeToken, senderId, msgText);
        return res.status(200).json({ success: true, result });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    // 📥 [จุดอัปเกรดที่ 2] โหมดรับแชทอัตโนมัติจาก Facebook เข้า Smart Inbox 
    if (body.object === 'page') {
      try {
        for (const entry of body.entry) {
          const page_id = entry.id; 

          if (entry.messaging && entry.messaging[0]) {
            const messaging_event = entry.messaging[0];
            const sender_psid = messaging_event.sender.id;

            // 🔍 สลับท่อส่ง: ค้นหาใน Firestore ว่าใครเชื่อมต่อเพจไอดีนี้อยู่
            const usersRef = collection(db, "users");
            const q = query(usersRef, where("connectedPages", "array-contains", page_id));
            const querySnapshot = await getDocs(q);

            let currentStoreToken = null;
            let ownerId = null;

            if (!querySnapshot.empty) {
              const userData = querySnapshot.docs[0].data();
              ownerId = querySnapshot.docs[0].id; 
              currentStoreToken = userData.pageAccessToken; // 🔑 ดึงกุญแจร้านค้าย่อยมาสลับใช้
            }
            
            // บันทึกข้อมูลแชทไหลเข้า Smart Inbox
            if (messaging_event.message && messaging_event.message.text) {
              const incomingMessage = messaging_event.message.text;
              
              await addDoc(collection(db, "chats"), {
                pageId: page_id,
                senderId: sender_psid,
                message: incomingMessage,
                ownerId: ownerId || "unknown", // ⚡ ผูกเข้าตะกร้าร้านค้านั้นๆ โดยตรง ข้อมูลไม่ปนกัน
                status: "new", // สเตตัสเป็นแชทใหม่เสมอ
                timestamp: serverTimestamp()
              });
            }

            // ถ้าบอทอยากคุยตอบกลับอัตโนมัติยามเช้า (ถ้าต้องการใช้งานสามารถเปิดคอมเมนต์ได้ครับ)
            if (currentStoreToken && messaging_event.message) {
               // await sendFacebookMessage(currentStoreToken, sender_psid, "ระบบได้รับที่อยู่เรียบร้อยแล้วค่ะ สแตนด์บายรอเลขพัสดุได้เลย!");
            }
          }
        }
        return res.status(200).send('EVENT_RECEIVED');
      } catch (error) {
        console.error("Webhook Error:", error);
        return res.status(500).json({ error: error.message });
      }
    }
    return res.status(404).send();
  }

  res.setHeader('Allow', ['GET', 'POST']);
  return res.status(405).send(`Method ${req.method} Not Allowed`);
}