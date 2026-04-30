export default async function handler(req, res) {
  // 🔥 กำหนดรหัสลับของเราเอง (เดี๋ยวสเต็ป 2 เราต้องเอารหัสนี้ไปกรอกใน Facebook)
  const VERIFY_TOKEN = "smartlabel_super_secret_2026";

  // ==========================================
  // โหมดที่ 1: Facebook ยิงมาเพื่อยืนยันตัวตน (Verify Webhook)
  // ==========================================
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    // ถ้ามีข้อมูลส่งมา และโหมดเป็นการ subscribe
    if (mode && token) {
      if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        console.log('✅ WEBHOOK_VERIFIED: ยืนยันตัวตนกับ Facebook สำเร็จ!');
        // ต้องส่ง challenge กลับไปให้ Facebook เพื่อยืนยัน
        return res.status(200).send(challenge);
      } else {
        // รหัสลับไม่ตรงกัน เตะกลับไป!
        return res.status(403).send('Forbidden');
      }
    }
    return res.status(400).send('Bad Request');
  }

  // ==========================================
  // โหมดที่ 2: Facebook ส่งข้อความแชทลูกค้ามาให้เรา
  // ==========================================
  if (req.method === 'POST') {
    const body = req.body;

    // เช็คว่าข้อมูลมาจาก Page จริงๆ
    if (body.object === 'page') {
      
      // วนลูปอ่านข้อความ (บางทีอาจจะมาพร้อมกันหลายข้อความ)
      body.entry.forEach(function(entry) {
        const webhook_event = entry.messaging[0];
        const sender_psid = webhook_event.sender.id; // รหัส Facebook ของลูกค้า
        
        // ถ้ามีข้อความ text ส่งมา
        if (webhook_event.message && webhook_event.message.text) {
          const messageText = webhook_event.message.text;
          
          // ตอนนี้เราแค่ Console Log ดูก่อนว่าดูดแชทมาได้จริงไหม
          console.log(`💬 มีข้อความเข้าจากลูกค้า ID [${sender_psid}]: ${messageText}`);
          
          // 💡 เดี๋ยวสเต็ปต่อไป เราจะเอา messageText ตรงนี้ไปเข้า AI แยกที่อยู่
          // และบันทึกลง Firestore อัตโนมัติครับ!
        }
      });

      // ต้องตอบ 200 OK กลับไปหา Facebook เสมอ ไม่งั้น Facebook จะส่งซ้ำรัวๆ ครับ
      return res.status(200).send('EVENT_RECEIVED');
    } else {
      return res.status(404).send('Not Found');
    }
  }

  // ถ้าเข้ามาด้วยวิธีอื่นที่ไม่ใช่ GET หรือ POST
  res.setHeader('Allow', ['GET', 'POST']);
  res.status(405).send(`Method ${req.method} Not Allowed`);
}