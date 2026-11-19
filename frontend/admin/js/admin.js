// Admin Dashboard Script — DPRD Surakarta

// Switch Tab
function showTab(tabId) {
  document.querySelectorAll(".tab-pane").forEach((p) => p.classList.remove("active"));
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));

  document.getElementById(`tab-${tabId}`).classList.add("active");
  document.getElementById(`btn-tab-${tabId}`).classList.add("active");

  if (tabId === "logs") loadAttendanceLogs();
  if (tabId === "participants") loadParticipants();
  if (tabId === "manual") loadParticipantsForManualDropdown();
}

// 1. Load Stats
async function loadStats() {
  try {
    const res = await fetch("/api/admin/stats");
    const data = await res.json();
    document.getElementById("statActiveParticipants").textContent = data.active_participants;
    document.getElementById("statCheckIns").textContent = data.today_check_ins;
    document.getElementById("statCheckOuts").textContent = data.today_check_outs;
    document.getElementById("statFlagged").textContent = data.today_flagged;
  } catch (err) {
    console.error("Gagal memuat statistik:", err);
  }
}

// 2. Load Attendance Logs
async function loadAttendanceLogs() {
  const dateInput = document.getElementById("filterDate").value;
  const flaggedOnly = document.getElementById("filterFlagged").checked;

  let url = `/api/admin/attendance?only_flagged=${flaggedOnly}`;
  if (dateInput) url += `&target_date=${dateInput}`;

  const tbody = document.getElementById("logsTableBody");
  tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:30px; color:#94a3b8;">Memuat data...</td></tr>';

  try {
    const res = await fetch(url);
    const logs = await res.json();

    if (logs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:30px; color:#94a3b8;">Tidak ada data presensi pada rentang ini.</td></tr>';
      return;
    }

    tbody.innerHTML = logs.map((r) => {
      const photoHtml = r.evidence_photo_url
        ? `<img src="${r.evidence_photo_url}" class="thumb-preview" onclick="zoomPhoto('${r.evidence_photo_url}')" title="Klik untuk perbesar">`
        : '<span style="color:#64748b;">-</span>';

      const statusBadge = `<span class="badge badge-${r.status}">${r.status}</span>`;
      const flagWarning = r.is_suspicious ? `<br><small style="color:#ef4444;">⚠ ${r.suspicious_reason}</small>` : '';

      return `
        <tr>
          <td>${photoHtml}</td>
          <td><strong>${r.checked_at}</strong></td>
          <td><code>${r.intern_id}</code></td>
          <td>${r.full_name}</td>
          <td>${r.division}</td>
          <td><strong>${r.attendance_type}</strong></td>
          <td>${statusBadge} ${flagWarning}</td>
          <td>${r.similarity_score ? (r.similarity_score * 100).toFixed(1) + '%' : '-'}</td>
          <td>
            <button class="btn btn-danger" style="padding:4px 8px; font-size:0.75rem;" onclick="deleteAttendance('${r.id}', '${r.full_name}', '${r.attendance_type}')" title="Hapus rekaman ini">Hapus</button>
          </td>
        </tr>
      `;
    }).join("");
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="9" style="color:#ef4444; text-align:center;">Gagal memuat log: ${err.message}</td></tr>`;
  }
}

// Hapus satu presensi spesifik (misal duplikat/salah record)
async function deleteAttendance(id, name, type) {
  if (!confirm(`Yakin ingin menghapus presensi ${type} untuk '${name}'?`)) return;
  try {
    const res = await fetch(`/api/admin/attendance/${id}`, { method: "DELETE" });
    const data = await res.json();
    alert(data.message);
    loadAttendanceLogs();
    loadStats();
  } catch (err) {
    alert("Gagal menghapus: " + err.message);
  }
}

// Bersihkan rekaman ganda hari ini dengan 1 klik
async function cleanDuplicatesToday() {
  if (!confirm("Fitur ini akan membersihkan semua presensi berulang pada hari ini (hanya menyisakan 1 Masuk pertama dan 1 Pulang terakhir per peserta).\nLanjutkan?")) return;
  try {
    const res = await fetch("/api/admin/attendance/duplicates/clean-today", { method: "DELETE" });
    const data = await res.json();
    alert(data.message);
    loadAttendanceLogs();
    loadStats();
  } catch (err) {
    alert("Gagal membersihkan: " + err.message);
  }
}

// 3. Load Participants
async function loadParticipants() {
  const tbody = document.getElementById("participantsTableBody");
  tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:30px; color:#94a3b8;">Memuat peserta...</td></tr>';

  try {
    const res = await fetch("/api/participants");
    const participants = await res.json();

    if (participants.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:30px; color:#94a3b8;">Belum ada peserta terdaftar.</td></tr>';
      return;
    }

    tbody.innerHTML = participants.map((p) => {
      const statusBadge = p.status === "active"
        ? '<span class="badge badge-verified">AKTIF</span>'
        : '<span class="badge" style="background:#475569; color:#cbd5e1;">SELESAI / NONAKTIF</span>';

      const actionBtn = p.status === "active"
        ? `<button class="btn btn-danger" style="padding:4px 10px; font-size:0.75rem;" onclick="deactivateParticipant('${p.id}', '${p.full_name}')">Hapus Biometrik (Selesai Magang)</button>`
        : '<small style="color:#64748b;">Data biometrik terhapus</small>';

      return `
        <tr>
          <td><code>${p.intern_id}</code></td>
          <td><strong>${p.full_name}</strong></td>
          <td>${p.institution || '-'}</td>
          <td>${p.internship_start} s.d ${p.internship_end}</td>
          <td><strong>${p.active_embeddings_count}</strong> foto sudut</td>
          <td>${statusBadge}</td>
          <td>${actionBtn}</td>
        </tr>
      `;
    }).join("");
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" style="color:#ef4444; text-align:center;">Gagal: ${err.message}</td></tr>`;
  }
}

// Deactivate & Purge Participant Biometrics
async function deactivateParticipant(id, name) {
  const confirmDeact = confirm(`PERINGATAN UU PDP:\nApakah Anda yakin ingin menonaktifkan peserta '${name}'?\n\nSemua data vektor biometrik wajah akan DIHAPUS PERMANEN dari database dan memori server!`);
  if (!confirmDeact) return;

  try {
    const res = await fetch(`/api/participants/${id}`, { method: "DELETE" });
    const data = await res.json();
    alert(data.message);
    loadParticipants();
    loadStats();
  } catch (err) {
    alert("Gagal menonaktifkan: " + err.message);
  }
}

// 4. Manual Attendance
async function loadParticipantsForManualDropdown() {
  const sel = document.getElementById("manualParticipantSelect");
  try {
    const res = await fetch("/api/participants?status_filter=active");
    const list = await res.json();
    sel.innerHTML = '<option value="">-- Pilih Peserta Magang --</option>' +
      list.map((p) => `<option value="${p.id}">${p.intern_id} - ${p.full_name}</option>`).join("");
  } catch (err) {
    sel.innerHTML = '<option value="">Gagal memuat peserta</option>';
  }
}

async function submitManualAttendanceForm(e) {
  e.preventDefault();
  const pid = document.getElementById("manualParticipantSelect").value;
  const attType = document.getElementById("manualType").value;
  const reason = document.getElementById("manualReason").value.trim();
  const adminName = document.getElementById("manualAdminName").value.trim();

  if (!pid || !reason || !adminName) {
    alert("Semua field wajib diisi!");
    return;
  }

  try {
    const res = await fetch("/api/admin/attendance/manual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        participant_id: pid,
        attendance_type: attType,
        manual_reason: reason,
        admin_name: adminName,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Gagal mencatat");

    alert(data.message);
    document.getElementById("manualForm").reset();
    showTab("logs");
    loadStats();
  } catch (err) {
    alert("Gagal: " + err.message);
  }
}

// Ekspor File (CSV / Excel)
function exportReport(format) {
  const dateInput = document.getElementById("filterDate").value;
  let url = `/api/admin/export?export_format=${format}`;
  if (dateInput) url += `&target_date=${dateInput}`;
  window.open(url, "_blank");
}

// Zoom Photo Modal
function zoomPhoto(url) {
  document.getElementById("zoomedImg").src = url;
  document.getElementById("photoModal").classList.add("active");
}

function closePhotoModal() {
  document.getElementById("photoModal").classList.remove("active");
}

// Inisialisasi
document.getElementById("filterDate").value = new Date().toISOString().split("T")[0];
loadStats();
loadAttendanceLogs();
