// แจ้งเตือน Telegram เมื่อมีบิลแจ้งโอนใหม่
// ENV (Vercel): TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, FIREBASE_SERVICE_ACCOUNT
// ข้อความสร้างจากข้อมูลใน Firestore ที่เซิร์ฟเวอร์ ไม่รับข้อความจาก client
import { adminDb, allowPost, requireUser } from './_lib/auth.js';

export default async function handler(req, res) {
  if (!allowPost(req, res)) return;
  const user = await requireUser(req, res);
  if (!user) return;

  const topupId = req.body?.topupId;
  if (typeof topupId !== 'string' || !topupId) return res.status(400).json({ error: 'ไม่พบรหัสรายการ' });

  try {
    const ref = adminDb.doc(`topup_requests/${topupId}`);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'ไม่พบรายการ' });
    const d = snap.data();
    if (d.userId !== user.uid) return res.status(403).json({ error: 'ไม่มีสิทธิ์' });
    if (d.telegramNotified) return res.json({ ok: true, skipped: true }); // กันยิงซ้ำ

    const text =
      `🚨 มียอดแจ้งโอนเงินเข้ามาใหม่! [SmartLabel]\n` +
      `ร้านค้า: ${d.storeName || '-'}\n` +
      `อีเมล: ${d.userEmail || '-'}\n` +
      `แพ็กเกจ: ${d.package || '-'}\n` +
      `ยอดเงินโอน: ฿${Number(d.amount || 0).toLocaleString()}\n` +
      `กรุณาตรวจสอบและอนุมัติที่หน้า SuperAdmin`;

    const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text }),
    });
    if (r.ok) await ref.update({ telegramNotified: true });
    return res.json({ ok: r.ok });
  } catch (e) {
    console.error('notify-topup error:', e);
    return res.status(500).json({ error: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์' });
  }
}
