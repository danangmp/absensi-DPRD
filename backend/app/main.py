from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles

from app.config import get_settings
from app.db.session import SessionLocal
from app.db.models.division import Division
from app.core.matcher import matcher
from app.api.routes import participants, enrollment, attendance, divisions, admin
from app.api.websocket import ws_router

settings = get_settings()
BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR.parent / "frontend"
EVIDENCE_DIR = BASE_DIR / "data" / "evidence_photos"


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Lifecycle Startup & Shutdown:
    1. Memastikan divisi default tersedia di DB.
    2. Memuat seluruh embedding aktif ke in-memory cache matcher.
    """
    db = SessionLocal()
    try:
        # 1. Pastikan ada divisi default
        div = db.query(Division).first()
        if not div:
            default_div = Division(
                name="Bagian Persidangan & Perundang-undangan",
                code="SIDANG",
                description="Divisi peserta magang DPRD",
                supervisor_name="Admin Resepsionis",
                is_active=True,
            )
            db.add(default_div)
            db.commit()

        # 2. Muat embedding ke RAM
        count = matcher.load_from_db(db)
        print(f"\n[STARTUP] In-memory FaceMatcher siap dengan {count} peserta aktif.")
    finally:
        db.close()

    yield
    print("[SHUTDOWN] Menutup aplikasi presensi.")


app = FastAPI(
    title="Sistem Presensi Wajah DPRD Surakarta",
    version="1.0.0",
    description="Backend Presensi Wajah Real-Time Berbasis Tablet Kiosk",
    lifespan=lifespan,
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Saat produksi atur ke allowed_origins di .env
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount API Routers
app.include_router(divisions.router, prefix="/api")
app.include_router(participants.router, prefix="/api")
app.include_router(enrollment.router, prefix="/api")
app.include_router(attendance.router, prefix="/api")
app.include_router(admin.router, prefix="/api")
app.include_router(ws_router)

# Mount Static Files (Frontend Kiosk & Admin Dashboard & Foto Bukti)
kiosk_dir = FRONTEND_DIR / "kiosk"
if kiosk_dir.exists():
    app.mount("/kiosk", StaticFiles(directory=str(kiosk_dir), html=True), name="kiosk")

admin_dir = FRONTEND_DIR / "admin"
if admin_dir.exists():
    app.mount("/admin", StaticFiles(directory=str(admin_dir), html=True), name="admin")

EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/evidence", StaticFiles(directory=str(EVIDENCE_DIR)), name="evidence")


@app.get("/")
def root():
    """Redirect root ke halaman kiosk tablet."""
    return RedirectResponse(url="/kiosk/index.html")


@app.get("/health")
def health_check():
    return {
        "status": "healthy",
        "active_participants_cached": len(matcher._index),
    }
