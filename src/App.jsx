import { QRCodeSVG } from 'qrcode.react';
import React, { useState } from 'react';

// ฟังก์ชันสกัดข้อความ
const extractOrderData = (rawText) => {
  if (!rawText) return null;
  const cleanText = rawText.replace(/-/g, '');
  
  const zipMatch = cleanText.match(/\b\d{5}\b/);
  const zipcode = zipMatch ? zipMatch[0] : '';
  
  const phoneMatch = cleanText.match(/\b0\d{8,9}\b/);
  const phone = phoneMatch ? phoneMatch[0] : '';
  
  let remainingText = cleanText;
  if (zipcode) remainingText = remainingText.replace(zipcode, '');
  if (phone) remainingText = remainingText.replace(phone, '');
  
  const lines = remainingText.split('\n').filter(line => line.trim() !== '');
  let customerName = '';
  let address = '';
  
  if (lines.length > 1) {
    customerName = lines[0].trim();
    address = lines.slice(1).join(' ').trim(); 
  } else {
    address = lines[0] ? lines[0].trim() : '';
  }

  const mockItems = ["เสื้อยืดคอกลม สีดำ ไซส์ L x1", "กางเกงยีนส์ ทรงกระบอก x1"];

  return { customerName, phone, address, zipcode, items: mockItems };
};

export default function App() {
  const [inputText, setInputText] = useState('');
  const [parsedData, setParsedData] = useState(null);

  const handleProcessText = () => {
    const data = extractOrderData(inputText);
    setParsedData(data);
  };

  return (
    <div className="min-h-screen bg-gray-100 p-6 font-sans">
      <header className="mb-6">
        <h1 className="text-3xl font-bold text-blue-800">📦 SmartLabel</h1>
        <p className="text-gray-600">ระบบจัดการออเดอร์และพิมพ์จ่าหน้าอัจฉริยะ</p>
      </header>

      <div className="flex flex-col md:flex-row gap-6">
        
        {/* ฝั่งซ้าย: Magic Box */}
        <div className="flex-1 bg-white p-6 rounded-lg shadow-md border-t-4 border-blue-500">
          <h2 className="text-xl font-semibold mb-4 text-gray-800">1. วางข้อความที่นี่ (Magic Box)</h2>
          <textarea
            className="w-full h-64 p-4 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-400 resize-none"
            placeholder="วางข้อความแชตที่มี ชื่อ ที่อยู่ เบอร์โทร ที่นี่..."
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
          />
          <button 
            onClick={handleProcessText}
            className="mt-4 w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 px-4 rounded-md transition duration-200"
          >
            ✨ แปลงร่างเป็นจ่าหน้า
          </button>
        </div>

        {/* ฝั่งขวา: Preview จ่าหน้า */}
        <div className="flex-1 bg-white p-6 rounded-lg shadow-md flex flex-col items-center">
          <h2 className="text-xl font-semibold mb-4 text-gray-800 w-full text-left">2. ตรวจสอบและสั่งพิมพ์</h2>
          
          {parsedData ? (
            <div className="w-full max-w-sm flex flex-col items-center">
              <div className="w-full border-2 border-gray-800 p-4 bg-white shadow-sm relative">
                
                <div className="flex justify-between items-center border-b pb-2 mb-2">
                  <span className="font-bold text-lg">SmartLabel ✅</span>
                  <span className="text-xs text-gray-500">Date: {new Date().toLocaleDateString()}</span>
                </div>

                <div className="mb-3">
                  <p className="text-xs font-bold text-gray-600">ผู้ส่ง (Sender):</p>
                  <p className="text-sm">ร้านขายดีช็อป (081-111-2222)<br/>123 ถ.สุขุมวิท กทม. 10110</p>
                </div>

                <div className="mb-4 bg-gray-50 p-2 border rounded">
                  <p className="text-xs font-bold text-blue-600 mb-1">ผู้รับ (Receiver):</p>
                  <p className="text-xl font-bold">{parsedData.customerName || 'ไม่ระบุชื่อ'}</p>
                  <p className="text-lg font-bold mt-1">☎ {parsedData.phone || 'ไม่ระบุเบอร์โทร'}</p>
                  <p className="text-md mt-1 leading-tight">{parsedData.address || 'ไม่ระบุที่อยู่'}</p>
                </div>

                <div className="text-center mb-4">
                  <p className="text-4xl font-extrabold tracking-widest">{parsedData.zipcode || '00000'}</p>
                </div>

                {/* ส่วนของ QR Code ของจริง */}
                <div className="flex flex-col items-center justify-center border-t border-b py-3 mb-3">
                  <div className="flex items-center justify-center p-1 bg-white border border-gray-300 rounded mb-1">
                    <QRCodeSVG 
                      value={JSON.stringify({
                        orderId: "TH-SMART-987654321",
                        name: parsedData.customerName,
                        phone: parsedData.phone,
                        zip: parsedData.zipcode
                      })} 
                      size={96} 
                    />
                  </div>
                  <p className="font-bold text-sm">TH-SMART-987654321</p>
                </div>

                <div>
                  <p className="text-xs font-bold">รายการสินค้า (Items):</p>
                  <ul className="text-xs list-disc pl-4 mt-1">
                    {parsedData.items.map((item, index) => (
                      <li key={index}>{item}</li>
                    ))}
                  </ul>
                </div>

              </div>

              <button className="mt-6 w-full bg-green-500 hover:bg-green-600 text-white font-bold py-3 px-4 rounded-md transition duration-200 shadow-lg flex justify-center items-center gap-2">
                🖨️ ยืนยันและสั่งพิมพ์ (Print)
              </button>
            </div>
          ) : (
            <div className="w-full h-64 flex items-center justify-center border-2 border-dashed border-gray-300 rounded-md text-gray-400">
              รอข้อความเพื่อสร้างจ่าหน้า...
            </div>
          )}
        </div>

      </div>
    </div>
  );
}