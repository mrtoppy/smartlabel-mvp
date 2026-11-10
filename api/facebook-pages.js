// เชื่อมเพจ Facebook โดย Page Access Token ไม่ผ่าน/ไม่ถูกเก็บฝั่ง client
//   action 'list'   : รับ user token → แลกเป็น long-lived → ดึงเพจ → เก็บ token ใน page_secrets → ส่งกลับแค่ {id,name}
//   action 'select' : บันทึกเพจที่ร้านเลือก (fb_pages, users.connectedPages/facebookPageId)
// ENV (Vercel): FB_APP_ID, FB_APP_SECRET, FIREBASE_SERVICE_ACCOUNT
import { adminDb, FieldValue, allowPost, requireUser } from './_lib/auth.js';

async function graph(path, params) {
  const r = await fetch(`https://graph.facebook.com/v20.0/${path}?${new URLSearchParams(params)}`);
  const json = await r.json();
  if (!r.ok) throw new Error(json?.error?.message || 'Facebook API error');
  return json;
}

export default async function handler(req, res) {
  if (!allowPost(req, res)) return;
  const user = await requireUser(req, res);
  if (!user) return;
  if (user.role !== 'Owner') return res.status(403).json({ error: 'เฉพาะเจ้าของร้านเท่านั้น' });
  if (user.data.plan !== 'Premium') return res.status(403).json({ error: 'ฟีเจอร์นี้สำหรับแพ็กเกจ Premium' });

  const body = req.body || {};
  try {
    if (body.action === 'list') {
      const userToken = String(body.userAccessToken || '');
      if (!userToken) return res.status(400).json({ error: 'ไม่พบ token จาก Facebook' });

      const long = await graph('oauth/access_token', {
        grant_type: 'fb_exchange_token',
        client_id: process.env.FB_APP_ID,
        client_secret: process.env.FB_APP_SECRET,
        fb_exchange_token: userToken,
      });
      const accounts = await graph('me/accounts', {
        access_token: long.access_token,
        fields: 'id,name,access_token',
        limit: '100',
      });

      const pages = {};
      for (const p of accounts.data || []) pages[p.id] = { name: p.name, accessToken: p.access_token };
      await adminDb.doc(`page_secrets/${user.ownerId}`).set({ pages, updatedAt: FieldValue.serverTimestamp() });
      return res.json(Object.entries(pages).map(([id, p]) => ({ id, name: p.name })));
    }

    if (body.action === 'select') {
      const ids = (Array.isArray(body.pageIds) ? body.pageIds : []).map(String).slice(0, 20);
      const secretSnap = await adminDb.doc(`page_secrets/${user.ownerId}`).get();
      const pages = secretSnap.exists ? secretSnap.data().pages || {} : {};
      const valid = ids.filter((id) => pages[id]);

      for (const id of valid) {
        await adminDb.doc(`fb_pages/${id}`).set({ ownerId: user.ownerId, updatedAt: FieldValue.serverTimestamp() });
      }
      await adminDb.doc(`users/${user.ownerId}`).set(
        { connectedPages: valid, facebookPageId: valid[0] || '', updatedAt: FieldValue.serverTimestamp() },
        { merge: true }
      );
      return res.json({ saved: valid.length });
    }

    return res.status(400).json({ error: 'action ไม่ถูกต้อง' });
  } catch (e) {
    console.error('facebook-pages error:', e);
    return res.status(500).json({ error: e.message || 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์' });
  }
}
