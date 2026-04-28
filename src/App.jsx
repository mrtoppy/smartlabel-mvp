import { QRCodeSVG } from 'qrcode.react';
import React, { useState, useRef, useEffect } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';

import { auth, db } from './firebase'; 
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from "firebase/auth";
// --- 🔥 เพิ่ม doc, getDoc, setDoc เข้ามาเพื่อจัดการ User Profile ---
import { collection, addDoc, getDocs, query, serverTimestamp, doc, getDoc, setDoc } from "firebase/firestore";

const extractOrderData = (rawText) => {
  if (!rawText) return null;
  const cleanText = rawText.replace(/-/g, '');
  const zipMatch = cleanText.match(/\b\d{5}\b/);
  const zipcode = zipMatch ? zipMatch[0] : '';
  const phoneMatch = cleanText.match(/\b0\d{8,9}\b/);
  const phone = phoneMatch ? phoneMatch[0] : '';

  let isCOD = false;
  let codAmount = '';
  const codRegex = /(?:cod|ปลายทาง|เก็บเงินปลายทาง|ยอด)\s*[:=]?\s*([\d,]+)/i;
  const codMatch = cleanText.match(codRegex);
  if (codMatch) {
    isCOD = true;
    codAmount = codMatch[1];
  }
  
  let remainingText = cleanText;
  if (zipcode) remainingText = remainingText.replace(zipcode, '');
  if (phone) remainingText = remainingText.replace(phone, '');
  if (codMatch) remainingText = remainingText.replace(codMatch[0], ''); 
  
  const lines = remainingText.split('\n').map(line => line.trim()).filter(line => line !== '');
  let customerName = '';
  let addressLines = [];
  let items = [];
  const itemRegex = /(x\s*\d+|\d+\s*(ตัว|ชิ้น|กล่อง|ใบ|คู่|ชุด|แพ็ค|ขวด|ซอง))/i;

  lines.forEach((line, index) => {
    if (itemRegex.test(line)) {
      items.push(line); 
    } else if (index === 0) {
      customerName = line; 
    } else {
      addressLines.push(line); 
    }
  });

  const address = addressLines.join(' ').trim();
  let warnings = [];
  if (!phone) warnings.push(isCOD ? "⚠️ ไม่มีเบอร์โทร (COD บังคับ!)" : "⚠️ ไม่มีเบอร์โทรศัพท์");
  if (!zipcode) warnings.push("⚠️ ไม่มีรหัสไปรษณีย์");
  if (cleanText.trim() !== '') {
    if (!/(ต\.|ตำบล|แขวง)/.test(cleanText)) warnings.push("⚠️ ขาด ตำบล/แขวง");
    if (!/(อ\.|อำเภอ|เขต)/.test(cleanText)) warnings.push("⚠️ ขาด อำเภอ/เขต");
    if (address === '') warnings.push("⚠️ ควรเคาะ Enter แยกชื่อ กับ ที่อยู่");
  }

  return { customerName, phone, address, zipcode, items, isCOD, codAmount, warnings };
};

const COLORS = ['#22c55e', '#f97316'];

export default function App() {
  const [user, setUser] = useState(null);
  const [userRole, setUserRole] = useState(''); // เก็บสถานะ Role จริงๆ
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('maker'); 
  
  const [orders, setOrders] = useState([{ id: Date.now(), rawText: '', parsedData: null, isSaved: false }]);
  const labelRefs = useRef({});

  const [storeProfile, setStoreProfile] = useState({ name: 'ToppySmart Logistics', phone: '087-448-4448', address: '123/48 ม.5 ต.หอรัตนไชย อ.พระนครศรีอยุธยา' });
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [tempProfile, setTempProfile] = useState({ ...storeProfile });

  const [historyOrders, setHistoryOrders] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [reprintOrder, setReprintOrder] = useState(null);

  const [dashboardStats, setDashboardStats] = useState({
    totalOrders: 0,
    codOrders: 0,
    totalCodAmount: 0,
    pieData: [],
    barData: []
  });

// --- 🔥 อัปเกรดระบบตรวจสอบผู้ใช้และดึงสิทธิ์ (Role) อุดช่องโหว่ความปลอดภัย ---
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      if (currentUser) {
        setUser(currentUser);
        try {
          const userRef = doc(db, "users", currentUser.uid);
          const userSnap = await getDoc(userRef);
          
          if (userSnap.exists()) {
            setUserRole(userSnap.data().role);
          } else {
            // 🔥 เปลี่ยนค่าเริ่มต้นเป็น 'Staff' แทน! ใครล็อกอินใหม่จะได้แค่ยศพนักงาน
            await setDoc(userRef, { email: currentUser.email, role: 'Staff' });
            setUserRole('Staff');
          }
        } catch (error) {
          console.error("Error fetching user role: ", error);
          setUserRole('Staff'); 
        }
      } else {
        setUser(null);
        setUserRole('');
      }
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  // ----------------------------------------------------

  useEffect(() => {
    const savedProfile = localStorage.getItem('smartlabel_profile');
    if (savedProfile) {
      setStoreProfile(JSON.parse(savedProfile));
    }
  }, []);

  const loadDashboardData = async () => {
    try {
      const q = query(collection(db, "orders"));
      const querySnapshot = await getDocs(q);

      let total = 0;
      let codCount = 0;
      let codSum = 0;
      let transferCount = 0;
      const dateMap = {};
      const ordersList = [];

      querySnapshot.forEach((doc) => {
        const data = doc.data();
        ordersList.push({ id: doc.id, ...data });

        total++;
        if (data.isCOD) {
          codCount++;
          codSum += data.codAmount || 0;
        } else {
          transferCount++;
        }
        if (data.createdAt) {
           const dateObj = data.createdAt.toDate();
           const dateStr = dateObj.toLocaleDateString('th-TH', { day: 'numeric', month: 'short' });
           if (!dateMap[dateStr]) dateMap[dateStr] = { name: dateStr, โอนเงิน: 0, COD: 0 };
           if (data.isCOD) dateMap[dateStr].COD += 1;
           else dateMap[dateStr].โอนเงิน += 1;
        }
      });

      ordersList.sort((a, b) => (b.createdAt?.toMillis() || 0) - (a.createdAt?.toMillis() || 0));
      setHistoryOrders(ordersList);

      const sortedBarData = Object.values(dateMap).sort((a, b) => new Date(a.name) - new Date(b.name));
      setDashboardStats({
        totalOrders: total,
        codOrders: codCount,
        totalCodAmount: codSum,
        pieData: [{ name: 'โอนเงินแล้ว', value: transferCount }, { name: 'เก็บเงินปลายทาง', value: codCount }],
        barData: sortedBarData.length > 0 ? sortedBarData : [{ name: 'รอข้อมูลใหม่', โอนเงิน: 0, COD: 0 }]
      });
    } catch (error) {
      console.error("Error fetching stats: ", error);
    }
  };

  useEffect(() => {
    if (activeTab === 'dashboard') loadDashboardData();
  }, [activeTab]);

  const handleLogin = async (e) => {
    e.preventDefault();
    try { await signInWithEmailAndPassword(auth, e.target.email.value, e.target.password.value); } 
    catch (error) { alert("อีเมลหรือรหัสผ่านไม่ถูกต้องครับ"); }
  };

  const handleLogout = () => signOut(auth);

  const handleTextChange = (id, newText) => {
    let updatedOrders = orders.map(order => {
      if (order.id === id) return { ...order, rawText: newText, parsedData: newText.trim() !== '' ? extractOrderData(newText) : null, isSaved: false };
      return order;
    });
    if (updatedOrders[updatedOrders.length - 1].rawText.trim() !== '') updatedOrders.push({ id: Date.now(), rawText: '', parsedData: null, isSaved: false });
    setOrders(updatedOrders);
  };

  const handleDeleteOrder = (id) => {
    const remainingOrders = orders.filter(order => order.id !== id);
    setOrders(remainingOrders.length === 0 ? [{ id: Date.now(), rawText: '', parsedData: null, isSaved: false }] : remainingOrders);
  };

  const handleFocus = (id) => {
    if (labelRefs.current[id]) labelRefs.current[id].scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const handleSaveProfile = () => {
    setStoreProfile(tempProfile);
    localStorage.setItem('smartlabel_profile', JSON.stringify(tempProfile));
    setIsSettingsOpen(false);
  };

  const handleSaveAndPrint = async () => {
    const readyToSaveOrders = orders.filter(o => o.parsedData && !o.isSaved && o.rawText.trim() !== '');

    if (readyToSaveOrders.length > 0) {
      try {
        for (const order of readyToSaveOrders) {
          const codNumber = order.parsedData.isCOD ? Number(order.parsedData.codAmount.replace(/,/g, '')) : 0;
          await addDoc(collection(db, "orders"), {
            rawText: order.rawText,
            adminEmail: user.email,
            storeName: storeProfile.name,
            customerName: order.parsedData.customerName,
            phone: order.parsedData.phone,
            address: order.parsedData.address,
            zipcode: order.parsedData.zipcode,
            items: order.parsedData.items,
            isCOD: order.parsedData.isCOD,
            codAmount: codNumber,
            createdAt: serverTimestamp() 
          });
        }
        setOrders(prevOrders => prevOrders.map(o => (o.parsedData && !o.isSaved && o.rawText.trim() !== '') ? { ...o, isSaved: true } : o));
      } catch (error) {
        console.error("Error saving document: ", error);
        alert("เกิดข้อผิดพลาดในการบันทึกข้อมูลครับ");
      }
    }
    window.print();
  };

  const handleEditHistory = (order) => {
    setOrders([
      { id: Date.now(), rawText: order.rawText || '', parsedData: extractOrderData(order.rawText || ''), isSaved: false },
      { id: Date.now() + 1, rawText: '', parsedData: null, isSaved: false }
    ]);
    setActiveTab('maker');
    window.scrollTo(0, 0); 
  };

  const handleReprintHistory = (order) => {
    setReprintOrder(order);
    setTimeout(() => {
      window.print();
      setReprintOrder(null); 
    }, 300); 
  };

  const filteredHistory = historyOrders.filter(order => {
    const term = searchQuery.toLowerCase();
    return (order.customerName || '').toLowerCase().includes(term) ||
           (order.phone || '').includes(term) ||
           (order.id || '').toLowerCase().includes(term);
  });

  if (loading) return <div className="min-h-screen flex items-center justify-center bg-gray-100 font-bold text-blue-600">กำลังโหลดระบบ...</div>;

  if (!user) {
    return (
      <div className="min-h-screen bg-blue-900 flex items-center justify-center p-6 font-sans">
        <div className="bg-white p-8 rounded-2xl shadow-2xl w-full max-w-md">
          <div className="text-center mb-8">
            <h1 className="text-4xl font-extrabold text-blue-800 mb-2">📦 SmartLabel</h1>
            <p className="text-gray-500 italic">"จ่าหน้าอัจฉริยะ เพื่อมืออาชีพเช่นคุณ"</p>
          </div>
          <form onSubmit={handleLogin}>
            <div className="mb-4">
              <label className="block text-sm font-bold text-gray-700 mb-2">อีเมลผู้ใช้งาน</label>
              <input name="email" type="email" required className="w-full border border-gray-300 p-3 rounded-lg focus:ring-2 focus:ring-blue-400 outline-none" placeholder="admin@toppysmart.com" />
            </div>
            <div className="mb-6">
              <label className="block text-sm font-bold text-gray-700 mb-2">รหัสผ่าน</label>
              <input name="password" type="password" required className="w-full border border-gray-300 p-3 rounded-lg focus:ring-2 focus:ring-blue-400 outline-none" placeholder="••••••••" />
            </div>
            <button type="submit" className="w-full bg-blue-700 hover:bg-blue-800 text-white font-bold py-3 rounded-lg transition-all shadow-lg transform hover:scale-[1.02]">เข้าสู่ระบบ</button>
          </form>
        </div>
      </div>
    );
  }

  if (reprintOrder) {
    return (
      <div className="bg-white min-h-screen">
        <style>{`
          @media print {
            @page { size: 100mm 150mm; margin: 0; }
            body { background-color: white; -webkit-print-color-adjust: exact; margin: 0; }
            .thermal-label { width: 100mm; height: 148mm; padding: 5mm; box-sizing: border-box; margin: 0; border: none; overflow: hidden; }
          }
        `}</style>
        <div className="w-full max-w-sm mx-auto p-4 thermal-label print:max-w-none print:m-0 print:p-2">
           <div className="flex justify-between border-b pb-2 mb-2 font-bold text-sm">
             <span>SmartLabel ✅ (Reprint)</span>
             <span className="text-gray-500">Admin: {reprintOrder.adminEmail?.split('@')[0]}</span>
           </div>
           <div className="mb-3">
             <p className="text-xs text-gray-500">ผู้ส่ง:</p>
             <p className="font-bold text-sm">{reprintOrder.storeName}</p>
           </div>
           {reprintOrder.isCOD && <div className="bg-black text-white text-center py-2 mb-2 text-2xl font-bold print:border-[3px] print:border-black">COD: {reprintOrder.codAmount}</div>}
           <div className="bg-gray-100 p-2 mb-2 print:bg-white print:border print:border-gray-400">
             <p className="text-xs text-blue-600 font-bold print:text-black">ผู้รับ:</p>
             <p className="text-xl font-bold">{reprintOrder.customerName || 'ไม่มีชื่อผู้รับ'}</p>
             <p className="text-lg font-bold">☎ {reprintOrder.phone || '-'}</p>
             <p className="text-sm leading-tight">{reprintOrder.address || 'ไม่มีที่อยู่'}</p>
           </div>
           <div className="text-center text-4xl font-black mb-3 tracking-widest">{reprintOrder.zipcode || '00000'}</div>
           <div className="flex flex-col items-center border-t border-b py-2 mb-2">
             <QRCodeSVG value={JSON.stringify({ id: reprintOrder.id, cod: reprintOrder.isCOD ? reprintOrder.codAmount : 0 })} size={80} />
             <p className="text-xs mt-1 font-mono">TH-SMART-{String(reprintOrder.id).slice(-6).toUpperCase()}</p>
           </div>
           <div>
              <p className="text-xs font-bold">รายการสินค้า (Items):</p>
              {reprintOrder.items && reprintOrder.items.length > 0 ? (
                <ul className="text-[10px] list-disc pl-4 mt-1 leading-tight">
                  {reprintOrder.items.map((item, index) => <li key={index}>{item}</li>)}
                </ul>
              ) : (
                <p className="text-[10px] text-gray-500 italic mt-1">- ไม่ระบุรายการ -</p>
              )}
           </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-100 p-6 font-sans print:bg-white print:p-0 relative">
      
      <style>{`
        @media print {
          @page { size: 100mm 150mm; margin: 0; }
          body { background-color: white; -webkit-print-color-adjust: exact; margin: 0; }
          .thermal-label { width: 100mm; height: 148mm; padding: 5mm; box-sizing: border-box; page-break-after: always; margin: 0 auto; border: none !important; overflow: hidden; }
        }
      `}</style>
      
      {isSettingsOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 print:hidden">
          <div className="bg-white p-6 rounded-lg shadow-xl w-full max-w-md">
            <h2 className="text-2xl font-bold mb-4 text-gray-800">⚙️ ตั้งค่าข้อมูลร้านค้า</h2>
            <div className="mb-4">
              <label className="block text-sm font-bold text-gray-700 mb-1">ชื่อร้านค้า (ผู้ส่ง)</label>
              <input type="text" className="w-full border border-gray-300 p-2 rounded focus:ring-2 focus:ring-blue-400 focus:outline-none" value={tempProfile.name} onChange={(e) => setTempProfile({...tempProfile, name: e.target.value})} />
            </div>
            <div className="mb-4">
              <label className="block text-sm font-bold text-gray-700 mb-1">เบอร์โทรศัพท์</label>
              <input type="text" className="w-full border border-gray-300 p-2 rounded focus:ring-2 focus:ring-blue-400 focus:outline-none" value={tempProfile.phone} onChange={(e) => setTempProfile({...tempProfile, phone: e.target.value})} />
            </div>
            <div className="mb-6">
              <label className="block text-sm font-bold text-gray-700 mb-1">ที่อยู่ร้านค้า</label>
              <textarea className="w-full border border-gray-300 p-2 rounded h-24 resize-none focus:ring-2 focus:ring-blue-400 focus:outline-none" value={tempProfile.address} onChange={(e) => setTempProfile({...tempProfile, address: e.target.value})} />
            </div>
            <div className="flex justify-end gap-3">
              <button onClick={() => setIsSettingsOpen(false)} className="px-4 py-2 bg-gray-200 text-gray-800 rounded hover:bg-gray-300 transition font-bold">ยกเลิก</button>
              <button onClick={handleSaveProfile} className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition font-bold">💾 บันทึกข้อมูล</button>
            </div>
          </div>
        </div>
      )}

      <header className="mb-6 bg-white p-4 rounded-lg shadow-sm print:hidden">
        <div className="flex justify-between items-center mb-4">
          <div>
            <h1 className="text-3xl font-bold text-blue-800 flex items-center gap-2">
              📦 SmartLabel 
              {/* ป้ายกำกับ Role แบบไดนามิก */}
              <span className={`text-sm px-2 py-1 rounded-full ${userRole === 'Owner' ? 'bg-purple-100 text-purple-700' : userRole === 'Admin' ? 'bg-blue-100 text-blue-600' : 'bg-gray-200 text-gray-700'}`}>
                {userRole}
              </span>
            </h1>
            <p className="text-gray-600 text-sm">ผู้ใช้งาน: {user.email}</p>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex bg-gray-100 p-1 rounded-lg">
              <button onClick={() => setActiveTab('maker')} className={`px-4 py-2 rounded-md font-bold transition-all text-sm ${activeTab === 'maker' || userRole === 'Staff' ? ( 'bg-white text-blue-600 shadow' ) : ( 'text-gray-500' )}`}>✍️ สร้างจ่าหน้า</button>

              {/* --- 🔥 ควบคุมการมองเห็นเมนูสถิติด้วย Role --- */}
              {(userRole === 'Owner' || userRole === 'Admin') && (
                <button onClick={() => setActiveTab('dashboard')} className={`px-4 py-2 rounded-md font-bold transition-all text-sm ${activeTab === 'dashboard' ? 'bg-white text-blue-600 shadow' : 'text-gray-500'}`}>📊 สถิติ & ประวัติ</button>
              )}

            </div>
            <button onClick={handleLogout} className="bg-red-50 hover:bg-red-100 text-red-600 px-4 py-2 rounded-lg font-bold text-sm transition-all">ออกจากระบบ 🚪</button>
          </div>
        </div>

        <div className="flex justify-between items-center bg-blue-50 p-3 rounded border border-blue-100">
          <div className="text-sm text-blue-800 flex items-center gap-3">
            {/* Wallet เห็นเฉพาะ Owner */}
            {userRole === 'Owner' && <span className="font-bold italic text-blue-600 border-r border-blue-200 pr-3">Wallet: ฿2,540</span>}
            <span><span className="font-bold">ร้าน:</span> {storeProfile.name}</span>
          </div>
          
          {/* ปุ่มตั้งค่าร้านค้า เห็นเฉพาะ Owner */}
          {userRole === 'Owner' && (
            <button onClick={() => setIsSettingsOpen(true)} className="text-xs bg-white border border-blue-200 text-blue-600 px-3 py-1 rounded hover:bg-blue-100 font-bold">⚙️ ตั้งค่าร้านค้า</button>
          )}
        </div>
      </header>

      {activeTab === 'maker' ? (
        <div className="flex flex-col md:flex-row gap-6 print:block">
           <div className="flex-1 bg-white p-6 rounded-lg shadow-md border-t-4 border-blue-500 max-h-[70vh] overflow-y-auto print:hidden">
            <h2 className="text-xl font-semibold mb-4 text-gray-800">1. วางข้อความแชต</h2>
            {orders.map((order, index) => {
              let boxColorClass = 'border-gray-300 focus:ring-blue-400';
              let hasWarnings = false;
              if (order.parsedData) {
                hasWarnings = order.parsedData.warnings.length > 0;
                if (order.parsedData.isCOD) boxColorClass = hasWarnings ? 'border-red-400 bg-orange-50 focus:ring-orange-500' : 'border-orange-400 bg-orange-50 focus:ring-orange-500';
                else boxColorClass = hasWarnings ? 'border-red-400 bg-red-50 focus:ring-red-500' : 'border-green-400 bg-green-50 focus:ring-green-500';
              }

              return (
                <div key={order.id} className="mb-6 relative group border-b pb-4 border-gray-100">
                  <div className="flex justify-between items-end mb-1">
                    <label className="block text-sm font-bold text-gray-500">
                      ออเดอร์ที่ {index + 1} 
                      {order.isSaved && <span className="ml-2 text-xs bg-green-100 text-green-700 px-2 py-1 rounded-full">💾 บันทึกแล้ว</span>}
                    </label>
                    {(order.rawText !== '' || orders.length > 1) && (
                      <button onClick={() => handleDeleteOrder(order.id)} className="text-red-400 hover:text-red-600 text-sm font-bold transition flex items-center gap-1">🗑️ ลบ</button>
                    )}
                  </div>
                  <textarea className={`w-full h-32 p-4 border rounded-md focus:outline-none focus:ring-2 resize-none transition-all ${boxColorClass}`} placeholder="วางชื่อ ที่อยู่..." value={order.rawText} onChange={(e) => handleTextChange(order.id, e.target.value)} onFocus={() => handleFocus(order.id)} />
                  {order.parsedData && order.parsedData.warnings.length > 0 && (
                    <div className="mt-2 text-sm font-bold text-red-500 flex flex-col gap-1">{order.parsedData.warnings.map((w, i) => <span key={i}>{w}</span>)}</div>
                  )}
                </div>
              );
            })}
          </div>
          
          <div className="flex-1 bg-gray-50 rounded-lg shadow-inner border-2 border-dashed border-gray-300 max-h-[70vh] overflow-y-auto print:bg-white print:border-none print:block print:p-0 relative">
             <div className="sticky top-0 bg-white border-b-2 border-gray-200 p-4 flex justify-between items-center z-10 shadow-sm print:hidden">
               <h2 className="text-xl font-semibold text-gray-800">2. ตรวจสอบและสั่งพิมพ์</h2>
               <button onClick={handleSaveAndPrint} className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-6 rounded-md shadow-lg flex items-center gap-2 transition-transform transform hover:scale-105">
                 💾 บันทึก & สั่งพิมพ์
               </button>
            </div>
            
            <div className="p-6 print:p-0">
              {orders.filter(o => o.parsedData).map((order) => (
                <div key={order.id} ref={(el) => (labelRefs.current[order.id] = el)} className="w-full max-w-sm mx-auto mb-8 bg-white border-2 border-black p-4 print:max-w-none print:mx-0 print:mb-0 thermal-label">
                   <div className="flex justify-between border-b pb-2 mb-2 font-bold text-sm">
                     <span>SmartLabel ✅</span>
                     <span className="text-gray-500">Admin: {user.email.split('@')[0]}</span>
                   </div>
                   <div className="mb-3"><p className="text-xs text-gray-500">ผู้ส่ง:</p><p className="font-bold text-sm">{storeProfile.name}</p></div>
                   {order.parsedData.isCOD && <div className="bg-black text-white text-center py-2 mb-2 text-2xl font-bold print:border-[3px] print:border-black">COD: {order.parsedData.codAmount}</div>}
                   <div className="bg-gray-100 p-2 mb-2 print:bg-white print:border print:border-gray-400">
                     <p className="text-xs text-blue-600 font-bold print:text-black">ผู้รับ:</p>
                     <p className="text-xl font-bold">{order.parsedData.customerName || 'ไม่มีชื่อผู้รับ'}</p>
                     <p className="text-lg font-bold">☎ {order.parsedData.phone || '-'}</p>
                     <p className="text-sm leading-tight">{order.parsedData.address || 'ไม่มีที่อยู่'}</p>
                   </div>
                   <div className="text-center text-4xl font-black mb-3 tracking-widest">{order.parsedData.zipcode || '00000'}</div>
                   <div className="flex flex-col items-center border-t border-b py-2 mb-2">
                     <QRCodeSVG value={JSON.stringify({ id: order.id, cod: order.parsedData.isCOD ? order.parsedData.codAmount : 0, admin: user.email })} size={80} />
                     <p className="text-xs mt-1 font-mono">TH-SMART-{String(order.id).slice(-6).toUpperCase()}</p>
                   </div>
                   <div>
                      <p className="text-xs font-bold">รายการสินค้า (Items):</p>
                      {order.parsedData.items.length > 0 ? (
                        <ul className="text-[10px] list-disc pl-4 mt-1 leading-tight">{order.parsedData.items.map((item, index) => <li key={index}>{item}</li>)}</ul>
                      ) : (
                        <p className="text-[10px] text-gray-500 italic mt-1">- ไม่ระบุรายการ -</p>
                      )}
                   </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          <div className="bg-white p-6 rounded-lg shadow-md border-t-4 border-purple-500">
            <h2 className="text-2xl font-bold mb-6 flex justify-between">
              ภาพรวมธุรกิจ ({userRole} Dashboard)
              <span className="text-sm text-gray-500 font-normal self-end">อัปเดตข้อมูลล่าสุดอัตโนมัติ</span>
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
              <div className="bg-blue-50 border border-blue-100 p-6 rounded-xl">
                <h3 className="text-blue-600 font-bold mb-2">ยอดจัดส่งรวมทั้งหมด</h3>
                <p className="text-4xl font-extrabold text-blue-900">{dashboardStats.totalOrders} <span className="text-lg font-normal">ชิ้น</span></p>
              </div>
              <div className="bg-orange-50 border border-orange-100 p-6 rounded-xl">
                <h3 className="text-orange-600 font-bold mb-2">ออเดอร์ COD</h3>
                <p className="text-4xl font-extrabold text-orange-900">{dashboardStats.codOrders} <span className="text-lg font-normal">ชิ้น</span></p>
              </div>
              <div className="bg-green-50 border border-green-100 p-6 rounded-xl relative">
                <h3 className="text-green-600 font-bold mb-2">คาดการณ์เงินโอนเข้า (COD)</h3>
                <p className="text-4xl font-extrabold text-green-900">฿{dashboardStats.totalCodAmount.toLocaleString()}</p>
              </div>
            </div>
            
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
              <div className="lg:col-span-2 border border-gray-200 p-4 rounded-xl shadow-sm">
                <h3 className="font-bold text-gray-700 mb-4 text-center">สถิติการส่งพัสดุรายวัน (Daily Volume)</h3>
                <div className="h-72">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={dashboardStats.barData}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="name" />
                      <YAxis />
                      <Tooltip cursor={{fill: '#f3f4f6'}} />
                      <Legend />
                      <Bar dataKey="โอนเงิน" stackId="a" fill="#22c55e" radius={[0, 0, 4, 4]} />
                      <Bar dataKey="COD" stackId="a" fill="#f97316" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
              <div className="border border-gray-200 p-4 rounded-xl shadow-sm flex flex-col items-center">
                <h3 className="font-bold text-gray-700 mb-4">สัดส่วนประเภทออเดอร์</h3>
                <div className="h-64 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={dashboardStats.pieData} innerRadius={60} outerRadius={80} paddingAngle={5} dataKey="value">
                        {dashboardStats.pieData.map((entry, index) => <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />)}
                      </Pie>
                      <Tooltip />
                      <Legend verticalAlign="bottom" height={36}/>
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-white p-6 rounded-lg shadow-md border-t-4 border-blue-500">
            <div className="flex flex-col md:flex-row justify-between items-center mb-6 gap-4">
              <h2 className="text-2xl font-bold text-gray-800">🗂️ ประวัติพัสดุทั้งหมด</h2>
              <div className="relative w-full md:w-96">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">🔍</div>
                <input 
                  type="text" 
                  className="bg-gray-50 border border-gray-300 text-gray-900 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block w-full pl-10 p-2.5" 
                  placeholder="ค้นหาชื่อ, เบอร์โทร, เลขพัสดุ (TH-SMART...)" 
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
            </div>

            <div className="overflow-x-auto relative shadow-sm rounded-lg border border-gray-200">
              <table className="w-full text-sm text-left text-gray-500">
                <thead className="text-xs text-gray-700 uppercase bg-gray-100">
                  <tr>
                    <th scope="col" className="py-3 px-6">วันที่สร้าง</th>
                    <th scope="col" className="py-3 px-6">เลขพัสดุ (ID)</th>
                    <th scope="col" className="py-3 px-6">ผู้รับ</th>
                    <th scope="col" className="py-3 px-6">เบอร์โทร</th>
                    <th scope="col" className="py-3 px-6">ยอด COD</th>
                    <th scope="col" className="py-3 px-6 text-center">จัดการ</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredHistory.length > 0 ? (
                    filteredHistory.map((order, index) => (
                      <tr key={index} className="bg-white border-b hover:bg-blue-50 transition">
                        <td className="py-4 px-6">{order.createdAt ? order.createdAt.toDate().toLocaleDateString('th-TH', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-'}</td>
                        <td className="py-4 px-6 font-mono font-bold text-blue-600">TH-SMART-{order.id.slice(-6).toUpperCase()}</td>
                        <td className="py-4 px-6 font-bold text-gray-900">{order.customerName || 'ไม่มีชื่อ'}</td>
                        <td className="py-4 px-6">{order.phone || '-'}</td>
                        <td className="py-4 px-6 font-bold">{order.isCOD ? `฿${order.codAmount.toLocaleString()}` : <span className="text-green-500 text-xs">โอนแล้ว</span>}</td>
                        <td className="py-4 px-6 flex justify-center gap-2">
                          <button onClick={() => handleReprintHistory(order)} className="bg-gray-200 hover:bg-gray-300 text-gray-800 p-2 rounded shadow-sm text-xs font-bold" title="พิมพ์ซ้ำ">🖨️ พิมพ์ซ้ำ</button>
                          <button onClick={() => handleEditHistory(order)} className="bg-blue-100 hover:bg-blue-200 text-blue-700 p-2 rounded shadow-sm text-xs font-bold" title="ดึงข้อมูลไปแก้ไข">✏️ แก้ไข</button>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr><td colSpan="6" className="text-center py-6 text-gray-400">ไม่พบประวัติออเดอร์ที่ค้นหา...</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}