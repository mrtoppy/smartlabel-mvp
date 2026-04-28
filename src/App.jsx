import { QRCodeSVG } from 'qrcode.react';
import React, { useState, useRef, useEffect } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';

import { auth, db } from './firebase'; 
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from "firebase/auth";
import { collection, addDoc, getDocs, query, serverTimestamp, doc, getDoc, setDoc, where, updateDoc, increment } from "firebase/firestore";

// --- ฟังก์ชันสกัดข้อความ (หัวใจของระบบ) ---
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
    if (itemRegex.test(line)) items.push(line); 
    else if (index === 0) customerName = line; 
    else addressLines.push(line); 
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
  const [userRole, setUserRole] = useState(''); 
  const [quota, setQuota] = useState(0); 
  
  const [isTopupOpen, setIsTopupOpen] = useState(false);
  const [selectedPackage, setSelectedPackage] = useState(100); 
  const [isAuthView, setIsAuthView] = useState(false); // ควบคุมหน้า Landing vs Login
  
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('maker'); 
  
  const [orders, setOrders] = useState([{ id: Date.now(), rawText: '', parsedData: null, isSaved: false, crmSuggestion: null }]);
  const labelRefs = useRef({});

  const [storeProfile, setStoreProfile] = useState({ name: 'ToppySmart Logistics', phone: '087-448-4448', address: '123/48 ม.5 ต.หอรัตนไชย อ.พระนครศรีอยุธยา' });
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [tempProfile, setTempProfile] = useState({ ...storeProfile });

  const [historyOrders, setHistoryOrders] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [reprintOrder, setReprintOrder] = useState(null);

  const [dashboardStats, setDashboardStats] = useState({ totalOrders: 0, codOrders: 0, totalCodAmount: 0, pieData: [], barData: [] });
  const [billingRequests, setBillingRequests] = useState([]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      if (currentUser) {
        setUser(currentUser);
        try {
          const userRef = doc(db, "users", currentUser.uid);
          const userSnap = await getDoc(userRef);
          if (userSnap.exists()) {
            setUserRole(userSnap.data().role);
            setQuota(userSnap.data().quota || 0);
          } else {
            await setDoc(userRef, { email: currentUser.email, role: 'Owner', quota: 20 });
            setUserRole('Owner');
            setQuota(20);
          }
        } catch (error) { console.error("Error:", error); }
      } else {
        setUser(null); setUserRole(''); setQuota(0);
      }
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    const savedProfile = localStorage.getItem('smartlabel_profile');
    if (savedProfile) setStoreProfile(JSON.parse(savedProfile));
  }, []);

  const loadDashboardData = async () => {
    try {
      const q = query(collection(db, "orders"));
      const querySnapshot = await getDocs(q);
      let total = 0, codCount = 0, codSum = 0, transferCount = 0;
      const dateMap = {};
      const ordersList = [];

      querySnapshot.forEach((doc) => {
        const data = doc.data();
        ordersList.push({ id: doc.id, ...data });
        total++;
        if (data.isCOD) { codCount++; codSum += data.codAmount || 0; } 
        else { transferCount++; }
        if (data.createdAt) {
           const dateObj = data.createdAt.toDate();
           const dateStr = dateObj.toLocaleDateString('th-TH', { day: 'numeric', month: 'short' });
           if (!dateMap[dateStr]) dateMap[dateStr] = { name: dateStr, โอนเงิน: 0, COD: 0 };
           if (data.isCOD) dateMap[dateStr].COD += 1; else dateMap[dateStr].โอนเงิน += 1;
        }
      });
      ordersList.sort((a, b) => (b.createdAt?.toMillis() || 0) - (a.createdAt?.toMillis() || 0));
      setHistoryOrders(ordersList);
      const sortedBarData = Object.values(dateMap).sort((a, b) => new Date(a.name) - new Date(b.name));
      setDashboardStats({
        totalOrders: total, codOrders: codCount, totalCodAmount: codSum,
        pieData: [{ name: 'โอนเงินแล้ว', value: transferCount }, { name: 'เก็บเงินปลายทาง', value: codCount }],
        barData: sortedBarData.length > 0 ? sortedBarData : [{ name: 'รอข้อมูลใหม่', โอนเงิน: 0, COD: 0 }]
      });
    } catch (error) { console.error(error); }
  };

  const loadBillingRequests = async () => {
    try {
      const q = query(collection(db, "topups"), where("status", "==", "pending"));
      const querySnapshot = await getDocs(q);
      const requests = [];
      querySnapshot.forEach((doc) => { requests.push({ id: doc.id, data: doc.data() }); });
      requests.sort((a, b) => (b.data.createdAt?.toMillis() || 0) - (a.data.createdAt?.toMillis() || 0));
      setBillingRequests(requests);
    } catch (error) { console.error("Error loading bills:", error); }
  };

  useEffect(() => { 
    if (activeTab === 'dashboard') loadDashboardData(); 
    if (activeTab === 'billing' && userRole === 'SuperAdmin') loadBillingRequests();
  }, [activeTab, userRole]);

  const handleLogin = async (e) => {
    e.preventDefault();
    try { await signInWithEmailAndPassword(auth, e.target.email.value, e.target.password.value); } 
    catch (error) { alert("อีเมลหรือรหัสผ่านไม่ถูกต้องครับ"); }
  };
  const handleLogout = () => signOut(auth);

  const checkCustomerHistory = async (orderId, phone) => {
    if (!phone || phone.length < 9) return;
    try {
      const q = query(collection(db, "orders"), where("phone", "==", phone));
      const querySnapshot = await getDocs(q);
      if (!querySnapshot.empty) {
        const historyData = [];
        querySnapshot.forEach((doc) => historyData.push(doc.data()));
        historyData.sort((a, b) => (b.createdAt?.toMillis() || 0) - (a.createdAt?.toMillis() || 0));
        setOrders(prevOrders => prevOrders.map(order => order.id === orderId ? { ...order, crmSuggestion: historyData[0] } : order));
      } else {
        setOrders(prevOrders => prevOrders.map(order => order.id === orderId ? { ...order, crmSuggestion: null } : order));
      }
    } catch (error) { console.error("CRM Error:", error); }
  };

  const handleTextChange = (id, newText) => {
    let updatedOrders = orders.map(order => {
      if (order.id === id) {
        const parsed = newText.trim() !== '' ? extractOrderData(newText) : null;
        if (parsed && parsed.phone && parsed.phone !== order.parsedData?.phone) checkCustomerHistory(id, parsed.phone);
        if (!parsed || !parsed.phone) return { ...order, rawText: newText, parsedData: parsed, isSaved: false, crmSuggestion: null };
        return { ...order, rawText: newText, parsedData: parsed, isSaved: false };
      }
      return order;
    });
    if (updatedOrders[updatedOrders.length - 1].rawText.trim() !== '') updatedOrders.push({ id: Date.now(), rawText: '', parsedData: null, isSaved: false, crmSuggestion: null });
    setOrders(updatedOrders);
  };

  const applyCrmData = (orderId, crmData) => {
    setOrders(prevOrders => prevOrders.map(order => {
      if (order.id === orderId) {
        const newRawText = `${crmData.customerName}\n${crmData.address} ${crmData.zipcode}\n${order.rawText}`;
        return { ...order, rawText: newRawText, parsedData: extractOrderData(newRawText), crmSuggestion: null };
      }
      return order;
    }));
  };

  const handleDeleteOrder = (id) => {
    const remainingOrders = orders.filter(order => order.id !== id);
    setOrders(remainingOrders.length === 0 ? [{ id: Date.now(), rawText: '', parsedData: null, isSaved: false, crmSuggestion: null }] : remainingOrders);
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
    if (userRole !== 'SuperAdmin' && readyToSaveOrders.length > quota) { setIsTopupOpen(true); return; }
    if (readyToSaveOrders.length > 0) {
      try {
        for (const order of readyToSaveOrders) {
          const codNumber = order.parsedData.isCOD ? Number(order.parsedData.codAmount.replace(/,/g, '')) : 0;
          await addDoc(collection(db, "orders"), {
            rawText: order.rawText, adminEmail: user.email, storeName: storeProfile.name,
            customerName: order.parsedData.customerName, phone: order.parsedData.phone,
            address: order.parsedData.address, zipcode: order.parsedData.zipcode,
            items: order.parsedData.items, isCOD: order.parsedData.isCOD, codAmount: codNumber,
            createdAt: serverTimestamp() 
          });
        }
        if (userRole !== 'SuperAdmin') {
          const userRef = doc(db, "users", user.uid);
          await updateDoc(userRef, { quota: increment(-readyToSaveOrders.length) });
          setQuota(prev => prev - readyToSaveOrders.length);
        }
        setOrders(prevOrders => prevOrders.map(o => (o.parsedData && !o.isSaved && o.rawText.trim() !== '') ? { ...o, isSaved: true } : o));
      } catch (error) { alert("เกิดข้อผิดพลาดในการบันทึกข้อมูลครับ"); }
    }
    window.print();
  };

  const handleEditHistory = (order) => {
    setOrders([{ id: Date.now(), rawText: order.rawText || '', parsedData: extractOrderData(order.rawText || ''), isSaved: false, crmSuggestion: null }, { id: Date.now() + 1, rawText: '', parsedData: null, isSaved: false, crmSuggestion: null }]);
    setActiveTab('maker'); window.scrollTo(0, 0); 
  };

  const handleReprintHistory = (order) => {
    setReprintOrder(order); setTimeout(() => { window.print(); setReprintOrder(null); }, 300); 
  };

  const handleExportCSV = () => {
    if (historyOrders.length === 0) return alert("ไม่มีข้อมูลให้ดาวน์โหลดครับ");
    const headers = ["วันที่สร้าง", "เลขพัสดุ", "ชื่อผู้รับ", "เบอร์โทร", "ที่อยู่", "รหัสไปรษณีย์", "รายการสินค้า", "ยอด COD", "แอดมิน"];
    const csvRows = filteredHistory.map(order => [
      order.createdAt ? order.createdAt.toDate().toLocaleString('th-TH') : '-',
      `TH-SMART-${order.id.slice(-6).toUpperCase()}`, `"${order.customerName || ''}"`, order.phone || '-', `"${order.address || ''}"`,
      order.zipcode || '-', `"${(order.items || []).join(' | ')}"`, order.isCOD ? order.codAmount : "0", order.adminEmail || '-'
    ].join(','));
    const blob = new Blob(["\uFEFF" + headers.join(',') + '\n' + csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `SmartLabel_Orders.csv`; link.click();
  };

  const handleSubmitTopup = async () => {
    try {
      await addDoc(collection(db, "topups"), {
        email: user.email, uid: user.uid, requestedQuota: selectedPackage,
        amount: selectedPackage === 100 ? 50 : 200, status: 'pending', createdAt: serverTimestamp()
      });
      alert("ส่งหลักฐานสำเร็จ! กรุณารอแอดมินอนุมัติครับ"); setIsTopupOpen(false);
    } catch (error) { alert("เกิดข้อผิดพลาดในการส่งคำขอ"); }
  };

  const handleApproveTopup = async (requestId, userId, requestedQuota) => {
    try {
      await updateDoc(doc(db, "topups", requestId), { status: 'approved', approvedAt: serverTimestamp() });
      await updateDoc(doc(db, "users", userId), { quota: increment(requestedQuota) });
      if (userId === user.uid) setQuota(prev => prev + requestedQuota);
      alert(`✅ อนุมัติสำเร็จ! เพิ่มโควต้า ${requestedQuota} ใบเรียบร้อย`);
      loadBillingRequests(); 
    } catch (error) { alert("เกิดข้อผิดพลาดในการอนุมัติ"); }
  };

  const filteredHistory = historyOrders.filter(order => {
    const term = searchQuery.toLowerCase();
    return (order.customerName || '').toLowerCase().includes(term) || (order.phone || '').includes(term) || (order.id || '').toLowerCase().includes(term);
  });

  if (loading) return <div className="min-h-screen flex items-center justify-center bg-gray-100 font-bold text-blue-600">กำลังโหลดระบบ...</div>;

  // --- 🔥 Landing Page UI ---
  if (!user && !isAuthView) {
    return (
      <div className="min-h-screen bg-white font-sans text-gray-900">
        {/* Navbar */}
        <nav className="flex justify-between items-center px-6 py-4 border-b">
          <div className="text-2xl font-black text-blue-800">📦 SmartLabel</div>
          <button onClick={() => setIsAuthView(true)} className="bg-blue-600 text-white px-6 py-2 rounded-full font-bold hover:bg-blue-700 transition shadow-md">เข้าสู่ระบบ</button>
        </nav>

        {/* Hero Section */}
        <header className="px-6 py-20 text-center bg-gradient-to-b from-blue-50 to-white">
          <h1 className="text-5xl md:text-7xl font-black text-blue-900 mb-6 leading-tight">
            จ่าหน้าพัสดุไวขึ้น 10 เท่า <br/> <span className="text-blue-600">ด้วยสมองกลอัจฉริยะ</span>
          </h1>
          <p className="text-xl text-gray-600 mb-10 max-w-2xl mx-auto">
            สกัดชื่อที่อยู่จากแชทลูกค้าอัตโนมัติ พร้อมระบบจดจำลูกค้าเก่า (CRM) และสถิติครบวงจร เพื่อแม่ค้าออนไลน์มือโปรเช่นคุณ
          </p>
          <button onClick={() => setIsAuthView(true)} className="bg-blue-600 text-white text-xl px-12 py-4 rounded-full font-black hover:scale-105 transition-all shadow-xl">
            เริ่มทดลองใช้ฟรี 20 ใบ
          </button>
          <div className="mt-12 opacity-50 flex justify-center gap-8 grayscale italic font-bold">
             <span>#แม่ค้าแฮปปี้</span> <span>#พิมพ์ไวไม่ง้อก๊อปปี้</span> <span>#สถิติแม่นยำ</span>
          </div>
        </header>

        {/* Features Section */}
        <section className="py-20 px-6 max-w-6xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-12">
           <div className="text-center">
             <div className="text-5xl mb-4">🧠</div>
             <h3 className="text-xl font-bold mb-2">Smart CRM</h3>
             <p className="text-gray-500">พิมพ์แค่เบอร์โทร ข้อมูลชื่อและที่อยู่ลูกค้าเก่าเด้งขึ้นมาให้ทันที ไม่ต้องก๊อปวางซ้ำๆ</p>
           </div>
           <div className="text-center">
             <div className="text-5xl mb-4">🖨️</div>
             <h3 className="text-xl font-bold mb-2">Thermal Ready</h3>
             <p className="text-gray-500">ออกแบบมาเพื่อเครื่องพิมพ์ความร้อน (100x150mm) โดยเฉพาะ พิมพ์ออกมาสวยเป๊ะทุกใบ</p>
           </div>
           <div className="text-center">
             <div className="text-5xl mb-4">📊</div>
             <h3 className="text-xl font-bold mb-2">Dashboard & Export</h3>
             <p className="text-gray-500">ดูยอดส่งรายวัน แยกประเภทโอนเงิน/COD และดาวน์โหลดข้อมูลเป็น Excel ได้ในคลิกเดียว</p>
           </div>
        </section>

        {/* Pricing Section */}
        <section className="py-20 bg-gray-50">
          <div className="max-w-4xl mx-auto px-6 text-center">
            <h2 className="text-4xl font-bold mb-12">ราคาแพ็กเกจที่คุณเลือกได้</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
              <div className="bg-white p-10 rounded-3xl shadow-lg border-2 border-gray-100">
                 <p className="text-blue-600 font-bold mb-4">เริ่มต้นเบาๆ</p>
                 <p className="text-6xl font-black mb-4">฿50</p>
                 <p className="text-gray-500 mb-8">ได้รับ 100 จ่าหน้า <br/> (เพียง 0.5 บาทต่อใบ)</p>
                 <button onClick={() => setIsAuthView(true)} className="w-full py-4 rounded-xl border-2 border-blue-600 text-blue-600 font-bold hover:bg-blue-50 transition">เลือกแพ็กเกจนี้</button>
              </div>
              <div className="bg-white p-10 rounded-3xl shadow-2xl border-4 border-blue-600 relative overflow-hidden">
                 <div className="absolute top-0 right-0 bg-blue-600 text-white px-6 py-2 font-bold text-sm rounded-bl-2xl">ยอดฮิต</div>
                 <p className="text-blue-600 font-bold mb-4">คุ้มค่าที่สุด</p>
                 <p className="text-6xl font-black mb-4">฿200</p>
                 <p className="text-gray-500 mb-8">ได้รับ 500 จ่าหน้า <br/> (เพียง 0.4 บาทต่อใบ)</p>
                 <button onClick={() => setIsAuthView(true)} className="w-full py-4 rounded-xl bg-blue-600 text-white font-bold hover:bg-blue-700 transition">เลือกแพ็กเกจนี้</button>
              </div>
            </div>
          </div>
        </section>

        <footer className="py-12 border-t text-center text-gray-400 text-sm">
           © 2026 ToppySmart Logistics. พัฒนาโดยพาร์ทเนอร์ & CTO Copilot
        </footer>
      </div>
    );
  }

  // --- หน้า Login ---
  if (!user && isAuthView) {
    return (
      <div className="min-h-screen bg-blue-900 flex flex-col items-center justify-center p-6 font-sans">
        <button onClick={() => setIsAuthView(false)} className="text-blue-200 mb-8 hover:text-white transition">← กลับหน้าหลัก</button>
        <div className="bg-white p-8 rounded-2xl shadow-2xl w-full max-w-md">
          <div className="text-center mb-8"><h1 className="text-4xl font-extrabold text-blue-800 mb-2">📦 SmartLabel</h1><p className="text-gray-500 italic">"จ่าหน้าอัจฉริยะ เพื่อมืออาชีพเช่นคุณ"</p></div>
          <form onSubmit={handleLogin}>
            <div className="mb-4"><label className="block text-sm font-bold text-gray-700 mb-2">อีเมลผู้ใช้งาน</label><input name="email" type="email" required className="w-full border border-gray-300 p-3 rounded-lg focus:ring-2 focus:ring-blue-400 outline-none" placeholder="admin@toppysmart.com" /></div>
            <div className="mb-6"><label className="block text-sm font-bold text-gray-700 mb-2">รหัสผ่าน</label><input name="password" type="password" required className="w-full border border-gray-300 p-3 rounded-lg focus:ring-2 focus:ring-blue-400 outline-none" placeholder="••••••••" /></div>
            <button type="submit" className="w-full bg-blue-700 hover:bg-blue-800 text-white font-bold py-3 rounded-lg transition-all shadow-lg transform hover:scale-[1.02]">เข้าสู่ระบบ</button>
          </form>
          <p className="mt-6 text-center text-gray-400 text-xs">สำหรับพนักงาน: กรุณาขอรหัสผ่านจากเจ้าของร้าน</p>
        </div>
      </div>
    );
  }

  // --- หน้าแอปหลัก (หลังจาก Login) ---
  if (reprintOrder) {
    return (
      <div className="bg-white min-h-screen">
        <style>{`@media print { @page { size: 100mm 150mm; margin: 0; } body { background-color: white; -webkit-print-color-adjust: exact; margin: 0; } .thermal-label { width: 100mm; height: 148mm; padding: 5mm; box-sizing: border-box; margin: 0; border: none; overflow: hidden; } }`}</style>
        <div className="w-full max-w-sm mx-auto p-4 thermal-label print:max-w-none print:m-0 print:p-2">
           <div className="flex justify-between border-b pb-2 mb-2 font-bold text-sm"><span>SmartLabel ✅ (Reprint)</span><span className="text-gray-500">Admin: {reprintOrder.adminEmail?.split('@')[0]}</span></div>
           <div className="mb-3"><p className="text-xs text-gray-500">ผู้ส่ง:</p><p className="font-bold text-sm">{reprintOrder.storeName}</p></div>
           {reprintOrder.isCOD && <div className="bg-black text-white text-center py-2 mb-2 text-2xl font-bold print:border-[3px] print:border-black">COD: {reprintOrder.codAmount}</div>}
           <div className="bg-gray-100 p-2 mb-2 print:bg-white print:border print:border-gray-400"><p className="text-xs text-blue-600 font-bold print:text-black">ผู้รับ:</p><p className="text-xl font-bold">{reprintOrder.customerName || 'ไม่มีชื่อผู้รับ'}</p><p className="text-lg font-bold">☎ {reprintOrder.phone || '-'}</p><p className="text-sm leading-tight">{reprintOrder.address || 'ไม่มีที่อยู่'}</p></div>
           <div className="text-center text-4xl font-black mb-3 tracking-widest">{reprintOrder.zipcode || '00000'}</div>
           <div className="flex flex-col items-center border-t border-b py-2 mb-2"><QRCodeSVG value={JSON.stringify({ id: reprintOrder.id, cod: reprintOrder.isCOD ? reprintOrder.codAmount : 0 })} size={80} /><p className="text-xs mt-1 font-mono">TH-SMART-{String(reprintOrder.id).slice(-6).toUpperCase()}</p></div>
           <div><p className="text-xs font-bold">รายการสินค้า (Items):</p>{reprintOrder.items && reprintOrder.items.length > 0 ? (<ul className="text-[10px] list-disc pl-4 mt-1 leading-tight">{reprintOrder.items.map((item, index) => <li key={index}>{item}</li>)}</ul>) : (<p className="text-[10px] text-gray-500 italic mt-1">- ไม่ระบุรายการ -</p>)}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-100 p-6 font-sans print:bg-white print:p-0 relative">
      <style>{`@media print { @page { size: 100mm 150mm; margin: 0; } body { background-color: white; -webkit-print-color-adjust: exact; margin: 0; } .thermal-label { width: 100mm; height: 148mm; padding: 5mm; box-sizing: border-box; page-break-after: always; margin: 0 auto; border: none !important; overflow: hidden; } }`}</style>
      
      {/* Modals & Header (เหมือนเดิมที่พาร์ทเนอร์มี) */}
      {isTopupOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50 print:hidden">
          <div className="bg-white p-8 rounded-2xl shadow-2xl w-full max-w-lg">
            <div className="flex justify-between items-center mb-6"><h2 className="text-2xl font-bold text-gray-800 flex items-center gap-2">🚀 เติมแพ็กเกจจ่าหน้า</h2><button onClick={() => setIsTopupOpen(false)} className="text-gray-400 hover:text-red-500 font-bold text-xl">&times;</button></div>
            <div className="bg-blue-50 border border-blue-200 p-4 rounded-xl mb-6 text-center"><p className="text-gray-600 mb-1">โควต้าปัจจุบันของคุณ</p><p className="text-4xl font-extrabold text-blue-600">{quota} <span className="text-lg font-normal text-blue-800">ใบ</span></p></div>
            <h3 className="font-bold text-gray-700 mb-3">1. เลือกแพ็กเกจที่ต้องการ</h3>
            <div className="grid grid-cols-2 gap-3 mb-6">
              <div onClick={() => setSelectedPackage(100)} className={`border-2 rounded-lg p-3 text-center cursor-pointer relative overflow-hidden transition ${selectedPackage === 100 ? 'border-blue-500 bg-blue-50' : 'border-gray-300 hover:border-blue-300'}`}>{selectedPackage === 100 && <div className="absolute top-0 right-0 bg-blue-500 text-white text-[10px] font-bold px-2 py-1 rounded-bl-lg">เลือกอยู่</div>}<p className={`font-bold text-lg ${selectedPackage === 100 ? 'text-blue-800' : 'text-gray-800'}`}>100 ใบ</p><p className="text-sm text-gray-600">50 บาท</p></div>
              <div onClick={() => setSelectedPackage(500)} className={`border-2 rounded-lg p-3 text-center cursor-pointer relative overflow-hidden transition ${selectedPackage === 500 ? 'border-blue-500 bg-blue-50' : 'border-gray-300 hover:border-blue-300'}`}>{selectedPackage === 500 && <div className="absolute top-0 right-0 bg-blue-500 text-white text-[10px] font-bold px-2 py-1 rounded-bl-lg">เลือกอยู่</div>}<p className={`font-bold text-lg ${selectedPackage === 500 ? 'text-blue-800' : 'text-gray-800'}`}>500 ใบ</p><p className="text-sm text-gray-600">200 บาท</p></div>
            </div>
            <h3 className="font-bold text-gray-700 mb-3">2. สแกนชำระเงิน (PromptPay)</h3>
            <div className="flex flex-col items-center bg-gray-50 p-4 rounded-lg border border-gray-200 mb-6"><div className="bg-white p-2 rounded-lg shadow-sm mb-2"><QRCodeSVG value="0812345678" size={120} /></div><p className="text-sm font-bold text-gray-700">บจก. ท็อปปี้สมาร์ท โลจิสติกส์</p><p className="text-xs text-gray-500">ยอดชำระ: {selectedPackage === 100 ? '50.00' : '200.00'} บาท</p></div>
            <h3 className="font-bold text-gray-700 mb-3">3. แนบสลิปโอนเงิน</h3>
            <div className="mb-6"><input type="file" accept="image/*" className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100" /></div>
            <button onClick={handleSubmitTopup} className="w-full bg-green-500 hover:bg-green-600 text-white font-bold py-3 rounded-lg shadow-lg transition-transform transform hover:scale-[1.02]">ยืนยันการชำระเงิน</button>
          </div>
        </div>
      )}

      <header className="mb-6 bg-white p-4 rounded-lg shadow-sm print:hidden">
        <div className="flex justify-between items-center mb-4">
          <div>
            <h1 className="text-3xl font-bold text-blue-800 flex items-center gap-2">📦 SmartLabel <span className={`text-sm px-2 py-1 rounded-full ${userRole === 'SuperAdmin' ? 'bg-red-100 text-red-700 border border-red-200' : userRole === 'Owner' ? 'bg-purple-100 text-purple-700' : userRole === 'Admin' ? 'bg-blue-100 text-blue-600' : 'bg-gray-200 text-gray-700'}`}>{userRole}</span></h1>
            <p className="text-gray-600 text-sm">ผู้ใช้งาน: {user.email}</p>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex bg-gray-100 p-1 rounded-lg">
              <button onClick={() => setActiveTab('maker')} className={`px-4 py-2 rounded-md font-bold transition-all text-sm ${activeTab === 'maker' ? 'bg-white text-blue-600 shadow' : 'text-gray-500'}`}>✍️ สร้างจ่าหน้า</button>
              {(userRole === 'SuperAdmin' || userRole === 'Owner' || userRole === 'Admin') && <button onClick={() => setActiveTab('dashboard')} className={`px-4 py-2 rounded-md font-bold transition-all text-sm ${activeTab === 'dashboard' ? 'bg-white text-blue-600 shadow' : 'text-gray-500'}`}>📊 สถิติ & ประวัติ</button>}
              {userRole === 'SuperAdmin' && <button onClick={() => setActiveTab('billing')} className={`px-4 py-2 rounded-md font-bold transition-all text-sm ${activeTab === 'billing' ? 'bg-white text-blue-600 shadow' : 'text-gray-500'}`}>💳 จัดการบิล {billingRequests.length > 0 && <span className="ml-1 bg-red-500 text-white text-xs px-1.5 py-0.5 rounded-full">{billingRequests.length}</span>}</button>}
            </div>
            <button onClick={handleLogout} className="bg-red-50 hover:bg-red-100 text-red-600 px-4 py-2 rounded-lg font-bold text-sm transition-all">ออกจากระบบ 🚪</button>
          </div>
        </div>
        <div className="flex justify-between items-center bg-blue-50 p-3 rounded border border-blue-100">
          <div className="text-sm text-blue-800 flex items-center gap-3">
            {(userRole === 'Owner' || userRole === 'SuperAdmin' || userRole === 'Admin') && (
              <span className="font-bold text-purple-700 border-r border-blue-200 pr-3 flex items-center gap-1">
                🎫 โควต้าคงเหลือ: <span className={`${quota <= 5 && userRole !== 'SuperAdmin' ? 'text-red-500 animate-pulse' : ''}`}>{userRole === 'SuperAdmin' ? '∞' : quota} ใบ</span>
                {userRole !== 'SuperAdmin' && <button onClick={() => setIsTopupOpen(true)} className="ml-2 bg-purple-600 text-white px-2 py-0.5 rounded text-xs hover:bg-purple-700 transition">➕ เติม</button>}
              </span>
            )}
            <span><span className="font-bold">ร้าน:</span> {storeProfile.name}</span>
          </div>
          {(userRole === 'Owner' || userRole === 'SuperAdmin') && <button onClick={() => setIsSettingsOpen(true)} className="text-xs bg-white border border-blue-200 text-blue-600 px-3 py-1 rounded hover:bg-blue-100 font-bold">⚙️ ตั้งค่าร้านค้า</button>}
        </div>
      </header>

      {/* --- การแสดงผลตาม Tab (Copy จากโค้ดเดิมพาร์ทเนอร์มาใส่ที่นี่ได้เลยครับ ผมขอย่อไว้เพื่อให้โค้ดไม่ยาวเกินไป) --- */}
      {activeTab === 'maker' || userRole === 'Staff' ? (
         // ... (ใส่ UI Tab Maker เดิม) ...
         <div className="flex flex-col md:flex-row gap-6 print:block">
            <div className="flex-1 bg-white p-6 rounded-lg shadow-md border-t-4 border-blue-500 max-h-[70vh] overflow-y-auto print:hidden">
              <h2 className="text-xl font-semibold mb-4 text-gray-800">1. วางข้อความแชต</h2>
              {orders.map((order, index) => {
                let boxColorClass = 'border-gray-300 focus:ring-blue-400';
                if (order.parsedData) {
                  const hasWarnings = order.parsedData.warnings.length > 0;
                  boxColorClass = order.parsedData.isCOD ? (hasWarnings ? 'border-red-400 bg-orange-50 focus:ring-orange-500' : 'border-orange-400 bg-orange-50 focus:ring-orange-500') : (hasWarnings ? 'border-red-400 bg-red-50 focus:ring-red-500' : 'border-green-400 bg-green-50 focus:ring-green-500');
                }
                return (
                  <div key={order.id} className="mb-6 border-b pb-4 border-gray-100">
                    <div className="flex justify-between items-end mb-2"><label className="block text-sm font-bold text-gray-500">ออเดอร์ที่ {index + 1} {order.isSaved && <span className="ml-2 text-xs bg-green-100 text-green-700 px-2 py-1 rounded-full">💾 บันทึกแล้ว</span>}</label>{(order.rawText !== '' || orders.length > 1) && <button onClick={() => handleDeleteOrder(order.id)} className="text-red-400 hover:text-red-600 text-sm font-bold transition flex items-center gap-1">🗑️ ลบ</button>}</div>
                    {order.crmSuggestion && <div className="mb-2 p-3 bg-blue-50 border border-blue-200 rounded-md flex justify-between items-center animate-pulse"><div><p className="text-xs text-blue-500 font-bold">✨ พบประวัติ!</p><p className="text-sm font-bold">{order.crmSuggestion.customerName}</p></div><button onClick={() => applyCrmData(order.id, order.crmSuggestion)} className="bg-blue-600 text-white text-xs font-bold py-2 px-3 rounded shadow-md">ใช้ข้อมูลนี้เลย</button></div>}
                    <textarea className={`w-full h-32 p-4 border rounded-md focus:outline-none focus:ring-2 resize-none transition-all ${boxColorClass}`} placeholder="วางที่อยู่..." value={order.rawText} onChange={(e) => handleTextChange(order.id, e.target.value)} />
                    {order.parsedData && order.parsedData.warnings.length > 0 && <div className="mt-2 text-sm font-bold text-red-500 flex flex-col">{order.parsedData.warnings.map((w, i) => <span key={i}>{w}</span>)}</div>}
                  </div>
                );
              })}
            </div>
            <div className="flex-1 bg-gray-50 rounded-lg shadow-inner border-2 border-dashed border-gray-300 max-h-[70vh] overflow-y-auto print:bg-white print:border-none relative">
               <div className="sticky top-0 bg-white border-b-2 border-gray-200 p-4 flex justify-between items-center z-10 print:hidden"><h2 className="text-xl font-semibold">2. ตรวจสอบและสั่งพิมพ์</h2><button onClick={handleSaveAndPrint} className="bg-blue-600 text-white font-bold py-2 px-6 rounded-md shadow-lg transition-transform transform hover:scale-105">💾 บันทึก & สั่งพิมพ์</button></div>
               <div className="p-6 print:p-0">
                {orders.filter(o => o.parsedData).map((order) => (
                  <div key={order.id} ref={(el) => (labelRefs.current[order.id] = el)} className="w-full max-w-sm mx-auto mb-8 bg-white border-2 border-black p-4 thermal-label">
                     <div className="flex justify-between border-b pb-2 mb-2 font-bold text-sm"><span>SmartLabel ✅</span><span className="text-gray-500">Admin: {user.email.split('@')[0]}</span></div>
                     <div className="mb-3"><p className="text-xs text-gray-500">ผู้ส่ง:</p><p className="font-bold text-sm">{storeProfile.name}</p></div>
                     {order.parsedData.isCOD && <div className="bg-black text-white text-center py-2 mb-2 text-2xl font-bold">COD: {order.parsedData.codAmount}</div>}
                     <div className="bg-gray-100 p-2 mb-2 print:bg-white print:border"><p className="text-xs text-blue-600 font-bold">ผู้รับ:</p><p className="text-xl font-bold">{order.parsedData.customerName || 'ไม่มีชื่อ'}</p><p className="text-lg font-bold">☎ {order.parsedData.phone || '-'}</p><p className="text-sm leading-tight">{order.parsedData.address || 'ไม่มีที่อยู่'}</p></div>
                     <div className="text-center text-4xl font-black mb-3 tracking-widest">{order.parsedData.zipcode || '00000'}</div>
                     <div className="flex flex-col items-center border-t border-b py-2 mb-2"><QRCodeSVG value={JSON.stringify({ id: order.id, cod: order.parsedData.isCOD ? order.parsedData.codAmount : 0, admin: user.email })} size={80} /><p className="text-xs mt-1 font-mono uppercase">TH-SMART-{String(order.id).slice(-6)}</p></div>
                     <div><p className="text-xs font-bold">รายการสินค้า:</p>{order.parsedData.items.length > 0 ? (<ul className="text-[10px] list-disc pl-4">{order.parsedData.items.map((item, index) => <li key={index}>{item}</li>)}</ul>) : (<p className="text-[10px] text-gray-400 italic">- ไม่ระบุรายการ -</p>)}</div>
                  </div>
                ))}
               </div>
            </div>
         </div>
      ) : activeTab === 'dashboard' ? (
         <div className="flex flex-col gap-6">
            <div className="bg-white p-6 rounded-lg shadow-md border-t-4 border-purple-500">
              <h2 className="text-2xl font-bold mb-6 flex justify-between">ภาพรวมธุรกิจ ({userRole})</h2>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
                <div className="bg-blue-50 p-6 rounded-xl border border-blue-100"><h3 className="text-blue-600 font-bold">ส่งรวมทั้งหมด</h3><p className="text-4xl font-black text-blue-900">{dashboardStats.totalOrders} ชิ้น</p></div>
                <div className="bg-orange-50 p-6 rounded-xl border border-orange-100"><h3 className="text-orange-600 font-bold">ออเดอร์ COD</h3><p className="text-4xl font-black text-orange-900">{dashboardStats.codOrders} ชิ้น</p></div>
                <div className="bg-green-50 p-6 rounded-xl border border-green-100"><h3 className="text-green-600 font-bold">คาดการณ์เงินโอน</h3><p className="text-4xl font-black text-green-900">฿{dashboardStats.totalCodAmount.toLocaleString()}</p></div>
              </div>
            </div>
            <div className="bg-white p-6 rounded-lg shadow-md border-t-4 border-blue-500">
               <div className="flex flex-col md:flex-row justify-between mb-6 gap-4"><h2 className="text-2xl font-bold">🗂️ ประวัติพัสดุ</h2><div className="flex gap-2"><input type="text" className="border p-2 rounded-lg text-sm w-64" placeholder="ค้นหาชื่อ, เบอร์..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}/><button onClick={handleExportCSV} className="bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-bold shadow hover:bg-green-700">📥 โหลด Excel</button></div></div>
               <div className="overflow-x-auto border rounded-lg"><table className="w-full text-sm text-left"><thead className="bg-gray-50 uppercase text-xs font-bold"><tr><th className="py-3 px-6">วันที่สร้าง</th><th className="py-3 px-6">เลขพัสดุ</th><th className="py-3 px-6">ผู้รับ</th><th className="py-3 px-6">ยอด COD</th><th className="py-3 px-6 text-center">จัดการ</th></tr></thead>
               <tbody>{filteredHistory.map((order, index) => (<tr key={index} className="border-b hover:bg-gray-50"><td className="py-4 px-6">{order.createdAt?.toDate().toLocaleDateString('th-TH')}</td><td className="py-4 px-6 font-mono font-bold text-blue-600">TH-{order.id.slice(-6).toUpperCase()}</td><td className="py-4 px-6 font-bold">{order.customerName}</td><td className="py-4 px-6">{order.isCOD ? `฿${order.codAmount}` : 'โอนแล้ว'}</td><td className="py-4 px-6 flex justify-center gap-2"><button onClick={() => handleReprintHistory(order)} className="bg-gray-200 px-2 py-1 rounded text-xs font-bold">🖨️ พิมพ์ซ้ำ</button><button onClick={() => handleEditHistory(order)} className="bg-blue-100 text-blue-700 px-2 py-1 rounded text-xs font-bold">✏️ แก้ไข</button></td></tr>))}</tbody></table></div>
            </div>
         </div>
      ) : activeTab === 'billing' && userRole === 'SuperAdmin' ? (
         <div className="bg-white p-6 rounded-lg shadow-md border-t-4 border-yellow-500">
           <h2 className="text-2xl font-bold mb-6">💳 อนุมัติการเติมเงิน (SuperAdmin)</h2>
           <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
             {billingRequests.map((req, index) => (
               <div key={index} className="border p-5 rounded-xl bg-yellow-50 relative">
                 <p className="font-bold">{req.data.email}</p><p className="text-xs text-gray-500 mb-4">{req.data.createdAt?.toDate().toLocaleString('th-TH')}</p>
                 <div className="bg-white p-3 rounded mb-4 flex justify-between"><div><p className="text-xs">แพ็กเกจ</p><p className="font-bold text-blue-600">{req.data.requestedQuota} ใบ</p></div><div className="text-right"><p className="text-xs">ยอดโอน</p><p className="font-black text-green-600">฿{req.data.amount}</p></div></div>
                 <button onClick={() => handleApproveTopup(req.id, req.data.uid, req.data.requestedQuota)} className="w-full bg-green-500 text-white font-bold py-2 rounded shadow hover:bg-green-600 transition">✅ ยืนยันสลิป</button>
               </div>
             ))}
           </div>
         </div>
      ) : null}
    </div>
  );
}