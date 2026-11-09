export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { messageText } = req.body;
    
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    const telegramUrl = `https://api.telegram.org/bot${token}/sendMessage`;
    
    const response = await fetch(telegramUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: messageText,
        parse_mode: 'Markdown'
      })
    });

    const data = await response.json();
    res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("Telegram API Error:", error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}