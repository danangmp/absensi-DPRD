import base64
import uuid
from datetime import datetime, timedelta
from pathlib import Path
import cv2
import numpy as np
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Depends
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db.session import SessionLocal
from app.db.models.attendance import Attendance, AttendanceType, AttendanceStatus
from app.core.matcher import matcher
from app.core.face_processor import face_processor

router = APIRouter()
settings = get_settings()

# In-memory cooldown cache: dict[uuid.UUID, datetime]
cooldown_cache: dict[uuid.UUID, datetime] = {}


@router.websocket("/ws/kiosk")
async def websocket_kiosk_recognition(websocket: WebSocket):
    """
    WebSocket endpoint untuk streaming kamera dari tablet kiosk.
    
    Tablet mengirimkan frame terkompresi (JPEG Base64) setiap ~300ms.
    Backend memproses frame di CPU (<150ms) dan mengembalikan hasil instan
    tanpa reload halaman atau latency HTTP overhead.
    """
    await websocket.accept()

    # Kirim pesan koneksi berhasil
    await websocket.send_json({
        "type": "connected",
        "message": "Terhubung ke Server Kiosk DPRD Surakarta",
        "active_participants": len(matcher._index),
    })

    db = SessionLocal()
    evidence_base = Path(settings.evidence_photo_path)
    evidence_base.mkdir(parents=True, exist_ok=True)

    try:
        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type", "frame")

            if msg_type == "ping":
                await websocket.send_json({"type": "pong"})
                continue

            if msg_type == "frame":
                img_data_uri = data.get("image", "")
                att_type_str = data.get("attendance_type", "check_in")
                att_type = AttendanceType.CHECK_OUT if att_type_str == "check_out" else AttendanceType.CHECK_IN

                if not img_data_uri:
                    continue

                # Strip data URI prefix jika ada (data:image/jpeg;base64,...)
                if "," in img_data_uri:
                    img_data_uri = img_data_uri.split(",", 1)[1]

                try:
                    img_bytes = base64.b64decode(img_data_uri)
                    nparr = np.frombuffer(img_bytes, np.uint8)
                    frame_bgr = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
                except Exception:
                    await websocket.send_json({"status": "error", "message": "Format citra tidak valid"})
                    continue

                if frame_bgr is None:
                    continue

                # Jalankan deteksi wajah & ekstraksi embedding InsightFace
                res = face_processor.process_frame(frame_bgr, enforce_quality=False)

                if not res.bbox:
                    await websocket.send_json({
                        "status": "no_face",
                        "message": "Arahkan wajah ke kamera",
                    })
                    continue

                x1, y1, x2, y2 = res.bbox
                h, w, _ = frame_bgr.shape

                # Koordinat normalisasi (0.0 - 1.0) untuk rendering canvas di tablet
                bbox_norm = {
                    "x": float(x1 / w),
                    "y": float(y1 / h),
                    "width": float((x2 - x1) / w),
                    "height": float((y2 - y1) / h),
                }

                if res.embedding is None:
                    await websocket.send_json({
                        "status": "analyzing",
                        "bbox": bbox_norm,
                        "message": "Memeriksa ketajaman wajah...",
                    })
                    continue

                # Cocokkan embedding dengan database in-memory
                match_res = matcher.match(res.embedding)

                if match_res.is_matched:
                    pid = match_res.participant_id
                    now = datetime.now()

                    # 1. ATURAN: SEHARI CUMA BISA 1x MASUK & 1x PULANG
                    today_start = datetime.combine(now.date(), datetime.min.time())
                    existing_today = (
                        db.query(Attendance)
                        .filter(
                            Attendance.participant_id == pid,
                            Attendance.attendance_type == att_type,
                            Attendance.checked_at >= today_start,
                        )
                        .order_by(Attendance.checked_at.desc())
                        .first()
                    )

                    if existing_today:
                        waktu_str = existing_today.checked_at.strftime("%H:%M WIB")
                        jenis_str = "Masuk" if att_type == AttendanceType.CHECK_IN else "Pulang"
                        saran_str = "Untuk presensi pulang, pilih tombol 'Presensi Pulang'." if att_type == AttendanceType.CHECK_IN else "Presensi hari ini sudah lengkap!"

                        await websocket.send_json({
                            "status": "already_checked",
                            "bbox": bbox_norm,
                            "participant_id": str(pid),
                            "intern_id": match_res.intern_id,
                            "full_name": match_res.full_name,
                            "time": waktu_str,
                            "message": f"Anda SUDAH presensi {jenis_str} hari ini pukul {waktu_str}. {saran_str}",
                        })
                        continue

                    # 2. Catat Presensi Baru (Belum pernah presensi jenis ini hari ini)
                    cooldown_cache[pid] = now

                    # Simpan foto bukti
                    today_str = now.strftime("%Y/%m/%d")
                    ev_dir = evidence_base / today_str
                    ev_dir.mkdir(parents=True, exist_ok=True)
                    ev_filename = f"{uuid.uuid4()}.jpg"
                    ev_file_path = ev_dir / ev_filename
                    cv2.imwrite(str(ev_file_path), frame_bgr, [cv2.IMWRITE_JPEG_QUALITY, 80])

                    # Simpan record ke database
                    att_record = Attendance(
                        participant_id=pid,
                        attendance_type=att_type,
                        status=AttendanceStatus.FLAGGED if match_res.is_suspicious else AttendanceStatus.VERIFIED,
                        checked_at=now,
                        similarity_score=match_res.similarity_score,
                        evidence_photo_path=f"{today_str}/{ev_filename}",
                        is_suspicious=match_res.is_suspicious,
                        suspicious_reason=match_res.suspicious_reason,
                    )
                    db.add(att_record)
                    db.commit()

                    await websocket.send_json({
                        "status": "success",
                        "bbox": bbox_norm,
                        "participant_id": str(pid),
                        "intern_id": match_res.intern_id,
                        "full_name": match_res.full_name,
                        "similarity_score": round(match_res.similarity_score, 3),
                        "time": now.strftime("%H:%M:%S WIB"),
                        "attendance_type": "Masuk" if att_type == AttendanceType.CHECK_IN else "Pulang",
                        "message": f"Selamat Datang, {match_res.full_name}!",
                    })

                else:
                    await websocket.send_json({
                        "status": "unrecognized",
                        "bbox": bbox_norm,
                        "similarity_score": round(match_res.similarity_score, 3),
                        "message": "Wajah tidak dikenali. Silakan coba lagi.",
                    })

    except WebSocketDisconnect:
        pass
    finally:
        db.close()
