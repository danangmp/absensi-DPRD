// Kiosk Controller — DPRD Surakarta
const video = document.getElementById("kioskVideo");
const canvas = document.getElementById("overlayCanvas");
const ctx = canvas.getContext("2d");

const statusCard = document.getElementById("statusCard");
const statusTitle = document.getElementById("statusTitle");
const statusSubtitle = document.getElementById("statusSubtitle");

let currentAttendanceType = new Date().getHours() < 12 ? "check_in" : "check_out";
let ws = null;
let isStreaming = false;
let isPaused = false;
let failedAttempts = 0;

// Web Audio API untuk suara konfirmasi instan tanpa perlu file mp3
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

function playChime(type) {
  if (audioCtx.state === "suspended") {
    audioCtx.resume();
  }
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain);
  gain.connect(audioCtx.destination);

  const now = audioCtx.currentTime;

  if (type === "success") {
    // Nada ceria naik (C5 -> E5 -> G5)
    osc.frequency.setValueAtTime(523.25, now);
    osc.frequency.setValueAtTime(659.25, now + 0.1);
    osc.frequency.setValueAtTime(783.99, now + 0.2);
    gain.gain.setValueAtTime(0.3, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.6);
    osc.start(now);
    osc.stop(now + 0.6);
  } else if (type === "cooldown") {
    // Nada lembut peringatan
    osc.frequency.setValueAtTime(440, now);
    gain.gain.setValueAtTime(0.2, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
    osc.start(now);
    osc.stop(now + 0.3);
  } else if (type === "fail") {
    // Nada rendah
    osc.frequency.setValueAtTime(220, now);
    gain.gain.setValueAtTime(0.25, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.4);
    osc.start(now);
    osc.stop(now + 0.4);
  }
}

// Update Jam Real-Time
function updateClock() {
  const now = new Date();
  const timeStr = now.toLocaleTimeString("id-ID", { hour12: false });
  const dateStr = now.toLocaleDateString("id-ID", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  document.getElementById("clockTime").textContent = timeStr;
  document.getElementById("clockDate").textContent = dateStr;
}
setInterval(updateClock, 1000);
updateClock();

// Toggle Presensi Masuk / Pulang
function setAttendanceType(type) {
  currentAttendanceType = type;
  document.getElementById("btnCheckIn").classList.toggle("active", type === "check_in");
  document.getElementById("btnCheckOut").classList.toggle("active", type === "check_out");
}
setAttendanceType(currentAttendanceType);

let currentStream = null;

// Inisialisasi Kamera & Deteksi DroidCam
async function initCamera() {
  try {
    // 1. Minta akses awal agar label kamera (DroidCam, Integrated, dll.) terbuka
    currentStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });

    // 2. Deteksi semua kamera yang tersedia di sistem
    await updateCameraList();

    // 3. Pasang stream ke elemen video
    video.srcObject = currentStream;
    await video.play();

    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;

    initWebSocket();

    // Pantau jika ada kamera USB / DroidCam baru dicolokkan/dihubungkan
    navigator.mediaDevices.ondevicechange = () => {
      updateCameraList();
    };

  } catch (err) {
    console.error("Gagal membuka kamera:", err);
    statusTitle.textContent = "Kamera Tidak Terdeteksi";
    statusSubtitle.textContent = "Izinkan akses kamera di browser atau pastikan DroidCam Client sudah 'Start'.";
    statusCard.className = "status-card unrecognized";
  }
}

// Daftarkan semua kamera ke dropdown pemilih
async function updateCameraList() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const videoDevices = devices.filter((d) => d.kind === "videoinput");
  const camSelect = document.getElementById("cameraSelect");

  if (!camSelect) return;

  camSelect.innerHTML = "";

  const savedCamId = localStorage.getItem("preferredCameraId");
  let selectedId = null;

  videoDevices.forEach((device, idx) => {
    const opt = document.createElement("option");
    opt.value = device.deviceId;
    opt.textContent = device.label || `Kamera ${idx + 1}`;

    // Otomatis prioritaskan DroidCam jika terdeteksi dan belum ada pilihan manual
    const isDroidCam = (device.label || "").toLowerCase().includes("droidcam");
    if (savedCamId === device.deviceId || (!savedCamId && isDroidCam && !selectedId)) {
      opt.selected = true;
      selectedId = device.deviceId;
    }

    camSelect.appendChild(opt);
  });

  // Jika DroidCam ditemukan dan berbeda dari stream awal, otomatis ganti ke DroidCam
  if (selectedId && currentStream) {
    const activeTrack = currentStream.getVideoTracks()[0];
    const activeSettings = activeTrack ? activeTrack.getSettings() : {};
    if (activeSettings.deviceId !== selectedId) {
      await switchCamera(selectedId);
    }
  }
}

// Ganti Kamera Aktif (saat user memilih di dropdown)
async function onCameraSelected(deviceId) {
  if (!deviceId) return;
  localStorage.setItem("preferredCameraId", deviceId);
  await switchCamera(deviceId);
}

async function switchCamera(deviceId) {
  try {
    if (currentStream) {
      currentStream.getTracks().forEach((track) => track.stop());
    }

    currentStream = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: { exact: deviceId },
        width: { ideal: 640 },
        height: { ideal: 480 },
      },
      audio: false,
    });

    video.srcObject = currentStream;
    await video.play();

    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;

    console.log("Kamera berhasil dialihkan.");
  } catch (err) {
    console.error("Gagal beralih ke kamera yang dipilih:", err);
    alert("Gagal menghubungkan ke kamera tersebut. Pastikan aplikasi DroidCam di PC sudah dalam status 'Start'.");
  }
}

// Inisialisasi WebSocket Kiosk Real-Time
function initWebSocket() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${window.location.host}/ws/kiosk`;

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log("WebSocket terhubung.");
    document.getElementById("kioskBadge").textContent = "ONLINE";
    document.getElementById("kioskBadge").style.color = "#10b981";
    startFrameStreaming();
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    handleServerResponse(data);
  };

  ws.onclose = () => {
    console.warn("WebSocket putus. Reconnecting dalam 3 detik...");
    document.getElementById("kioskBadge").textContent = "RECONNECTING";
    document.getElementById("kioskBadge").style.color = "#f59e0b";
    isStreaming = false;
    setTimeout(initWebSocket, 3000);
  };
}

// Loop Pengiriman Frame ke Server (Setiap 280ms)
function startFrameStreaming() {
  if (isStreaming) return;
  isStreaming = true;

  const offscreen = document.createElement("canvas");
  offscreen.width = 400;
  offscreen.height = 300;
  const offCtx = offscreen.getContext("2d");

  const sendInterval = setInterval(() => {
    if (!isStreaming || ws.readyState !== WebSocket.OPEN) {
      clearInterval(sendInterval);
      isStreaming = false;
      return;
    }

    if (isPaused) return;

    // Gambar frame video ke offscreen canvas
    offCtx.drawImage(video, 0, 0, offscreen.width, offscreen.height);
    const jpegDataUrl = offscreen.toDataURL("image/jpeg", 0.75);

    ws.send(JSON.stringify({
      type: "frame",
      image: jpegDataUrl,
      attendance_type: currentAttendanceType,
    }));
  }, 280);
}

// Handler Respon dari Server
function handleServerResponse(data) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (isPaused) return;

  // Gambar Bounding Box Wajah jika terdeteksi
  if (data.bbox) {
    const bx = (1 - data.bbox.x - data.bbox.width) * canvas.width; // Flip X sesuai cermin
    const by = data.bbox.y * canvas.height;
    const bw = data.bbox.width * canvas.width;
    const bh = data.bbox.height * canvas.height;

    ctx.lineWidth = 3;
    if (data.status === "success") {
      ctx.strokeStyle = "#10b981"; // Hijau
    } else if (data.status === "cooldown") {
      ctx.strokeStyle = "#f59e0b"; // Kuning
    } else {
      ctx.strokeStyle = "#38bdf8"; // Biru scanning
    }
    ctx.strokeRect(bx, by, bw, bh);
  }

  // State: BERHASIL PRESENSI
  if (data.status === "success") {
    playChime("success");
    isPaused = true;
    failedAttempts = 0;

    statusCard.className = "status-card success";
    statusTitle.textContent = `Selamat Datang, ${data.full_name}!`;
    statusSubtitle.textContent = `Presensi ${data.attendance_type} Berhasil • Pukul ${data.time}`;

    // Tampilkan 4 detik agar peserta sempat melihat, lalu reset
    setTimeout(() => {
      resetToStandby();
      isPaused = false;
    }, 4000);
    return;
  }

  // State: SUDAH PRESENSI HARI INI (ATURAN 1X MASUK / 1X PULANG)
  if (data.status === "already_checked") {
    playChime("cooldown");
    isPaused = true;

    statusCard.className = "status-card cooldown";
    statusTitle.textContent = `Sudah Tercatat Hari Ini (${data.full_name})`;
    statusSubtitle.textContent = data.message;

    setTimeout(() => {
      resetToStandby();
      isPaused = false;
    }, 4500);
    return;
  }

  // State: COOLDOWN 5 MENIT
  if (data.status === "cooldown") {
    playChime("cooldown");
    isPaused = true;

    statusCard.className = "status-card cooldown";
    statusTitle.textContent = `Sudah Tercatat (${data.full_name})`;
    statusSubtitle.textContent = `Anda sudah melakukan presensi. Sisa cooldown: ${data.remaining_seconds} detik.`;

    setTimeout(() => {
      resetToStandby();
      isPaused = false;
    }, 3000);
    return;
  }

  // State: TIDAK DIKENAL
  if (data.status === "unrecognized") {
    failedAttempts++;
    statusCard.className = "status-card unrecognized";
    statusTitle.textContent = "Wajah Belum Terdaftar";
    statusSubtitle.textContent = failedAttempts >= 5
      ? "Gagal 5x. Silakan hubungi admin resepsionis."
      : "Posisikan wajah tepat di lingkaran panduan.";

    if (failedAttempts >= 5) {
      document.getElementById("btnFallback").style.display = "inline-flex";
    }
    return;
  }

  // State: STANDBY
  if (data.status === "no_face") {
    resetToStandby();
  }
}

function resetToStandby() {
  statusCard.className = "status-card standby";
  statusTitle.textContent = "Arahkan Wajah ke Kamera";
  statusSubtitle.textContent = "Sistem otomatis mendeteksi dan mencatat presensi Anda";
}

// Fullscreen Toggle
function toggleFullScreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch((err) => alert(err.message));
  } else {
    document.exitFullscreen();
  }
}

// Cache Divisi
let cachedDivisions = [];

async function prefetchDivisions() {
  try {
    const res = await fetch("/api/divisions");
    if (res.ok) {
      cachedDivisions = await res.json();
    }
  } catch (err) {
    console.warn("Gagal preload divisi:", err);
  }
}
prefetchDivisions();

function openEnrollmentModal() {
  document.getElementById("enrollModal").classList.add("active");
  populateDivisionsDropdown();
}

function closeEnrollmentModal() {
  document.getElementById("enrollModal").classList.remove("active");
}

function populateDivisionsDropdown() {
  const sel = document.getElementById("enrollDivision");
  if (cachedDivisions.length > 0) {
    sel.innerHTML = cachedDivisions
      .map((d) => `<option value="${d.id}">${d.name} (${d.code})</option>`)
      .join("");
  } else {
    // Fallback jika belum selesai fetch
    sel.innerHTML = '<option value="c39bac6b-8c01-4137-aa0f-cae69715458d">Bagian Persidangan & Perundang-undangan (SIDANG)</option>';
    prefetchDivisions().then(() => {
      if (cachedDivisions.length > 0) {
        sel.innerHTML = cachedDivisions
          .map((d) => `<option value="${d.id}">${d.name} (${d.code})</option>`)
          .join("");
      }
    });
  }
}

let capturedPoses = { front: null, left: null, right: null };

function captureEnrollPose(poseName) {
  if (!video.videoWidth || !video.videoHeight) {
    alert("Kamera belum siap. Pastikan izin kamera aktif.");
    return;
  }

  // Gunakan resolusi asli kamera (misal 640x480) tanpa crop terpotong
  const offscreen = document.createElement("canvas");
  offscreen.width = video.videoWidth;
  offscreen.height = video.videoHeight;
  const offCtx = offscreen.getContext("2d");

  // Gambar citra asli kamera tanpa flip untuk kualitas ekstraksi model
  offCtx.drawImage(video, 0, 0, offscreen.width, offscreen.height);

  const b64 = offscreen.toDataURL("image/jpeg", 0.88);
  capturedPoses[poseName] = b64;

  const card = document.getElementById(`poseCard_${poseName}`);
  card.classList.add("captured");
  document.getElementById(`thumb_${poseName}`).src = b64;
}

async function submitEnrollmentForm(e) {
  e.preventDefault();
  const internId = document.getElementById("enrollInternId").value.trim();
  const fullName = document.getElementById("enrollFullName").value.trim();
  const institution = document.getElementById("enrollInstitution").value.trim();
  const divisionId = document.getElementById("enrollDivision").value;

  if (!capturedPoses.front || !capturedPoses.left || !capturedPoses.right) {
    alert("Harap ambil ke-3 foto pose (1. Depan, 2. Toleh Kiri, 3. Toleh Kanan) terlebih dahulu!");
    return;
  }

  const submitBtn = document.getElementById("btnSubmitEnroll");
  submitBtn.disabled = true;
  submitBtn.textContent = "Menganalisis & Mendaftarkan Wajah...";

  const pinVal = document.getElementById("enrollPin") ? document.getElementById("enrollPin").value.trim() : "123456";

  try {
    // Kirim request ATOMIK ke server: validasi wajah + buat peserta sekaligus
    const res = await fetch("/api/enrollment/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        intern_id: internId,
        full_name: fullName,
        institution: institution,
        division_id: divisionId,
        pin: pinVal || "123456",
        biometric_consent: true,
        photos: [
          { angle: "front", photo_b64: capturedPoses.front },
          { angle: "left", photo_b64: capturedPoses.left },
          { angle: "right", photo_b64: capturedPoses.right },
        ],
      }),
    });

    let result = {};
    const resText = await res.text();
    try {
      result = JSON.parse(resText);
    } catch (e) {
      throw new Error(`Server (${res.status}): ${resText.slice(0, 150)}`);
    }

    if (!res.ok) {
      throw new Error(result.detail || "Gagal mendaftarkan peserta");
    }

    alert(`BERHASIL!\n${result.message}`);
    closeEnrollmentModal();

    // Reset Form & Poses
    document.getElementById("enrollForm").reset();
    capturedPoses = { front: null, left: null, right: null };
    document.querySelectorAll(".pose-card").forEach((c) => c.classList.remove("captured"));
    document.querySelectorAll(".pose-thumb").forEach((img) => (img.src = ""));

  } catch (err) {
    alert(`PERINGATAN:\n${err.message}`);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Simpan & Daftarkan Wajah";
  }
}

// Start
initCamera();


// ============================================================
// 1. MANAJEMEN DAYA / SUHU TABLET (AUTO-SLEEP INACTIVITY TIMER)
// ============================================================
let lastActivityTime = Date.now();
const INACTIVITY_TIMEOUT_MS = 30000; // 30 detik tanpa wajah -> Istirahat hemat daya
let isSleeping = false;

function touchActivity() {
  lastActivityTime = Date.now();
  if (isSleeping) {
    wakeUpKiosk();
  }
}

// Pasang event listener sentuhan di layar tablet
window.addEventListener("touchstart", touchActivity);
window.addEventListener("mousedown", touchActivity);

// Timer cek inaktivitas tiap 3 detik
setInterval(() => {
  if (isSleeping || isPaused) return;

  const idleTime = Date.now() - lastActivityTime;
  if (idleTime > INACTIVITY_TIMEOUT_MS) {
    enterSleepMode();
  }
}, 3000);

// Status Daya Kamera
let isCameraHardwareOn = true;

function toggleCameraPower() {
  if (isCameraHardwareOn) {
    turnOffCameraHardware();
  } else {
    turnOnCameraHardware();
  }
}

function turnOffCameraHardware() {
  isCameraHardwareOn = false;
  // 1. Matikan track fisik kamera (LED indikator kamera mati, sensor dingin)
  if (currentStream) {
    currentStream.getTracks().forEach((track) => track.stop());
    currentStream = null;
  }
  isStreaming = false;

  // 2. Tampilkan overlay hemat daya
  document.getElementById("sleepOverlay").classList.add("active");
  document.querySelector(".sleep-title").textContent = "Kamera Dimatikan (Mode Hemat Daya)";
  document.querySelector(".sleep-subtitle").textContent = "Sensor kamera nonaktif agar tablet tetap dingin • Ketuk untuk menyalakan";

  // 3. Update tombol header
  const btn = document.getElementById("btnToggleCamera");
  if (btn) {
    btn.style.background = "rgba(16, 185, 129, 0.2)";
    btn.style.borderColor = "#10b981";
    btn.style.color = "#6ee7b7";
    document.getElementById("lblCameraPower").textContent = "Nyalakan Kamera";
  }

  statusCard.className = "status-card standby";
  statusTitle.textContent = "Kamera Standby (Mati)";
  statusSubtitle.textContent = "Ketuk tombol 'Nyalakan Kamera' atau sentuh layar untuk presensi.";
  console.log("[HARDWARE] Kamera fisik dimatikan total.");
}

async function turnOnCameraHardware() {
  isCameraHardwareOn = true;
  document.getElementById("sleepOverlay").classList.remove("active");
  document.querySelector(".sleep-title").textContent = "Ketuk Layar untuk Presensi";
  document.querySelector(".sleep-subtitle").textContent = "Mode hemat daya aktif • Sentuh layar untuk menyalakan kamera";

  const btn = document.getElementById("btnToggleCamera");
  if (btn) {
    btn.style.background = "rgba(239, 68, 68, 0.2)";
    btn.style.borderColor = "#ef4444";
    btn.style.color = "#fca5a5";
    document.getElementById("lblCameraPower").textContent = "Matikan Kamera";
  }

  // Nyalakan kembali sensor kamera
  const savedId = localStorage.getItem("preferredCameraId");
  await switchCamera(savedId || undefined);
  startFrameStreaming();
  resetToStandby();
  lastActivityTime = Date.now();
  console.log("[HARDWARE] Kamera fisik dinyalakan kembali.");
}

function enterSleepMode() {
  isSleeping = true;
  // Saat mode tidur inaktivitas, matikan juga track sensor kamera
  turnOffCameraHardware();
}

function wakeUpKiosk() {
  isSleeping = false;
  turnOnCameraHardware();
}

// Update lastActivity saat ada wajah terdeteksi dari respons server
const originalHandleServerResponse = handleServerResponse;
handleServerResponse = function(data) {
  if (data.status !== "no_face") {
    lastActivityTime = Date.now();
  }
  originalHandleServerResponse(data);
};

// ============================================================
// 2. PRESENSI CADANGAN MANDIRI (SELF-SERVICE PIN)
// ============================================================
function openPinModal() {
  document.getElementById("pinModal").classList.add("active");
  document.getElementById("pinInternId").focus();
}

function closePinModal() {
  document.getElementById("pinModal").classList.remove("active");
  document.getElementById("pinCode").value = "";
}

async function submitPinAttendance() {
  const internId = document.getElementById("pinInternId").value.trim();
  const pin = document.getElementById("pinCode").value.trim();

  if (!internId || !pin) {
    alert("Harap masukkan ID Magang dan PIN!");
    return;
  }

  // Ambil 1 foto bukti snapshot kamera saat input PIN (cegah joki)
  let photoB64 = null;
  if (video.videoWidth && video.videoHeight) {
    const snapCanvas = document.createElement("canvas");
    snapCanvas.width = 400;
    snapCanvas.height = 300;
    const sCtx = snapCanvas.getContext("2d");
    sCtx.drawImage(video, 0, 0, 400, 300);
    photoB64 = snapCanvas.toDataURL("image/jpeg", 0.75);
  }

  try {
    const res = await fetch("/api/attendance/fallback-pin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        intern_id: internId,
        pin: pin,
        attendance_type: currentAttendanceType,
        photo_b64: photoB64,
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.detail || "Presensi PIN gagal");
    }

    closePinModal();
    playChime("success");
    isPaused = true;

    statusCard.className = "status-card success";
    statusTitle.textContent = `Selamat Datang, ${data.full_name}!`;
    statusSubtitle.textContent = `Presensi Mandiri via PIN Berhasil • Pukul ${data.time}`;

    setTimeout(() => {
      resetToStandby();
      isPaused = false;
      document.getElementById("btnFallback").style.display = "none";
    }, 4000);

  } catch (err) {
    alert("GAGAL: " + err.message);
  }
}
