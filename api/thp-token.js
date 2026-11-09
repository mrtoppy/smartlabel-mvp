export default async function handler(req, res) {
  // อนุญาตให้เรียกผ่าน POST เท่านั้น
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    // ดึงกุญแจลับจากระบบของ Vercel (จะไม่โชว์ในโค้ดหน้าบ้าน)
    const username = process.env.THP_USERNAME;
    const password = process.env.THP_PASSWORD;
    
    // แปลงรหัสเป็น Base64 ตามมาตรฐาน API
    const authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');

    const response = await fetch('https://pus2.thailandpost.com/redbox/auth/app/token', {
      method: 'POST',
      headers: { 'Authorization': authHeader }
    });

    const data = await response.json();

    if (data.detail === 'ok') {
      res.status(200).json({ token: data.token });
    } else {
      res.status(400).json({ error: 'Failed to get token' });
    }
  } catch (error) {
    console.error("API Error:", error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}