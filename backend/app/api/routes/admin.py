import io
import uuid
from datetime import datetime, date, timedelta
import pandas as pd
from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.db.models.participant import Participant, ParticipantStatus
from app.db.models.attendance import Attendance, AttendanceType, AttendanceStatus
from app.db.models.division import Division

router = APIRouter(prefix="/admin", tags=["Admin Dashboard"])


class ManualAttendanceRequest(BaseModel):
    participant_id: uuid.UUID
    attendance_type: AttendanceType
    checked_at: datetime = Field(default_factory=datetime.now)
    manual_reason: str = Field(..., min_length=5, description="Alasan wajib diisi (misal: kamera tablet rusak / izin khusus)")
    admin_name: str = Field(..., description="Nama admin yang menyetujui")


@router.get("/stats")
def get_dashboard_stats(db: Session = Depends(get_db)):
    """Ringkasan statistik dashboard admin."""
    today_start = datetime.combine(date.today(), datetime.min.time())

    total_active_participants = (
        db.query(Participant)
        .filter(Participant.status == ParticipantStatus.ACTIVE)
        .count()
    )

    today_attendances = (
        db.query(Attendance)
        .filter(Attendance.checked_at >= today_start)
        .all()
    )

    check_ins = len([a for a in today_attendances if a.attendance_type == AttendanceType.CHECK_IN])
    check_outs = len([a for a in today_attendances if a.attendance_type == AttendanceType.CHECK_OUT])
    suspicious_count = len([a for a in today_attendances if a.is_suspicious])

    return {
        "active_participants": total_active_participants,
        "today_check_ins": check_ins,
        "today_check_outs": check_outs,
        "today_flagged": suspicious_count,
        "server_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S WIB"),
    }


@router.get("/attendance")
def get_attendance_logs(
    target_date: str | None = None,  # Format: YYYY-MM-DD
    division_id: uuid.UUID | None = None,
    only_flagged: bool = False,
    db: Session = Depends(get_db),
):
    """Mengambil daftar log presensi dengan filter tanggal, divisi, atau status flagged."""
    query = db.query(Attendance)

    if target_date:
        try:
            d = datetime.strptime(target_date, "%Y-%m-%d").date()
            d_start = datetime.combine(d, datetime.min.time())
            d_end = datetime.combine(d, datetime.max.time())
            query = query.filter(Attendance.checked_at >= d_start, Attendance.checked_at <= d_end)
        except ValueError:
            pass
    else:
        # Default 7 hari terakhir
        seven_days_ago = datetime.now() - timedelta(days=7)
        query = query.filter(Attendance.checked_at >= seven_days_ago)

    if only_flagged:
        query = query.filter(Attendance.is_suspicious == True)

    records = query.order_by(Attendance.checked_at.desc()).all()

    result = []
    for r in records:
        if division_id and r.participant and r.participant.division_id != division_id:
            continue

        result.append({
            "id": str(r.id),
            "participant_id": str(r.participant_id),
            "intern_id": r.participant.intern_id if r.participant else "-",
            "full_name": r.participant.full_name if r.participant else "Peserta Dihapus",
            "division": r.participant.division.name if r.participant and r.participant.division else "-",
            "attendance_type": "Masuk" if r.attendance_type == AttendanceType.CHECK_IN else "Pulang",
            "status": r.status.value,
            "checked_at": r.checked_at.strftime("%Y-%m-%d %H:%M:%S WIB"),
            "similarity_score": round(r.similarity_score, 3) if r.similarity_score else None,
            "is_suspicious": r.is_suspicious,
            "suspicious_reason": r.suspicious_reason,
            "manual_reason": r.manual_reason,
            "evidence_photo_url": f"/evidence/{r.evidence_photo_path}" if r.evidence_photo_path else None,
        })

    return result


@router.get("/export")
def export_attendance_report(
    export_format: str = Query("csv", regex="^(csv|excel)$"),
    target_date: str | None = None,
    db: Session = Depends(get_db),
):
    """Ekspor rekap presensi ke CSV atau Excel."""
    query = db.query(Attendance)
    if target_date:
        try:
            d = datetime.strptime(target_date, "%Y-%m-%d").date()
            d_start = datetime.combine(d, datetime.min.time())
            d_end = datetime.combine(d, datetime.max.time())
            query = query.filter(Attendance.checked_at >= d_start, Attendance.checked_at <= d_end)
        except ValueError:
            pass

    records = query.order_by(Attendance.checked_at.desc()).all()

    rows = []
    for r in records:
        rows.append({
            "Waktu": r.checked_at.strftime("%Y-%m-%d %H:%M:%S"),
            "ID Magang": r.participant.intern_id if r.participant else "",
            "Nama Lengkap": r.participant.full_name if r.participant else "",
            "Divisi": r.participant.division.name if r.participant and r.participant.division else "",
            "Jenis": "Masuk" if r.attendance_type == AttendanceType.CHECK_IN else "Pulang",
            "Metode/Status": r.status.value,
            "Skor Kemiripan": round(r.similarity_score, 3) if r.similarity_score else "-",
            "Mencurigakan": "YA" if r.is_suspicious else "TIDAK",
            "Keterangan/Alasan": r.suspicious_reason or r.manual_reason or "",
        })

    df = pd.DataFrame(rows)

    if export_format == "excel":
        output = io.BytesIO()
        with pd.ExcelWriter(output, engine="openpyxl") as writer:
            df.to_excel(writer, index=False, sheet_name="Presensi DPRD")
        output.seek(0)
        filename = f"rekap_presensi_{date.today().strftime('%Y%m%d')}.xlsx"
        return StreamingResponse(
            output,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f"attachment; filename={filename}"},
        )
    else:
        csv_data = df.to_csv(index=False)
        filename = f"rekap_presensi_{date.today().strftime('%Y%m%d')}.csv"
        return StreamingResponse(
            io.StringIO(csv_data),
            media_type="text/csv",
            headers={"Content-Disposition": f"attachment; filename={filename}"},
        )


@router.post("/attendance/manual")
def create_manual_attendance(data: ManualAttendanceRequest, db: Session = Depends(get_db)):
    """Input presensi manual oleh admin (wajib ada alasan & nama admin)."""
    participant = db.query(Participant).filter(Participant.id == data.participant_id).first()
    if not participant:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Peserta tidak ditemukan.")

    record = Attendance(
        participant_id=participant.id,
        attendance_type=data.attendance_type,
        status=AttendanceStatus.MANUAL,
        checked_at=data.checked_at,
        manual_reason=f"[{data.admin_name}] {data.manual_reason}",
        is_suspicious=False,
    )
    db.add(record)
    db.commit()

    return {
        "success": True,
        "message": f"Presensi manual untuk {participant.full_name} berhasil dicatat oleh {data.admin_name}.",
    }


class UpdateAttendanceRequest(BaseModel):
    attendance_type: AttendanceType | None = None
    checked_at: datetime | None = None
    manual_reason: str | None = None


@router.put("/attendance/{attendance_id}")
def update_attendance_record(attendance_id: uuid.UUID, data: UpdateAttendanceRequest, db: Session = Depends(get_db)):
    """Admin mengedit data presensi yang salah / keliru."""
    record = db.query(Attendance).filter(Attendance.id == attendance_id).first()
    if not record:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Data presensi tidak ditemukan.")

    if data.attendance_type is not None:
        record.attendance_type = data.attendance_type
    if data.checked_at is not None:
        record.checked_at = data.checked_at
    if data.manual_reason is not None:
        record.manual_reason = data.manual_reason
        record.status = AttendanceStatus.MANUAL

    db.commit()
    return {"success": True, "message": "Data presensi berhasil diperbarui oleh admin."}


@router.delete("/attendance/{attendance_id}")
def delete_attendance_record(attendance_id: uuid.UUID, db: Session = Depends(get_db)):
    """Admin menghapus presensi duplikat atau data uji coba agar data kehadiran valid."""
    record = db.query(Attendance).filter(Attendance.id == attendance_id).first()
    if not record:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Data presensi tidak ditemukan.")

    db.delete(record)
    db.commit()
    return {"success": True, "message": "Data presensi berhasil dihapus."}


@router.delete("/attendance/duplicates/clean-today")
def clean_duplicate_attendances_today(db: Session = Depends(get_db)):
    """
    Fitur 1-Klik: Bersihkan presensi duplikat pada hari ini.
    Hanya menyisakan 1 presensi Masuk pertama dan 1 presensi Pulang terakhir per peserta.
    """
    today_start = datetime.combine(date.today(), datetime.min.time())
    today_records = (
        db.query(Attendance)
        .filter(Attendance.checked_at >= today_start)
        .order_by(Attendance.checked_at.asc())
        .all()
    )

    kept = set()
    deleted_count = 0

    # Kelompokkan per participant dan jenis
    # Masuk: simpan yang paling awal
    # Pulang: simpan yang paling akhir
    records_by_key = {}
    for r in today_records:
        key = (r.participant_id, r.attendance_type)
        if key not in records_by_key:
            records_by_key[key] = []
        records_by_key[key].append(r)

    for (pid, att_type), r_list in records_by_key.items():
        if len(r_list) > 1:
            if att_type == AttendanceType.CHECK_IN:
                # Pertahankan yang pertama, hapus sisanya
                for extra in r_list[1:]:
                    db.delete(extra)
                    deleted_count += 1
            else:
                # Pertahankan yang terakhir, hapus sisanya
                for extra in r_list[:-1]:
                    db.delete(extra)
                    deleted_count += 1

    db.commit()
    return {
        "success": True,
        "deleted_count": deleted_count,
        "message": f"Berhasil membersihkan {deleted_count} data presensi ganda pada hari ini.",
    }
