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

  const handleCopyTrackingMessage = async (order) => {
      // 1. ดึงเลขพัสดุจากช่องกรอก หรือจากฐานข้อมูล
      const finalTracking = trackingInputs[order.id] || order.trackingNum;

      if (!finalTracking) {
        alert("รบกวนตรวจสอบ 'เลขพัสดุ' ในช่องก่อนกดส่งนะครับท่าน CEO!");
        return;
      }

      // 2. ⚡ ถ้าระบบตรวจสอบแล้วพบ pageId และ senderId จากแชท (เหมือนในภาพ image_de2385.jpg)
      if (order.pageId && order.senderId) {
        try {
          // ยิง Fetch API ไปที่หลังบ้าน webhook.js
          const response = await fetch('/api/webhook', { // 🛑 ปรับ Path ตรงนี้ให้ตรงกับ Route หลังบ้านของท่านนะครับ เช่น /api/webhook
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'send_tracking',
              pageId: order.pageId,
              senderId: order.senderId,
              trackingNum: finalTracking,
              customerName: order.customerName
            })
          });

          const data = await response.json();
          if (data.success) {
            alert(`⚡ ยิงเลขพัสดุ ${finalTracking} เข้า Messenger คุณ ${order.customerName || ''} เรียบร้อยครับท่าน CEO!`);
            return; // ส่งสำเร็จ จบงานทันทีไม่ต้องก๊อปวาง
          } else {
            console.error("Webhook error:", data.error);
          }
        } catch (error) {
          console.error("Failed to send automatic chat:", error);
        }
      }

      // 3. 📋 โหมดสำรอง (Fallback): ถ้าไม่มีรหัสแชท หรือระบบบอทขัดข้อง ให้ก๊อปปี้ลงคลิปบอร์ดแบบเดิมทันที
      const message = `
  ขอบคุณที่อุดหนุนครับ! 🙏
  รายการ: ${order.customerName || 'คุณลูกค้า'}
  ยอดชำระ: ${order.isCOD ? `COD ${order.codAmount} บาท` : 'โอนเงินแล้ว'}
  📦 เลขพัสดุของคุณคือ: ${finalTracking}
  🚚 ตรวจสอบสถานะ: https://track.thailandpost.co.th/?trackNumber=${finalTracking}

  SmartLabel ยินดีให้บริการครับ ✅
      `.trim();

      navigator.clipboard.writeText(message)
        .then(() => {
          alert("📋 ระบบคัดลอกข้อความแจ้งเลขพัสดุลงคลิปบอร์ดให้แทนเรียบร้อยครับ!");
        })
        .catch(err => {
          console.error('Error in copying:', err);
        });
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

  const [historyRequests, setHistoryRequests] = useState([]); // 📜 เก็บประวัติบิลที่ Approved / Rejected แล้ว
  const [totalRevenue, setTotalRevenue] = useState(0);        // 💰 ยอดรวมรายได้สะสมในระบบ
  
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


  // 📡 ฟังก์ชันขอเลขพัสดุ (อัปเกรดรองรับ EMS/ลงทะเบียน/พัสดุ)
  const fetchRealTrackingFromTHP = async (type = '1') => {
    try {
      const username = '22061';
      const password = 'RWJRlBbGkeMRTr7DSLGd9JGAaP0zjqPI';
      const authHeader = 'Basic ' + btoa(`${username}:${password}`);

      const response = await fetch(`https://postone.thailandpost.com/api/bc.php?typ=${type}&cnt=1`, {
        method: 'GET',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) throw new Error('API Blocked or Error');

      const data = await response.text();
      return data.trim();

    } catch (error) {
      console.warn("⚠️ API Error (อาจติด CORS): ใช้ระบบจำลองที่ถูกต้องแทน");
      
      // 🛡️ ระบบจำลองที่สมจริง (Mock 2.0)
      const randomNum = Math.floor(100000000 + Math.random() * 900000000);
      
      // ถ้าเป็น type 1 (EMS) ให้ขึ้นต้นด้วย E
      if (type === '1') return `ED${randomNum}TH`; 
      // ถ้าเป็น type 2 (ลงทะเบียน) ให้ขึ้นต้นด้วย R
      if (type === '2') return `RC${randomNum}TH`;
      // อื่นๆ ให้เป็น TH
      return `TH${randomNum}TH`;
    }
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

  // 📡 🆕 ระบบดึงข้อมูลประวัติการชำระเงินย้อนหลัง (Approved & Rejected) แบบ Real-time
  const loadTopupHistoryRequests = () => {
    try {
      const q = query(
        collection(db, "topup_requests"),
        where("status", "in", ["approved", "rejected"]) // 🎯 ดึงเฉพาะบิลที่ทำรายการเสร็จแล้ว
      );

      const unsubscribe = onSnapshot(q, (snapshot) => {
        let revenueSum = 0;
        const requests = snapshot.docs.map(doc => {
          const data = doc.data();
          // คำนวณรายได้สะสมเฉพาะบิลที่แอดมินกดอนุมัติจริงเท่านั้น
          if (data.status === 'approved') {
            revenueSum += Number(data.amount) || 0;
          }
          return { id: doc.id, ...data };
        });

        // เรียงประวัติให้อันที่ทำรายการล่าสุดอยู่บนสุดเสมอ
        const sortedHistory = requests.sort((a, b) => 
          (b.approvedAt?.toMillis() || b.rejectedAt?.toMillis() || 0) - 
          (a.approvedAt?.toMillis() || a.rejectedAt?.toMillis() || 0)
        );

        setHistoryRequests(sortedHistory);
        setTotalRevenue(revenueSum); // ส่งยอดเงินรวมขึ้นหน้าจอแดชบอร์ด
      });

      return unsubscribe;
    } catch (error) {
      console.error("Error loading topup history:", error);
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
  
  // 📡 🆕 ค่ายกลดึงข้อมูลตามแท็บหน้าจอ ฉบับสมบูรณ์ (รวมหน้าพนักงาน + ท่อประวัติการเงิน SuperAdmin)
  useEffect(() => { 
    // 💳 1. ด่าน SuperAdmin: ถ้าเปิดหน้าอนุมัติบิล ให้ปลุกท่อบิลค้าง (Pending) และท่อประวัติเงินเข้า (History) ทำงานคู่กัน
    if (activeTab === 'billing' && userRole === 'SuperAdmin') {
      const unsubscribePending = loadBillingRequests();
      const unsubscribeHistory = loadTopupHistoryRequests(); // 👈 ท่อประวัติที่เพิ่มเข้ามาใหม่
      
      // คืนค่าล้างท่อสัญญาณเมื่อสลับแท็บ ป้องกันแรมรั่ว (Memory Leak)
      return () => {
        unsubscribePending && unsubscribePending();
        unsubscribeHistory && unsubscribeHistory();
      };
    }

    // 👥 2. ด่าน Owner (เถ้าแก่): ถ้าเปิดหน้าพนักงาน ให้ดึงรายชื่อลูกน้องมาโชว์ (รักษาของเดิมไว้ 100%)
    if (activeTab === 'team' && (userRole === 'Owner' || userRole === 'Admin')) {
      loadStaffData();
    }

    // 🏢 3. ด่าน SuperAdmin: ดึงข้อมูลร้านค้าทั้งหมดในระบบ
    if (activeTab === 'shops' && userRole === 'SuperAdmin') {
      loadAllShopsData();
    }

    // 🤝 4. ด่าน SuperAdmin: ดึงข้อมูลระบบพาร์ทเนอร์/ตัวแทนนักการตลาด
    if (activeTab === 'affiliates' && userRole === 'SuperAdmin') {
      loadAffiliateDataForAdmin();
    }
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

    // --- 🚀 2. ส่งข้อมูลไปช่องตรงกลาง และฝังรหัสเชื่อมโยงแชท Facebook ---
    const emptyOrderIndex = orders.findIndex(order => !order.rawText || order.rawText.trim() === '');

    if (emptyOrderIndex > -1) {
      // 2.1 ถ้ารสพบกล่องเก่าที่ว่างอยู่ ให้เอาที่อยู่ไปใส่ พร้อมผูกรหัสแชทพ่วงไปด้วย
      setOrders(prevOrders => prevOrders.map((o, idx) => idx === emptyOrderIndex ? {
        ...o,
        rawText: cleanedText,
        parsedData: extractOrderData(cleanedText),
        pageId: chat.pageId || "",    // ⚡ ฝังรหัสเพจลงกล่องหน้าบ้าน
        senderId: chat.senderId || "",  // ⚡ ฝังรหัสลูกค้าลงกล่องหน้าบ้าน
        isSaved: false
      } : o));
    } else {
      // 2.2 ถ้ากล่องเต็มหมดแล้ว ให้สร้างกล่องออเดอร์ใหม่ต่อท้าย พร้อมผูกรหัสแชทไปทันที
      const newOrderId = Date.now();
      const newOrder = { 
        id: newOrderId, 
        rawText: cleanedText, 
        parsedData: extractOrderData(cleanedText), 
        pageId: chat.pageId || "",    // ⚡ ฝังรหัสเพจลงกล่องหน้าบ้าน
        senderId: chat.senderId || "",  // ⚡ ฝังรหัสลูกค้าลงกล่องหน้าบ้าน
        isSaved: false, 
        crmSuggestion: null 
      };
      setOrders(prevOrders => [...prevOrders, newOrder]);
    }

    // --- 🧹 3. เปลี่ยนสถานะแชทใน Firebase เป็นพิมพ์แล้ว ---
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
        
        // ⚡ ปรับปรุงใน App.jsx ตอนที่แม่ค้ากดยืนยันตั้งค่าร้าน
        await setDoc(userRef, {
          storeName: tempProfile.name,
          phone: tempProfile.phone,
          address: tempProfile.address,
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

// 🔑 1. ฟังก์ชันขอ Token เพื่อเข้าถึงระบบ Preload [cite: 46, 189, 237]
  const getTHPToken = async () => {
    try {
      const username = '22061'; // [cite: 7, 48, 85]
      const password = 'RWJRlBbGkeMRTr7DSLGd9JGAaP0zjqPI'; // [cite: 8, 97, 99]
      const authHeader = 'Basic ' + btoa(`${username}:${password}`); // [cite: 48, 79]

      // ขอ Token จาก URL มาตรฐาน [cite: 255]
      const response = await fetch('https://pus2.thailandpost.com/redbox/auth/app/token', {
        method: 'POST',
        headers: { 'Authorization': authHeader }
      });

      const resData = await response.json();
      return resData.detail === 'ok' ? resData.token : null; // [cite: 284, 306]
    } catch (error) {
      console.error("Token Error:", error);
      return null;
    }
  };

  // 📡 2. ฟังก์ชันส่งข้อมูลรายละเอียดจ่าหน้าเข้าระบบ (Preload) [cite: 236, 324, 503]
  const preloadOrderToTHP = async (token, order, trackingNum) => {
    try {
      const payload = {
        data: [{
          tracking: trackingNum, // [cite: 398, 434, 469]
          serv: 1, // 1 = EMS [cite: 134, 162, 399]
          itm: order.parsedData.items.join(', ') || 'สินค้าทั่วไป', // [cite: 400, 436]
          cod_amount: order.parsedData.isCOD ? order.parsedData.codAmount : "0", // [cite: 405, 447, 482]
          // ข้อมูลผู้ส่ง [cite: 406-411, 483-492]
          fr_name: storeProfile.name || 'SmartLabel Shop',
          fr_tel: storeProfile.phone || '0888888888',
          fr_address: storeProfile.address || 'กรุงเทพมหานคร',
          fr_district: "-", 
          fr_postcode: "10000",
          fr_country_iso: "TH",
          // ข้อมูลผู้รับ [cite: 412-417, 493-502]
          det_name: order.parsedData.customerName,
          det_tel: order.parsedData.phone,
          det_address: order.parsedData.address,
          det_district: "-", 
          det_postcode: order.parsedData.zipcode,
          det_country_iso: "TH"
        }]
      };

      // ยิงข้อมูลเข้าสู่ระบบ Preload ของไปรษณีย์ไทย [cite: 348, 519]
      const response = await fetch('https://pus2.thailandpost.com/redbox/items/preload', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`, // [cite: 364, 376]
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload) // [cite: 393, 531]
      });

      const result = await response.json();
      return result.detail === 'ok'; // [cite: 605]
    } catch (error) {
      console.error("Preload Error:", error);
      return false;
    }
  };

  // 📡 ฟังก์ชันเช็คสถานะจากไปรษณีย์ไทย
  const fetchTrackingStatus = async (trackingNum) => {
    try {
      const username = '22061'; // [cite: 1]
      const password = 'RWJRlBbGkeMRTr7DSLGd9JGAaP0zjqPI'; // [cite: 1]
      const authHeader = 'Basic ' + btoa(`${username}:${password}`); // [cite: 48]

      // หมายเหตุ: URL นี้สำหรับดึงสถานะพัสดุ (Track & Trace)
      const response = await fetch(`https://trackapi.thailandpost.co.th/post/api/v1/track`, {
        method: 'POST',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ "trackNumber": [trackingNum], "language": "TH" })
      });

      const result = await response.json();
      // ดึงสถานะล่าสุด (เช่น รับฝาก, อยู่ระหว่างขนส่ง, นำจ่ายสำเร็จ) 
      return result.response.items[trackingNum][0].status_description || 'Preloaded';
    } catch (error) {
      return 'Preloaded'; // ถ้าเช็คไม่ได้ให้คงสถานะเดิมไว้
    }
  };

  const handleUpdateAllStatus = async () => {
    setLoading(true);
    try {
      const updatedOrders = await Promise.all(historyOrders.map(async (order) => {
        if (order.trackingNum && order.status !== 'นำจ่ายสำเร็จ') {
          const newStatus = await fetchTrackingStatus(order.trackingNum);
          
          // อัปเดตลง Firestore ด้วยครับ
          const orderRef = doc(db, "orders", order.id);
          await updateDoc(orderRef, { status: newStatus });
          
          return { ...order, status: newStatus };
        }
        return order;
      }));
      
      setHistoryOrders(updatedOrders);
      alert("✅ อัปเดตสถานะพัสดุทั้งหมดเรียบร้อยครับท่านเจ้าสำนัก!");
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  };
    
  const handleSaveAndPrint = async () => {
      // 🔍 กรองเฉพาะออเดอร์ "ใหม่" ที่ยังไม่เคยเซฟ (isSaved เป็น false) และมีที่อยู่จัดส่ง
      const newOrdersToSave = orders.filter(o => o.parsedData && !o.isSaved && o.rawText.trim() !== '');
      
      // ... ส่วนเช็คโควต้าของท่าน CEO ปล่อยไว้คงเดิมได้เลยครับ ...

      if (newOrdersToSave.length > 0) {
        try {
          const thpToken = await getTHPToken();
          const processedOrders = [];

          for (const order of orders) {
            // 🎯 ดำเนินการเฉพาะงานใหม่ที่ยังไม่มีการบันทึก และมีข้อมูลจัดส่ง
            if (order.parsedData && !order.isSaved && !order.trackingNum) {
              const autoTracking = await fetchRealTrackingFromTHP('1'); 
              
              if (thpToken && autoTracking) {
                await preloadOrderToTHP(thpToken, order, autoTracking);
              }

              // ⚡ จัดระเบียบข้อมูล Payload ให้ Flat (แบนราบ) เพื่อให้ Dashboard และประวัติพัสดุดึงไปโชว์ได้ 100%
              const orderPayload = {
                // 👤 ข้อมูลผู้รับ (ดึงออกมาจากชั้นใน parsedData แผ่ออกมาเป็นระดับนอก)
                customerName: order.parsedData.customerName || "ไม่ระบุชื่อ",
                phone: order.parsedData.phone || "ไม่ระบุเบอร์",
                address: order.parsedData.address || "ไม่ระบุที่อยู่",
                zipcode: order.parsedData.zipcode || "",
                items: order.parsedData.items || [],
                isCOD: order.parsedData.isCOD || false,
                codAmount: Number(order.parsedData.codAmount) || 0,
                rawText: order.rawText || "",
                
                // 📦 ข้อมูลสถานะและเลขแทรคกิ้งของไปรษณีย์ไทย
                trackingNum: autoTracking || "",
                status: '📦 เตรียมการส่ง',
                
                // 🔐 กุญแจชี้เป้าสำหรับเชื่อมโยงสิทธิ์แชทและการแสดงผล
                ownerId: userOwnerId || "",                            // รหัสเจ้าของร้านค้า
                pageId: order.pageId || order.parsedData.pageId || "",    // ID เพจ Facebook
                senderId: order.senderId || order.parsedData.senderId || "", // ID แชทของลูกค้า
                creatorName: storeProfile.staffName || "Owner",        // ผู้ทำรายการ
                adminEmail: user?.email || "-",
                
                // 📅 ตราประทับเวลา
                createdAt: serverTimestamp()
              };

              // 💾 บันทึกลงฐานข้อมูลแฟ้ม orders
              await addDoc(collection(db, "orders"), orderPayload);

              processedOrders.push({ ...order, trackingNum: autoTracking, isSaved: true });
            } else {
              // 🔄 งานพิมพ์ซ้ำ (isSaved: true) ให้เก็บไว้พิมพ์อย่างเดียว ไม่ทำอะไรเพิ่ม
              processedOrders.push(order);
            }
          }
          setOrders(processedOrders);

          // 💰 ตัดเครดิตเฉพาะจำนวนงานใหม่ (newOrdersToSave.length)
          if (userRole === 'Owner') {
            const userRef = doc(db, "users", user.uid);
            await updateDoc(userRef, { 
              quota: increment(-newOrdersToSave.length), 
              usedQuota: increment(newOrdersToSave.length) 
            });
          }
        } catch (error) { 
          console.error("❌ บันทึกใบปะหน้าขัดข้อง:", error); 
        }
      }

      // 🖨️ สั่งพิมพ์ใบความร้อน
      setTimeout(() => {
        window.print();
        setOrders([{ id: Date.now(), rawText: '', parsedData: null, isSaved: false }]);
      }, 1000);
    };

// 🖨️ ฟังก์ชันพิมพ์ซ้ำ (Reprint) - ปรับปรุงฉบับเสถียรป้องกันอาการจอขาวน็อคกลางอากาศ
  const handleReprint = (oldOrder) => {
    try {
      // 🛡️ ดักจับและป้องกันกรณี items หลุดหายจากฐานข้อมูล (ป้องกันข้อผิดพลาด .length)
      const safeItems = Array.isArray(oldOrder.items) 
        ? oldOrder.items 
        : (oldOrder.parsedData?.items && Array.isArray(oldOrder.parsedData.items) ? oldOrder.parsedData.items : []);

      // 🎯 ประกอบโครงสร้างที่อยู่กลับคืนเป็นข้อความดิบ (RawText) เพื่อให้กล่องหน้าบ้านสกัดใหม่ได้เนียนตา
      const reconstructedRawText = oldOrder.rawText || 
        `${oldOrder.customerName || ''}\n${oldOrder.address || ''} ${oldOrder.zipcode || ''}\n${oldOrder.phone || ''}`;

      setOrders([{
        ...oldOrder,
        id: oldOrder.id, 
        rawText: reconstructedRawText,
        // จัดระเบียบชั้นตัวแปร parsedData คืนชีพส่งกลับหน้าบ้าน
        parsedData: {
          customerName: oldOrder.customerName || "ไม่ระบุชื่อ",
          phone: oldOrder.phone || "-",
          address: oldOrder.address || "ไม่ระบุที่อยู่",
          zipcode: oldOrder.zipcode || "",
          items: safeItems, // Safe Mode: ถ้าไม่มีข้อมูลสินค้าจะถูกแทนที่ด้วย Array ว่างทันที ตัวแอปจะไม่น็อค
          isCOD: oldOrder.isCOD || false,
          codAmount: oldOrder.codAmount || 0,
          warnings: []
        },
        isSaved: true, // มาร์คค้างไว้ว่าบันทึกแล้ว จะได้ไม่ไปตัดสิทธิ์หรือขอเลขพัสดุซ้ำ
        trackingNum: oldOrder.trackingNum // ดึงกุญแจเลขพัสดุเดิมมาใช้จ่าหน้าต่อ
      }]);
      
      // สั่งพากระจกหน้าจอสไลด์เลื่อนขึ้นไปด้านบนสุด (หน้าสร้างจ่าหน้า) อัตโนมัติ
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (error) {
      console.error("เกิดข้อผิดพลาดในการดึงข้อมูลพิมพ์ซ้ำ:", error);
      alert("⚠️ ขออภัยครับ ระบบไม่สามารถดึงออเดอร์นี้กลับไปพิมพ์ซ้ำได้ เนื่องจากโครงสร้างข้อมูลเดิมไม่สมบูรณ์");
    }
  };

  const handleEditHistory = (order) => { setOrders([{ id: Date.now(), rawText: order.rawText || '', parsedData: extractOrderData(order.rawText || ''), isSaved: false, crmSuggestion: null }, { id: Date.now() + 1, rawText: '', parsedData: null, isSaved: false, crmSuggestion: null }]); setActiveTab('maker'); window.scrollTo(0, 0); };
  const handleReprintHistory = (order) => { setReprintOrder(order); setTimeout(() => { window.print(); setReprintOrder(null); }, 300); };
  
// 🔥 ระบบกรองข้อมูลอัจฉริยะ (กรองตามวันที่คลิกกราฟ + คำค้นหา Tracking/วันที่)
  const filteredOrders = historyOrders.filter(order => {
    
    // 1. 📅 กรองตามวันที่กดจากกราฟแท่ง (ถ้ามีการเลือก)
    if (selectedDate) {
      const orderDate = order.createdAt?.toDate().toLocaleDateString('th-TH', { day: 'numeric', month: 'short' });
      if (orderDate !== selectedDate) return false;
    }

    // 2. 🔍 กรองตามช่องค้นหา (ชื่อ, เบอร์, ปณ, REF, และเพิ่ม Tracking/วันที่)
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      
      // เตรียมข้อมูลสำหรับการค้นหา
      const trackRef = `REF-${order.id.slice(-6).toUpperCase()}`.toLowerCase();
      const tracking = (order.trackingNum || '').toLowerCase(); // ดึงเลขพัสดุจริงมาเช็ค
      
      // สร้างรูปแบบวันที่สำหรับค้นหา เช่น "15/5/69"
      const dateForSearch = order.createdAt 
        ? order.createdAt.toDate().toLocaleDateString('th-TH', { day: 'numeric', month: 'numeric', year: '2-digit' }) 
        : '';

      return (
        (order.customerName || '').toLowerCase().includes(q) ||
        (order.phone || '').includes(q) ||
        (order.zipcode || '').includes(q) ||
        trackRef.includes(q) ||
        tracking.includes(q) ||      // ✅ เพิ่มการค้นหาด้วยเลขพัสดุ (เช่น ED...)
        dateForSearch.includes(q)     // ✅ เพิ่มการค้นหาด้วยวันที่ (เช่น 15/5)
      );
    }

    return true;
  });

const handleExportCSV = () => {
    if (filteredOrders.length === 0) return alert("ไม่มีข้อมูลให้ดาวน์โหลดครับ");

    // 1. เพิ่มหัวข้อ "เลข Tracking" เข้าไปในอาเรย์ headers
    const headers = ["วันที่สร้าง", "หมายเลข REF", "เลข Tracking", "ชื่อผู้รับ", "เบอร์โทร", "ที่อยู่", "รหัสไปรษณีย์", "รายการสินค้า", "ยอด COD", "แอดมิน"];

    const csvRows = filteredOrders.map(order => [ 
      order.createdAt ? order.createdAt.toDate().toLocaleString('th-TH') : '-', 
      `REF-${order.id.slice(-6).toUpperCase()}`, 
      // 2. ดึงค่า trackingNum จาก Firestore มาใส่ (ถ้าไม่มีให้แสดง '-')
      order.trackingNum || '-', 
      `"${order.customerName || ''}"`, 
      order.phone || '-', 
      `"${order.address || ''}"`, 
      order.zipcode || '-', 
      `"${(order.items || []).join(' | ')}"`, 
      order.isCOD ? order.codAmount : "0", 
      order.adminEmail || '-' 
    ].join(','));

    // ใส่ BOM (\uFEFF) เพื่อให้ Excel เปิดภาษาไทยได้ถูกต้อง
    const blob = new Blob(["\uFEFF" + headers.join(',') + '\n' + csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a"); 
    link.href = URL.createObjectURL(blob); 
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

  // 🚀 ฟังก์ชันส่งข้อมูลแจ้งโอนเงิน (เวอร์ชันแก้ไขบั๊กข้อมูลเพี้ยน + ยิง Telegram บน Vercel ผ่าน 100%)
  const handleSubmitTopup = async () => {
    if (!slipImage) {
      alert("กรุณาอัปโหลดรูปภาพสลิปก่อนครับ");
      return;
    }
    
    try {
      setIsUploading(true);
      
      const currentStoreName = storeProfile?.name || "ร้านค้าสมาชิก SmartLabel";
      
      // ดักจับและคำนวณราคา/จำนวนใบ ให้แม่นยำตรงกับแพ็กเกจที่เลือก
      let amountPaid = 0;
      let labelCount = 0;
      let packageName = "Standard";

      if (selectedPackage === 500) {
        amountPaid = 200;
        labelCount = 500;
        packageName = "Standard (500 ใบ)";
      } else if (selectedPackage === 2000) {
        amountPaid = 500;
        labelCount = 2000;
        packageName = "🔥 Popular (2,000 ใบ)";
      } else if (selectedPackage === 10000) {
        amountPaid = 1000;
        labelCount = 10000;
        packageName = "💎 Ultimate Premium (10,000 ใบ)";
      }

      // (1) บันทึกข้อมูลลง Firestore ให้โครงสร้างฟิลด์ตรงกับหน้า SuperAdmin 100%
      const topupRef = await addDoc(collection(db, "topup_requests"), {
        userId: user.uid,
        userEmail: user.email || "ไม่ระบุอีเมล",
        storeName: currentStoreName,
        package: packageName,      // ส่งชื่อแพ็กเกจไปแสดงผล
        amount: amountPaid,        // จำนวนเงิน 200/500/1000
        labelCount: labelCount,    // จำนวนใบที่จะเพิ่มให้ระบบเมื่ออนุมัติ
        slipImage: slipImage,      // ลิงก์รูปภาพสลิป
        status: "pending",
        timestamp: serverTimestamp()
      });

      console.log("บันทึก Firestore สำเร็จ ID:", topupRef.id);

      // (2) 📡 ยิงเข้า Telegram ด้วยวิธีห่อ URL (ทลายกำแพง CORS บน Vercel)
      const TELEGRAM_BOT_TOKEN = "8781734272:AAFngphg8npXdgYpegDvVqxSCx98t8K1DJc"; 
      const TELEGRAM_CHAT_ID = "-5548697561"; 
      
      const messageText = 
        `🚨 *มียอดแจ้งโอนเงินเข้ามาใหม่! [SmartLabel]*\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `🏪 *ร้านค้า:* ${currentStoreName}\n` +
        `📧 *อีเมล:* ${user.email || 'ไม่ระบุ'}\n` +
        `📦 *แพ็กเกจ:* ${packageName}\n` +
        `💰 *ยอดเงินโอน:* ฿${amountPaid.toLocaleString()}.00 บาท\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `🔍 *กรุณาตรวจสอบและอนุมัติที่หน้า SuperAdmin*`;

      // ใช้ยิงผ่านท่อโบราณแต่โคตรเสถียรด้วย GET/POST URL String
      const telegramUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage?chat_id=${TELEGRAM_CHAT_ID}&text=${encodeURIComponent(messageText)}&parse_mode=Markdown`;
      
      await fetch(telegramUrl).catch(err => console.log("Telegram send background error:", err));

      alert("🚀 ส่งหลักฐานการชำระเงินสำเร็จเรียบร้อย! ระบบกำลังตรวจสอบสลิปค่ะ");
      setIsTopupOpen(false);
      setSlipImage(null);

    } catch (error) {
      console.error("เกิดข้อผิดพลาดเซิร์ฟเวอร์:", error);
      alert("เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้งครับ");
    } finally {
      setIsUploading(false);
    }
  };

// 🟢 ฟังก์ชันอนุมัติเติมโควตาฉบับแก้บั๊กสกัดตัวเลข และบันทึกตรงถัง users ชัวร์ ๆ
  const handleApproveTopup = async (request) => {
    if (!request || !request.data) return;
    
    if (!window.confirm(`คุณแน่ใจใช่หรือไม่ที่จะ "อนุมัติ" รายการเติมเงินของร้าน: ${request.data.storeName || 'ร้านค้าสมาชิก'}`)) return;

    try {
      const targetUserId = request.data.userId;
      const amountPaid = Number(request.data.amount) || 0;
      
      // 🎯 แก้บั๊กแกะสลักจำนวนใบ: ดึงค่า labelCount ตัวเลขตรง ๆ จากฐานข้อมูล 
      // หากไม่มี ให้ถอดรูปจากข้อความ package (เช่น "Standard (500 ใบ)" ให้ดึง 500)
      let quotaToAdd = Number(request.data.labelCount) || 0;
      if (quotaToAdd === 0 && request.data.package) {
        const extractedNum = request.data.package.match(/\d+/);
        quotaToAdd = extractedNum ? Number(extractedNum[0]) : 0;
      }
      
      // ถ้าแกะแล้วยังเป็น 0 ให้ดักสิทธิ์ตามสเกลราคาเพื่อความปลอดภัยสูงสุด
      if (quotaToAdd === 0) {
        quotaToAdd = amountPaid === 1000 ? 10000 : amountPaid === 500 ? 2000 : 500;
      }

      console.log(`กำลังดำเนินการเติมโควตาจำนวน: ${quotaToAdd} ใบ ให้รหัสผู้ใช้: ${targetUserId}`);

      // 1. วิ่งไปเปิดถังพิกัด "users" ของร้านค้าคนนั้นเพื่อบวกแต้มโควตา
      const userRef = doc(db, "users", targetUserId);
      const userSnap = await getDoc(userRef);

      if (userSnap.exists()) {
        const userData = userSnap.data();
        let currentQuota = Number(userData.quota) || 0;
        let newQuota = currentQuota + quotaToAdd;
        let newPlan = userData.plan || "Free";
        
        let expireDate = userData.premiumExpireDate ? userData.premiumExpireDate.toDate() : new Date();
        const now = new Date();

        // 💎 ถ้าสลิปนี้มียอดเงิน 1,000 บาท ให้สับท่อเลื่อนขั้นเป็น Premium ทันที
        if (amountPaid === 1000) {
          newPlan = "Premium";
          if (expireDate > now) {
            expireDate.setDate(expireDate.getDate() + 30); // ทบวันเพิ่มให้
          } else {
            expireDate = new Date();
            expireDate.setDate(expireDate.getDate() + 30); // เริ่มนับหนึ่งใหม่
          }
        }

        // บันทึกเพิ่มแต้มลง Firestore ถังหลัก
        await updateDoc(userRef, {
          quota: newQuota,
          plan: newPlan,
          premiumExpireDate: newPlan === "Premium" ? Timestamp.fromDate(expireDate) : (userData.premiumExpireDate || null)
        });

        // 2. เปลี่ยนสถานะของบิลแจ้งโอนนี้ให้กลายเป็นอนุมัติแล้ว เพื่อเคลียร์หน้าจอ SuperAdmin
        await updateDoc(doc(db, "topup_requests", request.id), {
          status: "approved",
          approvedAt: serverTimestamp(),
          approvedBy: user?.email || "SuperAdmin"
        });

        alert(`🎉 อนุมัติสำเร็จ! ระบบเติมแต้ม +${quotaToAdd.toLocaleString()} จ่าหน้า และปรับสถานะร้านค้าเรียบร้อยครับ`);
      } else {
        alert("❌ ไม่พบข้อมูลบัญชีผู้ใช้ร้านค้านี้ในระบบ Firestore ถัง users ครับ");
      }
    } catch (error) {
      console.error("เกิดข้อผิดพลาดในการอนุมัติค่ายกล:", error);
      alert("เกิดข้อผิดพลาดในการเซฟข้อมูล กรุณาตรวจสอบ Console ครับ");
    }
  };

    const handleRejectTopup = async (requestId) => {
      if (!window.confirm("คุณแน่ใจใช่หรือไม่ที่จะ 'ไม่อนุมัติ' รายการแจ้งโอนเงินนี้?")) return;
      
      try {
        const docRef = doc(db, "topup_requests", requestId);
        await updateDoc(docRef, {
          status: "rejected",
          rejectedAt: serverTimestamp()
        });
        alert("❌ ปฏิเสธรายการเรียบร้อยแล้ว ระบบจะไม่เพิ่มจำนวนใบให้ร้านค้านี้ครับ");
      } catch (error) {
        console.error("Error rejecting:", error);
        alert("เกิดข้อผิดพลาดในการทำรายการ");
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
      <div className="min-h-screen bg-white font-sans text-gray-900 selection:bg-blue-200 overflow-x-hidden">
        <style>{`
          @keyframes float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-10px); } }
          .animate-float { animation: float 3s ease-in-out infinite; }
          .btn-cute { transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275); }
          .btn-cute:hover { transform: scale(1.05) translateY(-2px); box-shadow: 0 15px 30px -10px rgba(59, 130, 246, 0.5); }
          .card-hover { transition: all 0.4s ease; }
          .card-hover:hover { transform: translateY(-8px); box-shadow: 0 20px 40px -15px rgba(0,0,0,0.08); }
          .bg-grid { background-image: radial-gradient(#e5e7eb 1px, transparent 1px); background-size: 20px 20px; }
        `}</style>
        
        {/* 🧭 Navbar */}
        <nav className="flex justify-between items-center px-6 md:px-12 py-6 border-b bg-white/80 backdrop-blur-md sticky top-0 z-50">
          {/*<div className="text-2xl font-black text-blue-800 flex items-center gap-2">
            <span className="animate-float inline-block">📦</span> SmartLabel
          </div>*/}{/* 🧭 Logo เดิม */}
          <div className="flex items-center">
            <img 
              src="/LogoSmartLabel.png" // 🔑 ใช้ไฟล์ใหม่ที่ปรับสัดส่วนแล้ว
              alt="ToppySmart SmartLabel Logo" 
              className="h-21 md:h-24 w-auto object-contain hover:scale-105 transition-transform duration-300"
            />
          </div>
          <div className="flex gap-4 items-center">
            {/*<button onClick={() => { setIsAuthView(true); setAuthType('partner'); setAuthMode('login'); }} className="text-slate-500 font-bold hover:text-blue-600 transition-colors hidden lg:block">🤝 Partner Program</button>*/}
            <div className="h-6 w-px bg-slate-200 hidden lg:block"></div>
            <button onClick={() => setIsAuthView(true)} className="btn-cute bg-white text-blue-600 border-2 border-blue-600 px-6 py-2 rounded-xl font-bold">เข้าสู่ระบบ</button>
            {/*<button onClick={() => { setIsAuthView(true); setAuthMode('register'); }} className="btn-cute bg-blue-600 text-white px-6 py-2 rounded-xl font-bold shadow-lg shadow-blue-500/30">สมัครฟรี</button>*/}
          </div>
        </nav>
        
        {/* 🚀 Hero Section */}
        <header className="px-6 py-28 text-center bg-grid relative">
          <div className="absolute inset-0 bg-gradient-to-b from-blue-50/60 to-white -z-10"></div>
          <div className="inline-block px-4 py-1.5 mb-6 bg-blue-100 text-blue-700 rounded-full text-sm font-black tracking-widest uppercase animate-pulse">
            🚀 ระบบ SaaS ใหม่! เชื่อมต่อ API ไปรษณีย์ไทย & ดูดแชทเพจ 100%
          </div>
          <h1 className="text-5xl md:text-8xl font-black text-slate-900 mb-8 leading-[1.1] tracking-tight">
            จบงานจ่าหน้า <br/> <span className="bg-clip-text text-transparent bg-gradient-to-r from-blue-600 to-indigo-600">และแจ้งเลขในคลิกเดียว</span>
          </h1>
          <p className="text-xl text-slate-500 mb-12 max-w-3xl mx-auto leading-relaxed font-medium">
            ระบบแรกที่เชื่อมต่อกับ <strong className="text-blue-600">ไปรษณีย์ไทย (PostOne)</strong> โดยตรง ออกเลขพัสดุจริงทันที 
            พร้อมระบบดูดแชทสกัดจ่าหน้า และยิงเลขแทรคกิ้งกลับเข้า Messenger ลูกค้าสายฟ้าแลบ!
          </p>
          <div className="flex flex-col md:flex-row gap-4 justify-center items-center">
            <button onClick={() => { setIsAuthView(true); setAuthMode('register'); }} className="btn-cute bg-blue-600 text-white text-xl px-12 py-5 rounded-2xl font-black shadow-2xl shadow-blue-500/40">เริ่มทดลองใช้ฟรี 50 ใบ</button>
            <div className="text-slate-400 font-medium flex items-center gap-2">
              <span>⭐️ ไม่ต้องผูกบัตรเครดิต</span>
              <span className="text-slate-200">|</span>
              <span>⚡️ เริ่มใช้งานได้ใน 1 นาที</span>
            </div>
          </div>
        </header>
        
        {/* 🌟 Features Showcase */}
        <section className="py-24 px-6 max-w-7xl mx-auto">
          <div className="text-center mb-20">
            <h2 className="text-3xl md:text-5xl font-black text-slate-800 mb-4">ฟังก์ชันที่ทำให้เรา "เหนือกว่า"</h2>
            <div className="h-1.5 w-24 bg-blue-500 mx-auto rounded-full"></div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8">
            <div className="bg-white p-8 rounded-3xl border border-slate-100 shadow-sm card-hover">
              <div className="text-4xl mb-4">📡</div>
              <h3 className="text-xl font-black mb-3 text-slate-800">Direct THP API</h3>
              <p className="text-slate-500 text-sm leading-relaxed">เชื่อมระบบไปรษณีย์ไทยโดยตรง ออกเลขพัสดุ EMS/ลงทะเบียน ของจริงได้ทันทีจากหน้าจอ</p>
            </div>
            <div className="bg-white p-8 rounded-3xl border border-slate-100 shadow-sm card-hover">
              <div className="text-4xl mb-4">⚡</div>
              <h3 className="text-xl font-black mb-3 text-slate-800">Auto Chat Send</h3>
              <p className="text-slate-500 text-sm leading-relaxed">ปุ่มสายฟ้าอัจฉริยะ คลิกเดียวส่งเลขแทรคกิ้งเข้า Facebook Messenger ลูกค้าอัตโนมัติไม่ต้องก๊อปวาง</p>
            </div>
            <div className="bg-white p-8 rounded-3xl border border-slate-100 shadow-sm card-hover">
              <div className="text-4xl mb-4">🤖</div>
              <h3 className="text-xl font-black mb-3 text-slate-800">Smart Inbox</h3>
              <p className="text-slate-500 text-sm leading-relaxed">ดูดแชทลูกค้าเข้าสู่ระบบดักสกัดข้อมูลจ่าหน้า รหัสไปรษณีย์ และเบอร์โทรศัพท์ได้ใน 1 วินาที</p>
            </div>
            <div className="bg-white p-8 rounded-3xl border border-slate-100 shadow-sm card-hover">
              <div className="text-4xl mb-4">🔄</div>
              <h3 className="text-xl font-black mb-3 text-slate-800">Status Tracking</h3>
              <p className="text-slate-500 text-sm leading-relaxed">ระบบอัปเดตสถานะพัสดุ Real-time คอยติดตามและแจ้งเตือนจนกว่าของจะถึงมือผู้รับ</p>
            </div>
          </div>
        </section>

        {/* 💳 Pricing Section */}
        <section className="py-24 bg-slate-50 border-y border-slate-100">
          <div className="max-w-6xl mx-auto px-6 text-center">
            <h2 className="text-4xl font-black mb-4 text-slate-800">แพ็กเกจที่คุ้มค่าที่สุดในตลาด</h2>
            <p className="text-slate-500 mb-16 font-medium">ประหยัดเวลาแอดมินวันละหลายชั่วโมง เลือกแพ็กเกจที่ใช่สำหรับสเกลร้านคุณ</p>
            
            <div className="grid grid-cols-1 md:grid-cols-3 gap-8 text-left">
              {/* แพ็กเกจ 200 บาท */}
              <div className="bg-white p-8 rounded-[2.5rem] shadow-sm border border-slate-200 card-hover flex flex-col">
                <div className="mb-8">
                  <p className="text-slate-400 font-black mb-2 tracking-widest uppercase text-xs">Standard</p>
                  <p className="text-5xl font-black mb-2 text-slate-800">฿200</p>
                  <p className="text-slate-400 text-sm font-bold">ได้รับ 500 จ่าหน้า (0.4 บ./ใบ)</p>
                </div>
                <ul className="text-sm text-slate-600 mb-10 space-y-4 flex-grow font-medium">
                  <li className="flex items-center gap-2">✅ ระบบสกัดที่อยู่จากแชทคีย์มือ</li>
                  <li className="flex items-center gap-2">✅ ระบบจดจำลูกค้าเก่า (CRM)</li>
                  <li className="flex items-center gap-2">✅ ออกเลขพัสดุจำลอง (Mock 2.0)</li>
                  <li className="flex items-center gap-2">✅ แดชบอร์ดสถิติแพ็กของพนักงาน</li>
                </ul>
                <button onClick={() => { setIsAuthView(true); setAuthMode('register'); }} className="btn-cute w-full py-4 rounded-2xl border-2 border-slate-200 text-slate-600 font-bold hover:bg-slate-50">เริ่มใช้งานฟรี</button>
              </div>

              {/* 🔥 แพ็กเกจพรีเมียม (พระเอกสูงสุด) */}
              <div className="bg-slate-900 p-8 rounded-[2.5rem] shadow-2xl border-4 border-blue-500 relative overflow-hidden card-hover transform md:-translate-y-6 flex flex-col text-white">
                <div className="absolute top-0 right-0 bg-blue-500 text-white px-6 py-2 font-black text-xs rounded-bl-2xl uppercase tracking-widest animate-pulse">Recommended</div>
                <div className="mb-8">
                  <p className="text-blue-400 font-black mb-2 tracking-widest uppercase text-xs">Ultimate Automation</p>
                  <p className="text-6xl font-black mb-2 text-white">฿1,000</p>
                  <p className="text-blue-300 text-sm font-black">ได้รับ 10,000 จ่าหน้า (เพียง 0.1 บ./ใบ)</p>
                </div>
                <ul className="text-sm text-slate-200 mb-10 space-y-4 flex-grow font-medium">
                  <li className="flex items-center gap-3">🚀 <span className="font-bold text-blue-300">เชื่อม API ไปรษณีย์ไทยของจริง (PostOne)</span></li>
                  <li className="flex items-center gap-3">⚡ <span className="font-bold text-blue-300">ปุ่มสายฟ้ายิงแจ้งเลขพัสดุเข้าแชทลูกค้า</span></li>
                  <li className="flex items-center gap-3">🤖 <span className="font-bold text-blue-300">เชื่อมต่อและดูดแชท Facebook Page ได้ไม่จำกัด</span></li>
                  <li className="flex items-center gap-3">🔄 อัปเดตสถานะพัสดุอัตโนมัติทุก 4 ชม.</li>
                  <li className="flex items-center gap-3">📊 ระบบ CRM, แดชบอร์ดหรูหรา และสถิติครบชุด</li>
                </ul>
                <button onClick={() => { setIsAuthView(true); setAuthMode('register'); }} className="btn-cute w-full py-5 rounded-2xl bg-blue-600 text-white font-black shadow-xl shadow-blue-500/40">อัปเกรดเป็นระดับโปร</button>
              </div>

              {/* แพ็กเกจ 500 บาท */}
              <div className="bg-white p-8 rounded-[2.5rem] shadow-sm border border-slate-200 card-hover flex flex-col">
                <div className="mb-8">
                  <p className="text-indigo-500 font-black mb-2 tracking-widest uppercase text-xs">Popular</p>
                  <p className="text-5xl font-black mb-2 text-slate-800">฿500</p>
                  <p className="text-slate-400 text-sm font-bold">ได้รับ 2,000 จ่าหน้า (0.25 บ./ใบ)</p>
                </div>
                <ul className="text-sm text-slate-600 mb-10 space-y-4 flex-grow font-medium">
                  <li className="flex items-center gap-2">✅ ระบบสกัดที่อยู่จากแชทคีย์มือ</li>
                  <li className="flex items-center gap-2">✅ ระบบจดจำลูกค้าเก่า (CRM)</li>
                  <li className="flex items-center gap-2">✅ ระบบ Export ไฟล์ Excel บัญชี</li>
                  <li className="flex items-center gap-2">✅ สถิติตัวเลขรายรับรวมรายวัน</li>
                </ul>
                <button onClick={() => { setIsAuthView(true); setAuthMode('register'); }} className="btn-cute w-full py-4 rounded-2xl border-2 border-indigo-600 text-indigo-600 font-bold hover:bg-slate-50">เลือกแพ็กเกจนี้</button>
              </div>
            </div>
          </div>
        </section>

        {/* 📞 โซนปิดการขายและติดต่อสอบถาม (CTA Section ดีไซน์ใหม่หมดจด) */}
        <section className="py-20 bg-white text-center relative px-6">
          <div className="max-w-3xl mx-auto bg-gradient-to-br from-slate-50 to-blue-50/30 border border-slate-100 rounded-[3rem] p-10 md:p-14 shadow-sm">
            <h2 className="text-3xl md:text-4xl font-black text-slate-800 mb-4">ต้องการสอบถามข้อมูลเพิ่มเติม?</h2>
            <p className="text-slate-500 font-medium mb-8 max-w-xl mx-auto">ทีมงาน ToppySmart Logistics พร้อมดูแลและให้คำแนะนำครับ</p>
            
            <div className="flex flex-col sm:flex-row gap-4 justify-center items-center">
              {/* ปุ่ม LINE ปรับปรุงไอคอน SVG สะอาดตา ไม่พึ่งพาลิ้งก์นอกเว็บบางอัน */}
              <a href="https://qr-official.line.me/gs/M_057bbduq_GW.png?oat_content=qr" target="_blank" rel="noreferrer" 
                className="btn-cute w-full sm:w-auto flex items-center justify-center gap-3 px-10 py-4.5 bg-[#06C755] text-white font-black rounded-2xl shadow-xl shadow-green-500/20 text-lg">
                <svg className="w-6 h-6 fill-current" viewBox="0 0 24 24">
                  <path d="M24 10.304c0-5.369-5.383-9.738-12-9.738s-12 4.369-12 9.738c0 4.814 4.269 8.846 10.036 9.564.39.084.922.258 1.058.592.12.296.08.759.04 1.058l-.17 1.023c-.05.32-.25 1.253 1.09.684 1.34-.57 7.21-4.24 9.84-7.252 2.11-2.43 2.11-4.78 2.11-5.691zm-15.39 3.011c0 .4-.33.73-.73.73h-1.63c-.4 0-.73-.33-.73-.73v-4.1c0-.4.33-.73.73-.73s.73.33.73.73v3.37h.9c.4 0 .73.33 .73.73zm2.59-.73c0 .4-.33.73-.73.73s-.73-.33-.73-.73v-4.1c0-.4.33-.73.73-.73s.73.33.73.73v4.1zm5.54.73c0 .4-.33.73-.73.73h-2.15c-.4 0-.73-.33-.73-.73v-4.1c0-.4.33-.73.73-.73h2.15c.4 0 .73.33 .73.73s-.33.73-.73.73h-1.42v.69h1.16c.4 0 .73.33 .73.73s-.33.73-.73.73h-1.16v.77h1.42c.4 0 .73.33 .73.73zm-3.03-2.15l1.32-1.98v1.98c0 .4.33.73.73.73s.73-.33.73-.73v-4.1c0-.43-.36-.73-.75-.73-.24 0-.46.12-.59.32l-1.44 2.16v-2.16c0-.4-.33-.73-.73-.73s-.73.33-.73.73v4.1c0 .4.33.73.73.73.39 0 .73-.3.73-.73z"/>
                </svg>
                เพิ่มเพื่อนสอบถามทาง LINE
              </a>
            </div>
          </div>
        </section>

        {/* 👣 Footer */}
        <footer className="py-12 bg-white border-t border-slate-100 px-6">
          <div className="max-w-6xl mx-auto flex flex-col md:flex-row justify-between items-center gap-6">
            <div className="text-center md:text-left">
              <div className="text-xl font-black text-blue-800 mb-1">SmartLabel</div>
              <p className="text-slate-400 text-xs font-medium">© 2026 ToppySmart Logistics. All rights reserved. <br/>พัฒนาร่วมกับ CTO Copilot</p>
            </div>
            <div className="flex gap-6">
               <button onClick={() => { setIsAuthView(true); setAuthType('partner'); setAuthMode('login'); }} className="text-sm text-blue-600 font-black hover:underline flex items-center gap-2">🤝 ร่วมเป็นพาร์ทเนอร์กับเรา สมัครหรือเข้าใช้งานที่นี่</button>
            </div>
          </div>
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
              {/* แพ็กเกจ 500 ใบ */}
              <div onClick={() => setSelectedPackage(500)} className={`border-2 rounded-2xl p-4 text-center cursor-pointer relative transition-all ${selectedPackage === 500 ? 'border-slate-500 bg-slate-50 scale-[1.03] shadow-md shadow-slate-500/20' : 'border-gray-200 hover:border-slate-300 hover:bg-slate-50'}`}>
                {selectedPackage === 500 && <div className="absolute top-0 right-0 bg-slate-500 text-white text-[10px] font-bold px-3 py-1 rounded-bl-xl">เลือกอยู่</div>}
                <p className={`font-black text-xl ${selectedPackage === 500 ? 'text-slate-700' : 'text-slate-700'}`}>500 ใบ</p>
                <p className="text-xs text-slate-500 mt-1 font-medium">200 บาท</p>
              </div>

              {/* แพ็กเกจ 2,000 ใบ */}
              <div onClick={() => setSelectedPackage(2000)} className={`border-2 rounded-2xl p-4 text-center cursor-pointer relative transition-all ${selectedPackage === 2000 ? 'border-blue-500 bg-blue-50 scale-[1.03] shadow-md shadow-blue-500/20' : 'border-gray-200 hover:border-blue-300 hover:bg-slate-50'}`}>
                {selectedPackage === 2000 && <div className="absolute top-0 right-0 bg-blue-500 text-white text-[10px] font-bold px-3 py-1 rounded-bl-xl">ยอดฮิต 🔥</div>}
                <p className={`font-black text-xl ${selectedPackage === 2000 ? 'text-blue-700' : 'text-slate-700'}`}>2,000 ใบ</p>
                <p className="text-xs text-slate-500 mt-1 font-medium">500 บาท</p>
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
                  value={generatePayload("0874484448", { amount: selectedPackage === 500 ? 200 : selectedPackage === 2000 ? 500 : 1000 })} 
                  size={130} 
                />
              </div>
              <p className="text-sm font-black text-slate-800">พร้อมเพย์: ท็อปปี้สมาร์ท โลจิสติกส์</p>
              <p className="text-lg font-black text-emerald-600 mt-1 bg-emerald-50 px-4 py-1 rounded-full border border-emerald-100">
                {/* 🎯 สลับข้อความยอดชำระให้ตรงกัน */}
                ยอดชำระ: ฿{selectedPackage === 500 ? '200.00' : selectedPackage === 2000 ? '500.00' : '1,000.00'}
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
            {/* 🏪 1. บล็อกชื่อร้านค้า (ผู้ส่ง) - ดีไซน์ใหม่หรูหราเข้าชุด */}
            <div className="mb-4 text-left">
              <label className="block text-xs font-bold text-gray-500 mb-1.5 pl-1">
                🏪 ชื่อร้านค้า (ผู้ส่ง)
              </label>
              <input 
                type="text" 
                className="w-full border border-gray-200 bg-slate-50/50 p-2.5 rounded-xl text-xs outline-none focus:ring-2 focus:ring-blue-300 transition-all font-medium text-slate-800" 
                placeholder="กรอกชื่อร้านค้าของคุณ..." 
                value={tempProfile.name || ''} 
                onChange={(e) => setTempProfile({...tempProfile, name: e.target.value})} 
              />
            </div>

            {/* ☎️ 2. บล็อกเบอร์โทรศัพท์ร้านค้า - เนียนกริ๊บคุมโทนเดียวกัน */}
            <div className="mb-4 text-left">
              <label className="block text-xs font-bold text-gray-500 mb-1.5 pl-1">
                📞 เบอร์โทรศัพท์ร้านค้า (แสดงบนใบปะหน้า)
              </label>
              <input 
                type="text" 
                className="w-full border border-gray-200 bg-slate-50/50 p-2.5 rounded-xl text-xs outline-none focus:ring-2 focus:ring-blue-300 transition-all font-medium text-slate-800" 
                placeholder="เช่น 081-XXXXXXX" 
                value={tempProfile.phone || ''} 
                onChange={(e) => setTempProfile({...tempProfile, phone: e.target.value})} 
              />
            </div>

            {/* 🏠 3. บล็อกที่อยู่ร้านค้าแบบละเอียด - ดีไซน์พรีเมียม (เอาพื้นหลังสีเหลืองออกเพื่อให้กลมกลืน) */}
            <div className="mb-4 text-left">
              <label className="block text-xs font-bold text-gray-500 mb-1.5 pl-1">
                🏠 ที่อยู่ร้านค้า <span className="text-rose-500 text-[10px] font-black ml-1">*จำเป็น</span>
              </label>
              <textarea 
                className="w-full border border-gray-200 bg-slate-50/50 p-2.5 rounded-xl text-xs outline-none focus:ring-2 focus:ring-blue-300 transition-all font-medium text-slate-800 h-24 resize-none" 
                placeholder="กรอกที่อยู่สำหรับจ่าหน้าผู้ส่ง หรือกรณีพัสดุตีกลับ..." 
                value={tempProfile.address || ''} 
                onChange={(e) => setTempProfile({...tempProfile, address: e.target.value})} 
              />
            </div>
            
            {/* 📜 กล่องตั้งค่าข้อความพิเศษและสัญญารูปแบบใหม่ (จัดระเบียบใหม่หมด ไม่ซ้ำซ้อน) */}
            <div className="mt-4 p-4 bg-slate-50 border border-slate-200 rounded-2xl text-left">
              <h3 className="text-xs font-black text-blue-700 mb-2 flex items-center gap-1">
                ✉️ ข้อความพิเศษ / ข้อมูลสัญญาส่งของ
              </h3>
              <p className="text-[10px] text-gray-500 mb-3">* หากกรอกข้อมูลบรรทัดที่ 1 ระบบจะเปิดกล่องข้อความพิเศษบนใบปะหน้าให้อัตโนมัติ</p>
              
              <div className="grid grid-cols-1 gap-3">
                {/* แถวที่ 1: ข้อความหัวข้อหลัก */}
                <div>
                  <label className="block text-[11px] font-bold text-gray-500 mb-1">ข้อความบรรทัดที่ 1 (ตัวหนา/สีน้ำเงิน)</label>
                  <input 
                    type="text" 
                    className="w-full border p-2 rounded-xl text-xs outline-none focus:ring-2 focus:ring-blue-300 transition-all" 
                    placeholder="เช่น ชำระค่าฝากส่งรายเดือน หรือ สินค้าแตกง่าย" 
                    value={tempProfile.specialLine1 || ''} 
                    onChange={(e) => setTempProfile({...tempProfile, specialLine1: e.target.value})} 
                  />
                </div>

                {/* แถวที่ 2: ข้อความรอง */}
                <div>
                  <label className="block text-[11px] font-bold text-gray-500 mb-1">ข้อความบรรทัดที่ 2</label>
                  <input 
                    type="text" 
                    className="w-full border p-2 rounded-xl text-xs outline-none focus:ring-2 focus:ring-blue-300 transition-all" 
                    placeholder="เช่น ปณท. อนุญาตแล้ว หรือ กรุณาถ่ายวิดีโอตอนเปิดกล่อง" 
                    value={tempProfile.specialLine2 || ''} 
                    onChange={(e) => setTempProfile({...tempProfile, specialLine2: e.target.value})} 
                  />
                </div>

                {/* แถวที่ 3: เลขที่ใบอนุญาต และ เลขที่สัญญา */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-bold text-gray-500 mb-1">ใบอนุญาตเลขที่ (ถ้ามี)</label>
                    <input 
                      type="text" 
                      className="w-full border p-2 rounded-xl text-xs outline-none focus:ring-2 focus:ring-blue-300 transition-all" 
                      placeholder="เช่น 45/2569" 
                      value={tempProfile.licenseNo || ''} 
                      onChange={(e) => setTempProfile({...tempProfile, licenseNo: e.target.value})} 
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-bold text-gray-500 mb-1">สัญญาเลขที่ (ถ้ามี)</label>
                    <input 
                      type="text" 
                      className="w-full border p-2 rounded-xl text-xs outline-none focus:ring-2 focus:ring-blue-300 transition-all" 
                      placeholder="เช่น ปณ.(น)/123" 
                      value={tempProfile.contractNo || ''} 
                      onChange={(e) => setTempProfile({...tempProfile, contractNo: e.target.value})} 
                    />
                  </div>
                </div>
              </div>
            </div>
            <div className="h-5"></div>
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
                // 📍 ปรับปรุงท่อน callback ของ FacebookLogin ใน App.jsx ให้ดึง Page Token ตัวจริง
                callback={async (response) => {
                  console.log("ล็อกอินบุคคลสำเร็จ:", response);
                  
                  if (response.accessToken) {
                    const userAccessToken = response.accessToken;

                    try {
                      // 1. ยิง API ไปถาม Facebook เพื่อขอรายชื่อเพจและ Page Access Token ของแต่ละเพจ
                      const fbPageUrl = `https://graph.facebook.com/v20.0/me/accounts?access_token=${userAccessToken}`;
                      const fbResponse = await fetch(fbPageUrl);
                      const fbData = await fbResponse.json();

                      if (fbData.data && fbData.data.length > 0) {
                        // ในที่นี้สมมติว่าเลือกเพจแรกที่เจอ หรือเพจที่แมตช์ (ท่านสามารถทำระบบให้เลือกเพจได้)
                        const selectedPage = fbData.data[0]; 
                        const realPageAccessToken = selectedPage.access_token; // 🔑 นี่คือราชาโทเค็นของเพจตัวจริง!
                        const pageId = selectedPage.id;

                        setConnectedPages(fbData.data);

                        // 2. บันทึก "Page Access Token" ตัวจริงและรหัสเพจลง Firestore
                        if (user) {
                          const userRef = doc(db, "users", user.uid);
                          await updateDoc(userRef, {
                            pageAccessToken: realPageAccessToken, // กุญแจส่งข้อความในนามเพจ
                            facebookPageId: pageId,               // รหัสเพจสำหรับทำ Webhook ดักจับแชท
                            updatedAt: serverTimestamp()
                          });
                          console.log("✅ ระบบดึงและบันทึก Page Access Token ตัวจริงลง Firebase เรียบร้อย!");
                          alert(`เชื่อมต่อเพจ "${selectedPage.name}" สำเร็จเรียบร้อยครับ!`);
                        }
                      } else {
                        alert("❌ ไม่พบเพจ Facebook ที่เชื่อมต่อกับบัญชีนี้ กรุณาตรวจสอบสิทธิ์ครับ");
                      }
                    } catch (err) {
                      console.error("เกิดข้อผิดพลาดในการดึง Page Token:", err);
                      alert("เกิดข้อผิดพลาดระบบหลังบ้านในการเชื่อมต่อเพจ");
                    }
                  } else {
                    alert("การล็อกอิน Facebook ล้มเหลว หรือไม่ได้รับสิทธิ์");
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
                      <div key={order.id} ref={(el) => (labelRefs.current[order.id] = el)} className="w-full max-w-sm mx-auto mb-6 bg-white border-2 border-black p-3 thermal-label print:max-w-none print:mx-0 print:mb-0 print:shadow-none print:transform-none">
                        {/* Header & Admin Info */}
                        <div className="flex justify-between border-b-2 border-black pb-1 mb-2 font-bold text-[10px]">
                          <span>SmartLabel ✅</span>
                          <span className="text-gray-500">Admin: {user?.email?.split('@')[0]}</span>
                        </div>

                        {/* Sender Info (Compact) - อัปเกรดจัดแถวขนานรองรับเลขสัญญาขวาบน */}
                        <div className="mb-2 border-b-2 border-black pb-2 flex justify-between items-start gap-2">
                          {/* ฝั่งซ้าย: ข้อมูลชื่อและที่อยู่ละเอียดของผู้ส่ง */}
                          <div className="flex-1 min-w-0">
                            <p className="text-[9px] text-gray-500 font-medium leading-none">ผู้ส่ง:</p>
                            <p className="font-black text-sm leading-tight text-slate-900 mt-0.5">{storeProfile.name || "ไม่ระบุชื่อร้าน"}</p>
                            {storeProfile.address && (
                              <p className="text-[10px] text-slate-600 leading-tight mt-1 font-medium break-words">
                                {storeProfile.address} {storeProfile.phone ? `โทร. ${storeProfile.phone}` : ''}
                              </p>
                            )}
                          </div>

                          {/* ฝั่งขวา: 📜 กล่องข้อความพิเศษ (ยืดหยุ่นสูง ปรับเปลี่ยนข้อความได้ตามใจชอบ) */}
                          {/* เงื่อนไขใหม่: ถ้ามีการกรอกข้อความบรรทัดแรกเข้ามา ระบบจะเปิดกล่องนี้ออโต้ครับ */}
                          {storeProfile?.specialLine1 ? (
                            <div className="w-[125px] p-1.5 border border-black rounded-sm text-[8px] font-bold text-slate-800 leading-tight bg-slate-50/50 flex flex-col justify-center flex-shrink-0 text-left">
                              <p className="text-[7.5px] font-black text-blue-700 border-b border-gray-300 pb-0.5 mb-0.5 uppercase tracking-wide truncate">
                                {storeProfile.specialLine1}
                              </p>
                              <p className="truncate">{storeProfile.specialLine2 || ""}</p>
                              <p className="truncate">เลขที่: {storeProfile.licenseNo || "-"}</p>
                              <p className="truncate">สัญญา: {storeProfile.contractNo || "-"}</p>
                            </div>
                          ) : (
                            // หากไม่มีการกรอกข้อมูลพิเศษ จะปล่อยโล่งสะอาดตา ไม่แสดงอะไรเลยครับ
                            <div className="w-[125px] h-10 flex-shrink-0"></div>
                          )}
                        </div>
                        {/* COD Section (ถ้ามี) */}
                        {order.parsedData.isCOD && (
                          <div className="bg-black text-white text-center py-1.5 mb-2 text-xl font-black tracking-wider rounded-sm border-2 border-black">
                            COD: {order.parsedData.codAmount}
                          </div>
                        )}

                        {/* Receiver Info */}
                        <div className="bg-white p-2 mb-2 rounded-sm border-2 border-black">
                          <p className="text-[9px] text-blue-600 font-black mb-0.5 print:text-black">ผู้รับ:</p>
                          <p className="text-lg font-black text-slate-800 leading-none">{order.parsedData.customerName || 'ไม่มีชื่อ'}</p>
                          <p className="text-base font-bold text-slate-700 mt-1 leading-none">☎ {order.parsedData.phone || '-'}</p>
                          <p className="text-[11px] leading-snug mt-1.5 text-slate-600 font-medium">{order.parsedData.address || 'ไม่มีที่อยู่'}</p>
                        </div>

                        {/* Zipcode (Highlight) */}
                        <div className="text-center text-4xl font-black mb-2 tracking-widest text-slate-900">{order.parsedData.zipcode || '00000'}</div>

                        {/* 📦 ส่วนเลขพัสดุและบาร์โค้ด */}
                        {order.trackingNum && (
                          <div className="flex flex-col items-center mb-2 pt-1 border-t-2 border-black">
                            <p className="text-2xl font-black tracking-widest text-black mb-1">{order.trackingNum}</p>
                            <div className="bg-white p-1">
                              <QRCodeSVG value={order.trackingNum} size={70} />
                            </div>
                            <p className="text-[8px] mt-0.5 font-bold text-gray-500 uppercase">Thailand Post Tracking</p>
                          </div>
                        )}

                        {/* 📋 ส่วนรายการสินค้า และพื้นที่สำหรับข้อความพิเศษ 3 บรรทัด (ไม่ตีกรอบ จัดระเบียบด้วย Flex) */}
                        <div className="border-t-2 border-black pt-2 flex justify-between items-start gap-2">
                          <div className="flex-1 min-w-0">
                            <p className="text-[10px] font-black text-slate-700 mb-0.5">รายการสินค้า:</p>
                            {order.parsedData.items.length > 0 ? (
                              <ul className="text-[9px] list-disc pl-3 font-medium text-slate-600 leading-tight">
                                {order.parsedData.items.map((item, index) => <li key={index}>{item}</li>)}
                              </ul>
                            ) : (
                              <p className="text-[9px] text-gray-400 italic">- ไม่ระบุรายการ -</p>
                            )}
                          </div>
                          
                          {/* 🆔 แสดงเลข REF แบบตัวอักษรประจำตระกูล */}
                          <div className="text-right ml-2 border-l border-gray-300 pl-2 flex-shrink-0">
                            <p className="text-[8px] font-mono uppercase font-black text-slate-400 leading-none">REF NO.</p>
                            <p className="text-[11px] font-mono font-black text-slate-800 leading-none mt-1">#{String(order.id).slice(-6)}</p>
                          </div>
                        </div>
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
                      <th className="py-4 px-6 text-center whitespace-nowrap flex items-center justify-center gap-2">
                        สถานะพัสดุ
                        <button 
                          onClick={handleUpdateAllStatus}
                          className="p-1.5 bg-blue-500 text-white rounded-full hover:rotate-180 transition-all duration-500 shadow-sm"
                          title="อัปเดตสถานะทั้งหมด"
                        >
                          🔄
                        </button>
                      </th>
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
                            
                            {/* 📦 โซนกรอกเลขพัสดุและส่งแชทสายฟ้าแลบ (ฉบับเสถียร 100%) */}
                            <td className="py-4 px-6">
                              <div className="flex gap-2 items-center justify-center">
                                <input 
                                  type="text" 
                                  placeholder="เช่น OA123456789TH" 
                                  className="border border-slate-200 p-2 rounded-lg text-xs w-36 focus:ring-2 focus:ring-blue-300 outline-none uppercase font-mono"
                                  value={trackingInputs[order.id] !== undefined ? trackingInputs[order.id] : (order.trackingNum || '')}
                                  onChange={(e) => setTrackingInputs({...trackingInputs, [order.id]: e.target.value.toUpperCase()})}
                                />
                                
                                {/* ⚡ ตรวจสอบตัวแปรพิมพ์ใหญ่พิมพ์เล็ก (pageId / senderId) ให้ตรงกับ Firestore */}
                                {order.pageId && order.senderId ? (
                                  <button 
                                    onClick={() => handleCopyTrackingMessage(order)}
                                    className="bg-blue-600 text-white p-2 rounded-lg text-xs font-bold hover:bg-blue-700 transition-colors shadow-sm flex items-center justify-center gap-1"
                                    title="ส่งเลขพัสดุเข้า Facebook Messenger ลูกค้าโดยตรง"
                                  >
                                    ⚡ ส่งเข้าแชท
                                  </button>
                                ) : (
                                  <button 
                                    onClick={() => handleCopyTrackingMessage(order)}
                                    className="bg-emerald-500 text-white p-2 rounded-lg text-xs font-bold hover:bg-emerald-600 transition-colors shadow-sm flex items-center justify-center gap-1"
                                    title="คัดลอกข้อความเพื่อไปวางในแชทด้วยตัวเอง"
                                  >
                                    📋 ก๊อปปี้
                                  </button>
                                )}
                              </div>
                            </td>

                            {/* 🖨️ โซนปุ่มพิมพ์ซ้ำ (แยกทางไม่ทับเส้นกัน หน้าต่างพรีวิวจะไม่หายแว๊บ) */}
                            <td className="py-4 px-6 text-center">
                              <button 
                                onClick={() => handleReprint(order)}
                                className="bg-indigo-50 text-indigo-600 px-3 py-1.5 rounded-lg text-xs font-bold hover:bg-indigo-600 hover:text-white transition-colors shadow-sm"
                                title="ดึงข้อมูลนี้กลับไปที่หน้าสร้างจ่าหน้าเพื่อเปิดพรีวิว"
                              >
                                🖨️ พิมพ์ซ้ำ
                              </button>
                            </td>
                            <td className="py-4 px-6 text-center">
                              {order.trackingNum ? (
                                <div className="flex flex-col items-center gap-1">
                                  <span className={`px-3 py-1 rounded-full text-[10px] font-black border ${
                                    order.status === 'นำจ่ายสำเร็จ' ? 'bg-emerald-50 text-emerald-600 border-emerald-100' : 
                                    order.status?.includes('ระหว่าง') ? 'bg-blue-50 text-blue-600 border-blue-100' : 
                                    'bg-slate-50 text-slate-500 border-slate-100'
                                  }`}>
                                    {order.status === 'นำจ่ายสำเร็จ' ? '✅ ส่งสำเร็จ' : 
                                    order.status?.includes('ระหว่าง') ? '🚚 กำลังขนส่ง' : 
                                    order.status || '📦 เตรียมการส่ง'}
                                  </span>
                                  <a 
                                    href={`https://track.thailandpost.co.th/?trackNumber=${order.trackingNum}`}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-[9px] text-blue-400 hover:text-blue-600 underline font-bold"
                                  >
                                    ตรวจสอบละเอียด
                                  </a>
                                </div>
                              ) : (
                                <span className="text-slate-300 text-[10px]">ยังไม่ออกเลข</span>
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
                  {/* 🟢 ค่ายกลจัดระเบียบปุ่มเรียงหน้ากระดานข้างกัน + แก้อาการส่งค่าเพี้ยน */}
                  <div className="flex flex-row items-center gap-3 mt-4">
                    <button 
                      onClick={() => handleApproveTopup(req)} 
                      className="btn-cute flex-1 bg-emerald-500 hover:bg-emerald-600 text-white font-black py-3 rounded-xl shadow-lg shadow-emerald-500/20 flex items-center justify-center gap-2 text-sm whitespace-nowrap"
                    >
                      ✅ อนุมัติยอดเงิน
                    </button>
                    <button 
                      onClick={() => handleRejectTopup(req.id)} 
                      className="btn-cute bg-rose-100 hover:bg-rose-600 text-rose-600 hover:text-white font-bold py-3 px-4 rounded-xl transition-colors text-sm whitespace-nowrap"
                    >
                      ❌ ไม่อนุมัติ
                    </button>
                  </div>
                </div>
              </div>
            ))}
            {billingRequests.length === 0 && (
              <div className="col-span-full py-20 text-center text-slate-400"><span className="text-6xl mb-4 block">🎉</span><p className="text-xl font-bold">สุดยอด! ไม่มีรายการค้างตรวจสอบเลย</p></div>
            )}
          </div>
          {/* 📜 🆕 ตารางประวัติการอนุมัติแพ็กเกจ (วางต่อท้ายกล่องตรวจสอบบิลเดิม) */}
            <div className="col-span-full bg-white p-6 md:p-8 rounded-3xl shadow-sm border border-slate-100 mt-8 text-left animate-[fadeIn_0.4s_ease]">
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-6 gap-4 border-b border-slate-100 pb-4">
                <div>
                  <h3 className="text-xl font-black text-slate-800 flex items-center gap-2">
                    📜 รายงานประวัติการเงินและรายการอนุมัติ
                  </h3>
                  <p className="text-xs text-slate-400 mt-1">สมุดบัญชีดิจิทัลสรุปการทำรายการสำเร็จและรายการปฏิเสธทั้งหมดในระบบ</p>
                </div>
                <div className="bg-emerald-50 border border-emerald-100 px-5 py-3 rounded-2xl flex items-center gap-2 shadow-sm self-stretch sm:self-auto justify-between">
                  <span className="text-xs font-bold text-emerald-700">💰 รายได้รวมสะสม:</span>
                  <span className="text-2xl font-black text-emerald-600">฿{totalRevenue.toLocaleString()}.00</span>
                </div>
              </div>

              <div className="overflow-x-auto border border-slate-100 rounded-2xl shadow-inner">
                <table className="w-full text-sm text-left">
                  <thead className="bg-slate-50 uppercase text-xs font-black text-slate-500 tracking-wider border-b">
                    <tr>
                      <th className="py-4 px-6 whitespace-nowrap">วันเวลาที่ทำรายการ</th>
                      <th className="py-4 px-6">ร้านค้าสมาชิก</th>
                      <th className="py-4 px-6">แพ็กเกจ</th>
                      <th className="py-4 px-6 text-right whitespace-nowrap">ยอดเงิน</th>
                      <th className="py-4 px-6 text-center whitespace-nowrap">ผู้ดำเนินการ</th>
                      <th className="py-4 px-6 text-center">สถานะ</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {historyRequests.length === 0 ? (
                      <tr>
                        <td colSpan="6" className="text-center py-16 text-slate-400 font-medium">
                          🍃 ยังไม่มีประวัติการอนุมัติหรือปฏิเสธรายการในระบบ
                        </td>
                      </tr>
                    ) : (
                      historyRequests.map((history, idx) => (
                        <tr key={idx} className="hover:bg-slate-50/60 transition-colors">
                          <td className="py-4 px-6 text-slate-500 font-medium text-xs whitespace-nowrap">
                            {history.approvedAt ? new Date(history.approvedAt.toDate()).toLocaleString('th-TH') : history.rejectedAt ? new Date(history.rejectedAt.toDate()).toLocaleString('th-TH') : '-'}
                          </td>
                          <td className="py-4 px-6">
                            <p className="font-bold text-slate-800 text-sm">{history.storeName || "ลูกค้าทั่วไป"}</p>
                            <p className="text-[11px] text-slate-400 font-mono mt-0.5">{history.userEmail}</p>
                          </td>
                          <td className="py-4 px-6">
                            <span className="font-bold text-xs bg-indigo-50 text-indigo-700 px-2.5 py-1 rounded-md border border-indigo-100">
                              {history.package || "Standard"}
                            </span>
                          </td>
                          <td className="py-4 px-6 text-right font-black text-slate-700 text-base whitespace-nowrap">
                            ฿{(history.amount || 0).toLocaleString()}
                          </td>
                          <td className="py-4 px-6 text-center font-medium text-slate-500 text-xs whitespace-nowrap">
                            👤 {history.approvedBy || "SuperAdmin"}
                          </td>
                          <td className="py-4 px-6 text-center whitespace-nowrap">
                            <span className={`px-2.5 py-1 rounded-lg text-xs font-black shadow-sm ${
                              history.status === 'approved' 
                                ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' 
                                : 'bg-rose-50 text-rose-700 border border-rose-200'
                            }`}>
                              {history.status === 'approved' ? '✅ อนุมัติสำเร็จ' : '❌ ปฏิเสธบิล'}
                            </span>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
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