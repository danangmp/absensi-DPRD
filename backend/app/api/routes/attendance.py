import base64
import uuid
from datetime import datetime, date, timedelta
from pathlib import Path
import cv2
import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
import bcrypt

from app.config import get_settings
from app.db.session import get_db
from app.db.models.attendance import Attendance, AttendanceType, AttendanceStatus
from app.db.models.participant import Participant, ParticipantStatus
from app.db.models.participant_pin import ParticipantPin

router = APIRouter(prefix="/attendance", tags=["Attendance"])
settings = get_settings()


class FallbackPinRequest(BaseModel):
    intern_id: str = Field(..., description="Nomor Induk Magang")
    pin: str = Field(..., description="PIN 4-8 digit pribadi peserta")
    attendance_type: AttendanceType = Field(default=AttendanceType.CHECK_IN)
    photo_b64: str | None = Field(default=None, description="Foto bukti dari kamera tablet saat input PIN")


@router.post("/fallback-pin")
def submit_fallback_pin_attendance(data: FallbackPinRequest, db: Session = Depends(get_db)):
    """
    JALUR PRESENSI CADANGAN MANDIRI (SELF-SERVICE PIN):
    Peserta melakukan presensi sendiri menggunakan PIN pribadi jika deteksi wajah
    gagal atau peserta memakai masker/kacamata tebal — TANPA PERLU PENJAGA RESEPSIONIS.
    Foto bukti tetap diambil untuk mencegah joki PIN.
    """
    now = datetime.now()

    # 1. Cari Peserta
    participant = db.query(Participant).filter(
        Participant.intern_id == data.intern_id,
        Participant.status == ParticipantStatus.ACTIVE,
    ).first()

    if not participant:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Peserta dengan ID '{data.intern_id}' tidak ditemukan atau sudah tidak aktif.",
        )

    # 2. Verifikasi PIN
    pin_record = db.query(ParticipantPin).filter(
        ParticipantPin.participant_id == participant.id,
        ParticipantPin.is_active == True,
    ).first()

    if not pin_record:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Peserta belum memiliki PIN cadangan. Silakan hubungi admin.",
        )

    # Cek Lockout (jika salah >= 3 kali)
    if pin_record.locked_until and now < pin_record.locked_until:
        sisa = int((pin_record.locked_until - now).total_seconds())
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"PIN terkunci karena salah 3x. Silakan tunggu {sisa} detik lagi.",
        )

    # Cek kebenaran PIN
    if not bcrypt.checkpw(data.pin.encode("utf-8"), pin_record.hashed_pin.encode("utf-8")):
        pin_record.failed_attempts += 1
        if pin_record.failed_attempts >= 3:
            pin_record.locked_until = now + timedelta(minutes=10)
            db.commit()
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="PIN salah 3 kali berturut-turut. Akses PIN terkunci selama 10 menit demi keamanan.",
            )
        db.commit()
        sisa_percobaan = 3 - pin_record.failed_attempts
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"PIN salah! Sisa percobaan: {sisa_percobaan}x.",
        )

    # Reset counter jika benar
    pin_record.failed_attempts = 0
    pin_record.locked_until = None

    # ATURAN: SEHARI CUMA BISA 1x MASUK & 1x PULANG
    today_start = datetime.combine(now.date(), datetime.min.time())
    existing_today = (
        db.query(Attendance)
        .filter(
            Attendance.participant_id == participant.id,
            Attendance.attendance_type == data.attendance_type,
            Attendance.checked_at >= today_start,
        )
        .first()
    )
    if existing_today:
        jenis_str = "Masuk" if data.attendance_type == AttendanceType.CHECK_IN else "Pulang"
        waktu_str = existing_today.checked_at.strftime("%H:%M WIB")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Peserta '{participant.full_name}' SUDAH melakukan presensi {jenis_str} hari ini pukul {waktu_str}.",
        )

    # 3. Simpan foto bukti snapshot kamera jika ada
    ev_rel_path = None
    if data.photo_b64:
        try:
            raw_b64 = data.photo_b64
            if "," in raw_b64:
                raw_b64 = raw_b64.split(",", 1)[1]
            img_bytes = base64.b64decode(raw_b64)
            nparr = np.frombuffer(img_bytes, np.uint8)
            frame_bgr = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

            if frame_bgr is not None:
                evidence_base = Path(settings.evidence_photo_path)
                today_str = now.strftime("%Y/%m/%d")
                ev_dir = evidence_base / today_str
                ev_dir.mkdir(parents=True, exist_ok=True)
                ev_filename = f"{uuid.uuid4()}.jpg"
                cv2.imwrite(str(ev_dir / ev_filename), frame_bgr, [cv2.IMWRITE_JPEG_QUALITY, 80])
                ev_rel_path = f"{today_str}/{ev_filename}"
        except Exception:
            pass

    # 4. Simpan presensi ke database
    att_record = Attendance(
        participant_id=participant.id,
        attendance_type=data.attendance_type,
        status=AttendanceStatus.FALLBACK_PIN,
        checked_at=now,
        similarity_score=None,
        evidence_photo_path=ev_rel_path,
        is_suspicious=False,
        manual_reason="Presensi mandiri menggunakan PIN cadangan",
    )
    db.add(att_record)
    db.commit()

    return {
        "success": True,
        "full_name": participant.full_name,
        "intern_id": participant.intern_id,
        "time": now.strftime("%H:%M:%S WIB"),
        "attendance_type": "Masuk" if data.attendance_type == AttendanceType.CHECK_IN else "Pulang",
        "message": f"Presensi Mandiri via PIN Berhasil! Selamat beraktivitas, {participant.full_name}.",
    }



@router.get("/today")
def get_today_attendance(db: Session = Depends(get_db)):
    """Mendapatkan daftar presensi hari ini."""
    today_start = datetime.combine(date.today(), datetime.min.time())
    records = (
        db.query(Attendance)
        .filter(Attendance.checked_at >= today_start)
        .order_by(Attendance.checked_at.desc())
        .all()
    )

    result = []
    for r in records:
        result.append({
            "id": str(r.id),
            "participant_id": str(r.participant_id),
            "intern_id": r.participant.intern_id if r.participant else None,
            "full_name": r.participant.full_name if r.participant else None,
            "division": r.participant.division.name if r.participant and r.participant.division else None,
            "attendance_type": r.attendance_type.value,
            "status": r.status.value,
            "checked_at": r.checked_at.isoformat(),
            "time_str": r.checked_at.strftime("%H:%M:%S WIB"),
            "similarity_score": round(r.similarity_score, 3) if r.similarity_score else None,
            "is_suspicious": r.is_suspicious,
            "suspicious_reason": r.suspicious_reason,
            "evidence_photo_url": f"/evidence/{r.evidence_photo_path}" if r.evidence_photo_path else None,
        })
    return result
