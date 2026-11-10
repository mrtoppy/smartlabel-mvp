// ส่งเลขพัสดุเข้า Messenger ของลูกค้า (แทน action 'send_tracking' เดิมใน webhook.js)
// ตรวจ: ล็อกอินแล้ว, ออเดอร์เป็นของร้านตัวเอง (พนักงานส่งได้เฉพาะออเดอร์ที่ตัวเองทำ),
//       มีประวัติแชทกับลูกค้ารายนี้จริง, และใช้ Page Token ของร้านนั้นจาก page_secrets
// ENV (Vercel): FIREBASE_SERVICE_ACCOUNT
import { adminDb, FieldValue, allowPost, requireUser } from './_lib/auth.js';

export default async function handler(req, res) {
  if (!allowPost(req, res)) return;
  const user = await requireUser(req, res);
  if (!user) return;
  if (!['Owner', 'Admin', 'Staff'].includes(user.role)) {
    return res.status(403).json({ error: 'ไม่มีสิทธิ์ทำรายการนี้' });
  }

  const orderId = req.body?.orderId;
  if (typeof orderId !== 'string' || !orderId) return res.status(400).json({ error: 'ไม่พบรหัสออเดอร์' });

  try {
    const orderRef = adminDb.doc(`orders/${orderId}`);
    const orderSnap = await orderRef.get();
    if (!orderSnap.exists) return res.status(404).json({ error: 'ไม่พบออเดอร์' });
    const order = orderSnap.data();

    if (order.ownerId !== user.ownerId) return res.status(403).json({ error: 'ไม่มีสิทธิ์ส่งออเดอร์นี้' });
    if (user.role !== 'Owner' && order.adminEmail !== user.email) {
      return res.status(403).json({ error: 'ส่งได้เฉพาะออเดอร์ที่ตัวเองสร้าง' });
    }
    if (!order.pageId || !order.senderId || !order.trackingNum) {
      return res.status(400).json({ error: 'ออเดอร์นี้ไม่มีข้อมูลแชทหรือเลขพัสดุ' });
    }

    // ต้องเคยมีแชทจากลูกค้ารายนี้ในร้านนี้จริง (กันการแก้ senderId เพื่อส่งหาคนอื่น)
    const chatSnap = await adminDb.collection('chats')
      .where('ownerId', '==', user.ownerId)
      .where('pageId', '==', order.pageId)
      .where('senderId', '==', order.senderId)
      .limit(1).get();
    if (chatSnap.empty) return res.status(403).json({ error: 'ไม่พบประวัติแชทกับลูกค้ารายนี้' });

    const secretSnap = await adminDb.doc(`page_secrets/${user.ownerId}`).get();
    const token = secretSnap.exists ? secretSnap.data().pages?.[order.pageId]?.accessToken : null;
    if (!token) return res.status(404).json({ error: 'ไม่พบกุญแจเชื่อมต่อ Facebook ของเพจนี้ กรุณาเชื่อมต่อเพจใหม่' });

    const text =
      `ขอบคุณที่อุดหนุนครับ! 🙏\nคุณลูกค้า: ${order.customerName || 'คุณลูกค้า'}\n` +
      `📦 เลขพัสดุของคุณคือ: ${order.trackingNum}\n` +
      `🚚 ตรวจสอบสถานะได้ที่: https://track.thailandpost.co.th/?trackNumber=${order.trackingNum}\n\n` +
      `SmartLabel ยินดีให้บริการครับ ✅`;

    const r = await fetch('https://graph.facebook.com/v20.0/me/messages', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: order.senderId },
        messaging_type: 'RESPONSE', // ใช้ได้ภายใน 24 ชม. หลังลูกค้าทักล่าสุด
        message: { text },
      }),
    });
    const result = await r.json();
    if (!r.ok) {
      return res.status(502).json({ error: result?.error?.message || 'ส่งข้อความผ่าน Facebook ไม่สำเร็จ' });
    }
    await orderRef.update({ trackingSentAt: FieldValue.serverTimestamp() });
    return res.json({ success: true });
  } catch (e) {
    console.error('send-tracking error:', e);
    return res.status(500).json({ error: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์' });
  }
}
