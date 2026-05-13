import { QRCodeSVG } from 'qrcode.react';
import React, { useState, useRef, useEffect } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';

import { auth, db } from './firebase'; 
import { onAuthStateChanged, signInWithEmailAndPassword, signOut, createUserWithEmailAndPassword, getAuth, sendPasswordResetEmail } from "firebase/auth";
import { initializeApp, getApps } from "firebase/app";
import { collection, addDoc, getDocs, query, orderBy, onSnapshot, serverTimestamp, doc, getDoc, setDoc, where, updateDoc, increment, deleteDoc, Timestamp } from "firebase/firestore";

import generatePayload from 'promptpay-qr';

import FacebookLoginRaw from 'react-facebook-login/dist/facebook-login-render-props';


{/*import { messaging } from './firebase'; // import ตัวที่เราเพิ่งสร้างเมื่อกี้
import { getToken, onMessage } from "firebase/messaging";*/}

// ทะลวงกล่องที่ Vercel ห่อซ้อนกัน (เช็คทุกระดับชั้น)

const FacebookLogin = FacebookLoginRaw.default?.default || FacebookLoginRaw.default || FacebookLoginRaw;

// 🔥 สมองกล Advanced Parser ตัวเทพ
const extractOrderData = (rawText) => {
  if (!rawText) return null;
  let cleanText = rawText.replace(/-/g, ''); 

  const phoneMatch = cleanText.match(/\b0\d{8,9}\b/);
  const phone = phoneMatch ? phoneMatch[0] : '';
  const zipMatch = cleanText.match(/\b\d{5}\b/);
  const zipcode = zipMatch ? zipMatch[0] : '';

  let isCOD = false;
  let codAmount = '';
  const codRegex = /(?:cod|ปลายทาง|เก็บเงินปลายทาง|ยอด)\s*[:=]?\s*([\d,]+)/i;

  let addressPart = cleanText;
  let itemsPart = '';

  let lastIndex = -1;
  if (phoneMatch) lastIndex = Math.max(lastIndex, cleanText.indexOf(phoneMatch[0]) + phoneMatch[0].length);
  if (zipMatch) lastIndex = Math.max(lastIndex, cleanText.indexOf(zipMatch[0]) + zipMatch[0].length);

  if (lastIndex > -1 && lastIndex < cleanText.length) {
    itemsPart = cleanText.substring(lastIndex);
    addressPart = cleanText.substring(0, lastIndex);
  }

  const codMatchItems = itemsPart.match(codRegex) || addressPart.match(codRegex);
  if (codMatchItems) {
    isCOD = true;
    codAmount = codMatchItems[1];
    itemsPart = itemsPart.replace(codMatchItems[0], '');
    addressPart = addressPart.replace(codMatchItems[0], '');
  }

  if (phone) addressPart = addressPart.replace(phone, '');
  if (zipcode) addressPart = addressPart.replace(zipcode, '');
  addressPart = addressPart.replace(/\b(โทร\.?|เบอร์โทรศัพท์|เบอร์ติดต่อ|tel\.?)\b/gi, '');

  let lines = addressPart.split('\n').map(l => l.trim()).filter(l => l !== '');
  let customerName = '';
  let addressLines = [];

  if (lines.length === 1) {
    const splitRegex = /\s(\d+\/|\d+\s|บ้านเลขที่|หมู่|ม\.|ซอย|ซ\.|ถนน|ถ\.|ตำบล|ต\.)/;
    const match = lines[0].match(splitRegex);
    if (match) {
      customerName = lines[0].substring(0, match.index).trim();
      addressLines.push(lines[0].substring(match.index).trim());
    } else {
      const firstSpace = lines[0].indexOf(' ');
      if (firstSpace > -1) {
        customerName = lines[0].substring(0, firstSpace).trim();
        addressLines.push(lines[0].substring(firstSpace).trim());
      } else { customerName = lines[0]; }
    }
  } else if (lines.length > 1) {
    customerName = lines[0];
    addressLines = lines.slice(1);
  }

  let items = [];
  const cleanedItemsPart = itemsPart.trim();
  if (cleanedItemsPart) {
    const itemSplitRegex = /(.+?(?:x\s*\d+|\d+\s*(?:ตัว|ชิ้น|กล่อง|ใบ|คู่|ชุด|แพ็ค|ขวด|ซอง)))(?:\s+|$)/gi;
    let match; let foundItems = [];
    while ((match = itemSplitRegex.exec(cleanedItemsPart)) !== null) { foundItems.push(match[1].trim()); }
    items = foundItems.length > 0 ? foundItems : [cleanedItemsPart];
  }

  const address = addressLines.join(' ').trim();
  let warnings = [];
  if (!phone) warnings.push(isCOD ? "⚠️ ไม่มีเบอร์โทร (COD บังคับ!)" : "⚠️ ไม่มีเบอร์โทรศัพท์");
  if (!zipcode) warnings.push("⚠️ ไม่มีรหัสไปรษณีย์");
  if (addressPart.trim() !== '') {
    if (!/(ต\.|ตำบล|แขวง)/.test(addressPart)) warnings.push("⚠️ ขาด ตำบล/แขวง");
    if (!/(อ\.|อำเภอ|เขต)/.test(addressPart)) warnings.push("⚠️ ขาด อำเภอ/เขต");
  }

  return { customerName, phone, address, zipcode, items, isCOD, codAmount, warnings };
};

const COLORS = ['#22c55e', '#f97316'];

export default function App() {
  const userPlan = 'premium';
  const [user, setUser] = useState(null);
  const [userRole, setUserRole] = useState(''); 
  const [quota, setQuota] = useState(0); 
  const [userOwnerId, setUserOwnerId] = useState(null);

  const [isTopupOpen, setIsTopupOpen] = useState(false);
  const [selectedPackage, setSelectedPackage] = useState(100); 
  
  const [slipImage, setSlipImage] = useState(null);
  const [isUploading, setIsUploading] = useState(false);

  const [isAuthView, setIsAuthView] = useState(false); 
  const [authMode, setAuthMode] = useState('login'); 
  const [authType, setAuthType] = useState('merchant'); // 🔥 สลับโหมดร้านค้า(merchant) / ตัวแทน(partner)
  const [affiliateData, setAffiliateData] = useState(null); // ข้อมูลตัวแทน
  const [withdrawalHistory, setWithdrawalHistory] = useState([]); // ประวัติถอนเงิน

  const [connectedPages, setConnectedPages] = useState([]); // เก็บรายชื่อเพจที่ดึงมาจาก Facebook
  const [selectedPages, setSelectedPages] = useState([]);   // เก็บ ID เพจที่แม่ค้าติ๊กเลือกจะดูดแชท

  // 🔥 ฟังก์ชันช่วยก๊อปปี้ข้อความ
  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
    alert('คัดลอกลงคลิปบอร์ดแล้ว! นำไปวาง(Paste) ได้เลยครับ 📋');
  };

  // 📦 ฟังก์ชันคัดลอกข้อความแจ้งเลขพัสดุให้ลูกค้า
  const handleCopyTrackingMessage = (order) => {
    const trackingNumber = trackingInputs[order.id];
    
    // ดักไว้ก่อน เผื่อแม่ค้าลืมกรอกเลขพัสดุ
    if (!trackingNumber || trackingNumber.trim() === '') {
      alert("⚠️ รบกวนกรอก 'เลขพัสดุ' ในช่องก่อนกดปุ่มคัดลอกนะครับท่าน CEO!");
      return;
    }

    // ประกอบร่างข้อความสุดน่ารัก
    const customerName = order.customerName !== 'ไม่ระบุชื่อ' ? order.customerName : 'ลูกค้าที่น่ารัก';
    const message = `จัดส่งพัสดุเรียบร้อยนะคะ 📦✨\n\nคุณ ${customerName}\nเลขพัสดุ: ${trackingNumber}\n\nเช็คสถานะพัสดุได้ที่นี่เลยค่ะ 👇\nhttps://track.thailandpost.co.th\n\nขอบพระคุณที่อุดหนุน ${storeProfile.name || 'ร้านของเรา'} นะคะ 🙏💖`;

    // ใช้ฟังก์ชัน copy ของท่าน CEO ที่มีอยู่แล้ว
    copyToClipboard(message);
    
    // (ทางเลือก) ถ้าอนาคตอยากให้มันเซฟเลขพัสดุลง Firebase ด้วย สามารถเขียนโค้ดอัปเดตลง db ตรงนี้ได้เลยครับ
  };
  
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('maker'); 
  
  const [orders, setOrders] = useState([{ id: Date.now(), rawText: '', parsedData: null, isSaved: false, crmSuggestion: null }]);
  const labelRefs = useRef({});

  const [storeProfile, setStoreProfile] = useState({ name: '', phone: '', address: '' });
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [tempProfile, setTempProfile] = useState({ ...storeProfile });

  const [historyOrders, setHistoryOrders] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [trackingInputs, setTrackingInputs] = useState({}); // 🔥 เก็บเลขแทรคกิ้งชั่วคราวในตาราง (key คือ order.id)
  const [selectedDate, setSelectedDate] = useState(null); // 🔥 เก็บค่าว่ากำลังคลิกดูสถิติของวันไหน
  const [reprintOrder, setReprintOrder] = useState(null);

  const [dashboardStats, setDashboardStats] = useState({ totalOrders: 0, codOrders: 0, totalCodAmount: 0, pieData: [], barData: [] });
  const [billingRequests, setBillingRequests] = useState([]);
  
  const [staffList, setStaffList] = useState([]);
  const [newStaff, setNewStaff] = useState({ name: '', phone: '', role: 'Staff' });

  // State สำหรับเก็บแชทที่ดูดมาจาก Facebook
  const [incomingChats, setIncomingChats] = useState([]);

  // 🔥 State ใหม่สำหรับเก็บข้อมูลร้านค้าทั้งหมด (SuperAdmin)
  const [allShops, setAllShops] = useState([]);
  // 🔥 State สำหรับ SuperAdmin ดูข้อมูล Affiliate
  const [allAffiliates, setAllAffiliates] = useState([]);
  const [allWithdrawals, setAllWithdrawals] = useState([]);

  // 🕒 State สำหรับระบบประวัติแชท
  const [allChats, setAllChats] = useState([]); // เก็บแชททั้งหมด
  const [isHistoryModalOpen, setIsHistoryModalOpen] = useState(false); // เปิด/ปิด Pop-up

  // 🚀 ฟังก์ชันจำลองการขอเลขพัสดุจากไปรษณีย์ไทย (Mock API)
  const fetchMockTracking = async () => {
    // จำลองว่ารอระบบไปรษณีย์ตอบกลับ 0.8 วินาที
    await new Promise(resolve => setTimeout(resolve, 800)); 
    const randomNum = Math.floor(100000000 + Math.random() * 900000000);
    return `TH${randomNum}TH`; // เสกเลขออกมาเป็นรูปแบบไปรษณีย์ไทย
  };

  // 📥 1. State สำหรับเก็บแชท (ใช้ชื่อ incomingChats ให้ตรงกับโค้ด UI ของท่าน CEO)


  // 🔄 2. ฟังก์ชันดึงแชทอัตโนมัติจาก Firebase
  useEffect(() => {
    if (!user) return; 

    const q = query(
      collection(db, "chats"),
      where("ownerId", "==", user.uid)
    );

  const unsubscribe = onSnapshot(q, (snapshot) => {
      const chats = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      
      // เรียงลำดับเวลาใหม่สุดขึ้นก่อน
      chats.sort((a, b) => (b.timestamp?.toMillis() || 0) - (a.timestamp?.toMillis() || 0));
      
      // 🔥 แบ่งตะกร้า: เก็บทั้งหมดไว้ที่นึง และโชว์เฉพาะอันใหม่ที่จอหลัก
      setAllChats(chats); 
      setIncomingChats(chats.filter(chat => chat.status === "new"));
    });

    return () => unsubscribe(); 
  }, [user]);

  // ดึงข้อมูลตัวแทนและการถอนเงิน
  const loadAffiliateDataForAdmin = async () => {
    try {
      const qAff = query(collection(db, "users"), where("role", "==", "Affiliate"));
      const snapAff = await getDocs(qAff);
      const affList = []; snapAff.forEach(d => affList.push({id: d.id, ...d.data()}));
      setAllAffiliates(affList);

      const qW = query(collection(db, "withdrawals")); 
      const snapW = await getDocs(qW);
      const wList = []; snapW.forEach(d => wList.push({id: d.id, ...d.data()}));
      setAllWithdrawals(wList.sort((a,b) => b.createdAt?.toMillis() - a.createdAt?.toMillis()));
    } catch (error) { console.error("Error loading affiliate data:", error); }
  };

    // ดึงเฉพาะแชทที่เจ้าของเป็นเรา (user.uid) และมีสถานะเป็น 'new'
  useEffect(() => {
    if (!user) return; 

    const q = query(
      collection(db, 'chats'), 
      where('ownerId', '==', user.uid), 
      where('status', '==', 'new')
    );
    const unsubscribeChats = onSnapshot(qChats, (snapshot) => {
      const chatData = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      setIncomingChats(chatData);
    });

    return () => unsubscribeChats();
  }, []);

  // ========================================================
  // 🛡️ ยามเฝ้าประตู: เช็ควันหมดอายุ Premium อัตโนมัติ
  // ========================================================
  useEffect(() => {
    if (!user) return; 

    const checkPremiumExpire = async () => {
      try {
        const userRef = doc(db, "users", user.uid);
        const userSnap = await getDoc(userRef);

        if (userSnap.exists()) {
          const userData = userSnap.data();
          const now = new Date();

          // ถ้าเป็น Premium และมีวันหมดอายุระบุไว้
          if (userData.plan === "Premium" && userData.premiumExpireDate) {
            const expireTime = userData.premiumExpireDate.toDate();

            // เช็คว่า "เวลาปัจจุบัน" เลย "เวลาหมดอายุ" ไปหรือยัง?
            if (now > expireTime) {
              console.log("⚠️ หมดเวลา Premium! ระบบกำลังดาวน์เกรดเป็น Basic...");
              
              // 1. สั่ง Firebase ให้เปลี่ยน plan เป็น Basic
              await updateDoc(userRef, { plan: "Basic" });
              
              // 2. อัปเดต State หน้าจอให้กระจกฝ้าเด้งขึ้นมาทันที (ใช้ชื่อ State ตามที่ท่าน CEO มี)
              // ถ้าท่าน CEO ใช้คำสั่งดึง storeProfile แบบ Real-time ไว้แล้ว หน้าจอมันจะตัดฝ้าลงมาเองครับ!
            }
          }
        }
      } catch (error) {
        console.error("Error checking premium status:", error);
      }
    };

    checkPremiumExpire();
  }, [user]);

  // 🔥 State สำหรับคู่มือการใช้งาน (Onboarding Tutorial)
  const [showTutorial, setShowTutorial] = useState(false);
  const [tutorialStep, setTutorialStep] = useState(0);

  // 📥 1. ฝ่ายทะเบียนประวัติ: ดึงข้อมูลผู้ใช้และข้อมูลร้านค้า (ฉบับแชร์ข้อมูลให้ลูกน้อง)
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      if (currentUser) {
        setUser(currentUser);
        try {
          const userRef = doc(db, "users", currentUser.uid);
          const userSnap = await getDoc(userRef);

          if (userSnap.exists()) {
            const data = userSnap.data();
            const currentRole = data.role;
            setUserRole(currentRole);

            // 🤝 กรณีเป็น Affiliate (พาร์ทเนอร์)
            if (currentRole === 'Affiliate') {
              setAffiliateData(data);
              const qW = query(collection(db, "withdrawals"), where("affiliateId", "==", currentUser.uid));
              getDocs(qW).then(snap => {
                const wList = []; snap.forEach(d => wList.push({ id: d.id, ...d.data() }));
                setWithdrawalHistory(wList.sort((a, b) => b.createdAt?.toMillis() - a.createdAt?.toMillis()));
              });
            }

            // 🚀 จุดสำคัญ: การจัดการข้อมูลร้านค้า (Store Profile & Quota)
            if (['Admin', 'Staff'].includes(currentRole)) {
              // 👥 ถ้าเป็น "ลูกน้อง": ให้ไปดึงข้อมูลจากไอดีของ "เถ้าแก่" (ownerId)
              if (data.ownerId) {
                const ownerRef = doc(db, "users", data.ownerId);
                const ownerSnap = await getDoc(ownerRef);
                if (ownerSnap.exists()) {
                  const ownerData = ownerSnap.data();
                  // 📥 ดึงข้อมูลของเถ้าแก่มาใส่ให้ลูกน้องเห็น
                  setStoreProfile({
                    name: ownerData.storeName || "ร้านค้าสมาชิก",
                    phone: ownerData.phone || "",
                    address: ownerData.address || "",
                    plan: ownerData.plan || "Free" // 🔓 ม่านจะเปิดที่นี่เพราะ plan จะเป็น Premium ตามเถ้าแก่
                  });
                  setQuota(ownerData.quota || 0); // 🎫 โควต้าจะเด้งขึ้นตามเถ้าแก่
                  setUserOwnerId(data.ownerId);
                }
              }
            } else {
              // 👨‍💼 ถ้าเป็น "Owner" หรือ "SuperAdmin": ใช้ข้อมูลตัวเองตามปกติ
              setStoreProfile({
                name: data.storeName || "",
                phone: data.phone || "",
                address: data.address || "",
                plan: data.plan || "Free"
              });
              setQuota(data.quota || 0);
              setUserOwnerId(currentUser.uid);
              
              if (currentRole === 'SuperAdmin') setActiveTab('shops');
              // โชว์ Tutorial เฉพาะ Owner
              if (!localStorage.getItem(`has_seen_tutorial_${currentUser.uid}`)) {
                setShowTutorial(true);
              }
            }

          } else {
            // 🆕 กรณีเป็นผู้ใช้ใหม่ (สมัครสมาชิกครั้งแรก)
            const roleToSet = authType === 'partner' ? 'Affiliate' : 'Owner';
            const initialData = {
              email: currentUser.email,
              role: roleToSet,
              ownerId: currentUser.uid,
              createdAt: serverTimestamp(),
              ...(roleToSet === 'Affiliate' ? { balance: 0, referralCode: "SL" + Math.floor(1000 + Math.random() * 9000) } : { quota: 50, plan: 'Free', storeName: '' })
            };
            await setDoc(userRef, initialData);
            setUserRole(roleToSet);
            setQuota(roleToSet === 'Owner' ? 50 : 0);
            setUserOwnerId(currentUser.uid);
          }
        } catch (error) { console.error("Error fetching user data:", error); }
      } else {
        // 🚪 ออกจากระบบ: ล้างค่าทั้งหมด
        setUser(null); setUserRole(''); setQuota(0); setUserOwnerId(null); setAffiliateData(null);
      }
      setLoading(false);
    });
    return () => unsubscribe();
  }, [authType]); // เฝ้าดู authType เผื่อมีการสลับหน้าสมัครพาร์ทเนอร์

  useEffect(() => {
      const savedProfile = localStorage.getItem('smartlabel_profile');
      if (savedProfile) setStoreProfile(JSON.parse(savedProfile));

      // 🔥 [Affiliate Step 1.1] ดักจับ Referral Code จาก URL
      const urlParams = new URLSearchParams(window.location.search);
      const refCode = urlParams.get('ref');
      
      if (refCode) {
        // แอบจดจำ Referral Code ไว้ในเครื่องลูกค้า
        // บังคับแปลงเป็นพิมพ์ใหญ่ทั้งหมด เพื่อป้องกันปัญหาตอนคนพิมพ์ลิงก์ผิด
        localStorage.setItem('smartlabel_ref', refCode.toUpperCase()); 
        
        // ทำความสะอาด URL ให้ดูเนียนตา
        window.history.replaceState({}, document.title, window.location.pathname);
      }
    }, []);

  // 📡 ระบบดึงข้อมูล Dashboard และ History แบบ Real-time
  useEffect(() => {
    if (!userOwnerId || userRole === 'SuperAdmin') return; 

    // 🚨 แก้บั๊ก: ชี้เป้าหมายไปที่แฟ้ม "orders" ให้ถูกต้อง
    const q = query(collection(db, "orders"), where("ownerId", "==", userOwnerId));

    // ใช้ onSnapshot แทน getDocs เพื่อให้ข้อมูลไหลเข้าจอทันทีที่กดเซฟ (Real-time)
    const unsubscribe = onSnapshot(q, (querySnapshot) => {
      let total = 0, codCount = 0, codSum = 0, transferCount = 0;
      const dateMap = {}; 
      const staffMap = {}; // 🏆 กล่องเก็บคะแนนสำหรับ Leaderboard
      const ordersList = [];

      querySnapshot.forEach((doc) => {
        const data = doc.data(); 
        ordersList.push({ id: doc.id, ...data });
        total++;

        if (data.isCOD) { 
            codCount++; 
            codSum += Number(data.codAmount) || 0; 
        } else { 
            transferCount++; 
        }

        // 📅 จัดกลุ่มยอดรายวันสำหรับกราฟแท่ง
        if (data.createdAt) {
           const dateStr = data.createdAt.toDate().toLocaleDateString('th-TH', { day: 'numeric', month: 'short' });
           if (!dateMap[dateStr]) dateMap[dateStr] = { name: dateStr, โอนเงิน: 0, COD: 0 };
           if (data.isCOD) dateMap[dateStr].COD += 1; else dateMap[dateStr].โอนเงิน += 1;
        }

        // 🏆 เก็บแต้มพนักงานสำหรับ Leaderboard
        const creator = data.creatorName || data.phone || 'Owner';
        staffMap[creator] = (staffMap[creator] || 0) + 1;
      });

      // จัดเรียง History ให้อันใหม่ล่าสุดอยู่บนสุด
      ordersList.sort((a, b) => (b.createdAt?.toMillis() || 0) - (a.createdAt?.toMillis() || 0));
      
      // จัดเรียง Leaderboard พนักงานจากคนที่แพ็คเยอะสุดไปน้อยสุด
      const staffLeaderboard = Object.keys(staffMap).map(name => ({
         name: name,
         ชิ้นงาน: staffMap[name]
      })).sort((a, b) => b.ชิ้นงาน - a.ชิ้นงาน);

      // อัปเดตข้อมูลเข้าสู่หน้าจอ
      setHistoryOrders(ordersList);
      setDashboardStats({
        totalOrders: total, 
        codOrders: codCount, 
        totalCodAmount: codSum,
        pieData: [{ name: 'โอนเงินแล้ว', value: transferCount }, { name: 'เก็บเงินปลายทาง', value: codCount }],
        barData: Object.values(dateMap).sort((a, b) => new Date(a.name) - new Date(b.name)) || [{ name: 'รอข้อมูลใหม่', โอนเงิน: 0, COD: 0 }],
        staffData: staffLeaderboard // 👈 โยนข้อมูลให้กราฟ Gamification
      });
    }, (error) => { 
        console.error("Dashboard Real-time Error:", error); 
    });

    // คืนค่าฟังก์ชันยกเลิกการดึงข้อมูลเมื่อสลับหน้าจอ (ลดภาระเซิร์ฟเวอร์)
    return () => unsubscribe();
  }, [userOwnerId, userRole]);

  const loadBillingRequests = () => {
      try {
        // 🎯 เปลี่ยนชื่อคอลเลกชันให้ตรงกับที่แม่ค้าส่งมา (topup_requests)
        const q = query(
          collection(db, "topup_requests"), 
          where("status", "==", "pending")
        );
        
        // ✨ ใช้ onSnapshot เพื่อให้บิลใหม่เด้งเข้าหน้าจอ SuperAdmin ทันทีไม่ต้องกดรีเฟรช
        const unsubscribe = onSnapshot(q, (snapshot) => {
          const requests = snapshot.docs.map(doc => ({
            id: doc.id,
            data: doc.data()
          }));
          
          // เรียงลำดับตามเวลา (ใหม่สุดอยู่บน)
          const sortedRequests = requests.sort((a, b) => 
            (b.data.timestamp?.toMillis() || 0) - (a.data.timestamp?.toMillis() || 0)
          );
          
          setBillingRequests(sortedRequests);
        });

        return unsubscribe;
      } catch (error) { 
        console.error("Error loading bills:", error); 
      }
    };
  const loadStaffData = async () => {
    try {
      const q = query(collection(db, "users"), where("ownerId", "==", user.uid));
      const querySnapshot = await getDocs(q);
      const staffs = [];
      querySnapshot.forEach((doc) => { staffs.push({ id: doc.id, ...doc.data() }); });
      setStaffList(staffs);
    } catch (error) { console.error("Error loading staff:", error); }
  };

  // 🔥 ฟังก์ชันใหม่สำหรับ SuperAdmin เพื่อดึงข้อมูลร้านค้าทั้งหมด
  const loadAllShopsData = async () => {
    try {
      const q = query(collection(db, "users"), where("role", "==", "Owner"));
      const querySnapshot = await getDocs(q);
      const shops = [];
      querySnapshot.forEach((doc) => { shops.push({ id: doc.id, ...doc.data() }); });
      // เรียงจากร้านใหม่ล่าสุดไปเก่า
      shops.sort((a, b) => (b.createdAt?.toMillis() || 0) - (a.createdAt?.toMillis() || 0));
      setAllShops(shops);
    } catch (error) { console.error("Error loading shops:", error); }
  };

  useEffect(() => {
    if (userRole === 'SuperAdmin') {
      const unsubscribe = loadBillingRequests(); // เรียกฟังก์ชันที่เราเพิ่งแก้
      return () => unsubscribe && unsubscribe(); // ล้างข้อมูลเมื่อปิดหน้าจอ
    }
  }, [userRole]);

  // 🔔 ระบบขออนุญาตแจ้งเตือน (Web Push Notification)
  {/*useEffect(() => {
    const requestNotificationPermission = async () => {
      try {
        console.log("กำลังขออนุญาตส่งแจ้งเตือน...");
        const permission = await Notification.requestPermission();
        
        if (permission === 'granted') {
          console.log("✅ ผู้ใช้อนุญาตให้ส่งแจ้งเตือนแล้ว!");

          // 🛠️ 1. จูงมือระบบไปลงทะเบียนบุรุษไปรษณีย์ด้วยตัวเอง
          const registration = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
          
          // 🛠️ 2. ขอรับ Token (ใส่ registration พ่วงเข้าไปด้วย)
          const currentToken = await getToken(messaging, { 
            vapidKey: "BGfgMAh9aIGcLHy4sZbjmJw4mTfkLIutjfljsCR8avKDJNCTGhN7Om5z4mGhNHmd5dQQgw5ionip5irvzU6xZKk", // เช็คให้ชัวร์ว่าไม่มีเว้นวรรคข้างหน้าหรือข้างหลังรหัสเท่านี้นะครับ
            serviceWorkerRegistration: registration // 👈 เพิ่มบรรทัดนี้เข้ามาครับ!
          });

          if (currentToken) {
            console.log("🔑 Token ของเครื่องนี้คือ:", currentToken);
          } else {
            console.log("ไม่มี Token กลับมา ให้ตรวจสอบ VAPID Key ครับ");
          }   
        } else {
          console.log("❌ ผู้ใช้ไม่อนุญาตให้ส่งแจ้งเตือน");
        }
      } catch (error) {
        console.error("เกิดข้อผิดพลาดในการขอสิทธิ์แจ้งเตือน:", error);
      }
    };

    // ดักฟังข้อความแจ้งเตือน กรณีที่แม่ค้ากำลังเปิดหน้าเว็บเราทิ้งไว้อยู่ (Foreground)
    const unsubscribeMessage = onMessage(messaging, (payload) => {
      console.log("🔔 มีข้อความเข้าขณะเปิดแอป:", payload);
      // ตรงนี้เราสามารถสั่งให้เด้ง Toast แจ้งเตือนมุมจอสวยๆ ได้ครับ
      alert(`มีแจ้งเตือนใหม่: ${payload.notification.title}`); 
    });

    requestNotificationPermission();

    return () => unsubscribeMessage();
  }, []);*/}
  
  useEffect(() => { 

    if (activeTab === 'billing' && userRole === 'SuperAdmin') loadBillingRequests();
    if (activeTab === 'team' && userRole === 'Owner') loadStaffData();
    if (activeTab === 'shops' && userRole === 'SuperAdmin') loadAllShopsData();
    if (activeTab === 'affiliates' && userRole === 'SuperAdmin') loadAffiliateDataForAdmin();
  }, [activeTab, userRole, userOwnerId]);

const handleAuth = async (e) => {
    e.preventDefault();
    const emailInput = e.target.email.value.trim();
    const password = e.target.password.value;
    
    // 📧 ปรับระบบการจัดการอีเมลให้เป็นสากล
    // ถ้าเป็น Merchant และใส่แค่เบอร์โทร (ไม่มี @) ระบบจะยังช่วยต่อท้ายให้เหมือนเดิมเพื่อความสะดวก
    // แต่ถ้าเป็น Partner เราจะใช้อีเมลที่เขากรอกมาโดยตรงเลยครับ
    let formattedEmail = emailInput;
    if (!emailInput.includes('@')) {
      const domain = authType === 'partner' ? '@partner.smartlabel.com' : '@smartlabel.com';
      formattedEmail = `${emailInput}${domain}`;
    }

    try {
      if (authMode === 'login') { 
        await signInWithEmailAndPassword(auth, formattedEmail, password); 
      } else {
        const userCredential = await createUserWithEmailAndPassword(auth, formattedEmail, password);
        const user = userCredential.user;
        
        if (authType === 'partner') {
           // 🔥 สร้างรหัสแนะนำ (Referral Code) สำหรับพาร์ทเนอร์
           const refCode = Math.random().toString(36).substring(2, 8).toUpperCase();
           const partnerName = e.target.partnerName.value;

           await setDoc(doc(db, "users", user.uid), { 
              email: formattedEmail, // เก็บอีเมลจริงที่ใช้สมัคร
              role: 'Affiliate', 
              ownerId: user.uid,
              name: partnerName, 
              phone: emailInput.includes('@') ? '' : emailInput, // ถ้าเขาใส่อีเมลมา ช่องเบอร์โทรจะว่างไว้ให้เขาไปเติมในโปรไฟล์ครับ
              referralCode: refCode,
              balance: 0, 
              totalEarned: 0, 
              referredCount: 0, 
              paymentInfo: '',
              createdAt: serverTimestamp() 
           });
           alert(`🎉 สมัครพาร์ทเนอร์สำเร็จ! รหัสแนะนำของคุณคือ: ${refCode}`);
        } else {
           const storeName = e.target.storeName.value;
           
           // ✅ บันทึกข้อมูล Owner (แม่ค้า)
           await setDoc(doc(db, "users", user.uid), { 
              email: formattedEmail, 
              role: 'Owner',           
              quota: 50,             
              usedQuota: 0,          
              plan: 'Free',          
              storeName: storeName, 
              ownerId: user.uid, 
              createdAt: serverTimestamp() 
           });

           const initialProfile = { name: storeName, phone: '', address: '' };
           setStoreProfile(initialProfile); 
           localStorage.setItem('smartlabel_profile', JSON.stringify(initialProfile));
           alert("🎉 สมัครสมาชิกสำเร็จ! รับโควต้าทดลองใช้ฟรี 50 จ่าหน้าครับ");
        }
      }
    } catch (error) { 
      console.error("Auth Error:", error);
      alert(authMode === 'login' ? "ข้อมูลเข้าสู่ระบบไม่ถูกต้องครับ" : "เกิดข้อผิดพลาด หรือไอดีนี้ถูกใช้งานแล้วครับ"); 
    }
  };

  const handleLogout = () => { 
    setActiveTab(userRole === 'SuperAdmin' ? 'shops' : 'maker'); 
    signOut(auth); 
  };

  const handleAddStaff = async (e) => {
    e.preventDefault();
    if (newStaff.phone.length !== 10) return alert("กรุณากรอกเบอร์โทรศัพท์ 10 หลักครับ");
    try {
      let secondaryApp; const appName = "SecondaryApp";
      if (getApps().find(a => a.name === appName)) { secondaryApp = getApps().find(a => a.name === appName); } 
      else { secondaryApp = initializeApp(auth.app.options, appName); }
      const secondaryAuth = getAuth(secondaryApp);
      const staffEmail = `${newStaff.phone}@smartlabel.com`;
      const userCredential = await createUserWithEmailAndPassword(secondaryAuth, staffEmail, '123456');
      const newUid = userCredential.user.uid;
      await setDoc(doc(db, "users", newUid), { email: staffEmail, name: newStaff.name, phone: newStaff.phone, role: newStaff.role, ownerId: userOwnerId, createdAt: serverTimestamp() });
      await signOut(secondaryAuth);
      alert(`เพิ่มพนักงานสำเร็จ! รหัสผ่านเริ่มต้นคือ: 123456`); setNewStaff({ name: '', phone: '', role: 'Staff' }); loadStaffData();
    } catch (error) { alert("เกิดข้อผิดพลาด หรือเบอร์โทรนี้ถูกใช้งานไปแล้วครับ"); }
  };

  const handleDeleteStaff = async (staffId) => {
    if(window.confirm("ต้องการลบพนักงานคนนี้ออกจากระบบใช่หรือไม่?")) {
      try { await deleteDoc(doc(db, "users", staffId)); loadStaffData(); } catch (error) { alert("ลบข้อมูลไม่สำเร็จครับ"); }
    }
  };

  const checkCustomerHistory = async (orderId, phone) => {
    if (!phone || phone.length < 9 || !userOwnerId) return;
    try {
      const q = query(collection(db, "orders"), where("phone", "==", phone));
      const querySnapshot = await getDocs(q);
      if (!querySnapshot.empty) {
        const historyData = []; 
        querySnapshot.forEach((doc) => { if(doc.data().ownerId === userOwnerId) { historyData.push(doc.data()); } });
        if(historyData.length > 0) {
            historyData.sort((a, b) => (b.createdAt?.toMillis() || 0) - (a.createdAt?.toMillis() || 0));
            setOrders(prev => prev.map(o => o.id === orderId ? { ...o, crmSuggestion: historyData[0] } : o));
        } else { setOrders(prev => prev.map(o => o.id === orderId ? { ...o, crmSuggestion: null } : o)); }
      } else { setOrders(prev => prev.map(o => o.id === orderId ? { ...o, crmSuggestion: null } : o)); }
    } catch (error) { console.error(error); }
  };

  const handleUseChat = async (chat) => {
    let text = chat.message;

    // --- 🧠 1. Smart Filter: คัดกรองข้อมูล ---
    const hasNumbers = /\d{5,}/.test(text); 
    const hasAddressKeywords = /(ต\.|อ\.|จ\.|ตำบล|อำเภอ|จังหวัด|หมู่|ม\.|ซอย|ถ\.)/.test(text);

    if (!hasNumbers && !hasAddressKeywords) {
      alert("ข้อความนี้ดูเหมือนจะเป็นแค่คำทักทาย หรือข้อมูลที่อยู่ไม่ครบถ้วนครับ 🕵️‍♂️");
      return; 
    }

    let cleanedText = text
      .replace(/สวัสดี(ครับ|ค่ะ)/g, "")
      .replace(/สั่ง(ของ|สินค้า)(หน่อย)?(ครับ|ค่ะ)/g, "")
      .replace(/สนใจ(ครับ|ค่ะ)/g, "")
      .replace(/มีของ(ไหม|มั้ย)(ครับ|ค่ะ)/g, "")
      .trim();

    // --- 🚀 2. ส่งข้อมูลไปช่องตรงกลาง ---
    if (orders && orders.length > 0) {
      handleTextChange(orders[0].id, cleanedText); 
    } else {
      console.warn("ยังไม่มีกล่องออเดอร์เปิดอยู่ครับ");
    }

    // 2.1 หาดูว่ามีกล่องออเดอร์ไหนที่ "ยังว่างอยู่" (ยังไม่มีข้อความ) บ้างไหม?
    const emptyOrder = orders.find(order => !order.rawText || order.rawText.trim() === '');

    if (emptyOrder) {
      // 2.2 ถ้าเจอกล่องว่าง ให้เอาที่อยู่ไปใส่กล่องนั้นเลย
      handleTextChange(emptyOrder.id, cleanedText); 
    } else {
      // 2.3 แต่ถ้าทุกกล่องมีข้อมูลเต็มหมดแล้ว... ให้สร้างกล่องใหม่เพิ่มต่อท้ายเลย!
      const newOrderId = Date.now(); // สร้าง ID ใหม่
      const newOrder = { 
        id: newOrderId, 
        rawText: cleanedText, // เอาที่อยู่ใส่เข้าไปเลย
        parsedData: null, 
        isSaved: false, 
        crmSuggestion: null 
      };
      
      // อัปเดต State โดยเอาของเก่าทั้งหมดมากาง แล้วเอาของใหม่ต่อท้าย
      setOrders(prevOrders => [...prevOrders, newOrder]);
      
      // *หมายเหตุ: ถ้าหน้าเว็บไม่ยอมดึงที่อยู่ไปสกัด (Parsed) อัตโนมัติ 
      // ท่าน CEO อาจจะต้องเรียกใช้ extractOrderData(cleanedText) เพิ่มเติมตรงนี้นะครับ
    }

    // --- 🧹 3. ซ่อนข้อความแชทเดิม ---
    try {
      await updateDoc(doc(db, "chats", chat.id), { status: "processed" });
    } catch (error) {
      console.error("Error updating chat status:", error);
    }
  };

  // 2. ฟังก์ชันใหม่: ซ่อนแชทขยะ (ไม่ใช่ที่อยู่)
  // 🗑️ ฟังก์ชันสำหรับปุ่ม ❌ ซ่อนข้อความขยะ
  const handleDismissChat = async (chatId) => {
    try {
      // เปลี่ยนสถานะในโกดัง Firebase เป็น "dismissed" (ถูกทิ้ง)
      await updateDoc(doc(db, "chats", chatId), { status: "dismissed" });
    } catch (error) {
      console.error("Error dismissing chat:", error);
      alert("เกิดข้อผิดพลาดในการซ่อนข้อความครับ");
    }
  };

// ♻️ ฟังก์ชันกู้คืนแชทกลับไปหน้าหลัก
  const handleRestoreChat = async (chatId) => {
    try {
      // แค่เปลี่ยนสถานะกลับเป็น new... แชทก็จะวิ่งกลับไปจอซ้ายทันที!
      await updateDoc(doc(db, "chats", chatId), { status: "new" });
      alert("ดึงข้อความกลับไปที่ Smart Inbox เรียบร้อยครับ! ✨");
    } catch (error) {
      console.error("Error restoring chat:", error);
    }
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
    setOrders(prev => prev.map(o => {
      if (o.id === orderId) {
        const newRawText = `${crmData.customerName}\n${crmData.address} ${crmData.zipcode}\n${o.rawText}`;
        return { ...o, rawText: newRawText, parsedData: extractOrderData(newRawText), crmSuggestion: null };
      }
      return o;
    }));
  };

  const handleDeleteOrder = (id) => {
    const remaining = orders.filter(o => o.id !== id);
    setOrders(remaining.length === 0 ? [{ id: Date.now(), rawText: '', parsedData: null, isSaved: false, crmSuggestion: null }] : remaining);
  };

  const handleFocus = (id) => { 
      if (labelRefs.current[id]) { labelRefs.current[id].scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  };

  const handleSaveProfile = async () => {
      try {
        if (!user) return;
        
        const userRef = doc(db, "users", user.uid);
        
        // 1. 💾 สั่งบันทึกลง Firebase (ดึงของจากตะกร้า tempProfile ไปเซฟ)
        await setDoc(userRef, {
          storeName: tempProfile.name,      // 👈 เปลี่ยนตรงนี้เป็น temp
          phone: tempProfile.phone,         // 👈 เปลี่ยนตรงนี้เป็น temp
          address: tempProfile.address,     // 👈 เปลี่ยนตรงนี้เป็น temp
          connectedPages: selectedPages, 
          updatedAt: serverTimestamp()
        }, { merge: true });

        // 2. 🔄 อัปเดตตะกร้าหลัก (เพื่อให้หน้าเว็บด้านหลังเปลี่ยนชื่อ/เบอร์ทันทีโดยไม่ต้อง F5)
        setStoreProfile(tempProfile);

        alert("บันทึกข้อมูลร้านค้าและตั้งค่าเพจสำเร็จเรียบร้อยครับ!");
        setIsSettingsOpen(false); // ปิดหน้าต่าง
      } catch (error) {
        console.error("Error saving profile:", error);
        alert("เกิดข้อผิดพลาดในการบันทึกข้อมูลครับ");
      }
    };

  const handleSaveAndPrint = async () => {
    // 1. กรองเอาเฉพาะออเดอร์ที่พร้อมเซฟ
    const readyToSaveOrders = orders.filter(o => o.parsedData && !o.isSaved && o.rawText.trim() !== '');
    
    if (userRole === 'Owner' && readyToSaveOrders.length > quota) { 
        setIsTopupOpen(true); 
        return; 
    }

    if (readyToSaveOrders.length > 0) {
      try {
        // สร้างอาเรย์ใหม่เพื่อเก็บออเดอร์ที่เติมเลขพัสดุแล้ว
        const ordersWithTracking = [];

        for (const order of readyToSaveOrders) {
          const autoTracking = await fetchMockTracking(); // 👈 เสกเลขพัสดุ
          const codNumber = order.parsedData.isCOD ? Number(order.parsedData.codAmount.replace(/,/g, '')) : 0;
          const staffName = user.email ? user.email.split('@')[0] : 'ไม่ระบุตัวตน';

          // เซฟลงฐานข้อมูล
          await addDoc(collection(db, "orders"), {
            ...order.parsedData, // กระจายข้อมูลที่ตัดคำไว้
            rawText: order.rawText, 
            adminEmail: user.email, 
            creatorName: staffName, 
            storeName: storeProfile.name || '', 
            customerName: order.parsedData.customerName || 'ไม่ระบุชื่อลูกค้า', 
            trackingNum: autoTracking, // ✅ บันทึกเลขพัสดุลง DB
            ownerId: userOwnerId, 
            createdAt: serverTimestamp() 
          });

          // เก็บเลขพัสดุใส่ตัวแปรชั่วคราวเพื่อส่งไปที่หน้าปรินต์
          ordersWithTracking.push({ ...order, trackingNum: autoTracking });
        }

        // 🚀 อัปเดต State หน้าจอ เพื่อให้เลขพัสดุโชว์บน "ใบจ่าหน้า" ทันที
        setOrders(ordersWithTracking);

        if (userRole === 'Owner') {
          const userRef = doc(db, "users", user.uid);
          await updateDoc(userRef, { quota: increment(-readyToSaveOrders.length), usedQuota: increment(readyToSaveOrders.length) });
          setQuota(prev => prev - readyToSaveOrders.length);
        }
        
      } catch (error) { 
        console.error("Save Error:", error);
        alert("เกิดข้อผิดพลาดในการบันทึกข้อมูลครับ"); 
        return;
      }
    }

    // 🕒 รอเสี้ยววินาทีให้ React วาดเลขพัสดุลงใบจ่าหน้าให้เสร็จก่อนสั่งพิมพ์
    setTimeout(() => {
      window.print();
      // ล้างหน้าจอหลังพิมพ์เสร็จ
      setOrders([{ id: Date.now(), rawText: '', parsedData: null, isSaved: false }]);
    }, 500);
  };

  // 🖨️ ฟังก์ชันสำหรับดึงข้อมูลเก่ากลับมาที่หน้า "สร้างจ่าหน้า"
  const handleReprint = (oldOrder) => {
    if (!oldOrder) return;

    // 🛡️ ฟังก์ชันผู้พิทักษ์: บังคับทุกอย่างให้เป็น String เสมอ ป้องกันหน้าจอขาว
    const safeStr = (val) => (val ? String(val) : '');

    const recoveredData = {
      customerName: (oldOrder.customerName && oldOrder.customerName !== 'ไม่ระบุชื่อลูกค้า') ? safeStr(oldOrder.customerName) : '',
      phone: safeStr(oldOrder.phone),
      address: safeStr(oldOrder.address),
      zipcode: safeStr(oldOrder.zipcode),
      province: '', 
      district: '', 
      subdistrict: '', 
      items: Array.isArray(oldOrder.items) ? oldOrder.items : [], 
      isCOD: Boolean(oldOrder.isCOD),
      codAmount: oldOrder.isCOD ? safeStr(oldOrder.codAmount) : '',
      warnings: [] // 👈 พระเอกขี่ม้าขาว! เติมตะกร้าคำเตือนเปล่าๆ เข้าไป ระบบจะได้หา .length เจอครับ!
    };

    // ส่งข้อมูลกลับไปที่กล่องสร้างจ่าหน้า
    setOrders([{ 
      id: Date.now(), 
      rawText: safeStr(oldOrder.rawText), 
      parsedData: recoveredData, 
      isSaved: false,
      crmSuggestion: null 
    }]);

    // เด้งกลับไปที่แท็บ 'maker'
    setActiveTab('maker'); 
    
    // ไม่ต้องมี alert แล้วก็ได้ครับ จะได้สไลด์ปรู๊ดไปเลยแบบสมูทๆ
  };

  const handleEditHistory = (order) => { setOrders([{ id: Date.now(), rawText: order.rawText || '', parsedData: extractOrderData(order.rawText || ''), isSaved: false, crmSuggestion: null }, { id: Date.now() + 1, rawText: '', parsedData: null, isSaved: false, crmSuggestion: null }]); setActiveTab('maker'); window.scrollTo(0, 0); };
  const handleReprintHistory = (order) => { setReprintOrder(order); setTimeout(() => { window.print(); setReprintOrder(null); }, 300); };
  
// 🔥 ระบบกรองข้อมูลอัจฉริยะ (กรองตามวันที่คลิก และ คำค้นหา)
  const filteredOrders = historyOrders.filter(order => {
    // 1. กรองตามวันที่กดจากกราฟแท่ง
    if (selectedDate) {
      const orderDate = order.createdAt?.toDate().toLocaleDateString('th-TH', { day: 'numeric', month: 'short' });
      if (orderDate !== selectedDate) return false;
    }
    // 2. กรองตามช่องค้นหา (ชื่อ, เบอร์, ปณ, Tracking)
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const trackRef = `REF-${order.id.slice(-6).toUpperCase()}`.toLowerCase();
      return (
        (order.customerName || '').toLowerCase().includes(q) ||
        (order.phone || '').includes(q) ||
        (order.zipcode || '').includes(q) ||
        trackRef.includes(q)
      );
    }
    return true;
  });

  const handleExportCSV = () => {
    if (filteredOrders.length === 0) return alert("ไม่มีข้อมูลให้ดาวน์โหลดครับ");
    const headers = ["วันที่สร้าง", "หมายเลขพัสดุ", "ชื่อผู้รับ", "เบอร์โทร", "ที่อยู่", "รหัสไปรษณีย์", "รายการสินค้า", "ยอด COD", "แอดมิน"];
    const csvRows = filteredOrders.map(order => [ 
      order.createdAt ? order.createdAt.toDate().toLocaleString('th-TH') : '-', 
      `REF-${order.id.slice(-6).toUpperCase()}`, 
      `"${order.customerName || ''}"`, 
      order.phone || '-', 
      `"${order.address || ''}"`, 
      order.zipcode || '-', 
      `"${(order.items || []).join(' | ')}"`, 
      order.isCOD ? order.codAmount : "0", 
      order.adminEmail || '-' 
    ].join(','));
    const blob = new Blob(["\uFEFF" + headers.join(',') + '\n' + csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a"); link.href = URL.createObjectURL(blob); 
    link.download = `SmartLabel_${selectedDate ? selectedDate.replace(/\//g, '-') : 'All'}.csv`; 
    link.click();
  };

  const handleImageUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setIsUploading(true);
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (event) => {
      const img = new Image();
      img.src = event.target.result;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const MAX_WIDTH = 500; 
        const scaleSize = MAX_WIDTH / img.width;
        canvas.width = MAX_WIDTH; canvas.height = img.height * scaleSize;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const base64Compressed = canvas.toDataURL('image/jpeg', 0.6); 
        setSlipImage(base64Compressed);
        setIsUploading(false);
      };
    };
  };

  // นำเข้า Timestamp จาก firebase/firestore ด้วยนะครับ (ถ้ายังไม่มี)
  // import { doc, getDoc, updateDoc, Timestamp } from "firebase/firestore";

  // 🚀 ฟังก์ชันส่งคำขอเติมเงิน (แบบใหม่: ส่งบิลไปรออนุมัติ)
  const handleSubmitTopup = async () => {
    if (!slipImage) return;
    
    setIsUploading(true);
    try {
      let amount = 0;
      let quotaToAdd = selectedPackage;

      // 1. ตรวจสอบยอดเงินตามแพ็กเกจที่เลือก
      if (selectedPackage === 100) amount = 50;
      else if (selectedPackage === 500) amount = 200;
      else if (selectedPackage === 10000) amount = 1000;

      // 2. สร้างใบคำขอ (Pending Request) ไปที่คอลเลกชัน topup_requests
      // แทนที่จะอัปเดตโควต้าตัวเองทันที เราจะส่งใบสั่งซื้อไปให้แอดมินตรวจครับ
      await addDoc(collection(db, "topup_requests"), {
        userId: user.uid,
        userEmail: user.email,
        amount: amount,
        package: selectedPackage,
        slipImage: slipImage, // URL รูปสลิปที่อัปโหลดแล้ว
        status: "pending",    // สถานะ: รอตรวจสอบ
        timestamp: serverTimestamp(),
        planRequested: amount === 1000 ? "Premium" : "Basic"
      });

      alert("🚀 ส่งหลักฐานการโอนเงินเรียบร้อยแล้ว! \nกรุณารอแอดมินตรวจสอบและอนุมัติโควต้าสักครู่นะครับ");
      
      // ปิดหน้าต่างและเคลียร์ค่า
      setIsTopupOpen(false);
      setSlipImage(null);
      setSelectedPackage(100); 

    } catch (error) {
      console.error("Error submitting topup request:", error);
      alert("เกิดข้อผิดพลาดในการส่งข้อมูลครับ กรุณาลองใหม่อีกครั้ง");
    } finally {
      setIsUploading(false);
    }
  };

  const handleApproveTopup = async (requestId, targetUserId, quotaToAdd, amount) => {
      try {
        // 1. ดึงข้อมูลผู้ใช้ที่จะเติมเงินให้
        const userRef = doc(db, "users", targetUserId);
        const userSnap = await getDoc(userRef);

        if (userSnap.exists()) {
          const userData = userSnap.data();
          let newQuota = (userData.quota || 0) + quotaToAdd;
          let newPlan = userData.plan || "Basic";
          
          let expireDate = userData.premiumExpireDate ? userData.premiumExpireDate.toDate() : new Date();
          const now = new Date();

          // 🟢 ถ้าเป็นยอด 1,000 บาท ให้เปิด/ต่ออายุ Premium
          if (amount === 1000) {
            newPlan = "Premium";
            if (expireDate > now) {
              expireDate.setDate(expireDate.getDate() + 30); // ทบวัน
            } else {
              expireDate = new Date();
              expireDate.setDate(expireDate.getDate() + 30); // เริ่มใหม่
            }
          }

          // 2. อัปเดตข้อมูลให้แม่ค้า (ผู้รับเงิน)
          await updateDoc(userRef, {
            quota: newQuota,
            plan: newPlan,
            premiumExpireDate: newPlan === "Premium" ? Timestamp.fromDate(expireDate) : (userData.premiumExpireDate || null)
          });

          // 3. เปลี่ยนสถานะบิลเป็น Approved เพื่อให้หายไปจากหน้าจอตรวจสอบ
          await updateDoc(doc(db, "topup_requests", requestId), {
            status: "approved",
            approvedAt: serverTimestamp(),
            approvedBy: user.email
          });

          alert("✅ อนุมัติยอดเงินและเติมโควต้าเรียบร้อยแล้วครับ!");
        }
      } catch (error) {
        console.error("Error approving topup:", error);
        alert("เกิดข้อผิดพลาดในการอนุมัติครับ");
      }
    };

  // 🔥 ฟังก์ชันกด "โอนเงินให้นักการตลาดแล้ว"
  const handleApproveWithdrawal = async (withdrawId) => {
    try {
      await updateDoc(doc(db, "withdrawals", withdrawId), { status: 'approved', approvedAt: serverTimestamp() });
      alert("✅ ยืนยันการโอนเงินให้นักการตลาดสำเร็จ!");
      loadAffiliateDataForAdmin();
    } catch(err) { alert("เกิดข้อผิดพลาด"); }
  };

  if (loading) return <div className="min-h-screen flex items-center justify-center bg-gray-100 font-bold text-blue-600 animate-pulse">กำลังโหลดระบบ...</div>;

  if (!user && !isAuthView) {
      return (
        <div className="min-h-screen bg-white font-sans text-gray-900 selection:bg-blue-200">
          <style>{`@keyframes float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-10px); } } .animate-float { animation: float 3s ease-in-out infinite; } .btn-cute { transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275); } .btn-cute:hover { transform: scale(1.05) translateY(-2px); box-shadow: 0 10px 20px -10px rgba(59, 130, 246, 0.5); } .card-hover { transition: transform 0.3s ease, box-shadow 0.3s ease; } .card-hover:hover { transform: translateY(-5px); box-shadow: 0 20px 30px -10px rgba(0,0,0,0.1); }`}</style>
          
          <nav className="flex justify-between items-center px-6 py-4 border-b">
            <div className="text-2xl font-black text-blue-800 flex items-center gap-2"><span className="animate-float inline-block">📦</span> SmartLabel</div>
            <div className="flex gap-4">
              <button onClick={() => { setIsAuthView(true); setAuthType('partner'); setAuthMode('login'); }} className="text-indigo-500 font-bold hover:underline flex items-center gap-1 hidden md:flex"><span>🤝</span> ร่วมเป็นพาร์ทเนอร์</button>
              <button onClick={() => setIsAuthView(true)} className="btn-cute bg-blue-600 text-white px-6 py-2 rounded-full font-bold">เข้าสู่ระบบ</button>
            </div>
          </nav>
          
          <header className="px-6 py-20 text-center bg-gradient-to-b from-blue-50 to-white">
            <h1 className="text-5xl md:text-7xl font-black text-blue-900 mb-6 leading-tight hover:scale-[1.01] transition-transform">จ่าหน้าพัสดุไวขึ้น 10 เท่า <br/> <span className="text-blue-600">ด้วยสมองกลอัจฉริยะ</span></h1>
            <p className="text-xl text-gray-600 mb-10 max-w-2xl mx-auto">สกัดชื่อที่อยู่จากแชทลูกค้าอัตโนมัติ พร้อมระบบจดจำลูกค้าเก่า (CRM) และสถิติครบวงจร เพื่อแม่ค้าออนไลน์มือโปรเช่นคุณ</p>
            {/* เปลี่ยนเป็นแจกฟรี 50 ใบ ใจป้ำๆ ครับ */}
            <button onClick={() => { setIsAuthView(true); setAuthMode('register'); }} className="btn-cute bg-blue-600 text-white text-xl px-12 py-4 rounded-full font-black shadow-xl animate-bounce mt-4">เริ่มทดลองใช้ฟรี 50 ใบ</button>
          </header>
          
          <section className="py-20 px-6 max-w-6xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-12">
            <div className="text-center group">
              <div className="text-6xl mb-4 group-hover:scale-125 group-hover:rotate-12 transition-transform duration-300 inline-block">🧠</div>
              <h3 className="text-xl font-bold mb-2">Smart CRM</h3>
              <p className="text-gray-500">พิมพ์แค่เบอร์โทร ข้อมูลชื่อและที่อยู่ลูกค้าเก่าเด้งขึ้นมาให้ทันที</p>
            </div>
            <div className="text-center group">
              <div className="text-6xl mb-4 group-hover:scale-125 group-hover:-translate-y-2 transition-transform duration-300 inline-block">🖨️</div>
              <h3 className="text-xl font-bold mb-2">Thermal Ready</h3>
              <p className="text-gray-500">ออกแบบมาเพื่อเครื่องพิมพ์ความร้อน พิมพ์ออกมาสวยเป๊ะทุกใบ</p>
            </div>
            <div className="text-center group">
              <div className="text-6xl mb-4 group-hover:scale-125 group-hover:rotate-[-12deg] transition-transform duration-300 inline-block">📊</div>
              <h3 className="text-xl font-bold mb-2">Dashboard & Export</h3>
              <p className="text-gray-500">ดูยอดส่งรายวัน และดาวน์โหลดข้อมูลเป็น Excel ได้ในคลิกเดียว</p>
            </div>
          </section>
          
          <section className="py-24 bg-slate-50 border-t border-slate-100">
            <div className="max-w-6xl mx-auto px-6 text-center">
              <h2 className="text-4xl font-black mb-12 text-slate-800">ราคาแพ็กเกจที่คุณเลือกได้</h2>
              {/* ปรับ Grid เป็น 3 คอลัมน์ สำหรับ 3 แพ็กเกจ */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-8 text-left">
                
                {/* แพ็กเกจ 50 บาท */}
                <div className="bg-white p-8 rounded-3xl shadow-lg border border-slate-200 card-hover flex flex-col justify-between">
                  <div>
                    <p className="text-slate-500 font-bold mb-4 tracking-widest uppercase text-sm">เริ่มต้นเบาๆ</p>
                    <p className="text-5xl font-black mb-4 text-slate-800">฿50</p>
                    <p className="text-slate-500 mb-6 font-medium">ได้รับ 100 จ่าหน้า <br/> <span className="text-sm">(เพียง 0.5 บาท/ใบ)</span></p>
                    <ul className="text-sm text-slate-600 mb-8 space-y-3">
                      <li className="flex items-center gap-2">✅ ใช้งานระบบจ่าหน้าปกติ</li>
                      <li className="flex items-center gap-2">✅ ระบบจดจำลูกค้าเก่า (CRM)</li>
                      <li className="flex items-center gap-2 opacity-40">❌ ระบบดูดแชท Facebook</li>
                      <li className="flex items-center gap-2 opacity-40">❌ AI สกัดที่อยู่อัตโนมัติ</li>
                    </ul>
                  </div>
                  <button onClick={() => { setIsAuthView(true); setAuthMode('register'); }} className="btn-cute w-full py-3 rounded-xl border-2 border-slate-300 text-slate-600 font-bold hover:bg-slate-50">เริ่มต้นใช้งาน</button>
                </div>

                {/* แพ็กเกจ 200 บาท */}
                <div className="bg-white p-8 rounded-3xl shadow-lg border border-slate-200 card-hover flex flex-col justify-between">
                  <div>
                    <p className="text-blue-600 font-bold mb-4 tracking-widest uppercase text-sm">ขายดี</p>
                    <p className="text-5xl font-black mb-4 text-slate-800">฿200</p>
                    <p className="text-slate-500 mb-6 font-medium">ได้รับ 500 จ่าหน้า <br/> <span className="text-sm">(เพียง 0.4 บาท/ใบ)</span></p>
                    <ul className="text-sm text-slate-600 mb-8 space-y-3">
                      <li className="flex items-center gap-2">✅ ใช้งานระบบจ่าหน้าปกติ</li>
                      <li className="flex items-center gap-2">✅ ระบบจดจำลูกค้าเก่า (CRM)</li>
                      <li className="flex items-center gap-2 opacity-40">❌ ระบบดูดแชท Facebook</li>
                      <li className="flex items-center gap-2 opacity-40">❌ AI สกัดที่อยู่อัตโนมัติ</li>
                    </ul>
                  </div>
                  <button onClick={() => { setIsAuthView(true); setAuthMode('register'); }} className="btn-cute w-full py-3 rounded-xl border-2 border-blue-600 text-blue-600 font-bold hover:bg-blue-50">เลือกแพ็กเกจนี้</button>
                </div>

                {/* 🔥 แพ็กเกจพรีเมียม 1,000 บาท (พระเอกของเรา) */}
                <div className="bg-gradient-to-b from-indigo-50 to-white p-8 rounded-3xl shadow-2xl border-4 border-indigo-600 relative overflow-hidden card-hover transform md:-translate-y-4 flex flex-col justify-between">
                  <div className="absolute top-0 right-0 bg-indigo-600 text-white px-6 py-2 font-black text-sm rounded-bl-2xl shadow-sm tracking-widest">พรีเมียม 💎</div>
                  <div>
                    <p className="text-indigo-600 font-bold mb-4 tracking-widest uppercase text-sm">คุ้มค่าที่สุด</p>
                    <div className="flex items-end gap-1 mb-4">
                      <p className="text-5xl font-black text-slate-800">฿1,000</p>
                      {/*<p className="text-lg text-slate-500 font-bold mb-1">/เดือน</p>*/}
                    </div>
                    <p className="text-slate-500 mb-6 font-medium">ได้รับ 10,000 จ่าหน้า 30 วัน(สะสมวันได้) <br/> <span className="text-sm">(คุ้มสุดๆ เพียง 0.10 บาท/ใบ)</span></p>
                    <ul className="text-sm text-indigo-900 mb-8 space-y-3 font-bold">
                      <li className="flex items-center gap-2">✨ ระบบดูดแชทเพจ Facebook</li>
                      <li className="flex items-center gap-2">⚡ AI สกัดที่อยู่อัตโนมัติ</li>
                      <li className="flex items-center gap-2">✅ ใช้งานระบบจ่าหน้าปกติ</li>
                      <li className="flex items-center gap-2">✅ ระบบจดจำลูกค้าเก่า (CRM)</li>
                    </ul>
                  </div>
                  <button onClick={() => { setIsAuthView(true); setAuthMode('register'); }} className="btn-cute w-full py-4 rounded-xl bg-indigo-600 text-white font-black shadow-lg shadow-indigo-500/40">อัปเกรดเป็น Premium</button>
                </div>

              </div>
              
              {/* ป้ายประกาศสำหรับขาใหญ่ 
              <div className="mt-16 text-slate-500 font-medium bg-white p-6 rounded-2xl shadow-sm border border-slate-200 inline-block">
                🚀 ส่งมากกว่า 10,000 ชิ้น/เดือน? เตรียมพบกับแพ็กเกจ <span className="font-black text-slate-800">Ultimate</span> เร็วๆ นี้! <button className="text-indigo-600 font-bold hover:underline ml-2">ติดต่อทีมงานเพื่อจองคิว</button>
              </div>*/}
            </div>
          </section>
          
          <footer className="py-12 bg-white border-t border-slate-100 flex flex-col items-center gap-4 text-slate-400 text-sm font-medium">
            <p>© 2026 ToppySmart Logistics. พัฒนาโดยพาร์ทเนอร์ & CTO Copilot</p>
            <button onClick={() => { setIsAuthView(true); setAuthType('partner'); setAuthMode('login'); }} className="text-indigo-500 font-bold hover:underline flex items-center gap-1">🤝 ระบบจัดการรายได้สำหรับนักการตลาด (Partner Login)</button>
          </footer>
        </div>
      );
    }

if (!user && isAuthView) {
    // 💡 เปลี่ยนเงื่อนไข: ถ้าเข้ามาโหมด "พาร์ทเนอร์" (ทั้งล็อกอินและลงทะเบียน) จะกางเป็น 2 คอลัมน์
    const isPartnerAuth = authType === 'partner';

    return (
      <div className={`min-h-screen flex flex-col items-center justify-center p-4 md:p-6 font-sans relative transition-colors duration-500 ${authType === 'partner' ? 'bg-indigo-900' : 'bg-blue-900'}`}>
        <style>{`.btn-cute { transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275); } .btn-cute:hover { transform: scale(1.05); }`}</style>
        <button onClick={() => setIsAuthView(false)} className="absolute top-6 left-6 text-white/50 hover:text-white font-bold transition hover:-translate-x-1">← กลับหน้าหลัก</button>

        {/* 📦 ปรับขนาดกล่อง: ถ้าเป็น Partner ให้ขยายกว้าง (max-w-4xl) ถ้าหน้าอื่นให้เล็กเหมือนเดิม (max-w-md) */}
        <div className={`bg-white rounded-3xl shadow-2xl w-full ${isPartnerAuth ? 'max-w-4xl flex flex-col md:flex-row overflow-hidden' : 'max-w-md p-8'} animate-[fadeIn_0.5s_ease-out]`}>

          {/* 🟠 แผงฝั่งซ้ายสีส้ม (โชว์ตลอดเมื่อเป็นโหมด Partner) */}
          {isPartnerAuth && (
            <div className="bg-gradient-to-br from-orange-400 to-orange-600 md:w-5/12 p-8 md:p-10 text-white flex flex-col justify-between hidden md:flex">
              <div>
                <div className="w-16 h-16 bg-white/20 rounded-2xl flex items-center justify-center text-3xl mb-8 shadow-sm backdrop-blur-sm">💰</div>
                <h2 className="text-3xl font-black mb-4 leading-tight">สร้างรายได้<br/>ไปกับ Smart Label</h2>
                <p className="text-orange-50 font-medium mb-8 leading-relaxed">รับค่าแนะนำ 10% ทุกรอบการชำระเงินของลูกค้า ตลอดชีพ!</p>

                <div className="space-y-4">
                  <div className="flex items-center gap-4 bg-black/10 p-3.5 rounded-xl transition hover:bg-black/20"><span className="text-2xl">🔗</span><span className="font-bold text-sm">รับลิงก์ส่วนตัวทันที</span></div>
                  <div className="flex items-center gap-4 bg-black/10 p-3.5 rounded-xl transition hover:bg-black/20"><span className="text-2xl">📊</span><span className="font-bold text-sm">ระบบหลังบ้านเช็คยอด Real-time</span></div>
                  <div className="flex items-center gap-4 bg-black/10 p-3.5 rounded-xl transition hover:bg-black/20"><span className="text-2xl">🏧</span><span className="font-bold text-sm">ถอนเงินไวผ่าน PromptPay</span></div>
                </div>
              </div>
              <div className="mt-12 text-xs font-black tracking-widest text-orange-200/80 uppercase">
                Toppy Smart Affiliate Program 2026
              </div>
            </div>
          )}

          {/* ⚪ แผงฝั่งขวา (โซนฟอร์มล็อกอิน/สมัครสมาชิกแบบดั้งเดิม) */}
          <div className={`${isPartnerAuth ? 'md:w-7/12 p-8 md:p-10 bg-white flex flex-col justify-center' : ''}`}>

            {/* Header ของฟอร์ม */}
            <div className="text-center mb-6">
              <h1 className={`text-4xl font-extrabold mb-2 flex justify-center items-center gap-2 ${authType === 'partner' ? 'text-indigo-600' : 'text-blue-800'}`}>
                {authType === 'partner' ? <><span className="animate-bounce inline-block">🤝</span> Partner</> : <><span className="animate-bounce inline-block">📦</span> SmartLabel</>}
              </h1>
              <p className="text-gray-500 font-bold">
                {authType === 'partner' ? (authMode === 'login' ? 'ระบบจัดการรายได้นักการตลาด' : 'สมัครเป็นพาร์ทเนอร์กับเรา') : (authMode === 'login' ? 'ยินดีต้อนรับกลับมา!' : 'เริ่มต้นความสำเร็จไปกับเรา')}
              </p>
            </div>

            <form onSubmit={handleAuth}>
              {/* ฟอร์มร้านค้า (Merchant) */}
              {authMode === 'register' && authType === 'merchant' && (
                <div className="mb-4">
                  <label className="block text-sm font-bold text-gray-700 mb-1">ชื่อร้านค้าของคุณ</label>
                  <input name="storeName" type="text" required className="w-full border p-3 rounded-xl focus:ring-4 focus:ring-blue-200 outline-none bg-gray-50 transition-all" placeholder="เช่น ToppySmart Shop" />
                </div>
              )}

              {/* ฟอร์มพาร์ทเนอร์ (เอาเฉพาะชื่อ-นามสกุลมาโชว์ตอนสมัคร) */}
              {authMode === 'register' && authType === 'partner' && (
                <div className="mb-4">
                  <label className="block text-sm font-bold text-gray-700 mb-1">ชื่อ-นามสกุล (พาร์ทเนอร์)</label>
                  <input name="partnerName" type="text" required className="w-full border p-3 rounded-xl focus:ring-4 focus:ring-indigo-200 outline-none bg-gray-50 transition-all" placeholder="เช่น นิชาภา สอนชา" />
                </div>
              )}

              {/* 📧 ช่องกรอกอีเมล (ใช้ร่วมกันหมด) */}
              <div className="mb-4">
                <label className="block text-sm font-bold text-gray-700 mb-1">
                  {authType === 'partner' ? 'อีเมลของคุณ (สำหรับรับค่าคอมมิชชัน)' : (authMode === 'login' ? 'อีเมล หรือ เบอร์โทรศัพท์' : 'อีเมลของคุณ')}
                </label>
                <input
                  name="email"
                  type="text"
                  required
                  className={`w-full border p-3 rounded-xl focus:ring-4 outline-none bg-gray-50 transition-all ${authType === 'partner' ? 'focus:ring-indigo-200' : 'focus:ring-blue-200'}`}
                  placeholder={authType === 'partner' ? "partner@mail.com" : (authMode === 'login' ? "เบอร์โทรศัพท์ หรือ อีเมล" : "owner@mail.com")}
                />
              </div>

              {/* 🔑 ช่องรหัสผ่าน พร้อมปุ่มลืมรหัสผ่าน */}
              <div className="mb-6">
                <div className="flex justify-between items-center mb-1">
                  <label className="block text-sm font-bold text-gray-700">รหัสผ่าน</label>
                  {authMode === 'login' && (
                    <button
                      type="button"
                      onClick={() => {
                        const emailInput = document.querySelector('input[name="email"]');
                        if (!emailInput || !emailInput.value || !emailInput.value.includes('@')) {
                          alert("⚠️ กรุณากรอก 'อีเมล' ของคุณในช่องด้านบน แล้วคลิก 'ลืมรหัสผ่าน' อีกครั้งครับ");
                          return;
                        }
                        import("firebase/auth").then(({ sendPasswordResetEmail }) => {
                          sendPasswordResetEmail(auth, emailInput.value)
                            .then(() => alert(`✅ ระบบได้ส่งลิงก์ตั้งรหัสผ่านใหม่ไปที่: ${emailInput.value} เรียบร้อยแล้วครับ!`))
                            .catch(() => alert("❌ ไม่พบที่อยู่อีเมลนี้ในระบบ กรุณาตรวจสอบอีกครั้งครับ"));
                        });
                      }}
                      className={`text-xs font-bold hover:underline ${authType === 'partner' ? 'text-indigo-500' : 'text-blue-500'}`}
                    >
                      ลืมรหัสผ่าน?
                    </button>
                  )}
                </div>
                <input
                  name="password"
                  type="password"
                  required
                  className={`w-full border p-3 rounded-xl focus:ring-4 outline-none bg-gray-50 transition-all ${authType === 'partner' ? 'focus:ring-indigo-200' : 'focus:ring-blue-200'}`}
                  placeholder="••••••••"
                />
              </div>

              {/* ปุ่ม Submit */}
              <button type="submit" className={`btn-cute w-full text-white font-bold py-3.5 rounded-xl shadow-lg ${authType === 'partner' ? 'bg-indigo-600 hover:shadow-indigo-500/50' : 'bg-blue-600 hover:shadow-blue-500/50'}`}>
                {authMode === 'login' ? 'เข้าสู่ระบบ' : '✨ สมัครสมาชิกฟรี'}
              </button>
            </form>

            {/* ส่วน Footer */}
            <div className="mt-6 text-center border-t border-gray-100 pt-6">
              {authMode === 'login' ? (
                <p className="text-sm text-gray-600">
                  {authType === 'partner' ? 'พาร์ทเนอร์ใหม่?' : 'เจ้าของร้านคนใหม่?'} <button onClick={() => setAuthMode('register')} className={`font-bold hover:underline ${authType === 'partner' ? 'text-indigo-600' : 'text-blue-600'}`}>ลงทะเบียนที่นี่</button>
                </p>
              ) : (
                <p className="text-sm text-gray-600">
                  มีบัญชีอยู่แล้ว? <button onClick={() => setAuthMode('login')} className={`font-bold hover:underline ${authType === 'partner' ? 'text-indigo-600' : 'text-blue-600'}`}>เข้าสู่ระบบ</button>
                </p>
              )}
              {authType === 'partner' && (
                <button type="button" onClick={() => { setAuthType('merchant'); setAuthMode('login'); }} className="mt-5 text-xs font-medium text-slate-400 hover:text-slate-600 underline">กลับหน้าล็อกอินร้านค้าปกติ</button>
              )}
            </div>

          </div>
        </div>
      </div>
    );
  }

  if (reprintOrder) {
    return (
      <div className="bg-white min-h-screen">
        <style>{`@media print { @page { size: 100mm 150mm; margin: 0; } body, html { background-color: white; margin: 0; padding: 0; -webkit-print-color-adjust: exact; } .thermal-label { width: 100mm !important; min-height: 148mm !important; height: auto !important; padding: 5mm !important; box-sizing: border-box !important; margin: 0 !important; border: none !important; box-shadow: none !important; page-break-after: always; page-break-inside: avoid; } }`}</style>
        <div className="w-full max-w-sm mx-auto p-4 thermal-label print:max-w-none print:m-0 print:p-2">
           <div className="flex justify-between border-b pb-2 mb-2 font-bold text-sm"><span>SmartLabel ✅</span><span className="text-gray-500">Admin: {reprintOrder.adminEmail?.split('@')[0]}</span></div>
           <div className="mb-3"><p className="text-xs text-gray-500">ผู้ส่ง:</p><p className="font-bold text-sm">{reprintOrder.storeName}</p></div>
           {reprintOrder.isCOD && <div className="bg-black text-white text-center py-2 mb-2 text-2xl font-bold">COD: {reprintOrder.codAmount}</div>}
           <div className="bg-gray-100 p-2 mb-2 print:bg-white print:border"><p className="text-xs text-blue-600 font-bold">ผู้รับ:</p><p className="text-xl font-bold">{reprintOrder.customerName || 'ไม่มีชื่อผู้รับ'}</p><p className="text-lg font-bold">☎ {reprintOrder.phone || '-'}</p><p className="text-sm leading-tight">{reprintOrder.address || 'ไม่มีที่อยู่'}</p></div>
           <div className="text-center text-4xl font-black mb-3 tracking-widest">{reprintOrder.zipcode || '00000'}</div>
           <div className="flex flex-col items-center border-t border-b py-2 mb-2">
             <QRCodeSVG value={JSON.stringify({ id: reprintOrder.id, cod: reprintOrder.isCOD ? reprintOrder.codAmount : 0 })} size={60} />
             <p className="text-[10px] mt-1 font-mono uppercase font-bold text-slate-500 tracking-widest">REF: #{String(reprintOrder.id).slice(-6)}</p>
           </div>
           <div><p className="text-xs font-bold">รายการสินค้า:</p>{reprintOrder.items && reprintOrder.items.length > 0 ? (<ul className="text-[10px] list-disc pl-4 mt-1 leading-tight">{reprintOrder.items.map((item, index) => <li key={index}>{item}</li>)}</ul>) : (<p className="text-[10px] text-gray-500 italic mt-1">- ไม่ระบุรายการ -</p>)}</div>
        </div>
      </div>
    );
  }
  // --- Affiliate Partner Dashboard ---
  const handleWithdrawRequest = async (e) => {
     e.preventDefault();
     const promptpay = e.target.promptpay.value;
     const amount = parseFloat(e.target.amount.value);
     if(amount < 100) return alert("ขั้นต่ำในการถอน 100 บาทครับ");
     if(amount > affiliateData.balance) return alert("ยอดเงินในบัญชีไม่พอครับ");

     try {
       await addDoc(collection(db, "withdrawals"), {
          affiliateId: user.uid, affiliateName: affiliateData.name, paymentInfo: promptpay,
          amount: amount, status: 'pending', createdAt: serverTimestamp()
       });
       // ตัดยอด balance ใน users
       await updateDoc(doc(db, "users", user.uid), { balance: increment(-amount) });
       setAffiliateData(prev => ({...prev, balance: prev.balance - amount}));
       alert("ส่งคำขอถอนเงินสำเร็จ! กรุณารอแอดมินตรวจสอบครับ");
       
       // โหลดประวัติใหม่
       const qW = query(collection(db, "withdrawals"), where("affiliateId", "==", user.uid));
       const snap = await getDocs(qW);
       const wList = []; snap.forEach(d => wList.push({id: d.id, ...d.data()}));
       setWithdrawalHistory(wList.sort((a,b) => b.createdAt?.toMillis() - a.createdAt?.toMillis()));
       e.target.reset();
     } catch (error) { alert("เกิดข้อผิดพลาดในการแจ้งถอนเงิน"); }
  };

  if (userRole === 'Affiliate' && affiliateData) {
    const refLink = `${window.location.origin}/?ref=${affiliateData.referralCode}`;
    const adText = `📦 จบปัญหาหลังบ้านร้านค้าออนไลน์ที่วุ่นวาย! ด้วย SmartLabel ระบบสร้างจ่าหน้าอัจฉริยะ\n✅ ดึงชื่อที่อยู่จากแชทอัตโนมัติ\n✅ จำลูกค้าเก่า (CRM) ไม่ต้องพิมพ์ใหม่\n✅ โหลดไฟล์ Excel ทำบัญชีได้ทันที\n🎁 สมัครวันนี้ รับโควต้าจ่าหน้าฟรี 50 ใบ!\n👉 สมัครเลย: ${refLink}`;

    return (
      <div className="min-h-screen bg-slate-50 p-6 font-sans">
        <header className="flex justify-between items-center bg-white p-5 rounded-2xl shadow-sm border border-slate-100 mb-6">
          <h1 className="text-2xl font-black text-indigo-600 flex items-center gap-2">🤝 Partner Dashboard</h1>
          <div className="flex items-center gap-4">
            <span className="text-sm font-bold text-slate-600">ID: <span className="text-indigo-600 bg-indigo-50 px-2 py-1 rounded">{affiliateData.referralCode}</span></span>
            <button onClick={() => { setActiveTab('maker'); signOut(auth); }} className="btn-cute bg-rose-50 text-rose-600 px-5 py-2 rounded-xl font-bold text-sm hover:bg-rose-100">ออก 🚪</button>
          </div>
        </header>

        <div className="bg-orange-500 text-white p-4 rounded-2xl shadow-md mb-6 text-center font-bold text-lg">
          💰 พื้นที่สำหรับการตลาด (Affiliate Partner)
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
           <div className="bg-gradient-to-br from-orange-500 to-orange-600 p-8 rounded-3xl shadow-lg text-white relative overflow-hidden">
             <div className="absolute -right-6 -bottom-6 text-8xl opacity-20">💸</div>
             <p className="font-bold text-orange-100 mb-2">ยอดเงินที่ถอนได้ (Balance)</p>
             <p className="text-5xl font-black">{affiliateData.balance.toLocaleString()} <span className="text-xl">THB</span></p>
           </div>
           <div className="bg-white p-8 rounded-3xl shadow-sm border border-slate-100 flex flex-col justify-center">
             <p className="font-bold text-slate-500 mb-2">รายได้สะสมตลอดกาล (Total Earned)</p>
             <p className="text-4xl font-black text-slate-800 mb-2">{affiliateData.totalEarned.toLocaleString()} <span className="text-xl">THB</span></p>
             <p className="text-sm font-bold text-emerald-600 bg-emerald-50 px-3 py-1 rounded-lg inline-block self-start">✨ แนะนำสำเร็จแล้ว: {affiliateData.referredCount} ร้านค้า</p>
           </div>
        </div>

        <div className="bg-white p-8 rounded-3xl shadow-sm border border-slate-100 mb-6">
           <h2 className="text-xl font-black text-slate-800 mb-6 flex items-center gap-2">🎯 อาวุธสำหรับการตลาด</h2>
           
           <div className="mb-6">
              <p className="font-bold text-slate-700 mb-2">1. ลิงก์แนะนำส่วนตัวของคุณ (รหัสลับ: <span className="text-indigo-600">{affiliateData.referralCode}</span>)</p>
              <div className="flex gap-2">
                 <input type="text" readOnly value={refLink} className="flex-1 border border-slate-200 bg-slate-50 p-3 rounded-xl text-slate-600 font-mono text-sm outline-none" />
                 <button onClick={() => copyToClipboard(refLink)} className="btn-cute bg-indigo-600 text-white font-bold px-6 rounded-xl shadow-md hover:bg-indigo-700">📋 คัดลอกลิงก์</button>
              </div>
           </div>

           <div>
              <p className="font-bold text-slate-700 mb-2">2. ไอเดียข้อความโพสต์ Facebook / Line</p>
              <div className="bg-yellow-50/50 border border-yellow-200 p-5 rounded-2xl relative">
                 <pre className="text-sm text-slate-700 font-sans whitespace-pre-wrap">{adText}</pre>
                 <button onClick={() => copyToClipboard(adText)} className="btn-cute mt-4 bg-orange-500 text-white font-bold px-4 py-2 rounded-lg text-sm shadow-md hover:bg-orange-600">📋 คัดลอกข้อความ</button>
              </div>
           </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
           <div className="bg-white p-8 rounded-3xl shadow-sm border border-slate-100">
             <h2 className="text-xl font-black text-slate-800 mb-6 flex items-center gap-2">🏦 แจ้งถอนเงินเข้าบัญชี</h2>
             <form onSubmit={handleWithdrawRequest}>
                <div className="mb-4">
                  <label className="block text-sm font-bold text-slate-700 mb-2">เบอร์พร้อมเพย์ หรือ เลขบัญชีธนาคาร</label>
                  <input name="promptpay" type="text" required className="w-full border p-3 rounded-xl focus:ring-4 focus:ring-orange-100 outline-none transition-all bg-slate-50 focus:bg-white" placeholder="เช่น 0891234567 (กสิกรไทย)" />
                </div>
                <div className="mb-6">
                  <label className="block text-sm font-bold text-slate-700 mb-2">ยอดเงินที่ต้องการถอน (ขั้นต่ำ 100 บาท)</label>
                  <input name="amount" type="number" required min="100" max={affiliateData.balance} className="w-full border p-3 rounded-xl focus:ring-4 focus:ring-orange-100 outline-none transition-all bg-slate-50 focus:bg-white" placeholder="0.00" />
                </div>
                <button type="submit" className="btn-cute w-full bg-slate-800 text-white font-black py-4 rounded-xl shadow-lg hover:bg-slate-900 transition-colors">🚀 แจ้งถอนเงิน</button>
             </form>
           </div>
           
           <div className="bg-white p-8 rounded-3xl shadow-sm border border-slate-100">
             <h2 className="text-xl font-black text-slate-800 mb-6 flex items-center gap-2">📄 ประวัติการถอนเงิน</h2>
             <div className="overflow-hidden border border-slate-100 rounded-2xl max-h-64 overflow-y-auto">
               <table className="w-full text-sm text-left">
                 <thead className="bg-slate-50 text-xs font-bold text-slate-500"><tr><th className="py-3 px-4">วันที่</th><th className="py-3 px-4 text-right">ยอดเงิน</th><th className="py-3 px-4 text-center">สถานะ</th></tr></thead>
                 <tbody>
                   {withdrawalHistory.length === 0 ? (
                     <tr><td colSpan="3" className="text-center py-8 text-slate-400">ยังไม่มีประวัติการแจ้งถอนเงิน</td></tr>
                   ) : (
                     withdrawalHistory.map((item, idx) => (
                       <tr key={idx} className="border-t border-slate-50">
                         <td className="py-3 px-4 text-slate-500 text-xs">{item.createdAt ? item.createdAt.toDate().toLocaleDateString('th-TH') : '-'}</td>
                         <td className="py-3 px-4 text-right font-black text-slate-700">฿{item.amount.toLocaleString()}</td>
                         <td className="py-3 px-4 text-center">
                           <span className={`px-2 py-1 rounded text-[10px] font-bold ${item.status === 'approved' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>{item.status === 'approved' ? 'โอนแล้ว' : 'รอตรวจสอบ'}</span>
                         </td>
                       </tr>
                     ))
                   )}
                 </tbody>
               </table>
             </div>
           </div>
        </div>
      </div>
    );
  }
  return (
    <div className="min-h-screen bg-slate-50 p-6 font-sans print:bg-white print:p-0 relative">
      <style>{`
        @media print { @page { size: 100mm 150mm; margin: 0; } body, html { background-color: white; margin: 0; padding: 0; -webkit-print-color-adjust: exact; } ::-webkit-scrollbar { display: none; } .thermal-label { width: 100mm !important; min-height: 148mm !important; height: auto !important; padding: 5mm !important; box-sizing: border-box !important; page-break-after: always !important; page-break-inside: avoid !important; margin: 0 !important; border: none !important; box-shadow: none !important; } }
        .btn-cute { transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275); }
        .btn-cute:hover { transform: scale(1.05) translateY(-2px); box-shadow: 0 5px 15px -5px rgba(0,0,0,0.2); }
        .card-hover { transition: transform 0.3s ease, box-shadow 0.3s ease; }
        .card-hover:hover { transform: translateY(-5px); box-shadow: 0 10px 25px -5px rgba(0,0,0,0.1); }
        .modal-enter { animation: fadeIn 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
        @keyframes fadeIn { from { opacity: 0; transform: scale(0.95) translateY(10px); } to { opacity: 1; transform: scale(1) translateY(0); } }
      `}</style>

      {/* 🔥 The "WOW" Onboarding Tutorial */}
      {showTutorial && (
        <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-sm flex items-center justify-center z-[100] print:hidden">
          <div className="bg-white rounded-3xl shadow-2xl p-8 max-w-lg w-full text-center modal-enter relative overflow-hidden">
            {/* วงกลมตกแต่งฉากหลัง */}
            <div className="absolute -top-20 -right-20 w-40 h-40 bg-blue-100 rounded-full blur-2xl opacity-50 pointer-events-none"></div>
            <div className="absolute -bottom-20 -left-20 w-40 h-40 bg-indigo-100 rounded-full blur-2xl opacity-50 pointer-events-none"></div>
            
            {/* เนื้อหาคู่มือ */}
            <div className="relative z-10 min-h-[250px] flex flex-col items-center justify-center">
              {tutorialStep === 0 && (
                <div className="animate-[fadeIn_0.3s_ease-out]">
                  <div className="text-7xl mb-4 animate-bounce">⚙️</div>
                  <h3 className="text-2xl font-black text-slate-800 mb-3">1. ตั้งค่าร้านค้าให้เป๊ะ!</h3>
                  <p className="text-slate-600 font-medium leading-relaxed">เริ่มต้นด้วยการกดปุ่ม <span className="font-bold text-blue-600">"ตั้งค่าร้าน"</span> (มุมขวาบน) เพื่อใส่ชื่อ เบอร์โทร และที่อยู่ของคุณให้ครบถ้วน เพื่อให้ไปแสดงบนใบจ่าหน้าอย่างสวยงาม</p>
                </div>
              )}
              {tutorialStep === 1 && (
                <div className="animate-[fadeIn_0.3s_ease-out]">
                  <div className="text-7xl mb-4 hover:scale-110 transition-transform">👥</div>
                  <h3 className="text-2xl font-black text-slate-800 mb-3">2. สร้างทีมงานแพ็กของ</h3>
                  <p className="text-slate-600 font-medium leading-relaxed">ไปที่แท็บ <span className="font-bold text-blue-600">"พนักงาน"</span> เพื่อเพิ่มลูกน้องเข้าสู่ระบบ พวกเขาจะล็อกอินด้วยเบอร์โทรได้ทันที โดยไม่เห็นข้อมูลโควต้าและการเงินของร้าน!</p>
                </div>
              )}
              {tutorialStep === 2 && (
                <div className="animate-[fadeIn_0.3s_ease-out]">
                  <div className="text-7xl mb-4">✍️</div>
                  <h3 className="text-2xl font-black text-slate-800 mb-3">3. วางแชท สกัดจ่าหน้า</h3>
                  <p className="text-slate-600 font-medium leading-relaxed">ก๊อปปี้ที่อยู่ลูกค้ามาวาง ระบบจะแยกชื่อ เบอร์โทร และรหัสไปรษณีย์ให้อัตโนมัติ <br/><span className="text-rose-500 font-bold">อย่าลืม!</span> ตรวจสอบความถูกต้องก่อนกดบันทึกและสั่งพิมพ์นะ</p>
                </div>
              )}
              {tutorialStep === 3 && (
                <div className="animate-[fadeIn_0.3s_ease-out]">
                  <div className="text-7xl mb-4 animate-float">🚀</div>
                  <h3 className="text-2xl font-black text-slate-800 mb-3">4. โควต้าหมด? เติมได้เลย</h3>
                  <p className="text-slate-600 font-medium leading-relaxed">ถ้าจ่าหน้าใกล้หมด กดปุ่ม <span className="font-bold text-indigo-600">"+ เติมโควต้า"</span> สแกนจ่ายผ่านคิวอาร์โค้ด แล้วอัปโหลดรูปสลิปส่งให้แอดมินอนุมัติได้ง่ายๆ ไม่กี่วินาที</p>
                </div>
              )}
              {tutorialStep === 4 && (
                <div className="animate-[fadeIn_0.3s_ease-out]">
                  <div className="text-7xl mb-4">📊</div>
                  <h3 className="text-2xl font-black text-slate-800 mb-3">5. วิเคราะห์ยอดขาย</h3>
                  <p className="text-slate-600 font-medium leading-relaxed">เช็คสถิติการส่ง แยกยอดโอนและยอด COD รายวันได้ที่แท็บ <span className="font-bold text-blue-600">"สถิติ"</span> พร้อมดาวน์โหลดประวัติเป็น Excel ไปทำบัญชีต่อได้ทันที</p>
                </div>
              )}
            </div>

            {/* จุดบอกสถานะ (Dots) */}
            <div className="flex justify-center gap-2 mt-6 mb-8">
              {[0, 1, 2, 3, 4].map((step) => (
                <div key={step} className={`w-2.5 h-2.5 rounded-full transition-colors ${tutorialStep === step ? 'bg-blue-600 w-6' : 'bg-slate-200'}`}></div>
              ))}
            </div>

            {/* ปุ่มควบคุม */}
            <div className="flex justify-between gap-4">
              <button 
                onClick={() => setTutorialStep(prev => Math.max(0, prev - 1))} 
                className={`px-6 py-3 rounded-xl font-bold transition-opacity ${tutorialStep === 0 ? 'opacity-0 cursor-default' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
                disabled={tutorialStep === 0}
              >
                ย้อนกลับ
              </button>
              
              {tutorialStep < 4 ? (
                <button 
                  onClick={() => setTutorialStep(prev => prev + 1)} 
                  className="flex-1 bg-blue-600 text-white px-6 py-3 rounded-xl font-bold shadow-lg shadow-blue-500/30 hover:bg-blue-700 transition-transform active:scale-95"
                >
                  ถัดไป 👉
                </button>
              ) : (
                <button 
                  onClick={() => {
                    localStorage.setItem(`has_seen_tutorial_${user.uid}`, 'true');
                    setShowTutorial(false);
                    setIsSettingsOpen(true); // 🔥 ปิดคู่มือปุ๊บ บังคับเด้งหน้าตั้งค่าร้านทันที!
                  }} 
                  className="flex-1 bg-emerald-500 text-white px-6 py-3 rounded-xl font-black shadow-lg shadow-emerald-500/30 hover:bg-emerald-600 transition-transform active:scale-95 animate-pulse"
                >
                  เริ่มลุยกันเลย! 🎉
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      
      {isTopupOpen && (
        <div className="fixed inset-0 bg-slate-900/70 backdrop-blur-md flex items-center justify-center z-50 print:hidden transition-opacity">
          <div className="bg-white p-8 rounded-3xl shadow-2xl w-full max-w-lg modal-enter max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-2xl font-black text-slate-800 flex items-center gap-2">🚀 เติมแพ็กเกจจ่าหน้า</h2>
              <button onClick={() => { setIsTopupOpen(false); setSlipImage(null); }} className="text-gray-400 hover:text-rose-500 hover:rotate-90 transition-transform font-bold text-2xl">&times;</button>
            </div>
            
            <div className="bg-gradient-to-r from-indigo-50 to-blue-50 border border-indigo-100 p-4 rounded-2xl mb-6 text-center card-hover">
              <p className="text-indigo-600 font-medium mb-1">โควต้าปัจจุบันของคุณ</p>
              <p className="text-4xl font-extrabold text-indigo-700">{quota} <span className="text-lg font-normal">ใบ</span></p>
            </div>

            <h3 className="font-bold text-slate-700 mb-3 flex items-center gap-2"><span className="bg-blue-600 text-white w-6 h-6 rounded-full flex items-center justify-center text-xs">1</span> เลือกแพ็กเกจสุดคุ้ม</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
              {/* แพ็กเกจ 100 ใบ */}
              <div onClick={() => setSelectedPackage(100)} className={`border-2 rounded-2xl p-4 text-center cursor-pointer relative transition-all ${selectedPackage === 100 ? 'border-slate-500 bg-slate-50 scale-[1.03] shadow-md shadow-slate-500/20' : 'border-gray-200 hover:border-slate-300 hover:bg-slate-50'}`}>
                {selectedPackage === 100 && <div className="absolute top-0 right-0 bg-slate-500 text-white text-[10px] font-bold px-3 py-1 rounded-bl-xl">เลือกอยู่</div>}
                <p className={`font-black text-xl ${selectedPackage === 100 ? 'text-slate-700' : 'text-slate-700'}`}>100 ใบ</p>
                <p className="text-xs text-slate-500 mt-1 font-medium">50 บาท</p>
              </div>
              
              {/* แพ็กเกจ 500 ใบ */}
              <div onClick={() => setSelectedPackage(500)} className={`border-2 rounded-2xl p-4 text-center cursor-pointer relative transition-all ${selectedPackage === 500 ? 'border-blue-500 bg-blue-50 scale-[1.03] shadow-md shadow-blue-500/20' : 'border-gray-200 hover:border-blue-300 hover:bg-slate-50'}`}>
                {selectedPackage === 500 && <div className="absolute top-0 right-0 bg-blue-500 text-white text-[10px] font-bold px-3 py-1 rounded-bl-xl">ยอดฮิต 🔥</div>}
                <p className={`font-black text-xl ${selectedPackage === 500 ? 'text-blue-700' : 'text-slate-700'}`}>500 ใบ</p>
                <p className="text-xs text-slate-500 mt-1 font-medium">200 บาท</p>
              </div>

              {/* 💎 แพ็กเกจ Premium 10,000 ใบ */}
              <div onClick={() => setSelectedPackage(10000)} className={`border-2 rounded-2xl p-4 text-center cursor-pointer relative transition-all ${selectedPackage === 10000 ? 'border-indigo-500 bg-indigo-50 scale-[1.03] shadow-md shadow-indigo-500/20' : 'border-gray-200 hover:border-indigo-300 hover:bg-indigo-50'}`}>
                {selectedPackage === 10000 && <div className="absolute top-0 right-0 bg-indigo-600 text-white text-[10px] font-bold px-3 py-1 rounded-bl-xl">พรีเมียม 💎</div>}
                <p className={`font-black text-xl ${selectedPackage === 10000 ? 'text-indigo-700' : 'text-slate-700'}`}>10,000 ใบ</p>
                <p className="text-xs text-indigo-600 mt-1 font-black">+ ดูดแชท 30 วัน</p>
                <p className="text-xs text-indigo-600 mt-1 font-black">1,000 บาท</p>
              </div>
            </div>

            <h3 className="font-bold text-slate-700 mb-3 flex items-center gap-2"><span className="bg-blue-600 text-white w-6 h-6 rounded-full flex items-center justify-center text-xs">2</span> สแกน QR ชำระเงิน</h3>
              <div className="flex flex-col items-center bg-slate-50 p-5 rounded-2xl border border-slate-200 mb-6">
              <div className="bg-white p-3 rounded-xl shadow-sm mb-3 border border-slate-100">
                {/* 🎯 สลับยอดเงิน QR Code ให้ตรงกับ 3 แพ็กเกจ */}
                <QRCodeSVG 
                  value={generatePayload("0874484448", { amount: selectedPackage === 100 ? 50 : selectedPackage === 500 ? 200 : 1000 })} 
                  size={130} 
                />
              </div>
              <p className="text-sm font-black text-slate-800">พร้อมเพย์: ท็อปปี้สมาร์ท โลจิสติกส์</p>
              <p className="text-lg font-black text-emerald-600 mt-1 bg-emerald-50 px-4 py-1 rounded-full border border-emerald-100">
                {/* 🎯 สลับข้อความยอดชำระให้ตรงกัน */}
                ยอดชำระ: ฿{selectedPackage === 100 ? '50.00' : selectedPackage === 500 ? '200.00' : '1,000.00'}
              </p>
            </div>

            {/* ส่วนอัปโหลดสลิป ปล่อยไว้เหมือนเดิมครับ */}
            <h3 className="font-bold text-slate-700 mb-3 flex items-center gap-2"><span className="bg-blue-600 text-white w-6 h-6 rounded-full flex items-center justify-center text-xs">3</span> แนบหลักฐานการโอนเงิน</h3>
            <div className="mb-8">
              {slipImage ? (
                <div className="relative rounded-2xl overflow-hidden border-2 border-emerald-500 group">
                  <img src={slipImage} alt="Slip" className="w-full h-48 object-cover" />
                  <div className="absolute inset-0 bg-black/50 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onClick={() => setSlipImage(null)} className="btn-cute bg-white text-rose-600 font-bold px-4 py-2 rounded-lg text-sm">เปลี่ยนรูปภาพ</button>
                  </div>
                </div>
              ) : (
                <label className="flex flex-col items-center justify-center w-full h-32 border-2 border-dashed border-blue-300 rounded-2xl cursor-pointer bg-blue-50/50 hover:bg-blue-50 transition-colors group">
                  <div className="flex flex-col items-center justify-center pt-5 pb-6">
                    <span className="text-3xl mb-2 group-hover:scale-125 transition-transform">📸</span>
                    <p className="mb-1 text-sm text-blue-600 font-bold"><span className="underline">คลิกที่นี่</span> เพื่อเลือกรูปสลิป</p>
                    <p className="text-xs text-slate-400">รองรับไฟล์ JPG, PNG</p>
                  </div>
                  <input type="file" className="hidden" accept="image/*" onChange={handleImageUpload} />
                </label>
              )}
              {isUploading && <p className="text-center text-xs text-blue-500 font-bold mt-2 animate-pulse">กำลังประมวลผลรูปภาพ...</p>}
            </div>

            <button onClick={handleSubmitTopup} disabled={!slipImage || isUploading} className={`btn-cute w-full font-bold py-4 rounded-xl shadow-lg text-lg flex justify-center items-center gap-2 ${(!slipImage || isUploading) ? 'bg-slate-300 text-slate-500 cursor-not-allowed shadow-none' : 'bg-blue-600 text-white shadow-blue-500/30 hover:bg-blue-700'}`}>
              🚀 ยืนยันการชำระเงิน
            </button>
          </div>
        </div>
      )}

      {/* Header Panel */}
      {isSettingsOpen && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-50 print:hidden">
          <div className="bg-white p-8 rounded-3xl shadow-2xl w-full max-w-md animate-[fadeIn_0.3s_ease-out]" style={{ maxHeight: '90vh', overflowY: 'auto' }}>
            <h2 className="text-2xl font-bold mb-6 text-gray-800">⚙️ ตั้งค่าข้อมูลร้านค้า</h2>
            <div className="mb-4">
              <label className="block text-sm font-bold text-gray-700 mb-2">ชื่อร้านค้า (ผู้ส่ง)</label>
              <input type="text" className="w-full border p-3 rounded-xl focus:ring-4 focus:ring-blue-100 outline-none transition-all" value={tempProfile.name} onChange={(e) => setTempProfile({...tempProfile, name: e.target.value})} placeholder="กรอกชื่อร้านค้าของคุณ..." />
            </div>
            <div className="mb-4">
              <label className="block text-sm font-bold text-gray-700 mb-2">เบอร์โทรศัพท์ <span className="text-rose-500 text-xs ml-1">*จำเป็น</span></label>
              <input type="text" className="w-full border p-3 rounded-xl focus:ring-4 focus:ring-blue-100 outline-none transition-all bg-yellow-50 focus:bg-white" value={tempProfile.phone} onChange={(e) => setTempProfile({...tempProfile, phone: e.target.value})} placeholder="เช่น 0891234567 (ติดต่อกรณีพัสดุมีปัญหา)" />
            </div>
            <div className="mb-8">
              <label className="block text-sm font-bold text-gray-700 mb-2">ที่อยู่ร้านค้า <span className="text-rose-500 text-xs ml-1">*จำเป็น</span></label>
              <textarea className="w-full border p-3 rounded-xl h-24 resize-none focus:ring-4 focus:ring-blue-100 outline-none transition-all bg-yellow-50 focus:bg-white" value={tempProfile.address} onChange={(e) => setTempProfile({...tempProfile, address: e.target.value})} placeholder="กรอกที่อยู่สำหรับจ่าหน้าผู้ส่ง หรือกรณีพัสดุตีกลับ..." />
            </div>
            {/* โซนใหม่: เชื่อมต่อเพจ Facebook */}
            <div className="mb-8 p-5 bg-indigo-50 border border-indigo-100 rounded-xl">
              <h3 className="text-sm font-bold text-indigo-800 mb-2 flex items-center gap-2">
                <span>🔗</span> เชื่อมต่อ Facebook Page
              </h3>
              <p className="text-xs text-indigo-600 mb-4">
                เพื่อดูดแชทลูกค้าเข้าสู่ Smart Inbox อัตโนมัติ (เฉพาะแพ็กเกจ Premium)
              </p>
              
              {/* 🔒 เช็คสิทธิ์ Premium ก่อนโชว์ปุ่ม Facebook */}
              {storeProfile?.plan === 'Premium' ? (
              <FacebookLogin
                appId="1535211344898500"
                autoLoad={false}
                fields="name,email,picture,accounts"
                scope="pages_show_list,pages_messaging,pages_read_engagement"
                callback={(response) => {
                  console.log("ได้ข้อมูลจาก Facebook แล้ว!", response);
                  if (response.accounts && response.accounts.data.length > 0) {
                     // เซ็ตข้อมูลเพจลง State เพื่อเอาไปโชว์ให้แม่ค้าเลือก
                     setConnectedPages(response.accounts.data);
                     alert(`พบ ${response.accounts.data.length} เพจ! กรุณาติ๊กเลือกเพจด้านล่างเพื่อเชื่อมต่อครับ`);
                  } else {
                     alert("คุณยังไม่ได้อนุญาตสิทธิ์เข้าถึงเพจ หรือคุณไม่มีเพจครับ");
                  }
                }}
                render={renderProps => (
                  <button 
                    onClick={renderProps.onClick} 
                    className="w-full bg-[#1877F2] hover:bg-[#166FE5] text-white font-bold py-3 px-4 rounded-lg flex justify-center items-center gap-2 transition-colors shadow-sm"
                  >
                    <svg className="w-5 h-5 fill-current" viewBox="0 0 24 24"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.469h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.469h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
                    เชื่อมต่อเพจ Facebook
                  </button>
                )}
              />
              ) : (
                // 🛑 ถ้าไม่ใช่ Premium ให้โชว์ปุ่มล็อคสีเทาๆ
                <button 
                  type="button"
                  onClick={() => alert('✨ ฟีเจอร์เชื่อมต่อเพจ Facebook สำหรับแพ็กเกจ Premium เท่านั้น!\n\nกรุณาติดต่อแอดมินเพื่ออัปเกรดระบบดูดแชทอัตโนมัติครับ 🚀')} 
                  className="w-full bg-slate-100 hover:bg-slate-200 text-slate-500 font-bold py-3 px-4 rounded-lg flex justify-center items-center gap-2 transition-colors border border-slate-300"
                >
                  <span className="text-lg drop-shadow-sm">🔒</span> เชื่อมต่อเพจ Facebook (ฟีเจอร์ Premium)
                </button>
              )}
              {/* โซนแสดงรายชื่อเพจให้เลือก (จะโชว์ก็ต่อเมื่อดึงข้อมูลเฟสบุ๊คสำเร็จ) */}
              {connectedPages.length > 0 && (
                <div className="mt-4 p-4 bg-white border border-gray-200 rounded-lg">
                  <h4 className="text-sm font-bold text-gray-800 mb-2">เลือกเพจที่ต้องการดูดแชท:</h4>
                  <div className="flex flex-col gap-2 max-h-40 overflow-y-auto">
                    {connectedPages.map(page => (
                      <label key={page.id} className="flex items-center gap-2 cursor-pointer hover:bg-gray-50 p-2 rounded">
                        <input 
                          type="checkbox" 
                          className="w-4 h-4 text-blue-600 rounded border-gray-300"
                          value={page.id}
                          checked={selectedPages.includes(page.id)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedPages([...selectedPages, page.id]);
                            } else {
                              setSelectedPages(selectedPages.filter(id => id !== page.id));
                            }
                          }}
                        />
                        <span className="text-sm text-gray-700">{page.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div className="flex justify-end gap-3">
              <button onClick={() => setIsSettingsOpen(false)} className="btn-cute px-6 py-3 bg-gray-100 text-gray-700 rounded-xl font-bold">ยกเลิก</button>
              <button onClick={handleSaveProfile} className="btn-cute px-6 py-3 bg-blue-600 text-white rounded-xl font-bold shadow-lg shadow-blue-500/30">💾 บันทึก</button>
            </div>
          </div>
        </div>
      )}
      <header className="mb-6 bg-white p-5 rounded-2xl shadow-sm border border-gray-100 print:hidden">
        <div className="flex flex-col md:flex-row justify-between items-center gap-4 mb-5">
          <div>
            <h1 className="text-3xl font-black text-blue-800 flex items-center gap-2">📦 SmartLabel <span className={`text-xs px-3 py-1 rounded-full font-bold shadow-sm ${userRole === 'SuperAdmin' ? 'bg-gradient-to-r from-rose-500 to-red-600 text-white shadow-red-500/30' : userRole === 'Owner' ? 'bg-gradient-to-r from-fuchsia-500 to-purple-600 text-white shadow-purple-500/30' : userRole === 'Admin' ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-700'}`}>{userRole}</span></h1>
            <p className="text-slate-500 text-sm mt-1 font-medium">ผู้ใช้งาน: {user.email.replace('@smartlabel.com', '')}</p>
          </div>
          
          <div className="flex flex-wrap items-center gap-3">
            {/* 🔥 แผงปุ่มเมนู เปลี่ยนไปตาม Role (ซ่อนเมนูไม่จำเป็นของ SuperAdmin) */}
            <div className="flex bg-slate-100 p-1.5 rounded-xl">
              
              {/* พนักงานทั่วไป และ เจ้าของร้าน */}
              {userRole !== 'SuperAdmin' && (
                <>
                  <button onClick={() => setActiveTab('maker')} className={`btn-cute px-5 py-2.5 rounded-lg font-bold text-sm transition-all ${activeTab === 'maker' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>✍️ สร้างจ่าหน้า</button>
                  <button onClick={() => setActiveTab('dashboard')} className={`btn-cute px-5 py-2.5 rounded-lg font-bold text-sm transition-all ${activeTab === 'dashboard' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>📊 สถิติ</button>
                </>
              )}
              
              {/* เฉพาะเจ้าของร้าน ถึงเห็นเมนูจัดการลูกน้อง */}
              {['Owner', 'Admin'].includes(userRole) && (
                <button onClick={() => setActiveTab('team')} className={`btn-cute px-5 py-2.5 rounded-lg font-bold text-sm transition-all ${activeTab === 'team' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>👥 พนักงาน</button>
              )}

              {/* 👑 เฉพาะพระเจ้า (SuperAdmin) จะเห็นหน้าร้านค้า และ การอนุมัติบิล */}
              {userRole === 'SuperAdmin' && (
                <>
                  <button onClick={() => setActiveTab('shops')} className={`btn-cute px-5 py-2.5 rounded-lg font-bold text-sm transition-all ${activeTab === 'shops' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>🏢 จัดการร้านค้า</button>
                  <button onClick={() => setActiveTab('affiliates')} className={`btn-cute px-5 py-2.5 rounded-lg font-bold text-sm transition-all ${activeTab === 'affiliates' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>🤝 ระบบตัวแทน</button>
                  <button onClick={() => setActiveTab('billing')} className={`btn-cute px-5 py-2.5 rounded-lg font-bold text-sm flex items-center gap-2 transition-all ${activeTab === 'billing' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>💳 อนุมัติบิล {billingRequests.length > 0 && <span className="bg-rose-500 text-white px-2 py-0.5 rounded-full text-xs shadow-md animate-bounce">{billingRequests.length}</span>}</button>
                </>
              )}
            </div>
            <button onClick={handleLogout} className="btn-cute bg-rose-50 text-rose-600 px-5 py-3 rounded-xl font-bold text-sm hover:bg-rose-100 transition-colors">ออก 🚪</button>
          </div>
        </div>
        
        {/* 🔥 โซนที่ 1: แถบแสดงโควต้า ให้ Owner และ Admin เห็น */}
        {['Owner', 'Admin'].includes(userRole) && (
          <div className="flex justify-between items-center bg-gradient-to-r from-blue-50 to-indigo-50 p-4 rounded-xl border border-blue-100 shadow-inner">
            <div className="font-black text-indigo-700 bg-white px-5 py-2.5 rounded-xl shadow-sm flex items-center gap-3 border border-indigo-50">
              🎫 โควต้าคงเหลือ: 
              <span className={`text-xl ${quota <= 5 ? 'text-rose-500 animate-pulse' : 'text-indigo-900'}`}>
                {quota} <span className="text-sm font-bold text-indigo-400">ใบ</span>
              </span>
              <button onClick={() => setIsTopupOpen(true)} className="btn-cute ml-2 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white px-4 py-1.5 rounded-lg text-xs shadow-md shadow-indigo-500/30">
                ➕ เติมโควต้า
              </button>
            </div>
            
            {/* 🛑 โซนที่ 2: ล็อคปุ่มตั้งค่าร้าน ให้เฉพาะ Owner (เถ้าแก่) เห็นเท่านั้น! */}
            {userRole === 'Owner' && (
              <button 
                onClick={() => {
                  setTempProfile(storeProfile); // 👈 1. บังคับโคลนข้อมูลของจริงล่าสุด มาใส่ตะกร้าชั่วคราวก่อน
                  setIsSettingsOpen(true);      // 👈 2. ค่อยสั่งเปิดหน้าต่าง
                }} className="btn-cute bg-white border border-slate-200 text-slate-700 px-5 py-2.5 rounded-xl font-bold text-sm shadow-sm hover:bg-slate-50 transition-colors">⚙️ ตั้งค่าร้าน
              </button>
            )}
          </div>
        )}
      </header>

      {/* --- Tab Content --- */}

      {/* 🔥 Tab ใหม่: จัดการร้านค้าทั้งหมด (SuperAdmin Only) */}
      {activeTab === 'shops' && userRole === 'SuperAdmin' ? (
         <div className="bg-white p-8 rounded-3xl shadow-sm border-t-4 border-blue-500">
           <h2 className="text-2xl font-black mb-8 text-slate-800 flex items-center gap-2">🏢 รายชื่อร้านค้าในระบบ (Tenants)</h2>
           <div className="overflow-hidden border border-slate-200 rounded-2xl">
             <table className="w-full text-sm text-left">
               <thead className="bg-slate-50 uppercase text-xs font-black text-slate-500 tracking-wider">
                 <tr>
                   <th className="py-4 px-6">ชื่อร้านค้า (Store Name)</th>
                   <th className="py-4 px-6">อีเมลเจ้าของ (Owner)</th>
                   <th className="py-4 px-6 text-center">วันที่สมัคร</th>
                   <th className="py-4 px-6 text-center">ใช้ไปแล้ว (ใบ)</th>
                   <th className="py-4 px-6 text-center">โควต้าคงเหลือ</th>
                 </tr>
               </thead>
               <tbody>
                 {allShops.length === 0 ? ( 
                   <tr><td colSpan="4" className="text-center py-12 text-slate-400 font-medium">ยังไม่มีร้านค้าในระบบ...</td></tr>
                 ) : ( 
                   allShops.map((shop, idx) => (
                     <tr key={idx} className="border-t border-slate-100 hover:bg-blue-50/50 transition-colors">
                       <td className="py-4 px-6 font-bold text-slate-800 text-lg">{shop.storeName || <span className="text-slate-400 italic">ไม่ระบุ</span>}</td>
                       <td className="py-4 px-6 font-mono font-medium text-slate-600">{shop.email}</td>
                      <td className="py-4 px-6 text-center text-slate-500">{shop.createdAt ? shop.createdAt.toDate().toLocaleDateString('th-TH') : '-'}</td>
                      <td className="py-4 px-6 text-center font-black text-blue-600 text-lg">{shop.usedQuota || 0}</td>
                      <td className="py-4 px-6 text-center">
                         <span className={`px-4 py-2 rounded-xl font-black text-lg shadow-sm ${shop.quota <= 5 ? 'bg-rose-100 text-rose-700' : 'bg-indigo-100 text-indigo-700'}`}>
                           {shop.quota || 0}
                         </span>
                       </td>
                     </tr>
                   ))
                 )}
               </tbody>
             </table>
           </div>
         </div>
      ) : activeTab === 'maker' ? (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 print:block print:gap-0 print:m-0">
            
            {/* ======================================================== */}
            {/* 💎 โซนซ้าย: Inbox อัจฉริยะ (ดึงแชทอัตโนมัติ) */}
            {/* ======================================================== */}
            <div className="lg:col-span-4 flex flex-col h-[75vh] print:hidden">
                <div className="bg-gradient-to-r from-violet-600 to-indigo-600 rounded-t-2xl p-4 text-white flex justify-between items-center shadow-lg">
                  <h3 className="font-bold text-lg flex items-center gap-2"><span className="text-2xl">🤖</span> Smart Inbox</h3>
                
                {/* 🔥 เพิ่มปุ่ม "ประวัติ" เข้าไปตรงนี้ครับ */}
                <div className="flex items-center gap-2">
                  <button onClick={() => setIsHistoryModalOpen(true)} className="bg-white/20 hover:bg-white/30 px-3 py-1 rounded-full text-xs font-semibold backdrop-blur-sm transition-colors cursor-pointer flex items-center gap-1 shadow-sm border border-white/30">
                    🕒 ประวัติ/ถังขยะ
                  </button>
                  <span className="bg-white/20 px-3 py-1 rounded-full text-xs font-semibold backdrop-blur-sm shadow-sm border border-white/30 hidden sm:inline-block">✨ Premium</span>
                </div>
              </div>
              <div className="bg-white border-x border-b border-gray-200 rounded-b-2xl shadow-lg flex-1 p-4 overflow-y-auto relative">
                {/* 🛑 กระจกฝ้าล็อคฟีเจอร์ Premium (จะโชว์ถ้าไม่ใช่ Premium) */}
               {storeProfile?.plan !== 'Premium' && (
                 <div className="absolute inset-0 bg-white/70 backdrop-blur-[2px] z-10 flex flex-col items-center justify-center rounded-b-2xl">
                    <span className="text-6xl mb-4 drop-shadow-md">🔒</span>
                    <h4 className="text-xl font-black text-indigo-900 mb-2">ฟีเจอร์ระดับพรีเมียม</h4>
                    <p className="text-sm text-indigo-700 text-center px-6 mb-5 font-medium leading-relaxed">
                      ยกระดับร้านค้าของคุณ! ปลดล็อกระบบดูดแชทเพจ Facebook<br/>และให้ AI สกัดที่อยู่จัดส่งให้อัตโนมัติในคลิกเดียว
                    </p>
                {/* เปลี่ยนจาก onClick={() => alert(...)} เป็น onClick={() => setIsTopupOpen(true)} */}
                  <button 
                    onClick={() => setIsTopupOpen(true)} 
                    className="btn-cute bg-gradient-to-r from-indigo-600 to-violet-600 text-white px-8 py-3 rounded-full font-bold shadow-lg shadow-indigo-500/40 flex items-center gap-2 hover:scale-105 transition-transform"
                  >
                    ⭐ อัปเกรดแพ็กเกจเลย
                  </button>
                 </div>
               )}
                {incomingChats.length === 0 ? (
                  <div className="text-center text-gray-400 mt-10 flex flex-col items-center">
                    <span className="text-4xl mb-3">📭</span>
                    <p>ยังไม่มีข้อความเข้าใหม่...</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {incomingChats.map((chat) => (
                      <div key={chat.id} className="bg-indigo-50/50 border border-indigo-100 rounded-xl p-4 hover:shadow-md transition-all duration-300 relative group">
                        <div className="flex justify-between items-start mb-2">
                          <span className="text-xs text-indigo-400 font-semibold bg-white px-2 py-1 rounded-md shadow-sm border border-indigo-50">ID ลูกค้า: {chat.senderId}</span>
                          <span className="text-xs text-gray-400">{chat.timestamp ? new Date(chat.timestamp.toDate()).toLocaleTimeString('th-TH') : 'Just now'}</span>
                        </div>
                        <p className="text-gray-700 text-sm mb-4 line-clamp-3 leading-relaxed">"{chat.message}"</p>
                        {/* 🔥 เปลี่ยนปุ่มเดิมเป็น 2 ปุ่มนี้ครับ */}
                          <div className="flex gap-2 mt-2">
                            <button 
                              onClick={() => handleUseChat(chat)} // ส่งไปทั้งก้อน chat ไม่ใช่แค่ message
                              className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-2 px-3 rounded-lg shadow-sm transition-all flex justify-center items-center gap-1 text-sm"
                            >
                              <span>⚡</span> สกัดที่อยู่
                            </button>
                            <button 
                              onClick={() => handleDismissChat(chat.id)} 
                              className="bg-gray-100 hover:bg-red-100 text-gray-500 hover:text-red-600 font-bold py-2 px-3 rounded-lg transition-all flex justify-center items-center text-sm border border-gray-200"
                              title="ซ่อนข้อความนี้"
                            >
                              ❌
                            </button>
                          </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>



            {/* ======================================================== */}
            {/* โซนขวา: ฟอร์มก๊อปวางเดิม และ พรีวิวพิมพ์ */}
            {/* ======================================================== */}
            <div className="lg:col-span-8 flex flex-col lg:flex-row gap-6">
                
                {/* กล่องซ้ายในโซนขวา: กรอกข้อมูล */}
                <div className="flex-1 bg-white p-6 rounded-2xl shadow-sm border border-gray-100 max-h-[75vh] overflow-y-auto print:hidden">
                  <h2 className="text-xl font-black mb-6 text-gray-800 flex items-center gap-2"><span className="text-blue-500">1.</span> วางข้อความแชต</h2>
                  {orders.map((order, index) => {
                    let boxColorClass = 'border-gray-200 focus:ring-blue-300';
                    if (order.parsedData) {
                      const hasWarnings = order.parsedData.warnings.length > 0;
                      boxColorClass = order.parsedData.isCOD ? (hasWarnings ? 'border-orange-400 bg-orange-50/50' : 'border-orange-500 bg-orange-50 ring-2 ring-orange-200') : (hasWarnings ? 'border-rose-400 bg-rose-50/50' : 'border-emerald-500 bg-emerald-50 ring-2 ring-emerald-200');
                    }

                    return (
                      <div key={order.id} className="mb-6 p-5 rounded-2xl border border-gray-100 bg-slate-50/50 hover:bg-white transition-colors group">
                        <div className="flex justify-between items-center mb-3">
                          <label className="font-bold text-gray-500 bg-white px-3 py-1 rounded-lg text-sm shadow-sm border border-gray-100">ออเดอร์ที่ {index + 1} {order.isSaved && <span className="ml-2 text-xs bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full">💾 บันทึกแล้ว</span>}</label>
                          {(order.rawText !== '' || orders.length > 1) && <button onClick={() => handleDeleteOrder(order.id)} className="text-rose-400 hover:text-rose-600 text-sm font-bold flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">🗑️ ลบ</button>}
                        </div>
                        {order.crmSuggestion && <div className="mb-3 p-4 bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-xl flex justify-between items-center shadow-sm animate-pulse"><div><p className="text-xs text-indigo-600 font-black mb-1">✨ พบประวัติลูกค้า!</p><p className="text-sm font-bold text-slate-800">{order.crmSuggestion.customerName}</p></div><button onClick={() => applyCrmData(order.id, order.crmSuggestion)} className="btn-cute bg-indigo-600 text-white text-xs font-bold py-2 px-4 rounded-lg shadow-md shadow-indigo-500/30">ใช้ข้อมูลนี้</button></div>}
                        <textarea className={`w-full h-32 p-4 rounded-xl focus:outline-none focus:ring-4 resize-none transition-all shadow-inner ${boxColorClass}`} placeholder="วางที่อยู่ หรือ พิมพ์แค่เบอร์โทรศัพท์..." value={order.rawText} onChange={(e) => handleTextChange(order.id, e.target.value)} onFocus={() => handleFocus(order.id)} />
                        {order.parsedData && order.parsedData.warnings.length > 0 && <div className="mt-3 text-sm font-bold text-rose-500 flex flex-col gap-1 bg-rose-50 p-3 rounded-lg border border-rose-100">{order.parsedData.warnings.map((w, i) => <span key={i}>⚠️ {w.replace('⚠️ ', '')}</span>)}</div>}
                      </div>
                      
                    );
                    
                  })}
                </div>
                
                {/* กล่องขวาในโซนขวา: พรีวิวพิมพ์ */}
                <div className="flex-1 bg-slate-100/50 rounded-2xl shadow-inner border-2 border-dashed border-slate-300 max-h-[75vh] overflow-y-auto print:max-h-none print:overflow-visible print:bg-white print:border-none print:shadow-none print:m-0 print:p-0 relative print:static">
                  <div className="sticky top-0 bg-white/80 backdrop-blur-md border-b border-slate-200 p-5 flex justify-between items-center z-10 print:hidden"><h2 className="text-xl font-black text-gray-800 flex items-center gap-2"><span className="text-blue-500">2.</span> ตรวจสอบและสั่งพิมพ์</h2><button onClick={handleSaveAndPrint} className="btn-cute bg-blue-600 text-white font-bold py-3 px-6 rounded-xl shadow-lg shadow-blue-500/30 flex items-center gap-2">💾 บันทึก & สั่งพิมพ์</button></div>
                  <div className="p-8 print:p-0 print:m-0">
                    {orders.filter(o => o.parsedData).map((order) => (
                      <div key={order.id} ref={(el) => (labelRefs.current[order.id] = el)} className="w-full max-w-sm mx-auto mb-10 bg-white border-2 border-black p-4 thermal-label shadow-xl card-hover print:max-w-none print:mx-0 print:mb-0 print:shadow-none print:transform-none">
                        <div className="flex justify-between border-b-2 border-slate-200 pb-2 mb-3 font-bold text-sm print:border-black"><span>SmartLabel ✅</span><span className="text-gray-500">Admin: {user?.email?.split('@')[0]}</span></div>
                        <div className="mb-3"><p className="text-xs text-gray-500 font-medium">ผู้ส่ง:</p><p className="font-bold text-sm">{storeProfile.name}</p></div>
                        {order.parsedData.isCOD && <div className="bg-black text-white text-center py-2 mb-3 text-2xl font-black tracking-wider rounded-sm print:border-4 print:border-black">COD: {order.parsedData.codAmount}</div>}
                        <div className="bg-slate-50 p-3 mb-3 rounded-sm border border-slate-200 print:bg-white print:border-black print:border-2"><p className="text-xs text-blue-600 font-black mb-1 print:text-black">ผู้รับ:</p><p className="text-xl font-black text-slate-800">{order.parsedData.customerName || 'ไม่มีชื่อ'}</p><p className="text-lg font-bold text-slate-700 mt-1">☎ {order.parsedData.phone || '-'}</p><p className="text-sm leading-relaxed mt-2 text-slate-600">{order.parsedData.address || 'ไม่มีที่อยู่'}</p></div>
                        <div className="text-center text-5xl font-black mb-4 tracking-widest text-slate-900">{order.parsedData.zipcode || '00000'}</div>
                        <div className="flex flex-col items-center border-t-2 border-b-2 border-slate-200 py-3 mb-3 print:border-black"><QRCodeSVG value={JSON.stringify({ id: order.id, cod: order.parsedData.isCOD ? order.parsedData.codAmount : 0, admin: user?.email })} size={60} /><p className="text-[10px] mt-2 font-mono uppercase font-bold text-slate-500 tracking-widest">REF: #{String(order.id).slice(-6)}</p></div>
                        <div><p className="text-xs font-black text-slate-700 mb-1">รายการสินค้า:</p>{order.parsedData.items.length > 0 ? (<ul className="text-[10px] list-disc pl-4 font-medium text-slate-600">{order.parsedData.items.map((item, index) => <li key={index}>{item}</li>)}</ul>) : (<p className="text-[10px] text-gray-400 italic">- ไม่ระบุรายการ -</p>)}</div>
                      </div>
                    ))}
                  </div>
                </div>
            </div>
          </div>
      ) : activeTab === 'dashboard' ? (
         <div className="flex flex-col gap-6">
            {/* 1. สรุปยอดรวม (Top Cards) */}
            <div className="bg-white p-8 rounded-3xl shadow-sm border border-slate-100">
              <h2 className="text-2xl font-black mb-8 text-slate-800 flex items-center gap-2">📊 ภาพรวมธุรกิจ</h2>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-2">
                <div className="bg-blue-50 p-6 rounded-2xl border border-blue-100 card-hover"><div className="w-12 h-12 bg-blue-100 rounded-full flex items-center justify-center text-xl mb-4">📦</div><h3 className="text-blue-600 font-bold mb-1">ส่งรวมทั้งหมด</h3><p className="text-5xl font-black text-blue-900">{dashboardStats.totalOrders} <span className="text-lg font-medium">ชิ้น</span></p></div>
                <div className="bg-orange-50 p-6 rounded-2xl border border-orange-100 card-hover"><div className="w-12 h-12 bg-orange-100 rounded-full flex items-center justify-center text-xl mb-4">🚚</div><h3 className="text-orange-600 font-bold mb-1">ออเดอร์ COD</h3><p className="text-5xl font-black text-orange-900">{dashboardStats.codOrders} <span className="text-lg font-medium">ชิ้น</span></p></div>
                <div className="bg-emerald-50 p-6 rounded-2xl border border-emerald-100 card-hover"><div className="w-12 h-12 bg-emerald-100 rounded-full flex items-center justify-center text-xl mb-4">💰</div><h3 className="text-emerald-600 font-bold mb-1">คาดการณ์เงินโอน</h3><p className="text-5xl font-black text-emerald-900">฿{dashboardStats.totalCodAmount.toLocaleString()}</p></div>
              </div>
            </div>

            {/* 2. กราฟสถิติ (Charts) */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
               {/* กราฟวงกลม */}
               <div className="bg-white p-6 rounded-3xl shadow-sm border border-slate-100 flex flex-col items-center justify-center card-hover">
                  <h3 className="text-lg font-black text-slate-700 w-full text-left mb-2">สัดส่วนประเภทการชำระ</h3>
                  <ResponsiveContainer width="100%" height={250}>
                     <PieChart>
                        <Pie data={dashboardStats.pieData} innerRadius={60} outerRadius={85} paddingAngle={5} dataKey="value">
                           {dashboardStats.pieData.map((entry, index) => <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />)}
                        </Pie>
                        <Tooltip contentStyle={{borderRadius: '12px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)'}} />
                        <Legend wrapperStyle={{fontSize: '14px', fontWeight: 'bold'}} />
                     </PieChart>
                  </ResponsiveContainer>
               </div>
               
               {/* กราฟแท่ง (ยอดรายวัน) */}
               <div className="bg-white p-6 rounded-3xl shadow-sm border border-slate-100 lg:col-span-2 card-hover">
                  <div className="flex justify-between items-center mb-4">
                    <h3 className="text-lg font-black text-slate-700">สถิติการส่งพัสดุรายวัน <span className="text-sm font-medium text-slate-400 ml-2">(คลิกแท่งกราฟเพื่อดูรายละเอียด)</span></h3>
                    {selectedDate && <button onClick={() => setSelectedDate(null)} className="btn-cute text-xs bg-slate-100 text-slate-600 px-4 py-2 rounded-xl font-bold hover:bg-slate-200">❌ ดูทั้งหมด</button>}
                  </div>
                  <ResponsiveContainer width="100%" height={250}>
                     <BarChart data={dashboardStats.barData} onClick={(data) => { if(data && data.activePayload) setSelectedDate(data.activePayload[0].payload.name); }}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                        <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{fontSize: 12, fill: '#64748b', fontWeight: 'bold'}} />
                        <YAxis axisLine={false} tickLine={false} tick={{fontSize: 12, fill: '#64748b'}} />
                        <Tooltip cursor={{fill: '#f8fafc'}} contentStyle={{borderRadius: '12px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)'}} />
                        <Legend iconType="circle" wrapperStyle={{fontSize: '13px', fontWeight: 'bold'}} />
                        <Bar dataKey="โอนเงิน" stackId="a" fill="#22c55e" radius={[0, 0, 6, 6]} cursor="pointer" />
                        <Bar dataKey="COD" stackId="a" fill="#f97316" radius={[6, 6, 0, 0]} cursor="pointer" />
                     </BarChart>
                  </ResponsiveContainer>
               </div>
            </div>

            {/* 🔥 2.5 กราฟผลงานพนักงาน (Gamification) */}
            <div className="bg-white p-6 rounded-3xl shadow-sm border border-slate-100 mb-6 card-hover">
               <div className="flex justify-between items-center mb-4">
                 <h3 className="text-lg font-black text-slate-700">🏆 Leaderboard ผลงานทีมงาน <span className="text-sm font-medium text-slate-400 ml-2">(ใครแพ็คเยอะสุด?)</span></h3>
               </div>
               <ResponsiveContainer width="100%" height={250}>
                  {/* เปลี่ยนเป็นกราฟแนวนอน (layout="vertical") เพื่อให้อ่านชื่อพนักงานง่ายขึ้น */}
                  <BarChart data={dashboardStats.staffData || []} layout="vertical" margin={{ top: 5, right: 30, left: 40, bottom: 5 }}>
                     <CartesianGrid strokeDasharray="3 3" horizontal={true} vertical={false} stroke="#f1f5f9" />
                     <XAxis type="number" hide />
                     <YAxis dataKey="name" type="category" axisLine={false} tickLine={false} tick={{fontSize: 13, fill: '#475569', fontWeight: 'bold'}} />
                     <Tooltip cursor={{fill: '#f8fafc'}} contentStyle={{borderRadius: '12px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)'}} />
                     <Bar dataKey="ชิ้นงาน" fill="#6366f1" radius={[0, 8, 8, 0]} barSize={24} animationDuration={1500}>
                     </Bar>
                  </BarChart>
               </ResponsiveContainer>
            </div>

            {/* 3. ตารางรายละเอียด (Data Table) */}
            <div className="bg-white p-8 rounded-3xl shadow-sm border border-slate-100 mb-10">
               <div className="flex flex-col md:flex-row justify-between items-center mb-6 gap-4">
                  <h3 className="text-xl font-black text-slate-800 flex items-center gap-3">
                     📋 รายละเอียดพัสดุ 
                     {selectedDate && <span className="text-blue-600 bg-blue-50 px-4 py-1.5 rounded-xl text-sm border border-blue-100 animate-[fadeIn_0.3s_ease-out]">📅 ประจำวันที่: {selectedDate}</span>}
                  </h3>
                  <div className="flex gap-3 w-full md:w-auto">
                     <input type="text" placeholder="🔍 ค้นหา ชื่อ, รหัสปณ, หรือ REF..." value={searchQuery} onChange={(e)=>setSearchQuery(e.target.value)} className="border border-slate-200 p-3 rounded-xl focus:ring-4 focus:ring-blue-100 outline-none text-sm w-full md:w-72 transition-all bg-slate-50 focus:bg-white" />
                     <button onClick={handleExportCSV} className="btn-cute bg-emerald-50 text-emerald-600 font-black px-6 py-3 rounded-xl text-sm hover:bg-emerald-500 hover:text-white flex-shrink-0 transition-colors shadow-sm">📥 ดาวน์โหลด Excel</button>
                  </div>
               </div>
               
               <div className="overflow-x-auto border border-slate-200 rounded-2xl">
                <table className="w-full text-sm text-left">
                  <thead className="bg-slate-50 uppercase text-xs font-black text-slate-500 tracking-wider border-b border-slate-200">
                    <tr>
                      <th className="py-4 px-6 whitespace-nowrap">วันที่ / เวลา</th>
                      <th className="py-4 px-6 whitespace-nowrap">หมายเลขสิ่งของ</th>
                      <th className="py-4 px-6 whitespace-nowrap">ชื่อผู้รับ (ลูกค้า)</th>
                      <th className="py-4 px-6 min-w-[200px]">ที่อยู่จัดส่ง</th>
                      <th className="py-4 px-6 text-right whitespace-nowrap">ยอดเก็บเงิน (COD)</th>
                      {/* 👈 คอลัมน์ใหม่: กรอกเลขพัสดุ */}
                      <th className="py-4 px-6 text-center min-w-[250px]">แจ้งเลขพัสดุ</th> 
                      <th className="py-4 px-6 text-center whitespace-nowrap">จัดการ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredOrders.length === 0 ? (
                      <tr><td colSpan="7" className="text-center py-16 text-slate-400 font-medium">ไม่พบข้อมูลที่ค้นหา หรือยังไม่มีออเดอร์ในวันนี้...</td></tr>
                    ) : (
                      filteredOrders.map((order, idx) => (
                          <tr key={idx} className="border-b border-slate-100 hover:bg-blue-50/50 transition-colors">
                            <td className="py-4 px-6 text-slate-500 whitespace-nowrap">{order.createdAt ? order.createdAt.toDate().toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' }) : '-'}</td>
                            <td className="py-4 px-6 font-mono font-bold text-indigo-600 tracking-wider bg-indigo-50/30 whitespace-nowrap">REF-{order.id.slice(-6).toUpperCase()}</td>
                            <td className="py-4 px-6 whitespace-nowrap">
                                <p className="font-bold text-slate-800 text-base">{order.customerName || 'ไม่ระบุชื่อ'}</p>
                                <p className="text-xs text-slate-500 mt-1">👤 {order.creatorName || order.phone || 'Owner'}</p> {/* ย้ายคนทำรายการมาไว้ใต้ชื่อลูกค้า ประหยัดพื้นที่ครับ */}
                            </td>
                            <td className="py-4 px-6">
                                <p className="text-slate-600 line-clamp-2 text-xs leading-relaxed mb-1" title={order.address}>{order.address}</p>
                                <span className="font-black text-slate-800 tracking-widest bg-slate-100 px-2 py-0.5 rounded text-xs">{order.zipcode}</span>
                            </td>
                            <td className="py-4 px-6 text-right">
                                {order.isCOD 
                                ? <span className="font-black text-xl text-orange-600 bg-orange-50 px-4 py-1.5 rounded-xl border border-orange-100">฿{order.codAmount}</span> 
                                : <span className="font-black text-emerald-600 text-sm bg-emerald-50 px-4 py-1.5 rounded-xl border border-emerald-100">โอนเงินแล้ว</span>}
                            </td>
                            
                            {/* 📦 โซนกรอกเลขพัสดุและก๊อปปี้ */}
                            <td className="py-4 px-6">
                              <div className="flex gap-2 items-center justify-center">
                                <input 
                                  type="text" 
                                  placeholder="เช่น OA123456789TH" 
                                  className="border border-slate-200 p-2 rounded-lg text-xs w-36 focus:ring-2 focus:ring-blue-300 outline-none uppercase font-mono"
                                  // 👈 จุดที่ต้องแก้: ถ้าเรากำลังพิมพ์ ให้โชว์ค่าที่พิมพ์ (trackingInputs) 
                                  // แต่ถ้าไม่ได้พิมพ์ ให้โชว์ค่าที่มาจากฐานข้อมูล (order.trackingNum)
                                  value={trackingInputs[order.id] !== undefined ? trackingInputs[order.id] : (order.trackingNum || '')}
                                  onChange={(e) => setTrackingInputs({...trackingInputs, [order.id]: e.target.value.toUpperCase()})}
                                />
                                <button 
                                  onClick={() => handleCopyTrackingMessage(order)}
                                  className="bg-emerald-500 text-white p-2 rounded-lg text-xs font-bold hover:bg-emerald-600 transition-colors shadow-sm flex items-center justify-center"
                                  title="คัดลอกข้อความแจ้งลูกค้า"
                                >
                                  📋 ก๊อปปี้
                                </button>
                              </div>
                            </td>

                            <td className="py-4 px-6 text-center">
                              <button 
                                onClick={() => handleReprint(order)}
                                className="bg-indigo-50 text-indigo-600 px-3 py-1.5 rounded-lg text-xs font-bold hover:bg-indigo-600 hover:text-white transition-colors shadow-sm"
                                title="ดึงข้อมูลนี้กลับไปที่หน้าสร้างจ่าหน้า"
                              >
                                🖨️ พิมพ์ซ้ำ
                              </button>
                            </td>
                          </tr>
                      ))
                    )}
                  </tbody>
                </table>
               </div>
            </div>
         </div>
      ) : activeTab === 'team' && ['Owner', 'Admin'].includes(userRole) ? (
          <div className="flex flex-col lg:flex-row gap-6">
            <div className="w-full lg:w-1/3">
              <div className="bg-white p-8 rounded-3xl shadow-sm border border-gray-100 sticky top-6">
                <h2 className="text-xl font-black mb-6 text-slate-800 flex items-center gap-2">➕ เพิ่มพนักงาน</h2>
                <form onSubmit={handleAddStaff}>
                  <div className="mb-5"><label className="block text-sm font-bold text-slate-700 mb-2">ชื่อพนักงาน</label><input type="text" required value={newStaff.name} onChange={(e)=>setNewStaff({...newStaff, name: e.target.value})} className="w-full border border-slate-200 p-3 rounded-xl focus:ring-4 focus:ring-blue-100 outline-none bg-slate-50 transition-all" placeholder="เช่น น้องฟ้าใส" /></div>
                  <div className="mb-5"><label className="block text-sm font-bold text-slate-700 mb-2">เบอร์โทรศัพท์ (ใช้ล็อกอิน)</label><input type="text" maxLength="10" required value={newStaff.phone} onChange={(e)=>setNewStaff({...newStaff, phone: e.target.value})} className="w-full border border-slate-200 p-3 rounded-xl focus:ring-4 focus:ring-blue-100 outline-none bg-slate-50 transition-all" placeholder="089xxxxxxx" /><div className="bg-blue-50 text-blue-700 text-xs p-2 rounded-lg mt-2 font-medium">🔑 รหัสผ่านเริ่มต้นจะถูกตั้งเป็น: 123456</div></div>
                  <div className="mb-8"><label className="block text-sm font-bold text-slate-700 mb-2">สิทธิ์การเข้าถึง</label><select value={newStaff.role} onChange={(e)=>setNewStaff({...newStaff, role: e.target.value})} className="w-full border border-slate-200 p-3 rounded-xl focus:ring-4 focus:ring-blue-100 outline-none bg-slate-50 font-medium appearance-none"><option value="Staff">👨‍💻 พนักงาน (จ่าหน้าอย่างเดียว)</option><option value="Admin">💼 ผู้จัดการ (ดูสถิติได้)</option></select></div>
                  <button type="submit" className="btn-cute w-full bg-blue-600 text-white font-bold py-4 rounded-xl shadow-lg shadow-blue-500/30 text-lg">บันทึกข้อมูลพนักงาน</button>
                </form>
              </div>
            </div>
            <div className="w-full lg:w-2/3">
              <div className="bg-white p-8 rounded-3xl shadow-sm border border-gray-100">
                <h2 className="text-xl font-black mb-6 text-slate-800 flex items-center gap-2">👥 ทีมงานของคุณ</h2>
                <div className="overflow-hidden border border-slate-200 rounded-2xl">
                  <table className="w-full text-sm text-left"><thead className="bg-slate-50 uppercase text-xs font-black text-slate-500 tracking-wider"><tr><th className="py-4 px-6">ชื่อ</th><th className="py-4 px-6">เบอร์โทร (ล็อกอิน)</th><th className="py-4 px-6">สิทธิ์</th><th className="py-4 px-6 text-center">จัดการ</th></tr></thead>
                    <tbody>
                      {staffList.length === 0 ? ( <tr><td colSpan="4" className="text-center py-12 text-slate-400 font-medium">ยังไม่มีพนักงานในระบบ...</td></tr>
                      ) : ( staffList.map((staff, idx) => (
                          <tr key={idx} className="border-t border-slate-100 hover:bg-blue-50/50 transition-colors">
                            <td className="py-4 px-6 font-bold text-slate-800">{staff.name}</td>
                            <td className="py-4 px-6 font-mono font-medium text-slate-600">{staff.phone}</td>
                            <td className="py-4 px-6"><span className={`px-3 py-1 rounded-full text-xs font-bold shadow-sm ${staff.role === 'Admin' ? 'bg-indigo-100 text-indigo-700' : 'bg-slate-100 text-slate-700'}`}>{staff.role}</span></td>
                            <td className="py-4 px-6 text-center">
                              {/* 🛡️ กฎเหล็กการลบพนักงาน:
                                  1. ห้ามลบ Owner เด็ดขาด (staff.role !== 'Owner')
                                  2. ห้ามลบตัวเอง (staff.id !== user.uid)
                                  3. ถ้าคนกดคือ Owner ให้ลบใครก็ได้ (ยกเว้นตัวเองตามข้อ 2)
                                  4. ถ้าคนกดคือ Admin ให้ลบได้เฉพาะ 'Staff' เท่านั้น (ป้องกัน Admin ตีกันเอง)
                              */}
                              {staff.role !== 'Owner' && staff.id !== user.uid && (userRole === 'Owner' || (userRole === 'Admin' && staff.role === 'Staff')) ? (
                                <button 
                                  onClick={() => handleDeleteStaff(staff.id)} 
                                  className="btn-cute text-rose-500 hover:text-white font-bold text-xs bg-rose-50 hover:bg-rose-500 px-3 py-1.5 rounded-lg transition-colors"
                                >
                                  ลบออก
                                </button>
                              ) : (
                                // ถ้าไม่เข้าเงื่อนไข ให้โชว์ขีดกลางโง่ๆ แทนปุ่มลบครับ
                                <span className="text-slate-300 text-xs font-bold">-</span>
                              )}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
      ) : activeTab === 'affiliates' && userRole === 'SuperAdmin' ? (
         <div className="flex flex-col gap-6">
           {/* ตารางนักการตลาด */}
           <div className="bg-white p-8 rounded-3xl shadow-sm border-t-4 border-indigo-500">
             <h2 className="text-2xl font-black mb-6 text-slate-800 flex items-center gap-2">🤝 รายชื่อนักการตลาด (Affiliate Partners)</h2>
             <div className="overflow-hidden border border-slate-200 rounded-2xl">
               <table className="w-full text-sm text-left">
                 <thead className="bg-slate-50 uppercase text-xs font-black text-slate-500">
                   <tr><th className="py-4 px-6">ชื่อ - เบอร์โทร</th><th className="py-4 px-6 text-center">รหัสแนะนำ</th><th className="py-4 px-6 text-right">รายได้สะสม</th><th className="py-4 px-6 text-right">ยอดคงเหลือ</th></tr>
                 </thead>
                 <tbody>
                   {allAffiliates.length === 0 ? <tr><td colSpan="4" className="text-center py-8 text-slate-400">ยังไม่มีนักการตลาด...</td></tr> : 
                    allAffiliates.map((aff, idx) => (
                     <tr key={idx} className="border-t border-slate-100 hover:bg-slate-50">
                       <td className="py-4 px-6"><p className="font-bold text-slate-800">{aff.name}</p><p className="text-xs text-slate-500">ID: {aff.phone}</p></td>
                       <td className="py-4 px-6 text-center"><span className="bg-indigo-100 text-indigo-700 font-bold px-3 py-1 rounded">{aff.referralCode}</span></td>
                       <td className="py-4 px-6 text-right font-black text-slate-700">฿{(aff.totalEarned || 0).toLocaleString()}</td>
                       <td className="py-4 px-6 text-right font-black text-orange-600">฿{(aff.balance || 0).toLocaleString()}</td>
                     </tr>
                   ))}
                 </tbody>
               </table>
             </div>
           </div>

           {/* ตารางขอถอนเงิน */}
           <div className="bg-white p-8 rounded-3xl shadow-sm border-t-4 border-orange-500">
             <h2 className="text-2xl font-black mb-6 text-slate-800 flex items-center gap-2">🏦 รายการขอถอนเงิน (Withdrawals)</h2>
             <div className="overflow-hidden border border-slate-200 rounded-2xl">
               <table className="w-full text-sm text-left">
                 <thead className="bg-slate-50 uppercase text-xs font-black text-slate-500">
                   <tr><th className="py-4 px-6">วันที่</th><th className="py-4 px-6">พาร์ทเนอร์</th><th className="py-4 px-6">พร้อมเพย์/บัญชี</th><th className="py-4 px-6 text-right">ยอดถอน</th><th className="py-4 px-6 text-center">จัดการ</th></tr>
                 </thead>
                 <tbody>
                   {allWithdrawals.length === 0 ? <tr><td colSpan="5" className="text-center py-8 text-slate-400">ไม่มีรายการขอถอนเงิน...</td></tr> : 
                    allWithdrawals.map((w, idx) => (
                     <tr key={idx} className="border-t border-slate-100 hover:bg-slate-50">
                       <td className="py-4 px-6 text-slate-500">{w.createdAt ? w.createdAt.toDate().toLocaleDateString('th-TH') : '-'}</td>
                       <td className="py-4 px-6 font-bold text-slate-800">{w.affiliateName}</td>
                       <td className="py-4 px-6 font-mono text-blue-600">{w.paymentInfo}</td>
                       <td className="py-4 px-6 text-right font-black text-orange-600">฿{w.amount.toLocaleString()}</td>
                       <td className="py-4 px-6 text-center">
                         {w.status === 'pending' ? 
                           <button onClick={() => handleApproveWithdrawal(w.id)} className="btn-cute bg-emerald-500 hover:bg-emerald-600 text-white font-bold px-4 py-2 rounded-lg text-xs shadow-md">✅ โอนเงินแล้ว</button>
                         : <span className="bg-emerald-100 text-emerald-700 font-bold px-3 py-1 rounded text-xs">โอนแล้ว</span>}
                       </td>
                     </tr>
                   ))}
                 </tbody>
               </table>
             </div>
           </div>
         </div>
      ) : activeTab === 'billing' && userRole === 'SuperAdmin' ? (
        <div className="bg-white p-8 rounded-3xl shadow-sm border-t-4 border-emerald-400">
          <h2 className="text-2xl font-black mb-8 text-slate-800 flex items-center gap-2">💳 ตรวจสอบและอนุมัติบิล (SuperAdmin)</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
            {billingRequests.map((req, index) => (
              <div key={index} className="border border-slate-200 rounded-3xl bg-white shadow-lg overflow-hidden flex flex-col card-hover">
                <div className="bg-slate-100 h-48 w-full border-b border-slate-200 relative">
                  {req.data.slipImage ? (
                    <img src={req.data.slipImage} alt="Slip" className="w-full h-full object-cover" onClick={() => window.open(req.data.slipImage, '_blank')} title="คลิกเพื่อดูรูปใหญ่" style={{cursor: 'zoom-in'}} />
                  ) : (
                    <div className="flex items-center justify-center h-full text-slate-400 font-medium">ไม่มีรูปภาพแนบมา</div>
                  )}
                  <div className="absolute top-3 right-3 bg-rose-500 text-white text-[10px] font-bold px-3 py-1 rounded-full shadow-md">รอตรวจสอบ</div>
                </div>
                
                <div className="p-6 flex-1 flex flex-col justify-between">
                  <div>
                    <p className="font-black text-slate-800 text-lg">{req.data.storeName || 'ไม่มีชื่อร้าน'}</p>
                    <p className="text-xs text-slate-500 mb-4 font-medium">{req.data.userEmail}</p>
                    <div className="bg-slate-50 p-4 rounded-xl mb-6 flex justify-between border border-slate-100">
                      <div><p className="text-xs text-slate-500 font-bold mb-1 uppercase tracking-widest">แพ็กเกจที่ขอ</p><p className="font-black text-blue-600 text-xl">{req.data.package} <span className="text-sm">ใบ</span></p></div>
                      <div className="text-right"><p className="text-xs text-slate-500 font-bold mb-1 uppercase tracking-widest">ยอดโอน</p><p className="font-black text-emerald-600 text-xl">฿{req.data.amount}</p></div>
                    </div>
                  </div>
                  <button onClick={() => handleApproveTopup(req.id, req.data.userId, req.data.package, req.data.amount)} className="btn-cute w-full bg-emerald-500 text-white font-black py-4 rounded-xl shadow-lg shadow-emerald-500/30 flex items-center justify-center gap-2 text-lg">✅ ยืนยันว่ายอดเงินเข้าแล้ว</button>
                </div>
              </div>
            ))}
            {billingRequests.length === 0 && (
              <div className="col-span-full py-20 text-center text-slate-400"><span className="text-6xl mb-4 block">🎉</span><p className="text-xl font-bold">สุดยอด! ไม่มีรายการค้างตรวจสอบเลย</p></div>
            )}
          </div>
        </div>
      ) : null}
    
      {/* ======================================================== */}
      {/* 🕒 หน้าต่าง Pop-up: ประวัติแชท & ถังขยะ */}
      {/* ======================================================== */}
      {isHistoryModalOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-[2px] z-50 flex justify-center items-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden animate-fade-in-up">
            
            {/* หัว Pop-up */}
            <div className="bg-indigo-600 p-4 flex justify-between items-center text-white">
              <h2 className="text-lg font-bold flex items-center gap-2">🕒 ประวัติการสกัด & ถังขยะ</h2>
              <button onClick={() => setIsHistoryModalOpen(false)} className="hover:bg-white/20 p-2 rounded-full transition-colors leading-none">❌</button>
            </div>

            {/* ช่องค้นหา */}
            <div className="p-4 border-b border-gray-100 bg-gray-50/50">
              <input
                type="text"
                placeholder="🔍 ค้นหาจากชื่อ, เบอร์โทร, หรือข้อความ..."
                className="w-full p-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none transition-shadow text-sm"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>

            {/* รายการแชท */}
            <div className="p-4 flex-1 overflow-y-auto space-y-3 bg-gray-50">
              {allChats
                .filter(c => c.status === "processed" || c.status === "dismissed")
                .filter(c => c.message.includes(searchQuery) || (c.senderId && c.senderId.includes(searchQuery)))
                .length === 0 ? (
                  <div className="text-center text-gray-400 py-10 flex flex-col items-center">
                    <span className="text-4xl mb-2">📭</span>
                    <p>ไม่พบประวัติแชทที่ค้นหาครับ</p>
                  </div>
                ) : (
                  allChats
                    .filter(c => c.status === "processed" || c.status === "dismissed")
                    .filter(c => c.message.includes(searchQuery) || (c.senderId && c.senderId.includes(searchQuery)))
                    .map(chat => (
                      <div key={chat.id} className="bg-white p-4 rounded-xl border border-gray-200 shadow-sm flex justify-between items-start gap-4 hover:shadow-md transition-shadow">
                        <div className="flex-1 overflow-hidden">
                          <div className="flex gap-2 items-center mb-2">
                             <span className={`text-xs px-2 py-1 rounded-md font-bold ${chat.status === 'processed' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                               {chat.status === 'processed' ? '✅ สกัดแล้ว' : '🗑️ ลบแล้ว'}
                             </span>
                             <span className="text-xs text-gray-400">{chat.timestamp ? new Date(chat.timestamp.toDate()).toLocaleString('th-TH') : ''}</span>
                          </div>
                          <p className="text-sm text-gray-700 whitespace-pre-line line-clamp-3">{chat.message}</p>
                        </div>
                        <button
                          onClick={() => handleRestoreChat(chat.id)}
                          className="bg-indigo-50 hover:bg-indigo-600 text-indigo-700 hover:text-white px-3 py-2 rounded-lg font-bold text-sm transition-colors shadow-sm whitespace-nowrap flex items-center gap-1"
                        >
                          <span>♻️</span> ดึงกลับ
                        </button>
                      </div>
                    ))
                )}
            </div>
          </div>
        </div>
      )}
    
    </div>
  );
}